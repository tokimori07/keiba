"""
競馬ノート 学習モデル（条件付きロジット / Benter方式）

各馬の「強さ」 U = Σ β_k × 特徴量_k を学習し、レース内で
    P(馬iが勝つ) = exp(U_i) / Σ_j exp(U_j)
とする。特徴量には市場確率の対数 log(p_market) も入れるので、
「オッズをどれだけ信じ、自分の情報をどれだけ足すか」も自動で決まる。

numpy 不要（標準ライブラリのみ）。ニュートン法で数秒で収束する。
"""
import json
import math
import os

# (キー, 表示名, 説明)
FEATURES = [
    ("market", "市場の評価（オッズ）", "単勝オッズから見た勝率（対数）"),
    ("rating", "能力値", "近5走の着差とクラスから算出（レース内で標準化）"),
    ("last", "前走の内容", "前走のパフォーマンス（レース内で標準化）"),
    ("best", "近5走のベスト", "近5走で最も良かったパフォーマンス（レース内で標準化）"),
    ("lastPlace", "前走の着順", "前走の着順÷頭数（小さいほど上位）"),
    ("logDays", "休養明け", "前走からの日数（対数）"),
    ("sameTop3", "同条件の実績", "同じ馬場・近い距離での3着内率"),
    ("fewRuns", "キャリアの浅さ", "近走が3走以下"),
    ("noData", "情報なし", "近走データがない"),
]
KEYS = [k for k, _, _ in FEATURES]
ZSCORE = ("rating", "last", "best")  # レース内で標準化する特徴量


def design(horses, market_p):
    """1レース分の特徴量行列。horses[i]["feat"] と市場確率から作る"""
    feats = [h.get("feat") or {} for h in horses]
    cols = {}
    for k in ZSCORE:
        vals = [f.get(k) for f in feats]
        ok = [v for v in vals if v is not None]
        if len(ok) >= 2:
            m = sum(ok) / len(ok)
            sd = math.sqrt(sum((v - m) ** 2 for v in ok) / len(ok)) or 1.0
            cols[k] = [((v - m) / sd) if v is not None else -0.5 for v in vals]  # 情報なしはやや下に置く
        else:
            cols[k] = [0.0] * len(vals)
    X = []
    for i, f in enumerate(feats):
        X.append([
            math.log(max(market_p[i], 1e-6)),
            cols["rating"][i],
            cols["last"][i],
            cols["best"][i],
            f.get("lastPlace") if f.get("lastPlace") is not None else 0.5,
            f.get("logDays") if f.get("logDays") is not None else math.log(60),
            f.get("sameTop3", 0.2),
            1.0 if f.get("runs", 0) <= 3 else 0.0,
            1.0 if f.get("rating") is None else 0.0,
        ])
    return X


def market_probs(odds):
    inv = [1 / o for o in odds]
    s = sum(inv)
    return [v / s for v in inv]


def softmax(u):
    m = max(u)
    e = [math.exp(x - m) for x in u]
    s = sum(e)
    return [x / s for x in e]


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def solve(A, b):
    """連立一次方程式（ガウスの消去法・部分ピボット）"""
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        M[c], M[p] = M[p], M[c]
        if abs(M[c][c]) < 1e-12:
            continue
        for r in range(n):
            if r != c:
                f = M[r][c] / M[c][c]
                for k in range(c, n + 1):
                    M[r][k] -= f * M[c][k]
    return [M[i][n] / M[i][i] if abs(M[i][i]) > 1e-12 else 0.0 for i in range(n)]


def prepare(races):
    """[(X, winner_index)] に変換。勝ち馬がいないレースは除外"""
    data = []
    for race in races:
        hs = race["horses"]
        win = [i for i, h in enumerate(hs) if h["place"] == 1]
        if len(hs) < 3 or len(win) != 1:
            continue
        data.append((design(hs, market_probs([h["odds"] for h in hs])), win[0]))
    return data


def fit(races, l2=2.0, iters=30):
    """
    条件付きロジットを最大事後推定。L2正則化は「市場どおり(β_market=1, 他=0)」に向けてかける
    → データが少ないうちは市場とほぼ同じ予測になり、暴れない
    """
    data = prepare(races)
    k = len(KEYS)
    prior = [1.0] + [0.0] * (k - 1)
    beta = prior[:]
    for _ in range(iters):
        grad = [-l2 * (beta[j] - prior[j]) for j in range(k)]
        H = [[(-l2 if a == b else 0.0) for b in range(k)] for a in range(k)]
        for X, w in data:
            p = softmax([dot(beta, x) for x in X])
            mean = [sum(p[i] * X[i][j] for i in range(len(X))) for j in range(k)]
            for j in range(k):
                grad[j] += X[w][j] - mean[j]
            for i in range(len(X)):
                d = [X[i][j] - mean[j] for j in range(k)]
                for a in range(k):
                    pa = p[i] * d[a]
                    for b in range(a, k):
                        H[a][b] -= pa * d[b]
        for a in range(k):
            for b in range(a):
                H[a][b] = H[b][a]
        step = solve([[-v for v in row] for row in H], grad)
        beta = [b + s for b, s in zip(beta, step)]
        if max(abs(s) for s in step) < 1e-6:
            break
    return {"beta": dict(zip(KEYS, beta)), "races": len(data), "l2": l2}


def predict(model, horses, odds):
    """学習済みモデルで勝率を出す（オッズは最新のものを渡す）"""
    beta = [model["beta"][k] for k in KEYS]
    X = design(horses, market_probs(odds))
    return softmax([dot(beta, x) for x in X])


def own_strength(model, horses):
    """市場以外の部分 U_own（画面側で最新オッズと組み合わせて p ∝ exp(U_own + β_market·log p_market)）"""
    beta = [model["beta"][k] for k in KEYS]
    X = design(horses, [1.0] * len(horses))  # log(1)=0 → 市場項を除いた値
    return [dot(beta, x) for x in X]


def log_loss(data_races, prob_fn):
    total, n = 0.0, 0
    for race in data_races:
        hs = race["horses"]
        win = [i for i, h in enumerate(hs) if h["place"] == 1]
        if len(hs) < 3 or len(win) != 1:
            continue
        p = prob_fn(race)
        total -= math.log(max(p[win[0]], 1e-9))
        n += 1
    return total / n if n else None


L2_GRID = [3, 10, 30, 100, 300]


def choose_l2(train):
    """学習期間をさらに前後に分け、後ろで一番よく当たった正則化の強さを選ぶ（データが少ないほど強く＝市場寄り）"""
    cut = int(len(train) * 0.7)
    a, b = train[:cut], train[cut:]
    market_ll = log_loss(b, lambda r: market_probs([h["odds"] for h in r["horses"]]))
    best, best_ll = L2_GRID[-1], None
    for l2 in L2_GRID:
        m = fit(a, l2)
        ll = log_loss(b, lambda r: predict(m, r["horses"], [h["odds"] for h in r["horses"]]))
        if ll is not None and (best_ll is None or ll < best_ll):
            best, best_ll = l2, ll
    # 市場をはっきり(0.5%以上)上回れないなら、一番市場寄りの設定にする（偶然の当たりに乗らない）
    if market_ll is None or best_ll is None or best_ll > market_ll * 0.995:
        return L2_GRID[-1]
    return best


def evaluate(races, l2=None):
    """前半70%で学習 → 後半30%で「市場（オッズ）だけ」と比べて評価"""
    races = sorted(races, key=lambda r: (r["date"], r["race_id"]))
    cut = int(len(races) * 0.7)
    train, test = races[:cut], races[cut:]
    if len(train) < 30 or len(test) < 10:
        raise ValueError("学習には40レース以上のバックテストデータが必要です（期間を広げてください）")
    if l2 is None:
        l2 = choose_l2(train)
    model = fit(train, l2)
    mk = lambda r: market_probs([h["odds"] for h in r["horses"]])
    md = lambda r: predict(model, r["horses"], [h["odds"] for h in r["horses"]])
    ll_market, ll_model = log_loss(test, mk), log_loss(test, md)

    # 後半期間の成績
    top_model = top_market = n = 0
    bands = [(1.0, 1.1), (1.1, 1.3), (1.3, 1.6), (1.6, 99)]
    bets = {b: {"bets": 0, "hits": 0, "pay": 0} for b in bands}
    calib = [{"from": a, "to": b, "n": 0, "pred": 0.0, "win": 0} for a, b in [(0, .05), (.05, .1), (.1, .2), (.2, .35), (.35, 1.01)]]
    for race in test:
        hs = race["horses"]
        p = md(race)
        n += 1
        top_model += hs[max(range(len(hs)), key=lambda i: p[i])]["place"] == 1
        top_market += hs[min(range(len(hs)), key=lambda i: hs[i]["odds"])]["place"] == 1
        for h, pi in zip(hs, p):
            ev = pi * h["odds"]
            for b in bands:
                if b[0] <= ev < b[1]:
                    bets[b]["bets"] += 1
                    if h["place"] == 1:
                        bets[b]["hits"] += 1
                        bets[b]["pay"] += round(h["odds"] * 100)
            for c in calib:
                if c["from"] <= pi < c["to"]:
                    c["n"] += 1
                    c["pred"] += pi
                    c["win"] += h["place"] == 1
    for c in calib:
        c["pred"] = c["pred"] / c["n"] if c["n"] else None
        c["actual"] = c["win"] / c["n"] if c["n"] else None
    ev_rows = [{"from": a, "to": b, **v, "roi": v["pay"] / (v["bets"] * 100) if v["bets"] else None} for (a, b), v in bets.items()]
    full = fit(races, l2)  # 実際に使うのは全期間で学習したモデル
    return {
        "trainRaces": len(train), "testRaces": len(test), "l2": l2,
        "trainFrom": train[0]["date"], "testFrom": test[0]["date"], "to": races[-1]["date"],
        "logLossMarket": ll_market, "logLossModel": ll_model,
        "improvement": (ll_market - ll_model) / ll_market if ll_market else None,
        "topModel": top_model / n if n else None, "topMarket": top_market / n if n else None,
        "evBands": ev_rows, "calibration": calib,
        "testModel": model["beta"], "model": {**full, "trainedAt": races[-1]["date"], "from": races[0]["date"]},
        "features": [{"key": k, "label": lb, "desc": d} for k, lb, d in FEATURES],
    }


def model_path(root):
    return os.path.join(root, ".cache", "model.json")


def save_model(root, model):
    os.makedirs(os.path.dirname(model_path(root)), exist_ok=True)
    with open(model_path(root), "w", encoding="utf-8") as f:
        json.dump(model, f, ensure_ascii=False, indent=1)


def load_model(root):
    try:
        with open(model_path(root), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None
