const test = require('node:test');
const assert = require('node:assert');
const P = require('../js/pace.js');

const run = (fc, lc, field, extra = {}) => ({ surface: '芝', distance: 1600, place: 3, firstCorner: fc, lastCorner: lc, field, ...extra });

test('近走の位置取りから脚質プロフィール', () => {
  const p = P.profile([run(1, 1, 16), run(1, 2, 16), run(2, 2, 16)], '芝', 1600);
  assert.ok(p.early < 0.05);
  assert.ok(p.nigeRate > 0.6);
  const q = P.profile([run(15, 12, 16), run(14, 10, 16)], '芝', 1600);
  assert.ok(q.early > 0.8);
});

test('逃げ馬が多いとハイペース、いなければスロー', () => {
  const nige = (no) => ({ no, runs: [run(1, 1, 16), run(1, 1, 16)] });
  const mid = (no) => ({ no, runs: [run(9, 8, 16), run(10, 9, 16)] });
  const back = (no) => ({ no, runs: [run(15, 12, 16)] });
  const high = P.predict([nige(1), nige(2), nige(3), mid(4), mid(5), back(6), back(7)], '芝', 1600);
  assert.strictEqual(high.pace, 'ハイ');
  assert.deepStrictEqual(high.leaders.sort(), [1, 2, 3]);
  const slow = P.predict([mid(1), mid(2), mid(3), mid(4), back(5), back(6), back(7), back(8)], '芝', 1600);
  assert.strictEqual(slow.pace, 'スロー');
});

test('ハイペースでは上がりの速い後方の馬が展開利', () => {
  const nige = (no) => ({ no, runs: [run(1, 1, 16, { up: -0.5 })] });
  const closer = { no: 9, runs: [run(15, 10, 16, { up: 1.0 })] };
  const r = P.predict([nige(1), nige(2), nige(3), closer, { no: 5, runs: [run(8, 8, 16, { up: 0 })] }], '芝', 1600);
  const c = r.horses.find((h) => h.no === 9);
  assert.ok(c.paceEdge > 0);
  assert.ok(c.finishRank < c.earlyRank);
});

test('データのない馬は中団に置く', () => {
  const r = P.predict([{ no: 1, runs: [] }, { no: 2, runs: [run(1, 1, 10)] }], '芝', 1600);
  assert.ok(r.horses.find((h) => h.no === 1).unknown);
});
