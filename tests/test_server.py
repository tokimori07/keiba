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


class UpdaterTest(unittest.TestCase):
    def setUp(self):
        import io, tempfile, zipfile
        self.tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.tmp, ".cache"))
        open(os.path.join(self.tmp, ".cache", "keep.txt"), "w").write("data")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("keiba-br/server.py", 'APP_VERSION = "9999.01.01-a"\n')
            z.writestr("keiba-br/index.html", "<html>new</html>")
            z.writestr("keiba-br/js/app.js", "// new")
            z.writestr("keiba-br/.cache/keep.txt", "overwritten?")
            z.writestr("keiba-br/../evil.txt", "x")
            z.writestr("keiba-br/tests/t.py", "x")
        self.zip = buf.getvalue()
        self.orig = (S.ROOT, S.restart)
        S.ROOT = self.tmp
        S.restart = lambda: None

    def tearDown(self):
        S.ROOT, S.restart = self.orig

    def fake(self, url, timeout=20):
        if url.startswith("https://raw.githubusercontent.com/"):
            return b'APP_VERSION = "9999.01.01-a"\n'
        return self.zip

    def test_apply_replaces_only_app_files(self):
        u = S.Updater()
        u._fetch = self.fake
        r = u.apply()
        self.assertTrue(r["applied"])
        self.assertEqual(open(os.path.join(self.tmp, "index.html")).read(), "<html>new</html>")
        self.assertEqual(open(os.path.join(self.tmp, "js", "app.js")).read(), "// new")
        self.assertEqual(open(os.path.join(self.tmp, ".cache", "keep.txt")).read(), "data")  # 記録・学習データは触らない
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "tests")))
        self.assertFalse(os.path.exists(os.path.join(os.path.dirname(self.tmp), "evil.txt")))

    def test_no_update_when_same_version(self):
        u = S.Updater()
        u._fetch = lambda url, timeout=20: ('APP_VERSION = "%s"\n' % S.APP_VERSION).encode()
        self.assertFalse(u.check()["available"])
        self.assertFalse(u.apply()["applied"])


class StateStoreTest(unittest.TestCase):
    def test_conflict_detection(self):
        import tempfile
        st = S.StateStore(tempfile.mkdtemp())
        self.assertEqual(st.get()["rev"], 0)
        ok, cur = st.put(0, {"bets": [1]})
        self.assertTrue(ok); self.assertEqual(cur["rev"], 1)
        ok, cur = st.put(0, {"bets": [2]})          # 古い版からの保存は拒否して、最新を返す
        self.assertFalse(ok); self.assertEqual(cur["data"], {"bets": [1]})
        ok, cur = st.put(1, {"bets": [1, 2]})
        self.assertTrue(ok); self.assertEqual(st.get()["data"], {"bets": [1, 2]})
