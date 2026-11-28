"""
競馬ノート 分析ロジック（netkeiba のHTML解析と集計。通信はしない）

  - 能力値: 出馬表の近5走（shutuba_past）から各馬のパフォーマンスを数値化し★に変換
  - レース傾向: 過去10年の同レース（または同時期・同条件）の結果から
               荒れやすさ・枠順（内外）・脚質・人気の傾向を集計
"""
import math
import re
import statistics
from datetime import date, timedelta

# ---------------------------------------------------------------------------
# 共通
# ---------------------------------------------------------------------------
def strip_tags(s):
    s = re.sub(r"<[^>]+>", "", s or "")
    s = s.replace("&nbsp;", " ").replace("&amp;", "&")
    return re.sub(r"\s+", " ", s).strip()


def to_int(s):
    m = re.search(r"-?\d+", str(s or "").replace(",", ""))
    return int(m.group(0)) if m else None


def to_float(s):
    m = re.search(r"-?\d+(?:\.\d+)?", str(s or "").replace(",", ""))
    return float(m.group(0)) if m else None


# クラスの基準点（1クラス ≒ 4点。1秒差 ≒ 8点 で換算）
CLASS_LEVEL = {
    "G1": 100, "G2": 96, "G3": 93, "L": 90, "OP": 89,
    "3勝": 85, "2勝": 81, "1勝": 77, "未勝利": 72, "新馬": 72, "地方": 76, "不明": 80,
}
GRADE_TEXT = {
    "GI": "G1", "JpnI": "G1", "GII": "G2", "JpnII": "G2", "GIII": "G3", "JpnIII": "G3",
    "L": "L", "OP": "OP", "3勝": "3勝", "2勝": "2勝", "1勝": "1勝",
}
JRA_VENUES = {"札幌", "函館", "福島", "新潟", "東京", "中山", "中京", "京都", "阪神", "小倉"}


def race_class(grade_text, race_name, venue):
    if grade_text in GRADE_TEXT:
        return GRADE_TEXT[grade_text]
    if "新馬" in race_name:
        return "新馬"
    if "未勝利" in race_name:
        return "未勝利"
    n = race_name.translate(str.maketrans("１２３", "123"))
    for c in ("1勝", "2勝", "3勝"):
        if c in n:
            return c
    for old, c in (("500万", "1勝"), ("1000万", "2勝"), ("1600万", "3勝"), ("オープン", "OP")):
        if old in n:
            return c
    if venue and venue not in JRA_VENUES:
        return "地方"
    return "不明"


def running_style(first_corner, field):
    """最初のコーナー通過順位 → 脚質"""
    if not first_corner or not field:
        return None
    if first_corner <= 1:
        return "逃げ"
    r = first_corner / field
    if r <= 0.35:
        return "先行"
    if r <= 0.7:
        return "差し"
    return "追込"


# ---------------------------------------------------------------------------
# 能力値（近5走）
# ---------------------------------------------------------------------------
RECENCY = [1.0, 0.85, 0.7, 0.55, 0.45]


def parse_past5(html):
    """shutuba_past.html → {馬番: {waku, name, style, runs:[...]}}"""
    out = {}
    for row in re.findall(r'<tr class="HorseList[^"]*"[^>]*>(.*?)</tr>', html, re.S):
        waku = re.search(r'<td class="Waku\d+"[^>]*>\s*(\d+)', row)
        no = re.search(r'<td class="Waku"[^>]*>\s*(\d+)', row)
        if not no:
            continue
        name = re.search(r'class="Horse02">\s*<a[^>]*>(.*?)</a>', row, re.S)
        style = re.search(r'class="kyakusitu">(.*?)<', row)
        jk = re.search(r'<td class="Jockey">.*?/jockey/result/recent/(\d+)[^>]*>(.*?)</a>', row, re.S)
        sire = re.search(r'class="Horse01[^"]*">(.*?)</div>', row, re.S)
        barei = re.search(r'class="Barei">\s*([牡牝セ])(\d+)', row)
        bms = re.search(r'class="Horse04">\((.*?)\)</div>', row, re.S)
        kin = re.search(r'<td class="Jockey">.*?</a>\s*<br\s*/?>\s*<span>([\d.]+)</span>', row, re.S)
        tr = re.search(r'class="Horse05">\s*<a[^>]*/trainer/result/recent/(\d+)[^>]*>(.*?)</a>', row, re.S)
        bw = re.search(r'class="Weight[^"]*">\s*(\d{3})kg(?:<span>\(([-+]?\d+)\)</span>)?', row)
        runs = []
        for rid, cell in re.findall(r'<td class="Past[^"]*"(?:\s+id="myhorse_(\d+)")?[^>]*>(.*?)</td>', row, re.S):
            run = parse_past_cell(cell, rid)
            if run:
                runs.append(run)
        out[int(no.group(1))] = {
            "no": int(no.group(1)),
            "waku": int(waku.group(1)) if waku else None,
            "name": strip_tags(name.group(1)) if name else "",
            "style": strip_tags(style.group(1)) if style else "",
            "jockeyId": jk.group(1) if jk else "",
            "jockey": strip_tags(jk.group(2)) if jk else "",
            "sire": strip_tags(sire.group(1)) if sire else "",
            "sex": barei.group(1) if barei else "",
            "age": int(barei.group(2)) if barei else None,
            "bms": strip_tags(bms.group(1)) if bms else "",
            "kinryo": float(kin.group(1)) if kin else None,
            "trainerId": tr.group(1) if tr else "",
            "trainer": strip_tags(tr.group(2)) if tr else "",
            "bodyWeight": int(bw.group(1)) if bw else None,
            "weightDiff": int(bw.group(2)) if bw and bw.group(2) else None,
            "runs": runs,
        }
    return out


def to_seconds(s):
    """'1:54.2' → 114.2、'58.9' → 58.9"""
    m = re.fullmatch(r"\s*(?:(\d+):)?(\d+(?:\.\d)?)\s*", s or "")
    if not m:
        return None
    return int(m.group(1) or 0) * 60 + float(m.group(2))


def parse_past_cell(cell, race_id=""):
    d1 = re.search(r'class="Data01">\s*<span>(.*?)</span>\s*<span class="Num">(.*?)</span>', cell, re.S)
    if not d1:
        return None
    dv = strip_tags(d1.group(1)).split(" ", 1)
    place = to_int(d1.group(2)) if re.fullmatch(r"\s*\d+\s*", d1.group(2)) else None
    d2 = re.search(r'class="Data02">(.*?)</div>', cell, re.S)
    grade = re.search(r'Icon_GradeType[^"]*">([^<]+)<', d2.group(1)) if d2 else None
    race_name = strip_tags(re.sub(r'<span class="Icon_GradeType.*?</span>', "", d2.group(1), flags=re.S)) if d2 else ""
    d5 = strip_tags((re.search(r'class="Data05">(.*?)</div>', cell, re.S) or [None, ""])[1])
    course = re.search(r"(芝|ダ|障)\s*(\d{3,4})", d5)
    tm = re.search(r"\d{3,4}\s+(\d+:\d+\.\d|\d+\.\d)", d5)
    cond = re.search(r"(良|稍|重|不)", d5)
    d3 = strip_tags((re.search(r'class="Data03">(.*?)</div>', cell, re.S) or [None, ""])[1])
    field = re.search(r"(\d+)頭", d3)
    pop = re.search(r"(\d+)人", d3)
    gate = re.search(r"(\d+)番", d3)
    jk_kin = re.search(r"人\s+(\S+)\s+([\d.]+)\s*$", d3)
    d6 = strip_tags((re.search(r'class="Data06">(.*?)</div>', cell, re.S) or [None, ""])[1])
    passing = re.match(r"([\d-]+)", d6)
    last3f = re.search(r"\((\d+\.\d)\)", d6)
    bw = re.search(r"(\d{3})\((-?\+?\d+|前計不)\)", d6)
    d7 = strip_tags((re.search(r'class="Data07">(.*?)</div>', cell, re.S) or [None, ""])[1])
    margin = re.search(r"\((-?\d+\.\d)\)\s*$", d7)
    venue = dv[1] if len(dv) > 1 else ""
    first_corner = to_int(passing.group(1).split("-")[0]) if passing else None
    last_corner = to_int(passing.group(1).rstrip("-").split("-")[-1]) if passing else None
    n = to_int(field.group(1)) if field else None
    cls = race_class(grade.group(1).strip() if grade else "", race_name, venue)
    return {
        "date": dv[0].replace(".", "-"),
        "venue": venue,
        "race": race_name,
        "class": cls,
        "place": place,
        "surface": course.group(1) if course else "",
        "distance": int(course.group(2)) if course else None,
        "field": n,
        "pop": to_int(pop.group(1)) if pop else None,
        "margin": float(margin.group(1)) if margin else None,
        "last3f": float(last3f.group(1)) if last3f else None,
        "style": running_style(first_corner, n),
        "raceId": race_id,
        "time": to_seconds(tm.group(1)) if tm else None,
        "cond": cond.group(1) if cond else "",
        "firstCorner": first_corner,
        "lastCorner": last_corner,
        "bodyWeight": int(bw.group(1)) if bw else None,
        "gate": int(gate.group(1)) if gate else None,
        "jockeyName": jk_kin.group(1) if jk_kin else "",
        "kinryo": float(jk_kin.group(2)) if jk_kin else None,
    }


def run_score(run):
    """1走のパフォーマンス = クラス基準点 − 着差(秒)の換算"""
    if run["place"] is None:  # 中止・除外など
        return None
    margin = run["margin"]
    if margin is None:
        margin = (run["place"] - 1) * 0.15
    margin = max(-0.6, min(margin, 3.0))  # 大差負け・大差勝ちは頭打ち
    dist = run["distance"] or 1600
    return CLASS_LEVEL.get(run["class"], 80) - margin * 8 * (1600 / dist) ** 0.5


def rate_horse(runs, surface, distance):
    """近5走から能力値を算出。今回と条件が違う走は軽く扱う"""
    scored = []
    for i, run in enumerate(runs[:5]):
        s = run_score(run)
        if s is None or run["surface"] == "障":
            continue
        w = RECENCY[i]
        if surface and run["surface"] and run["surface"] != surface:
            w *= 0.4
        if distance and run["distance"] and abs(run["distance"] - distance) > 400:
            w *= 0.6
        scored.append((s, w))
    if not scored:
        return None
    mean = sum(s * w for s, w in scored) / sum(w for _, w in scored)
    best = max(s for s, w in scored if w >= 0.3) if any(w >= 0.3 for _, w in scored) else mean
    return round(0.6 * mean + 0.4 * best, 1)


def stars_in_field(ratings):
    """レース内での相対評価を★1〜5に。トップとの差で決める"""
    valid = [r for r in ratings.values() if r is not None]
    if not valid:
        return {k: None for k in ratings}
    top = max(valid)
    out = {}
    for k, r in ratings.items():
        if r is None:
            out[k] = None
            continue
        gap = top - r
        out[k] = 5 if gap <= 2 else 4 if gap <= 5 else 3 if gap <= 9 else 2 if gap <= 14 else 1
    return out


def horses_report(past, surface, distance):
    ratings = {no: rate_horse(h["runs"], surface, distance) for no, h in past.items()}
    stars = stars_in_field(ratings)
    out = []
    for no, h in sorted(past.items()):
        runs = h["runs"]
        same = [r for r in runs if r["surface"] == surface and r["distance"] and distance
                and abs(r["distance"] - distance) <= 200 and r["place"]]
        styles = [r["style"] for r in runs if r["style"]]
        out.append({
            "no": no,
            "waku": h["waku"],
            "name": h["name"],
            "rating": ratings[no],
            "stars": stars[no],
            "recent": [r["place"] for r in runs],
            "sameCourse": [sum(1 for r in same if r["place"] == k) for k in (1, 2, 3)] + [sum(1 for r in same if r["place"] > 3)],
            "style": h["style"] or (statistics.mode(styles) if styles else ""),
            "runs": runs,
        })
    return out


# ---------------------------------------------------------------------------
# レース傾向（過去10年）
# ---------------------------------------------------------------------------
GENERIC_NAME = re.compile(r"(新馬|未勝利|1勝クラス|2勝クラス|3勝クラス|\d+万下|歳以上|歳上)$")


def is_named_race(name):
    return bool(name) and not GENERIC_NAME.search(name)


def normalize_name(name):
    table = str.maketrans("ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ０１２３４５６７８９（）", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789()")
    return re.sub(r"\s|\(.*?\)", "", (name or "").translate(table))


def candidate_dates(target, years_back):
    """k年前の同じ月日に最も近い同じ曜日を中心に、前後の開催日候補（近い順）"""
    y = target.year - years_back
    try:
        base = target.replace(year=y)
    except ValueError:  # 2/29
        base = target.replace(year=y, day=28)
    shift = (target.weekday() - base.weekday() + 3) % 7 - 3
    base += timedelta(days=shift)
    for off in (0, -1, 1, -7, 7):
        yield base + timedelta(days=off)


def find_past_races(target_race, target_date, fetch_list, years=10, per_year=3):
    """
    過去の同レース（重賞・特別はレース名一致、条件戦は同競馬場・同コース）を探す
    fetch_list(date) -> その日のレース一覧
    """
    named = is_named_race(target_race["name"])
    key = normalize_name(target_race["name"])
    found = []
    misses = 0
    for k in range(1, years + 1):
        if misses >= 2:  # 2年続けて見つからなければ、それ以前は施行されていないとみなす
            break
        misses += 1
        for d in candidate_dates(target_date, k):
            races = fetch_list(d.strftime("%Y%m%d"))
            if named:
                hit = [r for r in races if normalize_name(r["name"]) == key]
                if not hit and target_race.get("grade"):
                    # 略称が年によって違う（例: エリザベス杯／エ女王杯）→ 同じグレード・同じ馬場と距離のレースで探す
                    hit = [r for r in races if r.get("grade") == target_race["grade"]
                           and r.get("course") and r.get("course") == target_race.get("course")]
            else:
                hit = [r for r in races if r["venue"] == target_race["venue"]
                       and r.get("course") == target_race.get("course")]
            if hit:
                found.extend({**r, "year": d.year, "date": d.isoformat()} for r in hit[:per_year])
                misses = 0
                break
    return {"mode": "same_race" if named else "same_course", "races": found}


def parse_result(html):
    """result.html → 着順表と払戻"""
    table = re.search(r'<table[^>]*id="All_Result_Table"[^>]*>(.*?)</table>', html, re.S)
    rows = []
    if table:
        for row in re.findall(r"<tr[^>]*>(.*?)</tr>", table.group(1), re.S):
            if "<th" in row:
                continue
            rank = re.search(r'class="Rank">(.*?)<', row)
            waku = re.search(r'class="Num Waku\d*"[^>]*>\s*<div>(\d+)', row)
            no = re.search(r'class="Num Txt_C"[^>]*>\s*<div>(\d+)', row)
            pop = re.search(r'class="OddsPeople">(\d+)<', row)
            odds = re.search(r'class="Odds Txt_R">\s*<span[^>]*>\s*([\d.]+)\s*<', row)  # 上位人気以外はclassなしのspan
            passing = re.search(r'class="PassageRate">\s*([\d-]+)', row)
            name = re.search(r'class="HorseNameSpan">(.*?)<', row, re.S)
            jk = re.search(r'/jockey/result/recent/(\d+)/?"[^>]*>\s*<span class="JockeyNameSpan">(.*?)</span>', row, re.S)
            tr = re.search(r'/trainer/result/recent/(\d+)/?"[^>]*>\s*<span class="TrainerNameSpan">(.*?)</span>', row, re.S)
            times = re.findall(r'<td class="Time[^"]*">(.*?)</td>', row, re.S)
            bw = re.search(r'class="Weight">\s*(\d{3})\s*(?:<small>\(([-+]?\d+)\)</small>)?', row)
            rows.append({
                "jockeyId": jk.group(1) if jk else "",
                "jockey": strip_tags(jk.group(2)) if jk else "",
                "place": to_int(rank.group(1)) if rank and re.fullmatch(r"\d+", rank.group(1).strip()) else None,
                "waku": to_int(waku.group(1)) if waku else None,
                "no": to_int(no.group(1)) if no else None,
                "pop": to_int(pop.group(1)) if pop else None,
                "odds": float(odds.group(1)) if odds else None,
                "firstCorner": to_int(passing.group(1).split("-")[0]) if passing else None,
                "name": strip_tags(name.group(1)) if name else "",
                "trainerId": tr.group(1) if tr else "",
                "trainer": strip_tags(tr.group(2)) if tr else "",
                "time": to_seconds(strip_tags(times[0])) if times else None,
                "last3f": to_float(strip_tags(times[2])) if len(times) > 2 else None,
                "bodyWeight": int(bw.group(1)) if bw else None,
                "weightDiff": int(bw.group(2)) if bw and bw.group(2) else None,
            })
    payout = {}
    for cls in ("Tansho", "Umaren", "Wide", "Umatan", "Fuku3", "Tan3"):
        m = re.search(r'<tr class="%s">.*?class="Payout"><span>(.*?)</span>' % cls, html, re.S)
        if m:
            payout[cls] = to_int(m.group(1).split("<br")[0])
    fukusho = {}
    m = re.search(r'<tr class="Fukusho">.*?class="Result">(.*?)</td>.*?class="Payout"><span>(.*?)</span>', html, re.S)
    if m:
        nos = [int(x) for x in re.findall(r"<span>(\d+)</span>", m.group(1))]
        pays = [to_int(x) for x in re.split(r"<br\s*/?>", m.group(2))]
        fukusho = {no: pay for no, pay in zip(nos, pays) if pay}
    field = sum(1 for r in rows if r["no"])
    for r in rows:
        r["style"] = running_style(r["firstCorner"], field)
    for r in rows:  # 上がり3Fの順位（レース内）
        r["last3fRank"] = (1 + sum(1 for o in rows if o["last3f"] and r["last3f"] and o["last3f"] < r["last3f"])) if r["last3f"] else None
    cond = re.search(r'class="Item04">\s*(良|稍|重|不)', html)
    d2 = re.search(r'class="RaceData02">(.*?)</div>', html, re.S)
    grade = re.search(r'Icon_GradeType(\d+)', html[:html.find("All_Result_Table")] if "All_Result_Table" in html else "")
    cls_text = strip_tags(d2.group(1)) if d2 else ""
    cls = {"1": "G1", "2": "G2", "3": "G3", "15": "L", "5": "OP"}.get(grade.group(1)) if grade else None
    cls = cls or race_class("", cls_text, "")
    return {"rows": rows, "field": field, "payout": payout, "fukusho": fukusho,
            "cond": (cond.group(1)[0] if cond else ""), "class": cls}


def rough_level(median_tan3):
    """3連単配当の中央値 → 荒れ度★"""
    if median_tan3 is None:
        return None
    for stars, limit in ((1, 8000), (2, 20000), (3, 50000), (4, 120000)):
        if median_tan3 < limit:
            return stars
    return 5


def aggregate_trend(results):
    """results: [{year, venue, name, result: parse_result()}]"""
    races = [r for r in results if r["result"]["rows"]]
    if not races:
        return None
    waku = {w: {"runs": 0, "top3": 0, "win": 0} for w in range(1, 9)}
    inout = {"内": {"runs": 0, "top3": 0}, "外": {"runs": 0, "top3": 0}}
    styles = {s: {"runs": 0, "top3": 0, "win": 0} for s in ("逃げ", "先行", "差し", "追込")}
    pops = {b: {"runs": 0, "top3": 0, "win": 0} for b in ("1番人気", "2〜3番人気", "4〜6番人気", "7〜9番人気", "10番人気〜")}
    fav = [0, 0, 0, 0]
    winner_pops, tan3, umaren, years = [], [], [], []

    def pop_band(p):
        return "1番人気" if p == 1 else "2〜3番人気" if p <= 3 else "4〜6番人気" if p <= 6 else "7〜9番人気" if p <= 9 else "10番人気〜"

    for race in races:
        res = race["result"]
        n = res["field"]
        winner = None
        for r in res["rows"]:
            if not r["no"]:
                continue
            top3 = r["place"] is not None and r["place"] <= 3
            win = r["place"] == 1
            if win:
                winner = r
            if r["waku"]:
                waku[r["waku"]]["runs"] += 1
                waku[r["waku"]]["top3"] += top3
                waku[r["waku"]]["win"] += win
            side = "内" if r["no"] <= (n + 1) // 2 else "外"
            inout[side]["runs"] += 1
            inout[side]["top3"] += top3
            if r["style"]:
                styles[r["style"]]["runs"] += 1
                styles[r["style"]]["top3"] += top3
                styles[r["style"]]["win"] += win
            if r["pop"]:
                b = pops[pop_band(r["pop"])]
                b["runs"] += 1
                b["top3"] += top3
                b["win"] += win
                if r["pop"] == 1:
                    fav[min(r["place"] or 4, 4) - 1] += 1
        if winner and winner["pop"]:
            winner_pops.append(winner["pop"])
        if res["payout"].get("Tan3"):
            tan3.append(res["payout"]["Tan3"])
        if res["payout"].get("Umaren"):
            umaren.append(res["payout"]["Umaren"])
        years.append({
            "year": race["year"], "venue": race["venue"], "name": race["name"], "field": n,
            "winner": winner["name"] if winner else "", "winnerPop": winner["pop"] if winner else None,
            "winnerWaku": winner["waku"] if winner else None, "winnerStyle": winner["style"] if winner else None,
            "tan3": res["payout"].get("Tan3"), "umaren": res["payout"].get("Umaren"),
            "top3": [{"place": r["place"], "name": r.get("name", ""), "no": r["no"], "pop": r.get("pop"),
                      "waku": r.get("waku"), "style": r.get("style")}
                     for r in sorted((r for r in res["rows"] if r.get("no") and r.get("place") and r["place"] <= 3),
                                     key=lambda r: r["place"])],
        })

    def rate(d):
        return {k: {**v, "rate": (v["top3"] / v["runs"]) if v["runs"] else None} for k, v in d.items()}

    med_tan3 = int(statistics.median(tan3)) if tan3 else None
    inner = inout["内"]["top3"] / inout["内"]["runs"] if inout["内"]["runs"] else 0
    outer = inout["外"]["top3"] / inout["外"]["runs"] if inout["外"]["runs"] else 0
    style_rates = rate(styles)
    best_style = max((s for s in style_rates if style_rates[s]["runs"] >= 3),
                     key=lambda s: style_rates[s]["rate"] or 0, default=None)
    return {
        "count": len(races),
        "roughStars": rough_level(med_tan3),
        "medianTan3": med_tan3,
        "medianUmaren": int(statistics.median(umaren)) if umaren else None,
        "favorite": fav,  # 1番人気の [1着, 2着, 3着, 着外]
        "winnerPopAvg": round(sum(winner_pops) / len(winner_pops), 1) if winner_pops else None,
        "waku": rate(waku),
        "inout": rate(inout),
        "inoutBias": "内有利" if inner - outer > 0.05 else "外有利" if outer - inner > 0.05 else "互角",
        "styles": style_rates,
        "bestStyle": best_style,
        "pops": rate(pops),
        "years": sorted(years, key=lambda y: -y["year"]),
    }


def parse_date(s):
    return date(int(s[:4]), int(s[4:6]), int(s[6:8]))


# ---------------------------------------------------------------------------
# 学習モデル用の特徴量（その馬の近5走から、レース前に分かる情報だけ）
# ---------------------------------------------------------------------------
def course_key(venue, surface, distance):
    return f"{venue}|{surface}|{distance}"


def build_standards(results):
    """
    コースごとの基準（タイム指数・上がりの物差し）
      results: [(venue, surface, distance, parse_result の結果)]
      time: 勝ち時計の中央値、up: 5着以内の馬の上がり3Fの中央値
    """
    win, up = {}, {}
    for venue, surface, distance, res in results:
        k = course_key(venue, surface, distance)
        for r in res.get("rows", []):
            if r.get("place") == 1 and r.get("time"):
                win.setdefault(k, []).append(r["time"])
            if r.get("last3f") and r.get("place") and r["place"] <= 5:
                up.setdefault(k, []).append(r["last3f"])
    return {"time": {k: statistics.median(v) for k, v in win.items() if len(v) >= 3},
            "up": {k: statistics.median(v) for k, v in up.items() if len(v) >= 8}}


COND_ADJ = {"良": 0.0, "稍": 0.4, "重": 0.8, "不": 1.2}  # 2000mあたりの馬場の重さ（秒）


def speed_index(run, std):
    """タイム指数: コースの基準タイムより速いほど高い（1000mあたり0.1秒＝1点）"""
    k = course_key(run.get("venue"), run.get("surface"), run.get("distance"))
    t = (std or {}).get("time", {}).get(k)
    if not t or not run.get("time") or run.get("place") is None:
        return None
    d = run["distance"]
    adj = COND_ADJ.get(run.get("cond"), 0.0) * d / 2000 * (1 if run["surface"] == "芝" else -0.5)
    return (t + adj - run["time"]) / d * 10000


def up_index(run, std):
    """上がり指数: コースの基準より上がり3Fが速いほど高い（秒）"""
    k = course_key(run.get("venue"), run.get("surface"), run.get("distance"))
    u = (std or {}).get("up", {}).get(k)
    return (u - run["last3f"]) if u and run.get("last3f") else None


def horse_features(runs, surface, distance, race_date, ctx=None):
    """
    数値の特徴量（欠損は None）。レース内での標準化は learn.py で行う
    ctx（任意）: std=コース基準, class_of(raceId)=過去走のクラス, up_rank_of(raceId, 上がり)=上がり順位(0〜1),
                 weight_diff=今回の馬体重の増減, cur_class=今回のクラス
    """
    ctx = ctx or {}
    class_of = ctx.get("class_of") or (lambda rid: None)
    runs = [r for r in runs if r["date"] < race_date]
    runs = [dict(r, **{"class": class_of(r.get("raceId")) or r["class"]}) if r.get("raceId") else r for r in runs]
    valid = [r for r in runs if r["place"] is not None and r["surface"] != "障"]
    scores = [run_score(r) for r in valid]
    last = valid[0] if valid else None
    days = None
    if runs:
        try:
            d0 = date.fromisoformat(race_date)
            d1 = date.fromisoformat(runs[0]["date"])
            days = (d0 - d1).days
        except ValueError:
            days = None
    same = [r for r in valid if r["surface"] == surface and r["distance"] and distance
            and abs(r["distance"] - distance) <= 200]
    std = ctx.get("std")
    sp = [s for s in (speed_index(r, std) for r in valid) if s is not None]
    ups = [u for u in (up_index(r, std) for r in valid[:3]) if u is not None]
    hidden = None
    if last and last.get("field") and ctx.get("up_rank_of"):
        rank = ctx["up_rank_of"](last.get("raceId"), last.get("last3f"))
        if rank is not None:
            hidden = last["place"] / last["field"] - rank  # 上がりは上位なのに着順が悪い＝隠れた好内容
    class_up = 0.0
    cur = ctx.get("cur_class")
    if last and cur in CLASS_LEVEL and last["class"] in CLASS_LEVEL and "不明" not in (cur, last["class"]):
        class_up = (CLASS_LEVEL[cur] - CLASS_LEVEL[last["class"]]) / 4
    wd = ctx.get("weight_diff")
    return {
        "rating": rate_horse(runs, surface, distance),
        "last": scores[0] if scores else None,
        "best": max(scores) if scores else None,
        "lastPlace": (last["place"] / last["field"]) if last and last.get("field") else None,
        "logDays": math.log(max(days, 7)) if days is not None else None,
        "runs": len(runs),
        "sameTop3": (sum(1 for r in same if r["place"] <= 3) + 0.5) / (len(same) + 2),  # 件数が少ないときは平均へ寄せる
        "spBest": max(sp) if sp else None,
        "upAvg": sum(ups) / len(ups) if ups else None,
        "hidden": hidden,
        "wDiff": wd / 10 if wd is not None else None,
        "classUp": class_up,
    }


def runner_attrs(entry, race_date, distance):
    """過去10年の傾向分析用: 1頭の属性（年齢・性別・所属・血統・前走の内容・間隔・距離の変化）"""
    runs = [r for r in entry.get("runs", []) if r["date"] < race_date]
    last = runs[0] if runs else None
    days = None
    if last:
        try:
            days = (date.fromisoformat(race_date) - date.fromisoformat(last["date"])).days
        except ValueError:
            days = None
    trainer = entry.get("trainer") or ""
    belong = trainer.split("・")[0] if "・" in trainer else ("地方" if trainer else "")
    return {
        "no": entry.get("no"), "name": entry.get("name", ""), "sex": entry.get("sex", ""), "age": entry.get("age"),
        "kinryo": entry.get("kinryo"), "belong": belong, "sire": entry.get("sire", ""), "bms": entry.get("bms", ""),
        "jockey": entry.get("jockey", ""), "style": entry.get("style", ""),
        "prevRace": re.sub(r"\s+", "", last["race"]) if last else "", "prevClass": last["class"] if last else "",
        "prevPlace": last["place"] if last else None, "prevField": last.get("field") if last else None,
        "prevPop": last.get("pop") if last else None, "prevVenue": last.get("venue", "") if last else "",
        "days": days, "distChg": (distance - last["distance"]) if last and last.get("distance") and distance else None,
        # 近5走（どのレースで好走しているか）: レース名・クラス・着順・頭数・人気・日付
        "past": [{"race": re.sub(r"\s+", "", r["race"]), "cls": r["class"], "place": r["place"], "field": r.get("field"),
                  "pop": r.get("pop"), "date": r["date"]} for r in runs[:5] if r.get("race")],
    }


def trend_rows(past, result, race_date, distance):
    """過去の1レース分: 出走馬ごとの属性＋着順・人気・枠・払戻"""
    rows = []
    fuku = result.get("fukusho", {})
    tan = result.get("payout", {}).get("Tansho")
    for r in result["rows"]:
        if not r.get("no") or r.get("place") is None:
            continue
        a = runner_attrs(past.get(r["no"], {"no": r["no"], "name": r.get("name", "")}), race_date, distance)
        a.update({"no": r["no"], "name": r.get("name") or a["name"], "place": r["place"], "pop": r.get("pop"),
                  "waku": r.get("waku"), "style": r.get("style") or a["style"], "field": result.get("field"),
                  "winPay": tan if r["place"] == 1 and tan else 0, "placePay": fuku.get(r["no"], 0)})
        rows.append(a)
    return rows


def current_class(grade, name, venue=""):
    """今回のレースのクラス（重賞はグレード、それ以外はレース名から）"""
    g = (grade or "").replace("Ｇ", "G")
    if g in ("G1", "G2", "G3", "L", "OP"):
        return g
    return race_class("", name or "", venue)


# ---------------------------------------------------------------------------
# 払戻（馬券の自動精算用）
# ---------------------------------------------------------------------------
PAYOUT_TYPES = {"Tansho": "単勝", "Fukusho": "複勝", "Wakuren": "枠連", "Umaren": "馬連",
                "Wide": "ワイド", "Umatan": "馬単", "Fuku3": "3連複", "Tan3": "3連単"}


def parse_payouts(html):
    """result.html の払戻表 → {"単勝": [{"nos": [15], "pay": 180}], "ワイド": [...3組...], ...}（100円あたり）"""
    out = {}
    for cls, name in PAYOUT_TYPES.items():
        m = re.search(r'<tr class="%s">.*?class="Result">(.*?)</td>.*?class="Payout">(.*?)</td>' % cls, html, re.S)
        if not m:
            continue
        cell, pay_cell = m.group(1), m.group(2)
        if "<ul" in cell:
            combos = [[int(x) for x in re.findall(r"<span>(\d+)</span>", ul)] for ul in re.findall(r"<ul>(.*?)</ul>", cell, re.S)]
        else:
            combos = [[int(x)] for x in re.findall(r"<span>(\d+)</span>", cell)]
        pays = [to_int(x) for x in re.split(r"<br\s*/?>", strip_tags_keep_br(pay_cell)) if to_int(x)]
        combos = [c for c in combos if c]
        if combos and len(combos) == len(pays):
            out[name] = [{"nos": c, "pay": p} for c, p in zip(combos, pays)]
    return out


def strip_tags_keep_br(s):
    return re.sub(r"<(?!br)[^>]+>", "", s or "")


# ---------------------------------------------------------------------------
# 騎手の成績
# ---------------------------------------------------------------------------
JOCKEY_PRIOR = 0.21   # 平均的な3着内率（約3/14頭）
JOCKEY_K = 30         # 騎乗数が少ない騎手は平均へ寄せる強さ（30騎乗分）


class JockeyStats:
    """騎乗結果を積み上げて、騎手ごとの成績を返す（日付順に add すれば「その時点まで」の成績になる）"""

    def __init__(self):
        self.s = {}

    def add(self, jockey_id, name, place):
        if not jockey_id or place is None:
            return
        x = self.s.setdefault(jockey_id, {"name": name, "rides": 0, "wins": 0, "top3": 0})
        x["rides"] += 1
        x["wins"] += place == 1
        x["top3"] += place <= 3
        if name:
            x["name"] = name

    def rate(self, jockey_id):
        """平均へ寄せた3着内率"""
        x = self.s.get(jockey_id) or {"rides": 0, "top3": 0}
        return (x["top3"] + JOCKEY_PRIOR * JOCKEY_K) / (x["rides"] + JOCKEY_K)

    def info(self, jockey_id, name=""):
        x = self.s.get(jockey_id) or {"name": name, "rides": 0, "wins": 0, "top3": 0}
        r = self.rate(jockey_id)
        stars = 5 if r >= 0.36 else 4 if r >= 0.29 else 3 if r >= 0.22 else 2 if r >= 0.16 else 1
        return {"id": jockey_id, "name": name or x["name"], "rides": x["rides"], "wins": x["wins"], "top3": x["top3"],
                "winRate": x["wins"] / x["rides"] if x["rides"] else None,
                "top3Rate": x["top3"] / x["rides"] if x["rides"] else None,
                "rate": round(r, 4), "stars": stars if x["rides"] >= 10 else None}
