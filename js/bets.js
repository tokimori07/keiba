/*
 * 馬券の組み合わせと精算（DOM非依存）
 *   - 選んだ馬と買い方（通常／ボックス）から買い目の組み合わせを作る
 *   - 確定した払戻から的中・払戻額を計算する
 */
(function (root) {
  'use strict';

  // 券種ごとの「選ぶ頭数」と「着順の順番が関係あるか」
  const TYPES = {
    単勝: { k: 1, ordered: false },
    複勝: { k: 1, ordered: false },
    枠連: { k: 2, ordered: false },
    馬連: { k: 2, ordered: false },
    ワイド: { k: 2, ordered: false },
    馬単: { k: 2, ordered: true },
    '3連複': { k: 3, ordered: false },
    '3連単': { k: 3, ordered: true },
  };

  function combinations(arr, k) {
    if (k === 0) return [[]];
    const out = [];
    arr.forEach((x, i) => combinations(arr.slice(i + 1), k - 1).forEach((c) => out.push([x, ...c])));
    return out;
  }
  function permutations(arr, k) {
    if (k === 0) return [[]];
    const out = [];
    arr.forEach((x, i) => permutations(arr.filter((_, j) => j !== i), k - 1).forEach((c) => out.push([x, ...c])));
    return out;
  }

  /**
   * 買い目の組み合わせを作る
   * @param {string} type 券種
   * @param {'normal'|'box'} mode
   * @param {number[]} picks 選んだ馬番（選んだ順）
   * @returns {number[][]} 組み合わせ（着順が関係ない券種は昇順）
   */
  function buildCombos(type, mode, picks) {
    const t = TYPES[type];
    if (!t) return [];
    const uniq = picks.filter((x, i) => picks.indexOf(x) === i);
    if (t.k === 1) return uniq.map((n) => [n]);  // 単勝・複勝は選んだ頭数分
    if (mode === 'box') {
      if (uniq.length < t.k) return [];
      const list = t.ordered ? permutations(uniq, t.k) : combinations(uniq, t.k);
      return t.ordered ? list : list.map((c) => c.slice().sort((a, b) => a - b));
    }
    if (uniq.length !== t.k) return [];
    return [t.ordered ? uniq : uniq.slice().sort((a, b) => a - b)];
  }

  /** 表示用の買い目文字列 */
  function label(type, mode, picks) {
    const t = TYPES[type];
    if (!t) return picks.join('-');
    if (t.k === 1) return picks.join(',');
    if (mode === 'box') return `BOX ${picks.join('-')}`;
    return picks.join(t.ordered ? '→' : '-');
  }

  /**
   * 精算: 払戻（100円あたり）と組み合わせから、払戻額を計算
   * @param {{type:string, combos:number[][], unit:number}} bet unit=1点あたりの金額
   * @param {Object} payouts {"単勝":[{nos,pay}],...}
   * @returns {{payout:number, hits:number}}
   */
  function settle(bet, payouts) {
    const t = TYPES[bet.type];
    const list = (payouts && payouts[bet.type]) || [];
    const key = (nos) => (t && t.ordered ? nos : nos.slice().sort((a, b) => a - b)).join('-');
    const table = new Map();
    list.forEach((p) => table.set(key(p.nos), (table.get(key(p.nos)) || 0) + p.pay));
    let payout = 0, hits = 0;
    (bet.combos || []).forEach((c) => {
      const pay = table.get(key(c));
      if (pay) { payout += Math.round((pay * bet.unit) / 100); hits++; }
    });
    return { payout, hits };
  }

  const api = { TYPES, buildCombos, label, settle, combinations, permutations };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KeibaBets = api;
})(typeof window !== 'undefined' ? window : globalThis);
