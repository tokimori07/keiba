/*
 * 予想の振り返りと、オッズの見極め（DOM非依存）
 *   - 保存した予想（印・推定勝率・オッズ）と結果を突き合わせ、印別・人気別などの成績を出す
 *   - 買った時点のオッズと最終オッズを比べる（CLV: Closing Line Value）
 */
(function (root) {
  'use strict';

  const MARK_ORDER = ['◎', '○', '▲', '△'];

  function blank() { return { n: 0, win: 0, top3: 0, winPay: 0, placePay: 0 }; }
  function add(g, h, res) {
    g.n++;
    if (res.win.includes(h.no)) { g.win++; g.winPay += res.winPay[h.no] || 0; }
    if (res.top3.includes(h.no)) { g.top3++; g.placePay += res.placePay[h.no] || 0; }
  }
  function finish(g) {
    return { ...g, winRate: g.n ? g.win / g.n : null, top3Rate: g.n ? g.top3 / g.n : null,
      winRoi: g.n ? g.winPay / (g.n * 100) : null, placeRoi: g.n ? g.placePay / (g.n * 100) : null };
  }

  /** 人気順（最終オッズがあればそれで、なければ予想時のオッズで） */
  function popularity(pred) {
    const odds = (h) => (pred.final && pred.final[h.no]) || h.odds;
    const sorted = pred.horses.slice().sort((a, b) => odds(a) - odds(b));
    return Object.fromEntries(sorted.map((h, i) => [h.no, i + 1]));
  }

  /**
   * @param {Object[]} preds 結果の出た予想
   * @returns 印別・1番人気・モデル本命・ずれ・オッズの動き の成績
   */
  function analyze(preds) {
    const marks = Object.fromEntries(MARK_ORDER.map((m) => [m, blank()]));
    const g = { fav: blank(), model: blank(), honmeiAna: blank(), modelUp: blank(), modelDown: blank(),
      moveDown: blank(), moveUp: blank(), moveFlat: blank() };
    let races = 0, marked = 0, moved = 0;
    preds.filter((p) => p.result && p.horses && p.horses.length).forEach((p) => {
      races++;
      const res = p.result;
      const pop = popularity(p);
      const fav = p.horses.find((h) => pop[h.no] === 1);
      if (fav) add(g.fav, fav, res);
      const top = p.horses.reduce((a, b) => (b.p > a.p ? b : a), p.horses[0]);
      add(g.model, top, res);
      if (p.horses.some((h) => h.mark)) marked++;
      p.horses.forEach((h) => {
        if (marks[h.mark]) add(marks[h.mark], h, res);
        if (h.mark === '◎' && pop[h.no] >= 4) add(g.honmeiAna, h, res);
        if (h.pm > 0 && h.p > h.pm * 1.15) add(g.modelUp, h, res);
        if (h.pm > 0 && h.p < h.pm * 0.85) add(g.modelDown, h, res);
        const first = p.first && p.first[h.no], last = p.final && p.final[h.no];
        if (first && last) {
          const r = last / first;
          add(r <= 0.7 ? g.moveDown : r >= 1.3 ? g.moveUp : g.moveFlat, h, res);
        }
      });
      if (p.first) moved++;
    });
    const out = { races, marked, moved, marks: {} };
    MARK_ORDER.forEach((m) => { out.marks[m] = finish(marks[m]); });
    Object.keys(g).forEach((k) => { out[k] = finish(g[k]); });
    return out;
  }

  /** 払戻（{"単勝":[{nos,pay}],...}）から、勝ち馬・3着内・払戻の表を作る */
  function resultFromPayouts(payouts) {
    const tan = payouts['単勝'] || [], fuku = payouts['複勝'] || [], tri = payouts['3連単'] || [];
    const win = tan.map((x) => x.nos[0]);
    const top3 = fuku.length ? fuku.map((x) => x.nos[0]) : (tri[0] ? tri[0].nos.slice() : win.slice());
    return {
      win, top3, order: tri[0] ? tri[0].nos.slice() : [],
      winPay: Object.fromEntries(tan.map((x) => [x.nos[0], x.pay])),
      placePay: Object.fromEntries(fuku.map((x) => [x.nos[0], x.pay])),
    };
  }

  // ---- CLV（買った時点のオッズ ÷ 最終オッズ）----
  const KIND = { 単勝: 'win', 複勝: 'win', 馬連: 'quinella', ワイド: 'wide', 馬単: 'exacta', '3連複': 'trio', '3連単': 'trifecta' };
  const ORDERED = { 馬単: true, '3連単': true };

  /** 最終オッズの表から、その馬券の最終オッズを引く */
  function finalOddsOf(bet, fin) {
    if (!fin || !bet.combos || bet.combos.length !== 1) return null;
    const c = bet.combos[0];
    if (bet.type === '単勝' || bet.type === '複勝') {
      const h = (fin.horses || []).find((x) => Number(x.no) === Number(c[0]));
      if (!h) return null;
      return bet.type === '単勝' ? h.odds : h.placeMin;
    }
    const key = (ORDERED[bet.type] ? c : c.slice().sort((a, b) => a - b)).join('-');
    const o = (fin.odds || {})[key];
    return typeof o === 'number' ? o : null;
  }

  function clv(bets) {
    const rows = bets.filter((b) => b.oddsAtBet > 1 && b.oddsFinal > 1);
    const by = {};
    let sum = 0, down = 0;
    rows.forEach((b) => {
      const v = b.oddsAtBet / b.oddsFinal - 1;  // +: 買った後にオッズが下がった（＝良い値で買えた）
      sum += v; if (b.oddsFinal < b.oddsAtBet) down++;
      const t = by[b.type] || (by[b.type] = { n: 0, sum: 0, down: 0 });
      t.n++; t.sum += v; if (b.oddsFinal < b.oddsAtBet) t.down++;
    });
    return {
      n: rows.length, avg: rows.length ? sum / rows.length : null, downRate: rows.length ? down / rows.length : null,
      byType: Object.entries(by).map(([type, t]) => ({ type, n: t.n, avg: t.sum / t.n, downRate: t.down / t.n })),
    };
  }

  const api = { MARK_ORDER, analyze, popularity, resultFromPayouts, KIND, finalOddsOf, clv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KeibaReview = api;
})(typeof window !== 'undefined' ? window : globalThis);
