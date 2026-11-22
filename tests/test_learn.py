import math, os, random, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import learn as L

def synth(n_races, seed, beta_rating=0.6):
    """真の強さ = log(市場) + 0.6×能力(標準化)。市場は能力情報の一部を見落としている世界"""
    rng = random.Random(seed)
    races = []
    for r in range(n_races):
        n = rng.randint(8, 16)
        base = [rng.gauss(0, 1) for _ in range(n)]
        hidden = [rng.gauss(0, 1) for _ in range(n)]
        mk = L.softmax(base)
        odds = [round(0.8 / p, 1) for p in mk]
        mk = L.market_probs(odds)
        true = L.softmax([math.log(mk[i]) + beta_rating * hidden[i] for i in range(n)])
        u = rng.random(); acc = 0; win = n - 1
        for i, p in enumerate(true):
            acc += p
            if u <= acc: win = i; break
        hs = [{"odds": odds[i], "place": 1 if i == win else 2 + i,
               "feat": {"rating": 80 + 5 * hidden[i], "last": None, "best": None, "lastPlace": None,
                        "logDays": None, "runs": 5, "sameTop3": 0.2}} for i in range(n)]
        races.append({"race_id": str(r), "date": f"2026-{1 + r // 300:02d}-{1 + r % 28:02d}", "horses": hs})
    return races

class T(unittest.TestCase):
    def test_recovers_signal(self):
        m = L.fit(synth(1500, 1), l2=1.0)
        self.assertAlmostEqual(m["beta"]["market"], 1.0, delta=0.15)
        self.assertAlmostEqual(m["beta"]["rating"], 0.6, delta=0.15)
    def test_no_signal_stays_market(self):
        m = L.fit(synth(800, 2, beta_rating=0.0), l2=2.0)
        self.assertLess(abs(m["beta"]["rating"]), 0.15)
    def test_evaluate_beats_market(self):
        r = L.evaluate(synth(1200, 3))
        self.assertGreater(r["improvement"], 0.0)
        self.assertIn("model", r)
    def test_probs_sum_to_one(self):
        m = L.fit(synth(200, 4))
        hs = synth(1, 5)[0]["horses"]
        p = L.predict(m, hs, [h["odds"] for h in hs])
        self.assertAlmostEqual(sum(p), 1.0)
        own = L.own_strength(m, hs)
        mk = L.market_probs([h["odds"] for h in hs])
        p2 = L.softmax([own[i] + m["beta"]["market"] * math.log(mk[i]) for i in range(len(hs))])
        for a, b in zip(p, p2): self.assertAlmostEqual(a, b)

if __name__ == "__main__": unittest.main()


class Jockey(unittest.TestCase):
    def test_no_leakage(self):
        """騎手の成績は前日までの結果だけ。同じ日のレース結果は使わない"""
        mk = lambda rid, date, place: {"race_id": rid, "date": date, "horses": [
            {"jockeyId": "J1", "jockey": "A", "place": place, "odds": 3.0, "feat": {}},
            {"jockeyId": "J2", "jockey": "B", "place": 2 if place == 1 else 1, "odds": 3.0, "feat": {}}]}
        races = [mk("r3", "2026-01-02", 1), mk("r1", "2026-01-01", 1), mk("r2", "2026-01-01", 1)]
        L.add_jockey_feature(races)
        prior = (0 + 0.21 * 30) / 30
        by = {r["race_id"]: r for r in races}
        self.assertAlmostEqual(by["r1"]["horses"][0]["feat"]["jockey"], prior)
        self.assertAlmostEqual(by["r2"]["horses"][0]["feat"]["jockey"], prior)  # 同日の r1 の結果は使わない
        self.assertAlmostEqual(by["r3"]["horses"][0]["feat"]["jockey"], (2 + 0.21 * 30) / 32)
