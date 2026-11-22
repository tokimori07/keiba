"""
競馬ノート 分析ロジック（netkeiba のHTML解析と集計。通信はしない）

  - 能力値: 出馬表の近5走（shutuba_past）から各馬のパフォーマンスを数値化し★に変換
  - レース傾向: 過去10年の同レース（または同時期・同条件）の結果から
               荒れやすさ・枠順（内外）・脚質・人気の傾向を集計
"""
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
        runs = []
        for cell in re.findall(r'<td class="Past[^"]*"[^>]*>(.*?)</td>', row, re.S):
            run = parse_past_cell(cell)
            if run:
                runs.append(run)
        out[int(no.group(1))] = {
            "no": int(no.group(1)),
            "waku": int(waku.group(1)) if waku else None,
            "name": strip_tags(name.group(1)) if name else "",
            "style": strip_tags(style.group(1)) if style else "",
            "runs": runs,
        }
    return out


def parse_past_cell(cell):
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
    d3 = strip_tags((re.search(r'class="Data03">(.*?)</div>', cell, re.S) or [None, ""])[1])
    field = re.search(r"(\d+)頭", d3)
    pop = re.search(r"(\d+)人", d3)
    d6 = strip_tags((re.search(r'class="Data06">(.*?)</div>', cell, re.S) or [None, ""])[1])
    passing = re.match(r"([\d-]+)", d6)
    last3f = re.search(r"\((\d+\.\d)\)", d6)
    d7 = strip_tags((re.search(r'class="Data07">(.*?)</div>', cell, re.S) or [None, ""])[1])
    margin = re.search(r"\((-?\d+\.\d)\)\s*$", d7)
    venue = dv[1] if len(dv) > 1 else ""
    first_corner = to_int(passing.group(1).split("-")[0]) if passing else None
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
            odds = re.search(r'class="Odds_Ninki">([\d.]+)<', row)
            passing = re.search(r'class="PassageRate">\s*([\d-]+)', row)
            name = re.search(r'class="HorseNameSpan">(.*?)<', row, re.S)
            rows.append({
                "place": to_int(rank.group(1)) if rank and re.fullmatch(r"\d+", rank.group(1).strip()) else None,
                "waku": to_int(waku.group(1)) if waku else None,
                "no": to_int(no.group(1)) if no else None,
                "pop": to_int(pop.group(1)) if pop else None,
                "odds": float(odds.group(1)) if odds else None,
                "firstCorner": to_int(passing.group(1).split("-")[0]) if passing else None,
                "name": strip_tags(name.group(1)) if name else "",
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
    return {"rows": rows, "field": field, "payout": payout, "fukusho": fukusho}


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
