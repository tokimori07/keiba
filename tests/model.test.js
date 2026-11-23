const test = require('node:test');
const assert = require('node:assert');
const M = require('../js/model.js');
const S = require('../js/stats.js');
const close = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);
const sum = (m) => Array.from(m.values()).reduce((a, b) => a + b, 0);

test('市場確率は合計1、控除率20%を推定', () => {
  const odds = [2, 4, 8, 8].map((o) => o * 0.8); // 公正オッズ×0.8
  close(M.marketProbs(odds).reduce((a, b) => a + b, 0), 1);
  close(M.overround(odds), 0.2);
});
test('Harville: 各券種の確率合計が整合', () => {
  const p = M.scoreProbs([90, 80, 70, 60, 50, 50, 40, 30, 30, 20], 10);
  const h = M.harville(p);
  close(sum(h.exacta), 1); close(sum(h.quinella), 1);
  close(sum(h.trifecta), 1); close(sum(h.trio), 1);
  close(sum(h.wide), 3);                       // 1レースでワイドは3組的中
  close(h.place.reduce((a, b) => a + b, 0), 3); // 複勝3頭
});
test('補正Harville: 人気馬どうしの組み合わせを元のHarvilleより低く見る', () => {
  const p = [0.4, 0.25, 0.15, 0.1, 0.05, 0.05];
  const a = M.harville(p, { second: 1, third: 1 }), b = M.harville(p);
  assert.ok(b.trio.get('0-1-2') < a.trio.get('0-1-2'));
  close(sum(b.trio), 1);
});
test('7頭以下は複勝2着まで', () => {
  const h = M.harville(M.scoreProbs([60, 50, 50, 50, 40, 40], 10));
  close(h.place.reduce((a, b) => a + b, 0), 2);
});
test('ブレンド: w=0で市場、w=1で自分の確率', () => {
  const a = [0.5, 0.3, 0.2], b = [0.2, 0.3, 0.5];
  M.blend(a, b, 0).forEach((v, i) => close(v, b[i], 1e-6));
  M.blend(a, b, 1).forEach((v, i) => close(v, a[i], 1e-6));
});
test('ケリー: EV<=1なら0', () => {
  assert.strictEqual(M.kelly(0.2, 5), 0);
  close(M.kelly(0.3, 5), (1.5 - 1) / 4);
});
test('収支集計', () => {
  const bets = [
    { date: '2026-01-01', stake: 1000, payout: 0 },
    { date: '2026-01-02', stake: 1000, payout: 0 },
    { date: '2026-01-03', stake: 1000, payout: 3500 },
    { date: '2026-01-04', stake: 500, payout: null },
  ];
  const s = S.summarize(bets);
  assert.strictEqual(s.count, 3); assert.strictEqual(s.pending, 1);
  assert.strictEqual(s.profit, 500); close(s.roi, 3500 / 3000);
  assert.strictEqual(s.maxLosingStreak, 2); assert.strictEqual(s.maxDrawdown, 2000);
});
