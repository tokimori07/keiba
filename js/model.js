/*
 * 予想モデル（純粋な計算ロジック。DOMに依存しない）
 *
 *  1. 単勝オッズ → 市場確率（控除率を除いて正規化）
 *  2. 自分の評価スコア → 自分の確率（softmax）
 *  3. 市場確率と自分の確率を対数線形でブレンド（Benter方式）
 *  4. Harvilleモデルで 複勝/馬連/ワイド/馬単/3連複/3連単 の確率を推定
 *  5. 期待値(EV) = 確率 × オッズ、ケリー基準で推奨購入額
 */
(function (root) {
  'use strict';

  /** 単勝オッズ配列 → 市場の勝率（合計1に正規化） */
  function marketProbs(odds) {
    const inv = odds.map((o) => (o > 1 ? 1 / o : 0));
    const sum = inv.reduce((a, b) => a + b, 0);
    return inv.map((v) => (sum > 0 ? v / sum : 0));
  }

  /** 単勝オッズから推定される控除率（オーバーラウンド） */
  function overround(odds) {
    const sum = odds.reduce((a, o) => a + (o > 1 ? 1 / o : 0), 0);
    return sum > 0 ? 1 - 1 / sum : 0;
  }

  /** スコア(0-100) → 勝率。temperature が小さいほどメリハリが強い */
  function scoreProbs(scores, temperature) {
    const t = temperature > 0 ? temperature : 10;
    const max = Math.max(...scores);
    const ex = scores.map((s) => Math.exp((s - max) / t));
    const sum = ex.reduce((a, b) => a + b, 0);
    return ex.map((v) => v / sum);
  }

  function softmaxRaw(u) {
    const m = Math.max(...u);
    const ex = u.map((x) => Math.exp(x - m));
    const s = ex.reduce((a, b) => a + b, 0);
    return ex.map((v) => v / s);
  }

  /** 対数線形ブレンド: p ∝ pModel^w × pMarket^(1-w) */
  function blend(pModel, pMarket, w) {
    const raw = pModel.map((pm, i) => {
      const a = Math.max(pm, 1e-9);
      const b = Math.max(pMarket[i], 1e-9);
      return Math.exp(w * Math.log(a) + (1 - w) * Math.log(b));
    });
    const sum = raw.reduce((x, y) => x + y, 0);
    return raw.map((v) => v / sum);
  }

  /**
   * Harvilleモデルで全着順(1-2-3着)の確率を列挙し、各券種の確率を集計
   * @param {number[]} p 各馬の勝率
   * @returns {{place:number[], exacta:Map, quinella:Map, wide:Map, trifecta:Map, trio:Map}}
   */
  function harville(p) {
    const n = p.length;
    const placeSlots = n <= 4 ? 1 : n <= 7 ? 2 : 3; // JRA複勝: 4頭以下なし(便宜上1着),5-7頭は2着まで
    const place = new Array(n).fill(0);
    const top2 = new Array(n).fill(0);
    const exacta = new Map();
    const quinella = new Map();
    const wide = new Map();
    const trifecta = new Map();
    const trio = new Map();
    const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
    const key = (arr) => arr.join('-');
    const sorted = (arr) => arr.slice().sort((a, b) => a - b);

    for (let i = 0; i < n; i++) {
      if (p[i] <= 0) continue;
      for (let j = 0; j < n; j++) {
        if (j === i || p[j] <= 0) continue;
        const pij = p[i] * (p[j] / (1 - p[i]));
        add(exacta, key([i, j]), pij);
        add(quinella, key(sorted([i, j])), pij);
        top2[i] += pij;
        top2[j] += pij;
        if (n < 3) continue;
        for (let k = 0; k < n; k++) {
          if (k === i || k === j || p[k] <= 0) continue;
          const pijk = pij * (p[k] / (1 - p[i] - p[j]));
          add(trifecta, key([i, j, k]), pijk);
          add(trio, key(sorted([i, j, k])), pijk);
          add(wide, key(sorted([i, j])), pijk);
          add(wide, key(sorted([i, k])), pijk);
          add(wide, key(sorted([j, k])), pijk);
          place[i] += pijk;
          place[j] += pijk;
          place[k] += pijk;
        }
      }
    }
    if (placeSlots === 2 || n < 3) {
      for (let i = 0; i < n; i++) place[i] = top2[i];
    } else if (placeSlots === 1) {
      for (let i = 0; i < n; i++) place[i] = p[i];
    }
    return { place, exacta, quinella, wide, trifecta, trio };
  }

  /**
   * ケリー基準: 最適な資金投入比率
   * f* = (p × odds − 1) / (odds − 1)
   */
  function kelly(p, odds) {
    if (!(odds > 1)) return 0;
    const f = (p * odds - 1) / (odds - 1);
    return f > 0 ? f : 0;
  }

  /** 100円単位に丸める */
  function roundBet(yen) {
    return Math.floor(yen / 100) * 100;
  }

  /**
   * レース全体の分析
   * @param {{no:number,name:string,odds:number,score:number}[]} horses
   * @param {{weight:number, temperature:number, bankroll:number, kellyFraction:number}} opt
   */
  function analyze(horses, opt) {
    const valid = horses.filter((h) => h.odds > 1);
    const odds = valid.map((h) => h.odds);
    const pMarket = marketProbs(odds);
    let pModel, p;
    if (opt.learned && valid.every((h) => typeof h.ownU === 'number')) {
      // 学習モデル: p ∝ exp(U_own + β_market × log p_market)
      p = softmaxRaw(valid.map((h, i) => h.ownU + opt.learned.betaMarket * Math.log(Math.max(pMarket[i], 1e-9))));
      pModel = p;
    } else {
      pModel = scoreProbs(valid.map((h) => h.score), opt.temperature);
      p = blend(pModel, pMarket, opt.weight);
    }
    const hv = harville(p);
    const rows = valid.map((h, i) => {
      const ev = p[i] * h.odds;
      const f = kelly(p[i], h.odds) * opt.kellyFraction;
      return {
        no: h.no,
        name: h.name,
        odds: h.odds,
        pMarket: pMarket[i],
        pModel: pModel[i],
        p: p[i],
        pPlace: hv.place[i],
        ev,
        fairOdds: p[i] > 0 ? 1 / p[i] : Infinity,
        kellyFrac: f,
        kellyBet: roundBet(f * opt.bankroll),
      };
    });
    const label = (k) => k.split('-').map((idx) => valid[+idx].no);
    const combos = {};
    const types = { quinella: '馬連', wide: 'ワイド', exacta: '馬単', trio: '3連複', trifecta: '3連単' };
    Object.keys(types).forEach((t) => {
      combos[t] = Array.from(hv[t].entries())
        .map(([k, v]) => ({ nos: label(k), p: v, fairOdds: 1 / v }))
        .sort((a, b) => b.p - a.p);
    });
    return { rows, combos, overround: overround(odds), comboNames: types };
  }

  const api = { marketProbs, overround, scoreProbs, softmaxRaw, blend, harville, kelly, roundBet, analyze };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KeibaModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
