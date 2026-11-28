#!/usr/bin/env python3
"""
競馬ノート ローカルサーバー（標準ライブラリのみ・インストール不要）

    python3 server.py            # netkeiba からオッズ取得
    python3 server.py --mock     # 架空データで動作確認（ネット接続不要）

起動後 http://localhost:8765 を開く。

API:
    GET /api/races?date=YYYYMMDD               その日のJRAレース一覧
    GET /api/odds?race_id=XXXXXXXXXXXX&type=win  出走馬＋単勝・複勝オッズ
    GET /api/odds?race_id=...&type=quinella     組み合わせオッズ
        type: win / quinella(馬連) / wide / exacta(馬単) / trio(3連複) / trifecta(3連単)

取得元への負荷を抑えるため、同じURLは一定時間キャッシュし、
取得元へのリクエストは最低 1.5 秒間隔を空ける。個人利用の範囲で使うこと。
"""
import argparse
import json
import math
import os
import random
import re
import sys
import threading
import time
import urllib.parse
import urllib.error
import urllib.request
import webbrowser
import gzip
import hashlib
import base64
from datetime import date as _date
from datetime import datetime as _datetime

import analysis as A
import backtest as B
import learn as L
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
# クラウドで動かすとき: KEIBA_CLOUD=1、データ（記録・保存ページ・学習結果）は KEIBA_DATA_DIR（永続ディスク）に置く
CLOUD = os.environ.get("KEIBA_CLOUD") == "1"
DATA_ROOT = os.environ.get("KEIBA_DATA_DIR") or ROOT
APP_VERSION = "2026.11.28-b"

# ---- アプリ内の更新（GitHubの公開リポジトリから最新版を取得）----
UPDATE_REPO = "tokimori07/keiba"
UPDATE_BRANCH = "claude/cool-clarke-bs454c"
# 更新で置き換えるファイル（記録・学習データの .cache などには触れない）
UPDATE_FILES = ("index.html", "server.py", "analysis.py", "backtest.py", "learn.py", "README.md",
                "install-mac.command", "uninstall-mac.command", "start.command", "start.bat")
UPDATE_DIRS = ("css/", "js/")

# ---- iPhoneなど同じWi-Fiの端末から使う（設定は .cache/config.json）----
STATIC_FILES = ("/", "/index.html")
STATIC_DIRS = ("/css/", "/js/")


def config_path():
    return os.path.join(DATA_ROOT, ".cache", "config.json")


def load_config():
    try:
        with open(config_path(), encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        cfg = {}
    if os.environ.get("KEIBA_KEY"):
        cfg["key"] = os.environ["KEIBA_KEY"]  # クラウドでは環境変数の合言葉を使う
    if not cfg.get("key"):
        import secrets
        cfg["key"] = secrets.token_urlsafe(12)  # 合言葉（QRコードのURLに入れて、iPhoneに覚えさせる）
        save_config(cfg)
    return cfg


def save_config(cfg):
    os.makedirs(os.path.dirname(config_path()), exist_ok=True)
    with open(config_path(), "w", encoding="utf-8") as f:
        json.dump(cfg, f)


def lan_addresses():
    """このMacの家庭内ネットワークでのアドレス"""
    import socket
    out = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))  # 実際には送信しない（経路から自分のIPを知るだけ）
        out.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    host = socket.gethostname()
    if host:
        out.append(host if host.endswith(".local") else host.split(".")[0] + ".local")
    return [a for a in out if a and not a.startswith("127.")]


def push_to_cloud(link, state, model):
    """MacのデータをクラウドのURL（合言葉付き）へ送る。クラウド側の記録とはまとめる（同じ記録は上書きしない）"""
    u = urllib.parse.urlparse(link.strip())
    key = urllib.parse.parse_qs(u.query).get("key", [""])[0]
    if u.scheme not in ("http", "https") or not u.netloc or not key:
        raise ValueError("クラウドの画面の「他の端末で開く」URL（?key=… 付き）を貼り付けてください")
    base = f"{u.scheme}://{u.netloc}"
    def call(path, data=None):
        req = urllib.request.Request(f"{base}{path}?key={urllib.parse.quote(key)}", method="POST" if data is not None else "GET",
                                     data=json.dumps(data, ensure_ascii=False).encode() if data is not None else None,
                                     headers={"Content-Type": "application/json", "User-Agent": "keiba-note"})
        def parse(raw):
            try:
                return json.loads(raw or b"{}")
            except ValueError:
                return {}
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return res.status, parse(res.read())
        except urllib.error.HTTPError as e:
            if e.code == 403:
                raise ValueError("合言葉が違います（クラウドの設定画面のURLをそのまま貼り付けてください）")
            return e.code, parse(e.read())
    mine = (state or {}).get("data") or {}
    sent = 0
    for _ in range(3):
        code, cur = call("/api/state")
        if code != 200:
            raise ValueError("クラウドに接続できません（URLと合言葉を確認）")
        theirs = cur.get("data") or {}
        deleted = {**theirs.get("deleted", {}), **mine.get("deleted", {})}
        bets = {b["id"]: b for b in theirs.get("bets", []) + mine.get("bets", []) if b.get("id") and b["id"] not in deleted}
        merged = {"bets": list(bets.values()), "preds": {**mine.get("preds", {}), **theirs.get("preds", {})},
                  "settings": theirs.get("settings") or mine.get("settings") or {}, "deleted": deleted}
        code, _ = call("/api/state", {"rev": cur.get("rev", 0), "data": merged})
        if code == 200:
            sent = len(merged["bets"])
            break
    else:
        raise ValueError("クラウド側で同時に保存が行われています。少し待ってやり直してください")
    if model:
        call("/api/model", model)
    return {"ok": True, "bets": sent, "model": bool(model)}


class StateStore:
    """馬券の記録・予想の振り返り・設定をMac側にも保存し、Mac・iPhoneで同じデータを使う"""

    def __init__(self, root):
        self.path = os.path.join(root, ".cache", "state.json")
        self.lock = threading.Lock()

    def get(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return {"rev": 0, "data": None}

    def put(self, rev, data):
        with self.lock:
            cur = self.get()
            if rev != cur["rev"]:
                return False, cur  # 他の端末が先に保存した → 画面側でまとめ直してもらう
            new = {"rev": cur["rev"] + 1, "data": data, "at": int(time.time())}
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(new, f, ensure_ascii=False)
            os.replace(tmp, self.path)
            return True, new


ICON_180 = "iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAAEgUlEQVR42u3dy05TURTG8e0OI3uLGqc9NjyML6CIQoziI/g6gqUwwPhMpqRj5WJwfByYgELBQ7u6z7r8vzgwQWjZ+9e11zqt7YOnH58nQuZlra5rVoHMTWYJCDgIOAg4CDgIOIjOUTYxyRIqBwEHAQcBB2m1IaUjJVQOwihLqBwEHAQcBBwEHAQchFGWUDkIAQdpfqxwrhAqBwEHAQdhlCVUDqKyclA4CJWDgIOAg4CDgENNpi++swhX00riPcEuZbz88cfH6OsTVoPKcV3Gzb+DgxBwNCgbFA9w/N8BPjIyFv4qOOLKwEfcp+ynG413PeoS0XOIMgJHwP2O6SMjAx/gENjjaD5i/b+V6cbJ0j8j0HLRkJbnxSircF9fnUj5GH15TOVARomfBg4/MuL4yMggNKSwA0fZ/fPtIyMDH+FG2enmSUmFoyOHw21GBgmEoxUZLjmu1bxBh5yPZ0ePqBx6c7x5GvbWwRFob8DhTYYnoDnVycEfVVtyvHnqY1W5fL4aH69PXVQOduKvrE/6+PCDQ1yGoA9wOKwZUj6sF4+MDO6kNxyyi36zVNB8JF7sc4cDfJh8T7DjN2dlxpP1Sf/b258yt2RwnTMyzN1tcGiRIXm4WPORY8poq8DY8hG0Ib3vfsf0YQZH661GwCunGRlxzsf749D/dLwaGcKHC0/ZL7uIW7pqhqSPrTP1lYPgwyIObWUjWnOakeHm11wFDo29kH4Z0oeLxl3IKh9M5yZqhqiPc5WVQ9vgakTGSnwwyhIa0oUePduWyoZ88dg+B4cfGb59ZD1nXHU4kPqtxF6+VfzmqsOBnh3RdaxY9CErg2PF3gM6akOqbHyqDgYx/VUHA0bZZstkoXgIy2CUdePDvYyk9rmVlOrqoK/Wh6iMvtotUN2Q6vQRp88NdPlc4aYK6o+IQ3b5lvchfaAwyi453E60+JCUMenzAmO5pfR0ScPIqwzN9ByCC7rANse82Br09RwtbnZl58XJlnC01XwEPFBMVo7yPsLKMHmslPQRWYbVnqOMD57xN/meYOY61mq/lxLvCVaseOz3rAwvsncVHC37kGw1zMpI1q9zrMIHMpzgsHW+gMO8D8qGKxzIWBkOFx84VY0VbUY17vExXsoerDp8qGLKseJzY8DhzYcznTSkyLg1Dj/Lfjjuzt5dlL/R5G4lfVaO4bhLJROoHMnpk7LDz93Z+4tit0VDas8HMsDR2s45lsG0gozYONxvITjU+YhgLsqxIruXQaqR21F2zo7udWc7FyI/h2OFhJYRDkeorZU4VlIdzEdntvNr4e8NtVwRj5XhXqfYd4HDv4+AMmhIkcEoO3fLdzuzD82aj6hLFLpyDHc7Iv8GHBF9RJYBjrsEBJcBjlsdIAMcBBz3LB6UDXDM94GMy/CeYP/6+PQw7mUNKgcBBwEHAQcBB1E2rdCakztGWRaBcKwQcBBwEHCQNhtSOlJC5SCMsoTKQcBBwEHAQcBBwEEYZQmVgxBwkObHCucKoXIQcBBwEEZZQuUg4CDgIOAg4CDgIORafgOBSHib5NgLhwAAAABJRU5ErkJggg=="
ICON_512 = "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"

MIN_IMPROVEMENT = 0.003  # 予想に使ってよい精度改善の目安（0.3%未満は誤差の範囲とみなす）

VENUES = {
    "01": "札幌", "02": "函館", "03": "福島", "04": "新潟", "05": "東京",
    "06": "中山", "07": "中京", "08": "京都", "09": "阪神", "10": "小倉",
}
COMBO_TYPES = ("quinella", "wide", "exacta", "trio", "trifecta")
ORDERED = ("exacta", "trifecta")  # 着順あり（キーを並べ替えない）


def parse_race_id(race_id):
    """race_id = 年(4) 場(2) 回(2) 日(2) R(2)"""
    if not re.fullmatch(r"\d{12}", race_id or ""):
        raise ValueError("race_id は12桁の数字です")
    return {
        "race_id": race_id,
        "venue": VENUES.get(race_id[4:6], "地方"),
        "race": int(race_id[10:12]),
    }


def combo_key(nos, kind):
    nos = [int(n) for n in nos]
    if kind not in ORDERED:
        nos = sorted(nos)
    return "-".join(str(n) for n in nos)


def to_float(s):
    try:
        v = float(str(s).replace(",", ""))
        return v if v > 0 else None
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# netkeiba
# ---------------------------------------------------------------------------
class NetkeibaProvider:
    BASE = "https://race.netkeiba.com"
    # netkeiba odds API の type 番号
    TYPE_NO = {"win": 1, "quinella": 4, "wide": 5, "exacta": 6, "trio": 7, "trifecta": 8}
    MIN_INTERVAL = 1.5

    def __init__(self):
        self._lock = threading.Lock()
        self._last = 0.0
        self._cache = {}

    # ---- HTTP ----
    CACHE_DIR = os.path.join(DATA_ROOT, ".cache")

    def _get(self, url, ttl, persist=False):
        """persist=True: 過去レースなど内容が変わらないページはディスクに保存し、二度と取りに行かない"""
        now = time.time()
        hit = self._cache.get(url)
        if hit and now - hit[0] < ttl:
            return hit[1]
        base = os.path.join(self.CACHE_DIR, hashlib.sha1(url.encode()).hexdigest())
        if persist:
            cached = read_cache(base)
            if cached is not None:
                return cached
        with self._lock:
            wait = self.MIN_INTERVAL - (time.time() - self._last)
            if wait > 0:
                time.sleep(wait)
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (personal keiba-note)",
                "Accept-Language": "ja",
            })
            raw = None
            for attempt in range(4):  # 一時的な切断・タイムアウトは待ってやり直す（5秒→15秒→45秒）
                try:
                    with urllib.request.urlopen(req, timeout=20) as res:
                        raw = res.read()
                    break
                except urllib.error.HTTPError as e:
                    if e.code < 500 or attempt == 3:
                        raise
                except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
                    if attempt == 3:
                        raise
                finally:
                    self._last = time.time()
                time.sleep(5 * 3 ** attempt)
        text = decode(raw)
        if persist:
            # 保存するページはメモリには置かない（大量に取得してもメモリを食わない）。圧縮して保存
            os.makedirs(self.CACHE_DIR, exist_ok=True)
            with gzip.open(base + ".html.gz", "wt", encoding="utf-8") as f:
                f.write(text)
        else:
            if len(self._cache) > 300:  # 一時キャッシュは古いものから捨てる
                for k in sorted(self._cache, key=lambda k: self._cache[k][0])[:100]:
                    del self._cache[k]
            self._cache[url] = (time.time(), text)
        return text

    # ---- レース一覧 ----
    def races(self, date):
        past = date < _date.today().strftime("%Y%m%d")
        html = self._get(f"{self.BASE}/top/race_list_sub.html?kaisai_date={date}", ttl=600, persist=past)
        return parse_race_list(html)

    def race_info(self, race_id, date):
        for r in self.races(date):
            if r["race_id"] == race_id:
                return r
        raise ValueError("指定日のレース一覧にこのレースが見つかりません（開催日を確認してください）")

    # ---- 能力値（近5走）----
    def horses(self, race_id, date):
        info = self.race_info(race_id, date)
        html = self._get(f"{self.BASE}/race/shutuba_past.html?race_id={race_id}", ttl=1800)
        past = A.parse_past5(html)
        report = {**info, "horses": A.horses_report(past, info["surface"], info["distance"])}
        add_jockeys(report, past, self.jockey_index())
        add_speed(report, self.standards())
        return with_model(report, past, date, self.trainer_index(), B.past_lookups(self, {}))

    # ---- 騎手の成績（保存済みの過去レース結果から集計）----
    def jockey_index(self):
        files = [f for f in os.listdir(self.CACHE_DIR)] if os.path.isdir(self.CACHE_DIR) else []
        if getattr(self, "_jk", None) and self._jk[0] == len(files):
            return self._jk[1]
        stats, trainers = A.JockeyStats(), A.JockeyStats()
        std_src = []
        for f in files:
            if not (f.endswith(".html") or f.endswith(".html.gz")):
                continue
            html = read_cache(os.path.join(self.CACHE_DIR, f.split(".")[0])) or ""
            if "All_Result_Table" not in html:
                continue
            res = A.parse_result(html)
            for r in res["rows"]:
                stats.add(r.get("jockeyId"), r.get("jockey"), r["place"])
                trainers.add(r.get("trainerId"), r.get("trainer"), r["place"])
            rid = re.search(r"race_id=(\d{12})", html)
            course = re.search(r'class="RaceData01">.*?(芝|ダ)(\d{3,4})m', html, re.S)
            if rid and course:  # タイム指数の物差し（コースごとの基準タイム）
                std_src.append((parse_race_id(rid.group(1))["venue"], course.group(1), int(course.group(2)), res))
        self._jk = (len(files), stats)
        self._tr = trainers
        self._std = A.build_standards(std_src)
        return stats

    def standards(self):
        self.jockey_index()
        return self._std

    def trainer_index(self):
        self.jockey_index()
        return self._tr

    # ---- 払戻（馬券の自動精算）----
    def payout(self, race_id):
        html = self._get(f"{self.BASE}/race/result.html?race_id={race_id}", ttl=300)
        pays = A.parse_payouts(html)
        if pays:  # 確定した結果は保存して二度と取りに行かない
            self._get(f"{self.BASE}/race/result.html?race_id={race_id}", ttl=300, persist=True)
        return {"race_id": race_id, "final": bool(pays), "payouts": pays}

    # ---- バックテスト用（過去レースなので保存して再利用）----
    def past5(self, race_id):
        return A.parse_past5(self._get(f"{self.BASE}/race/shutuba_past.html?race_id={race_id}", ttl=86400, persist=True))

    def result(self, race_id):
        return A.parse_result(self._get(f"{self.BASE}/race/result.html?race_id={race_id}", ttl=86400, persist=True))

    def cached_result(self, race_id):
        """保存済みなら結果を返す（通信しない）"""
        html = read_cache(os.path.join(self.CACHE_DIR, hashlib.sha1(
            f"{self.BASE}/race/result.html?race_id={race_id}".encode()).hexdigest()))
        return A.parse_result(html) if html and "All_Result_Table" in html else None

    # ---- レース傾向（過去10年）----
    def trend(self, race_id, date):
        info = self.race_info(race_id, date)
        found = A.find_past_races(info, A.parse_date(date), self.races)
        results, rows = [], []
        for r in found["races"]:
            html = self._get(f"{self.BASE}/race/result.html?race_id={r['race_id']}", ttl=86400, persist=True)
            res = A.parse_result(html)
            results.append({**r, "result": res})
            try:  # 過去の出走馬の前走・年齢などは、そのレースの5走表から（保存して再利用）
                past = self.past5(r["race_id"])
            except Exception:
                past = {}
            for x in A.trend_rows(past, res, r["date"], r.get("distance")):
                rows.append({**x, "year": r["year"]})
        trend = A.aggregate_trend(results)
        if trend:
            trend["rows"] = rows
            trend["current"] = self._current_attrs(race_id, info, date)
        return {**info, "mode": found["mode"], "trend": trend}

    def _current_attrs(self, race_id, info, date):
        d = date if "-" in date else f"{date[:4]}-{date[4:6]}-{date[6:8]}"
        try:
            past = A.parse_past5(self._get(f"{self.BASE}/race/shutuba_past.html?race_id={race_id}", ttl=1800))
        except Exception:
            return []
        return [{**A.runner_attrs(h, d, info.get("distance")), "waku": h.get("waku")} for h in past.values()]

    # ---- 確定オッズ（レース後。確定したら保存して二度と取りに行かない）----
    def final_odds(self, race_id, kind):
        base = os.path.join(self.CACHE_DIR, hashlib.sha1(f"final-odds:{race_id}:{kind}".encode()).hexdigest())
        cached = read_cache(base)
        if cached:
            return json.loads(cached)
        r = self.odds(race_id, kind)
        if r.get("status") == "result":
            os.makedirs(self.CACHE_DIR, exist_ok=True)
            with gzip.open(base + ".html.gz", "wt", encoding="utf-8") as f:
                f.write(json.dumps(r, ensure_ascii=False))
        return r

    # ---- オッズ ----
    def odds(self, race_id, kind):
        info = parse_race_id(race_id)
        type_no = self.TYPE_NO[kind]
        text = self._get(
            f"{self.BASE}/api/api_get_jra_odds.html?race_id={race_id}&type={type_no}&action=update",
            ttl=30,
        )
        payload = parse_odds_json(text)
        if kind == "win":
            names = parse_shutuba(self._get(f"{self.BASE}/race/shutuba.html?race_id={race_id}", ttl=3600))
            horses = win_from_payload(payload, names["horses"])
            return {**info, "name": names["name"], "kind": kind, "status": payload["status"],
                    "updated": payload["updated"], "horses": horses}
        return {**info, "kind": kind, "status": payload["status"], "updated": payload["updated"],
                "odds": combos_from_payload(payload, kind, type_no)}


def read_cache(base):
    """保存済みページを読む（圧縮版 .html.gz、旧形式 .html のどちらでも）"""
    if os.path.exists(base + ".html.gz"):
        with gzip.open(base + ".html.gz", "rt", encoding="utf-8") as f:
            return f.read()
    if os.path.exists(base + ".html"):
        with open(base + ".html", encoding="utf-8") as f:
            return f.read()
    return None


class Updater:
    """GitHubの最新版と比べ、新しければ取り込んで再起動する"""

    def __init__(self):
        self.last = None

    def _fetch(self, url, timeout=20):
        req = urllib.request.Request(url, headers={"User-Agent": "keiba-note-updater"})
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.read()

    def check(self):
        if CLOUD:  # クラウドはGitHubに反映すると自動で入れ替わる
            return {"current": APP_VERSION, "latest": APP_VERSION, "available": False, "cloud": True}
        src = self._fetch(f"https://raw.githubusercontent.com/{UPDATE_REPO}/{urllib.parse.quote(UPDATE_BRANCH)}/server.py").decode("utf-8")
        m = re.search(r'APP_VERSION = "([^"]+)"', src)
        latest = m.group(1) if m else None
        self.last = {"current": APP_VERSION, "latest": latest, "available": bool(latest and latest > APP_VERSION)}
        return self.last

    def apply(self):
        import io
        import zipfile
        info = self.check()
        if not info["available"]:
            return {**info, "applied": False}
        data = self._fetch(f"https://codeload.github.com/{UPDATE_REPO}/zip/refs/heads/{urllib.parse.quote(UPDATE_BRANCH)}", timeout=60)
        files = {}
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for name in z.namelist():
                if name.endswith("/") or "/" not in name:
                    continue
                rel = name.split("/", 1)[1]  # 先頭の「keiba-ブランチ名/」を外す
                if ".." in rel.split("/") or rel.startswith("/"):
                    continue
                if rel in UPDATE_FILES or (rel.startswith(UPDATE_DIRS) and rel.count("/") == 1):
                    files[rel] = z.read(name)
        if "server.py" not in files or "index.html" not in files:
            raise ValueError("ダウンロードした最新版の中身が不完全です。時間をおいて再度お試しください")
        for rel, body in files.items():  # いったん全部書き出してから入れ替える（途中で失敗しても壊れにくい）
            path = os.path.join(ROOT, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path + ".new", "wb") as f:
                f.write(body)
        for rel in files:
            path = os.path.join(ROOT, rel)
            os.replace(path + ".new", path)
            if rel.endswith(".command"):
                os.chmod(path, 0o755)
        threading.Timer(1.0, restart).start()  # 応答を返してから新しい版で起動し直す
        return {**info, "applied": True, "files": len(files)}


def restart():
    os.execv(sys.executable, [sys.executable] + sys.argv)


class OddsLog:
    """単勝オッズの推移を記録する（.cache/oddslog/<race_id>.json）。締切前のオッズの動きの検証用"""

    def __init__(self, root):
        self.dir = os.path.join(root, ".cache", "oddslog")
        self.lock = threading.Lock()

    def _path(self, race_id):
        return os.path.join(self.dir, re.sub(r"\D", "", race_id) + ".json")

    def get(self, race_id):
        try:
            with open(self._path(race_id), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return []

    def add(self, race_id, horses, status=""):
        odds = {str(h["no"]): h["odds"] for h in horses if h.get("odds")}
        if not odds or not re.fullmatch(r"\d{12}", race_id or ""):
            return
        with self.lock:
            log = self.get(race_id)
            if log and log[-1].get("final"):
                return  # 確定後は記録しない
            now = int(time.time())
            final = status == "result"
            if log and log[-1]["o"] == odds and now - log[-1]["t"] < 600 and not final:
                return  # 変化がなければ10分に1回だけ
            log.append({"t": now, "o": odds, **({"final": True} if final else {})})
            os.makedirs(self.dir, exist_ok=True)
            with open(self._path(race_id), "w", encoding="utf-8") as f:
                json.dump(log, f)


class OddsRecorder(threading.Thread):
    """開催日の9時〜17時、その日の重賞の単勝オッズを3分ごとに記録する（画面を開いていなくても）"""
    INTERVAL = 180

    def __init__(self, provider, log):
        super().__init__(daemon=True)
        self.provider, self.log = provider, log

    def tick(self, now=None):
        now = now or _datetime.now()
        if not (9 <= now.hour < 17):
            return 0
        n = 0
        for r in self.provider.races(now.strftime("%Y%m%d")):
            if r.get("grade") not in ("G1", "G2", "G3"):
                continue
            try:
                res = self.provider.odds(r["race_id"], "win")
                self.log.add(r["race_id"], res.get("horses", []), res.get("status", ""))
                n += 1
            except Exception:
                continue
        return n

    def run(self):
        while True:
            try:
                self.tick()
            except Exception:
                pass
            time.sleep(self.INTERVAL)


def add_speed(report, std):
    """展開予想用: 近走ごとのタイム指数・上がり指数（保存済みの結果から作ったコース基準で計算）"""
    for h in report["horses"]:
        for r in h.get("runs", []):
            r["sp"] = round(A.speed_index(r, std), 1) if A.speed_index(r, std) is not None else None
            r["up"] = round(A.up_index(r, std), 2) if A.up_index(r, std) is not None else None


def add_jockeys(report, past, stats):
    for h in report["horses"]:
        p = past.get(h["no"], {})
        h["jockey"] = stats.info(p.get("jockeyId", ""), p.get("jockey", "")) if p.get("jockeyId") else None


def with_model(report, past, date, trainers=None, lookups=None):
    """学習モデルが保存されていれば、各馬の「市場以外の強さ」を付ける（最新オッズとの合成は画面側）"""
    model = L.load_model(DATA_ROOT)
    if not model:
        return report
    if any(k not in model.get("beta", {}) for k in L.KEYS):
        return report  # 古い形式の学習結果（材料が違う）は使わない。検証タブで学習し直す
    d = date if "-" in date else f"{date[:4]}-{date[4:6]}-{date[6:8]}"
    ctx = {"std": model.get("std"), **(lookups or {}),
           "cur_class": A.current_class(report.get("grade"), report.get("name"), report.get("venue"))}
    hs = report["horses"]
    for h in hs:
        p = past.get(h["no"], {})
        h["feat"] = A.horse_features(p.get("runs", []), report.get("surface"), report.get("distance"), d,
                                     dict(ctx, weight_diff=p.get("weightDiff")))
        h["feat"]["jockey"] = h["jockey"]["rate"] if h.get("jockey") else None
        h["feat"]["trainer"] = trainers.rate(p["trainerId"]) if trainers and p.get("trainerId") else None
    for h, u in zip(hs, L.own_strength(model, hs)):
        h["ownU"] = round(u, 4)
        h.pop("feat", None)
    report["model"] = {"betaMarket": model["beta"]["market"], "trainedAt": model.get("trainedAt"), "races": model.get("races")}
    return report


def decode(raw):
    head = raw[:2048].decode("ascii", "ignore").lower()
    if "euc-jp" in head:
        return raw.decode("euc_jp", "replace")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("euc_jp", "replace")


def parse_race_list(html):
    """race_list_sub.html から race_id とレース名を抜き出す"""
    races, seen = [], set()
    for m in re.finditer(r'race_id=(\d{12})[^>]*>(.*?)</a>', html, re.S):
        rid = m.group(1)
        if rid in seen:
            continue
        name_m = re.search(r'class="ItemTitle"[^>]*>(.*?)<', m.group(2), re.S)
        if not name_m:
            continue
        seen.add(rid)
        body = m.group(2)
        course = re.search(r"(芝|ダ|障)\s*(\d{3,4})m", strip_tags(body))
        field = re.search(r"(\d+)頭", strip_tags(body))
        grade = re.search(r'ItemTitle.*?Icon_GradeType(\d+)', body, re.S)
        races.append({
            **parse_race_id(rid),
            "name": strip_tags(name_m.group(1)),
            "course": f"{course.group(1)}{course.group(2)}m" if course else "",
            "surface": course.group(1) if course else "",
            "distance": int(course.group(2)) if course else None,
            "field": int(field.group(1)) if field else None,
            "grade": {"1": "G1", "2": "G2", "3": "G3"}.get(grade.group(1), "") if grade else "",
        })
    races.sort(key=lambda r: (r["venue"], r["race"]))
    return races


def parse_shutuba(html):
    """出馬表から 馬番→馬名 とレース名"""
    horses = {}
    for row in re.findall(r'<tr[^>]*class="HorseList[^"]*"[^>]*>(.*?)</tr>', html, re.S):
        no = re.search(r'<td[^>]*class="Umaban[^"]*"[^>]*>\s*(\d+)\s*<', row)
        name = re.search(r'class="HorseName"[^>]*>.*?<a[^>]*>(.*?)</a>', row, re.S)
        if no and name:
            horses[int(no.group(1))] = strip_tags(name.group(1))
    title = re.search(r'class="RaceName"[^>]*>(.*?)<', html, re.S)
    return {"horses": horses, "name": strip_tags(title.group(1)) if title else ""}


def strip_tags(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s or "")).strip()


def parse_odds_json(text):
    """
    netkeiba odds API:
      {"status":"result|middle|yoso|...","data":{"official_datetime":"...","odds":{"1":{"01":["3.2","","1"],...}}}}
    JSONP形式で返る場合もあるので括弧の中を取り出す。
    """
    text = text.strip()
    m = re.match(r"^[\w$.]+\((.*)\)\s*;?$", text, re.S)
    if m:
        text = m.group(1)
    data = json.loads(text)
    body = data.get("data") or {}
    if not isinstance(body, dict):
        body = {}
    return {
        "status": data.get("status", ""),
        "updated": body.get("official_datetime", ""),
        "odds": body.get("odds") or {},
    }


def win_from_payload(payload, names):
    win = payload["odds"].get("1") or {}
    place = payload["odds"].get("2") or {}
    nos = sorted({int(k) for k in list(win) + list(place)} | set(names))
    horses = []
    for no in nos:
        k = f"{no:02d}"
        w = win.get(k) or []
        p = place.get(k) or []
        horses.append({
            "no": no,
            "name": names.get(no, ""),
            "odds": to_float(w[0]) if w else None,
            "pop": int(w[2]) if len(w) > 2 and str(w[2]).isdigit() else None,
            "placeMin": to_float(p[0]) if p else None,
            "placeMax": to_float(p[1]) if len(p) > 1 else None,
        })
    return horses


def combos_from_payload(payload, kind, type_no):
    table = payload["odds"].get(str(type_no)) or {}
    out = {}
    for k, v in table.items():
        if not re.fullmatch(r"(\d\d){2,3}", k):
            continue
        nos = [k[i:i + 2] for i in range(0, len(k), 2)]
        o = to_float(v[0] if isinstance(v, list) else v)  # ワイドは [下限, 上限, 人気]
        if o:
            out[combo_key(nos, kind)] = o
    return out


# ---------------------------------------------------------------------------
# モック（動作確認・デモ用）
# ---------------------------------------------------------------------------
class MockProvider:
    def final_odds(self, race_id, kind):
        return {**self.odds(race_id, kind), "status": "result"}

    JOCKEYS = ["北川", "南野", "東田", "西山", "中島", "上原", "下村", "森", "林", "川口", "岡", "谷"]
    NAMES = ["アオゾラ", "ハヤテ", "ミカヅキ", "シロガネ", "ツバクロ", "ホシアカリ", "カザグルマ", "ユキノハナ",
             "イナズマ", "コハク", "サクラビト", "トキノカネ", "ナミノリ", "ヒバリ", "モミジガリ", "ワカバ"]

    def races(self, date):
        out = []
        for vc in ("05", "08"):
            for r in range(1, 13):
                rid = f"{date[:4]}{vc}{date[4:6]}{date[6:8]}{r:02d}"
                out.append({**parse_race_id(rid), "name": "モック特別" if r == 11 else f"{r}R 一般",
                            "course": "芝1600m", "surface": "芝", "distance": 1600, "grade": "G3" if r == 11 else ""})
        return out

    def _probs(self, race_id):
        rng = random.Random(race_id)
        n = 8 + int(race_id[-2:]) % 9
        w = [rng.lognormvariate(0, 0.9) for _ in range(n)]
        s = sum(w)
        # 時間でオッズが少し動くように
        jitter = random.Random(race_id + str(int(time.time() // 60)))
        p = [x / s * jitter.uniform(0.93, 1.07) for x in w]
        s = sum(p)
        return [x / s for x in p]

    def _info(self, race_id):
        r = int(race_id[-2:])
        return {**parse_race_id(race_id), "name": "モック特別" if r == 11 else f"{r}R 一般",
                "course": "芝1600m", "surface": "芝", "distance": 1600, "field": len(self._probs(race_id)), "grade": ""}

    def horses(self, race_id, date):
        info = self._info(race_id)
        p = self._probs(race_id)
        rng = random.Random(race_id + "past")
        past = {}
        n = len(p)
        for i in range(n):
            runs = []
            tend = rng.random()  # 脚質の傾向（0=逃げ … 1=追込）
            for k in range(rng.randint(0, 5)):
                place = max(1, min(16, int(rng.gauss(8 - p[i] * 40, 3))))
                fc = max(1, min(16, round(tend * 15 + 1 + rng.gauss(0, 1.5))))
                runs.append({"date": f"2026-{10 - k:02d}-01", "venue": "東京", "race": "モック", "class": rng.choice(["2勝", "3勝", "OP"]),
                             "place": place, "surface": rng.choice(["芝", "芝", "ダ"]), "distance": rng.choice([1400, 1600, 1800]),
                             "field": 16, "pop": place, "margin": round(0 if place == 1 else place * 0.12, 1), "last3f": 34.5,
                             "style": A.running_style(fc, 16), "firstCorner": fc,
                             "lastCorner": max(1, min(16, round(fc - (1 - tend) * 2 + rng.gauss(0, 2)))),
                             "sp": round(rng.gauss(p[i] * 120, 6), 1), "up": round(rng.gauss((tend - 0.4) * 1.2, 0.4), 2)})
            past[i + 1] = {"no": i + 1, "waku": min(8, i * 8 // n + 1), "name": self.NAMES[i], "style": "", "runs": runs,
                           "jockeyId": f"J{(i * 7 + int(race_id[-2:])) % 12:02d}", "jockey": self.JOCKEYS[(i * 7 + int(race_id[-2:])) % 12]}
        report = {**info, "horses": A.horses_report(past, "芝", 1600)}
        stats = A.JockeyStats()
        for j in range(12):  # 架空の騎手成績（番号が小さいほど上手い）
            for k in range(120):
                stats.add(f"J{j:02d}", self.JOCKEYS[j], 1 if k % (3 + j) == 0 else 5)
        add_jockeys(report, past, stats)
        return with_model(report, past, date or "2026-12-31")

    def past5(self, race_id):
        return {h["no"]: {"no": h["no"], "waku": h["waku"], "name": h["name"], "style": "", "runs": h["runs"]}
                for h in self.horses(race_id, "")["horses"]}

    def result(self, race_id):
        p = self._probs(race_id)
        h = self.horses(race_id, "")["horses"]
        rng = random.Random(race_id + "result")
        # 能力値が高いほど少し勝ちやすい世界
        strength = [math.log(p[i]) + 0.04 * ((h[i]["rating"] or 80) - 80) + rng.gauss(0, 0.8) for i in range(len(p))]
        order = sorted(range(len(p)), key=lambda i: -strength[i])
        pops = {i: k + 1 for k, i in enumerate(sorted(range(len(p)), key=lambda i: -p[i]))}
        rows = [{"place": k + 1, "waku": None, "no": i + 1, "pop": pops[i], "odds": max(1.1, round(0.8 / p[i], 1)),
                 "firstCorner": None, "name": "", "style": None,
                 "jockeyId": f"J{(i * 7 + int(race_id[-2:])) % 12:02d}", "jockey": ""} for k, i in enumerate(order)]
        fuku = {rows[k]["no"]: max(100, int(rows[k]["odds"] * 30) // 10 * 10) for k in range(3)}
        return {"rows": rows, "field": len(rows), "payout": {}, "fukusho": fuku}

    def payout(self, race_id):
        rows = self.result(race_id)["rows"]
        a, b, c = rows[0], rows[1], rows[2]
        o = lambda x: int(x * 100) // 10 * 10
        pays = {
            "単勝": [{"nos": [a["no"]], "pay": o(a["odds"])}],
            "複勝": [{"nos": [r["no"]], "pay": max(100, o(r["odds"] / 3))} for r in (a, b, c)],
            "馬連": [{"nos": sorted([a["no"], b["no"]]), "pay": o(a["odds"] * b["odds"] / 2)}],
            "ワイド": [{"nos": sorted(p), "pay": max(100, o(x / 6))} for p, x in
                      (([a["no"], b["no"]], a["odds"] * b["odds"]), ([a["no"], c["no"]], a["odds"] * c["odds"]), ([b["no"], c["no"]], b["odds"] * c["odds"]))],
            "馬単": [{"nos": [a["no"], b["no"]], "pay": o(a["odds"] * b["odds"])}],
            "3連複": [{"nos": sorted([a["no"], b["no"], c["no"]]), "pay": o(a["odds"] * b["odds"] * c["odds"] / 6)}],
            "3連単": [{"nos": [a["no"], b["no"], c["no"]], "pay": o(a["odds"] * b["odds"] * c["odds"])}],
        }
        return {"race_id": race_id, "final": True, "payouts": pays}

    def trend(self, race_id, date):
        info = self._info(race_id)
        rng = random.Random(race_id + "trend")
        results = []
        for k in range(1, 11):
            n = rng.randint(12, 18)
            pops = list(range(1, n + 1))
            rng.shuffle(pops)
            order = sorted(range(n), key=lambda i: pops[i] + rng.gauss(0, 4))
            rows = []
            for place, i in enumerate(order, 1):
                rows.append({"place": place, "waku": min(8, i * 8 // n + 1), "no": i + 1, "pop": pops[i], "odds": None,
                             "firstCorner": rng.randint(1, n), "name": f"過去馬{k}-{i + 1}"})
            for r in rows:
                r["style"] = A.running_style(r["firstCorner"], n)
            results.append({"year": 2026 - k, "venue": info["venue"], "name": info["name"],
                            "result": {"rows": rows, "field": n, "payout": {"Tan3": rng.choice([3000, 12000, 45000, 98000, 230000]),
                                                                           "Umaren": rng.choice([600, 1800, 5200])}}})
        trend = A.aggregate_trend(results)
        prev = ["天皇賞(秋)", "毎日王冠", "京都大賞典", "オールカマー", "府中牝馬S", "3勝クラス"]
        cls = {"天皇賞(秋)": "G1", "毎日王冠": "G2", "京都大賞典": "G2", "オールカマー": "G2", "府中牝馬S": "G2", "3勝クラス": "3勝"}
        def attrs(r, i):
            pr = rng.choice(prev)
            return {"sex": rng.choice("牡牡牡牝セ"), "age": rng.choice([3, 4, 4, 5, 5, 6, 7]), "kinryo": rng.choice([55.0, 56.0, 57.0, 58.0]),
                    "belong": rng.choice(["美浦", "栗東", "栗東"]), "sire": rng.choice(["ディープインパクト", "キズナ", "エピファネイア", "ロードカナロア"]),
                    "prevRace": pr, "prevClass": cls[pr], "prevPlace": rng.randint(1, 14), "prevPop": rng.randint(1, 14),
                    "days": rng.choice([14, 21, 28, 35, 49, 70, 120]), "distChg": rng.choice([-400, -200, 0, 0, 200, 400])}
        trend["rows"] = [{**attrs(r, i), "no": r["no"], "name": r["name"], "place": r["place"], "pop": r["pop"], "waku": r["waku"],
                          "style": r["style"], "field": x["result"]["field"], "year": x["year"],
                          "winPay": r["pop"] * 150 if r["place"] == 1 else 0, "placePay": 100 + r["pop"] * 40 if r["place"] <= 3 else 0}
                         for x in results for i, r in enumerate(x["result"]["rows"])]
        n = len(self._probs(race_id))
        trend["current"] = [{**attrs(None, i), "no": i + 1, "name": self.NAMES[i % len(self.NAMES)], "waku": None,
                             "style": rng.choice(["逃げ", "先行", "差し", "追込"])} for i in range(n)]
        return {**info, "mode": "same_race", "trend": trend}

    def odds(self, race_id, kind):
        info = parse_race_id(race_id)
        p = self._probs(race_id)
        n = len(p)
        updated = time.strftime("%Y-%m-%d %H:%M:%S")
        rnd = lambda x: max(1.0, round(x, 1))
        if kind == "win":
            horses = [{
                "no": i + 1, "name": self.NAMES[i], "odds": rnd(0.8 / p[i]),
                "pop": None, "placeMin": rnd(0.8 / min(0.95, p[i] * 2.6)), "placeMax": rnd(0.8 / min(0.95, p[i] * 2.0)),
            } for i in range(n)]
            for rank, h in enumerate(sorted(horses, key=lambda h: h["odds"]), 1):
                h["pop"] = rank
            return {**info, "name": "モック特別", "kind": kind, "status": "middle", "updated": updated, "horses": horses}
        out = {}
        take = {"quinella": 0.775, "wide": 0.775, "exacta": 0.75, "trio": 0.75, "trifecta": 0.725}[kind]
        for i in range(n):
            for j in range(n):
                if i == j:
                    continue
                pij = p[i] * p[j] / (1 - p[i])
                if kind in ("quinella", "exacta"):
                    k = combo_key([i + 1, j + 1], kind)
                    out[k] = out.get(k, 0) + pij
                    continue
                for m in range(n):
                    if m in (i, j):
                        continue
                    pijm = pij * p[m] / (1 - p[i] - p[j])
                    if kind == "wide":
                        for a, b in ((i, j), (i, m), (j, m)):
                            k = combo_key([a + 1, b + 1], kind)
                            out[k] = out.get(k, 0) + pijm
                    else:
                        k = combo_key([i + 1, j + 1, m + 1], kind)
                        out[k] = out.get(k, 0) + pijm
        noise = random.Random(race_id + kind)
        odds = {k: rnd(take / v * noise.uniform(0.8, 1.25)) for k, v in out.items()}
        return {**info, "kind": kind, "status": "middle", "updated": updated, "odds": odds}


# ---------------------------------------------------------------------------
# HTTP サーバー
# ---------------------------------------------------------------------------
class BacktestJob:
    """バックテストは時間がかかるので別スレッドで実行し、進捗を返す"""

    def __init__(self, provider):
        self.provider = provider
        self.lock = threading.Lock()
        self.state = {"status": "idle"}
        self.races = []
        self.learned = None
        self._cancel = False

    def start(self, d_from, d_to, scope, temperature):
        with self.lock:
            if self.state.get("status") == "running":
                raise ValueError("既に実行中です")
            self._cancel = False
            self.state = {"status": "running", "done": 0, "total": 0, "message": "開始", "params":
                          {"from": d_from.isoformat(), "to": d_to.isoformat(), "scope": scope}}

        def progress(done, total, message):
            self.state.update(done=done, total=total, message=message)

        def run():
            try:
                self.races, self.std = B.collect(self.provider, d_from, d_to, scope, progress, lambda: self._cancel)
                result = B.evaluate(self.races, temperature)
                self.state.update(status="cancelled" if self._cancel else "done", result=result)
            except Exception as e:
                self.state.update(status="error", message=str(e))

        threading.Thread(target=run, daemon=True).start()

    def cancel(self):
        self._cancel = True

    def learn(self):
        if not self.races:
            raise ValueError("先に検証タブでバックテストを実行してください（学習データになります）")
        if not all("feat" in h for r in self.races for h in r["horses"]):
            raise ValueError("古い形式のデータです。もう一度バックテストを実行してください")
        self.learned = L.evaluate(self.races, std=getattr(self, "std", None))
        graded = [r for r in self.races if r.get("grade") in ("G1", "G2", "G3")]
        test_from = self.learned["testFrom"]
        g_test = [r for r in graded if r["date"] >= test_from]
        if len(g_test) >= 5:
            fit_test = L.fit([r for r in self.races if r["date"] < test_from], self.learned["l2"])
            mk = L.log_loss(g_test, lambda r: L.market_probs([h["odds"] for h in r["horses"]]))
            md = L.log_loss(g_test, lambda r: L.predict(fit_test, r["horses"], [h["odds"] for h in r["horses"]]))
            self.learned["graded"] = {"races": len(g_test), "improvement": (mk - md) / mk}
        return self.learned

    def reevaluate(self, temperature):
        if not self.races:
            raise ValueError("先にバックテストを実行してください")
        self.state["result"] = B.evaluate(self.races, temperature)
        return self.state


ODDS_LOG = OddsLog(DATA_ROOT)


def make_handler(provider):
    job = BacktestJob(provider)
    updater = Updater()
    oddslog = ODDS_LOG
    states = StateStore(DATA_ROOT)

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=ROOT, **kw)

        def end_headers(self):
            # 画面のファイル（HTML/CSS/JS）をブラウザに覚えさせない → 更新後すぐ新しい画面になる
            if not self.path.startswith("/api/"):
                self.send_header("Cache-Control", "no-cache")
            super().end_headers()

        def log_message(self, fmt, *args):
            if "/api/" in (args[0] if args else ""):
                sys.stderr.write("%s\n" % (fmt % args))

        def _json(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _local(self):
            if CLOUD:  # クラウドでは、すべてインターネット経由（合言葉が必要）
                return False
            return self.client_address[0] in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

        def _authorized(self, q):
            """Mac本体からは常にOK。他の端末は合言葉（QRコードのURL→Cookie）が必要"""
            if self._local():
                return True
            key = load_config()["key"]
            cookie = self.headers.get("Cookie", "")
            return q.get("key") == key or f"kn_key={key}" in cookie

        def _deny(self):
            body = ("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
                    "<body style='font-family:sans-serif;padding:24px;line-height:1.7'><h2>競馬ノート</h2>"
                    "<p>このURLは使えません。Macの競馬ノートの「設定」タブ →「iPhoneで使う」のQRコードを、iPhoneのカメラで読み取って開いてください。</p>").encode()
            self.send_response(403)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _bytes(self, body, ctype):
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "max-age=86400")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            url = urllib.parse.urlparse(self.path)
            q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
            if not self._authorized(q):
                return self._deny()
            n = int(self.headers.get("Content-Length") or 0)
            if n > 30 * 1024 * 1024:
                return self._json(413, {"error": "データが大きすぎます"})
            try:
                body = json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                return self._json(400, {"error": "JSONが不正です"})
            if url.path == "/api/model":  # 学習結果を受け取る（Macからクラウドへ移すとき）
                if not isinstance(body.get("beta"), dict):
                    return self._json(400, {"error": "学習結果の形式が不正です"})
                L.save_model(DATA_ROOT, body)
                return self._json(200, {"ok": True})
            if url.path == "/api/cloud/push":  # Macの記録・学習結果をクラウドへ送る（Mac本体の画面から）
                if not self._local():
                    return self._json(403, {"error": "Mac本体の画面から操作してください"})
                try:
                    return self._json(200, push_to_cloud(body.get("url", ""), states.get(), L.load_model(DATA_ROOT)))
                except Exception as e:
                    return self._json(502, {"error": f"クラウドに送れませんでした: {e}"})
            if url.path == "/api/state":
                ok, cur = states.put(body.get("rev"), body.get("data"))
                return self._json(200 if ok else 409, {"rev": cur["rev"], **({} if ok else {"data": cur["data"]})})
            return self._json(404, {"error": "not found"})

        def do_GET(self):
            url = urllib.parse.urlparse(self.path)
            q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
            if not self._authorized(q):
                return self._deny()
            if q.get("key") and not self._local() and not url.path.startswith("/api/"):  # 画面を開いたときは合言葉をCookieに保存して、URLから消す
                self.send_response(302)
                secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
                self.send_header("Set-Cookie", f"kn_key={q['key']}; Max-Age=31536000; Path=/; SameSite=Lax; HttpOnly{secure}")
                self.send_header("Location", url.path or "/")
                self.end_headers()
                return
            if url.path == "/icons/icon-180.png":
                return self._bytes(base64.b64decode(ICON_180), "image/png")
            if url.path == "/icons/icon-512.png":
                return self._bytes(base64.b64decode(ICON_512), "image/png")
            if url.path == "/manifest.webmanifest":
                return self._bytes(json.dumps({
                    "name": "競馬ノート", "short_name": "競馬ノート", "start_url": "/", "display": "standalone",
                    "background_color": "#f3f5f2", "theme_color": "#157347",
                    "icons": [{"src": "/icons/icon-180.png", "sizes": "180x180", "type": "image/png"},
                              {"src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png"}]},
                    ensure_ascii=False).encode(), "application/manifest+json")
            if not url.path.startswith("/api/"):
                # 画面のファイルだけを配る（記録などが入った .cache は見せない）
                if url.path in STATIC_FILES or (url.path.startswith(STATIC_DIRS) and ".." not in url.path):
                    return super().do_GET()
                return self._json(404, {"error": "not found"})
            try:
                if url.path == "/api/state":
                    return self._json(200, states.get())
                if url.path == "/api/lan/info" and CLOUD:
                    host = self.headers.get("X-Forwarded-Host") or self.headers.get("Host", "")
                    proto = self.headers.get("X-Forwarded-Proto", "https")
                    return self._json(200, {"cloud": True, "local": False, "lan": False,
                                            "urls": [f"{proto}://{host}/?key={load_config()['key']}"]})
                if url.path == "/api/lan/info":
                    cfg = load_config()
                    port = self.server.server_address[1]
                    return self._json(200, {"lan": bool(cfg.get("lan")), "active": self.server.server_address[0] != "127.0.0.1",
                                            "local": self._local(),
                                            "urls": [f"http://{a}:{port}/?key={cfg['key']}" for a in lan_addresses()] if self._local() else []})
                if url.path == "/api/lan/set":
                    if not self._local():
                        return self._json(403, {"error": "Mac本体の画面から操作してください"})
                    cfg = load_config()
                    cfg["lan"] = q.get("on") == "1"
                    if q.get("renew") == "1":
                        import secrets
                        cfg["key"] = secrets.token_urlsafe(12)
                    save_config(cfg)
                    threading.Timer(0.8, restart).start()  # 受け付ける範囲を変えるため再起動
                    return self._json(200, {"lan": cfg["lan"], "restarting": True})
                if url.path == "/api/update/apply" and not self._local():
                    return self._json(403, {"error": "更新はMac本体の画面から行ってください"})
                if url.path == "/api/update/check":
                    return self._json(200, updater.check())
                if url.path == "/api/update/apply":
                    return self._json(200, updater.apply())
                if url.path == "/api/ping":
                    return self._json(200, {"ok": True, "provider": type(provider).__name__, "version": APP_VERSION})
                if url.path == "/api/races":
                    date = q.get("date", "")
                    if not re.fullmatch(r"\d{8}", date):
                        return self._json(400, {"error": "date は YYYYMMDD 形式"})
                    return self._json(200, {"races": provider.races(date)})
                if url.path == "/api/backtest/start":
                    try:
                        d_from, d_to = A.parse_date(q["from"]), A.parse_date(q["to"])
                    except (KeyError, ValueError):
                        return self._json(400, {"error": "from/to は YYYYMMDD 形式"})
                    if d_from > d_to or (d_to - d_from).days > 400:
                        return self._json(400, {"error": "期間は1年以内で指定してください"})
                    job.start(d_from, d_to, q.get("scope", "named"), float(q.get("temp", 10)))
                    return self._json(200, job.state)
                if url.path == "/api/backtest/status":
                    return self._json(200, job.state)
                if url.path == "/api/backtest/cancel":
                    job.cancel()
                    return self._json(200, job.state)
                if url.path == "/api/payout":
                    parse_race_id(q.get("race_id", ""))
                    return self._json(200, provider.payout(q["race_id"]))
                if url.path == "/api/learn/run":
                    return self._json(200, job.learn())
                if url.path == "/api/learn/use":
                    if not job.learned:
                        return self._json(400, {"error": "先に学習してください"})
                    if (job.learned.get("improvement") or 0) < MIN_IMPROVEMENT and q.get("force") != "1":
                        return self._json(400, {"error": "検証期間でオッズだけの予想をはっきり上回れていないため、使用をおすすめしません"})
                    L.save_model(DATA_ROOT, job.learned["model"])
                    return self._json(200, {"ok": True, "model": job.learned["model"]})
                if url.path == "/api/learn/off":
                    try:
                        os.remove(L.model_path(DATA_ROOT))
                    except OSError:
                        pass
                    return self._json(200, {"ok": True})
                if url.path == "/api/learn/status":
                    m = L.load_model(DATA_ROOT)
                    return self._json(200, {"model": m, "learned": job.learned})
                if url.path == "/api/backtest/reevaluate":
                    return self._json(200, job.reevaluate(float(q.get("temp", 10))))
                if url.path in ("/api/horses", "/api/trend"):
                    date = q.get("date", "")
                    if not re.fullmatch(r"\d{8}", date):
                        return self._json(400, {"error": "date は YYYYMMDD 形式"})
                    parse_race_id(q.get("race_id", ""))
                    fn = provider.horses if url.path == "/api/horses" else provider.trend
                    return self._json(200, fn(q["race_id"], date))
                if url.path == "/api/odds":
                    kind = q.get("type", "win")
                    if kind != "win" and kind not in COMBO_TYPES:
                        return self._json(400, {"error": "type が不正です"})
                    res = provider.odds(q.get("race_id", ""), kind)
                    if kind == "win":
                        oddslog.add(q.get("race_id", ""), res.get("horses", []), res.get("status", ""))
                    return self._json(200, res)
                if url.path == "/api/finalodds":
                    kind = q.get("type", "win")
                    if kind != "win" and kind not in COMBO_TYPES:
                        return self._json(400, {"error": "type が不正です"})
                    return self._json(200, provider.final_odds(q.get("race_id", ""), kind))
                if url.path == "/api/oddslog":
                    return self._json(200, {"log": oddslog.get(q.get("race_id", ""))})
                return self._json(404, {"error": "not found"})
            except ValueError as e:
                return self._json(400, {"error": str(e)})
            except Exception as e:  # 取得元の仕様変更・通信エラー
                return self._json(502, {"error": f"取得に失敗しました: {e}"})

    return Handler


def already_running(url):
    try:
        with urllib.request.urlopen(url + "/api/ping", timeout=2) as res:
            return json.load(res).get("ok") is True
    except Exception:
        return False


def main():
    if sys.version_info < (3, 7):
        sys.exit("Python 3.7 以上が必要です（現在 %s）" % sys.version.split()[0])
    ap = argparse.ArgumentParser(description="競馬ノート ローカルサーバー")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT") or 8765))
    ap.add_argument("--mock", action="store_true", help="架空データで動かす")
    ap.add_argument("--no-browser", action="store_true", help="ブラウザを自動で開かない")
    args = ap.parse_args()
    provider = MockProvider() if args.mock else NetkeibaProvider()
    url = f"http://localhost:{args.port}"
    try:
        bind = "0.0.0.0" if CLOUD or load_config().get("lan") else "127.0.0.1"  # iPhoneで使う設定なら家のWi-Fiからも受け付ける
        srv = ThreadingHTTPServer((bind, args.port), make_handler(provider))
        if not args.mock:
            OddsRecorder(provider, ODDS_LOG).start()
    except OSError:
        # 既に競馬ノートが動いていれば、それを開くだけにする
        # （ポートが変わると保存データが見えなくなるため、別ポートでは起動しない）
        if already_running(url):
            print(f"競馬ノートは既に起動しています: {url}")
            if not args.no_browser:
                webbrowser.open(url)
            return
        sys.exit(f"ポート {args.port} が他のアプリに使われています。"
                 f"そのアプリを終了するか、--port 8800 のように別の番号を指定してください"
                 f"（番号を変えると、保存した記録は元の番号のときのURLでしか見えません）")
    if CLOUD:
        print(f"競馬ノート（クラウド）: ポート {srv.server_address[1]} で待機中。最初は https://<このアプリのURL>/?key=<合言葉> で開いてください", flush=True)
    url = f"http://localhost:{srv.server_address[1]}"
    print(f"競馬ノート: {url}  （{'モック' if args.mock else 'netkeiba'}モード）")
    print("このウィンドウを閉じるか Ctrl+C で終了します")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
