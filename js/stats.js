/* 収支集計ロジック（DOM非依存） */
(function (root) {
  'use strict';

  const isSettled = (b) => b.payout !== null && b.payout !== undefined && b.payout !== '';

  function summarize(bets) {
    const settled = bets.filter(isSettled);
    const stake = settled.reduce((a, b) => a + Number(b.stake || 0), 0);
    const payout = settled.reduce((a, b) => a + Number(b.payout || 0), 0);
    const hits = settled.filter((b) => Number(b.payout) > 0).length;
    // 連敗・ドローダウンは日付順に計算
    const ordered = settled.slice().sort(byDate);
    let streak = 0, maxStreak = 0, cum = 0, peak = 0, maxDD = 0;
    ordered.forEach((b) => {
      if (Number(b.payout) > 0) streak = 0;
      else maxStreak = Math.max(maxStreak, ++streak);
      cum += Number(b.payout) - Number(b.stake);
      peak = Math.max(peak, cum);
      maxDD = Math.max(maxDD, peak - cum);
    });
    return {
      count: settled.length,
      pending: bets.length - settled.length,
      stake,
      payout,
      profit: payout - stake,
      roi: stake > 0 ? payout / stake : 0,
      hitRate: settled.length > 0 ? hits / settled.length : 0,
      hits,
      maxLosingStreak: maxStreak,
      maxDrawdown: maxDD,
    };
  }

  function byDate(a, b) {
    return (a.date || '').localeCompare(b.date || '') || (a.createdAt || 0) - (b.createdAt || 0);
  }

  function groupBy(bets, keyFn) {
    const groups = new Map();
    bets.forEach((b) => {
      const k = keyFn(b) || '(未設定)';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(b);
    });
    return Array.from(groups.entries())
      .map(([key, list]) => ({ key, ...summarize(list) }))
      .filter((g) => g.count > 0);
  }

  function evBand(b) {
    const ev = Number(b.ev);
    if (!b.ev || !isFinite(ev)) return '(EV未入力)';
    if (ev < 1.0) return 'EV 1.0未満';
    if (ev < 1.2) return 'EV 1.0〜1.2';
    if (ev < 1.5) return 'EV 1.2〜1.5';
    return 'EV 1.5以上';
  }

  /** 累積収支の時系列 */
  function cumulative(bets) {
    let cum = 0;
    return bets
      .filter(isSettled)
      .sort(byDate)
      .map((b) => {
        cum += Number(b.payout) - Number(b.stake);
        return { date: b.date, value: cum };
      });
  }

  function filterPeriod(bets, period, today) {
    const now = today ? new Date(today) : new Date();
    const ymd = (d) => d.toISOString().slice(0, 10);
    if (period === 'year') {
      const y = String(now.getFullYear());
      return bets.filter((b) => (b.date || '').startsWith(y));
    }
    if (period === 'month') {
      const m = ymd(now).slice(0, 7);
      return bets.filter((b) => (b.date || '').startsWith(m));
    }
    if (period === '30d') {
      const from = new Date(now.getTime() - 30 * 86400000);
      return bets.filter((b) => (b.date || '') >= ymd(from));
    }
    return bets;
  }

  const api = { summarize, groupBy, evBand, cumulative, filterPeriod, isSettled, byDate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KeibaStats = api;
})(typeof window !== 'undefined' ? window : globalThis);
