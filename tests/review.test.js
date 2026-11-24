const test = require('node:test');
const assert = require('node:assert');
const R = require('../js/review.js');

const payouts = {
  単勝: [{ nos: [3], pay: 520 }],
  複勝: [{ nos: [3], pay: 180 }, { nos: [1], pay: 120 }, { nos: [5], pay: 300 }],
  '3連単': [{ nos: [3, 1, 5], pay: 12340 }],
};

test('払戻から勝ち馬・3着内・払戻を作る', () => {
  const r = R.resultFromPayouts(payouts);
  assert.deepStrictEqual(r.win, [3]);
  assert.deepStrictEqual(r.top3, [3, 1, 5]);
  assert.strictEqual(r.winPay[3], 520);
  assert.strictEqual(r.placePay[5], 300);
});

test('印別・1番人気・オッズの動きを集計', () => {
  const pred = {
    horses: [
      { no: 1, odds: 2.0, pm: 0.4, p: 0.35, mark: '○' },
      { no: 3, odds: 5.2, pm: 0.15, p: 0.2, mark: '◎' },
      { no: 5, odds: 9.0, pm: 0.09, p: 0.09, mark: '' },
      { no: 7, odds: 30, pm: 0.03, p: 0.02, mark: '△' },
    ],
    result: R.resultFromPayouts(payouts),
    final: { 1: 1.8, 3: 5.2, 5: 12, 7: 31 },
    first: { 1: 2.0, 3: 8.0, 5: 8.0, 7: 30 },
  };
  const a = R.analyze([pred]);
  assert.strictEqual(a.races, 1);
  assert.strictEqual(a.marks['◎'].win, 1);
  assert.strictEqual(a.marks['◎'].winRoi, 5.2);
  assert.strictEqual(a.marks['○'].top3, 1);
  assert.strictEqual(a.fav.n, 1);                // 1番人気は1番
  assert.strictEqual(a.fav.win, 0);
  assert.strictEqual(a.model.win, 0);            // モデル本命は1番（推定勝率最大）
  assert.strictEqual(a.modelUp.n, 1);            // 3番は予想 > オッズ×1.15
  assert.strictEqual(a.moveDown.n, 1);           // 3番 8.0→5.2 は大きく売れた
  assert.strictEqual(a.moveDown.win, 1);
  assert.strictEqual(a.moveUp.n, 1);             // 5番 8.0→12
});

test('CLV: 買った後にオッズが下がればプラス', () => {
  const bets = [
    { type: '単勝', oddsAtBet: 10, oddsFinal: 8 },
    { type: '単勝', oddsAtBet: 5, oddsFinal: 5 },
    { type: '3連複', oddsAtBet: 50, oddsFinal: 100 },
    { type: '馬連', oddsAtBet: '', oddsFinal: 20 },
  ];
  const c = R.clv(bets);
  assert.strictEqual(c.n, 3);
  assert.ok(Math.abs(c.avg - (0.25 + 0 - 0.5) / 3) < 1e-9);
  assert.ok(Math.abs(c.downRate - 1 / 3) < 1e-9);
});

test('最終オッズの表から馬券のオッズを引く', () => {
  assert.strictEqual(R.finalOddsOf({ type: '単勝', combos: [[3]] }, { horses: [{ no: 3, odds: 5.2, placeMin: 1.8 }] }), 5.2);
  assert.strictEqual(R.finalOddsOf({ type: '複勝', combos: [[3]] }, { horses: [{ no: 3, odds: 5.2, placeMin: 1.8 }] }), 1.8);
  assert.strictEqual(R.finalOddsOf({ type: '3連複', combos: [[5, 1, 3]] }, { odds: { '1-3-5': 45.6 } }), 45.6);
  assert.strictEqual(R.finalOddsOf({ type: '馬単', combos: [[5, 1]] }, { odds: { '5-1': 30.1, '1-5': 12 } }), 30.1);
  assert.strictEqual(R.finalOddsOf({ type: '馬連', combos: [[1, 2], [1, 3]] }, { odds: {} }), null);  // 複数点は対象外
});
