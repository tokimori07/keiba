/*
 * 展開予想（DOM非依存）
 *   近走の位置取り（1コーナー・最終コーナーの順位÷頭数）、逃げた割合、タイム指数、上がり指数から
 *   序盤の隊列・ペース・直線での伸びを予想する
 */
(function (root) {
  'use strict';

  const W = [1, 0.8, 0.65, 0.5, 0.4];  // 新しい走ほど重く

  /** 1頭の近走から脚質のプロフィールを作る */
  function profile(runs, surface, distance) {
    const ok = (runs || []).filter((r) => r.surface !== '障' && r.place != null).slice(0, 5);
    let ws = 0, early = 0, late = 0, wl = 0, nige = 0, nn = 0;
    const sp = [], up = [], l3 = [];
    ok.forEach((r, i) => {
      // 今回と馬場・距離が大きく違う走は軽く扱う
      const w = W[i] * (r.surface === surface ? 1 : 0.5) * (distance && r.distance && Math.abs(r.distance - distance) > 400 ? 0.6 : 1);
      if (r.firstCorner && r.field) {
        early += w * ((r.firstCorner - 1) / Math.max(r.field - 1, 1)); ws += w;
        nige += r.firstCorner === 1 ? 1 : 0; nn++;
      }
      if (r.lastCorner && r.field) { late += w * ((r.lastCorner - 1) / Math.max(r.field - 1, 1)); wl += w; }
      if (typeof r.sp === 'number') sp.push(r.sp);
      if (typeof r.up === 'number' && i < 3) up.push(r.up);
      if (typeof r.last3f === 'number' && r.surface === surface && i < 3) l3.push(r.last3f);
    });
    return {
      early: ws ? early / ws : null,          // 0=先頭 … 1=最後方（1コーナー）
      late: wl ? late / wl : null,            // 最終コーナー
      nigeRate: nn ? nige / nn : 0,           // 逃げた割合
      runs: nn,
      speed: sp.length ? Math.max(...sp) : null,                       // タイム指数（近5走の最高）
      closing: up.length ? up.reduce((a, b) => a + b, 0) / up.length : null,  // 上がり指数（基準より何秒速いか）
      last3f: l3.length ? l3.reduce((a, b) => a + b, 0) / l3.length : null,
    };
  }

  function zs(vals) {
    const ok = vals.filter((v) => v != null);
    if (ok.length < 2) return vals.map(() => 0);
    const m = ok.reduce((a, b) => a + b, 0) / ok.length;
    const sd = Math.sqrt(ok.reduce((a, b) => a + (b - m) ** 2, 0) / ok.length) || 1;
    return vals.map((v) => (v == null ? -0.3 : (v - m) / sd));
  }

  /**
   * レース全体の展開予想
   * @param {{no:number,name:string,runs:Object[]}[]} horses
   * @returns {{pace:string, paceScore:number, leaders:number[], horses:Object[], notes:string[]}}
   */
  function predict(horses, surface, distance) {
    const list = horses.map((h) => ({ no: h.no, name: h.name, ...profile(h.runs, surface, distance) }));
    const n = list.length || 1;
    // データのない馬は中団に置く
    list.forEach((h) => { if (h.early == null) { h.early = 0.55; h.unknown = true; } if (h.late == null) h.late = h.early; });
    const nigeCands = list.filter((h) => h.nigeRate >= 0.4 || (h.early <= 0.08 && h.runs >= 2));
    const fronts = list.filter((h) => h.early <= 0.25).length;
    // ペース指数: 逃げ候補の数と先行勢の厚み（0=スロー … 1=ハイ）
    const paceScore = Math.max(0, Math.min(1, 0.15 + 0.22 * nigeCands.length + 0.9 * (fronts / n - 0.2)));
    const pace = paceScore >= 0.62 ? 'ハイ' : paceScore <= 0.35 ? 'スロー' : 'ミドル';
    // 直線での伸び: タイム指数・上がり指数・位置取り×ペース
    const zSp = zs(list.map((h) => h.speed));
    const zUp = zs(list.map((h) => h.closing != null ? h.closing : (h.last3f != null ? -h.last3f : null)));
    const frontBonus = pace === 'スロー' ? 1.4 : pace === 'ハイ' ? 0.5 : 1;
    const closeBonus = pace === 'ハイ' ? 1.4 : pace === 'スロー' ? 0.7 : 1;
    list.forEach((h, i) => {
      h.zSpeed = zSp[i]; h.zClosing = zUp[i];
      h.finishScore = 0.5 * zSp[i] + 0.35 * zUp[i] * closeBonus + 1.2 * (0.5 - h.early) * frontBonus;
      // 展開の有利不利（タイム・上がりを除いた、位置取り×ペースだけの効果）
      h.paceEdge = 1.2 * (0.5 - h.early) * (frontBonus - 1) + 0.35 * zUp[i] * (closeBonus - 1);
    });
    const byEarly = list.slice().sort((a, b) => a.early - b.early);
    byEarly.forEach((h, i) => { h.earlyRank = i + 1; });
    const byFinish = list.slice().sort((a, b) => b.finishScore - a.finishScore);
    byFinish.forEach((h, i) => { h.finishRank = i + 1; });
    const notes = [];
    const nm = (h) => `${h.no}番`;
    notes.push(nigeCands.length >= 2 ? `逃げたい馬が${nigeCands.length}頭（${nigeCands.map(nm).join('・')}）。先行争いが激しくなりそう`
      : nigeCands.length === 1 ? `逃げ候補は${nm(nigeCands[0])}だけ。単騎で楽に逃げられる可能性`
      : `はっきりした逃げ馬がいない。押し出された馬がゆったり逃げる展開か`);
    notes.push(pace === 'ハイ' ? '前半が速くなりやすく、差し・追込に展開が向く'
      : pace === 'スロー' ? '前半がゆったり流れ、前に行く馬が残りやすい'
      : '平均的な流れ。能力どおりに決まりやすい');
    const gain = list.filter((h) => h.paceEdge > 0.15).sort((a, b) => b.paceEdge - a.paceEdge).slice(0, 3);
    if (gain.length) notes.push(`展開が向きそう: ${gain.map(nm).join('・')}`);
    const fast = list.filter((h) => h.speed != null).sort((a, b) => b.speed - a.speed)[0];
    if (fast) notes.push(`タイム指数トップは${nm(fast)}（${fast.speed.toFixed(0)}）`);
    return { pace, paceScore, leaders: nigeCands.map((h) => h.no), horses: list, notes };
  }

  const api = { profile, predict };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KeibaPace = api;
})(typeof window !== 'undefined' ? window : globalThis);
