import json, os, subprocess, sys, unittest
from datetime import date
ROOT = os.path.join(os.path.dirname(__file__), '..')
sys.path.insert(0, ROOT)
import backtest as B

def H(no, rating, odds, place, pop, fuku=0):
    return {"no": no, "rating": rating, "odds": odds, "place": place, "pop": pop, "fukusho": fuku}

class T(unittest.TestCase):
    def test_model_matches_js(self):
        hs = [H(1, 95, 3.0, 1, 1), H(2, 88, 5.5, 2, 2), H(3, None, 9.0, 3, 3), H(4, 80, 20.0, 4, 4)]
        py = B.model_probs(hs, 0.5, 10)
        # 予想タブと同じ: スコア換算 → KeibaModel.blend(scoreProbs, marketProbs)
        scores = [45 if h["rating"] is None else None for h in hs]
        vals = [h["rating"] for h in hs if h["rating"] is not None]
        m = sum(vals) / len(vals); sd = (sum((v - m) ** 2 for v in vals) / len(vals)) ** .5
        scores = [45 if h["rating"] is None else max(10, min(95, round(50 + (h["rating"] - m) / sd * 15))) for h in hs]
        js = f"""const M=require('./js/model.js');const o={json.dumps([h['odds'] for h in hs])};
          console.log(JSON.stringify(M.blend(M.scoreProbs({json.dumps(scores)},10),M.marketProbs(o),0.5)))"""
        out = json.loads(subprocess.check_output(["node", "-e", js], cwd=ROOT))
        for a, b in zip(py, out):
            self.assertAlmostEqual(a, b, places=9)

    def test_build_race_and_leakage(self):
        info = {"race_id": "x", "name": "テストS", "venue": "東京", "surface": "芝", "distance": 1600}
        run = lambda d, place: {"date": d, "place": place, "margin": 0.1 * (place - 1), "class": "OP", "distance": 1600, "surface": "芝"}
        past = {i: {"runs": [run("2026-10-01", i)] + ([run("2026-12-01", 1)] if i == 5 else [])} for i in range(1, 7)}
        result = {"rows": [{"no": i, "place": i, "odds": 2.0 * i, "pop": i} for i in range(1, 7)], "fukusho": {1: 120, 2: 200, 3: 300}}
        race = B.build_race(info, past, result, "2026-11-01")
        h5 = [h for h in race["horses"] if h["no"] == 5][0]
        self.assertEqual(h5["rating"], B.A.rate_horse([run("2026-10-01", 5)], "芝", 1600))  # 未来の走は使わない
        self.assertEqual([h["rank"] for h in sorted(race["horses"], key=lambda h: h["no"])], [1, 2, 3, 4, 5, 6])

    def test_skip_debut_races(self):
        info = {"race_id": "x", "name": "2歳新馬", "venue": "東京", "surface": "芝", "distance": 1600}
        past = {i: {"runs": []} for i in range(1, 8)}
        result = {"rows": [{"no": i, "place": i, "odds": 3.0, "pop": i} for i in range(1, 8)], "fukusho": {}}
        self.assertIsNone(B.build_race(info, past, result, "2026-11-01"))

    def test_evaluate(self):
        races = []
        for k in range(20):
            hs = [H(1, 95, 4.0, 1, 2, 150), H(2, 85, 2.0, 2, 1, 110), H(3, 80, 8.0, 3, 3, 200), H(4, 75, 15.0, 4, 4), H(5, 70, 30.0, 5, 5)]
            for i, h in enumerate(sorted(hs, key=lambda h: -h["rating"]), 1): h["rank"] = i
            st = B.A.stars_in_field({h["no"]: h["rating"] for h in hs})
            for h in hs: h["stars"] = st[h["no"]]
            races.append({"race_id": str(k), "date": f"2026-10-{k + 1:02d}", "horses": hs})
        r = B.evaluate(races)
        self.assertEqual(r["topRated"]["winRate"], 1.0)
        self.assertAlmostEqual(r["topRated"]["tanRoi"], 4.0)
        self.assertAlmostEqual(r["topRated"]["fukuRoi"], 1.5)
        self.assertEqual(r["favorite"]["winRate"], 0.0)
        self.assertEqual(r["split"]["trainRaces"], 14)
        self.assertEqual(len(r["grid"]), 25)

    def test_race_dates(self):
        ds = list(B.race_dates(date(2026, 11, 16), date(2026, 11, 23)))
        self.assertEqual([d.isoformat() for d in ds], ["2026-11-16", "2026-11-21", "2026-11-22", "2026-11-23"])

if __name__ == "__main__": unittest.main()
