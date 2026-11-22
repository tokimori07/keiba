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
import urllib.request
import webbrowser
import hashlib
from datetime import date as _date

import analysis as A
import backtest as B
import learn as L
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
APP_VERSION = "2026.11.22-b"

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
    CACHE_DIR = os.path.join(ROOT, ".cache")

    def _get(self, url, ttl, persist=False):
        """persist=True: 過去レースなど内容が変わらないページはディスクに保存し、二度と取りに行かない"""
        now = time.time()
        hit = self._cache.get(url)
        if hit and now - hit[0] < ttl:
            return hit[1]
        path = os.path.join(self.CACHE_DIR, hashlib.sha1(url.encode()).hexdigest() + ".html")
        if persist and os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                return f.read()
        with self._lock:
            wait = self.MIN_INTERVAL - (time.time() - self._last)
            if wait > 0:
                time.sleep(wait)
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (personal keiba-note)",
                "Accept-Language": "ja",
            })
            try:
                with urllib.request.urlopen(req, timeout=15) as res:
                    raw = res.read()
            finally:
                self._last = time.time()
        text = decode(raw)
        self._cache[url] = (time.time(), text)
        if persist:
            os.makedirs(self.CACHE_DIR, exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
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
        return with_model({**info, "horses": A.horses_report(past, info["surface"], info["distance"])}, past, date)

    # ---- バックテスト用（過去レースなので保存して再利用）----
    def past5(self, race_id):
        return A.parse_past5(self._get(f"{self.BASE}/race/shutuba_past.html?race_id={race_id}", ttl=86400, persist=True))

    def result(self, race_id):
        return A.parse_result(self._get(f"{self.BASE}/race/result.html?race_id={race_id}", ttl=86400, persist=True))

    # ---- レース傾向（過去10年）----
    def trend(self, race_id, date):
        info = self.race_info(race_id, date)
        found = A.find_past_races(info, A.parse_date(date), self.races)
        results = []
        for r in found["races"]:
            html = self._get(f"{self.BASE}/race/result.html?race_id={r['race_id']}", ttl=86400, persist=True)
            results.append({**r, "result": A.parse_result(html)})
        return {**info, "mode": found["mode"], "trend": A.aggregate_trend(results)}

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


def with_model(report, past, date):
    """学習モデルが保存されていれば、各馬の「市場以外の強さ」を付ける（最新オッズとの合成は画面側）"""
    model = L.load_model(ROOT)
    if not model:
        return report
    d = date if "-" in date else f"{date[:4]}-{date[4:6]}-{date[6:8]}"
    hs = report["horses"]
    for h in hs:
        runs = past.get(h["no"], {}).get("runs", [])
        h["feat"] = A.horse_features(runs, report.get("surface"), report.get("distance"), d)
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
            for k in range(rng.randint(0, 5)):
                place = max(1, min(16, int(rng.gauss(8 - p[i] * 40, 3))))
                runs.append({"date": f"2026-{10 - k:02d}-01", "venue": "東京", "race": "モック", "class": rng.choice(["2勝", "3勝", "OP"]),
                             "place": place, "surface": rng.choice(["芝", "芝", "ダ"]), "distance": rng.choice([1400, 1600, 1800]),
                             "field": 16, "pop": place, "margin": round(0 if place == 1 else place * 0.12, 1), "last3f": 34.5,
                             "style": rng.choice(["逃げ", "先行", "差し", "追込"])})
            past[i + 1] = {"no": i + 1, "waku": min(8, i * 8 // n + 1), "name": self.NAMES[i], "style": "", "runs": runs}
        return with_model({**info, "horses": A.horses_report(past, "芝", 1600)}, past, date or "2026-12-31")

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
                 "firstCorner": None, "name": "", "style": None} for k, i in enumerate(order)]
        fuku = {rows[k]["no"]: max(100, int(rows[k]["odds"] * 30) // 10 * 10) for k in range(3)}
        return {"rows": rows, "field": len(rows), "payout": {}, "fukusho": fuku}

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
        return {**info, "mode": "same_race", "trend": A.aggregate_trend(results)}

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
                self.races = B.collect(self.provider, d_from, d_to, scope, progress, lambda: self._cancel)
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
        self.learned = L.evaluate(self.races)
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


def make_handler(provider):
    job = BacktestJob(provider)

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

        def do_GET(self):
            url = urllib.parse.urlparse(self.path)
            if not url.path.startswith("/api/"):
                return super().do_GET()
            q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
            try:
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
                if url.path == "/api/learn/run":
                    return self._json(200, job.learn())
                if url.path == "/api/learn/use":
                    if not job.learned:
                        return self._json(400, {"error": "先に学習してください"})
                    if (job.learned.get("improvement") or 0) <= 0 and q.get("force") != "1":
                        return self._json(400, {"error": "検証期間でオッズより精度が低いため、使用をおすすめしません"})
                    L.save_model(ROOT, job.learned["model"])
                    return self._json(200, {"ok": True, "model": job.learned["model"]})
                if url.path == "/api/learn/off":
                    try:
                        os.remove(L.model_path(ROOT))
                    except OSError:
                        pass
                    return self._json(200, {"ok": True})
                if url.path == "/api/learn/status":
                    m = L.load_model(ROOT)
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
                    return self._json(200, provider.odds(q.get("race_id", ""), kind))
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
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--mock", action="store_true", help="架空データで動かす")
    ap.add_argument("--no-browser", action="store_true", help="ブラウザを自動で開かない")
    args = ap.parse_args()
    provider = MockProvider() if args.mock else NetkeibaProvider()
    url = f"http://localhost:{args.port}"
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(provider))
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
