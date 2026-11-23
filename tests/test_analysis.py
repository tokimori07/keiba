import os, sys, unittest
from datetime import date
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import analysis as A

PAST_ROW = '''<tr class="HorseList" id="tr_1"><td class="Waku3">3</td><td class="Waku">5</td>
<td class="Horse_Info"><div class="Horse02"><a href="x"> テストホース</a></div>
<div class="Horse06 fc"><span class="kyakusitu">先</span>中3週</div></td>
<td class="Past Ranking_2"><div class="Data_Item"><div class="Data01"><span>2026.10.25&nbsp;東京</span><span class="Num">2</span></div>
<div class="Data02"><a href="r">神無月S<span class="Icon_GradeType Icon_GradeType5">OP</span></a></div>
<div class="Data05">ダ1400 1:22.9 <strong>稍</strong></div><div class="Data03">16頭&nbsp;2番&nbsp;1人 騎手 57.0</div>
<div class="Data06">9-7&nbsp;(36.0)&nbsp;492(-2)</div><div class="Data07"><a href="h">勝ち馬</a>(0.2)</div></div></td>
<td class="Past"><div class="Data_Item"><div class="Data01"><span>2026.06.06&nbsp;東京</span><span class="Num">中止</span></div>
<div class="Data02"><a href="r">麦秋S<span class="Icon_GradeType Icon_GradeType16">3勝</span></a></div>
<div class="Data05">ダ1400</div><div class="Data03">15頭</div><div class="Data06"></div><div class="Data07"></div></div></td></tr>'''

RESULT = '''<table id="All_Result_Table"><tr><th>着順</th></tr>
<tr><td><div class="Rank">1</div></td><td class="Num Waku7"><div>7</div></td><td class="Num Txt_C"><div>13</div></td>
<span class="HorseNameSpan">A</span><span class="OddsPeople">5</span><td class="Odds Txt_R">\n<span  class="Odds_Ninki">9.8</span>\n</td><td class="PassageRate">3-2</td></tr>
<tr><td><div class="Rank">2</div></td><td class="Num Waku1"><div>1</div></td><td class="Num Txt_C"><div>1</div></td>
<span class="HorseNameSpan">B</span><span class="OddsPeople">1</span><td class="Odds Txt_R">\n<span >2.1</span>\n</td><td class="PassageRate">1-1</td></tr>
<tr><td><div class="Rank">除外</div></td><td class="Num Waku8"><div>8</div></td><td class="Num Txt_C"><div>16</div></td></tr>
</table><tr class="Tan3"><th>3連単</th><td class="Payout"><span>52,470円</span></td></tr>
<tr class="Umaren"><th>馬連</th><td class="Payout"><span>640円</span></td></tr>'''

class T(unittest.TestCase):
    def test_past5(self):
        p = A.parse_past5(PAST_ROW)[5]
        self.assertEqual((p["waku"], p["name"], p["style"]), (3, "テストホース", "先"))
        r = p["runs"][0]
        self.assertEqual((r["class"], r["place"], r["surface"], r["distance"], r["field"], r["pop"], r["margin"], r["last3f"]),
                         ("OP", 2, "ダ", 1400, 16, 1, 0.2, 36.0))
        self.assertIsNone(p["runs"][1]["place"])  # 中止
    def test_rating_and_stars(self):
        runs = A.parse_past5(PAST_ROW)[5]["runs"]
        rating = A.rate_horse(runs, "ダ", 1400)
        self.assertAlmostEqual(rating, 89 - 0.2 * 8 * (1600 / 1400) ** 0.5, places=1)
        self.assertEqual(A.stars_in_field({1: 100, 2: 97, 3: 91, 4: 80, 5: None}), {1: 5, 2: 4, 3: 3, 4: 1, 5: None})
    def test_class_beats_margin(self):
        g1_5th = {"place": 5, "margin": 0.5, "class": "G1", "distance": 1600, "surface": "芝"}
        win_1 = {"place": 1, "margin": -0.3, "class": "1勝", "distance": 1600, "surface": "芝"}
        self.assertGreater(A.run_score(g1_5th), A.run_score(win_1))
    def test_candidate_dates_same_weekday(self):
        for k in range(1, 11):
            ds = list(A.candidate_dates(date(2026, 11, 22), k))
            self.assertEqual(ds[0].weekday(), 6)
            self.assertLessEqual(abs((ds[0] - date(2026 - k, 11, 22)).days), 3)
    def test_named(self):
        self.assertTrue(A.is_named_race("マイルCS"))
        self.assertFalse(A.is_named_race("3歳以上1勝クラス"))
        self.assertFalse(A.is_named_race("2歳未勝利"))
    def test_find_past(self):
        lists = {"20251123": [{"race_id": "1", "venue": "京都", "name": "マイルCS", "course": "芝1600m"}],
                 "20241117": [{"race_id": "2", "venue": "京都", "name": "マイルＣＳ", "course": "芝1600m"}]}
        got = A.find_past_races({"name": "マイルCS", "venue": "京都"}, date(2026, 11, 22), lambda d: lists.get(d, []), years=5)
        self.assertEqual([r["race_id"] for r in got["races"]], ["1", "2"])
    def test_result_and_trend(self):
        res = A.parse_result(RESULT)
        self.assertEqual(res["field"], 3)
        self.assertEqual([(r["place"], r["waku"], r["no"], r["pop"]) for r in res["rows"]], [(1, 7, 13, 5), (2, 1, 1, 1), (None, 8, 16, None)])
        self.assertEqual([r["odds"] for r in res["rows"]], [9.8, 2.1, None])
        self.assertEqual(res["payout"], {"Tan3": 52470, "Umaren": 640})
        t = A.aggregate_trend([{"year": 2025, "venue": "京都", "name": "マイルCS", "result": res}])
        self.assertEqual(t["favorite"], [0, 1, 0, 0])
        self.assertEqual(t["winnerPopAvg"], 5)
        self.assertEqual(t["roughStars"], 4)
        self.assertEqual(t["waku"][7]["top3"], 1)

if __name__ == "__main__": unittest.main()


class Payouts(unittest.TestCase):
    def test_class_from_name(self):
        self.assertEqual(A.race_class("", "3歳以上1勝クラス", "東京"), "1勝")
        self.assertEqual(A.race_class("", "サラ系３歳以上 ２勝クラス", ""), "2勝")
        self.assertEqual(A.race_class("", "城崎特別", "阪神"), "不明")

    def test_past_cell_extras(self):
        run = A.parse_past5(PAST_ROW)[5]["runs"][0]
        self.assertAlmostEqual(run["time"], 82.9)
        self.assertEqual(run["cond"], "稍")
        self.assertEqual(run["bodyWeight"], 492)

    def test_speed_and_up_index(self):
        res = {"rows": [{"place": 1, "time": 83.0, "last3f": 36.0}] + [{"place": 3, "time": 83.5, "last3f": 36.4}] * 8}
        std = A.build_standards([("東京", "ダ", 1400, res)] * 3)
        run = {"venue": "東京", "surface": "ダ", "distance": 1400, "time": 82.9, "cond": "良", "place": 2, "last3f": 35.9}
        self.assertGreater(A.speed_index(run, std), 0)       # 基準より速い
        self.assertGreater(A.up_index(run, std), 0)
        slow = dict(run, time=84.0)
        self.assertLess(A.speed_index(slow, std), A.speed_index(run, std))

    def test_features_with_context(self):
        runs = A.parse_past5(PAST_ROW)[5]["runs"]
        f = A.horse_features(runs, "ダ", 1400, "2026-11-20",
                             {"weight_diff": 12, "cur_class": "G3", "up_rank_of": lambda rid, u: 0.1})
        self.assertAlmostEqual(f["wDiff"], 1.2)
        self.assertGreater(f["classUp"], 0)                  # OP → G3 は昇級
        self.assertAlmostEqual(f["hidden"], 2 / 16 - 0.1)

    def test_parse_payouts(self):
        html = '''<tr class="Tansho"><th>単勝</th><td class="Result"><div><span>15</span></div><div><span></span></div></td>
<td class="Payout"><span>180円</span></td></tr>
<tr class="Fukusho"><th>複勝</th><td class="Result"><div><span>15</span></div><div><span></span></div><div><span>6</span></div></td>
<td class="Payout"><span>110円<br />230円</span></td></tr>
<tr class="Wide"><th>ワイド</th><td class="Result"><ul><li><span>6</span></li><li><span>15</span></li><li></li></ul><ul><li><span>3</span></li><li><span>15</span></li><li></li></ul></td>
<td class="Payout"><span>340円<br />3,930円</span></td></tr>
<tr class="Tan3"><th>3連単</th><td class="Result"><ul><li><span>15</span></li><li><span>6</span></li><li><span>3</span></li></ul></td>
<td class="Payout"><span>52,470円</span></td></tr>'''
        p = A.parse_payouts(html)
        self.assertEqual(p["単勝"], [{"nos": [15], "pay": 180}])
        self.assertEqual(p["複勝"], [{"nos": [15], "pay": 110}, {"nos": [6], "pay": 230}])
        self.assertEqual(p["ワイド"][1], {"nos": [3, 15], "pay": 3930})
        self.assertEqual(p["3連単"], [{"nos": [15, 6, 3], "pay": 52470}])
        self.assertEqual(A.parse_payouts("<html>発走前</html>"), {})
