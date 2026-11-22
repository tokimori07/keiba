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
import os
import random
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))

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
    def _get(self, url, ttl):
        now = time.time()
        hit = self._cache.get(url)
        if hit and now - hit[0] < ttl:
            return hit[1]
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
        return text

    # ---- レース一覧 ----
    def races(self, date):
        html = self._get(f"{self.BASE}/top/race_list_sub.html?kaisai_date={date}", ttl=600)
        return parse_race_list(html)

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
        races.append({**parse_race_id(rid), "name": strip_tags(name_m.group(1))})
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
                rid = f"{date[:4]}{vc}0501{r:02d}"
                out.append({**parse_race_id(rid), "name": "モック特別" if r == 11 else f"{r}R 一般"})
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
def make_handler(provider):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=ROOT, **kw)

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
                    return self._json(200, {"ok": True, "provider": type(provider).__name__})
                if url.path == "/api/races":
                    date = q.get("date", "")
                    if not re.fullmatch(r"\d{8}", date):
                        return self._json(400, {"error": "date は YYYYMMDD 形式"})
                    return self._json(200, {"races": provider.races(date)})
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
