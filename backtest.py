"""
競馬ノート バックテスト

過去のレースで「その時点で手に入った情報（近5走）」から能力値を計算し、
実際の結果・最終オッズと突き合わせて次を検証する。

  1. 能力★ごとの勝率・複勝率・回収率（★が高いほど走っているか）
  2. 能力1位の馬 vs 1番人気の馬（市場より当たるか）
  3. 能力順位が人気より高い「過小評価馬」の回収率（市場に勝てる情報か）
  4. 予想モデル（自分の重み×基準EV）で単勝を買った場合の回収率
     → 前半の期間で最適な設定を選び、後半の期間で成績を確認（過学習チェック）
  5. 推定勝率の当てはまり（予測した勝率と実際の勝率）
"""
import math
from datetime import timedelta

import analysis as A

WEIGHTS = [0.0, 0.25, 0.5, 0.75, 1.0]
MIN_EVS = [1.0, 1.1, 1.2, 1.3, 1.5]


# ---------------------------------------------------------------------------
# データ収集
# ---------------------------------------------------------------------------
def race_dates(d_from, d_to):
    """開催の可能性がある日（土日・月曜祝日）"""
    d = d_from
    while d <= d_to:
        if d.weekday() in (5, 6, 0):
            yield d
        d += timedelta(days=1)


def in_scope(race, scope):
    if race.get("surface") == "障":
        return False
    if scope == "graded":
        return race.get("grade") in ("G1", "G2", "G3")
    if scope == "named":
        return A.is_named_race(race.get("name", ""))
    return True


def build_race(info, past, result, race_date):
    """1レース分の馬ごとの行（能力値・人気・オッズ・着順・複勝払戻）"""
    by_no = {r["no"]: r for r in result["rows"] if r["no"]}
    ratings = {}
    for no, h in past.items():
        runs = [r for r in h["runs"] if r["date"] < race_date]  # 念のため未来の情報を除外
        ratings[no] = A.rate_horse(runs, info.get("surface"), info.get("distance"))
    horses = []
    for no, r in by_no.items():
        if r["odds"] is None or r["place"] is None:  # 取消・除外・中止は対象外
            continue
        horses.append({
            "no": no, "rating": ratings.get(no), "pop": r["pop"], "odds": r["odds"],
            "place": r["place"], "fukusho": result.get("fukusho", {}).get(no, 0),
        })
    rated = [h for h in horses if h["rating"] is not None]
    if len(horses) < 5 or len(rated) < len(horses) * 0.6:  # 新馬戦など情報が少ないレースは除外
        return None
    for i, h in enumerate(sorted(rated, key=lambda h: -h["rating"]), 1):
        h["rank"] = i
    stars = A.stars_in_field({h["no"]: h["rating"] for h in horses})
    for h in horses:
        h["stars"] = stars[h["no"]]
        h.setdefault("rank", None)
    return {"race_id": info["race_id"], "date": race_date, "name": info["name"], "venue": info["venue"],
            "course": info.get("course", ""), "grade": info.get("grade", ""), "horses": horses}


def collect(provider, d_from, d_to, scope, progress=None, cancelled=lambda: False):
    """期間内の対象レースを集める。progress(done, total, message)"""
    targets = []
    dates = list(race_dates(d_from, d_to))
    for i, d in enumerate(dates):
        if cancelled():
            return []
        if progress:
            progress(0, 0, f"レース一覧を確認中 {d.isoformat()}（{i + 1}/{len(dates)}日）")
        for r in provider.races(d.strftime("%Y%m%d")):
            if in_scope(r, scope):
                targets.append((d, r))
    races = []
    for i, (d, info) in enumerate(targets):
        if cancelled():
            break
        if progress:
            progress(i, len(targets), f"{d.isoformat()} {info['venue']}{info['race']}R {info['name']}")
        try:
            past = provider.past5(info["race_id"])
            result = provider.result(info["race_id"])
        except Exception:  # 1レースの失敗で全体を止めない
            continue
        race = build_race(info, past, result, d.isoformat())
        if race:
            races.append(race)
    if progress:
        progress(len(targets), len(targets), "集計中")
    return races


# ---------------------------------------------------------------------------
# 予想モデル（js/model.js・js/app.js と同じ式）
# ---------------------------------------------------------------------------
def model_probs(horses, weight, temperature):
    vals = [h["rating"] for h in horses if h["rating"] is not None]
    mean = sum(vals) / len(vals)
    sd = math.sqrt(sum((v - mean) ** 2 for v in vals) / len(vals)) or 1
    scores = [45 if h["rating"] is None else max(10, min(95, round(50 + (h["rating"] - mean) / sd * 15))) for h in horses]
    mx = max(scores)
    ex = [math.exp((s - mx) / temperature) for s in scores]
    p_model = [e / sum(ex) for e in ex]
    inv = [1 / h["odds"] for h in horses]
    p_market = [v / sum(inv) for v in inv]
    raw = [math.exp(weight * math.log(max(a, 1e-9)) + (1 - weight) * math.log(max(b, 1e-9)))
           for a, b in zip(p_model, p_market)]
    return [r / sum(raw) for r in raw]


# ---------------------------------------------------------------------------
# 集計
# ---------------------------------------------------------------------------
def _acc():
    return {"n": 0, "win": 0, "top3": 0, "tanPay": 0, "fukuPay": 0}


def _add(a, h):
    a["n"] += 1
    a["win"] += h["place"] == 1
    a["top3"] += h["place"] <= 3
    a["tanPay"] += round(h["odds"] * 100) if h["place"] == 1 else 0
    a["fukuPay"] += h["fukusho"]


def _fin(a):
    n = a["n"]
    return {"n": n, "winRate": a["win"] / n if n else None, "top3Rate": a["top3"] / n if n else None,
            "tanRoi": a["tanPay"] / (n * 100) if n else None, "fukuRoi": a["fukuPay"] / (n * 100) if n else None}


def simulate(races, weight, min_ev, temperature):
    bets = hits = pay = 0
    for race in races:
        hs = race["horses"]
        for h, p in zip(hs, model_probs(hs, weight, temperature)):
            if p * h["odds"] >= min_ev:
                bets += 1
                if h["place"] == 1:
                    hits += 1
                    pay += round(h["odds"] * 100)
    return {"weight": weight, "minEv": min_ev, "bets": bets, "hits": hits,
            "roi": pay / (bets * 100) if bets else None, "profit": pay - bets * 100}


def evaluate(races, temperature=10):
    races = sorted(races, key=lambda r: (r["date"], r["race_id"]))
    if not races:
        return None
    by_star = {s: _acc() for s in (5, 4, 3, 2, 1)}
    top_rated, favorite, under, over = _acc(), _acc(), _acc(), _acc()
    for race in races:
        for h in race["horses"]:
            if h["stars"]:
                _add(by_star[h["stars"]], h)
            if h["rank"] == 1:
                _add(top_rated, h)
            if h["pop"] == 1:
                _add(favorite, h)
            if h["rank"] and h["pop"]:
                if h["pop"] - h["rank"] >= 3:      # 能力順位が人気より3つ以上上 = 過小評価
                    _add(under, h)
                elif h["rank"] - h["pop"] >= 3:    # 人気先行
                    _add(over, h)

    # 期間を前半(70%)と後半に分け、前半で選んだ設定を後半で確認
    cut = max(1, int(len(races) * 0.7))
    train, test = races[:cut], races[cut:]
    grid = [simulate(races, w, e, temperature) for w in WEIGHTS for e in MIN_EVS]
    train_grid = [simulate(train, w, e, temperature) for w in WEIGHTS for e in MIN_EVS]
    candidates = [g for g in train_grid if g["bets"] >= max(20, len(train) // 5) and g["weight"] > 0]
    best = max(candidates, key=lambda g: g["roi"] or 0) if candidates else None
    best_test = simulate(test, best["weight"], best["minEv"], temperature) if best and test else None
    fav_test = _acc()  # 比較用: 同じ後半期間に1番人気の単勝を毎レース買った場合
    for race in test:
        for h in race["horses"]:
            if h["pop"] == 1:
                _add(fav_test, h)

    # 当てはまり（能力のみ w=1 の推定勝率を帯ごとに）
    bins = [(0, .05), (.05, .1), (.1, .2), (.2, .35), (.35, 1.01)]
    calib = [{"from": a, "to": b, "n": 0, "pred": 0.0, "win": 0} for a, b in bins]
    for race in races:
        for h, p in zip(race["horses"], model_probs(race["horses"], 1.0, temperature)):
            for c in calib:
                if c["from"] <= p < c["to"]:
                    c["n"] += 1
                    c["pred"] += p
                    c["win"] += h["place"] == 1
    for c in calib:
        c["pred"] = c["pred"] / c["n"] if c["n"] else None
        c["actual"] = c["win"] / c["n"] if c["n"] else None

    return {
        "races": len(races), "horses": sum(len(r["horses"]) for r in races),
        "from": races[0]["date"], "to": races[-1]["date"],
        "byStars": {s: _fin(a) for s, a in by_star.items()},
        "topRated": _fin(top_rated), "favorite": _fin(favorite),
        "underrated": _fin(under), "overrated": _fin(over),
        "grid": grid, "temperature": temperature,
        "split": {"trainRaces": len(train), "testRaces": len(test), "trainFrom": train[0]["date"],
                  "testFrom": test[0]["date"] if test else None,
                  "best": best, "bestTest": best_test, "favoriteTest": _fin(fav_test)},
        "calibration": calib,
    }
