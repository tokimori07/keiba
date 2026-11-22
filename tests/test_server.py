import json, os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import server as S

ODDS_WIN = {"status": "middle", "data": {"official_datetime": "2026-11-22 15:10:00", "odds": {
    "1": {"01": ["3.2", "", "1"], "02": ["12.5", "", "4"], "03": ["0.0", "", "0"]},
    "2": {"01": ["1.2", "1.5", "1"], "02": ["2.8", "4.1", "4"]}}}}
SHUTUBA = '''<div class="RaceName">ジャパンC</div>
<tr class="HorseList" id="tr_1"><td class="Waku1 Txt_C"><span>1</span></td><td class="Umaban1 Txt_C">1</td>
<td class="HorseInfo"><div><div><span class="HorseName"><a href="x" title="アオゾラ">アオゾラ</a></span></div></div></td></tr>
<tr class="HorseList Cancel" id="tr_3"><td class="Waku2 Txt_C">2</td><td class="Umaban2 Txt_C">3</td>
<td><span class="HorseName"><a href="y">ミカヅキ</a></span></td></tr>
<tr class="HorseList" id="tr_2"><td class="Umaban1 Txt_C">2</td><td><span class="HorseName"><a href="z">ハヤテ</a></span></td></tr>'''
RACE_LIST = '''<li class="RaceList_DataItem"><a href="../race/shutuba.html?race_id=202605050811&rf=race_list">
<div class="Race_Num"><span>11R</span></div><div class="RaceList_ItemTitle"><span class="ItemTitle">ジャパンC</span></div></a>
<a href="../race/movie.html?race_id=202605050811">映像</a></li>
<li><a href="../race/shutuba.html?race_id=202608050801&rf=race_list"><span class="ItemTitle">2歳未勝利</span></a></li>'''

class T(unittest.TestCase):
    def test_race_id(self):
        r = S.parse_race_id("202605050811")
        self.assertEqual((r["venue"], r["race"]), ("東京", 11))
        with self.assertRaises(ValueError): S.parse_race_id("abc")
    def test_race_list(self):
        rs = S.parse_race_list(RACE_LIST)
        self.assertEqual([(r["venue"], r["race"], r["name"]) for r in rs], [("京都", 1, "2歳未勝利"), ("東京", 11, "ジャパンC")])
    def test_win(self):
        payload = S.parse_odds_json(json.dumps(ODDS_WIN))
        names = S.parse_shutuba(SHUTUBA)
        self.assertEqual(names["name"], "ジャパンC")
        hs = S.win_from_payload(payload, names["horses"])
        self.assertEqual([(h["no"], h["name"], h["odds"]) for h in hs], [(1, "アオゾラ", 3.2), (2, "ハヤテ", 12.5), (3, "ミカヅキ", None)])
        self.assertEqual((hs[0]["placeMin"], hs[0]["placeMax"], hs[0]["pop"]), (1.2, 1.5, 1))
    def test_jsonp(self):
        p = S.parse_odds_json("cb(" + json.dumps(ODDS_WIN) + ");")
        self.assertEqual(p["status"], "middle")
    def test_empty_before_sale(self):
        p = S.parse_odds_json('{"status":"yoso","data":""}')
        self.assertEqual(p["odds"], {})
    def test_combos(self):
        payload = {"odds": {"5": {"0103": ["2.1", "2.6", "1"]}, "6": {"0301": ["15.2", "", "8"]}, "8": {"030105": ["120.5", "", "40"]}}}
        self.assertEqual(S.combos_from_payload(payload, "wide", 5), {"1-3": 2.1})
        self.assertEqual(S.combos_from_payload(payload, "exacta", 6), {"3-1": 15.2})
        self.assertEqual(S.combos_from_payload(payload, "trifecta", 8), {"3-1-5": 120.5})
    def test_mock_consistent(self):
        m = S.MockProvider()
        w = m.odds("202605050811", "win")
        n = len(w["horses"])
        self.assertEqual(len(m.odds("202605050811", "quinella")["odds"]), n * (n - 1) // 2)
        self.assertEqual(len(m.odds("202605050811", "trifecta")["odds"]), n * (n - 1) * (n - 2))
        self.assertEqual(len(m.odds("202605050811", "wide")["odds"]), n * (n - 1) // 2)

if __name__ == "__main__": unittest.main()
