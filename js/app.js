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
      raceId: '', comboOdds: {}, horseInfo: {}, trend: null,
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
    $('p-ability').addEventListener('click', applyAbility);
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

  function starsHtml(n) {
    if (!n) return '<span class="hint" title="過去走なし">-</span>';
    return `<span class="stars">${'★'.repeat(n)}<span class="off">${'★'.repeat(5 - n)}</span></span>`;
  }
  function recentHtml(list) {
    if (!list || !list.length) return '<span class="hint">初出走</span>';
    return `<span class="recent">${list.map((p) => (p == null ? '止' : p <= 3 ? `<b>${p}</b>` : p)).join('-')}</span>`;
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
    return t.bestStyle.startsWith(style[0]) ? 'style-good' : '';
  }

  function renderHorses() {
    const info = d().horseInfo || {};
    const rows = d().horses.map((h, i) => {
      const x = info[h.no] || {};
      const tip = (x.runs || []).map((r) => `${r.date} ${r.venue} ${r.race}(${r.class}) ${r.surface}${r.distance || ''} ${r.place ?? '中止'}着 ${r.margin != null ? r.margin + '秒差' : ''}`).join('\n');
      return `
      <tr data-i="${i}">
        <td><input type="number" data-f="no" value="${esc(h.no)}" min="1" max="18" /></td>
        <td>${x.waku ? `<span class="waku ${wakuClass(x.waku)}" title="過去10年の傾向で色付け">${x.waku}</span>` : ''}</td>
        <td><input type="text" data-f="name" value="${esc(h.name)}" placeholder="馬名" /></td>
        <td title="${esc(tip)}">${x.rating !== undefined ? starsHtml(x.stars) + (x.rating ? `<span class="rating">${x.rating}</span>` : '') : ''}</td>
        <td title="${esc(tip)}">${x.rating !== undefined ? recentHtml(x.recent) : ''}</td>
        <td class="${styleClass(x.style)}">${esc(x.style || '')}</td>
        <td><input type="number" data-f="odds" value="${esc(h.odds)}" step="0.1" min="1" placeholder="例 5.4" /></td>
        <td><div class="marks">${MARKS.map(([m, v]) => `<button class="btn mark ${h.score === v ? 'on' : ''}" data-v="${v}" title="スコア${v}">${m}</button>`).join('')}</div></td>
        <td><input type="number" data-f="score" value="${esc(h.score)}" min="0" max="100" /></td>
        <td><button class="btn small ghost" data-act="del" title="削除">✕</button></td>
      </tr>`;
    }).join('');
    $('p-horses').innerHTML = rows || '<tr><td colspan="10" class="empty">「＋ 馬を追加」か「一括入力」、またはオッズ自動取得で出走馬を登録</td></tr>';
    renderAnalysis();
  }

  /** 能力値 → スコア(0〜100)。メンバー内の偏差で換算 */
  function applyAbility() {
    const info = d().horseInfo || {};
    const vals = d().horses.map((h) => (info[h.no] || {}).rating).filter((v) => v != null);
    if (vals.length < 2) { toast('先にオッズ取得で能力値を読み込んでください'); return; }
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
    d().horses.forEach((h) => {
      const r = (info[h.no] || {}).rating;
      h.score = r == null ? 45 : Math.round(Math.max(10, Math.min(95, 50 + ((r - mean) / sd) * 15)));
    });
    save(); renderHorses();
    toast('能力値をスコアに反映しました（印で微調整できます）');
  }

  // ---------- レース傾向 ----------
  function renderTrend() {
    const box = $('t-body');
    const data = d().trend;
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

  function renderAnalysis() {
    $('o-weight').textContent = d().weight + '%';
    $('o-temp').textContent = d().temp;
    $('o-minev').textContent = (d().minev / 100).toFixed(2);
    document.querySelectorAll('#p-combo-type button').forEach((b) => b.classList.toggle('on', b.dataset.k === d().comboType));
    document.querySelectorAll('#p-combo-sort button').forEach((b) => b.classList.toggle('on', b.dataset.s === (d().comboSort || 'p')));

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

    const type = d().comboType;
    const ordered = type === 'exacta' || type === 'trifecta';
    const rawOdds = (d().comboOdds || {})[type];
    const real = rawOdds && rawOdds.__rid === d().raceId ? rawOdds : null;
    let list = res.combos[type].map((c) => {
      const nos = ordered ? c.nos : c.nos.slice().sort((a, b) => a - b);
      const o = real ? real[nos.join('-')] : undefined;
      return { ...c, nos, real: o, ev: o ? c.p * o : null };
    });
    if (d().comboSort === 'ev') {
      list = list.filter((c) => c.ev !== null).sort((a, b) => b.ev - a.ev);
    }
    list = list.slice(0, 20);
    if (!list.length) {
      $('p-combos').innerHTML = '<tr><td colspan="7" class="empty">EV順は実オッズの取得後に使えます</td></tr>';
      return;
    }
    $('p-combos').innerHTML = list.map((c) => {
      const sel = c.nos.join(ordered ? '→' : '-');
      const evCls = c.ev === null ? '' : c.ev >= minEv ? 'pos' : 'neg';
      return `<tr data-p="${c.p}" data-sel="${esc(sel)}" class="${c.ev !== null && c.ev >= minEv ? 'buy' : ''}">
        <td><b>${esc(sel)}</b></td>
        <td class="num">${pct(c.p, 2)}</td>
        <td class="num">${c.fairOdds.toFixed(1)}</td>
        <td class="num">${(c.fairOdds * minEv).toFixed(1)}倍〜</td>
        <td><input type="number" data-f="odds" step="0.1" min="1" style="width:80px" placeholder="実オッズ" value="${c.real || ''}" /></td>
        <td class="num ev ${evCls}">${c.ev !== null ? c.ev.toFixed(2) : '-'}</td>
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
        ['f-list', 'f-fetch', 'f-race', 'f-auto', 't-load'].forEach((id) => { $(id).disabled = true; });
        $('f-hint').innerHTML = '自動取得を使うには、ターミナルで <code>python3 server.py</code> を実行し <b>http://localhost:8765</b> を開いてください。';
        return;
      }
      api('/api/ping').then((r) => status(r.provider === 'MockProvider' ? 'モックデータで接続中' : '接続OK', 'ok'))
        .catch(() => status('サーバーに接続できません', 'err'));
      $('f-list').addEventListener('click', listRaces);
      $('t-load').addEventListener('click', trend);
      $('f-fetch').addEventListener('click', () => win(true));
      $('f-auto').addEventListener('change', (e) => {
        clearInterval(timer);
        if (e.target.checked) timer = setInterval(() => { win(false).then(() => combos(false)); }, 60000);
      });
      if (d().raceId) {
        $('f-race').innerHTML = `<option value="${esc(d().raceId)}">${esc(d().venue)}${esc(d().race)}R ${esc(d().name)}</option>`;
      }
    }

    async function listRaces() {
      status('レース一覧を取得中…');
      try {
        const { races } = await api(`/api/races?date=${ymd()}`);
        if (!races.length) { status('この日のJRA開催はありません', 'err'); return; }
        $('f-race').innerHTML = races.map((r) =>
          `<option value="${esc(r.race_id)}">${esc(r.venue)} ${r.race}R ${esc(r.name)}</option>`).join('');
        if (races.some((r) => r.race_id === d().raceId)) $('f-race').value = d().raceId;
        status(`${races.length}レース`, 'ok');
      } catch (e) { status('一覧の取得失敗: ' + e.message, 'err'); }
    }

    async function win(manual) {
      const rid = $('f-race').value;
      if (!rid) { if (manual) toast('レースを選んでください'); return; }
      status('オッズを取得中…');
      try {
        const r = await api(`/api/odds?race_id=${rid}&type=win`);
        const prev = new Map(d().horses.map((h) => [Number(h.no), h]));
        if (rid !== d().raceId) { d().comboOdds = {}; d().horseInfo = {}; d().trend = null; prev.clear(); }
        d().horses = r.horses.filter((h) => h.odds).map((h) => ({
          no: h.no,
          name: h.name || (prev.get(h.no) || {}).name || '',
          odds: h.odds,
          score: (prev.get(h.no) || {}).score ?? 50,
        }));
        const scratched = r.horses.filter((h) => !h.odds).map((h) => h.no);
        Object.assign(d(), { raceId: rid, venue: r.venue, race: r.race, name: r.name || d().name, date: $('f-date').value });
        $('p-venue').value = r.venue; $('p-race').value = r.race; $('p-name').value = d().name; $('p-date').value = d().date;
        save(); renderHorses();
        status(`単勝 ${r.updated || ''} 時点${scratched.length ? ` / 取消・オッズなし: ${scratched.join(',')}番` : ''}`, 'ok');
        if (manual) { combos(true); horses().then(() => trend()); }
      } catch (e) { status('取得失敗: ' + e.message, 'err'); }
    }

    async function combos(force) {
      const rid = d().raceId;
      if (!rid || location.protocol === 'file:') return;
      const type = d().comboType;
      if (!force && d().comboOdds[type] && d().comboOdds[type].__rid === rid && Date.now() - d().comboOdds[type].__at < 60000) return;
      try {
        const r = await api(`/api/odds?race_id=${rid}&type=${type}`);
        d().comboOdds[type] = { ...r.odds, __rid: rid, __at: Date.now() };
        save();
        if (d().comboType === type) renderAnalysis();
      } catch (e) { status(`${COMBO_TO_BET[type]}オッズの取得失敗: ${e.message}`, 'err'); }
    }
    async function horses() {
      const rid = d().raceId; if (!rid) return;
      try {
        const r = await api(`/api/horses?race_id=${rid}&date=${(d().date || today()).replace(/-/g, "")}`);
        d().horseInfo = Object.fromEntries(r.horses.map((h) => [h.no, h]));
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
        ${W.map((w) => `<tr><th>${w * 100}%${w === 0 ? '（オッズのみ）' : ''}</th>${E.map((e) => {
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

  // ---------- 起動 ----------
  initPredict();
  Fetch.init();
  renderTrend();
  Backtest.init();
  initLog();
  initSettings();
  renderLog();
})();
