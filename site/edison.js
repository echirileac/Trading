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
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)');

  // ---------- views ----------
  const VIEWS = ['markets', 'market', 'alerts', 'record'];
  function setView(v, opts = {}) {
    if (!VIEWS.includes(v)) v = 'market';
    const was = document.body.dataset.view;
    if (v === 'alerts' && was !== 'alerts') UNREAD_SINCE = AL_SEEN; // before the badge marks them seen: these rows get a dot
    if (was && was !== v) document.body.dataset.dir = VIEWS.indexOf(v) > VIEWS.indexOf(was) ? 'fwd' : 'back'; // slide in from that side
    document.body.dataset.view = v; put('eg-view', v);
    document.querySelectorAll('.eg-nav button').forEach((b) => { if (b.dataset.go === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    movePill(!was);
    drawBadge();
    if (v === 'alerts') loadFeed();
    if (v === 'record' && S.DATA) requestAnimationFrame(() => drawTrackViz(S.DATA, S.H)); // measured once the page is visible
    if (v === 'markets') syncMarketsView();
    if (v !== 'market') closeDrawer(false);
    if (was !== v) {
      if (v === 'market' || v === 'record') requestAnimationFrame(() => MW.render()); // charts and sparklines measured while hidden need a redraw
      if (!opts.keepScroll) window.scrollTo({ top: 0 });
      if (opts.focus) { const h = document.querySelector(`.eg-view[data-view="${v}"] h1`) || document.querySelector(`.eg-view[data-view="${v}"] h2, .eg-view[data-view="${v}"] .sym`); if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); } }
    }
  }
  document.querySelectorAll('.eg-nav button').forEach((b) => b.addEventListener('click', () => { replay(b, 'eg-bounce'); setView(b.dataset.go, { focus: true }); }));

  // ---------- tab bar selection pill (glides between tabs) ----------
  function movePill(instant) {
    const nav = document.querySelector('.eg-nav'), b = nav && nav.querySelector('button[aria-current="page"]');
    if (!nav) return;
    let pill = nav.querySelector('.eg-nav-pill');
    if (!pill) { pill = document.createElement('span'); pill.className = 'eg-nav-pill'; pill.setAttribute('aria-hidden', 'true'); nav.prepend(pill); nav.classList.add('has-pill'); instant = true; }
    if (!b || !b.offsetWidth) { pill.hidden = true; return; }
    pill.hidden = false;
    if (instant || calm.matches) pill.classList.add('instant');
    pill.style.width = b.offsetWidth + 'px'; pill.style.height = b.offsetHeight + 'px';
    pill.style.translate = `${b.offsetLeft}px ${b.offsetTop}px`;
    if (instant || calm.matches) { void pill.offsetWidth; pill.classList.remove('instant'); }
  }
  { let t; window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => movePill(true), 80); }); }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => movePill(true));

  // ---------- phones: the bottom tab bar hides while scrolling down, comes back when scrolling up ----------
  // The script only decides hide / show (after 24 px down or 12 px up, so small wobbles do nothing); the slide itself
  // is a CSS transform the phone animates on its own. Always shown near the top, at the end of the page and while it
  // has keyboard focus. Reduce motion: it fades in place.
  {
    const narrow = window.matchMedia('(max-width: 760px)'), nav = document.querySelector('.eg-nav');
    let lastY = window.scrollY, acc = 0, ticking = false;
    const show = (on) => document.body.classList.toggle('eg-nav-hide', !on);
    const update = () => {
      ticking = false;
      const y = window.scrollY, dy = y - lastY; lastY = y;
      const atEnd = window.innerHeight + y >= document.documentElement.scrollHeight - 4;
      if (!narrow.matches || y < 80 || atEnd || (nav && nav.contains(document.activeElement))) { acc = 0; show(true); return; }
      if (!dy) return;
      if (Math.sign(dy) !== Math.sign(acc)) acc = 0; // direction changed: start counting again
      acc += dy;
      if (acc > 24) show(false); else if (acc < -12) show(true);
    };
    window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    narrow.addEventListener('change', () => show(true));
  }

  // ---------- detail tabs (News, Timeframes, Key levels, Events, Sources, Method) ----------
  const tabs = [...document.querySelectorAll('.eg-tablist [role="tab"]')];
  function setTab(t, focus) {
    let b = tabs.find((x) => x.dataset.tab === t && !x.hidden) || tabs.find((x) => !x.hidden);
    tabs.forEach((x) => { const on = x === b; x.setAttribute('aria-selected', String(on)); x.tabIndex = on ? 0 : -1; $(x.getAttribute('aria-controls')).hidden = !on; });
    put('eg-tab', b.dataset.tab);
    if (b.dataset.tab === 'levels' && S.DATA) drawLevelViz(S.DATA, S.H); // measured only once the tab is visible
    tabIntoView(b, !focus);
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
  // ---------- micro-animations: only for changes, never on every refresh ----------
  function enter(box, sel = ':scope > *') {
    if (calm.matches || !box) return;
    [...box.querySelectorAll(sel)].filter((n) => !n.hidden).slice(0, 14).forEach((n, i) => {
      n.classList.remove('eg-enter'); n.style.setProperty('--i', i); void n.offsetWidth; n.classList.add('eg-enter');
      const done = (e) => { if (e.target !== n) return; n.classList.remove('eg-enter'); n.removeEventListener('animationend', done); };
      n.addEventListener('animationend', done);
    });
  }
  function replay(node, cls) {
    if (calm.matches || !node) return;
    node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls);
    const done = (e) => { if (e.target !== node) return; node.classList.remove(cls); node.removeEventListener('animationend', done); }; // ignore children's animations
    node.addEventListener('animationend', done);
  }
  // Telegram-style rolling digits: the characters that changed slide in from below (up) or above (down);
  // the last two decimals stay dimmed. Without a direction it only lays the text out.
  function rollDigits(node, text, prev, dir) {
    const dimN = /\.\d{2,}$/.test(text) ? 2 : 0, off = text.length - (prev ? prev.length : 0);
    const frag = document.createDocumentFragment();
    let dim = null;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i], was = prev ? prev[i - off] : ch;
      let n = document.createTextNode(ch);
      if (dir && was !== ch && /\d/.test(ch)) {
        const box = el('span', { class: 'eg-rd' }), inner = el('span', { class: 'eg-ri' + (dir < 0 ? ' eg-ri-down' : '') }, ch);
        inner.style.animationDelay = (text.length - 1 - i) * 22 + 'ms';
        box.append(inner); n = box;
      }
      if (dimN && i === text.length - dimN) { dim = el('span', { class: 'dim' }); frag.append(dim); }
      (dim || frag).append(n);
    }
    node.replaceChildren(frag);
  }
  let LAST_PX = { id: null, v: null, txt: '' };
  function tickPrice(D) {
    const id = (D.meta && D.meta.id) || S.CUR_ID, v = D.price && D.price.last, node = $('price');
    const same = LAST_PX.id === id, dir = same && LAST_PX.v != null && v != null && v !== LAST_PX.v && !calm.matches ? Math.sign(v - LAST_PX.v) : 0;
    const txt = node.textContent;
    rollDigits(node, txt, same ? LAST_PX.txt : null, dir);
    if (dir) { node.classList.remove('eg-tick-up', 'eg-tick-down'); replay(node, dir > 0 ? 'eg-tick-up' : 'eg-tick-down'); }
    const swapped = LAST_PX.id && !same;
    LAST_PX = { id, v, txt };
    return swapped;
  }
  const TILE_PX = {};
  let LADDER_KEY = '';

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
  function fitLadderLabels(lbs) {
    if (!lbs.clientWidth) return; // hidden: checked again by the observer once shown
    lbs.classList.remove('stack');
    if (lbs.scrollWidth > lbs.clientWidth + 1) lbs.classList.add('stack');
  }
  const LADDER_RO = new ResizeObserver((es) => es.forEach((e) => fitLadderLabels(e.target)));
  function drawLadder(D, H) {
    const box = $('eg-ladder'), h = D.forecast && D.forecast.horizons && D.forecast.horizons[H];
    box.replaceChildren();
    if (!h || h.lo90 == null || h.hi90 == null) return;
    const lo = h.lo90, hi = h.hi90, last = D.price.last;
    const x = (v) => Math.max(1, Math.min(99, 8 + 84 * (v - lo) / Math.max(1e-9, hi - lo)));
    const bar = (cls, a, b) => { const d = el('div', { class: cls }); d.style.left = x(a) + '%'; d.style.width = (x(b) - x(a)) + '%'; return d; };
    const at = (cls, v) => { const d = el('div', { class: cls }); d.style.left = x(v) + '%'; return d; };
    // labels in a row under the bar: low and high at the ends, "now · centre" between them, or on its own line
    // when it does not fit (narrow phones), so they never overlap
    const lbs = el('div', { class: 'lbs' });
    lbs.append(el('div', { class: 'lb e0' }, MW.usd(lo)), el('div', { class: 'lb mid' }, `now ${MW.usd(last)} · centre ${MW.usd(h.center)}`), el('div', { class: 'lb e1' }, MW.usd(hi)));
    box.append(el('div', { class: 't' }), bar('w', lo, hi), bar('l', h.lo68, h.hi68), at('c', h.center), at('n', last), lbs);
    fitLadderLabels(lbs); LADDER_RO.observe(lbs); // re-checked when the row becomes visible or changes width
    const key = ((D.meta && D.meta.id) || S.CUR_ID) + '|' + H;
    if (key !== LADDER_KEY) { LADDER_KEY = key; replay(box, 'eg-grow'); }
  }
  // ---------- detail tabs on phones: a sideways-scrolling row ----------
  function tabEdges() {
    const tabRow = document.querySelector('.eg-tablist');
    if (!tabRow) return;
    const max = tabRow.scrollWidth - tabRow.clientWidth;
    tabRow.classList.toggle('more-l', tabRow.scrollLeft > 2);
    tabRow.classList.toggle('more-r', max - tabRow.scrollLeft > 2);
  }
  function tabIntoView(b, instant) { // scroll only the tab row (not the page) so the chosen tab is fully visible
    const tabRow = document.querySelector('.eg-tablist');
    if (!tabRow || tabRow.scrollWidth <= tabRow.clientWidth) { tabEdges(); return; }
    const l = b.offsetLeft - tabRow.offsetLeft, r = l + b.offsetWidth, pad = 24;
    let to = tabRow.scrollLeft;
    if (l - pad < to) to = l - pad; else if (r + pad > to + tabRow.clientWidth) to = r + pad - tabRow.clientWidth;
    tabRow.scrollTo({ left: Math.max(0, to), behavior: instant || calm.matches ? 'auto' : 'smooth' });
    tabEdges();
  }
  {
    const tabRow = document.querySelector('.eg-tablist');
    tabRow.addEventListener('scroll', tabEdges, { passive: true });
    window.addEventListener('resize', tabEdges);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(tabEdges);
  }

  // ---------- key levels on a price scale ----------
  // Levels as ticks on a vertical price scale (red resistance, green support), the live price as a dashed line with
  // a pill, and the forecast range for the chosen horizon as a shaded bar: dark = likely (68%), light = possible
  // (90%). A level's dot says whether the range reaches it. Labels are spread out so close levels stay readable.
  const SVGNS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs = {}, text) => { const n = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v); if (text != null) n.textContent = text; return n; };
  let LVZ_KEY = '';
  function lvzHighlight(i) {
    document.querySelectorAll('#eg-lvz .lvz-l').forEach((g) => g.classList.toggle('hl', g.dataset.i === String(i)));
    [...$('levels').rows].forEach((tr, k) => tr.classList.toggle('hl', k === i));
  }
  $('levels').addEventListener('mouseover', (e) => { const tr = e.target.closest('tr'); if (tr) lvzHighlight(tr.rowIndex); });
  $('levels').addEventListener('mouseleave', () => lvzHighlight(-1));
  function drawLevelViz(D, H) {
    const fig = $('eg-lvz-fig'), box = $('eg-lvz');
    const lv = (D && D.forecast && D.forecast.levels) || [], last = D && D.price && D.price.last;
    fig.hidden = !lv.length || last == null;
    if (fig.hidden) return;
    const W = Math.round(box.clientWidth);
    if (!W) return; // tab not visible yet: drawn when it opens
    const h = D.forecast.horizons && D.forecast.horizons[H];
    const rows = [...lv, { label: 'Live price', price: last, kind: 'now' }].sort((a, b) => b.price - a.price); // same order as the table
    const vals = rows.map((r) => r.price).concat(h ? [h.lo90, h.hi90] : []).filter(Number.isFinite);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = (hi - lo) * 0.05 || last * 0.01; lo -= pad; hi += pad;
    const Hh = Math.max(240, rows.length * 30 + 24), top = 12, bot = Hh - 12;
    const y = (v) => top + (hi - v) / (hi - lo) * (bot - top);
    const nowW = 68, bandX = nowW + 14, bandW = 16, tickEnd = bandX + bandW + 18, labelX = tickEnd + 20;
    const svg = sv('svg', { viewBox: `0 0 ${W} ${Hh}`, width: W, height: Hh, class: 'lvz', 'aria-hidden': 'true' });
    svg.append(sv('line', { x1: bandX + bandW / 2, x2: bandX + bandW / 2, y1: top, y2: bot, class: 'lvz-axis' }));
    if (h && h.lo90 != null) svg.append(
      sv('rect', { x: bandX, y: y(h.hi90), width: bandW, height: y(h.lo90) - y(h.hi90), class: 'lvz-b90' }),
      sv('rect', { x: bandX, y: y(h.hi68), width: bandW, height: y(h.lo68) - y(h.hi68), class: 'lvz-b68' }),
      sv('line', { x1: bandX - 3, x2: bandX + bandW + 3, y1: y(h.center), y2: y(h.center), class: 'lvz-c' }));
    const yn = y(last);
    svg.append(sv('line', { x1: nowW, x2: tickEnd + 6, y1: yn, y2: yn, class: 'lvz-now' })); // stops before the labels
    // spread labels: at least 22 px apart, kept inside the drawing
    const items = rows.map((r, i) => ({ r, i, yt: y(r.price) })).filter((it) => it.r.kind !== 'now');
    let prev = -Infinity;
    for (const it of items) { it.yl = Math.max(it.yt, prev + 22, top + 4); prev = it.yl; }
    for (let k = items.length - 1; k >= 0; k--) items[k].yl = Math.min(items[k].yl, k === items.length - 1 ? bot - 2 : items[k + 1].yl - 22);
    items.forEach((it, k) => {
      const r = it.r, res = r.kind !== 'support';
      const in68 = h && r.price >= h.lo68 && r.price <= h.hi68, in90 = h && r.price >= h.lo90 && r.price <= h.hi90;
      const g = sv('g', { class: `lvz-l ${res ? 'lvz-res' : 'lvz-sup'}${h && !in90 ? ' lvz-far' : ''}`, 'data-i': it.i });
      g.style.setProperty('--i', k);
      const pct = 100 * (r.price / last - 1);
      const t = sv('text', { x: labelX, y: it.yl + 4, class: 'lvz-t' });
      t.append(sv('tspan', { class: 'lvz-arrow' }, res ? '▲ ' : '▼ '), sv('tspan', {}, r.label + ' '), sv('tspan', { class: 'lvz-p' }, MW.usd(r.price)), sv('tspan', { class: 'lvz-d', dx: 6 }, `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`));
      g.append(sv('line', { x1: bandX - 4, x2: tickEnd, y1: it.yt, y2: it.yt, class: 'lvz-tick' }),
        sv('path', { d: `M${tickEnd} ${it.yt} L${labelX - 6} ${it.yl}`, class: 'lvz-lead' }),
        sv('circle', { cx: tickEnd, cy: it.yt, r: 3.5, class: in68 ? 'lvz-dot' : in90 ? 'lvz-ring' : 'lvz-mute' }), t);
      g.addEventListener('mouseenter', () => lvzHighlight(it.i));
      g.addEventListener('mouseleave', () => lvzHighlight(-1));
      svg.append(g);
    });
    const pill = sv('g', { class: 'lvz-nowp' }), round = window.matchMedia('(max-width: 760px)').matches ? 11 : 4;
    pill.append(sv('rect', { x: 0, y: yn - 11, width: nowW, height: 22, rx: round }), sv('text', { x: nowW / 2, y: yn + 4, 'text-anchor': 'middle' }, MW.usd(last)));
    svg.append(pill);
    const key = ((D.meta && D.meta.id) || S.CUR_ID) + '|' + H;
    if (key !== LVZ_KEY && !calm.matches) svg.classList.add('lvz-in');
    LVZ_KEY = key;
    box.replaceChildren(svg);
    // drop the distance from a label that would run past the edge
    svg.querySelectorAll('.lvz-t').forEach((t) => { if (t.getBBox().x + t.getBBox().width > W) t.lastChild.remove(); });
    const up = items.filter((it) => it.r.price > last).pop(), dn = items.find((it) => it.r.price < last);
    const near = [up && `nearest resistance ${up.r.label} at ${MW.usd(up.r.price)}`, dn && `nearest support ${dn.r.label} at ${MW.usd(dn.r.price)}`].filter(Boolean).join(', ');
    $('eg-lvz-cap').textContent = `${near ? near.charAt(0).toUpperCase() + near.slice(1) + '. ' : ''}${h ? `Bar: where the ${H}-day close is likely (dark, 68%) or possible (light, 90%). ● inside the likely range · ○ inside the wider range · faded: beyond it.` : ''}`;
  }

  // ---------- track record at a glance ----------
  // 1) bars per measure against its target (backtest and, once scored, published); 2) every recent forecast as a
  // range bar with a dot where the price closed, backtest first and the site's own published forecasts after;
  // 3) per-signal hit rates against the coin-flip line.
  let TRV_KEY = '';
  function trvRow(box, label, sub, rows, tgt, verdict, i) {
    const r = el('div', { class: 'trv-row' }), lb = el('div', { class: 'lb' }, label);
    if (sub) lb.append(el('small', {}, sub));
    const bars = el('div', { class: 'trv-bars' });
    bars.style.setProperty('--i', i);
    for (const x of rows) {
      const b = el('div', { class: 'trv-bar' + (x.pub ? ' pub' : '') + (x.v == null ? ' empty' : '') + (x.cls ? ' ' + x.cls : '') });
      const v = x.v == null ? null : Math.max(0, Math.min(100, x.v)), lab = el('b', {}, x.txt);
      if (v != null) { const f = el('i'); f.style.width = v + '%'; b.append(f); lab.style.left = v + '%'; if (v > 72) lab.classList.add('inside'); } // long bars carry their number inside
      b.append(lab);
      bars.append(b);
    }
    if (tgt != null) { const t = el('div', { class: 'trv-tgt' }); t.style.left = tgt + '%'; t.append(el('span', {}, tgt + '%')); bars.append(t); }
    r.append(lb, bars, verdict);
    box.append(r);
  }
  function drawTrackViz(D, H) {
    const card = $('eg-trv'), t = D && D.track;
    card.hidden = !t || !t.backtest;
    if (card.hidden) return;
    const B = (t.backtest && t.backtest[H]) || {}, L = (t.live && t.live[H]) || {};
    const pc = (a, b) => (b ? 100 * a / b : null), f0 = (v) => (v == null ? '—' : Math.round(v) + '%');
    const key = ((D.meta && D.meta.id) || S.CUR_ID) + '|' + H;
    card.classList.toggle('trv-in', key !== TRV_KEY && !calm.matches);
    TRV_KEY = key;

    // 1) scorecard
    const sc = $('eg-trv-score'); sc.replaceChildren();
    const k = el('p', { class: 'trv-key' });
    k.innerHTML = `<span><i></i>Backtest (${B.n || 0})</span><span><i class="pub"></i>Published (${L.n || 0})</span><span>│ target</span>`;
    sc.append(k);
    const verdict = (txt, why, cls) => { const v = el('div', { class: 'trv-verdict ' + (cls || '') }, txt); if (why) v.append(el('small', {}, why)); return v; };
    const judge = (v, tgt, kind) => {
      if (v == null) return verdict('—', 'not enough forecasts yet');
      if (kind === 'dir') return v >= 55 ? verdict('Has an edge', `${Math.round(v - 50)} points above a coin flip`, 'up') : v <= 45 ? verdict('Worse than a coin flip', `${Math.round(50 - v)} points below`, 'down') : verdict('About a coin flip', 'no reliable direction', 'flat');
      const d = v - tgt;
      return Math.abs(d) <= 4 ? verdict('Sized about right', `${d >= 0 ? '+' : ''}${Math.round(d)} points from target`, 'up') : d > 0 ? verdict('A little wide', `${Math.round(d)} points above target`, 'flat') : verdict('Too narrow', `${Math.round(-d)} points below target`, 'down');
    };
    const pubNote = L.n ? null : (t.open || []).filter((f) => f.h === H).map((f) => f.target).sort()[0];
    const rowsFor = (bv, lv) => [{ v: bv, txt: f0(bv) }, { v: lv, txt: lv == null ? (pubNote ? `first result ${MW.dayName(pubNote)}` : 'not scored yet') : f0(lv), pub: true }];
    const dirB = pc(B.dirHit, B.dirN), dirL = pc(L.dirHit, L.dirN);
    const usePub = (L.n || 0) >= 20; // verdicts read the published record once it has 20 forecasts, the backtest until then
    const basis = (v) => { const sm = v.querySelector('small'); if (sm) sm.textContent += (sm.textContent ? ' · ' : '') + (usePub ? 'published' : 'backtest'); return v; };
    trvRow(sc, 'Direction right', 'up or down called correctly', rowsFor(dirB, dirL), 50, basis(judge(usePub ? dirL : dirB, 50, 'dir')), 0);
    const i68B = pc(B.in68, B.n), i68L = pc(L.in68, L.n);
    trvRow(sc, 'Inside the likely range', 'close within the 68% range', rowsFor(i68B, i68L), 68, basis(judge(usePub ? i68L : i68B, 68)), 1);
    const i90B = pc(B.in90, B.n), i90L = pc(L.in90, L.n);
    trvRow(sc, 'Inside the wide range', 'close within the 90% range', rowsFor(i90B, i90L), 90, basis(judge(usePub ? i90L : i90B, 90)), 2);
    { // average miss vs assuming no change: shorter is better
      const m = usePub && L.mae != null ? L : B;
      if (m.mae != null && m.maeNaive != null) {
        const top = Math.max(m.mae, m.maeNaive) * 1.15;
        const better = m.mae < m.maeNaive * 0.97, worse = m.mae > m.maeNaive * 1.03;
        trvRow(sc, 'Average miss', `${m === L ? 'published' : 'backtest'}: forecast vs "no change"`,
          [{ v: 100 * m.mae / top, txt: `${m.mae.toFixed(2)}% forecast`, cls: 'pub' }, { v: 100 * m.maeNaive / top, txt: `${m.maeNaive.toFixed(2)}% no change` }], null,
          better ? verdict('Forecast helps', 'misses less than "no change"', 'up') : worse ? verdict('No better than "no change"', '', 'down') : verdict('Same as "no change"', 'shorter bar is better', 'flat'), 3);
      }
    }

    // 2) timeline: backtest forecasts, then the published ones (scored and pending)
    const box = $('eg-trv-tl'), W = Math.round(box.clientWidth);
    const pts = (t.backtest.pts && t.backtest.pts[H]) || [];
    const pub = [...(t.recent || []).filter((f) => f.h === H), ...(t.open || []).filter((f) => f.h === H)].sort((a, b) => (a.d0 < b.d0 ? -1 : 1));
    const items = pts.map(([d0, p0, c, lo68, hi68, lo90, hi90, actual]) => ({ d0, p0, c, lo68, hi68, lo90, hi90, actual }))
      .concat(pub.map((f) => ({ ...f, pub: true })));
    $('eg-trv-tl-note').textContent = pts.length
      ? `Each bar is one ${H}-day forecast: its likely and wide range, as a move from the price when it was made, and a dot where the price actually closed ${H} session${H > 1 ? 's' : ''} later. Last ${pts.length} backtest forecasts${pub.length ? `, then the site's own published ones` : ''}.`
      : 'The timeline appears after the next site update.';
    box.replaceChildren(); $('eg-trv-legend').hidden = !items.length;
    if (W && items.length) {
      const mv = (v, p0) => 100 * (v / p0 - 1);
      const ext = Math.max(...items.flatMap((f) => [mv(f.lo90, f.p0), mv(f.hi90, f.p0), f.actual != null ? mv(f.actual, f.p0) : 0]).map(Math.abs).filter(Number.isFinite), 0.5);
      const step = ext > 12 ? 5 : ext > 6 ? 2 : ext > 3 ? 1 : 0.5, lim = Math.ceil(ext / step) * step;
      const Hh = 220, padL = 40, padR = 6, top = 18, bot = Hh - 24;
      const gapSlots = pub.length && pts.length ? 1.5 : 0, n = items.length + gapSlots;
      const slot = (W - padL - padR) / n, bw = Math.max(2, Math.min(10, slot * 0.62));
      const y = (pct) => top + (lim - pct) / (2 * lim) * (bot - top);
      const svg = sv('svg', { viewBox: `0 0 ${W} ${Hh}`, width: W, height: Hh, role: 'img', 'aria-label': `${items.length} forecasts and where the price closed` });
      for (let g = -lim; g <= lim + 1e-9; g += step) {
        svg.append(sv('line', { x1: padL, x2: W - padR, y1: y(g), y2: y(g), class: Math.abs(g) < 1e-9 ? 'zero' : 'grid' }), sv('text', { x: padL - 6, y: y(g) + 4, 'text-anchor': 'end', class: 'ax' }, `${g > 0 ? '+' : ''}${+g.toFixed(1)}%`));
      }
      const x0 = (i) => padL + (i + (i >= pts.length ? gapSlots : 0) + 0.5) * slot;
      if (pub.length) {
        const xs = x0(pts.length) - slot / 2 - (gapSlots ? slot * 0.4 : 0);
        svg.append(sv('rect', { x: xs, y: top - 14, width: W - padR - xs, height: bot - top + 14, class: 'pubbg' }), sv('text', { x: W - padR - 3, y: top - 4, 'text-anchor': 'end', class: 'ax' }, 'Published'));
      }
      items.forEach((f, i) => {
        const cx = x0(i), g = sv('g', { class: 'f' + (f.actual == null ? ' pend' : '') });
        g.style.setProperty('--i', i);
        const a = f.actual != null ? mv(f.actual, f.p0) : null;
        const res = a == null ? 'pending' : f.actual >= f.lo68 && f.actual <= f.hi68 ? 'in' : f.actual >= f.lo90 && f.actual <= f.hi90 ? 'mid' : 'out';
        const s = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
        g.append(sv('title', {}, `${f.pub ? 'Published' : 'Backtest'} · made ${MW.dayName(f.d0)}${f.target ? ` for ${MW.dayName(f.target)}` : ''}: likely ${s(mv(f.lo68, f.p0))} to ${s(mv(f.hi68, f.p0))}, ${a == null ? 'pending' : `closed ${s(a)} (${res === 'in' ? 'inside the likely range' : res === 'mid' ? 'inside the wide range' : 'outside both'})`}`),
          sv('rect', { x: cx - bw / 2, y: y(mv(f.hi90, f.p0)), width: bw, height: Math.max(1, y(mv(f.lo90, f.p0)) - y(mv(f.hi90, f.p0))), class: 'r90' }),
          sv('rect', { x: cx - bw / 2, y: y(mv(f.hi68, f.p0)), width: bw, height: Math.max(1, y(mv(f.lo68, f.p0)) - y(mv(f.hi68, f.p0))), class: 'r68' }));
        if (a != null) g.append(sv('circle', { cx, cy: y(Math.max(-lim, Math.min(lim, a))), r: Math.max(2.4, Math.min(4, bw * 0.45)), class: 'd ' + res }));
        svg.append(g);
      });
      if (pts.length) {
        svg.append(sv('text', { x: x0(0) - bw / 2, y: Hh - 6, class: 'ax' }, MW.dayName(pts[0][0])));
        svg.append(sv('text', { x: x0(pts.length - 1) + bw / 2, y: Hh - 6, 'text-anchor': 'end', class: 'ax' }, MW.dayName(pts[pts.length - 1][0])));
      }
      box.append(svg);
    }

    // 3) signals
    const sigBox = $('eg-trv-sig'); sigBox.replaceChildren();
    const names = { trend: 'Trend', momentum: 'Momentum', mtf: 'Timeframes', rsi: 'RSI', news: 'News' };
    const sigs = Object.entries((L.n >= 20 ? L.signals : B.signals) || {}).filter(([, v]) => v && v[1] >= 10);
    $('eg-trv-sig-wrap').hidden = !sigs.length;
    sigs.sort((a, b) => b[1][0] / b[1][1] - a[1][0] / a[1][1]).forEach(([id, [hit, tot]], i) => {
      const v = 100 * hit / tot;
      trvRow(sigBox, names[id] || id, `${tot} times it pointed a way`, [{ v, txt: Math.round(v) + '%' }], 50,
        v >= 55 ? verdict('Useful', '', 'up') : v <= 45 ? verdict('Misleading', '', 'down') : verdict('Coin flip', '', 'flat'), i);
    });
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
  // When the model, the AI analyst and the timeframe reading point different ways: one tile per signal (tap to see
  // where it comes from) and one plain line on what that means for a trade.
  function drawDisagree(D) {
    const f = D.forecast || {}, sigs = [];
    const m = dirOf(f.score);
    sigs.push({ k: 'Model', d: m, v: m > 0 ? 'Leans up' : m < 0 ? 'Leans down' : 'Neutral', go: 'model' });
    const a = D.ai && D.ai.stance && D.ai.status !== 'off' && D.ai.status !== 'pending' && D.ai.status !== 'error' ? D.ai.stance : null;
    if (a) { const d = a === 'bullish' ? 1 : a === 'bearish' ? -1 : 0; sigs.push({ k: 'AI analyst', d, v: a.charAt(0).toUpperCase() + a.slice(1), go: 'ai' }); }
    const v = D.mtf && D.mtf.verdict;
    if (v && v.title && v.id !== 'none') sigs.push({ k: 'Timeframes', d: Math.sign(v.dir || 0), v: v.title, go: 'tf' });
    const show = new Set(sigs.map((x) => x.d)).size > 1 && sigs.length > 1;
    $('eg-disagree').hidden = !show;
    if (!show) return;
    const box = $('eg-dis-sigs'); box.replaceChildren();
    for (const x of sigs) {
      const cls = x.d > 0 ? 'up' : x.d < 0 ? 'down' : 'flat';
      const b = el('button', { type: 'button', class: 'eg-dis-sig ' + cls, title: `Show the ${x.k.toLowerCase()} reading` });
      const val = el('span', { class: 'v' }); val.append(el('i', { 'aria-hidden': 'true' }, x.d > 0 ? '▲' : x.d < 0 ? '▼' : '◆'), document.createTextNode(x.v));
      b.append(el('span', { class: 'k' }, x.k), val);
      b.addEventListener('click', () => disGo(x.go));
      box.append(b);
    }
    const name = (x) => (x.k === 'Model' ? 'the model' : x.k === 'AI analyst' ? 'the AI analyst' : 'the timeframes');
    const ups = sigs.filter((x) => x.d > 0), downs = sigs.filter((x) => x.d < 0), flats = sigs.filter((x) => !x.d);
    const list = (xs) => xs.map(name).join(' and ');
    let head, tip;
    if (ups.length && downs.length) {
      head = 'Signals point opposite ways';
      tip = `${cap(list(ups))} ${ups.length > 1 ? 'point' : 'points'} up, ${list(downs)} down. There is no edge in either direction: the forecast range is the safer guide. Wait for them to line up, or trade smaller.`;
    } else {
      const one = ups.length ? ups : downs, way = ups.length ? 'up' : 'down';
      head = 'No clear direction';
      tip = `Only ${list(one)} ${one.length > 1 ? 'point' : 'points'} ${way}; ${list(flats)} ${flats.length > 1 ? 'see' : 'sees'} no clear direction. Treat it as a weak hint, not a signal to trade.`;
    }
    $('eg-dis-h').textContent = head;
    $('eg-disagree-t').textContent = tip;
  }
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  function disGo(go) {
    const spot = (n) => { if (!n) return; n.scrollIntoView({ behavior: calm.matches ? 'auto' : 'smooth', block: 'center' }); n.classList.remove('eg-flash'); void n.offsetWidth; n.classList.add('eg-flash'); };
    if (go === 'model') spot($('bias').closest('.eg-lean') || $('bias'));
    else if (go === 'ai') spot($('ai-card'));
    else { const t = $('fc-tf'); if (t && !t.hidden && t.offsetParent) spot(t.closest('section')); else { setTab('tf'); spot($('p-tf')); } }
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
      b.addEventListener('click', () => { NEWS_F = k; put('eg-newsf', k); drawNewsFilter(); enter($('news')); });
      box.append(b);
    }
    lis.forEach((li) => { li.hidden = NEWS_F !== 'all' && kind(li) !== NEWS_F; });
    box.hidden = lis.length < 2;
  }

  // ---------- news: stories that arrived since the last refresh of the same market drop in ----------
  let NEWS_SEEN = { id: null, keys: null };
  function markNewNews(D, mark) {
    const id = (D && D.meta && D.meta.id) || S.CUR_ID, lis = [...$('news').children];
    const keyOf = (li) => { const a = li.querySelector('a'); return a ? a.getAttribute('href') + '|' + a.textContent : null; };
    const same = NEWS_SEEN.id === id && NEWS_SEEN.keys;
    if (mark && same && !calm.matches) lis.forEach((li) => { const k = keyOf(li); if (k && !NEWS_SEEN.keys.has(k)) li.classList.add('eg-new'); });
    const keys = same ? NEWS_SEEN.keys : new Set();
    lis.forEach((li) => { const k = keyOf(li); if (k) keys.add(k); });
    NEWS_SEEN = { id, keys };
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
  // On wide screens the panel sits beside the page (body.eg-plan-open makes room on the right); the charts are
  // redrawn for the new width once the slide has finished. Narrower screens keep the floating panel / bottom sheet.
  let relayT;
  const relayout = () => { clearTimeout(relayT); relayT = setTimeout(() => window.dispatchEvent(new Event('resize')), 260); };
  const scrim = $('eg-scrim');
  let closeT = null, onCloseEnd = null;
  function stopClosing() {
    clearTimeout(closeT); closeT = null;
    if (onCloseEnd) drawer.removeEventListener('animationend', onCloseEnd);
    onCloseEnd = null;
    drawer.classList.remove('out'); scrim.classList.remove('out');
  }
  function openDrawer() {
    stopClosing();
    drawer.style.translate = ''; scrim.style.opacity = '';
    drawer.hidden = false; scrim.hidden = false; planBtn.setAttribute('aria-expanded', 'true');
    document.body.classList.add('eg-plan-open'); relayout();
    drawer.focus({ preventScroll: true });
    syncDrawer(); drawLines();
  }
  function closeDrawer(focusBack = true) {
    if (drawer.hidden || drawer.classList.contains('out')) return;
    planBtn.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('eg-plan-open'); relayout(); // the page slides back while the panel leaves
    const finish = () => { stopClosing(); drawer.hidden = true; scrim.hidden = true; drawer.style.translate = ''; scrim.style.opacity = ''; drawLines(); };
    if (calm.matches) finish();
    else {
      drawer.classList.add('out'); scrim.classList.add('out');
      onCloseEnd = (e) => { if (e.target === drawer) finish(); };
      drawer.addEventListener('animationend', onCloseEnd);
      closeT = setTimeout(finish, 500);
    }
    if (focusBack) planBtn.focus({ preventScroll: true });
  }
  planBtn.addEventListener('click', () => (drawer.hidden || drawer.classList.contains('out') ? openDrawer() : closeDrawer()));
  scrim.addEventListener('click', () => closeDrawer());
  { const top = drawer.querySelector('.eg-drawer-top'); drawer.addEventListener('scroll', () => top.classList.toggle('stuck', drawer.scrollTop > 2), { passive: true }); } // hairline under the header once the form scrolls under it
  // phones: drag the sheet down by its grabber or header to close it; let go early and it springs back
  {
    const sheet = window.matchMedia('(max-width: 760px)');
    let drag = null;
    const start = (e) => {
      if (!sheet.matches || drawer.hidden || drawer.classList.contains('out') || e.target.closest('button, a, input, select')) return;
      drag = { y: e.clientY, t: e.timeStamp, dy: 0, v: 0, id: e.pointerId };
      drawer.setPointerCapture(e.pointerId); drawer.classList.add('dragging');
    };
    drawer.querySelectorAll('.eg-grab, .eg-drawer-h').forEach((n) => n.addEventListener('pointerdown', start));
    drawer.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dy = Math.max(0, e.clientY - drag.y), dt = e.timeStamp - drag.t;
      if (dt > 0) drag.v = (dy - drag.dy) / dt;
      drag.dy = dy; drag.t = e.timeStamp;
      drawer.style.translate = `0 ${dy}px`;
      scrim.style.opacity = String(1 - Math.min(1, dy / Math.max(1, drawer.offsetHeight)));
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const { dy, v } = drag; drag = null;
      drawer.classList.remove('dragging');
      if (dy > Math.min(140, drawer.offsetHeight * 0.25) || v > 0.6) closeDrawer(false);
      else { drawer.style.translate = ''; scrim.style.opacity = ''; }
    };
    drawer.addEventListener('pointerup', end); drawer.addEventListener('pointercancel', end);
  }
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
      const px = el('div', { class: 'px' }), pb = el('b'), ptxt = MW.fmt(m.last, dec), pv = TILE_PX[m.id];
      rollDigits(pb, ptxt, pv && pv.txt, pv && pv.v != null && m.last !== pv.v && !calm.matches ? Math.sign(m.last - pv.v) : 0);
      TILE_PX[m.id] = { v: m.last, txt: ptxt };
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
  const FEED_SEEN = { ready: false, keys: new Set() };
  const alKey = (r) => `${r.id}|${r.t}|${r.type}|${r.text}`;
  // Last 24 hours by default; "Show older" brings back the rest of the 7 days for this visit.
  let FEED_MORE = false;
  // The market picker is made once and only updated: rebuilding it on every refresh closed the phone's picker wheel
  // (or dropped the choice) when a refresh landed while it was open. The type chips are redrawn next to it.
  let AL_SEL = null, AL_CHIPS = null, AL_OPTS = '';
  function drawFeed() {
    const fbox = $('eg-al-f');
    if (!AL_SEL) {
      AL_CHIPS = el('div', { class: 'eg-alf-chips' });
      AL_SEL = el('select', { 'aria-label': 'Market', class: 'eg-msel' });
      AL_SEL.addEventListener('change', () => { AL_M = AL_SEL.value; put('eg-alm', AL_M); drawFeed(); enter($('eg-feed'), '.eg-feed li, .eg-day'); });
      fbox.replaceChildren(AL_SEL, AL_CHIPS);
    }
    const all = FEED.rows || [];
    const recent = all.filter((r) => Date.now() - Date.parse(r.t) <= 864e5);
    const rows = FEED_MORE ? all : recent;
    const ids = FEED.markets.map((r) => r.m.id + ':' + nameOf(r.m)).join('|');
    if (ids !== AL_OPTS) { // markets changed: rebuild the options only
      AL_OPTS = ids;
      AL_SEL.replaceChildren(el('option', { value: 'all' }, 'All markets'), ...FEED.markets.map((r) => el('option', { value: r.m.id }, nameOf(r.m))));
    }
    const mk = FEED.markets.some((r) => r.m.id === AL_M) ? AL_M : 'all';
    if (AL_SEL.value !== mk) AL_SEL.value = mk;
    const inMk = (r) => mk === 'all' || r.id === mk; // the chip counts follow the chosen market
    const mkRows = rows.filter(inMk);
    AL_CHIPS.replaceChildren();
    for (const [k, label] of AL_TYPES) {
      const n = k === 'all' ? mkRows.length : mkRows.filter((r) => r.type === k).length;
      if (k !== 'all' && !n && k !== AL_F) continue;
      const b = el('button', { type: 'button', 'aria-pressed': String(k === AL_F) }, `${label} ${n}`);
      b.addEventListener('click', () => { AL_F = k; put('eg-alf', k); drawFeed(); enter($('eg-feed'), '.eg-feed li, .eg-day'); });
      AL_CHIPS.append(b);
    }
    const box = $('eg-feed'); box.replaceChildren();
    if (!FEED.rows) {
      const sk = el('ul', { class: 'eg-feed eg-skel', 'aria-hidden': 'true' });
      for (let i = 0; i < 4; i++) { const li = el('li'); li.append(el('span', { class: 'ic' }), el('div', { class: 'tx' }), el('span', { class: 'tm' })); sk.append(li); }
      box.append(el('p', { class: 'sr', role: 'status' }, 'Loading alerts…'), sk);
      return;
    }
    const match = (r) => (AL_F === 'all' || r.type === AL_F) && inMk(r);
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
        box.append(el('h2', { class: 'eg-day' }, ds === today ? `Today · ${lab}` : ds === yest ? `Yesterday · ${lab}` : lab));
        ul = el('ul', { class: 'eg-feed' }); box.append(ul);
      }
      const li = el('li');
      if (FEED_SEEN.ready && !FEED_SEEN.keys.has(alKey(r))) li.classList.add('eg-new'); // arrived since the last look: drops in
      if (UNREAD_SINCE && Date.parse(r.t) > UNREAD_SINCE) { li.classList.add('eg-unread'); li.setAttribute('aria-label', 'New: ' + r.name + ', ' + (r.text || '')); }
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
      b.addEventListener('click', () => { FEED_MORE = !FEED_MORE; drawFeed(); enter($('eg-feed'), '.eg-feed li, .eg-day'); const nb = $('eg-feed').querySelector('.more-row .btn'); if (nb) nb.focus(); });
      const row = el('div', { class: 'more-row' }); row.append(b); box.append(row);
    }
    for (const r of all) FEED_SEEN.keys.add(alKey(r));
    FEED_SEEN.ready = true;
    if (document.body.dataset.view === 'alerts' && !document.hidden) { markSeen(all.map((r) => Date.parse(r.t))); drawBadge(); }
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

  // ---------- unread alerts: badge on the Alerts tab and in the browser tab title ----------
  // "Seen" is the newest alert time the user has had on screen (not the clock), so an alert that is published a few
  // minutes after it fired still counts as new. The first visit treats everything already there as seen.
  let AL_SEEN = Number(get('eg-al-seen', 0)) || 0, BADGE_N = 0, UNREAD_SINCE = 0;
  const BASE_TITLE = () => document.title.replace(/^\(\d+\+?\) /, '');
  function alertTimes() {
    const I = S.INDEX;
    if (!I || !I.markets || !I.markets.some((m) => Array.isArray(m.alT))) return null; // older build: no badge yet
    return I.markets.flatMap((m) => (m.alT || []).map((x) => x * 1000));
  }
  function markSeen(times) {
    const newest = Math.max(AL_SEEN, ...times.filter(Number.isFinite));
    if (newest > AL_SEEN) { AL_SEEN = newest; put('eg-al-seen', String(newest)); }
  }
  function drawBadge() {
    const ts = alertTimes();
    if (!ts) return;
    if (!AL_SEEN) markSeen(ts.length ? ts : [Date.now()]);
    if (document.body.dataset.view === 'alerts' && !document.hidden) markSeen(ts);
    const n = ts.filter((t) => t > AL_SEEN).length;
    const btn = document.querySelector('.eg-nav button[data-go="alerts"]');
    if (btn) {
      let b = btn.querySelector('.eg-badge');
      if (!b) { b = el('span', { class: 'eg-badge', 'aria-hidden': 'true' }); btn.append(b); }
      b.hidden = !n;
      b.textContent = n > 99 ? '99+' : String(n);
      if (n) btn.setAttribute('aria-label', `Alerts, ${n} new`); else btn.removeAttribute('aria-label');
      if (n > BADGE_N) replay(b, 'eg-badge-pop');
    }
    BADGE_N = n;
    const t = BASE_TITLE();
    document.title = n ? `(${n > 99 ? '99+' : n}) ${t}` : t;
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) drawBadge(); });

  // ---------- logo: refresh the site (same page and market; the hash is kept) ----------
  $('eg-brand').addEventListener('click', () => {
    const b = $('eg-brand');
    if (b.classList.contains('eg-reloading')) return;
    if (calm.matches) { location.reload(); return; }
    b.classList.add('eg-reloading');
    setTimeout(() => location.reload(), 380); // let the spin show before the page goes
  });

  // ---------- touch ripple ----------
  const RIPPLE = '.btn, .eg-tile, .wl-card, .eg-nav button, .eg-filter button, .seg button, .eg-seg button, .eg-ui > *, .eg-tablist button, .eg-tgl a, .eg-menu a, .eg-menu button';
  document.addEventListener('pointerdown', (e) => {
    if (calm.matches || e.button > 0) return;
    const t = e.target.closest(RIPPLE);
    if (!t || t.disabled) return;
    const r = t.getBoundingClientRect(), d = Math.max(r.width, r.height) * 2.2;
    const s = el('span', { class: 'eg-ripple', 'aria-hidden': 'true' });
    s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
    t.append(s);
    s.addEventListener('animationend', () => s.remove(), { once: true });
    setTimeout(() => s.remove(), 900);
  }, { passive: true });

  // ---------- theme change: a circle spreading from the theme button (browsers with view transitions) ----------
  let VT_PASS = false;
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('#theme');
    if (!btn || VT_PASS || calm.matches || !document.startViewTransition) return;
    e.stopImmediatePropagation();
    const r = btn.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    const R = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const vt = document.startViewTransition(() => { VT_PASS = true; try { btn.click(); } finally { VT_PASS = false; } });
    vt.ready.then(() => document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${R}px at ${x}px ${y}px)`] },
      { duration: 520, easing: 'cubic-bezier(.4, 0, .2, 1)', pseudoElement: '::view-transition-new(root)' })).catch(() => {});
  }, true);

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
      if (tickPrice(D)) { replay(document.querySelector('.eg-hero'), 'eg-swap'); enter($('news')); }
      markNewNews(D, true);
      drawEvent(D); drawLadder(D, H); drawLevelViz(D, H); drawTrackViz(D, H); drawEdge(D, H); drawDisagree(D); drawNewsFilter(); drawTrackSmall(D, H);
      if (!drawer.hidden) syncDrawer();
    } else { $('eg-event').hidden = true; $('eg-disagree').hidden = true; }
    drawLines(true);
    if (BADGE_N && !/^\(\d/.test(document.title)) document.title = `(${BADGE_N > 99 ? '99+' : BADGE_N}) ${document.title}`;
    if (firstRender && D && D.price && get('eg-tour', '') !== 'done' && !document.body.classList.contains('locked')) { firstRender = false; showTour(0); }
  });
  document.addEventListener('mw:news', () => { drawNewsFilter(); markNewNews(S.DATA, false); enter($('news')); });
  document.addEventListener('mw:index', (e) => {
    S = e.detail;
    drawBadge();
    drawTiles();
    if (document.body.dataset.view === 'alerts' && (!FEED.rows || Date.now() - FEED.at > 60000)) loadFeed(true); // first load too, when the page opens on Alerts
  });

  setView(get('eg-view', 'market'), { keepScroll: true });
  setTab(get('eg-tab', 'news'));
  syncMarketsView();
})();
