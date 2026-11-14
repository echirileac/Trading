// Edison Growth: layout extras on top of the shared page code (app.js).
// app.js fills every element by id exactly as on Classic; this file adds the views (Markets, Market, Alerts, Track record),
// the detail tabs, the Plan a trade drawer, the market tiles, the all-markets alert feed and a few summaries.
// It reads data only through window.MW, never changes the data files, and keeps its own settings under 'eg-*' keys.
(() => {
  const MW = window.MW;
  if (!MW) return;
  const $ = (id) => document.getElementById(id);
  const get = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } };
  const put = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
  const el = (tag, attrs = {}, text) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };
  const svgIcon = (inner, cls) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); if (cls) s.setAttribute('class', cls); s.innerHTML = inner; return s; };
  const BELL_OFF = '<path d="M6 16v-5a6 6 0 0 1 9-5.2M18 11v5l2 2H8"/><path d="M10 21h4M3 3l18 18"/>';
  let S = MW.state();
  const nameOf = (m) => (!m ? '' : m.id === 'NATGAS' ? 'NATGAS' : m.name || m.id);
  const dirOf = (x) => (x > 0.15 ? 1 : x < -0.15 ? -1 : 0);

  // ---------- views ----------
  const VIEWS = ['markets', 'market', 'alerts', 'record'];
  function setView(v, opts = {}) {
    if (!VIEWS.includes(v)) v = 'market';
    const was = document.body.dataset.view;
    document.body.dataset.view = v; put('eg-view', v);
    document.querySelectorAll('.eg-nav button').forEach((b) => { if (b.dataset.go === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    if (v === 'alerts') loadFeed();
    if (v === 'markets') syncMarketsView();
    if (v !== 'market') closeDrawer(false);
    if (was !== v) {
      if (v === 'market' || v === 'record') requestAnimationFrame(() => MW.render()); // charts and sparklines measured while hidden need a redraw
      if (!opts.keepScroll) window.scrollTo({ top: 0 });
      if (opts.focus) { const h = document.querySelector(`.eg-view[data-view="${v}"] h1`) || document.querySelector(`.eg-view[data-view="${v}"] h2, .eg-view[data-view="${v}"] .sym`); if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); } }
    }
  }
  document.querySelectorAll('.eg-nav button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.go, { focus: true })));

  // ---------- detail tabs (News, Timeframes, Key levels, Events, Sources, Method) ----------
  const tabs = [...document.querySelectorAll('.eg-tablist [role="tab"]')];
  function setTab(t, focus) {
    let b = tabs.find((x) => x.dataset.tab === t && !x.hidden) || tabs.find((x) => !x.hidden);
    tabs.forEach((x) => { const on = x === b; x.setAttribute('aria-selected', String(on)); x.tabIndex = on ? 0 : -1; $(x.getAttribute('aria-controls')).hidden = !on; });
    put('eg-tab', b.dataset.tab);
    if (focus) b.focus();
  }
  tabs.forEach((b, i) => {
    b.addEventListener('click', () => setTab(b.dataset.tab));
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const vis = tabs.filter((x) => !x.hidden), k = vis.indexOf(b);
      setTab(vis[(k + (e.key === 'ArrowRight' ? 1 : vis.length - 1)) % vis.length].dataset.tab, true);
    });
  });
  // "Patterns and hit rates" in the timeframes card jumps to the Timeframes tab (app.js then scrolls to it)
  document.addEventListener('click', (e) => { if (e.target.closest('a[href="#tf-card"]')) { setView('market', { keepScroll: true }); setTab('tf'); } }, true);

  // ---------- small helpers for the market view ----------
  function dimPrice(node) {
    const t = node.textContent;
    if (node.querySelector('.dim') || !/\.\d{2,}$/.test(t)) return;
    node.replaceChildren(document.createTextNode(t.slice(0, -2)), el('span', { class: 'dim' }, t.slice(-2)));
  }
  const whenOf = (e) => {
    const t = e.at ? Date.parse(e.at) : Date.parse(e.date + 'T12:00:00Z');
    const day = e.allDay || !e.at ? MW.dayName(e.date) : new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const dd = Math.round((new Date(new Date(t).toDateString()) - new Date(new Date().toDateString())) / 864e5);
    const rel = dd <= 0 ? (e.at && t > Date.now() && t - Date.now() < 36e5 * 12 ? `in ${Math.max(1, Math.round((t - Date.now()) / 36e5))} h` : 'today') : dd === 1 ? 'tomorrow' : `in ${dd} days`;
    return `${day} · ${rel}`;
  };
  function nextEvent(D) {
    const now = Date.now();
    const evs = (D.events || []).filter((e) => (e.at ? Date.parse(e.at) : Date.parse(e.date + 'T23:59:59Z')) >= now)
      .sort((a, b) => (a.at || a.date) < (b.at || b.date) ? -1 : 1);
    if (evs[0]) return { name: evs[0].name.replace(/ \(expected date\)/, ''), when: whenOf(evs[0]) };
    const ed = D.meta && D.meta.earnings && D.meta.earnings.date;
    if (ed && Date.parse(ed + 'T23:59:59Z') >= now) return { name: 'Earnings report', when: whenOf({ date: ed, allDay: true }) };
    return null;
  }
  function drawEvent(D) {
    const ev = nextEvent(D);
    $('eg-event').hidden = !ev;
    if (ev) { $('eg-event-n').textContent = ev.name; $('eg-event-w').textContent = ev.when; }
  }
  function drawLadder(D, H) {
    const box = $('eg-ladder'), h = D.forecast && D.forecast.horizons && D.forecast.horizons[H];
    box.replaceChildren();
    if (!h || h.lo90 == null || h.hi90 == null) return;
    const lo = h.lo90, hi = h.hi90, last = D.price.last;
    const x = (v) => Math.max(1, Math.min(99, 8 + 84 * (v - lo) / Math.max(1e-9, hi - lo)));
    const bar = (cls, a, b) => { const d = el('div', { class: cls }); d.style.left = x(a) + '%'; d.style.width = (x(b) - x(a)) + '%'; return d; };
    const at = (cls, v) => { const d = el('div', { class: cls }); d.style.left = x(v) + '%'; return d; };
    const lb = (v, txt, extra) => { const d = el('div', { class: 'lb ' + (extra || '') }, txt); d.style.left = x(v) + '%'; return d; };
    box.append(el('div', { class: 't' }), bar('w', lo, hi), bar('l', h.lo68, h.hi68), at('c', h.center), at('n', last),
      lb(lo, MW.usd(lo), 'e0'), lb(hi, MW.usd(hi), 'e1'), lb((lo + hi) / 2, `now ${MW.usd(last)} · centre ${MW.usd(h.center)}`));
    box.querySelector('.lb.e0').style.left = '8%'; box.querySelector('.lb.e1').style.left = '92%';
  }
  function drawEdge(D, H) {
    const bt = D.track && D.track.backtest && D.track.backtest[H], lv = D.track && D.track.live && D.track.live[H];
    const p = $('eg-edge');
    const parts = [];
    if (bt && bt.dirN >= 20) parts.push(`in the backtest ${Math.round(100 * bt.dirHit / bt.dirN)}% of ${bt.dirN}`);
    if (lv && lv.dirN >= 20) parts.push(`published ${Math.round(100 * lv.dirHit / lv.dirN)}% of ${lv.dirN}`);
    p.textContent = parts.length
      ? `The lean pointed the right way ${parts.join(', ')} (50% is a coin flip). The ranges are the tested part: treat the lean as context.`
      : 'Too few scored forecasts to judge the lean yet: treat it as context. The ranges are the tested part.';
  }
  function drawDisagree(D) {
    const f = D.forecast || {}, out = [], dirs = new Set();
    const m = dirOf(f.score);
    dirs.add(m); out.push(m > 0 ? 'Model leans up' : m < 0 ? 'Model leans down' : 'Model neutral');
    const a = D.ai && D.ai.stance && D.ai.status !== 'off' && D.ai.status !== 'pending' && D.ai.status !== 'error' ? D.ai.stance : null;
    if (a) { const d = a === 'bullish' ? 1 : a === 'bearish' ? -1 : 0; dirs.add(d); out.push(`AI analyst ${a}`); }
    const v = D.mtf && D.mtf.verdict;
    if (v && v.title) { const d = Math.sign(v.dir || 0); dirs.add(d); out.push(`timeframes: ${v.title.charAt(0).toLowerCase() + v.title.slice(1)}`); }
    const show = dirs.size > 1 && out.length > 1;
    $('eg-disagree').hidden = !show;
    if (show) $('eg-disagree-t').textContent = out.join(' · ');
  }
  function drawPulse(D) {
    const p = $('eg-pulse'), t = $('eg-pulse-t');
    if (!D || !D.generatedAt) { p.className = 'eg-pulse'; t.textContent = 'No data yet'; return; }
    const age = (Date.now() - Date.parse(D.generatedAt)) / 60000;
    const stale = age > 15 || (D.price && D.price.stale);
    p.className = 'eg-pulse ' + (stale ? 'stale' : D.market === 'open' ? 'live' : '');
    const mk = D.market === 'open' ? 'Live' : D.market === 'break' ? 'Daily break' : 'Market closed';
    t.textContent = `${stale ? 'Data ' + Math.round(age) + ' min old' : mk + ' · ' + MW.ago(D.generatedAt)}`;
    p.title = $('status').textContent;
  }
  setInterval(() => drawPulse(S.DATA), 15000);

  // ---------- AI analyst: short by default, full note on request ----------
  $('eg-why').addEventListener('click', () => {
    const c = $('ai-card'), on = !c.classList.contains('full');
    c.classList.toggle('full', on);
    $('eg-why').setAttribute('aria-expanded', String(on));
    $('eg-why').textContent = on ? 'Show less' : 'Why? Read the full note';
  });

  // ---------- news filter ----------
  let NEWS_F = get('eg-newsf', 'all');
  function drawNewsFilter() {
    const lis = [...$('news').children];
    const kind = (li) => { const c = li.querySelector('.chip'); if (!c) return 'neutral'; if (li.classList.contains('off')) return 'off'; return c.classList.contains('up') ? 'bull' : c.classList.contains('down') ? 'bear' : 'neutral'; };
    const n = { all: lis.length, bull: 0, bear: 0, neutral: 0, off: 0 };
    lis.forEach((li) => { n[kind(li)]++; });
    const opts = [['all', 'All'], ['bull', '▲ Bullish'], ['bear', '▼ Bearish'], ['neutral', 'Neutral'], ['off', 'Not about this market']];
    if (!n[NEWS_F] && NEWS_F !== 'all') NEWS_F = 'all';
    const box = $('eg-news-f'); box.replaceChildren();
    for (const [k, label] of opts) {
      if (k !== 'all' && !n[k]) continue;
      const b = el('button', { type: 'button', 'aria-pressed': String(k === NEWS_F) }, `${label} ${n[k]}`);
      b.addEventListener('click', () => { NEWS_F = k; put('eg-newsf', k); drawNewsFilter(); });
      box.append(b);
    }
    lis.forEach((li) => { li.hidden = NEWS_F !== 'all' && kind(li) !== NEWS_F; });
    box.hidden = lis.length < 2;
  }

  // ---------- track record: counts instead of percentages while the published sample is small ----------
  function drawTrackSmall(D, H) {
    const L = D.track && D.track.live && D.track.live[H], note = $('eg-tr-small');
    note.hidden = true;
    const meta = D.meta || { id: 'NATGAS' };
    $('eg-tr-sub').textContent = `${nameOf(meta)} · how the ${H}-day forecast has done.`;
    if (!L || !L.n || L.n >= 20) return;
    const rows = [...$('track-stats').querySelectorAll('tr')].slice(1);
    const vals = [[L.dirHit, L.dirN], [L.in68, L.n], [L.in90, L.n]];
    vals.forEach(([a, b], i) => { const cell = rows[i] && rows[i].children[1]; const bb = cell && cell.querySelector('b'); if (bb && b) { bb.textContent = `${a} of ${b}`; bb.className = 'small-n'; } });
    note.hidden = false;
    note.textContent = `Only ${L.n} published forecast${L.n > 1 ? 's have' : ' has'} been scored for ${H} day${H > 1 ? 's' : ''}, so the Published column shows counts. Percentages appear after 20; until then the Backtest column is the better guide.`;
  }

  // ---------- Plan a trade drawer ----------
  const drawer = $('eg-drawer'), planBtn = $('eg-plan');
  function openDrawer() {
    drawer.hidden = false; planBtn.setAttribute('aria-expanded', 'true');
    drawer.focus();
    syncDrawer(); drawLines();
  }
  function closeDrawer(focusBack = true) {
    if (drawer.hidden) return;
    drawer.hidden = true; planBtn.setAttribute('aria-expanded', 'false');
    drawLines();
    if (focusBack) planBtn.focus();
  }
  planBtn.addEventListener('click', () => (drawer.hidden ? openDrawer() : closeDrawer()));
  $('eg-drawer-x').addEventListener('click', () => closeDrawer());
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('search').classList.contains('open')) { $('search').classList.remove('open'); return; }
    if (!drawer.hidden) closeDrawer();
  });
  function syncDrawer() {
    const D = S.DATA, meta = (D && D.meta) || { id: S.CUR_ID };
    $('eg-drawer-sub').textContent = `${nameOf(meta)} · XTB · inputs stay in this browser`;
    const n = $('eg-drawer-chart'); n.replaceChildren();
    if (MW.chartView() === 'live') {
      n.append(document.createTextNode('Entry, stop and target are drawn on the Forecast view of the chart. '));
      const b = el('button', { type: 'button', class: 'btn' }, 'Show them on the chart');
      b.addEventListener('click', () => { const v = document.querySelector('#pc-view [data-v="forecast"]'); if (v) v.click(); syncDrawer(); $('pc-card').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
      n.append(b);
    } else n.textContent = 'Entry, stop and target are drawn on the chart while this panel is open.';
  }
  drawer.addEventListener('input', () => setTimeout(drawLines, 0));
  drawer.addEventListener('change', () => setTimeout(drawLines, 0));
  drawer.addEventListener('click', () => setTimeout(drawLines, 0));
  document.querySelectorAll('#pc-view button').forEach((b) => b.addEventListener('click', () => setTimeout(() => { if (!drawer.hidden) syncDrawer(); drawLines(true); }, 0)));
  let LINES_KEY = '';
  function drawLines(force) {
    const D = S.DATA;
    let arr = [];
    if (D && D.price && D.price.last != null) {
      const last = D.price.last;
      if (!drawer.hidden) {
        const num = (id) => { const v = parseFloat(($(id).textContent || '').replace(/[^0-9.]/g, '')); return isFinite(v) && v > 0 ? v : null; };
        const entry = Number($('rk-entry').value) || last, stop = num('rk-stop-out'), tgt = num('rk-tgt-out');
        arr.push({ price: entry, color: '--accent', title: 'Entry', solid: true, width: 2 });
        if (stop) arr.push({ price: stop, color: '--down', title: 'Stop', width: 2 });
        if (tgt) arr.push({ price: tgt, color: '--up', title: 'Target', width: 2 });
      } else {
        const lv = (D.forecast && D.forecast.levels) || [];
        const above = lv.filter((l) => l.price > last).sort((a, b) => a.price - b.price).slice(0, 2);
        const below = lv.filter((l) => l.price < last).sort((a, b) => b.price - a.price).slice(0, 2);
        arr = [...above, ...below].map((l) => ({ price: l.price, color: '--muted', title: l.label }));
      }
    }
    const key = JSON.stringify(arr);
    if (key === LINES_KEY && !force) return;
    LINES_KEY = key; MW.setLines(arr);
  }

  // ---------- markets view: tiles + table ----------
  let MV = get('eg-mv', 'tiles') === 'table' ? 'table' : 'tiles';
  function syncMarketsView() {
    document.querySelectorAll('.eg-seg [data-mv]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mv === MV)));
    $('eg-tiles').hidden = MV !== 'tiles';
    $('ov').hidden = MV !== 'table';
    if (MV === 'table' && !$('ov').open) {
      // open the table without changing Classic's remembered open/closed state for it
      let prev = null; try { prev = localStorage.getItem('ov-open'); } catch { /* none */ }
      $('ov').open = true;
      setTimeout(() => { try { if (prev == null) localStorage.removeItem('ov-open'); else localStorage.setItem('ov-open', prev); } catch { /* ignore */ } }, 60);
    }
  }
  document.querySelectorAll('.eg-seg [data-mv]').forEach((b) => b.addEventListener('click', () => { MV = b.dataset.mv; put('eg-mv', MV); syncMarketsView(); }));
  $('eg-add').addEventListener('click', () => MW.openSearch());
  function drawTiles() {
    const I = S.INDEX; if (!I || !I.markets) return;
    const H = S.H, box = $('eg-tiles'); box.replaceChildren();
    const arrow = (c) => el('span', { class: c === 'u' ? 'up' : c === 'd' ? 'down' : 'flat' }, c === 'u' ? '▲' : c === 'd' ? '▼' : c === 's' ? '◆' : '·');
    for (const m of I.markets) {
      const b = el('button', { type: 'button', class: 'eg-tile', 'aria-current': String(m.id === S.CUR_ID) });
      const dec = m.decimals != null ? m.decimals : 3;
      const t1 = el('div', { class: 't1' }), nm = el('div');
      nm.append(el('div', { class: 'nm' }, nameOf(m)), el('div', { class: 'sb' }, `${m.id === 'NATGAS' ? 'Henry Hub' : [m.symbol, m.exchange].filter(Boolean).join(' · ')}${m.market ? ' · ' + (m.market === 'open' ? 'open' : m.market === 'break' ? 'daily break' : 'closed') : ''}`));
      t1.append(nm);
      if (m.tgOff) { const mu = el('span', { class: 'muted', title: 'Telegram alerts off for this market' }); mu.append(svgIcon(BELL_OFF)); mu.append(el('span', { class: 'sr' }, '')); mu.setAttribute('aria-label', 'Telegram off'); t1.append(mu); }
      b.append(t1);
      if (m.last == null) {
        b.append(el('div', { class: 'sb' }, m.error ? 'No data: ' + m.error : 'Preparing: data appears within a few minutes.'));
        b.addEventListener('click', () => { MW.select(m.id); setView('market', { focus: true }); });
        box.append(b); continue;
      }
      const px = el('div', { class: 'px' }), pb = el('b', {}, MW.fmt(m.last, dec)); dimPrice(pb);
      const ch = m.changePct;
      px.append(pb, el('span', { class: ch > 0 ? 'up' : ch < 0 ? 'down' : 'flat' }, ch == null ? '' : `${ch > 0 ? '▲' : ch < 0 ? '▼' : ''} ${Math.abs(ch).toFixed(2)}%`));
      b.append(px);
      const h = m.h && m.h[H];
      if (h && h.lo68 != null) {
        const rg = el('div', { class: 'rg' }), r1 = el('div', { class: 'r1' });
        r1.append(el('span', { class: 'flat' }, `${H}-day likely range`), el('span', {}, `${MW.fmt(h.lo68, dec)} – ${MW.fmt(h.hi68, dec)}`));
        const bar = el('div', { class: 'bar', title: 'Where today\'s price sits inside the likely range' }), dot = el('i');
        dot.style.left = Math.max(2, Math.min(98, 100 * (m.last - h.lo68) / Math.max(1e-9, h.hi68 - h.lo68))) + '%';
        bar.append(dot); rg.append(r1, bar); b.append(rg);
      }
      if (m.tf && m.tf.l) { const tf = el('div', { class: 'tf' }), a = el('span', { class: 'tfa', 'aria-label': '15 minutes, 1 hour, 1 day' }); for (const c of m.tf.l) a.append(arrow(c)); tf.append(a, el('span', { class: 'flat' }, m.tf.title || '')); b.append(tf); }
      const tags = el('div', { class: 'tags' });
      const st = m.ai && m.ai.stance;
      if (st) tags.append(el('span', { class: 'chip ' + (st === 'bullish' ? 'up' : st === 'bearish' ? 'down' : 'flat') }, 'Analyst ' + st));
      const bits = [];
      if (m.rsi != null) bits.push(`RSI ${Math.round(m.rsi)}${m.rsi >= 70 ? ' overbought' : m.rsi <= 30 ? ' oversold' : ''}`);
      if (h && h.pUp != null) bits.push(`lean ${Math.round(100 * h.pUp)}% higher`);
      if (m.ai && ((m.ai.stance === 'bullish' && m.score < -0.15) || (m.ai.stance === 'bearish' && m.score > 0.15))) bits.push('disagrees with model');
      tags.append(el('span', {}, bits.join(' · ')));
      b.append(tags);
      b.append(m.next ? el('div', { class: 'ev' }, `${m.next.name.replace(/ \(expected date\)/, '')} · ${whenOf(m.next)}`) : el('div', { class: 'ev none' }, 'No scheduled release in the next 9 days'));
      b.addEventListener('click', () => { MW.select(m.id); setView('market', { focus: true }); });
      box.append(b);
    }
    const ms = I.markets, open = ms.filter((m) => m.market === 'open').length, off = ms.filter((m) => m.tgOff).length;
    const nx = ms.filter((m) => m.next).sort((a, b) => ((a.next.at || a.next.date) < (b.next.at || b.next.date) ? -1 : 1))[0];
    $('eg-mk-sum').textContent = `${ms.length} market${ms.length > 1 ? 's' : ''} · ${open} open${off ? ` · Telegram off for ${off}` : ''}${nx ? ` · next: ${nx.next.name.replace(/ \(expected date\)/, '')} (${nameOf(nx)}), ${whenOf(nx.next)}` : ''}`;
  }

  // ---------- alerts: one feed for every market ----------
  const AL_TYPES = [['all', 'All'], ['step', 'Price steps'], ['move', 'Big moves'], ['level', 'Levels'], ['flip', 'Model lean'], ['analyst', 'Analyst'], ['event', 'Events']];
  const AL_ICON = { move: '↗', level: '—', flip: '⇄', analyst: 'AI', event: '◷' };
  let AL_F = get('eg-alf', 'all'), AL_M = get('eg-alm', 'all');
  const FEED = { at: 0, rows: null, busy: false, markets: [] };
  async function loadFeed(force) {
    if (FEED.busy) return;
    const I = S.INDEX;
    if (!I || !I.markets) return;
    if (!force && FEED.rows && Date.now() - FEED.at < 60000) { drawFeed(); return; }
    FEED.busy = true;
    const res = await Promise.all(I.markets.map(async (m) => {
      try {
        let d = null;
        try { d = await MW.peek(`data/m/${m.id}.json`); } catch (e) { if (m.id === 'NATGAS') d = await MW.peek('data/latest.json'); else throw e; }
        return { m, A: d && d.alerts };
      } catch { return { m, A: null, fail: true } }
    }));
    FEED.busy = false; FEED.at = Date.now();
    FEED.markets = res;
    FEED.rows = [];
    for (const r of res) for (const x of (r.A && r.A.log) || []) FEED.rows.push({ ...x, id: r.m.id, name: nameOf(r.m) });
    FEED.rows.sort((a, b) => (a.t < b.t ? 1 : -1));
    document.body.classList.toggle('eg-feed-ok', res.some((r) => !r.fail));
    drawFeed(); drawTgList();
  }
  setInterval(() => { if (document.body.dataset.view === 'alerts' && !document.hidden) loadFeed(true); }, 120000);
  // Last 24 hours by default; "Show older" brings back the rest of the 7 days for this visit.
  let FEED_MORE = false;
  function drawFeed() {
    const fbox = $('eg-al-f'); fbox.replaceChildren();
    const all = FEED.rows || [];
    const recent = all.filter((r) => Date.now() - Date.parse(r.t) <= 864e5);
    const rows = FEED_MORE ? all : recent;
    for (const [k, label] of AL_TYPES) {
      const n = k === 'all' ? rows.length : rows.filter((r) => r.type === k).length;
      if (k !== 'all' && !n && k !== AL_F) continue;
      const b = el('button', { type: 'button', 'aria-pressed': String(k === AL_F) }, `${label} ${n}`);
      b.addEventListener('click', () => { AL_F = k; put('eg-alf', k); drawFeed(); });
      fbox.append(b);
    }
    const sel = el('select', { 'aria-label': 'Market', class: 'eg-msel' });
    sel.append(el('option', { value: 'all' }, 'All markets'));
    for (const r of FEED.markets) sel.append(el('option', { value: r.m.id }, nameOf(r.m)));
    sel.value = FEED.markets.some((r) => r.m.id === AL_M) ? AL_M : 'all';
    sel.style.cssText = 'margin-left:auto;background:var(--panel2);color:var(--fg);border:1px solid var(--line);border-radius:999px;min-height:34px;padding:0 12px;font:13px var(--font)';
    sel.addEventListener('change', () => { AL_M = sel.value; put('eg-alm', AL_M); drawFeed(); });
    fbox.append(sel);
    const box = $('eg-feed'); box.replaceChildren();
    if (!FEED.rows) { box.append(el('p', { class: 'note' }, 'Loading alerts…')); return; }
    const match = (r) => (AL_F === 'all' || r.type === AL_F) && (sel.value === 'all' || r.id === sel.value);
    const list = rows.filter(match), nOld = all.filter(match).length - recent.filter(match).length;
    const span = FEED_MORE ? 'the last 7 days' : 'the last 24 hours';
    if (!list.length) { box.append(el('p', { class: 'note' }, rows.length ? `No alerts match this filter in ${span}.` : `No alerts in ${span}.`)); }
    const today = new Date().toDateString(), yest = new Date(Date.now() - 864e5).toDateString();
    let day = '', ul = null;
    for (const r of list.slice(0, 200)) {
      const d = new Date(r.t), ds = d.toDateString();
      if (ds !== day) {
        day = ds;
        const lab = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
        box.append(el('h3', { class: 'eg-day' }, ds === today ? `Today · ${lab}` : ds === yest ? `Yesterday · ${lab}` : lab));
        ul = el('ul', { class: 'eg-feed' }); box.append(ul);
      }
      const li = el('li');
      const txt = String(r.text || '');
      const ic = r.type === 'step' ? (txt.trim().startsWith('▼') ? '▼' : '▲') : AL_ICON[r.type] || '•';
      const icCls = r.type === 'step' ? (ic === '▼' ? 'down' : 'up') : '';
      const tx = el('div', { class: 'tx' });
      tx.append(el('span', { class: 'mk' }, r.name), el('span', {}, r.type === 'step' ? txt.replace(/^[▲▼]\s*/, '') : txt));
      li.append(el('span', { class: 'ic ' + icCls, 'aria-hidden': 'true' }, ic), tx, el('span', { class: 'tm' }, d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })));
      ul.append(li);
    }
    if (nOld) {
      const b = el('button', { class: 'btn ghost', type: 'button', 'aria-expanded': String(FEED_MORE) }, FEED_MORE ? 'Show the last 24 hours only' : `Show ${nOld} older`);
      b.addEventListener('click', () => { FEED_MORE = !FEED_MORE; drawFeed(); const nb = $('eg-feed').querySelector('.more-row .btn'); if (nb) nb.focus(); });
      const row = el('div', { class: 'more-row' }); row.append(b); box.append(row);
    }
  }
  const tgPend = () => { try { return JSON.parse(localStorage.getItem('tg-pending')) || {}; } catch { return {}; } };
  function drawTgList() {
    const card = $('eg-tg-card'), box = $('eg-tgl');
    const ms = FEED.markets.filter((r) => r.A);
    card.hidden = !ms.some((r) => r.A.telegram);
    if (card.hidden) return;
    box.replaceChildren();
    const pend = tgPend();
    for (const r of ms) {
      const id = r.m.id, on = !r.A.muted, p = pend[id], waiting = p && p.on !== on && Date.now() - p.t < 20 * 60e3;
      const want = waiting ? !p.on : !on;
      const a = el('a', { href: MW.issueUrl(`watchlist: telegram ${want ? 'on' : 'off'} ${id}`, { action: 'telegram', id, telegram: want ? 'on' : 'off' }), target: '_blank', rel: 'noopener', class: (waiting ? p.on : on) ? 'on' : '', role: 'switch', 'aria-checked': String(waiting ? p.on : on), title: `Telegram alerts for ${nameOf(r.m)}: click to turn them ${want ? 'on' : 'off'} (opens GitHub: press Create)` });
      if (waiting) a.classList.add('pending');
      a.append(el('span', { class: 'sw', 'aria-hidden': 'true' }), document.createTextNode(`${nameOf(r.m)} · ${waiting ? (p.on ? 'turning on…' : 'turning off…') : on ? 'on' : 'off'}`));
      a.addEventListener('click', () => { const q = tgPend(); q[id] = { on: want, t: Date.now() }; try { localStorage.setItem('tg-pending', JSON.stringify(q)); } catch { /* ignore */ } setTimeout(drawTgList, 0); });
      box.append(a);
    }
  }

  // ---------- theme label: Light is called Silver here ----------
  const th = $('theme');
  new MutationObserver(() => { const s = th.querySelector('span'); if (s && s.textContent === 'Light') s.textContent = 'Silver'; if (/Light/.test(th.title)) th.title = th.title.replace('Light', 'Silver'); }).observe(th, { childList: true, subtree: true, characterData: true });

  // ---------- "more" menu ----------
  document.addEventListener('click', (e) => { const m = $('eg-more'); if (m.open && !m.contains(e.target)) m.open = false; });

  // ---------- first-visit tour ----------
  const TOUR = [
    ['Welcome to Edison Growth', 'Same data, password and settings as Classic, arranged in four places: Markets, Market, Alerts and Track record. You can switch back to Classic from the top bar any time.'],
    ['The range comes first', 'The forecast leads with the likely range, where about 68% of closes land. The model\'s up/down lean is a small line under it: it has been right about half the time, so treat it as context.'],
    ['Plan a trade', 'Plan a trade opens the risk helper beside the chart, with the inputs you saved in Classic. Entry, stop and target are drawn on the Forecast view of the chart.']
  ];
  let tourStep = 0;
  function showTour(i) {
    tourStep = i;
    const t = $('eg-tour');
    if (i >= TOUR.length) { t.hidden = true; put('eg-tour', 'done'); return; }
    t.hidden = false;
    $('eg-tour-h').textContent = TOUR[i][0]; $('eg-tour-p').textContent = TOUR[i][1];
    $('eg-tour-n').textContent = `${i + 1} of ${TOUR.length}`;
    $('eg-tour-next').textContent = i === TOUR.length - 1 ? 'Done' : 'Next';
  }
  $('eg-tour-next').addEventListener('click', () => showTour(tourStep + 1));
  $('eg-tour-skip').addEventListener('click', () => showTour(TOUR.length));
  $('eg-retour').addEventListener('click', () => { $('eg-more').open = false; showTour(0); $('eg-tour-next').focus(); });

  // ---------- react to the shared code ----------
  let firstRender = true;
  document.addEventListener('mw:render', (e) => {
    S = e.detail;
    const D = S.DATA, H = S.H;
    drawPulse(D);
    const tfOff = $('tf-card').hidden;
    tabs.find((b) => b.dataset.tab === 'tf').hidden = tfOff;
    setTab(get('eg-tab', 'news'));
    $('eg-why').hidden = !(D && D.ai && D.ai.status && !['off', 'pending', 'error'].includes(D.ai.status));
    if (D && D.price) {
      dimPrice($('price'));
      drawEvent(D); drawLadder(D, H); drawEdge(D, H); drawDisagree(D); drawNewsFilter(); drawTrackSmall(D, H);
      if (!drawer.hidden) syncDrawer();
    } else { $('eg-event').hidden = true; $('eg-disagree').hidden = true; }
    drawLines(true);
    if (firstRender && D && D.price && get('eg-tour', '') !== 'done' && !document.body.classList.contains('locked')) { firstRender = false; showTour(0); }
  });
  document.addEventListener('mw:news', drawNewsFilter);
  document.addEventListener('mw:index', (e) => {
    S = e.detail;
    drawTiles();
    if (document.body.dataset.view === 'alerts' && (!FEED.rows || Date.now() - FEED.at > 60000)) loadFeed(true); // first load too, when the page opens on Alerts
  });

  setView(get('eg-view', 'market'), { keepScroll: true });
  setTab(get('eg-tab', 'news'));
  syncMarketsView();
})();
