/* 競馬ノート UI */
(function () {
  'use strict';
  const M = window.KeibaModel;
  const S = window.KeibaStats;

  const VENUES = ['東京', '中山', '京都', '阪神', '中京', '新潟', '福島', '小倉', '札幌', '函館', '地方', '海外'];
  const BET_TYPES = ['単勝', '複勝', '枠連', '馬連', 'ワイド', '馬単', '3連複', '3連単', 'WIN5'];
  const MARKS = [['◎', 90], ['○', 80], ['▲', 70], ['△', 60], ['×', 30]];
  const COMBO_TO_BET = { quinella: '馬連', wide: 'ワイド', exacta: '馬単', trio: '3連複', trifecta: '3連単' };
  const KEY = 'keiba-note-v1';

  // ---------- 状態 ----------
  const defaultState = () => ({
    bets: [],
    settings: { bankroll: 100000, kelly: 0.25, cap: 10000 },
    draft: {
      date: today(), venue: '東京', race: 11, name: '',
      weight: 50, temp: 10, minev: 110, comboType: 'quinella', comboSort: 'p',
      raceId: '', comboOdds: {}, horseInfo: {}, trend: null, aim: 'balance', aimUnit: 100,
      method: 'learned', sort: 'no', editMode: false, raceMeta: {}, modelInfo: null,
      horses: [],
    },
  });
  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const s = JSON.parse(raw);
        const d = defaultState();
        return { ...d, ...s, settings: { ...d.settings, ...s.settings }, draft: { ...d.draft, ...s.draft } };
      }
    } catch (e) { /* localStorage不可・破損時は初期状態 */ }
    return defaultState();
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { toast('保存に失敗しました（ブラウザの保存領域を確認）'); }
  }

  // ---------- ユーティリティ ----------
  function today() {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yen = (n) => (n < 0 ? '-' : '') + '¥' + Math.abs(Math.round(n)).toLocaleString('ja-JP');
  const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
  const signCls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2000);
  }
  function fillSelect(el, items, withBlank) {
    el.innerHTML = (withBlank ? '<option value="">-</option>' : '') + items.map((v) => `<option>${esc(v)}</option>`).join('');
  }

  // ---------- タブ ----------
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
      if (btn.dataset.tab === 'stats') renderStats();
      if (btn.dataset.tab === 'log') { renderLog(); autoSettle(true); }
    });
  });

  // =====================================================
  // 予想
  // =====================================================
  const d = () => state.draft;

  const WAKU_COLOR = { 1: ['#ffffff', '#222'], 2: ['#222222', '#fff'], 3: ['#e53935', '#fff'], 4: ['#1e63d6', '#fff'],
    5: ['#f5c400', '#222'], 6: ['#2e9e4f', '#fff'], 7: ['#f08a00', '#fff'], 8: ['#f48fb1', '#222'] };

  /** JRAの枠番の割り当て（外枠から順に頭数が増える） */
  function wakuOf(no, n) {
    if (n <= 8) return no;
    const base = Math.floor(n / 8), extra = n % 8;
    let start = 1;
    for (let w = 1; w <= 8; w++) {
      const size = base + (w > 8 - extra ? 1 : 0);
      if (no < start + size) return w;
      start += size;
    }
    return 8;
  }

  function initPredict() {
    fillSelect($('p-venue'), VENUES);
    $('p-date').value = d().date;
    $('p-venue').value = d().venue;
    $('p-race').value = d().race;
    $('p-name').value = d().name;
    $('p-weight').value = d().weight;
    $('p-temp').value = d().temp;
    $('p-minev').value = d().minev;
    [['p-date', 'date'], ['p-venue', 'venue'], ['p-race', 'race'], ['p-name', 'name']].forEach(([id, k]) => {
      $(id).addEventListener('change', (e) => { d()[k] = e.target.value; save(); renderBanner(); });
    });
    [['p-weight', 'weight'], ['p-temp', 'temp'], ['p-minev', 'minev']].forEach(([id, k]) => {
      $(id).addEventListener('input', (e) => { d()[k] = Number(e.target.value); save(); renderAnalysis(); });
    });
    $('p-ability').addEventListener('click', applyAbility);
    $('p-edit').addEventListener('change', (e) => { d().editMode = e.target.checked; save(); renderHorses(); });
    $('p-edit').checked = !!d().editMode;
    $('p-method').addEventListener('click', (e) => {
      if (!e.target.dataset.m) return;
      d().method = e.target.dataset.m; save(); renderAnalysis();
    });
    $('p-sort').addEventListener('click', (e) => {
      if (!e.target.dataset.s) return;
      d().sort = e.target.dataset.s; save(); renderAnalysis();
    });
    $('p-add').addEventListener('click', () => {
      const next = d().horses.reduce((m, h) => Math.max(m, Number(h.no) || 0), 0) + 1;
      d().horses.push({ no: next, name: '', odds: '', score: 50 });
      d().editMode = true; $('p-edit').checked = true;
      save(); renderHorses();
    });
    $('p-clear').addEventListener('click', () => {
      if (!confirm('出走馬リストをクリアしますか？')) return;
      d().horses = []; d().horseInfo = {}; d().raceId = ''; d().trend = null; save(); renderHorses(); renderTrend(); renderBanner();
    });
    $('p-paste').addEventListener('click', () => $('p-paste-box').classList.toggle('hidden'));
    $('p-paste-apply').addEventListener('click', () => {
      const rows = $('p-paste-text').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const horses = [];
      rows.forEach((line) => {
        const cols = line.split(/[,\t、]|\s{1,}/).map((c) => c.trim()).filter(Boolean);
        if (cols.length < 3) return;
        const [no, name, odds, score] = cols;
        if (!isFinite(Number(no)) || !isFinite(Number(odds))) return;
        horses.push({ no: Number(no), name, odds: Number(odds), score: isFinite(Number(score)) && score !== undefined ? Number(score) : 50 });
      });
      if (!horses.length) { toast('読み取れる行がありません'); return; }
      d().horses = horses;
      $('p-paste-box').classList.add('hidden');
      save(); renderHorses();
      toast(`${horses.length}頭を取り込みました`);
    });

    const tb = $('p-horses');
    tb.addEventListener('change', (e) => {
      const tr = e.target.closest('tr'); if (!tr || !e.target.dataset.f) return;
      const h = d().horses[Number(tr.dataset.i)];
      const f = e.target.dataset.f;
      h[f] = f === 'name' ? e.target.value : e.target.value === '' ? '' : Number(e.target.value);
      save(); renderAnalysis();
    });
    tb.addEventListener('click', (e) => {
      const tr = e.target.closest('tr'); if (!tr) return;
      const i = Number(tr.dataset.i);
      const btn = e.target.closest('button'); if (!btn) return;
      if (btn.classList.contains('mark')) {
        const v = Number(btn.dataset.v);
        d().horses[i].score = d().horses[i].score === v ? 50 : v;
        if (d().method === 'learned') toast('印は「自分の印」モードの予想に使われます');
        save(); renderAnalysis();
      } else if (btn.dataset.act === 'del') {
        d().horses.splice(i, 1); save(); renderHorses();
      } else if (btn.dataset.act === 'rec') {
        prefillBet({ type: '単勝', sel: tr.dataset.no, ev: Number(tr.dataset.ev), stake: Number(tr.dataset.bet) || '' });
      } else if (btn.dataset.act === 'more') {
        tr.nextElementSibling.classList.toggle('hidden');
      }
    });
    $('s-summary').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act=rec]'); if (!btn) return;
      prefillBet({ type: btn.dataset.type, sel: btn.dataset.sel, ev: Number(btn.dataset.ev), stake: Number(btn.dataset.bet) || '' });
    });

    $('s-aim').addEventListener('click', (e) => {
      const t = e.target.closest('button'); if (!t) return;
      const box = $('s-aim');
      if (t.dataset.aim) {
        d().aim = t.dataset.aim; save(); renderAnalysis();
        AIMS[d().aim].types.forEach((type) => Fetch.combos(false, type));
      } else if (t.dataset.act === 'rec1') {
        const c = box._list[Number(t.dataset.i)];
        prefillBet({ type: COMBO_TO_BET[c.type], sel: c.nos.join(c.ordered ? '→' : '-'), ev: c.real ? c.ev : '', stake: Number(d().aimUnit) || 100 });
      } else if (t.dataset.act === 'recall') {
        if (!box._list || !box._list.length) return;
        if (!d().raceId && !d().name) { toast('先にレースを選んでください'); return; }
        recordAim(box._list, Number(d().aimUnit) || 100);
      }
    });
    $('s-aim').addEventListener('change', (e) => {
      if (e.target.id !== 'aim-unit') return;
      d().aimUnit = Math.max(100, Math.round(Number(e.target.value) / 100) * 100 || 100); save(); renderAnalysis();
    });

    $('p-combo-type').innerHTML = Object.entries(COMBO_TO_BET)
      .map(([k, v]) => `<button data-k="${k}">${v}</button>`).join('');
    $('p-combo-type').addEventListener('click', (e) => {
      if (!e.target.dataset.k) return;
      d().comboType = e.target.dataset.k; save(); renderAnalysis();
      Fetch.combos(false);
    });
    $('p-combo-sort').addEventListener('click', (e) => {
      if (!e.target.dataset.s) return;
      d().comboSort = e.target.dataset.s; save(); renderAnalysis();
    });
    $('p-combos').addEventListener('input', (e) => {
      if (e.target.dataset.f !== 'odds') return;
      const tr = e.target.closest('tr');
      const p = Number(tr.dataset.p);
      const o = Number(e.target.value);
      const cell = tr.querySelector('.ev');
      const ev = o > 0 ? p * o : null;
      cell.innerHTML = ev ? evBadge(ev) : '-';
    });
    $('p-combos').addEventListener('click', (e) => {
      if (e.target.dataset.act !== 'rec') return;
      const tr = e.target.closest('tr');
      const o = Number(tr.querySelector('input').value);
      const p = Number(tr.dataset.p);
      prefillBet({ type: COMBO_TO_BET[d().comboType], sel: tr.dataset.sel, ev: o > 0 ? p * o : '' });
    });
    renderHorses();
    renderBanner();
  }

  // ---------- 表示部品 ----------
  function starsHtml(n, big) {
    if (!n) return '<span class="hint" title="過去走なし">データなし</span>';
    return `<span class="stars ${big ? 'big' : ''}">${'★'.repeat(n)}<span class="off">${'★'.repeat(5 - n)}</span></span>`;
  }
  function recentHtml(list) {
    if (!list || !list.length) return '<span class="dots"><span class="hint">初出走</span></span>';
    return `<span class="dots" title="近5走の着順（左が古い→右が前走）">${list.slice().reverse().map((p) => {
      const c = p == null ? 'x' : p === 1 ? 'p1' : p <= 3 ? 'p3' : p <= 5 ? 'p5' : '';
      return `<i class="dot ${c}" title="${p == null ? '中止' : p + '着'}">${p == null ? '止' : p}</i>`;
    }).join('')}</span>`;
  }
  function jockeyHtml(j) {
    if (!j) return '';
    const tip = j.rides ? `${j.name}：${j.rides}騎乗 ${j.wins}勝・3着内 ${j.top3}回（勝率${pct(j.winRate, 0)}・3着内率${pct(j.top3Rate, 0)}）※保存済みの過去レースから集計`
      : `${j.name}：集計できる騎乗データがまだありません（バックテストを実行すると増えます）`;
    const st = j.stars ? `<span class="stars mini">${'★'.repeat(j.stars)}<span class="off">${'★'.repeat(5 - j.stars)}</span></span>` : '';
    return `<span class="jk" title="${esc(tip)}">${esc(j.name)}${st}</span>`;
  }
  function wakuBadge(w, no) {
    const [bg, fg] = WAKU_COLOR[w] || ['#ccc', '#222'];
    return `<span class="umaban" style="background:${bg};color:${fg}" title="${w}枠">${esc(no)}</span>`;
  }
  function evBadge(ev) {
    const minEv = d().minev / 100;
    if (ev >= minEv) return `<span class="ev-badge hot" title="期待値 ${ev.toFixed(2)}">${ev >= minEv * 1.3 ? '🔥' : ''}${ev.toFixed(2)}</span>`;
    if (ev >= 1) return `<span class="ev-badge warm">${ev.toFixed(2)}</span>`;
    return `<span class="ev-badge cold">${ev.toFixed(2)}</span>`;
  }
  /** 過去10年の枠別3着内率から、その枠が有利(good)/不利(bad)か */
  function wakuClass(w) {
    const t = d().trend && d().trend.trend;
    if (!t || !w) return '';
    const all = Object.values(t.waku).filter((v) => v.runs);
    const avg = all.reduce((a, v) => a + v.top3, 0) / all.reduce((a, v) => a + v.runs, 0);
    const r = t.waku[w];
    if (!r || r.runs < 5) return '';
    return r.rate >= avg * 1.35 ? 'good' : r.rate <= avg * 0.65 ? 'bad' : '';
  }
  function styleClass(style) {
    const t = d().trend && d().trend.trend;
    if (!t || !t.bestStyle || !style) return '';
    return t.bestStyle.startsWith(style[0]) ? 'good' : '';
  }

  // ---------- レースのバナー ----------
  function renderBanner() {
    const info = Object.values(d().horseInfo || {});
    const meta = d().raceMeta || {};
    const g = meta.grade || '';
    $('r-grade').textContent = g;
    $('r-grade').className = 'grade ' + (g ? g.toLowerCase() : 'none');
    $('r-name').textContent = d().name || 'レースを選んでください';
    const sub = [d().date, d().venue && d().race ? `${d().venue}${d().race}R` : '', meta.course, d().horses.length ? `${d().horses.length}頭` : ''].filter(Boolean);
    $('r-sub').textContent = sub.length > 1 ? sub.join('　') : '重賞を選んで「取得」を押すと、出走馬・オッズ・能力・過去10年の傾向をまとめて表示します';
    const t = d().trend && d().trend.race_id === d().raceId ? d().trend.trend : null;
    const chips = [];
    if (t) {
      const fav = t.favorite, n = fav.reduce((a, b) => a + b, 0);
      chips.push(`<span class="chip">荒れ度 ${starsHtml(t.roughStars)}</span>`);
      if (n) chips.push(`<span class="chip">1番人気 <b>${fav[0] + fav[1] + fav[2]}/${n}</b> 回3着内</span>`);
      chips.push(`<span class="chip">枠 <b>${esc(t.inoutBias)}</b></span>`);
      if (t.bestStyle) chips.push(`<span class="chip">有利な脚質 <b>${esc(t.bestStyle)}</b></span>`);
      if (t.winnerPopAvg) chips.push(`<span class="chip">勝ち馬の平均 <b>${t.winnerPopAvg}</b>番人気</span>`);
    } else if (info.length) {
      chips.push('<span class="chip muted">過去10年の傾向を読み込み中…</span>');
    }
    $('r-chips').innerHTML = chips.join('');
  }

  function renderHorses() { renderAnalysis(); }

  /** 能力値 → スコア(0〜100)。メンバー内の偏差で換算 */
  function applyAbility() {
    const info = d().horseInfo || {};
    const vals = d().horses.map((h) => (info[h.no] || {}).rating).filter((v) => v != null);
    if (vals.length < 2) { toast('先にレースを取得して能力値を読み込んでください'); return; }
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
    d().horses.forEach((h) => {
      const r = (info[h.no] || {}).rating;
      h.score = r == null ? 45 : Math.round(Math.max(10, Math.min(95, 50 + ((r - mean) / sd) * 15)));
    });
    save(); renderAnalysis();
    toast('能力値からスコアをセットしました（印で微調整できます）');
  }

  // ---------- 分析（出馬表・まとめ・組み合わせ） ----------
  function useLearned() {
    return d().method !== 'manual' && d().modelInfo && d().modelInfo.raceId === d().raceId;
  }

  function renderAnalysis() {
    $('o-weight').textContent = d().weight + '%';
    $('o-temp').textContent = d().temp;
    $('o-minev').textContent = (d().minev / 100).toFixed(2);
    const learned = useLearned();
    const method = learned ? 'learned' : 'manual';
    document.querySelectorAll('#p-method button').forEach((b) => b.classList.toggle('on', b.dataset.m === method));
    $('p-manual-opts').classList.toggle('hidden', learned);
    $('p-method-hint').innerHTML = learned
      ? `過去データから学習したモデル（${esc(d().modelInfo.trainedAt || '')}まで・${d().modelInfo.races}レースで学習）で勝率を推定。印は表示用です。`
      : d().method !== 'manual'
        ? '学習モデルは未設定です。検証タブで学習し「予想に使う」を押すと使えます。今は自分の印で予想しています。'
        : '印（◎○▲△×）とオッズを合成して勝率を推定します。';
    document.querySelectorAll('#p-combo-type button').forEach((b) => b.classList.toggle('on', b.dataset.k === d().comboType));
    document.querySelectorAll('#p-combo-sort button').forEach((b) => b.classList.toggle('on', b.dataset.s === (d().comboSort || 'p')));
    const sort = d().sort || 'no';
    document.querySelectorAll('#p-sort button').forEach((b) => b.classList.toggle('on', b.dataset.s === sort));

    const info = d().horseInfo || {};
    const edit = !!d().editMode;
    const n = d().horses.length;
    const valid = d().horses
      .map((h) => ({ no: h.no, name: h.name, odds: Number(h.odds), score: Number(h.score) || 0, ownU: (info[h.no] || {}).ownU }))
      .filter((h) => h.odds > 1);
    const st = state.settings;
    const minEv = d().minev / 100;
    const res = valid.length >= 2
      ? M.analyze(valid, { weight: d().weight / 100, temperature: d().temp, bankroll: st.bankroll, kellyFraction: st.kelly,
        learned: learned ? { betaMarket: d().modelInfo.betaMarket } : null })
      : null;
    const byNo = res ? Object.fromEntries(res.rows.map((r) => [r.no, r])) : {};
    $('p-overround').textContent = res ? `控除率 ${pct(res.overround, 0)}` : '';

    // ---- 出馬表 ----
    const maxP = res ? Math.max(...res.rows.map((r) => Math.max(r.p, r.pMarket))) : 1;
    const order = d().horses.map((h, i) => ({ h, i, r: byNo[h.no] }));
    if (sort === 'ev') order.sort((a, b) => (b.r ? b.r.ev : -1) - (a.r ? a.r.ev : -1));
    else if (sort === 'p') order.sort((a, b) => (b.r ? b.r.p : -1) - (a.r ? a.r.p : -1));
    else order.sort((a, b) => a.h.no - b.h.no);
    const pops = res ? Object.fromEntries(res.rows.slice().sort((a, b) => a.odds - b.odds).map((r, k) => [r.no, k + 1])) : {};

    $('p-horses').innerHTML = order.map(({ h, i, r }) => {
      const x = info[h.no] || {};
      const w = x.waku || wakuOf(Number(h.no), n);
      const buy = r && r.ev >= minEv;
      const bet = r ? Math.min(r.kellyBet, st.cap || Infinity) : 0;
      const runs = (x.runs || []).map((run) => `<tr><td>${esc(run.date)}</td><td>${esc(run.venue)}</td><td>${esc(run.race)} <small>${esc(run.class)}</small></td>
        <td>${esc(run.surface)}${run.distance || ''}</td><td class="num"><b>${run.place ?? '中止'}</b>着/${run.field || '-'}頭</td>
        <td class="num">${run.pop ?? '-'}人気</td><td class="num">${run.margin != null ? run.margin.toFixed(1) + '秒' : ''}</td><td>${esc(run.style || '')}</td></tr>`).join('');
      return `
      <tr data-i="${i}" data-no="${esc(h.no)}" data-ev="${r ? r.ev.toFixed(2) : ''}" data-bet="${buy ? bet : 0}" class="horse ${buy ? 'buy' : ''}">
        <td class="c-ban">${edit ? `<input class="plain w-no" type="number" data-f="no" value="${esc(h.no)}" />` : wakuBadge(w, h.no)}
          ${wakuClass(w) ? `<span class="waku-tip ${wakuClass(w)}" title="過去10年でこの枠は${wakuClass(w) === 'good' ? '好成績' : '不振'}">${wakuClass(w) === 'good' ? '◎枠' : '△枠'}</span>` : ''}</td>
        <td class="c-name">
          ${edit ? `<input class="plain w-name" data-f="name" value="${esc(h.name)}" placeholder="馬名" />` : `<div class="hname">${esc(h.name) || '<span class="hint">馬名未入力</span>'}</div>`}
          <div class="hsub">${jockeyHtml(x.jockey)}${x.rating !== undefined ? recentHtml(x.recent) : ''}
            ${x.style ? `<span class="style-chip ${styleClass(x.style)}" title="脚質">${esc(x.style)}</span>` : ''}
            ${runs ? '<button class="link" data-act="more">近走</button>' : ''}</div>
        </td>
        <td class="c-abil">${x.rating !== undefined ? starsHtml(x.stars, true) + (x.rating ? `<div class="rating">指数 ${x.rating}</div>` : '') : '<span class="hint">-</span>'}</td>
        <td class="num c-odds">${edit ? `<input class="plain w-odds" type="number" step="0.1" data-f="odds" value="${esc(h.odds)}" />`
          : `<div class="odds">${r ? r.odds.toFixed(1) : '-'}</div><div class="pop">${pops[h.no] ? pops[h.no] + '番人気' : ''}</div>`}</td>
        <td class="c-prob">${r ? `<div class="pbar" title="オッズ ${pct(r.pMarket)} / 予想 ${pct(r.p)}">
            <span class="me" style="width:${(r.p / maxP) * 100}%"></span><i class="mkt" style="left:${(r.pMarket / maxP) * 100}%"></i></div>
            <div class="pval"><b>${pct(r.p)}</b> <span class="${r.p > r.pMarket * 1.15 ? 'up' : r.p < r.pMarket * 0.85 ? 'down' : ''}">${r.p > r.pMarket * 1.15 ? '▲' : r.p < r.pMarket * 0.85 ? '▼' : ''}</span></div>` : ''}</td>
        <td class="num c-ev">${r ? evBadge(r.ev) : ''}${buy && bet > 0 ? `<div class="kelly">推奨 ${yen(bet)}</div>` : ''}</td>
        <td class="c-mark"><div class="marks">${MARKS.map(([m, v]) => `<button class="mark ${Number(h.score) === v ? 'on' : ''}" data-v="${v}" title="スコア${v}">${m}</button>`).join('')}</div>
          ${edit ? `<input class="plain w-score" type="number" data-f="score" value="${esc(h.score)}" title="スコア" />` : ''}</td>
        <td class="c-act">${r ? '<button class="btn small" data-act="rec" title="単勝を記録">記録</button>' : ''}${edit ? '<button class="btn small ghost" data-act="del">✕</button>' : ''}</td>
      </tr>
      ${runs ? `<tr class="runs hidden"><td></td><td colspan="7"><table class="mini">${runs}</table></td></tr>` : ''}`;
    }).join('') || '<tr><td colspan="8" class="empty">上で重賞を選んで「取得」を押してください（手入力もできます）</td></tr>';

    renderSummary(res);
    renderAim(res);
    renderBanner();

    // ---- 組み合わせ ----
    if (!res) { $('p-combos').innerHTML = '<tr><td colspan="7" class="empty">出走馬を取得すると表示します</td></tr>'; return; }
    const type = d().comboType;
    const ordered = type === 'exacta' || type === 'trifecta';
    const rawOdds = (d().comboOdds || {})[type];
    const real = rawOdds && rawOdds.__rid === d().raceId ? rawOdds : null;
    let list = res.combos[type].map((c) => {
      const nos = ordered ? c.nos : c.nos.slice().sort((a, b) => a - b);
      const o = real ? real[nos.join('-')] : undefined;
      return { ...c, nos, real: o, ev: o ? c.p * o : null };
    });
    if (d().comboSort === 'ev') list = list.filter((c) => c.ev !== null).sort((a, b) => b.ev - a.ev);
    list = list.slice(0, 15);
    if (!list.length) { $('p-combos').innerHTML = '<tr><td colspan="7" class="empty">期待値順は実オッズの取得後に使えます</td></tr>'; return; }
    $('p-combos').innerHTML = list.map((c) => {
      const sel = c.nos.join(ordered ? '→' : '-');
      const badges = c.nos.map((no) => wakuBadge((info[no] || {}).waku || wakuOf(no, n), no)).join(ordered ? '<span class="arrow">→</span>' : '');
      return `<tr data-p="${c.p}" data-sel="${esc(sel)}" class="${c.ev !== null && c.ev >= minEv ? 'buy' : ''}">
        <td><span class="combo">${badges}</span></td>
        <td class="num">${pct(c.p, 2)}</td>
        <td class="num">${c.fairOdds.toFixed(1)}</td>
        <td class="num">${(c.fairOdds * minEv).toFixed(1)}倍〜</td>
        <td><input class="plain w-odds" type="number" data-f="odds" step="0.1" min="1" placeholder="実オッズ" value="${c.real || ''}" /></td>
        <td class="num ev">${c.ev !== null ? evBadge(c.ev) : '-'}</td>
        <td><button class="btn small" data-act="rec">記録</button></td>
      </tr>`;
    }).join('');
  }

  // ---------- 狙い別のおすすめ ----------
  // 1年分（約2,750レース）の検証: 各帯の組み合わせを全部買った場合の回収率（理論倍率で分類）
  const PAYOUT_RATE = { wide: 0.775, quinella: 0.775, exacta: 0.75, trio: 0.75, trifecta: 0.725 };
  const AIMS = {
    hit: { icon: '🎯', label: '的中重視', types: ['wide'], min: 1.5, max: 8, points: 3,
      desc: '当てる回数を優先。人気サイドのワイドを少点数で',
      record: '過去1年の実績: この帯のワイドは回収率 約80〜84%・的中率 20〜38%（1点あたり）' },
    balance: { icon: '⚖️', label: 'バランス', types: ['quinella', 'trio'], min: 8, max: 60, points: 6,
      desc: '中穴の馬連・3連複。払戻率に対して最も損が小さかった帯',
      record: '過去1年の実績: 理論3〜20倍の3連複は回収率 約84〜89%（全券種でいちばん良い帯）' },
    manken: { icon: '💰', label: '万馬券狙い', types: ['trio', 'trifecta'], min: 100, max: 1000, points: 10,
      desc: '払戻1万円以上（100倍〜1000倍）の3連複・3連単',
      record: '過去1年の実績: 100〜1000倍の帯は回収率 約69〜78%。的中は1点あたり0.1〜0.5%程度で、外れが続く前提で' },
    jackpot: { icon: '🚀', label: '10万馬券', types: ['trifecta'], min: 1000, max: Infinity, points: 20,
      desc: '払戻10万円以上の3連単。夢を買う枠',
      record: '過去1年の実績: 1000倍以上の3連単は回収率 約68%。年に数回当たるかどうかの水準' },
  };

  function aimCandidates(res, aim) {
    const info = AIMS[aim];
    const out = [];
    info.types.forEach((type) => {
      const ordered = type === 'exacta' || type === 'trifecta';
      const raw = (d().comboOdds || {})[type];
      const real = raw && raw.__rid === d().raceId ? raw : null;
      res.combos[type].forEach((c) => {
        const nos = ordered ? c.nos : c.nos.slice().sort((a, b) => a - b);
        const o = real ? real[nos.join('-')] : undefined;
        const odds = o || c.fairOdds * PAYOUT_RATE[type];  // 実オッズがなければ推定（理論倍率×払戻率）
        if (!(odds >= info.min && odds < info.max)) return;
        out.push({ type, nos, p: c.p, odds, real: !!o, ev: c.p * odds, ordered });
      });
    });
    const anyReal = out.some((c) => c.real);
    // 実オッズがあれば（実オッズのある買い目だけで）期待値順、なければ推定的中率順
    const pool = anyReal ? out.filter((c) => c.real) : out;
    pool.sort((a, b) => (anyReal ? b.ev - a.ev : b.p - a.p));
    return { list: pool.slice(0, info.points), anyReal };
  }

  function renderAim(res) {
    const box = $('s-aim');
    if (!box) return;
    const aim = AIMS[d().aim] ? d().aim : 'balance';
    const info = AIMS[aim];
    const head = `<h2>狙い別のおすすめ</h2>
      <div class="aim-tabs">${Object.entries(AIMS).map(([k, a]) => `<button data-aim="${k}" class="${k === aim ? 'on' : ''}"><span>${a.icon}</span>${a.label}</button>`).join('')}</div>
      <p class="aim-desc">${info.desc}</p>`;
    if (!res) { box.innerHTML = head + '<p class="hint">出走馬を取得すると、狙いに合った買い目を出します。</p>'; return; }
    const { list, anyReal } = aimCandidates(res, aim);
    const n = d().horses.length;
    const hinfo = d().horseInfo || {};
    const unit = Number(d().aimUnit) || 100;
    const minEv = d().minev / 100;
    const hitP = list.reduce((a, c) => a + c.p, 0);
    const ret = list.reduce((a, c) => a + c.p * c.odds * unit, 0);
    const cost = list.length * unit;
    const good = list.filter((c) => c.ev >= minEv).length;
    const rows = list.map((c, i) => {
      const badges = c.nos.map((no) => wakuBadge((hinfo[no] || {}).waku || wakuOf(no, n), no)).join(c.ordered ? '<span class="arrow">→</span>' : '');
      return `<div class="aim-row ${c.real && c.ev >= minEv ? 'buy' : ''}">
        <span class="aim-type">${COMBO_TO_BET[c.type]}</span><span class="combo">${badges}</span>
        <span class="aim-odds">${c.real ? '' : '<small>推定</small>'}${c.odds >= 100 ? Math.round(c.odds) : c.odds.toFixed(1)}倍</span>
        <span class="aim-p">${pct(c.p, c.p < 0.01 ? 2 : 1)}</span>
        <span class="aim-ev">${c.real ? evBadge(c.ev) : ''}</span>
        <button class="btn small" data-act="rec1" data-i="${i}">記録</button></div>`;
    }).join('');
    box.innerHTML = head + (list.length ? `
      <div class="aim-kpi">
        <div><b>${list.length}</b>点</div>
        <div>的中率<b>${pct(Math.min(hitP, 1), hitP < 0.05 ? 1 : 0)}</b></div>
        <div>期待回収<b>${cost ? Math.round((ret / cost) * 100) : 0}%</b></div>
      </div>
      <div class="aim-list">${rows}</div>
      <div class="aim-foot">
        <label>1点 <input type="number" id="aim-unit" class="plain" min="100" step="100" value="${unit}">円</label>
        <span>計 <b>${yen(cost)}</b></span>
        <button class="btn small primary" data-act="recall">まとめて記録</button>
      </div>
      <p class="hint">${anyReal ? `実オッズで期待値の高い順。期待値${minEv.toFixed(2)}以上は${good}点${good ? '' : '（<b>見送りも検討</b>）'}` : '実オッズ取得前のため、推定的中率の高い順・オッズは推定です（取得すると期待値順に入れ替わります）'}</p>`
      : '<p class="hint">この狙いに合う買い目がありません（出走頭数が少ない・人気が偏っている等）。</p>') +
      (info.min >= 100 ? '<p class="hint">高配当の帯は的中率の推定誤差が大きく、期待値が高く出やすい点に注意（実績の回収率を目安に、少額で）。</p>' : '') +
      `<p class="aim-record">📊 ${info.record}</p>`;
    box._list = list;
  }

  function recordAim(list, unit) {
    list.forEach((c) => {
      const type = COMBO_TO_BET[c.type];
      state.bets.push({
        id: uid(), createdAt: Date.now(), date: d().date || today(), venue: d().venue || '', race: d().race ? Number(d().race) : '',
        name: d().name || '', raceId: d().raceId || '', type, mode: 'normal', picks: c.nos.slice(), combos: [c.nos.slice()],
        points: 1, unit, stake: unit, sel: c.nos.join(c.ordered ? '→' : '-'), payout: null,
        conf: '', ev: c.real ? Number(c.ev.toFixed(2)) : '', memo: `狙い: ${AIMS[d().aim || 'balance'].label}`,
      });
    });
    save(); renderLog();
    toast(`${list.length}点（計${yen(list.length * unit)}）を記録しました`);
  }

  // ---------- 予想のまとめ（サイド） ----------
  function renderSummary(res) {
    const box = $('s-summary');
    if (!res) { box.innerHTML = '<h2>予想のまとめ</h2><p class="hint">出走馬を取得すると、本命・妙味馬・おすすめの買い目が出ます。</p>'; return; }
    const info = d().horseInfo || {};
    const n = d().horses.length;
    const minEv = d().minev / 100;
    const st = state.settings;
    const byP = res.rows.slice().sort((a, b) => b.p - a.p);
    const byEv = res.rows.slice().sort((a, b) => b.ev - a.ev);
    const honmei = byP[0], taikou = byP[1];
    const value = byEv.find((r) => r.ev >= minEv && r !== honmei && r !== taikou);
    const ana = byEv.find((r) => r.ev >= minEv && r.odds >= 15 && r !== value && r !== honmei);
    const pick = (label, cls, r, note) => r ? `
      <div class="pick ${cls}">
        <div class="pick-label">${label}</div>
        <div class="pick-body">${wakuBadge((info[r.no] || {}).waku || wakuOf(r.no, n), r.no)}<span class="pick-name">${esc(r.name)}</span></div>
        <div class="pick-meta">単勝 <b>${r.odds.toFixed(1)}</b>倍・勝率 <b>${pct(r.p, 0)}</b>・期待値 ${evBadge(r.ev)}${note ? `<div class="hint">${note}</div>` : ''}</div>
      </div>` : '';
    const buys = byEv.filter((r) => r.ev >= minEv).map((r) => ({ r, bet: Math.min(r.kellyBet, st.cap || Infinity) })).filter((x) => x.bet > 0);
    const total = buys.reduce((a, x) => a + x.bet, 0);
    box.innerHTML = `
      <h2>予想のまとめ</h2>
      <div class="picks">
        ${pick('◎ 本命', 'p-honmei', honmei, '推定勝率が最も高い馬')}
        ${pick('○ 対抗', 'p-taikou', taikou, '')}
        ${value ? pick('🔥 妙味', 'p-value', value, 'オッズの割に勝率が高い＝期待値が高い') : byEv.some((r) => r.ev >= minEv) ? '' : '<div class="pick none">期待値が基準を超える馬はいません。<br><b>見送り</b>も立派な戦略です</div>'}
        ${ana ? pick('💥 穴', 'p-ana', ana, '15倍以上で期待値が高い') : ''}
      </div>
      ${buys.length ? `<div class="buy-list"><div class="bl-head">おすすめ単勝（ケリー基準）<span>計 ${yen(total)}</span></div>
        ${buys.map(({ r, bet }) => `<div class="bl-row">${wakuBadge((info[r.no] || {}).waku || wakuOf(r.no, n), r.no)}<span class="bl-name">${esc(r.name)}</span>
          <b>${yen(bet)}</b><button class="btn small" data-act="rec" data-type="単勝" data-sel="${esc(r.no)}" data-ev="${r.ev.toFixed(2)}" data-bet="${bet}">記録</button></div>`).join('')}
      </div>` : ''}`;
  }

  // ---------- レース傾向 ----------
  function renderTrend() {
    const box = $('t-body');
    const data = d().trend;
    renderBanner();
    if (!data || data.race_id !== d().raceId) { $('t-mode').textContent = ''; return; }
    const t = data.trend;
    $('t-mode').textContent = data.mode === 'same_race'
      ? `${data.name} 過去${t ? t.count : 0}回`
      : `同時期・同コース（${data.venue}${data.course}）過去${t ? t.count : 0}レース`;
    if (!t) { box.innerHTML = '<p class="empty">過去のデータが見つかりませんでした</p>'; return; }
    const fav = t.favorite;
    const favN = fav.reduce((a, b) => a + b, 0);
    const favTop3 = favN ? (fav[0] + fav[1] + fav[2]) / favN : 0;
    const longshots = t.pops['10番人気〜'];
    const notes = [];
    if (favN) notes.push(favTop3 >= 0.7 ? `1番人気は堅実（3着内 ${fav[0] + fav[1] + fav[2]}/${favN}回）。軸にしやすい` :
      favTop3 < 0.4 ? `1番人気の信頼度は低め（3着内 ${fav[0] + fav[1] + fav[2]}/${favN}回）。人気馬を疑う価値あり` :
      `1番人気の3着内は ${fav[0] + fav[1] + fav[2]}/${favN}回で平均的`);
    if (longshots && longshots.top3) notes.push(`10番人気以下の馬が3着以内に ${longshots.top3}回 入っている`);
    if (t.inoutBias !== '互角') notes.push(`${t.inoutBias}（馬番の前半/後半で3着内率 ${pct(t.inout['内'].rate || 0)} / ${pct(t.inout['外'].rate || 0)}）`);
    if (t.bestStyle) notes.push(`脚質は「${t.bestStyle}」の3着内率が最も高い（${pct(t.styles[t.bestStyle].rate)}）`);

    const bars = (obj, keys, label) => {
      const max = Math.max(0.01, ...keys.map((k) => (obj[k] && obj[k].rate) || 0));
      return `<table class="mini"><thead><tr><th>${label}</th><th class="num">3着内</th><th class="num">率</th><th></th></tr></thead><tbody>${keys.map((k) => {
        const v = obj[k] || { runs: 0, top3: 0, rate: null };
        return `<tr><td>${esc(k)}</td><td class="num">${v.top3}/${v.runs}</td><td class="num">${v.rate == null ? '-' : pct(v.rate, 0)}</td>
          <td><div class="bar"><span style="width:${((v.rate || 0) / max) * 100}%"></span></div></td></tr>`;
      }).join('')}</tbody></table>`;
    };
    const kpi = (label, value, sub) => `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub || ''}</div></div>`;
    box.innerHTML = `
      <div class="kpis">
        ${kpi('荒れ度', t.roughStars ? starsHtml(t.roughStars) : '-', t.medianTan3 ? `3連単の中央値 ${yen(t.medianTan3)}` : '')}
        ${kpi('1番人気の成績', fav.join('-'), `[1着-2着-3着-着外]　3着内率 ${pct(favTop3, 0)}`)}
        ${kpi('勝ち馬の平均人気', t.winnerPopAvg ? t.winnerPopAvg + '番人気' : '-', t.medianUmaren ? `馬連の中央値 ${yen(t.medianUmaren)}` : '')}
        ${kpi('枠順・脚質', `${t.inoutBias}`, t.bestStyle ? `有利な脚質: ${t.bestStyle}` : '')}
      </div>
      <ul class="insights">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
      <div class="trend-grid">
        <div><h3>枠番別</h3>${bars(t.waku, ['1', '2', '3', '4', '5', '6', '7', '8'], '枠')}</div>
        <div><h3>脚質別</h3>${bars(t.styles, ['逃げ', '先行', '差し', '追込'], '脚質')}
             <h3 style="margin-top:10px">馬番 内/外</h3>${bars(t.inout, ['内', '外'], '')}</div>
        <div><h3>人気別</h3>${bars(t.pops, ['1番人気', '2〜3番人気', '4〜6番人気', '7〜9番人気', '10番人気〜'], '人気')}</div>
      </div>
      <details><summary>年ごとの結果</summary><div class="table-wrap"><table class="mini">
        <thead><tr><th>年</th><th>競馬場</th><th>レース</th><th>勝ち馬</th><th class="num">人気</th><th class="num">枠</th><th>脚質</th><th class="num">馬連</th><th class="num">3連単</th></tr></thead>
        <tbody>${t.years.map((y) => `<tr><td>${y.year}</td><td>${esc(y.venue)}</td><td>${esc(y.name)}</td><td>${esc(y.winner)}</td>
          <td class="num">${y.winnerPop ?? '-'}</td><td class="num">${y.winnerWaku ?? '-'}</td><td>${esc(y.winnerStyle || '')}</td>
          <td class="num">${y.umaren ? yen(y.umaren) : '-'}</td><td class="num">${y.tan3 ? yen(y.tan3) : '-'}</td></tr>`).join('')}</tbody>
      </table></div></details>`;
  }

  // =====================================================
  // 馬券記録
  // =====================================================
  async function apiGet(path) {
    const res = await fetch(path, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }
  const BK = window.KeibaBets;
  const REC_TYPES = ['単勝', '複勝', 'ワイド', '馬連', '馬単', '3連複', '3連単', '枠連', 'WIN5'];
  const rec = { raceId: '', races: [], runners: [], type: '単勝', mode: 'normal', picks: [] };
  const online = () => location.protocol !== 'file:';

  function initLog() {
    fillSelect($('b-venue'), VENUES, true);
    $('b-types').innerHTML = REC_TYPES.map((t) => `<button data-t="${t}">${t}</button>`).join('');
    $('b-types').addEventListener('click', (e) => {
      const t = e.target.closest('button'); if (!t) return;
      rec.type = t.dataset.t;
      const k = (BK.TYPES[rec.type] || {}).k || 1;
      if (rec.mode === 'normal' && k > 1 && rec.picks.length > k) rec.picks = rec.picks.slice(0, k);
      renderForm();
    });
    $('b-mode').addEventListener('click', (e) => {
      if (!e.target.dataset.m) return;
      rec.mode = e.target.dataset.m; renderForm();
    });
    $('b-horses').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-no]'); if (!btn) return;
      const no = Number(btn.dataset.no);
      const k = (BK.TYPES[rec.type] || {}).k || 1;
      if (rec.picks.includes(no)) rec.picks = rec.picks.filter((x) => x !== no);
      else if (rec.mode === 'normal' && k > 1 && rec.picks.length >= k) { toast(`${rec.type}は${k}頭まで（もっと選ぶならボックス）`); return; }
      else rec.picks.push(no);
      renderForm();
    });
    $('b-quick').addEventListener('click', (e) => {
      if (!e.target.dataset.v) return;
      $('b-unit').value = e.target.dataset.v; renderForm();
    });
    $('b-unit').addEventListener('input', renderForm);
    $('b-sel').addEventListener('input', renderForm);
    $('b-date').addEventListener('change', () => loadRaces());
    $('b-racesel').addEventListener('change', () => selectRace($('b-racesel').value));
    ['b-venue', 'b-race', 'b-name'].forEach((id) => $(id).addEventListener('input', () => { if (!$('b-racesel').value) renderForm(); }));
    $('b-submit').addEventListener('click', submit);
    $('b-cancel').addEventListener('click', () => resetForm());
    $('b-search').addEventListener('input', renderLog);
    $('b-filter').addEventListener('change', renderLog);
    $('b-settle').addEventListener('click', () => autoSettle(false));
    $('b-list').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]'); if (!btn) return;
      const row = e.target.closest('[data-id]');
      const b = row && state.bets.find((x) => x.id === row.dataset.id); if (!b) return;
      if (btn.dataset.act === 'edit') editBet(b);
      if (btn.dataset.act === 'del' && confirm('この記録を削除しますか？')) {
        state.bets = state.bets.filter((x) => x.id !== b.id); save(); renderLog();
      }
      if (btn.dataset.act === 'miss') { b.payout = 0; save(); renderLog(); }
    });
    if (!online()) {
      $('b-racesel').innerHTML = '<option value="">サーバー未起動（下で手入力）</option>';
      $('b-racesel').disabled = true; $('b-manual-race').open = true; $('b-settle').disabled = true;
    }
    resetForm();
  }

  // ---------- レース選択 ----------
  async function loadRaces(selectId) {
    if (!online()) return;
    const date = $('b-date').value || today();
    $('b-racesel').innerHTML = '<option value="">読み込み中…</option>';
    try {
      const { races } = await apiGet(`/api/races?date=${date.replace(/-/g, '')}`);
      rec.races = races;
      if (!races.length) { $('b-racesel').innerHTML = '<option value="">この日はJRAの開催がありません</option>'; return; }
      const graded = races.filter((r) => r.grade);
      const byVenue = {};
      races.filter((r) => !r.grade).forEach((r) => { (byVenue[r.venue] = byVenue[r.venue] || []).push(r); });
      const opt = (r) => `<option value="${esc(r.race_id)}">${r.grade ? `【${esc(r.grade)}】` : ''}${esc(r.venue)}${r.race}R ${esc(r.name)}${r.course ? `（${esc(r.course)}）` : ''}</option>`;
      $('b-racesel').innerHTML = '<option value="">レースを選んでください</option>'
        + (graded.length ? `<optgroup label="重賞">${graded.map(opt).join('')}</optgroup>` : '')
        + Object.entries(byVenue).map(([v, list]) => `<optgroup label="${esc(v)}">${list.sort((a, b) => a.race - b.race).map(opt).join('')}</optgroup>`).join('');
      const want = selectId || rec.raceId;
      if (want && races.some((r) => r.race_id === want)) { $('b-racesel').value = want; await selectRace(want, true); }
    } catch (e) { $('b-racesel').innerHTML = `<option value="">取得できませんでした（${esc(e.message)}）</option>`; }
  }

  async function selectRace(rid, keepPicks) {
    rec.raceId = rid;
    if (!keepPicks) rec.picks = [];
    rec.runners = [];
    const r = rec.races.find((x) => x.race_id === rid);
    if (r) { $('b-venue').value = r.venue; $('b-race').value = r.race; $('b-name').value = r.name; }
    renderForm();
    if (!rid || !online()) return;
    $('b-horses').innerHTML = '<p class="hint">出走馬を読み込み中…</p>';
    try {
      const o = await apiGet(`/api/odds?race_id=${rid}&type=win`);
      rec.runners = o.horses;
      if (!$('b-name').value && o.name) $('b-name').value = o.name;
    } catch (e) { toast('出走馬を取得できませんでした。買い目は手入力してください'); }
    renderForm();
  }

  // ---------- フォーム表示 ----------
  function currentCombos() {
    const t = BK.TYPES[rec.type];
    if (!t) return null;  // WIN5など手入力
    return BK.buildCombos(rec.type, rec.mode, rec.picks);
  }

  function renderForm() {
    document.querySelectorAll('#b-types button').forEach((b) => b.classList.toggle('on', b.dataset.t === rec.type));
    const t = BK.TYPES[rec.type];
    const k = t ? t.k : 0;
    $('b-mode').classList.toggle('hidden', !t || k === 1);
    document.querySelectorAll('#b-mode button').forEach((b) => b.classList.toggle('on', b.dataset.m === rec.mode));
    $('b-mode-hint').textContent = !t ? '' : k === 1 ? '複数選ぶとそれぞれ1点ずつ買います'
      : rec.mode === 'box' ? `選んだ馬の全組み合わせ（${k}頭以上）` : t.ordered ? `着順どおりに${k}頭を選択（1着から順に）` : `${k}頭を選択`;

    // 出走馬ボタン（枠連は枠番）
    const manual = !t || (!rec.runners.length && rec.type !== '枠連');
    $('b-sel-wrap').classList.toggle('hidden', !manual);
    if (rec.type === '枠連') {
      $('b-horses').innerHTML = [1, 2, 3, 4, 5, 6, 7, 8].map((w) => `<button class="hbtn ${rec.picks.includes(w) ? 'on' : ''}" data-no="${w}">
        ${wakuBadge(w, w)}<span class="hb-name">${w}枠</span>${rec.picks.includes(w) ? `<span class="hb-ord">${rec.picks.indexOf(w) + 1}</span>` : ''}</button>`).join('');
    } else if (rec.runners.length && t) {
      const n = rec.runners.length;
      $('b-horses').innerHTML = rec.runners.map((h) => {
        const on = rec.picks.includes(h.no);
        const scratched = !h.odds && h.odds !== undefined;
        return `<button class="hbtn ${on ? 'on' : ''}" data-no="${h.no}" ${scratched ? 'disabled title="取消"' : ''}>
          ${wakuBadge(wakuOf(h.no, n), h.no)}<span class="hb-name">${esc(h.name || '')}</span>
          <span class="hb-odds">${h.odds ? h.odds.toFixed(1) : scratched ? '取消' : ''}</span>
          ${on ? `<span class="hb-ord">${t.ordered && rec.mode === 'normal' ? (rec.picks.indexOf(h.no) + 1) + '着' : '✓'}</span>` : ''}</button>`;
      }).join('');
    } else if (!t) {
      $('b-horses').innerHTML = '<p class="hint">WIN5は買い目を手入力してください</p>';
    } else if (!rec.raceId) {
      $('b-horses').innerHTML = `<p class="hint">${online() ? 'レースを選ぶと出走馬が表示されます。' : ''}一覧にないレースは買い目を手入力してください</p>`;
    }

    const combos = currentCombos();
    const unit = Number($('b-unit').value) || 0;
    const points = combos ? combos.length : ($('b-sel').value.trim() ? 1 : 0);
    const usePicks = combos && !manual;
    $('b-picked').innerHTML = usePicks && rec.picks.length
      ? `<span class="muted-inline">選択:</span> <b>${esc(rec.type)}</b> ${esc(BK.label(rec.type, rec.mode, rec.picks))}`
      : '';
    const pts = usePicks ? combos.length : points;
    $('b-total').innerHTML = pts
      ? `<span>${pts}点 × ${yen(unit)}</span><b>合計 ${yen(pts * unit)}</b>`
      : `<span class="hint">${usePicks && t && t.k > 1 && rec.mode === 'normal' ? `あと${Math.max(0, t.k - rec.picks.length)}頭選んでください` : '買い目を選んでください'}</span>`;
    $('b-submit').disabled = !pts || !unit;
  }

  function resetForm(keepRace) {
    $('b-id').value = '';
    if (!keepRace) {
      $('b-date').value = d().date || today();
      rec.raceId = d().raceId && d().date === $('b-date').value ? d().raceId : '';
    }
    rec.picks = []; rec.mode = 'normal';
    $('b-unit').value = 100; $('b-sel').value = ''; $('b-payout').value = '';
    $('b-conf').value = ''; $('b-ev').value = ''; $('b-memo').value = '';
    $('b-form-title').textContent = '馬券を記録';
    $('b-submit').textContent = 'この内容で記録する';
    if (!keepRace) loadRaces();
    renderForm();
  }

  function submit() {
    const id = $('b-id').value;
    const t = BK.TYPES[rec.type];
    const combos = currentCombos();
    const manual = !t || (!rec.runners.length && rec.type !== '枠連');
    let sel, cmb = null, picks = null;
    if (manual) {
      sel = $('b-sel').value.trim();
      if (!sel) { toast('買い目を入力してください'); return; }
      const nums = (sel.match(/\d+/g) || []).map(Number);
      if (t && nums.length) {  // 手入力でも「3-7」などは自動精算できるようにする
        picks = nums;
        cmb = BK.buildCombos(rec.type, t.k === 1 || nums.length === t.k ? 'normal' : 'box', nums);
        if (!cmb.length) cmb = null;
      }
    } else {
      if (!combos.length) { toast('買い目を選んでください'); return; }
      sel = BK.label(rec.type, rec.mode, rec.picks); cmb = combos; picks = rec.picks.slice();
    }
    const unit = Number($('b-unit').value);
    const points = cmb ? cmb.length : 1;
    const old = id ? state.bets.find((b) => b.id === id) : null;
    const payoutRaw = $('b-payout').value;
    const bet = {
      id: id || uid(), createdAt: old ? old.createdAt : Date.now(),
      date: $('b-date').value, venue: $('b-venue').value, race: $('b-race').value ? Number($('b-race').value) : '',
      name: $('b-name').value.trim(), raceId: $('b-racesel').value || '',
      type: rec.type, mode: rec.mode, picks, combos: cmb, points, unit, stake: unit * points, sel,
      payout: payoutRaw === '' ? null : Number(payoutRaw),
      conf: $('b-conf').value, ev: $('b-ev').value === '' ? '' : Number($('b-ev').value), memo: $('b-memo').value.trim(),
    };
    if (!bet.name && !bet.raceId) { toast('レースを選ぶか、レース名を入力してください'); return; }
    if (id) state.bets = state.bets.map((b) => (b.id === id ? bet : b));
    else state.bets.push(bet);
    save(); renderLog();
    toast(`${id ? '更新' : '記録'}しました（${bet.type} ${bet.sel}・${yen(bet.stake)}）`);
    resetForm(true);  // 同じレースで続けて記録しやすいよう、レースは残す
  }

  function editBet(b) {
    $('b-id').value = b.id;
    $('b-date').value = b.date;
    $('b-venue').value = b.venue || ''; $('b-race').value = b.race || ''; $('b-name').value = b.name || '';
    rec.type = b.type; rec.mode = b.mode || 'normal'; rec.picks = (b.picks || []).slice();
    rec.raceId = b.raceId || '';
    $('b-unit').value = b.unit || b.stake;
    $('b-sel').value = b.picks ? '' : b.sel;
    $('b-payout').value = b.payout ?? ''; $('b-conf').value = b.conf || ''; $('b-ev').value = b.ev ?? ''; $('b-memo').value = b.memo || '';
    $('b-form-title').textContent = '記録を編集';
    $('b-submit').textContent = '更新する';
    if (!b.raceId) { $('b-manual-race').open = true; if (!b.picks) $('b-sel').value = b.sel; }
    loadRaces(b.raceId);
    renderForm();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /** 予想タブの「記録」ボタンから */
  function prefillBet({ type, sel, ev, stake }) {
    document.querySelector('.tab[data-tab="log"]').click();
    $('b-id').value = '';
    $('b-date').value = d().date || today();
    rec.type = type; rec.mode = 'normal';
    rec.picks = String(sel).match(/\d+/g).map(Number);
    rec.raceId = d().raceId || '';
    $('b-venue').value = d().venue || ''; $('b-race').value = d().race || ''; $('b-name').value = d().name || '';
    $('b-unit').value = stake || 100;
    $('b-ev').value = ev ? Number(ev).toFixed(2) : '';
    $('b-form-title').textContent = '馬券を記録';
    $('b-submit').textContent = 'この内容で記録する';
    loadRaces(rec.raceId).then(() => renderForm());
    renderForm();
  }

  // ---------- 自動精算 ----------
  async function autoSettle(quiet) {
    if (!online()) return;
    const pending = state.bets.filter((b) => !S.isSettled(b) && b.raceId && b.combos && b.date <= today());
    if (!pending.length) { if (!quiet) toast('自動反映できる未確定の馬券はありません'); return; }
    const ids = [...new Set(pending.map((b) => b.raceId))];
    let done = 0, hit = 0;
    if (!quiet) $('b-settle').disabled = true;
    for (const rid of ids) {
      try {
        const r = await apiGet(`/api/payout?race_id=${rid}`);
        if (!r.final) continue;
        pending.filter((b) => b.raceId === rid).forEach((b) => {
          const s = BK.settle(b, r.payouts);
          b.payout = s.payout; b.hits = s.hits; done++; if (s.hits) hit++;
        });
      } catch (e) { /* 取得できないレースは飛ばす */ }
    }
    $('b-settle').disabled = false;
    save(); renderLog();
    if (done || !quiet) toast(done ? `${done}件の結果を反映しました（的中 ${hit}件）` : 'まだ結果が確定したレースはありません');
  }

  // ---------- 一覧 ----------
  function renderLog() {
    const q = $('b-search').value.trim().toLowerCase();
    const f = $('b-filter').value;
    const list = state.bets
      .filter((b) => !q || [b.name, b.sel, b.memo, b.venue, b.type].join(' ').toLowerCase().includes(q))
      .filter((b) => f === 'all' || (f === 'pending' ? !S.isSettled(b) : Number(b.payout) > 0))
      .sort((a, b) => -S.byDate(a, b));
    const pendingAuto = state.bets.filter((b) => !S.isSettled(b) && b.raceId && b.combos).length;
    $('b-settle').textContent = pendingAuto ? `結果を自動反映（${pendingAuto}件）` : '結果を自動反映';
    if (!list.length) { $('b-list').innerHTML = '<p class="empty">記録がありません。左のフォームから記録しましょう</p>'; return; }
    const groups = [];
    list.forEach((b) => {
      const key = `${b.date}|${b.raceId || b.venue + b.race + b.name}`;
      let g = groups.find((x) => x.key === key);
      if (!g) { g = { key, head: b, bets: [] }; groups.push(g); }
      g.bets.push(b);
    });
    $('b-list').innerHTML = groups.map((g) => {
      const stake = g.bets.reduce((a, b) => a + Number(b.stake || 0), 0);
      const settled = g.bets.every(S.isSettled);
      const pay = g.bets.reduce((a, b) => a + Number(b.payout || 0), 0);
      const h = g.head;
      return `<div class="race-group">
        <div class="rg-head"><span class="rg-date">${esc(h.date)}</span><b>${esc(h.venue || '')}${h.race ? esc(h.race) + 'R' : ''} ${esc(h.name || '')}</b>
          <span class="rg-sum">${yen(stake)} → ${settled ? `<b class="${signCls(pay - stake)}">${yen(pay)}（${pay - stake >= 0 ? '+' : ''}${yen(pay - stake)}）</b>` : '<span class="tag pending">未確定あり</span>'}</span></div>
        ${g.bets.map((b) => {
          const st = S.isSettled(b);
          const win = st && Number(b.payout) > 0;
          return `<div class="bet-row ${win ? 'win' : st ? 'lose' : ''}" data-id="${esc(b.id)}">
            <span class="type-chip">${esc(b.type)}</span>
            <span class="bet-sel">${esc(b.sel)}${b.points > 1 ? `<small>（${b.points}点×${yen(b.unit)}）</small>` : ''}</span>
            <span class="bet-stake">${yen(b.stake)}</span>
            <span class="bet-res">${win ? `<span class="res win">的中</span> <b>${yen(b.payout)}</b>` : st ? '<span class="res lose">ハズレ</span>' : '<span class="res wait">未確定</span>'}</span>
            <span class="bet-meta">${b.conf ? `自信${esc(b.conf)}` : ''}${b.ev ? ` 期待値${Number(b.ev).toFixed(2)}` : ''}${b.memo ? ` <span title="${esc(b.memo)}">📝</span>` : ''}</span>
            <span class="bet-act">${st ? '' : '<button class="btn small" data-act="miss" title="払戻0円で確定">ハズレ</button>'}
              <button class="btn small" data-act="edit">編集</button><button class="btn small ghost" data-act="del">✕</button></span>
          </div>`;
        }).join('')}
      </div>`;
    }).join('');
  }

  // =====================================================
  // 成績分析
  // =====================================================
  $('s-period').addEventListener('change', renderStats);

  function renderStats() {
    const bets = S.filterPeriod(state.bets, $('s-period').value);
    const s = S.summarize(bets);
    const kpi = (label, value, sub, cls = '') => `<div class="kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="sub">${sub || ''}</div></div>`;
    $('s-kpis').innerHTML = [
      kpi('回収率', pct(s.roi), '100%超えで黒字', s.roi >= 1 ? 'pos' : s.count ? 'neg' : ''),
      kpi('収支', yen(s.profit), `払戻 ${yen(s.payout)}`, signCls(s.profit)),
      kpi('的中率', pct(s.hitRate), `${s.hits} / ${s.count}件`),
      kpi('購入額', yen(s.stake), s.pending ? `未確定 ${s.pending}件` : ''),
      kpi('最大連敗', s.maxLosingStreak + '連敗', ''),
      kpi('最大ドローダウン', yen(-s.maxDrawdown), 'ピークからの最大下落'),
      kpi('1件平均購入', s.count ? yen(s.stake / s.count) : '-', ''),
      kpi('平均払戻(的中時)', s.hits ? yen(s.payout / s.hits) : '-', ''),
    ].join('');

    renderChart(S.cumulative(bets));
    $('s-type').innerHTML = groupTable(S.groupBy(bets, (b) => b.type), BET_TYPES);
    $('s-venue').innerHTML = groupTable(S.groupBy(bets, (b) => b.venue), VENUES);
    $('s-conf').innerHTML = groupTable(S.groupBy(bets, (b) => b.conf && '自信度' + b.conf), ['自信度A', '自信度B', '自信度C']);
    $('s-ev').innerHTML = groupTable(S.groupBy(bets, S.evBand), ['EV 1.0未満', 'EV 1.0〜1.2', 'EV 1.2〜1.5', 'EV 1.5以上']);
    $('s-month').innerHTML = groupTable(S.groupBy(bets, (b) => (b.date || '').slice(0, 7)), null, true);
  }

  function groupTable(groups, order, desc) {
    if (!groups.length) return '<p class="empty">データなし</p>';
    if (order) groups.sort((a, b) => idx(order, a.key) - idx(order, b.key));
    else groups.sort((a, b) => (desc ? -1 : 1) * a.key.localeCompare(b.key));
    const maxRoi = Math.max(2, ...groups.map((g) => g.roi));
    return `<div class="table-wrap"><table><thead><tr><th></th><th class="num">件数</th><th class="num">的中率</th><th class="num">購入</th><th class="num">収支</th><th class="num">回収率</th><th></th></tr></thead><tbody>
      ${groups.map((g) => `<tr><td>${esc(g.key)}</td><td class="num">${g.count}</td><td class="num">${pct(g.hitRate)}</td>
        <td class="num">${yen(g.stake)}</td><td class="num ${signCls(g.profit)}">${yen(g.profit)}</td>
        <td class="num ${g.roi >= 1 ? 'pos' : 'neg'}"><b>${pct(g.roi)}</b></td>
        <td><div class="bar"><span style="width:${Math.min(100, (g.roi / maxRoi) * 100)}%"></span><i style="left:${(1 / maxRoi) * 100}%"></i></div></td></tr>`).join('')}
      </tbody></table></div>`;
  }
  function idx(order, k) { const i = order.indexOf(k); return i < 0 ? 999 : i; }

  function renderChart(points) {
    const el = $('s-chart');
    if (points.length < 2) { el.innerHTML = '<p class="empty">確定済みの記録が2件以上になると表示します</p>'; return; }
    const W = 800, H = 220, pl = 64, pr = 12, pt = 12, pb = 26;
    const vals = points.map((p) => p.value);
    const min = Math.min(0, ...vals), max = Math.max(0, ...vals);
    const span = max - min || 1;
    const x = (i) => pl + (i / (points.length - 1)) * (W - pl - pr);
    const y = (v) => pt + (1 - (v - min) / span) * (H - pt - pb);
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
    const area = `${path}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z`;
    const ticks = [max, (max + min) / 2, min];
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="累積収支の推移">
      <path class="area" d="${area}"/>
      <line class="zero" x1="${pl}" x2="${W - pr}" y1="${y(0)}" y2="${y(0)}"/>
      <path class="line" d="${path}" vector-effect="non-scaling-stroke"/>
      ${ticks.map((t) => `<text x="${pl - 6}" y="${y(t) + 4}" text-anchor="end">${yen(t)}</text>`).join('')}
      <text x="${pl}" y="${H - 6}">${esc(points[0].date)}</text>
      <text x="${W - pr}" y="${H - 6}" text-anchor="end">${esc(points[points.length - 1].date)}</text>
    </svg>`;
  }

  // =====================================================
  // 設定
  // =====================================================
  function initSettings() {
    $('c-bankroll').value = state.settings.bankroll;
    $('c-kelly').value = String(state.settings.kelly);
    $('c-cap').value = state.settings.cap;
    [['c-bankroll', 'bankroll'], ['c-kelly', 'kelly'], ['c-cap', 'cap']].forEach(([id, k]) => {
      $(id).addEventListener('change', (e) => { state.settings[k] = Number(e.target.value); save(); renderAnalysis(); });
    });
    $('d-export').addEventListener('click', () => download(`keiba-note-${today()}.json`, JSON.stringify(state, null, 2), 'application/json'));
    $('d-csv').addEventListener('click', () => {
      const cols = ['date', 'venue', 'race', 'name', 'type', 'sel', 'stake', 'payout', 'conf', 'ev', 'memo'];
      const head = ['日付', '競馬場', 'R', 'レース名', '券種', '買い目', '購入額', '払戻額', '自信度', '予想EV', 'メモ'];
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = [head.map(q).join(','), ...state.bets.slice().sort(S.byDate).map((b) => cols.map((c) => q(b[c])).join(','))].join('\r\n');
      download(`keiba-bets-${today()}.csv`, '﻿' + csv, 'text/csv');
    });
    $('d-import').addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!Array.isArray(data.bets)) throw new Error('bets がありません');
        if (!confirm(`${data.bets.length}件の記録を読み込みます。現在のデータは置き換えられます。よろしいですか？`)) return;
        const def = defaultState();
        state = { ...def, ...data, settings: { ...def.settings, ...data.settings }, draft: { ...def.draft, ...data.draft } };
        save(); location.reload();
      } catch (err) { toast('読み込み失敗: ' + err.message); }
      e.target.value = '';
    });
    $('d-sample').addEventListener('click', () => {
      if (!confirm('サンプルデータを追加します（既存データは残ります）')) return;
      state.bets.push(...sampleBets());
      if (!d().horses.length) d().horses = sampleHorses();
      save(); location.reload();
    });
    $('d-reset').addEventListener('click', () => {
      if (!confirm('すべての記録と設定を削除します。元に戻せません。よろしいですか？')) return;
      state = defaultState(); save(); location.reload();
    });
  }

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function sampleHorses() {
    return [
      { no: 1, name: 'サンプルA', odds: 2.5, score: 80 }, { no: 2, name: 'サンプルB', odds: 3.6, score: 70 },
      { no: 3, name: 'サンプルC', odds: 5.4, score: 80 }, { no: 4, name: 'サンプルD', odds: 7.4, score: 60 },
      { no: 5, name: 'サンプルE', odds: 10.0, score: 70 }, { no: 6, name: 'サンプルF', odds: 14.4, score: 50 },
      { no: 7, name: 'サンプルG', odds: 20.2, score: 50 }, { no: 8, name: 'サンプルH', odds: 36.1, score: 30 },
    ];
  }
  function sampleBets() {
    const types = ['単勝', '複勝', '馬連', 'ワイド', '3連複'];
    const out = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const start = new Date(); start.setDate(start.getDate() - 120);
    for (let i = 0; i < 60; i++) {
      const dt = new Date(start.getTime() + Math.floor(i / 3) * 6 * 86400000);
      const type = types[Math.floor(rnd() * types.length)];
      const hitP = { 単勝: 0.2, 複勝: 0.45, 馬連: 0.12, ワイド: 0.3, '3連複': 0.06 }[type];
      const mult = { 単勝: 5, 複勝: 2.1, 馬連: 8, ワイド: 3.2, '3連複': 15 }[type];
      const stake = (1 + Math.floor(rnd() * 5)) * 200;
      const ev = +(0.8 + rnd() * 0.8).toFixed(2);
      const hit = rnd() < hitP * (ev / 1.1);
      out.push({
        id: uid() + i, createdAt: Date.now() + i,
        date: dt.toISOString().slice(0, 10), venue: VENUES[Math.floor(rnd() * 8)], race: 1 + Math.floor(rnd() * 12),
        name: 'サンプル', type, sel: String(1 + Math.floor(rnd() * 16)), stake,
        payout: hit ? Math.round((stake * mult * (0.6 + rnd())) / 10) * 10 : 0,
        conf: ['A', 'B', 'C'][Math.floor(rnd() * 3)], ev, memo: 'サンプルデータ',
      });
    }
    return out;
  }


  // =====================================================
  // オッズ自動取得（server.py 経由）
  // =====================================================
  const Fetch = (() => {
    let timer = null;
    const status = (msg, cls = '') => { $('f-status').textContent = msg; $('f-status').className = 'badge ' + cls; };
    const ymd = () => ($('f-date').value || today()).replace(/-/g, '');
    async function api(path) {
      const res = await fetch(path, { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      return body;
    }

    function init() {
      $('f-date').value = d().date || today();
      if (location.protocol === 'file:') {
        ['f-fetch', 'f-race', 'f-auto', 't-load', 'f-date'].forEach((id) => { $(id).disabled = true; });
        $('f-race').innerHTML = '<option>サーバー未起動（手入力モード）</option>';
        $('f-hint').innerHTML = '自動取得を使うには、ターミナルで <code>python3 server.py</code> を実行し <b>http://localhost:8765</b> を開いてください。';
        return;
      }
      api('/api/ping').then((r) => status(r.provider === 'MockProvider' ? 'モックデータで接続中' : '接続OK', 'ok'))
        .catch(() => status('サーバーに接続できません', 'err'));
      $('f-date').addEventListener('change', listRaces);
      $('f-race').addEventListener('change', () => { if ($('f-race').value && $('f-race').value !== d().raceId) win(true); });
      $('t-load').addEventListener('click', trend);
      $('f-fetch').addEventListener('click', () => win(true));
      $('f-auto').addEventListener('change', (e) => {
        clearInterval(timer);
        if (e.target.checked) timer = setInterval(() => { win(false).then(() => { combos(false); AIMS[d().aim || 'balance'].types.forEach((t) => combos(false, t)); }); }, 60000);
      });
      listRaces();
    }

    let raceList = [];
    async function listRaces() {
      status('重賞を検索中…');
      $('f-race').innerHTML = '<option value="">読み込み中…</option>';
      try {
        const { races } = await api(`/api/races?date=${ymd()}`);
        raceList = races.filter((r) => ['G1', 'G2', 'G3'].includes(r.grade))
          .sort((a, b) => a.grade.localeCompare(b.grade) || a.venue.localeCompare(b.venue));
        if (!raceList.length) {
          $('f-race').innerHTML = `<option value="">${races.length ? 'この日は重賞がありません' : 'この日はJRAの開催がありません'}</option>`;
          status('', ''); return;
        }
        $('f-race').innerHTML = '<option value="">重賞を選んでください</option>' + raceList.map((r) =>
          `<option value="${esc(r.race_id)}">【${esc(r.grade)}】${esc(r.name)}（${esc(r.venue)}${r.race}R ${esc(r.course)}）</option>`).join('');
        if (raceList.some((r) => r.race_id === d().raceId)) $('f-race').value = d().raceId;
        status(`重賞 ${raceList.length}レース`, 'ok');
      } catch (e) { status('一覧の取得失敗: ' + e.message, 'err'); }
    }

    async function win(manual) {
      const rid = $('f-race').value;
      if (!rid) { if (manual) toast('レースを選んでください'); return; }
      status('オッズを取得中…');
      try {
        const r = await api(`/api/odds?race_id=${rid}&type=win`);
        const prev = new Map(d().horses.map((h) => [Number(h.no), h]));
        if (rid !== d().raceId) { d().comboOdds = {}; d().horseInfo = {}; d().trend = null; d().modelInfo = null; d().raceMeta = {}; prev.clear(); }
        d().horses = r.horses.filter((h) => h.odds).map((h) => ({
          no: h.no,
          name: h.name || (prev.get(h.no) || {}).name || '',
          odds: h.odds,
          score: (prev.get(h.no) || {}).score ?? 50,
        }));
        const scratched = r.horses.filter((h) => !h.odds).map((h) => h.no);
        const meta = raceList.find((x) => x.race_id === rid);
        Object.assign(d(), { raceId: rid, venue: r.venue, race: r.race, name: r.name || d().name, date: $('f-date').value });
        if (meta) d().raceMeta = { grade: meta.grade, course: meta.course };
        $('p-venue').value = r.venue; $('p-race').value = r.race; $('p-name').value = d().name; $('p-date').value = d().date;
        save(); renderHorses();
        status(`単勝 ${r.updated || ''} 時点${scratched.length ? ` / 取消・オッズなし: ${scratched.join(',')}番` : ''}`, 'ok');
        if (manual) { combos(true); (AIMS[d().aim || 'balance'].types).forEach((t) => t !== d().comboType && combos(true, t)); horses().then(() => trend()); }
      } catch (e) { status('取得失敗: ' + e.message, 'err'); }
    }

    async function combos(force, typeArg) {
      const rid = d().raceId;
      if (!rid || location.protocol === 'file:') return;
      const type = typeArg || d().comboType;
      if (!force && d().comboOdds[type] && d().comboOdds[type].__rid === rid && Date.now() - d().comboOdds[type].__at < 60000) return;
      try {
        const r = await api(`/api/odds?race_id=${rid}&type=${type}`);
        d().comboOdds[type] = { ...r.odds, __rid: rid, __at: Date.now() };
        save();
        if (d().comboType === type || (AIMS[d().aim] || {}).types?.includes(type)) renderAnalysis();
      } catch (e) { status(`${COMBO_TO_BET[type]}オッズの取得失敗: ${e.message}`, 'err'); }
    }
    async function horses() {
      const rid = d().raceId; if (!rid) return;
      try {
        const r = await api(`/api/horses?race_id=${rid}&date=${(d().date || today()).replace(/-/g, "")}`);
        d().horseInfo = Object.fromEntries(r.horses.map((h) => [h.no, h]));
        d().modelInfo = r.model ? { ...r.model, raceId: rid } : null;
        if (!d().raceMeta.course && r.course) d().raceMeta = { ...d().raceMeta, course: r.course, grade: r.grade || d().raceMeta.grade };
        save(); renderHorses();
      } catch (e) { status('能力値の取得失敗: ' + e.message, 'err'); }
    }
    async function trend() {
      const rid = d().raceId;
      if (!rid) { toast('先にレースを選んでオッズ取得してください'); return; }
      $('t-load').disabled = true;
      $('t-body').innerHTML = '<p class="hint">過去10年分を集計中…（初回は1分ほどかかります。2回目以降はすぐ表示されます）</p>';
      try {
        d().trend = await api(`/api/trend?race_id=${rid}&date=${(d().date || today()).replace(/-/g, "")}`);
        save(); renderTrend(); renderHorses();
      } catch (e) { $('t-body').innerHTML = `<p class="empty">傾向の取得失敗: ${esc(e.message)}</p>`; }
      $('t-load').disabled = false;
    }
    return { init, combos, horses, trend };
  })();

  // =====================================================
  // 検証（バックテスト）
  // =====================================================
  const Backtest = (() => {
    let timer = null;
    const RATE_PER_DAY = { graded: 1.5, named: 6, all: 24 };  // 1日あたりの対象レース数の目安
    const roiCls = (r) => (r == null ? '' : r >= 1 ? 'pos' : r < 0.8 ? 'neg' : '');
    const pctOr = (x, d = 1) => (x == null ? '-' : pct(x, d));

    function init() {
      const to = new Date(); to.setDate(to.getDate() - 1);
      const from = new Date(to); from.setDate(from.getDate() - 56);
      const iso = (x) => new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      $('bt-from').value = iso(from); $('bt-to').value = iso(to);
      ['bt-from', 'bt-to', 'bt-scope'].forEach((id) => $(id).addEventListener('change', estimate));
      estimate();
      if (location.protocol === 'file:') {
        $('bt-run').disabled = true;
        $('bt-estimate').textContent = 'バックテストは server.py で起動したとき（http://localhost:8765）に使えます。';
      } else {
        $('bt-run').addEventListener('click', start);
        $('bt-cancel').addEventListener('click', () => fetch('/api/backtest/cancel'));
        $('bt-re').addEventListener('click', async () => {
          const res = await fetch('/api/backtest/reevaluate?temp=' + ($('bt-temp').value || 10));
          const body = await res.json().catch(() => ({}));
          if (!res.ok) { toast(body.error || '先に実行してください'); return; }
          state.backtest = body.result; save(); render(body.result);
          toast(`メリハリ ${body.result.temperature} で再集計しました`);
        });
        fetch('/api/backtest/status').then((r) => r.json()).then((st) => { if (st.status === 'running') poll(); }).catch(() => {});
      }
      $('bt-result').addEventListener('click', (e) => {
        if (e.target.dataset.act !== 'apply') return;
        d().weight = Number(e.target.dataset.w); d().minev = Number(e.target.dataset.e); d().temp = Number(e.target.dataset.t);
        save();
        $('p-weight').value = d().weight; $('p-minev').value = d().minev; $('p-temp').value = d().temp; renderAnalysis();
        toast(`予想タブに反映しました（自分の重み ${d().weight}% / 基準EV ${(d().minev / 100).toFixed(2)} / メリハリ ${d().temp}）`);
      });
      if (state.backtest) render(state.backtest);
    }

    function estimate() {
      const days = Math.max(0, (new Date($('bt-to').value) - new Date($('bt-from').value)) / 86400000 + 1);
      const raceDays = Math.round(days * 3 / 7);
      const races = Math.round(raceDays * RATE_PER_DAY[$('bt-scope').value]);
      const min = Math.ceil((raceDays * 1.5 + races * 3.2) / 60);
      $('bt-estimate').textContent = `目安: 約${races}レース・初回は約${min}分（取得済みのレースは保存されるので、2回目以降は数秒）。100レース以上あると結果が安定します。`;
    }

    async function start() {
      const q = new URLSearchParams({
        from: $('bt-from').value.replace(/-/g, ''), to: $('bt-to').value.replace(/-/g, ''),
        scope: $('bt-scope').value, temp: $('bt-temp').value || 10,
      });
      const res = await fetch('/api/backtest/start?' + q);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { toast(body.error || '開始できませんでした'); return; }
      poll();
    }

    function poll() {
      $('bt-progress').classList.remove('hidden'); $('bt-cancel').classList.remove('hidden'); $('bt-run').disabled = true;
      clearInterval(timer);
      timer = setInterval(async () => {
        let st;
        try { st = await (await fetch('/api/backtest/status')).json(); } catch (e) { return; }
        $('bt-bar').style.width = st.total ? `${(st.done / st.total) * 100}%` : '3%';
        $('bt-msg').textContent = `${st.total ? `${st.done}/${st.total}レース　` : ''}${st.message || ''}`;
        if (st.status === 'running') return;
        clearInterval(timer);
        $('bt-progress').classList.add('hidden'); $('bt-cancel').classList.add('hidden'); $('bt-run').disabled = false;
        if (st.status === 'error') { toast('バックテスト失敗: ' + st.message); return; }
        if (st.result) { state.backtest = st.result; save(); render(st.result); }
        else toast('対象レースがありませんでした');
      }, 1500);
    }

    function statTable(rows) {
      return `<div class="table-wrap"><table class="mini"><thead><tr><th></th><th class="num">頭数</th><th class="num">勝率</th><th class="num">複勝率</th><th class="num">単勝回収率</th><th class="num">複勝回収率</th></tr></thead><tbody>
        ${rows.map(([label, v]) => `<tr><td>${label}</td><td class="num">${v.n}</td><td class="num">${pctOr(v.winRate)}</td><td class="num">${pctOr(v.top3Rate)}</td>
          <td class="num ${roiCls(v.tanRoi)}"><b>${pctOr(v.tanRoi)}</b></td><td class="num ${roiCls(v.fukuRoi)}"><b>${pctOr(v.fukuRoi)}</b></td></tr>`).join('')}
      </tbody></table></div>`;
    }

    function verdicts(r) {
      const out = [];
      const s5 = r.byStars['5'], s1 = r.byStars['1'] || r.byStars['2'];
      if (s5.n && s1 && s1.n) {
        const ok = s5.winRate > (r.byStars['3'].winRate || 0) && (r.byStars['3'].winRate || 0) >= (s1.winRate || 0);
        out.push(ok ? `★が高いほど勝率が高い（★5 ${pct(s5.winRate)} → ★3 ${pctOr(r.byStars['3'].winRate)}）。<b class="pos">能力値は「強さ」を捉えています</b>`
          : `★と勝率の関係がはっきりしません。<b class="neg">能力値の計算式の見直しが必要</b>です`);
      }
      const t = r.topRated, f = r.favorite;
      out.push(`能力1位の馬の勝率 ${pct(t.winRate)}（1番人気は ${pct(f.winRate)}）。` + (t.winRate >= f.winRate
        ? '<b class="pos">市場と同等以上に当てています</b>' : '当てる力そのものは市場（1番人気）の方が上。<b>オッズとの組み合わせが鍵</b>'));
      const u = r.underrated;
      if (u.n >= 30) {
        const wins = Math.round(u.winRate * u.n);
        out.push(`人気より能力順位が3つ以上高い「過小評価馬」の単勝回収率は <b class="${roiCls(u.tanRoi)}">${pct(u.tanRoi)}</b>（${u.n}頭・${wins}勝）。` +
          (u.tanRoi >= 0.9 ? '市場が見落としている情報を含んでいる可能性があります' : '能力値の情報は、ほぼオッズに織り込み済みです') +
          (wins < 30 ? '。ただし勝ち数が少なく、数頭の大穴で数字が大きく動きます' : ''));
      }
      const sp = r.split;
      if (sp.best && sp.bestTest) {
        const ok = sp.bestTest.roi != null && sp.bestTest.roi >= 1;
        out.push(`前半（${sp.trainRaces}R）で最も良かった設定「自分の重み${sp.best.weight * 100}%・基準EV ${sp.best.minEv.toFixed(2)}」を後半（${sp.testRaces}R）に当てはめると、
          単勝回収率 <b class="${roiCls(sp.bestTest.roi)}">${pctOr(sp.bestTest.roi)}</b>（${sp.bestTest.bets}点・${sp.bestTest.hits}的中）。同期間に1番人気を買い続けると ${pctOr(sp.favoriteTest.tanRoi)}。` +
          (sp.bestTest.bets < 100 ? ' <b>まだ点数が少なく偶然の影響が大きい</b>ので、期間を広げて再確認してください' : ok ? ' <b class="pos">期間外でもプラス。有望です</b>' : ''));
      }
      if (!sp.best) out.push('前半期間に十分な点数（50点以上）の設定がなく、最適設定は選べませんでした。期間を広げてください');
      const hot = r.calibration.filter((c) => c.n >= 20 && c.pred >= 0.2 && c.actual < c.pred * 0.7);
      if (hot.length) out.push(`推定勝率が高い帯で、実際の勝率が推定を大きく下回っています（推定${pct(hot[hot.length - 1].pred, 0)} → 実際${pct(hot[hot.length - 1].actual, 0)}）。
        <b>推定が強気すぎる</b>ので「評価のメリハリ」を今（${r.temperature}）より大きくして再集計してください`);
      const hits = r.grid.filter((g) => g.weight > 0).map((g) => g.hits);
      if (Math.max(...hits) < 50) out.push(`的中数が最大でも${Math.max(...hits)}回と少なく、回収率は数回の高配当で大きく変わります。<b>半年〜1年分で検証するのが目安</b>です`);
      return out;
    }

    function heatmap(r) {
      const W = [0, 0.25, 0.5, 0.75, 1], E = [1.0, 1.1, 1.2, 1.3, 1.5];
      const best = r.split.best;
      const cell = (w, e) => r.grid.find((g) => g.weight === w && Math.abs(g.minEv - e) < 1e-9);
      const color = (roi) => {
        if (roi == null) return 'transparent';
        const x = Math.max(-1, Math.min(1, (roi - 0.8) / 0.4));  // 80%を中立に
        return x >= 0 ? `rgba(31,122,63,${0.12 + x * 0.45})` : `rgba(192,57,43,${0.12 - x * 0.4})`;
      };
      return `<div class="table-wrap"><table class="heat mini"><thead><tr><th>自分の重み ＼ 基準EV</th>${E.map((e) => `<th class="num">${e.toFixed(2)}</th>`).join('')}</tr></thead><tbody>
        ${W.map((w) => `<tr><th>${w * 100}%${w === 0 ? '（オッズのみ＝控除率の分だけ常にEV<1）' : ''}</th>${E.map((e) => {
          const g = cell(w, e);
          const isBest = best && best.weight === w && Math.abs(best.minEv - e) < 1e-9;
          return `<td class="cell ${isBest ? 'best' : ''}" style="background:${color(g.roi)}">${pctOr(g.roi, 0)}<small>${g.bets}点・${g.hits}的中</small></td>`;
        }).join('')}</tr>`).join('')}
      </tbody></table></div>`;
    }

    function render(r) {
      if (!r) { $('bt-result').innerHTML = ''; return; }
      const sp = r.split;
      const calib = r.calibration.filter((c) => c.n);
      $('bt-result').innerHTML = `
        <div class="card"><div class="card-head"><h2>総合判定</h2><span class="badge">${esc(r.from)}〜${esc(r.to)}　${r.races}レース・${r.horses}頭</span></div>
          <ul class="insights">${verdicts(r).map((v) => `<li>${v}</li>`).join('')}</ul>
          ${sp.best ? `<button class="btn primary" data-act="apply" data-w="${sp.best.weight * 100}" data-e="${Math.round(sp.best.minEv * 100)}" data-t="${r.temperature}">この設定（重み${sp.best.weight * 100}%・基準EV ${sp.best.minEv.toFixed(2)}）を予想タブに反映</button>` : ''}
        </div>
        <div class="grid-2">
          <div class="card"><h2>能力★別の成績</h2>${statTable([5, 4, 3, 2, 1].map((s) => ['★'.repeat(s), r.byStars[s]]))}
            <p class="hint">★が高いほど勝率・複勝率が高ければ、能力値は機能しています。回収率は80%前後が「市場平均」です。</p></div>
          <div class="card"><h2>市場（人気）との比較</h2>${statTable([['能力1位の馬', r.topRated], ['1番人気の馬', r.favorite], ['過小評価馬', r.underrated], ['人気先行馬', r.overrated]])}
            <p class="hint">過小評価馬＝能力順位が人気順位より3つ以上高い馬。ここの回収率が高いほど「オッズに勝てる情報」です。</p></div>
        </div>
        <div class="card"><h2>予想モデルの設定別 単勝回収率（全期間）</h2>
          <p class="hint">予想タブと同じ計算で「EVが基準以上の馬の単勝を100円ずつ」買った場合。枠線＝前半期間で最も良かった設定（後半の成績は総合判定を参照）。点数が少ないマスは偶然の影響が大きい点に注意。</p>
          ${heatmap(r)}</div>
        <div class="card"><h2>推定勝率の当てはまり（能力値のみ）</h2>
          <div class="table-wrap"><table class="mini"><thead><tr><th>推定勝率の帯</th><th class="num">頭数</th><th class="num">推定の平均</th><th class="num">実際の勝率</th></tr></thead><tbody>
          ${calib.map((c) => `<tr><td>${pct(c.from, 0)}〜${c.to > 1 ? '' : pct(c.to, 0)}</td><td class="num">${c.n}</td><td class="num">${pctOr(c.pred)}</td><td class="num"><b>${pctOr(c.actual)}</b></td></tr>`).join('')}
          </tbody></table></div>
          <p class="hint">推定と実際が近いほど確率として信頼できます。実際の方が極端に低い/高い場合は「評価のメリハリ」を調整してください。</p></div>`;
    }
    return { init };
  })();

  // =====================================================
  // 学習モデル
  // =====================================================
  const Learn = (() => {
    function init() {
      if (location.protocol === 'file:') { $('lm-run').disabled = true; $('lm-off').disabled = true; return; }
      $('lm-run').addEventListener('click', run);
      $('lm-off').addEventListener('click', async () => {
        await fetch('/api/learn/off'); toast('学習モデルの使用をやめました'); status();
        d().modelInfo = null; save(); renderAnalysis();
      });
      $('lm-result').addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-act]'); if (!btn) return;
        if (btn.dataset.act === 'use' || btn.dataset.act === 'force') {
          const res = await fetch('/api/learn/use' + (btn.dataset.act === 'force' ? '?force=1' : ''));
          const body = await res.json().catch(() => ({}));
          if (!res.ok) { toast(body.error || '保存できませんでした'); return; }
          toast('学習モデルを予想に使います。予想タブでレースを取得し直してください');
          d().method = 'learned'; save(); status();
        }
      });
      status();
    }
    async function status() {
      try {
        const r = await (await fetch('/api/learn/status')).json();
        $('lm-status').textContent = r.model ? `使用中: ${r.model.from}〜${r.model.trainedAt}・${r.model.races}レースで学習` : '学習モデルは未使用';
        $('lm-status').className = 'badge ' + (r.model ? 'ok' : '');
        if (r.learned && !$('lm-result').innerHTML) render(r.learned);
      } catch (e) { /* サーバー未起動 */ }
    }
    async function run() {
      $('lm-run').disabled = true;
      $('lm-result').innerHTML = '<p class="hint">学習中…（数秒〜数十秒）</p>';
      try {
        const res = await fetch('/api/learn/run');
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || '失敗しました');
        render(body);
      } catch (e) { $('lm-result').innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
      $('lm-run').disabled = false;
    }
    function render(r) {
      const imp = r.improvement;
      const good = imp != null && imp >= 0.003;  // 0.3%未満は誤差の範囲
      const feats = r.features.filter((f) => f.key !== 'market');
      const beta = r.model.beta;
      const maxAbs = Math.max(0.1, ...feats.map((f) => Math.abs(beta[f.key])));
      const g = r.graded;
      $('lm-result').innerHTML = `
        <div class="grid-2" style="margin-top:12px">
          <div class="kpi"><div class="label">オッズだけの予想と比べた精度（検証期間 ${r.testRaces}R）</div>
            <div class="headline ${good ? 'pos' : 'neg'}">${imp == null ? '-' : (imp > 0 ? '+' : '') + (imp * 100).toFixed(2) + '%'}</div>
            <div class="sub">対数損失の改善率。競馬ではプラス0.5%でも大きな差です${g ? `／重賞だけ(${g.races}R)では ${(g.improvement > 0 ? '+' : '') + (g.improvement * 100).toFixed(2)}%` : ''}</div></div>
          <div class="kpi"><div class="label">推定1位の馬の勝率（検証期間）</div>
            <div class="headline">${pct(r.topModel)}</div><div class="sub">1番人気は ${pct(r.topMarket)}</div></div>
        </div>
        <p class="verdict">${good
          ? '<b class="pos">学習モデルはオッズだけの予想より当たっています。</b>予想に使う価値があります。'
          : imp > 0 ? '<b>オッズだけの予想とほぼ同じ精度です（差は誤差の範囲）。</b>今ある情報はすでにオッズに織り込まれている、という結果です。'
          : '<b class="neg">まだオッズだけの予想を上回れていません。</b>データ（期間）を増やして再学習してください。今は使わない方が安全です。'}</p>
        <div class="btn-row" style="margin:10px 0 14px">
          ${good ? '<button class="btn primary" data-act="use">このモデルを予想に使う</button>'
            : '<button class="btn ghost" data-act="force" title="おすすめしません">それでも使う</button>'}
        </div>
        <div class="grid-2">
          <div><h3 style="font-size:13px;margin:0 0 8px">何を重視しているか（学習した重み）</h3>
            <div class="coef">${feats.map((f) => {
              const v = beta[f.key], w = (Math.abs(v) / maxAbs) * 50;
              return `<span title="${esc(f.desc)}">${esc(f.label)}</span>
                <div class="cbar"><i class="zero"></i><span style="${v >= 0 ? `left:50%;width:${w}%;background:var(--pos)` : `right:50%;width:${w}%;background:var(--neg)`}"></span></div>
                <span class="num ${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${v.toFixed(2)}</span>`;
            }).join('')}</div>
            <p class="hint">緑＝高いほど勝ちやすい／赤＝高いほど勝ちにくい（オッズを考慮した上での上乗せ分）。オッズの重み ${beta.market.toFixed(2)}（1.0＝市場をそのまま信頼）。前走の着順・休養明けなどは数値が大きいほど不利な指標です。</p></div>
          <div><h3 style="font-size:13px;margin:0 0 8px">期待値の帯ごとの単勝回収率（検証期間）</h3>
            <table class="mini"><thead><tr><th>期待値</th><th class="num">点数</th><th class="num">的中</th><th class="num">回収率</th></tr></thead><tbody>
            ${r.evBands.map((b) => `<tr><td>${b.from.toFixed(1)}〜${b.to > 9 ? '' : b.to.toFixed(1)}</td><td class="num">${b.bets}</td><td class="num">${b.hits}</td>
              <td class="num ${b.roi == null ? '' : b.roi >= 1 ? 'pos' : 'neg'}"><b>${b.roi == null ? '-' : pct(b.roi)}</b></td></tr>`).join('')}
            </tbody></table>
            <p class="hint">期待値が高い帯ほど回収率が高ければ、モデルの期待値は信頼できます。的中が少ない帯は偶然の影響が大きい点に注意。</p></div>
        </div>`;
    }
    return { init };
  })();

  // ---------- 起動 ----------
  initPredict();
  Fetch.init();
  renderTrend();
  Backtest.init();
  Learn.init();
  initLog();
  initSettings();
  renderLog();
})();
