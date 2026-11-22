const test = require('node:test');
const assert = require('node:assert');
const B = require('../js/bets.js');
const pays = { 単勝: [{ nos: [15], pay: 180 }], 複勝: [{ nos: [15], pay: 110 }, { nos: [6], pay: 230 }, { nos: [3], pay: 1370 }],
  馬連: [{ nos: [6, 15], pay: 640 }], ワイド: [{ nos: [6, 15], pay: 340 }, { nos: [3, 15], pay: 3930 }, { nos: [3, 6], pay: 9530 }],
  馬単: [{ nos: [15, 6], pay: 870 }], '3連複': [{ nos: [3, 6, 15], pay: 23090 }], '3連単': [{ nos: [15, 6, 3], pay: 52470 }] };

test('ボックスの点数', () => {
  assert.strictEqual(B.buildCombos('馬連', 'box', [1, 2, 3, 4]).length, 6);
  assert.strictEqual(B.buildCombos('馬単', 'box', [1, 2, 3]).length, 6);
  assert.strictEqual(B.buildCombos('3連複', 'box', [1, 2, 3, 4, 5]).length, 10);
  assert.strictEqual(B.buildCombos('3連単', 'box', [1, 2, 3, 4]).length, 24);
  assert.deepStrictEqual(B.buildCombos('単勝', 'normal', [3, 7]), [[3], [7]]);
  assert.deepStrictEqual(B.buildCombos('馬連', 'normal', [15, 6]), [[6, 15]]);
  assert.deepStrictEqual(B.buildCombos('馬単', 'normal', [15, 6]), [[15, 6]]);
  assert.deepStrictEqual(B.buildCombos('馬連', 'normal', [15]), []);
});
test('精算: 通常', () => {
  assert.deepStrictEqual(B.settle({ type: '単勝', combos: [[15]], unit: 500 }, pays), { payout: 900, hits: 1 });
  assert.deepStrictEqual(B.settle({ type: '馬単', combos: [[6, 15]], unit: 100 }, pays), { payout: 0, hits: 0 });  // 着順違い
  assert.deepStrictEqual(B.settle({ type: '馬単', combos: [[15, 6]], unit: 100 }, pays), { payout: 870, hits: 1 });
});
test('精算: ボックス・複数的中', () => {
  const box = { type: 'ワイド', combos: B.buildCombos('ワイド', 'box', [3, 6, 15]), unit: 100 };
  assert.deepStrictEqual(B.settle(box, pays), { payout: 340 + 3930 + 9530, hits: 3 });
  const tri = { type: '3連単', combos: B.buildCombos('3連単', 'box', [3, 6, 15]), unit: 200 };
  assert.deepStrictEqual(B.settle(tri, pays), { payout: 104940, hits: 1 });
  assert.deepStrictEqual(B.settle({ type: '複勝', combos: [[3], [9]], unit: 100 }, pays), { payout: 1370, hits: 1 });
});
test('表示ラベル', () => {
  assert.strictEqual(B.label('3連単', 'normal', [15, 6, 3]), '15→6→3');
  assert.strictEqual(B.label('馬連', 'box', [1, 2, 3]), 'BOX 1-2-3');
});
