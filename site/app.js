(() => {
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  let DATA = null, lastFetch = 0;
  let H = Number((location.hash.match(/^#([135])d$/) || [])[1] || 3);

  let DEC = 3, CUR = '$';
  const usd = (v, d) => (v == null || !isFinite(v) ? '—' : CUR + Number(v).toLocaleString('en-US', { minimumFractionDigits: d === undefined ? DEC : DEC > 3 ? DEC - 1 : d, maximumFractionDigits: d === undefined ? DEC : DEC > 3 ? DEC - 1 : d }));
  const fmtNum = (v, dec) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }));
  const sp = (v, d = 2) => (v == null || !isFinite(v) ? '' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d) + '%');
  const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  };
  const dayName = (ymd) => new Date(ymd + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const el = (tag, attrs = {}, text) => {
    const n = tag.startsWith('svg:') ? document.createElementNS(NS, tag.slice(4)) : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };

  // ---------- watchlist + market loading ----------
  let INDEX = null, CUR_ID = null;
  const REPO = (() => { const owner = location.hostname.split('.')[0]; const name = location.pathname.split('/').filter(Boolean)[0] || ''; return { owner, name }; })();
  const issueUrl = (title, obj) => `https://github.com/${REPO.owner}/${REPO.name}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent('Requested from the market watch page. Press "Create" to apply - an automatic job updates the watchlist and closes this issue.\n\n```json\n' + JSON.stringify(obj, null, 2) + '\n```\n')}`;
  function parseHash() {
    const m = location.hash.slice(1).match(/^([A-Za-z0-9-]+)?(?:\/([135])d)?$/) || [];
    const legacy = location.hash.match(/^#([135])d$/);
    if (legacy) return { id: null, h: +legacy[1] };
    return { id: m[1] || null, h: m[2] ? +m[2] : null };
  }
  function setHash() { history.replaceState(null, '', `#${CUR_ID}/${H}d`); }
  { const ph = parseHash(); if (ph.h) H = ph.h; CUR_ID = ph.id; }

  // ---------- password lock ----------
  // With SITE_PASSWORD set on GitHub, every data file arrives as { enc: 1, kdf, iv, ct }: gzip + AES-256-GCM with a key made
  // from the password (PBKDF2-SHA256). The key, never the password, is kept on this device when "Remember" is ticked.
  const LOCK = { raw: null, asking: null };
  const LOCK_STORE = 'site-key';
  const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const b64e = (u) => btoa(String.fromCharCode(...u));
  const kdfId = (k) => `${k.alg}|${k.salt}|${k.iter}`;
  function storedKey(kdf) {
    for (const st of [sessionStorage, localStorage]) {
      try { const v = JSON.parse(st.getItem(LOCK_STORE)); if (v && v.kdf === kdfId(kdf)) return b64d(v.k); } catch { /* none */ }
    }
    return null;
  }
  function forgetKey() { LOCK.raw = null; for (const st of [sessionStorage, localStorage]) { try { st.removeItem(LOCK_STORE); } catch { /* ignore */ } } }
  async function deriveKey(pw, kdf) {
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(kdf.salt), iterations: kdf.iter }, base, 256));
  }
  async function openSealed(j, raw) {
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    const zipped = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(j.iv) }, key, b64d(j.ct));
    return JSON.parse(await new Response(new Blob([zipped]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
  }
  // Shows the password screen; resolves once the typed password opens the sample file j.
  function askPassword(j) {
    if (LOCK.asking) return LOCK.asking;
    document.body.classList.add('locked');
    const form = $('lock-form'), pw = $('lock-pw'), err = $('lock-err'), go = $('lock-go');
    if (!window.crypto?.subtle || !window.DecompressionStream) err.textContent = 'This browser is too old to open the locked site. Try a current Chrome, Safari or Firefox.';
    pw.focus();
    LOCK.asking = new Promise((resolve) => {
      form.onsubmit = async (e) => {
        e.preventDefault();
        if (!pw.value) return;
        go.disabled = true; go.textContent = 'Checking…'; err.textContent = '';
        try {
          const raw = await deriveKey(pw.value, j.kdf);
          await openSealed(j, raw); // throws on a wrong password
          LOCK.raw = raw;
          try { ($('lock-keep').checked ? localStorage : sessionStorage).setItem(LOCK_STORE, JSON.stringify({ kdf: kdfId(j.kdf), k: b64e(raw) })); } catch { /* private mode: this tab only */ }
          pw.value = '';
          document.body.classList.remove('locked');
          LOCK.asking = null;
          resolve();
        } catch {
          err.textContent = 'Wrong password, try again.';
          pw.select();
        } finally { go.disabled = false; go.textContent = 'Unlock'; }
      };
    });
    return LOCK.asking;
  }
  // fetch + JSON + unlock: { ok, status, data }
  async function getData(url) {
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return { ok: false, status: r.status };
    const j = await r.json();
    if (j?.enc !== 1) { $('lock-btn').hidden = true; return { ok: true, data: j }; }
    for (;;) {
      const raw = LOCK.raw || storedKey(j.kdf);
      if (raw) {
        try { const data = await openSealed(j, raw); LOCK.raw = raw; $('lock-btn').hidden = false; return { ok: true, data }; }
        catch { forgetKey(); } // password changed since it was saved
      }
      await askPassword(j);
    }
  }
  $('lock-btn').addEventListener('click', () => { forgetKey(); location.reload(); });

  async function load() {
    if (LOCK.asking) return; // the password screen is open: nothing to refresh yet
    try {
      const r = await getData('data/index.json');
      if (r.ok) INDEX = r.data;
    } catch { /* older deployments have no index */ }
    if (!INDEX) INDEX = { markets: [{ id: 'NATGAS', name: 'Natural gas (Henry Hub)', symbol: 'NG front month' }] };
    if (!CUR_ID || !INDEX.markets.some((m) => m.id === CUR_ID)) CUR_ID = INDEX.markets[0]?.id || 'NATGAS';
    drawWatchlist();
    await loadMarket();
  }
  async function loadMarket() {
    try {
      let r = await getData(`data/m/${CUR_ID}.json`);
      if (!r.ok && CUR_ID === 'NATGAS') r = await getData('data/latest.json');
      if (!r.ok) throw new Error(r.status === 404 ? 'not built yet' : 'HTTP ' + r.status);
      DATA = r.data;
      lastFetch = Date.now();
      render();
    } catch (e) {
      // No data for this market: hide every price, forecast and news section so the previous market's numbers cannot stay on screen.
      DATA = null;
      $('tg').hidden = true;
      const s = INDEX?.markets.find((m) => m.id === CUR_ID);
      document.body.classList.add('nodata');
      setHeader(s || { id: CUR_ID, name: CUR_ID });
      $('status').textContent = ''; $('dot').className = 'dot';
      const b = $('banner'); b.className = 'banner show';
      const paid = /pro or venture|\bgrow\b|upgrad|pricing/i.test(s?.error || '');
      b.textContent = paid ? `${s.name}: this listing (${s.symbol}${s.exchange ? ' on ' + s.exchange : ''}) is not in the free Twelve Data plan, so it has no price, forecast or news here. Remove it and add the US listing instead. The live chart below still works.`
        : s?.error ? `${s.name}: ${s.error}` : `${s?.name || CUR_ID}: ${e.message === 'not built yet' ? 'data is being prepared, it appears within a few minutes of adding a market' : 'could not load (' + e.message + ')'}.`;
      pcDestroy(); PC.key = null;
      setView(); tvUpdate();
      emit('mw:render');
    }
  }
  function select(id) { if (id === CUR_ID) return; CUR_ID = id; setHash(); drawWatchlist(); loadMarket(); window.scrollTo({ top: 0, behavior: 'smooth' }); }

  function setHeader(meta) {
    const isNG = meta.id === 'NATGAS';
    $('m-name').textContent = isNG ? 'NATGAS' : meta.name;
    $('m-pill').textContent = isNG ? 'Henry Hub · NYMEX front month' : [meta.symbol, meta.exchange, catName(meta.category)].filter(Boolean).join(' · ');
    document.title = `${isNG ? 'NATGAS' : meta.symbol} · live 1 / 3 / 5-day forecast`;
    const rm = $('remove');
    if (isNG) rm.hidden = true;
    else { rm.hidden = false; rm.href = issueUrl(`watchlist: remove ${meta.id}`, { action: 'remove', id: meta.id }); rm.title = `Remove ${meta.name} from the watchlist (opens GitHub)`; }
  }
  const catName = (c) => ({ energy: 'Energy', metal: 'Metal', fx: 'Forex', crypto: 'Crypto', equity: 'Stock', etf: 'ETF', index: 'Index' }[c] || '');

  function drawWatchlist() {
    const nav = $('wl'); nav.replaceChildren();
    for (const m of INDEX.markets) {
      const b = el('button', { class: 'wl-card', type: 'button', 'aria-current': String(m.id === CUR_ID) });
      const biasCol = m.score > 0.15 ? 'var(--up)' : m.score < -0.15 ? 'var(--down)' : 'var(--muted)';
      const dot = el('span', { class: 'b' }); dot.style.background = biasCol;
      const name = el('div', { class: 'n' }); name.append(dot, document.createTextNode(m.id === 'NATGAS' ? 'NATGAS' : m.name));
      if (m.tgOff) name.append(el('span', { title: 'Telegram alerts off for this market', 'aria-label': 'Telegram alerts off' }, ' 🔕'));
      const dec = m.decimals ?? 3;
      b.append(name, el('div', { class: 's' }, m.id === 'NATGAS' ? 'Henry Hub' : m.symbol),
        el('div', { class: 'p' }, m.last != null ? fmtNum(m.last, dec) : (m.error ? 'No data' : '…')),
        el('div', { class: 'c ' + cls(m.changePct) }, m.changePct != null ? sp(m.changePct) + ' today' : (m.error ? 'see details' : 'preparing')));
      // Forecast on its own line, in its own colour: today's move and the model's lean for the next session are different things.
      const fh = m.changePct != null && m.h?.[H];
      if (fh && fh.pUp != null) {
        const pu = Math.round(100 * fh.pUp), up = pu >= 50, pc = up ? pu : 100 - pu;
        const lean = pc < 55 ? 'flat' : up ? 'up' : 'down';
        b.append(el('div', { class: 'f ' + lean, title: `Model forecast, not today's move: ${pu}% chance the ${H}-day target close is higher than now${pc < 55 ? ' (close to a coin flip)' : ''}` },
          `Next ${H}d: ${pc}% ${up ? 'higher' : 'lower'}`));
      }
      b.addEventListener('click', () => select(m.id));
      nav.append(b);
    }
    const add = el('button', { class: 'wl-add', type: 'button' }, '+ Add market');
    add.addEventListener('click', openSearch);
    nav.append(add);
    drawOverview();
    emit('mw:index');
  }

  // ---------- overview table ----------
  const disagrees = (m) => !!(m.ai && ((m.ai.stance === 'bullish' && m.score < -0.15) || (m.ai.stance === 'bearish' && m.score > 0.15)));
  let OV_SORT = { k: '', dir: -1 };
  try { OV_SORT = Object.assign(OV_SORT, JSON.parse(localStorage.getItem('ov-sort')) || {}); } catch { /* default order */ }
  function drawOverview() {
    const tb = $('ov-table'); tb.replaceChildren();
    const key = { name: (m) => (m.id === 'NATGAS' ? 'NATGAS' : m.name || '').toLowerCase(), changePct: (m) => m.changePct, lean: (m) => m.h && m.h[H] && m.h[H].pUp, rsi: (m) => m.rsi };
    const cols = [['name', 'Market'], [null, 'Price'], ['changePct', 'Today'], ['lean', `${H}-day lean`], [null, `${H}-day likely range`, 'hide-sm'], [null, 'Analyst'], [null, '15m · 1h · 1d'], ['rsi', 'RSI 14', 'hide-sm'], [null, 'Next event', 'hide-sm']];
    const head = el('tr');
    for (const [k, label, c] of cols) {
      const th = el('th', c ? { class: c } : {});
      if (k) { const b = el('button', { type: 'button', 'aria-pressed': String(OV_SORT.k === k), title: 'Sort by ' + label.toLowerCase() }, label + (OV_SORT.k === k ? (OV_SORT.dir < 0 ? ' ↓' : ' ↑') : '')); b.addEventListener('click', () => { OV_SORT = OV_SORT.k === k ? (OV_SORT.dir < 0 ? { k, dir: 1 } : { k: '', dir: -1 }) : { k, dir: k === 'name' ? 1 : -1 }; try { localStorage.setItem('ov-sort', JSON.stringify(OV_SORT)); } catch { /* ignore */ } drawOverview(); }); th.append(b); }
      else th.textContent = label;
      head.append(th);
    }
    tb.append(head);
    const rows = [...INDEX.markets];
    if (OV_SORT.k && key[OV_SORT.k]) rows.sort((a, b) => { const x = key[OV_SORT.k](a), y = key[OV_SORT.k](b); if (x == null || y == null) return (x == null) - (y == null); return (x < y ? -1 : x > y ? 1 : 0) * OV_SORT.dir; });
    for (const m of rows) {
      const tr = el('tr', { class: 'row', 'aria-current': String(m.id === CUR_ID) });
      tr.addEventListener('click', () => select(m.id));
      const dec = m.decimals ?? 3, h = m.h && m.h[H];
      const td = (cls, ...kids) => { const c = el('td', cls ? { class: cls } : {}); c.append(...kids.filter((x) => x != null)); tr.append(c); return c; };
      const sub = (t) => el('span', { class: 'sub' }, t);
      const nm = el('button', { class: 'nm', type: 'button' }, m.id === 'NATGAS' ? 'NATGAS' : m.name);
      td('', nm, sub(m.id === 'NATGAS' ? 'Henry Hub' : [m.symbol, m.exchange].filter(Boolean).join(' · ')));
      if (m.last == null) { const c = td('flat', document.createTextNode(m.error ? 'No data' : 'Preparing')); c.setAttribute('colspan', '8'); tb.append(tr); continue; }
      td('', document.createTextNode(fmtNum(m.last, dec)), sub(m.market === 'open' ? 'open' : m.market === 'break' ? 'daily break' : 'closed'));
      td(cls(m.changePct), document.createTextNode(m.changePct != null ? sp(m.changePct) : '—'));
      const leanCls = m.score > 0.15 ? 'up' : m.score < -0.15 ? 'down' : 'flat';
      td(leanCls, document.createTextNode(h ? `${Math.round(100 * h.pUp)}% higher` : '—'), sub(m.bias || ''));
      td('hide-sm', document.createTextNode(h && h.lo68 != null ? `${fmtNum(h.lo68, dec)} – ${fmtNum(h.hi68, dec)}` : '—'), h && h.events ? el('span', { class: 'sub warn' }, 'event before target') : null);
      const st = m.ai && m.ai.stance;
      td(st === 'bullish' ? 'up' : st === 'bearish' ? 'down' : 'flat', document.createTextNode(st ? st[0].toUpperCase() + st.slice(1) : '—'), disagrees(m) ? el('span', { class: 'sub warn' }, 'Disagrees with model') : null);
      { // one arrow per timeframe (15 minutes, 1 hour, 1 day) and the verdict under them
        const c = td(''), arrows = el('span', { class: 'tfa' });
        if (m.tf && m.tf.l) { for (const ch of m.tf.l) arrows.append(el('span', { class: ch === 'u' ? 'up' : ch === 'd' ? 'down' : 'flat' }, ch === 'u' ? '▲' : ch === 'd' ? '▼' : ch === 's' ? '◆' : '·')); c.append(arrows, sub(m.tf.title)); }
        else c.textContent = '—';
      }
      td('hide-sm' + (m.rsi >= 70 ? ' down' : m.rsi <= 30 ? ' up' : ''), document.createTextNode(m.rsi != null ? Math.round(m.rsi) : '—'), m.rsi >= 70 ? sub('overbought') : m.rsi <= 30 ? sub('oversold') : null);
      td('hide-sm', document.createTextNode(m.next ? m.next.name.replace(/ \(expected date\)/, '') : '—'), m.next ? sub(m.next.allDay ? dayName(m.next.date) : new Date(m.next.at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) : null);
      tb.append(tr);
    }
  }
  { let open = window.innerWidth >= 900; try { const v = localStorage.getItem('ov-open'); if (v != null) open = v === '1'; } catch { /* default */ } $('ov').open = open; }
  $('ov').addEventListener('toggle', () => { try { localStorage.setItem('ov-open', $('ov').open ? '1' : '0'); } catch { /* ignore */ } });

  // ---------- search ----------
  let COMMODITIES = null, FILTER = '', st;
  // Common CFD names -> the market most people mean (shown first)
  const ALIASES = [
    [/^(gold|xau)/i, { symbol: 'XAU/USD', instrument_name: 'Gold Spot (US dollar)', instrument_type: 'Precious Metal', _commodity: true }],
    [/^(silver|xag)/i, { symbol: 'XAG/USD', instrument_name: 'Silver Spot (US dollar)', instrument_type: 'Precious Metal', _commodity: true }],
    [/^(platinum|xpt)/i, { symbol: 'XPT/USD', instrument_name: 'Platinum Spot (US dollar)', instrument_type: 'Precious Metal', _commodity: true }],
    [/^(palladium|xpd)/i, { symbol: 'XPD/USD', instrument_name: 'Palladium Spot (US dollar)', instrument_type: 'Precious Metal', _commodity: true }],
    [/^(copper)/i, { symbol: 'HG1', instrument_name: 'Copper Spot', instrument_type: 'Industrial Metal', _commodity: true }],
    [/^(brent|uk ?oil|ukoil)/i, { symbol: 'Brent front month', instrument_name: 'Brent crude oil (front-month futures)', instrument_type: 'Energy Resource', exchange: 'ICE', _commodity: true, _builtin: true }],
    [/^(oil|crude|wti|us ?oil|usoil)/i, { symbol: 'WTI/USD', instrument_name: 'Crude Oil WTI Spot', instrument_type: 'Energy Resource', _commodity: true }],
    [/^(bitcoin|btc)/i, { symbol: 'BTC/USD', instrument_name: 'Bitcoin / US Dollar', instrument_type: 'Digital Currency', exchange: '' }],
    [/^(ethereum|eth)/i, { symbol: 'ETH/USD', instrument_name: 'Ethereum / US Dollar', instrument_type: 'Digital Currency', exchange: '' }],
    [/^(solana|sol)/i, { symbol: 'SOL/USD', instrument_name: 'Solana / US Dollar', instrument_type: 'Digital Currency', exchange: '' }],
    [/^(dax|de ?40|ger ?40|germany ?40)/i, { symbol: 'GDAXI', instrument_name: 'DAX index (Germany 40)', instrument_type: 'Index', exchange: 'XETR' }],
    [/^(s&p|sp ?500|spx|us ?500)/i, { symbol: 'SPX', instrument_name: 'S&P 500 index (US 500)', instrument_type: 'Index', exchange: 'NYSE' }],
    [/^(nasdaq|ndx|us ?tech|us ?100)/i, { symbol: 'NDX', instrument_name: 'Nasdaq 100 index (US Tech 100)', instrument_type: 'Index', exchange: 'NASDAQ' }],
    [/^(dow|djia|dji|us ?30)/i, { symbol: 'DJI', instrument_name: 'Dow Jones Industrial Average (US 30)', instrument_type: 'Index', exchange: 'NYSE' }],
    [/^(ftse|uk ?100)/i, { symbol: 'FTSE', instrument_name: 'FTSE 100 index (UK 100)', instrument_type: 'Index', exchange: 'LSE' }],
    [/^(nikkei|jp ?225|n225)/i, { symbol: 'N225', instrument_name: 'Nikkei 225 index (Japan 225)', instrument_type: 'Index', exchange: 'JPX' }]
  ];
  function openSearch() { $('search').classList.add('open'); $('q').focus(); if (!$('results').children.length) runSearch(); }
  $('search-close').addEventListener('click', () => $('search').classList.remove('open'));
  $('q').addEventListener('input', () => { clearTimeout(st); st = setTimeout(runSearch, 300); });
  document.querySelectorAll('#filters button').forEach((b) => b.addEventListener('click', () => {
    FILTER = b.dataset.f; document.querySelectorAll('#filters button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); runSearch();
  }));
  // Twelve Data says which plan each listing needs (show_plan=true). Only known paid tiers are blocked, so an unexpected answer never hides a free market.
  const paidPlan = (r) => { const p = String(r?.access?.plan || '').trim(); return /^(grow|pro|ultra|enterprise|venture)/i.test(p) ? p : ''; };
  function catOf(r) {
    const t = (r.instrument_type || r.category || '').toLowerCase();
    if (r._commodity) return /metal/.test(t) ? 'metal' : 'energy';
    if (/physical currency/.test(t)) return 'fx';
    if (/digital currency/.test(t)) return 'crypto';
    if (/index/.test(t)) return 'index';
    if (/etf/.test(t)) return 'etf';
    return 'equity';
  }
  async function runSearch() {
    const q = $('q').value.trim();
    const ul = $('results');
    let rows = [];
    try {
      if (!COMMODITIES) COMMODITIES = (await fetch('https://api.twelvedata.com/commodities').then((r) => r.json())).data || [];
      const ql = q.toLowerCase();
      const com = COMMODITIES.filter((c) => !q || c.symbol.toLowerCase().includes(ql) || c.name.toLowerCase().includes(ql) || (c.category || '').toLowerCase().includes(ql))
        .map((c) => ({ symbol: c.symbol, instrument_name: c.name, instrument_type: c.category, exchange: '', _commodity: true }));
      let api = [];
      if (q.length >= 2) api = (await fetch(`https://api.twelvedata.com/symbol_search?symbol=${encodeURIComponent(q)}&outputsize=30&show_plan=true`).then((r) => r.json())).data || [];
      const al = q ? ALIASES.filter(([re]) => re.test(q)).map(([, r]) => ({ ...r, exchange: r.exchange || '', _alias: true })) : [];
      rows = [...al, ...com, ...api].filter((r, i, arr) => arr.findIndex((x) => x.symbol === r.symbol && (x.exchange || '') === (r.exchange || '')) === i);
    } catch (e) { ul.replaceChildren(el('li', {}, 'Search is unavailable right now (' + e.message + ').')); return; }
    const want = (r) => { const c = catOf(r); return !FILTER || (FILTER === 'commodity' ? ['metal', 'energy'].includes(c) : FILTER === 'equity' ? ['equity', 'etf'].includes(c) : c === FILTER); };
    const Q = q.toUpperCase();
    const prefer = (r) => (paidPlan(r) ? 10 : 0) + (r._alias ? -4 : r.symbol.toUpperCase() === Q && !/stock/i.test(r.instrument_type || '') || r.symbol.toUpperCase().replace('/', '') === Q.replace('/', '') ? -3
      : r._commodity && /\/USD$/.test(r.symbol) && !/gram/i.test(r.instrument_name) ? -2
      : /\/USD$/.test(r.symbol) && /physical currency|digital currency/i.test(r.instrument_type) ? -1
      : r._commodity ? 0 : /physical currency|digital currency|index/i.test(r.instrument_type) ? 1 : /^(NASDAQ|NYSE)$/i.test(r.exchange) ? 2 : 3);
    rows = rows.filter(want).filter((r) => !/warrant|certificate|structured|bond/i.test(r.instrument_type || '')).sort((a, b) => prefer(a) - prefer(b)).slice(0, 25);
    const have = new Set(INDEX.markets.map((m) => m.symbol + '|' + (m.exchange || '')));
    ul.replaceChildren(...rows.map((r) => {
      const cat = catOf(r);
      const li = el('li');
      const left = el('div');
      left.append(el('div', { class: 'rn' }, `${r.instrument_name}`), el('div', { class: 'rm' }, [r.symbol, r.exchange, r.country, catName(cat)].filter(Boolean).join(' · ')));
      const exch = ['equity', 'etf', 'index'].includes(cat) ? r.exchange : '';
      const already = have.has(r.symbol + '|' + exch) || have.has(r.symbol + '|');
      const full = INDEX.markets.filter((m) => m.id !== 'NATGAS').length >= (INDEX.maxMarkets || 8);
      const paid = paidPlan(r);
      const btn = already ? el('span', { class: 'rm' }, 'On your list')
        : paid ? el('span', { class: 'rm', title: `This listing needs the Twelve Data ${paid} plan. Pick the US listing, which is in the free plan.` }, `Paid data plan (${paid})`)
        : r._builtin ? el('span', { class: 'rm', title: 'Uses a separate free data source; ask Claude to add it back' }, 'Ask Claude to add')
        : el('a', { class: 'btn', target: '_blank', rel: 'noopener', href: issueUrl(`watchlist: add ${r.symbol}`, { action: 'add', symbol: r.symbol, name: r.instrument_name, exchange: exch, type: r.instrument_type || '', category: cat }), title: full ? 'Watchlist is full (8 markets): remove one first' : 'Opens a pre-filled request on GitHub' }, full ? 'List full' : 'Add');
      li.append(left, btn); return li;
    }));
    if (!rows.length) ul.replaceChildren(el('li', {}, q ? 'No matches. Try the symbol (e.g. XAU/USD, EUR/USD, AAPL, BTC/USD).' : 'Type to search.'));
  }

  function setTabs() {
    document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-selected', String(+b.dataset.h === H)));
  }
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    H = +b.dataset.h; setHash(); drawWatchlist(); render();
  }));
  window.addEventListener('hashchange', () => { const ph = parseHash(); if (ph.h) H = ph.h; if (ph.id && ph.id !== CUR_ID) { CUR_ID = ph.id; drawWatchlist(); loadMarket(); } else render(); });
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 120); });

  function statusLine() {
    if (!DATA) return;
    const mk = { open: 'Market open', closed: 'Market closed', break: 'Daily break (17:00–18:00 ET)' }[DATA.market] || '';
    $('status').textContent = `${mk} · data ${ago(DATA.generatedAt)} · page checks every minute`;
    $('dot').className = 'dot' + (DATA.market === 'open' ? ' open' : '');
    const age = (Date.now() - Date.parse(DATA.generatedAt)) / 60000;
    const b = $('banner');
    if (DATA.price.stale) { b.textContent = 'Price sources did not answer on the last refresh; showing the last good price.'; b.className = 'banner show'; }
    else if (age > 15) { b.textContent = `The server data is ${Math.round(age)} minutes old (it normally refreshes every few minutes). Numbers below may be out of date.`; b.className = 'banner show'; }
    else b.className = 'banner';
  }

  // Edison Growth (edison.html) runs this same file and listens for these events to draw its own extras; Classic ignores them.
  const mwState = () => ({ DATA, INDEX, H, CUR_ID });
  const emit = (name) => { try { document.dispatchEvent(new CustomEvent(name, { detail: mwState() })); } catch { /* old browser */ } };
  function render() { try { renderInner(); } finally { emit('mw:render'); } }
  function renderInner() {
    setTabs();
    if (!DATA) { if (document.body.classList.contains('nodata')) { setView(); tvUpdate(); } return; }
    document.body.classList.toggle('nodata', !DATA.price);
    if (!DATA.price) {
      $('status').textContent = 'Waiting for price data'; $('dot').className = 'dot';
      const b = $('banner'); b.className = 'banner show';
      b.textContent = 'The price sources did not answer on the last server refresh (' + ago(DATA.generatedAt) + '). The page will fill in automatically once they do.';
      pcDestroy(); PC.key = null;
      setView(); tvUpdate(); drawTg();
      return;
    }
    const meta = DATA.meta || { id: 'NATGAS', name: 'Natural gas (Henry Hub)', symbol: 'NG front month', category: 'energy' };
    const isNG = meta.id === 'NATGAS';
    DEC = meta.decimals && !isNG ? meta.decimals : 3;
    CUR = isNG || meta.provider === 'cnbc' || (meta.category !== 'fx' && /\/USD$/.test(meta.symbol || '')) || /^(NASDAQ|NYSE|NYSE ARCA|CBOE|AMEX|BATS)$/i.test(meta.exchange || '') ? '$' : '';
    setHeader(meta);
    statusLine();
    const p = DATA.price, f = DATA.forecast, h = f.horizons[H];
    const closeWord = isNG || meta.provider === 'cnbc' ? 'settlement' : 'close';
    $('price').textContent = usd(p.last);
    $('chg').className = 'chg ' + cls(p.change);
    $('chg').textContent = p.change == null ? '' : `${p.change > 0 ? '+' : p.change < 0 ? '−' : ''}${Math.abs(p.change).toFixed(DEC)} (${sp(p.changePct)})`;
    $('asof').textContent = `Last trade ${new Date(p.asOf).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })} · vs previous ${closeWord} ${usd(p.prevClose)} · ${p.source || ''}`;

    $('fc-title').textContent = `${H}-day forecast · ${closeWord} ${dayName(h.targetDate)}`;
    const bc = f.score > 0.15 ? 'up' : f.score < -0.15 ? 'down' : 'flat';
    $('bias').textContent = f.bias; $('bias').className = 'bias ' + bc;
    $('fc-center').textContent = usd(h.center, 2);
    $('fc-pct').textContent = sp(h.changePct) + ' expected';
    $('fc-pct').className = 'fc-pct ' + cls(h.changePct);
    $('pb-down').style.width = (100 * (1 - h.pUp)).toFixed(1) + '%';
    $('pb-up').style.width = (100 * h.pUp).toFixed(1) + '%';
    $('p-down').textContent = `Model lean: ${Math.round(100 * (1 - h.pUp))}% lower`;
    $('p-up').textContent = `${Math.round(100 * h.pUp)}% higher`;
    $('r68').textContent = `${usd(h.lo68, 2)} – ${usd(h.hi68, 2)}`;
    $('r90').textContent = `${usd(h.lo90, 2)} – ${usd(h.hi90, 2)}`;
    drawFcTimeframes(f);
    drawEvents(h);

    drawTimeframes(); drawAI(); setView(); tvUpdate(); pcUpdate(); drawTrack(); drawIntraday(); drawSignals(); drawLevels(); drawRisk(); drawNews(); drawAlerts(); drawSources();
    $('method').textContent = DATA.method;
  }

  // ---------- main chart ----------
  function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw))); const m = raw / p; return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p; }
  function showTip(box, tip, ev, lines) {
    tip.replaceChildren(...lines.map((l, i) => el('div', i === 0 ? { class: 'h' } : {}, l)));
    tip.hidden = false;
    const r = box.getBoundingClientRect();
    let lx = ev.clientX - r.left + 12, ly = ev.clientY - r.top - 10;
    if (lx + tip.offsetWidth > box.clientWidth) lx = ev.clientX - r.left - tip.offsetWidth - 12;
    tip.style.left = Math.max(0, lx) + 'px'; tip.style.top = Math.max(0, Math.min(ly, box.clientHeight - tip.offsetHeight)) + 'px';
  }

  // ---------- AI analyst card ----------
  function drawAI() {
    const box = $('ai-body'); box.replaceChildren();
    const a = DATA.ai, pill = $('ai-stance');
    pill.hidden = true;
    if (!a || a.status === 'off') { box.append(el('p', { class: 'empty' }, 'AI analyst is waiting for its free Groq key: add a GROQ_API_KEY repository secret (see README).')); return; }
    // the free AI allowance is used up until a.waitUntil
    const paused = a.waitUntil && Date.parse(a.waitUntil) > Date.now() ? new Date(a.waitUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    if (a.status === 'pending') { box.append(el('p', { class: 'empty' }, paused ? `The free AI allowance is used up for now, so the first analyst note for this market is written after about ${paused}.` : 'The first analyst note for this market is being written. It appears within about 10 minutes.')); return; }
    if (a.status === 'error') { box.append(el('p', { class: 'empty' }, paused ? `The free AI allowance is used up for now; the analyst note is tried again after about ${paused}.` : `The analyst note could not be written: ${a.error || 'unknown error'}. It retries on the next refresh.`)); return; }
    pill.hidden = false;
    pill.textContent = `${a.stance[0].toUpperCase() + a.stance.slice(1)} · ${a.confidence} confidence`;
    pill.className = 'bias ' + (a.stance === 'bullish' ? 'up' : a.stance === 'bearish' ? 'down' : 'flat');
    const fScore = DATA.forecast.score;
    if ((a.stance === 'bullish' && fScore < -0.15) || (a.stance === 'bearish' && fScore > 0.15)) box.append(el('p', { class: 'ev-line', style: 'margin:10px 0 0' }, `The analyst (${a.stance}) and the quant model (${DATA.forecast.bias.toLowerCase()}) point in opposite directions here. Treat the direction as unsettled.`));
    box.append(el('h3', {}, a.headline), el('p', {}, a.summary));
    const ol = a.outlook?.[`${H}d`];
    if (ol) { const d = el('div', { class: 'ai-outlook' }); d.append(el('b', {}, `Next ${H} day${H > 1 ? 's' : ''}: `), document.createTextNode(ol)); box.append(d); }
    const cols = el('div', { class: 'cols' });
    const section = (title, items) => { if (!items?.length) return null; const d = el('div'); d.append(el('h4', {}, title)); const ul = el('ul'); items.forEach((t) => ul.append(el('li', {}, t))); d.append(ul); return d; };
    [section('Chart', a.chart), section('News flow', a.news)].forEach((d) => d && cols.append(d));
    const lv = el('div');
    if (a.levels?.support?.length || a.levels?.resistance?.length) {
      lv.append(el('h4', {}, 'Levels to watch'));
      const row = el('div', { class: 'lv' });
      (a.levels.resistance || []).forEach((v) => row.append(el('span', { class: 'down' }, `R ${fmtNum(v, DEC)}`)));
      (a.levels.support || []).forEach((v) => row.append(el('span', { class: 'up' }, `S ${fmtNum(v, DEC)}`)));
      lv.append(row); cols.append(lv);
    }
    [section('What would change the view', a.flip), section('Risks to watch', a.risks)].forEach((d) => d && cols.append(d));
    box.append(cols);
    const id = String(a.model || '');
    const pretty = (x) => x.replace(/^.*\//, '').replace(/^gpt-/i, 'GPT-').replace(/-mini$/i, ' mini').replace(/^llama-/i, 'Llama ').replace(/-versatile$/i, '').replace(/-/g, ' ');
    const model = a.provider === 'github' ? `${pretty(id)} via GitHub Models`
      : a.provider === 'groq' ? `${pretty(id)} via Groq`
      : id.replace(/^claude-/, 'Claude ').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-/g, ' ').replace(/\b(opus|sonnet|haiku|fable)\b/i, (w) => w[0].toUpperCase() + w.slice(1));
    box.append(el('div', { class: 'foot' }, `Written ${ago(a.at)} by ${model} when price was ${usd(a.price)}. It weighs the chart and news above; refreshed about every hour while the market is open (every 6 hours when closed), sooner after big moves.${paused ? ` The free AI allowance is used up for now, so this note is kept until about ${paused}.` : a.lastError ? ' Last refresh attempt failed, showing the previous note.' : ''} Market commentary, not financial advice.`));
  }

  // ---------- pro chart (TradingView Lightweight Charts) ----------
  const LWC = window.LightweightCharts;
  const PC = { main: null, rsi: null, macd: null, s: {}, key: null, themeKey: null, syncing: false, legendMap: null, n: 0, future: 0 };
  const store = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
  let PC_TF = store('pc-tf', '6M');
  const PC_SHOW = Object.assign({ ma20: true, ma50: true, ma200: false, bb: false, fc: true, rsi: true, macd: false }, store('pc-show', {}));
  const TF_BARS = { '1M': 22, '3M': 66, '6M': 130, '1Y': 260 };
  if (!['1D', '1W', '1M', '3M', '6M', '1Y'].includes(PC_TF)) PC_TF = '6M';

  const cssVar = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const probeEl = document.createElement('span');
  function rgba(v) { // resolve a theme colour (incl. #rrggbbaa) to rgb()/rgba() for the chart canvas
    if (!probeEl.isConnected) { probeEl.style.display = 'none'; document.body.append(probeEl); }
    probeEl.style.color = '';
    probeEl.style.color = v.startsWith('--') ? `var(${v})` : v;
    return getComputedStyle(probeEl).color;
  }
  function sd(a) { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); }
  const IND = {
    sma(c, n) { const o = new Array(c.length).fill(null); let t = 0; for (let i = 0; i < c.length; i++) { t += c[i]; if (i >= n) t -= c[i - n]; if (i >= n - 1) o[i] = t / n; } return o; },
    ema(c, n) { const o = new Array(c.length).fill(null); const k = 2 / (n + 1); let e = null; for (let i = 0; i < c.length; i++) { if (i === n - 1) e = c.slice(0, n).reduce((a, b) => a + b, 0) / n; else if (i >= n) e = c[i] * k + e * (1 - k); if (i >= n - 1) o[i] = e; } return o; },
    rsi(c, n = 14) {
      const o = new Array(c.length).fill(null); let g = 0, l = 0;
      for (let i = 1; i < c.length; i++) {
        const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
        if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
        else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
      }
      return o;
    },
    bb(c, n = 20, k = 2) {
      const m = IND.sma(c, n);
      const dev = m.map((v, i) => (v == null ? null : sd(c.slice(i - n + 1, i + 1))));
      return { mid: m, up: m.map((v, i) => (v == null ? null : v + k * dev[i])), lo: m.map((v, i) => (v == null ? null : v - k * dev[i])) };
    },
    macd(c) {
      const a = IND.ema(c, 12), b = IND.ema(c, 26);
      const line = c.map((_, i) => (a[i] == null || b[i] == null ? null : a[i] - b[i]));
      const start = line.findIndex((v) => v != null);
      const sig = new Array(c.length).fill(null);
      if (start >= 0) IND.ema(line.slice(start), 9).forEach((v, j) => { sig[start + j] = v; });
      return { line, sig, hist: line.map((v, i) => (v == null || sig[i] == null ? null : v - sig[i])) };
    }
  };

  function chartOpts() {
    return {
      autoSize: true,
      layout: { background: { type: 'solid', color: rgba('--panel') }, textColor: rgba('--muted'), fontFamily: cssVar('--font') || 'sans-serif', fontSize: 11 },
      grid: { vertLines: { color: rgba('--grid') }, horzLines: { color: rgba('--grid') } },
      rightPriceScale: { borderColor: rgba('--line'), minimumWidth: 64 },
      timeScale: { borderColor: rgba('--line'), rightOffset: 3, minBarSpacing: 2 },
      crosshair: { mode: LWC.CrosshairMode.Normal, vertLine: { color: rgba('--cursor'), labelBackgroundColor: rgba('--muted') }, horzLine: { color: rgba('--cursor'), labelBackgroundColor: rgba('--muted') } },
      localization: { priceFormatter: (v) => fmtNum(v, DEC) }
    };
  }
  function pcDestroy() { for (const k of ['main', 'rsi', 'macd']) if (PC[k]) { PC[k].remove(); PC[k] = null; } PC.s = {}; PC.pl = []; }
  // extra horizontal lines on the Forecast view (Edison Growth draws stop / target / key levels with these)
  let EXTRA_LINES = [];
  function applyExtraLines() {
    const c = PC.s.candles; if (!c) return;
    (PC.pl || []).forEach((l) => { try { c.removePriceLine(l); } catch { /* gone */ } });
    PC.pl = EXTRA_LINES.filter((x) => x && isFinite(x.price)).map((x) => c.createPriceLine({ price: x.price, color: rgba(x.color || '--muted'), lineWidth: x.width || 1, lineStyle: x.solid ? LWC.LineStyle.Solid : LWC.LineStyle.Dashed, axisLabelVisible: x.label !== false, title: x.title || '' }));
  }
  function pcBuild() {
    pcDestroy();
    const o = chartOpts();
    const sub = { ...o, layout: { ...o.layout, attributionLogo: false }, timeScale: { ...o.timeScale, visible: false }, rightPriceScale: { ...o.rightPriceScale, scaleMargins: { top: 0.15, bottom: 0.08 } } };
    PC.main = LWC.createChart($('pc-main'), o);
    PC.rsi = LWC.createChart($('pc-rsi'), sub);
    PC.macd = LWC.createChart($('pc-macd'), sub);
    const line = (chart, color, extra = {}) => chart.addLineSeries({ color: rgba(color), lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...extra });
    PC.s.candles = PC.main.addCandlestickSeries({ upColor: rgba('--up'), downColor: rgba('--down'), wickUpColor: rgba('--up'), wickDownColor: rgba('--down'), borderVisible: false });
    PC.s.ma20 = line(PC.main, '--c-ma20'); PC.s.ma50 = line(PC.main, '--c-ma50'); PC.s.ma200 = line(PC.main, '--c-ma200');
    PC.s.bbU = line(PC.main, '--c-bb', { lineWidth: 1 }); PC.s.bbL = line(PC.main, '--c-bb', { lineWidth: 1 });
    PC.s.bbM = line(PC.main, '--c-bb', { lineWidth: 1, lineStyle: LWC.LineStyle.Dotted });
    PC.s.fcC = line(PC.main, '--fg', { lineStyle: LWC.LineStyle.Dashed, lineWidth: 2 });
    PC.s.fcH = line(PC.main, '--muted', { lineStyle: LWC.LineStyle.Dashed, lineWidth: 1 });
    PC.s.fcL = line(PC.main, '--muted', { lineStyle: LWC.LineStyle.Dashed, lineWidth: 1 });
    PC.s.rsi = line(PC.rsi, '--accent', { lastValueVisible: true });
    PC.s.rsi.createPriceLine({ price: 70, color: rgba('--down'), lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: false });
    PC.s.rsi.createPriceLine({ price: 30, color: rgba('--up'), lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: false });
    PC.s.hist = PC.macd.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
    PC.s.macd = line(PC.macd, '--accent'); PC.s.sig = line(PC.macd, '--c-signal');
    // keep the three panes panned and zoomed together
    const charts = [PC.main, PC.rsi, PC.macd];
    charts.forEach((c) => c.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (PC.syncing || !r) return;
      PC.syncing = true; charts.forEach((d) => { if (d !== c) d.timeScale().setVisibleLogicalRange(r); }); PC.syncing = false;
    }));
    PC.main.subscribeCrosshairMove((p) => pcLegend(p && p.time));
    PC.themeKey = cssVar('--bg');
  }
  function timeKey(t) { return typeof t === 'string' ? t : typeof t === 'number' ? String(t) : t && t.year ? `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}` : null; }
  function pcLegend(time) {
    const L = PC.legendMap; if (!L) return;
    const t = (time && L.get(timeKey(time))) || L.get('__last');
    const box = $('pc-legend'); box.replaceChildren();
    if (!t) return;
    const add = (label, val, color) => { const s1 = el('span'); if (color) s1.style.color = rgba(color); if (label) s1.append(document.createTextNode(label + ' ')); s1.append(el('b', {}, val)); box.append(s1); };
    box.append(el('span', {}, t.label));
    if (t.o != null) { add('O', fmtNum(t.o, DEC)); add('H', fmtNum(t.h, DEC)); add('L', fmtNum(t.l, DEC)); add('C', fmtNum(t.c, DEC)); if (t.chg != null) add('', sp(t.chg)); }
    if (PC_SHOW.ma20 && t.ma20 != null) add('MA20', fmtNum(t.ma20, DEC), '--c-ma20');
    if (PC_SHOW.ma50 && t.ma50 != null) add('MA50', fmtNum(t.ma50, DEC), '--c-ma50');
    if (PC_SHOW.ma200 && t.ma200 != null) add('MA200', fmtNum(t.ma200, DEC), '--c-ma200');
    if (PC_SHOW.bb && t.bbU != null) add('BB', `${fmtNum(t.bbL, DEC)}–${fmtNum(t.bbU, DEC)}`, '--c-bb');
    if (t.fc) add('Forecast', `${fmtNum(t.fc[1], DEC)} (${fmtNum(t.fc[0], DEC)}–${fmtNum(t.fc[2], DEC)})`);
    const md = DEC > 3 ? DEC : 3;
    $('pc-rsi-tag').textContent = t.rsi != null ? `RSI 14 · ${t.rsi.toFixed(1)}` : 'RSI 14';
    $('pc-macd-tag').textContent = t.macd != null ? `MACD 12, 26, 9 · ${t.macd.toFixed(md)} · signal ${t.sig != null ? t.sig.toFixed(md) : '—'}` : 'MACD 12, 26, 9';
  }
  function futureDates(lastISO, n, everyDay) {
    const out = []; let d = new Date(lastISO + 'T00:00:00Z');
    while (out.length < n) { d = new Date(d.getTime() + 864e5); if (everyDay || d.getUTCDay() % 6 !== 0) out.push(d.toISOString().slice(0, 10)); }
    return out;
  }
  function pcSetVisibility() {
    const v = (k, on) => { if (PC.s[k]) PC.s[k].applyOptions({ visible: !!on }); };
    v('ma20', PC_SHOW.ma20); v('ma50', PC_SHOW.ma50); v('ma200', PC_SHOW.ma200);
    ['bbU', 'bbL', 'bbM'].forEach((k) => v(k, PC_SHOW.bb));
    ['fcC', 'fcH', 'fcL'].forEach((k) => v(k, PC_SHOW.fc));
    $('pc-rsi-box').hidden = !PC_SHOW.rsi; $('pc-macd-box').hidden = !PC_SHOW.macd;
    document.querySelectorAll('#pc-tools button').forEach((b) => b.setAttribute('aria-pressed', String(!!PC_SHOW[b.dataset.k])));
    document.querySelectorAll('#pc-tf button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tf === PC_TF)));
  }
  function pcRange() {
    if (!PC.main || !PC.n) return;
    if (INTRA[PC_TF]) { PC.main.timeScale().fitContent(); return; }
    const to = PC.n - 1 + PC.future + 2;
    const from = Math.max(-1, PC.n - (TF_BARS[PC_TF] || 130));
    PC.main.timeScale().setVisibleLogicalRange({ from, to });
  }
  const INTRA = { '1D': { ms: 24 * 36e5, bucket: 15 * 60e3, name: '15-minute' }, '1W': { ms: 7 * 864e5, bucket: 60 * 60e3, name: '1-hour' } };
  function intradayRows(samples, cfg) {
    const pts = (samples || []).filter((q) => q && q[1] > 0);
    if (!pts.length) return [];
    const lastT = pts[pts.length - 1][0], buckets = new Map();
    let prev = null;
    for (const s of pts) {
      const [t, c, sh, sl] = s, was = prev; prev = s;
      if (lastT - t > cfg.ms) continue;
      const k = Math.floor(t / cfg.bucket) * cfg.bucket;
      let b = buckets.get(k);
      if (!b) buckets.set(k, b = { k, open: c, high: c, low: c, close: c });
      else { b.high = Math.max(b.high, c); b.low = Math.min(b.low, c); b.close = c; }
      // A sample also carries the session's high and low so far. If one of them moved since the previous sample
      // (same session, at most ~15 minutes earlier), that extreme was traded in between: draw it as this candle's wick.
      if (sh > 0 && sl > 0 && was && was[2] > 0 && was[3] > 0 && t - was[0] <= 16 * 60e3 && sh >= was[2] && sl <= was[3]) {
        if (sh > was[2] && sh < c * 1.25) b.high = Math.max(b.high, sh);
        if (sl < was[3] && sl > c * 0.8) b.low = Math.min(b.low, sl);
      }
    }
    // the chart library draws in UTC; shift so the axis shows this browser's local time
    return [...buckets.values()].sort((x, y) => x.k - y.k)
      .map((r) => ({ time: Math.round(r.k / 1000 - new Date(r.k).getTimezoneOffset() * 60), open: r.open, high: r.high, low: r.low, close: r.close, k: r.k }));
  }
  function pcUpdate() {
    if (pcView() !== 'forecast') return;
    if (!LWC) { $('pc-main').textContent = 'The chart library did not load. Reload the page to try again.'; return; }
    const p = DATA.price, f = DATA.forecast, id = DATA.meta?.id || 'NATGAS';
    const intra = INTRA[PC_TF] || null, mode = intra ? PC_TF : 'daily';
    const bars = (p.daily || []).filter((b) => b.c != null);
    if (!bars.length) return;
    const rebuild = !PC.main || PC.themeKey !== cssVar('--bg') || PC.mode !== mode;
    const keepRange = !rebuild && PC.key === id && PC.h === H ? PC.main.timeScale().getVisibleLogicalRange() : null;
    if (rebuild) { pcBuild(); PC.mode = mode; PC.main.applyOptions({ timeScale: { timeVisible: !!intra, secondsVisible: false } }); }
    let rows, labelOf;
    const note = $('pc-note');
    if (intra) {
      rows = intradayRows(p.intraday, intra);
      const fmtT = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
      labelOf = (r) => fmtT(r.k);
      const span = p.intraday && p.intraday.length ? p.intraday[p.intraday.length - 1][0] - p.intraday[0][0] : 0;
      note.hidden = false;
      note.textContent = rows.length < 4
        ? `${intra.name} candles appear as the server records prices (every few minutes while the market is open). Not enough yet for this view, so check back shortly.`
        : `${intra.name} candles built from the prices recorded every few minutes${rows[0] ? ` since ${fmtT(rows[0].k)}` : ''}. New session highs and lows are drawn as wicks; other moves between recordings are not captured.${PC_TF === '1W' && span < 6 * 864e5 ? ' The week view fills in over the coming days.' : ''}`;
    } else {
      note.hidden = true;
      const okv = (v, c) => (v != null && v > c * 0.5 && v < c * 2 ? v : null); // ignore zero / broken ticks
      rows = bars.map((b) => { const o = okv(b.o, b.c) ?? b.c; return { time: b.date, open: o, high: Math.max(okv(b.h, b.c) ?? b.c, o, b.c), low: Math.min(okv(b.l, b.c) ?? b.c, o, b.c), close: b.c }; });
      const lastRow = rows[rows.length - 1];
      if (p.last != null) { lastRow.close = p.last; lastRow.high = Math.max(lastRow.high, p.last); lastRow.low = Math.min(lastRow.low, p.last); }
      labelOf = (r) => dayName(r.time);
    }
    const closes = rows.map((r) => r.close), times = rows.map((r) => r.time);
    const fut = intra || !rows.length ? [] : futureDates(times[times.length - 1], H, DATA.meta?.category === 'crypto');
    const ws = fut.map((t) => ({ time: t }));
    const asLine = (arr) => arr.map((v, i) => (v == null ? { time: times[i] } : { time: times[i], value: v })).concat(ws);
    PC.s.candles.applyOptions({ priceFormat: { type: 'price', precision: DEC, minMove: 1 / 10 ** DEC } });
    PC.s.candles.setData(rows.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })).concat(ws));
    const ma20 = IND.sma(closes, 20), ma50 = IND.sma(closes, 50), ma200 = IND.sma(closes, 200), bb = IND.bb(closes), rsi = IND.rsi(closes), mac = IND.macd(closes);
    PC.s.ma20.setData(asLine(ma20)); PC.s.ma50.setData(asLine(ma50)); PC.s.ma200.setData(asLine(ma200));
    PC.s.bbU.setData(asLine(bb.up)); PC.s.bbL.setData(asLine(bb.lo)); PC.s.bbM.setData(asLine(bb.mid));
    PC.s.rsi.setData(asLine(rsi));
    PC.s.macd.setData(asLine(mac.line)); PC.s.sig.setData(asLine(mac.sig));
    const upC = rgba('--up'), dnC = rgba('--down');
    PC.s.hist.setData(mac.hist.map((v, i) => (v == null ? { time: times[i] } : { time: times[i], value: v, color: v >= 0 ? upC : dnC })).concat(ws));
    // forecast lines (daily views only): centre and 68% band, same maths as the forecast card
    let fcPts = [];
    if (!intra && rows.length) {
      const mu = f.score * 0.25 * f.sigmaDaily, sg = f.sigmaDaily, L0 = p.last ?? closes[closes.length - 1];
      fcPts = [{ time: times[times.length - 1], c: L0, h: L0, l: L0 }].concat(fut.map((t, k) => ({
        time: t, c: L0 * Math.exp(mu * (k + 1)), h: L0 * Math.exp(mu * (k + 1) + sg * Math.sqrt(k + 1)), l: L0 * Math.exp(mu * (k + 1) - sg * Math.sqrt(k + 1))
      })));
    }
    PC.s.fcC.setData(fcPts.map((x) => ({ time: x.time, value: x.c })));
    PC.s.fcH.setData(fcPts.map((x) => ({ time: x.time, value: x.h })));
    PC.s.fcL.setData(fcPts.map((x) => ({ time: x.time, value: x.l })));
    // legend lookup
    const map = new Map();
    rows.forEach((r, i) => map.set(String(r.time), { label: labelOf(r), o: r.open, h: r.high, l: r.low, c: r.close, chg: i ? 100 * (r.close / rows[i - 1].close - 1) : null, ma20: ma20[i], ma50: ma50[i], ma200: ma200[i], bbU: bb.up[i], bbL: bb.lo[i], rsi: rsi[i], macd: mac.line[i], sig: mac.sig[i] }));
    fcPts.slice(1).forEach((x) => map.set(String(x.time), { label: dayName(x.time) + ' (forecast)', fc: [x.l, x.c, x.h] }));
    if (times.length) map.set('__last', map.get(String(times[times.length - 1])));
    PC.legendMap = map;
    PC.n = rows.length; PC.future = fut.length; PC.key = id; PC.h = H;
    pcSetVisibility();
    if (keepRange) PC.main.timeScale().setVisibleLogicalRange(keepRange); else pcRange();
    pcLegend(null);
    applyExtraLines();
  }
  document.querySelectorAll('#pc-tf button').forEach((b) => b.addEventListener('click', () => { const was = INTRA[PC_TF] ? PC_TF : 'daily'; PC_TF = b.dataset.tf; keep('pc-tf', PC_TF); const now = INTRA[PC_TF] ? PC_TF : 'daily'; if (was !== now && DATA) pcUpdate(); else { pcSetVisibility(); pcRange(); } }));
  document.querySelectorAll('#pc-tools button').forEach((b) => b.addEventListener('click', () => { PC_SHOW[b.dataset.k] = !PC_SHOW[b.dataset.k]; keep('pc-show', PC_SHOW); pcSetVisibility(); pcLegend(null); }));

  // ---------- chart views + live chart (TradingView Advanced Chart widget: free, no key, data included) ----------
  let PC_VIEW = store('pc-view', 'live'); if (!['live', 'forecast'].includes(PC_VIEW)) PC_VIEW = 'live';
  function pcView() { return document.body.classList.contains('nodata') ? 'live' : PC_VIEW; }
  function setView() {
    const v = pcView(), c = $('pc-card');
    c.classList.toggle('view-live', v === 'live'); c.classList.toggle('view-forecast', v === 'forecast');
    document.querySelectorAll('#pc-view button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
  }
  document.querySelectorAll('#pc-view button').forEach((b) => b.addEventListener('click', () => {
    PC_VIEW = b.dataset.v; keep('pc-view', PC_VIEW); setView();
    if (pcView() === 'live') tvUpdate(); else if (DATA && DATA.price) requestAnimationFrame(pcUpdate);
  }));
  // TradingView names for the markets on the watchlist. Futures (NYMEX, ICE) are not in the free widget, so commodities and indices use CFD symbols.
  const TV_EXCH = { NASDAQ: 'NASDAQ', NYSE: 'NYSE', 'NYSE ARCA': 'AMEX', 'NYSE AMERICAN': 'AMEX', AMEX: 'AMEX', CBOE: 'CBOE', BATS: 'CBOE', OTC: 'OTC', XETR: 'XETR', XETRA: 'XETR', LSE: 'LSE', EURONEXT: 'EURONEXT', BVB: 'BVB', SIX: 'SIX', TSX: 'TSX', TSXV: 'TSXV', BME: 'BME', ASX: 'ASX', HKEX: 'HKEX', NSE: 'NSE', BSE: 'BSE' };
  const TV_MAP = { 'XAU/USD': 'OANDA:XAUUSD', 'XAG/USD': 'OANDA:XAGUSD', 'XPT/USD': 'OANDA:XPTUSD', 'XPD/USD': 'OANDA:XPDUSD', HG1: 'OANDA:XCUUSD', 'WTI/USD': 'TVC:USOIL', 'XTI/USD': 'TVC:USOIL', 'BRENT/USD': 'TVC:UKOIL', 'XBR/USD': 'TVC:UKOIL', 'NG/USD': 'OANDA:NATGASUSD',
    SPX: 'FOREXCOM:SPXUSD', NDX: 'FOREXCOM:NSXUSD', DJI: 'FOREXCOM:DJI', GDAXI: 'INDEX:DEU40', FTSE: 'FOREXCOM:UKXGBP', N225: 'INDEX:NKY' };
  function tvDefault(m) {
    if (!m) return '';
    if (m.tv) return String(m.tv);
    if (m.id === 'NATGAS') return 'OANDA:NATGASUSD';
    if (m.id === 'BRENT') return 'TVC:UKOIL';
    const sym = String(m.symbol || '').toUpperCase().trim();
    if (!sym) return '';
    if (TV_MAP[sym]) return TV_MAP[sym];
    const pair = sym.match(/^([A-Z0-9]+)\/([A-Z0-9]+)$/);
    if (pair) {
      const [, b, q] = pair;
      if (m.category === 'crypto') return `BINANCE:${b}${q === 'USD' ? 'USDT' : q}`;
      if (m.category === 'fx') return `FX_IDC:${b}${q}`;
      if (m.category === 'metal') return `OANDA:${b}${q}`;
      return b + q;
    }
    if (!/^[A-Z0-9.\-]+$/.test(sym)) return '';
    const ex = TV_EXCH[String(m.exchange || '').toUpperCase()];
    return ex ? `${ex}:${sym}` : sym;
  }
  const TV_OVR = store('tv-sym', {}); // per-market symbol typed by the user
  const tvMeta = () => (DATA && DATA.meta) || (INDEX && INDEX.markets.find((m) => m.id === CUR_ID)) || { id: CUR_ID };
  const tvSymbolFor = (m) => TV_OVR[m.id] || tvDefault(m);
  const isLight = () => { const c = (rgba('--bg').match(/[\d.]+/g) || [0, 0, 0]).map(Number); return (c[0] + c[1] + c[2]) / 3 > 128; };
  let TV_KEY = '';
  function tvUpdate() {
    const m = tvMeta(), sym = tvSymbolFor(m), box = $('tv-box');
    if (document.activeElement !== $('tv-input')) $('tv-input').value = sym;
    $('tv-reset').hidden = !TV_OVR[m.id];
    if (pcView() !== 'live') return;
    const theme = isLight() ? 'light' : 'dark';
    const key = `${sym}|${theme}`;
    if (key === TV_KEY && box.firstChild) return;
    TV_KEY = key; box.replaceChildren();
    if (!sym) { box.append(el('p', { class: 'note', style: 'padding:16px' }, 'No TradingView symbol is known for this market yet. Type one below (for example NASDAQ:AAPL, OANDA:XAUUSD, FX_IDC:EURUSD) and press Apply.')); return; }
    let tz = 'Etc/UTC'; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz; } catch { /* keep UTC */ }
    const wrap = el('div', { class: 'tradingview-widget-container' });
    wrap.append(el('div', { class: 'tradingview-widget-container__widget' }));
    const sc = document.createElement('script');
    sc.type = 'text/javascript'; sc.async = true;
    sc.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    sc.text = JSON.stringify({ autosize: true, symbol: sym, interval: '60', timezone: tz, theme, style: '1', locale: 'en', allow_symbol_change: true, withdateranges: true, hide_side_toolbar: false, save_image: false, calendar: false, details: false, hotlist: false, studies: ['STD;RSI'], support_host: 'https://www.tradingview.com' });
    sc.addEventListener('error', () => { box.replaceChildren(el('p', { class: 'note', style: 'padding:16px' }, 'The TradingView chart could not load (blocked by the network or an ad blocker). The Forecast view still works.')); TV_KEY = ''; });
    wrap.append(sc); box.append(wrap);
  }
  $('tv-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const m = tvMeta(), v = $('tv-input').value.trim().toUpperCase();
    if (!/^[A-Z0-9_.:!&\-]{1,40}$/.test(v)) { $('tv-input').focus(); return; }
    if (v === tvDefault(m)) delete TV_OVR[m.id]; else TV_OVR[m.id] = v;
    keep('tv-sym', TV_OVR); $('tv-input').blur(); tvUpdate();
  });
  $('tv-reset').addEventListener('click', () => { delete TV_OVR[tvMeta().id]; keep('tv-sym', TV_OVR); $('tv-input').blur(); tvUpdate(); });

  // ---------- scheduled events + economic calendar ----------
  const evWhen = (e) => (e.allDay ? dayName(e.date) : new Date(e.at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
  function drawEvents(h) {
    const evs = DATA.events || [], line = $('fc-events');
    const hit = evs.filter((e) => (h.events || []).includes(e.id) && e.date <= h.targetDate);
    line.hidden = !hit.length;
    if (hit.length) line.textContent = `Before this target close: ${hit.map((e) => `${e.name} (${evWhen(e)}${e.note && e.id !== 'earnings' ? ', may move a day: US holiday week' : ''})`).join(' · ')}. ${hit.some((e) => e.id === 'earnings') ? 'The ranges do not include the earnings move, which can be several times a normal day.' : 'Scheduled releases can move the price sharply within minutes.'}`;
    const em = DATA.meta && DATA.meta.earnings, earn = em && em.date;
    $('ev-note').textContent = (evs.length ? 'Known releases for this market in the next 9 days:' : 'No scheduled release is known for this market in the next 9 days.') + (earn && !evs.some((e) => e.id === 'earnings') ? ` Next earnings report expected ${dayName(earn)}.` : em && em.pending && !earn ? ' The next earnings date has not been announced yet.' : '');
    $('ev-list').replaceChildren(...evs.map((e) => { const li = el('li'); li.append(el('span', { class: 'when' }, evWhen(e)), el('span', {}, e.name)); if (e.note) li.append(el('span', { class: 'nt' }, e.note)); return li; }));
    calUpdate();
  }
  let CAL_KEY = '';
  function calUpdate() { // the calendar loads only when the card is open
    const box = $('cal-box');
    if (!$('cal').open) return;
    const theme = isLight() ? 'light' : 'dark';
    if (theme === CAL_KEY && box.firstChild) return;
    CAL_KEY = theme; box.replaceChildren();
    const wrap = el('div', { class: 'tradingview-widget-container' });
    wrap.append(el('div', { class: 'tradingview-widget-container__widget' }));
    const sc = document.createElement('script');
    sc.type = 'text/javascript'; sc.async = true;
    sc.src = 'https://s3.tradingview.com/external-embedding/embed-widget-events.js';
    sc.text = JSON.stringify({ colorTheme: theme, isTransparent: false, width: '100%', height: '100%', locale: 'en', importanceFilter: '0,1', countryFilter: 'us,eu,gb,cn' });
    sc.addEventListener('error', () => { box.replaceChildren(el('p', { class: 'note', style: 'padding:16px' }, 'The calendar could not load (blocked by the network or an ad blocker).')); CAL_KEY = ''; });
    wrap.append(sc); box.append(wrap);
  }
  $('cal').open = !!store('cal-open', false);
  $('cal').addEventListener('toggle', () => { keep('cal-open', $('cal').open); calUpdate(); });

  // ---------- timeframes (15 minutes, 1 hour, 1 day) ----------
  // the timeframe reading inside the forecast card: verdict, one arrow per timeframe and what it adds to the lean
  function drawFcTimeframes(f) {
    const t = DATA.mtf, box = $('fc-tf'), sig = (f.signals || []).find((s) => s.id === 'mtf');
    box.hidden = !(t && t.verdict && t.tfs);
    if (box.hidden) return;
    box.replaceChildren();
    const v = t.verdict, top = el('div', { class: 'fc-tf-top' });
    top.append(el('span', {}, 'Timeframes'), el('span', { class: 'bias ' + cls(v.dir) }, v.title));
    const row = el('div', { class: 'fc-tf-row' }), word = { up: '▲ up', down: '▼ down', side: '◆ sideways' }, dirOf = { up: 1, down: -1, side: 0 };
    for (const [k, n] of [['15m', '15 min'], ['1h', '1 hour'], ['1d', '1 day']]) {
      const s = t.tfs[k]; if (!s) continue;
      const it = el('span', { class: s.ready ? cls(dirOf[s.label]) : 'flat' });
      it.append(el('small', {}, n), document.createTextNode(s.ready ? word[s.label] : 'building'));
      row.append(it);
    }
    const w = sig ? sig.weight : t.weight || 0, c = sig ? sig.contribution : 0;
    const p = el('p');
    p.append(document.createTextNode(w > 0
      ? `Counts for ${Math.round(w * 100)}% of the lean: ${c > 0 ? '+' : ''}${c.toFixed(2)} of the combined score ${f.score > 0 ? '+' : ''}${f.score.toFixed(2)}. `
      : (Object.values(t.tfs).some((s) => s && s.ready) ? 'Shown only, not counted in the lean. ' : 'Not counted until the charts have enough bars. ')));
    const a = el('a', { href: '#tf-card' }, 'Patterns and hit rates');
    a.addEventListener('click', (e) => { e.preventDefault(); $('tf-card').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    p.append(a);
    box.append(top, row, p);
  }

  function drawTimeframes() {
    const t = DATA.mtf, card = $('tf-card');
    card.hidden = !(t && t.verdict && t.tfs);
    if (card.hidden) return;
    const v = t.verdict;
    $('tf-verdict').textContent = v.title; $('tf-verdict').className = 'bias ' + cls(v.dir);
    $('tf-text').textContent = v.text;
    const names = { '15m': '15 minutes', '1h': '1 hour', '1d': '1 day' }, step = { '15m': 15 * 60e3, '1h': 36e5 };
    const word = { up: '▲ Up', down: '▼ Down', side: '◆ Sideways' }, dirOf = { up: 1, down: -1, side: 0 };
    const rate = (r) => `${Math.round(100 * r[0] / r[1])}% of ${r[1]}`;
    // when a pattern was completed: the close of its bar, in this browser's time (the date for daily bars)
    const when = (k, p) => (k === '1d' ? 'on ' + new Date(p.t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
      : 'at ' + new Date(p.t + step[k]).toLocaleString(undefined, Date.now() - p.t > 20 * 36e5 ? { weekday: 'short', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' }));
    const grid = $('tf-grid'); grid.replaceChildren();
    for (const k of ['15m', '1h', '1d']) {
      const s = t.tfs[k]; if (!s) continue;
      const box = el('div', { class: 'tf' }), top = el('div', { class: 'tf-top' });
      top.append(el('b', {}, names[k]), el('span', { class: s.ready ? cls(dirOf[s.label]) : 'flat' }, s.ready ? `${word[s.label]} (${s.score > 0 ? '+' : ''}${s.score.toFixed(2)})` : 'Building history'));
      box.append(top);
      if (s.ready) {
        const bar = el('div', { class: 'dbar' }), w = Math.min(1, Math.abs(s.score)) * 50, i = el('i');
        i.style.width = w + '%'; i.style.left = s.score >= 0 ? '50%' : (50 - w) + '%'; i.style.background = s.score >= 0 ? 'var(--up)' : 'var(--down)';
        bar.append(i); box.append(bar);
      }
      box.append(el('div', { class: 'sig-detail' }, s.text || ''));
      if (s.ready) {
        const R = t.rates && t.rates[k], L = t.live && t.live.pat && t.live.pat[k];
        const ul = el('ul', { class: 'tf-pats' });
        for (const p of s.patterns || []) {
          const li = el('li'), key = p.id + (p.dir > 0 ? '+' : '-'), bt = R && R.pat && R.pat[key], lv = L && L[key];
          li.append(el('span', { class: 'chip ' + (p.dir > 0 ? 'up' : 'down') }, p.name));
          let txt = `${when(k, p)}, price ${usd(p.px)}. `;
          txt += bt && bt[1] >= 10 ? `Right ${rate(bt)} earlier times` : bt ? `Seen ${bt[1]} time${bt[1] > 1 ? 's' : ''} before: too few to judge` : 'Not seen before in this history';
          if (lv && lv[1] >= 5) txt += `; since launch ${rate(lv)}`;
          li.append(document.createTextNode(txt + '.')); ul.append(li);
        }
        if (!ul.children.length) ul.append(el('li', {}, 'No pattern in the last few bars.'));
        box.append(ul);
        if (R && R.all && R.all[1] >= 10) box.append(el('div', { class: 'sig-detail' }, `Scored ${R.ahead} later on ${R.bars} bars: all patterns right ${rate(R.all)}${R.call && R.call[1] >= 10 ? `, the up/down reading right ${rate(R.call)}` : ''}. Coin flip: 50%.`));
      }
      grid.append(box);
    }
    const al = t.deep && t.deep.align, alTxt = al && al.d1 && al.d1[1] >= 10 ? ` Replayed together at the daily close since ${dayName(t.deep.from)}, the three pointed the right way for the next close ${rate(al.d1)} times${al.d3 && al.d3[1] >= 10 ? ` and for the close three sessions on ${rate(al.d3)} times` : ''}.` : '';
    $('tf-note').textContent = `Read on every refresh from ${t.source || 'price data'}. Each timeframe gets a score from −1 to +1: half trend (price against its 20- and 50-bar averages, the sequence of highs and lows), 30% momentum (RSI, MACD) and 20% chart patterns. `
      + 'The verdict follows the triple-screen method: the daily chart sets the direction, the 1-hour chart shows the pullback, the 15-minute chart times the turn. '
      + 'The percentages count how often a pattern was followed by a move its way on this market; near 50% means it has been no better than a coin flip here.' + alTxt
      + (t.weight > 0 ? ` This reading counts for ${Math.round(t.weight * 100)}% of the forecast's lean.` : ' This reading does not move the forecast yet: it is scored first, like every other signal (see "What the model sees").');
  }

  // ---------- track record ----------
  function drawTrack() {
    const t = DATA.track, card = $('track-card');
    card.hidden = !t;
    if (!t) return;
    const zero = { n: 0, dirN: 0, dirHit: 0, in68: 0, in90: 0, mae: null, maeNaive: null };
    const L = (t.live && t.live[H]) || zero, B = (t.backtest && t.backtest[H]) || zero;
    const futures = DATA.meta && DATA.meta.provider === 'cnbc' || !DATA.meta;
    const days = `${H} session${H > 1 ? 's' : ''}`;
    const open = (t.open || []).filter((f) => f.h === H).sort((a, b) => (a.target < b.target ? -1 : 1));
    $('track-note').textContent = `How the ${H}-day forecast has done. Published: every trading day at the close the site writes down its forecast and scores it against the close ${days} later${t.since ? ` (logging since ${dayName(t.since)})` : ''}. `
      + `Backtest: the same price signals replayed on the last ${(t.backtest && t.backtest.sessions) || 0} sessions, without news, which cannot be replayed${futures ? '; futures history includes contract-roll jumps' : ''}. `
      + (L.n ? '' : open.length ? `The first published result arrives after the close on ${dayName(open[0].target)}.` : 'The first forecast is logged at the next close.');
    const pct = (a, b) => (b ? Math.round(100 * a / b) + '%' : '—');
    const miss = (x) => (x.n && x.mae != null ? `${x.mae.toFixed(2)}% / ${x.maeNaive.toFixed(2)}%` : '—');
    const st = $('track-stats'); st.replaceChildren();
    const head = el('tr'); ['', `Published (${L.n})`, `Backtest (${B.n})`, 'Compare with'].forEach((x) => head.append(el('th', {}, x))); st.append(head);
    const row = (label, a, b, ref) => { const tr = el('tr'); const c1 = el('td'), c2 = el('td'); c1.append(el('b', {}, a)); c2.append(el('b', {}, b)); tr.append(el('td', {}, label), c1, c2, el('td', { class: 'ref' }, ref)); st.append(tr); };
    row('Direction right', pct(L.dirHit, L.dirN), pct(B.dirHit, B.dirN), '50% is a coin flip');
    row('Close inside the likely range', pct(L.in68, L.n), pct(B.in68, B.n), '68% when the range is sized right');
    row('Close inside the wide range', pct(L.in90, L.n), pct(B.in90, B.n), '90% when the range is sized right');
    row('Average miss: forecast / no change', miss(L), miss(B), 'The forecast adds value when the first number is smaller');
    const lg = $('track-log'); lg.replaceChildren();
    const done = (t.recent || []).filter((f) => f.h === H).sort((a, b) => (a.target < b.target ? 1 : -1));
    const rows = [...open.slice().reverse(), ...done].slice(0, 8);
    $('track-log-title').hidden = !rows.length; lg.parentNode.hidden = !rows.length;
    if (!rows.length) return;
    const h2 = el('tr'); ['Logged at close', 'Target close', 'From', 'Forecast', 'Likely range', 'Actual', 'Result'].forEach((x) => h2.append(el('th', {}, x))); lg.append(h2);
    for (const f of rows) {
      const tr = el('tr');
      const scored = f.actual != null;
      const res = el('td', { class: 'ref' });
      if (!scored) res.textContent = 'Pending';
      else {
        const flat = f.actual === f.p0 || f.c === f.p0, hit = (f.actual > f.p0) === (f.c > f.p0), inside = f.actual >= f.lo68 && f.actual <= f.hi68;
        if (!flat) res.append(el('span', { class: hit ? 'up' : 'down' }, hit ? 'Right direction' : 'Wrong direction'), document.createTextNode(' · '));
        res.append(el('span', { class: inside ? 'up' : 'down' }, inside ? 'inside range' : 'outside range'));
      }
      tr.append(el('td', {}, dayName(f.d0)), el('td', {}, dayName(f.target)), el('td', {}, usd(f.p0)), el('td', {}, `${usd(f.c)} (${sp(100 * (f.c / f.p0 - 1))})`),
        el('td', {}, `${usd(f.lo68)} – ${usd(f.hi68)}`), el('td', {}, scored ? `${usd(f.actual)} (${sp(100 * (f.actual / f.p0 - 1))})` : '—'), res);
      lg.append(tr);
    }
  }

  // ---------- intraday ----------
  function drawIntraday() {
    const box = $('intra'); box.replaceChildren();
    const p = DATA.price;
    const raw = (p.daily || []).at(-1) || {};
    const okb = (v) => (v != null && raw.c && v > raw.c * 0.5 && v < raw.c * 2 ? v : null);
    const bar = raw.c ? { ...raw, o: okb(raw.o), h: okb(raw.h), l: okb(raw.l) } : {};
    const last = p.last, prev = p.prevClose;
    const lo = Math.min(...[bar.l, last, prev].filter((v) => v != null && isFinite(v)));
    const hi = Math.max(...[bar.h, last, prev].filter((v) => v != null && isFinite(v)));
    const W = Math.max(280, box.clientWidth);
    const up = prev == null || last >= prev;
    const col = up ? 'var(--up)' : 'var(--down)';

    // 1) Day range bar: low ... high, with open, previous settlement and live price marked
    const H1 = 92, padX = 14, y0 = 40;
    const x = (v) => padX + ((v - lo) / Math.max(1e-6, hi - lo)) * (W - 2 * padX);
    const svg = el('svg:svg', { viewBox: `0 0 ${W} ${H1}`, width: '100%' }); box.append(svg);
    svg.append(el('svg:rect', { x: padX, y: y0 - 4, width: W - 2 * padX, height: 8, rx: 4, fill: 'var(--track)' }));
    if (bar.l != null && bar.h != null) svg.append(el('svg:rect', { x: x(bar.l), y: y0 - 4, width: Math.max(2, x(bar.h) - x(bar.l)), height: 8, rx: 4, fill: 'var(--track-strong)' }));
    if (prev != null) {
      svg.append(el('svg:rect', { x: Math.min(x(prev), x(last)), y: y0 - 4, width: Math.abs(x(last) - x(prev)), height: 8, fill: col, 'fill-opacity': '0.55' }));
      svg.append(el('svg:line', { x1: x(prev), x2: x(prev), y1: y0 - 14, y2: y0 + 14, stroke: 'var(--ref)', 'stroke-dasharray': '3 2' }));
    }
    if (bar.o != null) svg.append(el('svg:line', { x1: x(bar.o), x2: x(bar.o), y1: y0 - 9, y2: y0 + 9, stroke: 'var(--tick-open)', 'stroke-width': 2 }));
    svg.append(el('svg:circle', { cx: x(last), cy: y0, r: 7, fill: col, stroke: 'var(--panel)', 'stroke-width': 2 }));
    // labels above (live, prev) and below (low, high, open) with collision avoidance
    const placeRow = (items, y, anchorEdges) => {
      const placed = [];
      for (const it of items) {
        const t = el('svg:text', { x: x(it.v), y, 'text-anchor': 'middle', class: 'tick', fill: it.fill || null, 'font-weight': it.bold ? '700' : null }, it.text);
        svg.append(t);
        let bb = t.getBBox();
        if (bb.x < 0) { t.setAttribute('x', bb.width / 2 + 1); bb = t.getBBox(); }
        if (bb.x + bb.width > W) { t.setAttribute('x', W - bb.width / 2 - 1); bb = t.getBBox(); }
        if (placed.some((q) => !(bb.x + bb.width + 6 < q.x || q.x + q.width + 6 < bb.x))) { t.remove(); continue; }
        placed.push(bb);
      }
    };
    placeRow([
      { v: last, text: 'Now ' + usd(last), fill: col, bold: true },
      ...(prev != null ? [{ v: prev, text: 'Prev ' + usd(prev, 2) }] : [])
    ], y0 - 20);
    placeRow([
      ...(bar.l != null ? [{ v: bar.l, text: 'Low ' + usd(bar.l) }] : []),
      ...(bar.h != null ? [{ v: bar.h, text: 'High ' + usd(bar.h) }] : []),
      ...(bar.o != null ? [{ v: bar.o, text: 'Open ' + usd(bar.o) }] : [])
    ], y0 + 30);

    // 2) Intraday line, only once enough samples exist
    const lastS = (p.intraday || []).at(-1)?.[0] || 0;
    const pts = (p.intraday || []).filter((q) => q && isFinite(q[1]) && lastS - q[0] < 24 * 36e5);
    const span = pts.length > 1 ? pts.at(-1)[0] - pts[0][0] : 0;
    if (pts.length < 6 || span < 30 * 60e3) {
      box.append(el('p', { class: 'note', style: 'margin:8px 0 0' }, 'The intraday line appears once the server has collected about 30 minutes of prices (one point every few minutes while the market is open).'));
      return;
    }
    const Ht = 140, m = 6, rPad = 56;
    let a = Math.min(...pts.map((q) => q[1])), b = Math.max(...pts.map((q) => q[1]));
    const showPrev = prev != null && prev >= a - (b - a) * 0.6 && prev <= b + (b - a) * 0.6;
    if (showPrev) { a = Math.min(a, prev); b = Math.max(b, prev); }
    const pad = (b - a) * 0.12 || 0.01; a -= pad; b += pad;
    const t0 = pts[0][0], t1 = pts.at(-1)[0];
    const xs = (t) => m + ((t - t0) / Math.max(1, t1 - t0)) * (W - m - rPad);
    const ys = (v) => m + (1 - (v - a) / (b - a)) * (Ht - 2 * m - 16);
    const s2 = el('svg:svg', { viewBox: `0 0 ${W} ${Ht}`, width: '100%', style: 'margin-top:8px' }); box.append(s2);
    if (showPrev) {
      s2.append(el('svg:line', { x1: m, x2: W - rPad, y1: ys(prev), y2: ys(prev), stroke: 'var(--ref-soft)', 'stroke-dasharray': '3 3' }));
      s2.append(el('svg:text', { x: W - rPad + 6, y: ys(prev), dy: '0.32em', class: 'tick' }, 'Prev'));
    }
    s2.append(el('svg:path', { d: 'M' + pts.map((q) => `${xs(q[0])},${ys(q[1])}`).join('L'), fill: 'none', stroke: col, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    const lp = pts.at(-1);
    s2.append(el('svg:circle', { cx: xs(lp[0]), cy: ys(lp[1]), r: 3.5, fill: col }));
    const lastY = ys(lp[1]);
    s2.append(el('svg:text', { x: W - rPad + 6, y: Math.abs(lastY - (showPrev ? ys(prev) : -99)) < 13 ? lastY + (lastY < ys(prev) ? -8 : 8) : lastY, dy: '0.32em', class: 'tick', fill: col }, usd(lp[1])));
    const fmtT = (t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    s2.append(el('svg:text', { x: m, y: Ht - 2, class: 'tick' }, fmtT(t0)));
    s2.append(el('svg:text', { x: W - rPad, y: Ht - 2, 'text-anchor': 'end', class: 'tick' }, fmtT(t1)));
    const tip = el('div', { class: 'tip' }); tip.hidden = true; box.append(tip);
    s2.addEventListener('pointermove', (ev) => {
      const r = s2.getBoundingClientRect(); const px = (ev.clientX - r.left) * (W / r.width);
      const t = t0 + ((px - m) / (W - m - rPad)) * (t1 - t0);
      const pt = pts.reduce((u, v) => (Math.abs(v[0] - t) < Math.abs(u[0] - t) ? v : u));
      showTip(box, tip, ev, [new Date(pt[0]).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }), usd(pt[1])]);
    });
    s2.addEventListener('pointerleave', () => { tip.hidden = true; });
  }

  // ---------- signals ----------
  function drawSignals() {
    const f = DATA.forecast;
    $('score-note').textContent = `Combined score ${f.score > 0 ? '+' : ''}${f.score.toFixed(2)} on a −1 (bearish) to +1 (bullish) scale. Daily volatility ${(f.sigmaDaily * 100).toFixed(1)}%.`;
    const box = $('signals'); box.replaceChildren();
    for (const s of f.signals) {
      const row = el('div', { class: 'sig' });
      const top = el('div', { class: 'sig-top' });
      top.append(el('span', {}, `${s.name} · ${s.id === 'mtf' && !s.weight ? 'not counted' : Math.round(s.weight * 100) + '%'}`), el('span', { class: cls(s.value) }, (s.value > 0 ? '+' : '') + s.value.toFixed(2)));
      const bar = el('div', { class: 'dbar' });
      const w = Math.abs(s.value) * 50;
      const i = el('i'); i.style.width = w + '%'; i.style.left = s.value >= 0 ? '50%' : (50 - w) + '%'; i.style.background = s.value >= 0 ? 'var(--up)' : 'var(--down)';
      bar.append(i);
      row.append(top, bar, el('div', { class: 'sig-detail' }, s.detail));
      // has this signal earned its weight? right-direction rate in the backtest and in the published log, for the selected horizon
      const tk = DATA.track, bt = tk && tk.backtest && tk.backtest[H] && tk.backtest[H].signals && tk.backtest[H].signals[s.id], lv = tk && tk.live && tk.live[H] && tk.live[H].signals && tk.live[H].signals[s.id];
      const rate = (x) => `${Math.round(100 * x[0] / x[1])}% of ${x[1]}`;
      const parts = [];
      if (s.id === 'news') parts.push('no backtest (old news cannot be replayed)'); else if (bt && bt[1] >= 10) parts.push(`backtest ${s.id === 'mtf' ? '(daily chart only) ' : ''}${rate(bt)}`);
      if (lv && lv[1] >= 5) parts.push(`published ${rate(lv)}`); else if (tk) parts.push('published record still building');
      if (tk && parts.length) row.append(el('div', { class: 'sig-detail' }, `Pointed the right way over ${H} session${H > 1 ? 's' : ''}: ${parts.join(' · ')}. 50% is a coin flip.`));
      box.append(row);
    }
  }

  // ---------- levels ----------
  function drawLevels() {
    const t = $('levels'); t.replaceChildren();
    const last = DATA.price.last;
    const rows = [...DATA.forecast.levels, { label: 'Live price', price: last, kind: 'now' }].sort((a, b) => b.price - a.price);
    for (const l of rows) {
      const tr = el('tr', l.kind === 'now' ? { class: 'now' } : {});
      const k = el('td');
      if (l.kind !== 'now') { const sp1 = el('span', { class: 'k ' + (l.kind === 'support' ? 'up' : 'down') }, l.kind); k.append(sp1); }
      tr.append(el('td', {}, l.label), el('td', { class: 'r' }, usd(l.price)), el('td', { class: 'r flat' }, l.kind === 'now' ? '' : sp(100 * (l.price / last - 1), 1)), k);
      t.append(tr);
    }
  }

  // ---------- news ----------
  // ---------- risk helper ----------
  // XTB contract details. Unconfirmed ones are shown as "to check" until the user confirms them, because brokers
  // differ by up to 30x on lot sizes. NATGAS: from xStation's specification, 12 Nov 2026 (nominal value
  // "Instrument level * 30000", minimum 0.005 lot, maximum 95, leverage 1:10, daily swap long -0.042833% /
  // short -0.021056% of the position value, next rollover 20 Nov 2026). Swaps and rollover dates change: update here.
  const XTB = {
    NATGAS: { sym: 'NATGAS', unit: 'MMBtu', lot: 30000, min: 0.005, step: 0.005, max: 95, margin: 10, sure: true,
      swap: { long: -0.042833, short: -0.021056, asOf: '12 Nov' }, rollovers: ['2026-11-20'] },
    BRENT: { sym: 'OIL', unit: 'barrels', lot: 100, step: 0.01, margin: 10, sure: false }
  };
  function xtbSpec(meta) {
    if (XTB[meta.id]) return XTB[meta.id];
    const c = meta.category;
    if (c === 'equity' || c === 'etf') return { sym: `${meta.symbol}.US`, unit: 'shares', lot: 1, step: 1, margin: 20, sure: true };
    if (c === 'fx') return { sym: (meta.symbol || '').replace('/', ''), unit: 'units', lot: 100000, step: 0.01, margin: /^(EUR|GBP|USD|JPY|CHF|CAD)\/(EUR|GBP|USD|JPY|CHF|CAD)$/.test(meta.symbol || '') ? 3.33 : 5, sure: false };
    if (c === 'crypto') return { sym: (meta.symbol || '').replace('/', ''), unit: 'coins', lot: 1, step: 0.01, margin: 50, sure: false };
    if (c === 'index') return { sym: meta.symbol, unit: 'units', lot: 1, step: 0.01, margin: 5, sure: false };
    return { sym: meta.symbol, unit: 'units', lot: 1, step: 0.01, margin: /XAU|GOLD/i.test(meta.symbol || '') ? 5 : 10, sure: false };
  }
  const rkGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem('rk-' + k)); return v == null ? d : v; } catch { return d; } };
  const rkSet = (k, v) => keep('rk-' + k, v);
  let RK_FX = null; // { date, rates: { EUR, RON } } per 1 USD, ECB reference rates
  function rkLoadFx() {
    const c = rkGet('fx', null);
    if (c && Date.now() - c.at < 12 * 36e5) { RK_FX = c; return; }
    const urls = ['https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,RON', 'https://api.frankfurter.app/latest?from=USD&to=EUR,RON'];
    (async () => {
      for (const u of urls) {
        try { const r = await fetch(u); if (!r.ok) continue; const j = await r.json(); if (j?.rates?.EUR) { RK_FX = { at: Date.now(), date: j.date, rates: j.rates }; rkSet('fx', RK_FX); if (DATA?.price) drawRisk(); return; } } catch { /* next */ }
      }
    })();
  }
  const normCdf = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
  function atr14(daily) {
    const bars = daily.slice(0, -1).slice(-60); // completed sessions only
    if (bars.length < 15) return null;
    let a = null;
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i], pc = bars[i - 1].c;
      const h = b.h ?? b.c, l = b.l ?? b.c;
      const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      a = i <= 14 ? (a ?? 0) + tr / 14 : (a * 13 + tr) / 14;
    }
    return a;
  }
  let RK_ID = null;
  function drawRisk() {
    if (!DATA?.price) return;
    const meta = DATA.meta || { id: 'NATGAS', category: 'energy', symbol: 'NG' };
    const id = meta.id || 'NATGAS', spec = xtbSpec(meta), p = DATA.price, f = DATA.forecast;
    const ccy = rkGet('ccy', 'RON');
    // fill the form when the market changes
    if (RK_ID !== id) {
      RK_ID = id;
      $('rk-bal').value = rkGet('bal', '') ?? '';
      $('rk-ccy').value = ccy;
      $('rk-pct').value = rkGet('pct', 1);
      const dirSaved = rkGet('dir-' + id, null);
      $('rk-dir').dataset.d = String(dirSaved ?? (f.score < -0.15 ? -1 : 1));
      $('rk-entry').value = '';
      $('rk-stop').value = rkGet('stop', '1.5');
      $('rk-stop-px').value = '';
      $('rk-tgt').value = rkGet('tgt', '2');
      $('rk-tgt-px').value = '';
      $('rk-lot').value = rkGet('lot-' + id, spec.lot);
    }
    $('rk-entry').placeholder = fmtNum(p.last, DEC) + ' (live)';
    const lotOk = spec.sure || rkGet('lot-ok-' + id, false);
    $('rk-lot-lbl').textContent = `Units per lot (${spec.unit}) · xStation: ${spec.sym}`;
    const d = Number($('rk-dir').dataset.d) || 1;
    $('rk-dir').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.d) === d)));
    const method = $('rk-stop').value;
    $('rk-stop-px').hidden = method !== 'custom';
    const tMethod = $('rk-tgt').value;
    $('rk-tgt-px').hidden = tMethod !== 'custom';
    // currency: prices are in USD (stocks, commodities); currencies are left as quoted
    const quoteUsd = meta.category !== 'fx' || /\/USD$/.test(meta.symbol || '');
    const fxWrap = $('rk-fx-wrap');
    fxWrap.hidden = ccy === 'USD' || !quoteUsd;
    if (!fxWrap.hidden) {
      $('rk-fx-ccy').textContent = ccy;
      const live = RK_FX?.rates?.[ccy];
      const manual = Number(rkGet('fx-' + ccy, 0));
      if (document.activeElement !== $('rk-fx')) $('rk-fx').value = manual || (live ? live.toFixed(4) : '');
      $('rk-fx').title = live ? `ECB reference rate ${RK_FX.date}: ${live.toFixed(4)}` : 'Type the rate if it does not load';
    }
    const fx = ccy === 'USD' || !quoteUsd ? 1 : Number($('rk-fx').value) || null;  // account currency per 1 USD
    const out = (k, v) => { $(k).textContent = v; };
    const lines = $('rk-lines'); lines.replaceChildren();
    const line = (txt, cls) => { const li = el('li', cls ? { class: cls } : {}, txt); lines.append(li); return li; };

    const atr = atr14(p.daily || []);
    const entry = Number($('rk-entry').value) || p.last;
    let stop = null;
    if (method === 'custom') stop = Number($('rk-stop-px').value) || null;
    else if (method === 'r90') stop = d > 0 ? f.horizons[1].lo90 : f.horizons[1].hi90;
    else if (atr) stop = entry - d * Number(method) * atr;
    const dist = stop != null ? (entry - stop) * d : null;
    // profit target: a multiple of the risk, the model's 3-day range edge or centre, or the user's own price
    let tgt = null;
    if (tMethod === 'custom') tgt = Number($('rk-tgt-px').value) || null;
    else if (tMethod === 'r68') tgt = (d > 0 ? f.horizons[3]?.hi68 : f.horizons[3]?.lo68) ?? null;
    else if (tMethod === 'c3') tgt = f.horizons[3]?.center ?? null;
    else if (dist > 0) tgt = entry + d * Number(tMethod) * dist;
    const tdist = tgt != null ? (tgt - entry) * d : null;
    out('rk-tgt-out', tgt != null ? usd(tgt) : '—');
    const bal = Number($('rk-bal').value), pct = Number($('rk-pct').value);
    const lot = Number($('rk-lot').value) || spec.lot;
    const money = (usdAmt) => (fx ? `${Math.round(usdAmt * fx).toLocaleString('en-US')} ${ccy}` + (ccy !== 'USD' && quoteUsd ? ` ($${Math.round(usdAmt).toLocaleString('en-US')})` : '') : `$${Math.round(usdAmt).toLocaleString('en-US')}`);
    const money2 = (usdAmt) => { const f = (x) => (Math.abs(x) < 10 ? x.toFixed(2) : Math.round(x).toLocaleString('en-US')); return fx ? `${f(usdAmt * fx)} ${ccy}` + (ccy !== 'USD' && quoteUsd ? ` ($${f(usdAmt)})` : '') : `$${f(usdAmt)}`; };
    out('rk-stop-out', stop != null ? usd(stop) : '—');
    if (atr) line(`Average daily range (ATR, 14 sessions): ${usd(atr)}, ${(100 * atr / p.last).toFixed(1)}% of the price.`);
    else line('Not enough daily history yet for the average daily range; use your own stop price.', 'warn');
    if (!lotOk) {
      const li = line(`Check the lot size: in xStation open ${spec.sym} → Specification → "Nominal value of 1 lot". If it shows price × ${Number(lot).toLocaleString('en-US')}, this is right.`, 'warn');
      const b = el('button', { type: 'button' }, 'It matches'); b.addEventListener('click', () => { rkSet('lot-ok-' + id, true); drawRisk(); }); li.append(b);
    }
    if (dist == null || !(dist > 0)) {
      ['rk-size', 'rk-loss', 'rk-margin', 'rk-profit'].forEach((k) => out(k, '—'));
      if (stop != null) line(d > 0 ? 'For a buy, the stop must be below the entry.' : 'For a sell, the stop must be above the entry.', 'bad');
      return;
    }
    if (!(bal > 0) || !(pct > 0) || !fx) {
      ['rk-size', 'rk-loss', 'rk-margin', 'rk-profit'].forEach((k) => out(k, '—'));
      line(!(bal > 0) ? 'Enter your account balance to get a position size.' : !fx ? `Enter the USD to ${ccy} rate.` : 'Enter the risk per trade.', 'warn');
      return;
    }
    const riskUsd = (bal * pct / 100) / fx;
    const units = riskUsd / dist;
    const minLot = spec.min ?? spec.step, lotDec = spec.step >= 1 ? 0 : (String(spec.step).split('.')[1] || '').length;
    let lots = Math.round(Math.floor(units / lot / spec.step + 1e-9) * spec.step * 1e6) / 1e6;
    if (lots < minLot) lots = 0;
    const capped = spec.max && lots > spec.max;
    if (capped) lots = spec.max;
    const lotTxt = (x) => spec.step >= 1 ? `${x.toLocaleString('en-US')} ${spec.unit}` : `${x.toFixed(lotDec)} lot${x === 1 ? '' : 's'}`;
    if (lots <= 0) {
      const minLoss = minLot * lot * dist;
      out('rk-size', '0'); out('rk-loss', '—'); out('rk-margin', '—'); out('rk-profit', '—');
      line(`Too small: even the minimum ${lotTxt(minLot)} would lose ${money(minLoss)} at this stop (${(100 * minLoss * fx / bal).toFixed(2)}% of the balance). Use a closer stop, a higher risk %, or skip the trade.`, 'bad');
    } else {
      const lossUsd = lots * lot * dist, notional = lots * lot * entry;
      out('rk-size', lotTxt(lots) + (spec.step < 1 ? ` · ${Math.round(lots * lot).toLocaleString('en-US')} ${spec.unit}` : ''));
      out('rk-loss', `${money(lossUsd)} · ${(100 * lossUsd * fx / bal).toFixed(2)}%`);
      out('rk-margin', `${money(notional * spec.margin / 100)} · ${spec.margin}%`);
      if (tdist > 0) {
        const profitUsd = lots * lot * tdist;
        out('rk-profit', `${money(profitUsd)} · ${(100 * profitUsd * fx / bal).toFixed(2)}% · ${(tdist / dist).toFixed(tdist < dist ? 2 : 1)}R`);
      } else out('rk-profit', '—');
      if (notional * spec.margin / 100 * fx > bal) line('The margin is more than the balance, so XTB would not open this position. Lower the risk %, or use a wider stop (a wider stop gives a smaller size).', 'bad');
      line(`Exposure: ${money(notional)} (${(notional * fx / bal).toFixed(1)}× the balance). Each ${usd(atr || dist)} move ${atr ? '(one average day)' : ''} is ${money(lots * lot * (atr || dist))}.`);
      if (capped) line(`Capped at XTB's maximum of ${spec.max} lots per position.`, 'warn');
      if (spec.swap) {
        const sw = d > 0 ? spec.swap.long : spec.swap.short, night = notional * sw / 100;
        line(`Overnight cost (XTB swap ${d > 0 ? 'long' : 'short'} ${sw}% a day, as of ${spec.swap.asOf}): ${night < 0 ? 'about ' + money2(-night) + ' charged' : 'about ' + money2(night) + ' credited'} for each night the position is held, ${money2(Math.abs(night) * 7)} a week.`);
      }
    }
    // how the stop compares with normal day-to-day noise, from the forecast's daily volatility
    if (f.sigmaDaily) {
      const z = Math.log(1 + dist / entry) / f.sigmaDaily;
      const pDay = 1 - normCdf(z);
      const msg = `Stop ${usd(dist)} away (${(100 * dist / entry).toFixed(1)}%${atr ? `, ${(dist / atr).toFixed(1)}× ATR` : ''}). A daily close that far against you happens on about ${Math.round(100 * pDay)}% of days; intraday touches are more frequent.`;
      line(msg, z < 1 ? 'warn' : '');
      if (z < 1) line('That is inside one normal day\'s movement, so ordinary noise is likely to stop you out.', 'warn');
    }
    // the target: how far, how often a close gets there, and the hit rate needed to come out ahead
    if (tgt != null && !(tdist > 0)) line(tMethod === 'c3' ? 'The model\'s 3-day centre is on the losing side of this entry, so it gives no target in this direction. Pick another target.' : d > 0 ? 'For a buy, the target must be above the entry.' : 'For a sell, the target must be below the entry.', 'bad');
    else if (tdist > 0) {
      const R = tdist / dist, need = 100 / (1 + R);
      let msg = `Target ${usd(tdist)} away (${(100 * tdist / entry).toFixed(1)}%, ${R.toFixed(R < 1 ? 2 : 1)}R). With this stop and target, more than ${Math.round(need)}% of such trades must reach the target first to come out ahead, before spread and overnight costs.`;
      if (f.sigmaDaily) {
        const z = Math.log(1 + tdist / entry) / f.sigmaDaily;
        const pct = (x) => (x < 0.01 ? 'under 1' : String(Math.round(100 * x)));
        const pc = [1, 3, 5].map((h) => `${h} day${h > 1 ? 's' : ''} ${pct(1 - normCdf(z / Math.sqrt(h)))}%`);
        msg += ` Chance that the close is at or past it, with no direction assumed: ${pc.join(' · ')} (touching it during the day is more likely).`;
      }
      line(msg, R < 1 ? 'warn' : '');
    }
    // reward compared with risk, using the model's centres for 1, 3 and 5 days
    const rr = [1, 3, 5].map((h) => { const c = f.horizons[h]?.center; return c ? `${h}d ${((c - entry) * d / dist).toFixed(2)}R` : null; }).filter(Boolean);
    if (rr.length) line(`Model's expected move as a multiple of the risk (R): ${rr.join(' · ')}. ${(f.horizons[3]?.center - entry) * d < 0 ? 'The model leans against this direction.' : 'Below 1R means the expected move is smaller than the risk.'} The model has shown no reliable direction edge so far: treat this as context.`);
    if (pct > 2) line('Many traders keep the risk per trade at 1-2% so a losing streak stays survivable.', 'warn');
    const roll = (spec.rollovers || []).find((x) => Date.parse(x + 'T23:59:59Z') >= Date.now());
    if (roll) line(`XTB rolls ${spec.sym} to the next futures month on ${new Date(roll + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}: the quoted price jumps to the new contract and XTB books a correction on open positions. Check your stop in xStation after the rollover.`, 'warn');
    if ((DATA.events || []).some((e) => e.date <= f.horizons[1].targetDate)) line(`Scheduled report before the next close (${DATA.events.filter((e) => e.date <= f.horizons[1].targetDate).map((e) => e.name).join(', ')}): price can jump past a stop.`, 'warn');
  }
  ['rk-bal', 'rk-pct', 'rk-entry', 'rk-stop-px', 'rk-tgt-px', 'rk-lot', 'rk-fx'].forEach((k) => $(k).addEventListener('input', () => {
    const v = $(k).value;
    if (k === 'rk-bal') rkSet('bal', v); if (k === 'rk-pct') rkSet('pct', v);
    if (k === 'rk-lot' && RK_ID) { rkSet('lot-' + RK_ID, Number(v) || null); rkSet('lot-ok-' + RK_ID, true); }
    if (k === 'rk-fx') rkSet('fx-' + $('rk-ccy').value, Number(v) || 0);
    drawRisk();
  }));
  $('rk-ccy').addEventListener('change', () => { rkSet('ccy', $('rk-ccy').value); drawRisk(); });
  $('rk-stop').addEventListener('change', () => { rkSet('stop', $('rk-stop').value); if ($('rk-stop').value === 'custom' && !$('rk-stop-px').value && $('rk-stop-out').textContent !== '—') $('rk-stop-px').value = $('rk-stop-out').textContent.replace(/[^0-9.]/g, ''); drawRisk(); });
  $('rk-tgt').addEventListener('change', () => { rkSet('tgt', $('rk-tgt').value); if ($('rk-tgt').value === 'custom' && !$('rk-tgt-px').value && $('rk-tgt-out').textContent !== '—') $('rk-tgt-px').value = $('rk-tgt-out').textContent.replace(/[^0-9.]/g, ''); drawRisk(); });
  $('rk-dir').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { $('rk-dir').dataset.d = b.dataset.d; if (RK_ID) rkSet('dir-' + RK_ID, Number(b.dataset.d)); drawRisk(); }));
  rkLoadFx();

  // ---------- alerts ----------
  // Telegram switch per market. The page cannot change the repository itself, so the switch opens a pre-filled GitHub issue
  // (like Add / Remove); the watchlist job updates watchlist.json and the next refresh reports the new state back here.
  const TG_PENDING_MIN = 20;
  const tgPend = () => { try { return JSON.parse(localStorage.getItem('tg-pending')) || {}; } catch { return {}; } };
  const tgPendSet = (o) => { try { localStorage.setItem('tg-pending', JSON.stringify(o)); } catch { /* private mode */ } };
  function drawTg() {
    const a = $('tg'), A = DATA && DATA.alerts, id = DATA?.meta?.id || CUR_ID;
    if (!A || !A.telegram) { a.hidden = true; return; } // no bot set up: nothing to switch
    const on = !A.muted, pend = tgPend(), p = pend[id];
    const waiting = p && p.on !== on && Date.now() - p.t < TG_PENDING_MIN * 60e3;
    if (p && !waiting) { delete pend[id]; tgPendSet(pend); }
    const name = id === 'NATGAS' ? 'NATGAS' : DATA.meta?.name || id;
    a.hidden = false;
    a.classList.toggle('pending', !!waiting);
    a.setAttribute('aria-checked', String(waiting ? p.on : on));
    $('tg-lbl').textContent = waiting ? (p.on ? 'Turning on…' : 'Turning off…') : on ? 'Telegram on' : 'Telegram off';
    const want = waiting ? !p.on : !on; // a second click while waiting reverses the request
    a.href = issueUrl(`watchlist: telegram ${want ? 'on' : 'off'} ${id}`, { action: 'telegram', id, telegram: want ? 'on' : 'off' });
    a.title = waiting
      ? `Waiting for GitHub: press Create on the request page if you have not yet. The switch updates on the next refresh after that (about 2 minutes).`
      : `Telegram alerts for ${name} are ${on ? 'on' : 'off'}. Click to turn them ${on ? 'off' : 'on'} (opens a pre-filled request on GitHub: press Create). Alerts keep showing on this page either way.`;
    a.onclick = () => { const q = tgPend(); q[id] = { on: want, t: Date.now() }; tgPendSet(q); setTimeout(drawTg, 0); };
  }

  function drawAlerts() {
    drawTg();
    const A = DATA.alerts, list = $('al-list');
    list.replaceChildren();
    const icon = { move: '📈', level: '🧱', flip: '🔄', analyst: '🧠', event: '🗓', step: '' };
    const items = (A && A.log) || [];
    for (const x of items) {
      const li = el('li');
      li.append(el('span', { class: 'when' }, new Date(x.t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })), el('span', {}, `${icon[x.type] ?? '•'} ${x.text}`.trim()));
      list.append(li);
    }
    const how = 'Alerts cover every 0.5% price move since the previous price alert (▲ / ▼), unusual daily moves, breaks of the 50- and 200-day averages and the 20-session high or low, the model lean flipping between bullish and bearish, the AI analyst switching between bullish and bearish, and reminders before scheduled reports. Each fires once.';
    $('al-note').textContent = !A ? 'Alerts start with the next refresh.'
      : (items.length ? '' : 'No alerts for this market in the last 7 days. ') + how + (!A.telegram ? ' They can also be sent to Telegram: see the README.' : A.muted ? ' Telegram is switched off for this market (the switch at the top of the page), so they show here only.' : ' They are also sent to Telegram; switch that off for this market at the top of the page.');
  }

  function drawNews() {
    const items = DATA.news.items || [];
    const nFull = items.filter((n) => n.read && n.read.status === 'full').length;
    const nPart = items.filter((n) => n.read && n.read.status === 'partial').length;
    const nSum = items.filter((n) => n.read && n.read.status === 'summary').length;
    const nAi = items.filter((n) => n.ai).length, nOff = items.filter((n) => n.ai && n.ai.rel === false).length;
    const sc = DATA.news.scorer;
    const how = nAi
      ? ` ${nAi} stories were scored by an AI model (${(sc && sc.model) || 'gpt-oss on Groq'}) reading the headline, with the keyword score of the article text as a smaller input${nOff ? `; ${nOff === 1 ? '1 story' : nOff + ' stories'} judged not to be about this market ${nOff === 1 ? 'is' : 'are'} greyed out and left out of the forecast` : ''}${nAi < items.length ? '. The rest are scored with keywords until the AI catches up' : ''}.`
      : sc && sc.kind ? ' AI scoring is not available right now, so stories are scored with keywords.' : '';
    $('news-note').textContent = items.length
      ? `${items.length} stories from trusted outlets, fetched ${ago(DATA.news.fetchedAt)}. ${nFull} read in full, ${nPart} partly, ${nSum} paywalled (publisher summary read), the rest blocked to automated readers and scored on the headline only.${how} Tags show how each story was scored for price direction.`
      : 'No trusted headlines on the last refresh.';
    const ul = $('news'); ul.replaceChildren();
    for (const n of items.slice(0, 30)) {
      const li = el('li');
      const href = (n.read && n.read.url) || n.link;
      const a = el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, n.title);
      const meta = el('div', { class: 'meta' });
      const off = n.ai && n.ai.rel === false;
      const tag = off ? ['Not about this market', 'flat'] : n.score > 0.3 ? ['Bullish', 'up'] : n.score < -0.3 ? ['Bearish', 'down'] : ['Neutral', 'flat'];
      const r = n.read || { status: 'headline' };
      const readTxt = r.status === 'full' ? `Full article · ${r.words} words` : r.status === 'partial' ? `Partly read · ${r.words} words` : r.status === 'summary' ? 'Paywalled · summary read' : 'Headline only';
      meta.append(el('span', { class: 'chip ' + tag[1] }, tag[0]));
      if (n.ai) meta.append(el('span', { class: 'aib', title: `Scored by ${n.ai.m || 'AI'}: ${n.ai.s > 0 ? '+' : ''}${n.ai.s} on a -2 to +2 scale` }, 'AI'));
      meta.append(el('span', { class: 'rd rd-' + r.status, title: r.reason || '' }, readTxt), el('span', {}, n.source), el('span', {}, ago(n.publishedAt)));
      if (off) li.classList.add('off');
      li.append(a, meta);
      if (n.ai && n.ai.why) li.append(el('div', { class: 'kp' }, 'AI: ' + n.ai.why));
      if (r.keyPhrases && r.keyPhrases.length) li.append(el('div', { class: 'kp' }, 'Signals in the text: ' + r.keyPhrases.join(', ')));
      ul.append(li);
    }
  }

  function drawSources() {
    const ul = $('sources'); ul.replaceChildren();
    const ok = DATA.sources.filter((s) => s.ok).length;
    $('src-note').textContent = `${ok} of ${DATA.sources.length} sources answered on the last server refresh (${ago(DATA.generatedAt)}).`;
    for (const s of DATA.sources) ul.append(el('li', s.ok ? {} : { class: 'bad', title: s.error || '' }, s.name + (s.ok ? '' : ' — no answer')));
  }

  // ---------- light / dark theme ----------
  const ICONS = {
    auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/></svg>',
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>'
  };
  const LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' };
  let THEME = 'auto'; try { THEME = localStorage.getItem('theme') || 'auto'; } catch { /* storage blocked */ }
  const media = window.matchMedia('(prefers-color-scheme: light)');
  function applyTheme() {
    const root = document.documentElement;
    if (THEME === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', THEME);
    const btn = $('theme');
    btn.innerHTML = ICONS[THEME] + `<span>${LABEL[THEME]}</span>`;
    btn.title = `Theme: ${LABEL[THEME]} (click to change)`;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim() || '#121214');
    render(); // chart area gradients read the theme once per draw
  }
  $('theme').addEventListener('click', () => {
    THEME = { auto: 'light', light: 'dark', dark: 'auto' }[THEME];
    try { localStorage.setItem('theme', THEME); } catch { /* ignore */ }
    applyTheme();
  });
  media.addEventListener?.('change', () => { if (THEME === 'auto') applyTheme(); });
  applyTheme();

  // read a data file with the key this browser already has, never asking for the password (switch health check, Edison Growth extras)
  async function peek(url) {
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j?.enc !== 1) return j;
    const raw = LOCK.raw || storedKey(j.kdf);
    if (!raw) throw new Error('no saved key');
    return openSealed(j, raw);
  }
  window.MW = {
    state: mwState, peek, select: (id) => select(id), openSearch, issueUrl, render: () => render(),
    setLines: (arr) => { EXTRA_LINES = Array.isArray(arr) ? arr : []; applyExtraLines(); },
    chartView: () => pcView(), fmt: (v, d) => fmtNum(v, d), usd: (v, d) => usd(v, d), ago, dayName
  };

  setTabs();
  load();
  setInterval(load, 60 * 1000);
  window.addEventListener('keydown', (e) => { if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); openSearch(); } });
  setInterval(statusLine, 15 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastFetch > 30000) load(); });
})();
