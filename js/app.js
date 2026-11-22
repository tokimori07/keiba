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
      weight: 50, temp: 10, minev: 110, comboType: 'quinella',
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
      if (btn.dataset.tab === 'log') renderLog();
    });
  });

  // =====================================================
  // 予想
  // =====================================================
  const d = () => state.draft;

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
      $(id).addEventListener('change', (e) => { d()[k] = e.target.value; save(); });
    });
    [['p-weight', 'weight'], ['p-temp', 'temp'], ['p-minev', 'minev']].forEach(([id, k]) => {
      $(id).addEventListener('input', (e) => { d()[k] = Number(e.target.value); save(); renderAnalysis(); });
    });
    $('p-add').addEventListener('click', () => {
      const next = d().horses.reduce((m, h) => Math.max(m, Number(h.no) || 0), 0) + 1;
      d().horses.push({ no: next, name: '', odds: '', score: 50 });
      save(); renderHorses();
    });
    $('p-clear').addEventListener('click', () => {
      if (!confirm('出走馬リストをクリアしますか？')) return;
      d().horses = []; save(); renderHorses();
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
    tb.addEventListener('input', (e) => {
      const tr = e.target.closest('tr'); if (!tr) return;
      const h = d().horses[Number(tr.dataset.i)];
      const f = e.target.dataset.f;
      h[f] = f === 'name' ? e.target.value : e.target.value === '' ? '' : Number(e.target.value);
      if (f === 'score') tr.querySelectorAll('.mark').forEach((m) => m.classList.toggle('on', Number(m.dataset.v) === h.score));
      save(); renderAnalysis();
    });
    tb.addEventListener('click', (e) => {
      const tr = e.target.closest('tr'); if (!tr) return;
      const i = Number(tr.dataset.i);
      if (e.target.classList.contains('mark')) {
        const v = Number(e.target.dataset.v);
        d().horses[i].score = d().horses[i].score === v ? 50 : v;
        save(); renderHorses();
      } else if (e.target.dataset.act === 'del') {
        d().horses.splice(i, 1); save(); renderHorses();
      }
    });

    $('p-combo-type').innerHTML = Object.entries(COMBO_TO_BET)
      .map(([k, v]) => `<button data-k="${k}">${v}</button>`).join('');
    $('p-combo-type').addEventListener('click', (e) => {
      if (!e.target.dataset.k) return;
      d().comboType = e.target.dataset.k; save(); renderAnalysis();
    });
    $('p-combos').addEventListener('input', (e) => {
      if (e.target.dataset.f !== 'odds') return;
      const tr = e.target.closest('tr');
      const p = Number(tr.dataset.p);
      const o = Number(e.target.value);
      const cell = tr.querySelector('.ev');
      const ev = o > 0 ? p * o : null;
      cell.textContent = ev ? ev.toFixed(2) : '-';
      cell.className = 'num ev ' + (ev && ev >= d().minev / 100 ? 'pos' : ev ? 'neg' : '');
    });
    $('p-combos').addEventListener('click', (e) => {
      if (e.target.dataset.act !== 'rec') return;
      const tr = e.target.closest('tr');
      const o = Number(tr.querySelector('input').value);
      const p = Number(tr.dataset.p);
      prefillBet({ type: COMBO_TO_BET[d().comboType], sel: tr.dataset.sel, ev: o > 0 ? p * o : '' });
    });
    $('p-result').addEventListener('click', (e) => {
      if (e.target.dataset.act !== 'rec') return;
      const tr = e.target.closest('tr');
      prefillBet({ type: '単勝', sel: tr.dataset.no, ev: Number(tr.dataset.ev), stake: Number(tr.dataset.bet) || '' });
    });
    renderHorses();
  }

  function renderHorses() {
    const rows = d().horses.map((h, i) => `
      <tr data-i="${i}">
        <td><input type="number" data-f="no" value="${esc(h.no)}" min="1" max="18" /></td>
        <td><input type="text" data-f="name" value="${esc(h.name)}" placeholder="馬名" /></td>
        <td><input type="number" data-f="odds" value="${esc(h.odds)}" step="0.1" min="1" placeholder="例 5.4" /></td>
        <td><div class="marks">${MARKS.map(([m, v]) => `<button class="btn mark ${h.score === v ? 'on' : ''}" data-v="${v}" title="スコア${v}">${m}</button>`).join('')}</div></td>
        <td><input type="number" data-f="score" value="${esc(h.score)}" min="0" max="100" /></td>
        <td><button class="btn small ghost" data-act="del" title="削除">✕</button></td>
      </tr>`).join('');
    $('p-horses').innerHTML = rows || '<tr><td colspan="6" class="empty">「＋ 馬を追加」か「一括入力」で出走馬を登録</td></tr>';
    renderAnalysis();
  }

  function renderAnalysis() {
    $('o-weight').textContent = d().weight + '%';
    $('o-temp').textContent = d().temp;
    $('o-minev').textContent = (d().minev / 100).toFixed(2);
    document.querySelectorAll('#p-combo-type button').forEach((b) => b.classList.toggle('on', b.dataset.k === d().comboType));

    const horses = d().horses
      .map((h) => ({ no: h.no, name: h.name, odds: Number(h.odds), score: Number(h.score) || 0 }))
      .filter((h) => h.odds > 1);
    if (horses.length < 2) {
      $('p-result').innerHTML = '<tr><td colspan="10" class="empty">オッズ入力済みの馬が2頭以上になると分析します</td></tr>';
      $('p-combos').innerHTML = '';
      $('p-overround').textContent = '';
      return;
    }
    const st = state.settings;
    const res = M.analyze(horses, { weight: d().weight / 100, temperature: d().temp, bankroll: st.bankroll, kellyFraction: st.kelly });
    const minEv = d().minev / 100;
    $('p-overround').textContent = `オッズから見た控除率 ${pct(res.overround)}（JRA単勝の規定は20%）`;

    $('p-result').innerHTML = res.rows
      .slice().sort((a, b) => b.ev - a.ev)
      .map((r) => {
        const buy = r.ev >= minEv;
        const bet = Math.min(r.kellyBet, st.cap || Infinity);
        return `<tr class="${buy ? 'buy' : ''}" data-no="${esc(r.no)}" data-ev="${r.ev.toFixed(2)}" data-bet="${buy ? bet : 0}">
          <td>${esc(r.no)}</td><td>${esc(r.name)}</td>
          <td class="num">${r.odds.toFixed(1)}</td>
          <td class="num">${pct(r.pMarket)}</td>
          <td class="num">${pct(r.pModel)}</td>
          <td class="num"><b>${pct(r.p)}</b></td>
          <td class="num ${buy ? 'pos' : r.ev < 1 ? 'neg' : ''}"><b>${r.ev.toFixed(2)}</b> ${buy ? '<span class="tag buy">買い</span>' : ''}</td>
          <td class="num">${pct(r.pPlace)}</td>
          <td class="num">${buy && bet > 0 ? yen(bet) : '-'}</td>
          <td><button class="btn small" data-act="rec">記録へ</button></td>
        </tr>`;
      }).join('');

    const list = res.combos[d().comboType].slice(0, 20);
    $('p-combos').innerHTML = list.map((c) => {
      const sep = d().comboType === 'exacta' || d().comboType === 'trifecta' ? '→' : '-';
      const sel = c.nos.join(sep);
      return `<tr data-p="${c.p}" data-sel="${esc(sel)}">
        <td><b>${esc(sel)}</b></td>
        <td class="num">${pct(c.p, 2)}</td>
        <td class="num">${c.fairOdds.toFixed(1)}</td>
        <td class="num">${(c.fairOdds * minEv).toFixed(1)}倍〜</td>
        <td><input type="number" data-f="odds" step="0.1" min="1" style="width:80px" placeholder="実オッズ" /></td>
        <td class="num ev">-</td>
        <td><button class="btn small" data-act="rec">記録へ</button></td>
      </tr>`;
    }).join('');
  }

  // =====================================================
  // 馬券記録
  // =====================================================
  function initLog() {
    fillSelect($('b-venue'), VENUES, true);
    fillSelect($('b-type'), BET_TYPES);
    resetForm();
    $('b-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const id = $('b-id').value;
      const payoutRaw = $('b-payout').value;
      const bet = {
        id: id || uid(),
        createdAt: id ? (state.bets.find((b) => b.id === id) || {}).createdAt || Date.now() : Date.now(),
        date: $('b-date').value,
        venue: $('b-venue').value,
        race: $('b-race').value ? Number($('b-race').value) : '',
        name: $('b-name').value.trim(),
        type: $('b-type').value,
        sel: $('b-sel').value.trim(),
        stake: Number($('b-stake').value),
        payout: payoutRaw === '' ? null : Number(payoutRaw),
        conf: $('b-conf').value,
        ev: $('b-ev').value === '' ? '' : Number($('b-ev').value),
        memo: $('b-memo').value.trim(),
      };
      if (id) state.bets = state.bets.map((b) => (b.id === id ? bet : b));
      else state.bets.push(bet);
      save(); resetForm(); renderLog();
      toast(id ? '更新しました' : '記録しました');
    });
    $('b-cancel').addEventListener('click', resetForm);
    $('b-search').addEventListener('input', renderLog);
    $('b-filter').addEventListener('change', renderLog);
    $('b-list').addEventListener('click', (e) => {
      const tr = e.target.closest('tr'); if (!tr) return;
      const b = state.bets.find((x) => x.id === tr.dataset.id); if (!b) return;
      if (e.target.dataset.act === 'edit') editBet(b);
      if (e.target.dataset.act === 'del' && confirm('この記録を削除しますか？')) {
        state.bets = state.bets.filter((x) => x.id !== b.id); save(); renderLog();
      }
      if (e.target.dataset.act === 'miss') { b.payout = 0; save(); renderLog(); }
    });
  }

  function resetForm() {
    $('b-form').reset();
    $('b-id').value = '';
    $('b-date').value = d().date || today();
    $('b-form-title').textContent = '馬券を記録';
    $('b-submit').textContent = '記録する';
  }

  function editBet(b) {
    $('b-id').value = b.id;
    $('b-date').value = b.date; $('b-venue').value = b.venue || ''; $('b-race').value = b.race || '';
    $('b-name').value = b.name || ''; $('b-type').value = b.type; $('b-sel').value = b.sel;
    $('b-stake').value = b.stake; $('b-payout').value = b.payout ?? '';
    $('b-conf').value = b.conf || ''; $('b-ev').value = b.ev ?? ''; $('b-memo').value = b.memo || '';
    $('b-form-title').textContent = '記録を編集';
    $('b-submit').textContent = '更新する';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function prefillBet({ type, sel, ev, stake }) {
    resetForm();
    $('b-date').value = d().date; $('b-venue').value = d().venue; $('b-race').value = d().race;
    $('b-name').value = d().name; $('b-type').value = type; $('b-sel').value = sel;
    $('b-ev').value = ev ? Number(ev).toFixed(2) : '';
    $('b-stake').value = stake || '';
    document.querySelector('.tab[data-tab="log"]').click();
    $('b-stake').focus();
  }

  function renderLog() {
    const q = $('b-search').value.trim().toLowerCase();
    const f = $('b-filter').value;
    const list = state.bets
      .filter((b) => !q || [b.name, b.sel, b.memo, b.venue, b.type].join(' ').toLowerCase().includes(q))
      .filter((b) => f === 'all' || (f === 'pending' ? !S.isSettled(b) : Number(b.payout) > 0))
      .sort((a, b) => -S.byDate(a, b));
    $('b-list').innerHTML = list.map((b) => {
      const settled = S.isSettled(b);
      const pl = settled ? b.payout - b.stake : null;
      return `<tr data-id="${esc(b.id)}">
        <td>${esc(b.date)}</td>
        <td>${esc(b.venue)}${b.race ? esc(b.race) + 'R' : ''} ${esc(b.name)}</td>
        <td>${esc(b.type)}</td><td><b>${esc(b.sel)}</b></td>
        <td class="num">${yen(b.stake)}</td>
        <td class="num">${settled ? yen(b.payout) : '<span class="tag pending">未確定</span>'}</td>
        <td class="num ${signCls(pl)}">${settled ? yen(pl) : '-'}</td>
        <td>${esc(b.conf)}</td><td class="num">${b.ev ? Number(b.ev).toFixed(2) : ''}</td>
        <td class="memo">${esc(b.memo)}</td>
        <td><div class="btn-row">
          ${settled ? '' : '<button class="btn small" data-act="miss" title="払戻0円で確定">ハズレ</button>'}
          <button class="btn small" data-act="edit">編集</button>
          <button class="btn small ghost" data-act="del">✕</button></div></td>
      </tr>`;
    }).join('') || '<tr><td colspan="11" class="empty">記録がありません</td></tr>';
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

  // ---------- 起動 ----------
  initPredict();
  initLog();
  initSettings();
  renderLog();
})();
