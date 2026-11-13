// Switch between the two interfaces (Classic = index.html, Edison Growth = edison.html) with a confirmation and a health check.
// Both pages read the same data files with the same code (app.js), so only the layout changes. The switch moves you only after
// the other page loads and this browser's saved key opens the data; otherwise you stay where you are and nothing changes.
// The choice is remembered on this device ('ui' in localStorage). Escape hatch: add ?ui=classic to any address.
(() => {
  const PAGES = {
    classic: { url: './', name: 'Classic' },
    edison: { url: 'edison.html', name: 'Edison Growth' }
  };
  const here = document.querySelector('meta[name="ui-page"]')?.content || 'classic';
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}, text) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };
  const icon = (kind) => {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'uis-ic ' + kind);
    s.innerHTML = {
      ok: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
      bad: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
      run: '<circle cx="12" cy="12" r="9" opacity=".25"/><path d="M12 3a9 9 0 0 1 9 9"/>',
      wait: '<circle cx="12" cy="12" r="9"/>'
    }[kind];
    return s;
  };

  const css = `
  .uis-dlg { border: 1px solid var(--line); border-radius: 22px; background: var(--panel); color: var(--fg); padding: 0; width: min(420px, calc(100vw - 32px)); box-shadow: 0 24px 80px rgba(0,0,0,.45); font-family: var(--font, system-ui, sans-serif); }
  .uis-dlg::backdrop { background: rgba(5,5,10,.55); backdrop-filter: blur(2px); }
  .uis-body { padding: 24px; display: grid; gap: 14px; }
  .uis-body h2 { margin: 0; font-size: 19px; font-weight: 600; letter-spacing: -.01em; }
  .uis-body p { margin: 0; font-size: 14px; line-height: 1.5; color: var(--muted); }
  .uis-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  .uis-list li { display: flex; align-items: center; gap: 10px; font-size: 14px; line-height: 1.35; }
  .uis-list li.wait { color: var(--muted); }
  .uis-ic { width: 20px; height: 20px; flex: none; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .uis-ic.ok { stroke: var(--up); } .uis-ic.bad { stroke: var(--down); } .uis-ic.wait { stroke: var(--muted); }
  .uis-ic.run { stroke: var(--accent); animation: uis-spin .9s linear infinite; }
  @keyframes uis-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .uis-ic.run { animation: none; } }
  .uis-why { font-size: 13px; color: var(--down); }
  .uis-btns { display: flex; gap: 8px; margin-top: 4px; }
  .uis-btns button { flex: 1 1 0; min-height: 44px; border-radius: 999px; font: 600 14px var(--font, system-ui, sans-serif); cursor: pointer; border: 1px solid var(--line); background: transparent; color: var(--fg); }
  .uis-btns button.main { background: var(--accent); border-color: var(--accent); color: var(--bg); }
  .uis-edison .uis-btns button.main { background: var(--btn); border-color: var(--btn); color: #fff; }
  .uis-btns button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .uis-esc { font-size: 12px; color: var(--muted); }`;
  document.head.append(el('style', {}, css));

  const dlg = el('dialog', { class: 'uis-dlg uis-' + here, 'aria-labelledby': 'uis-h' });
  const body = el('div', { class: 'uis-body' });
  dlg.append(body);
  document.body.append(dlg);
  let busy = null; // AbortController of a running check

  const state = () => (window.MW ? window.MW.state() : {});
  const hashNow = () => {
    const s = state();
    return location.hash || (s.CUR_ID ? `#${s.CUR_ID}/${s.H || 3}d` : '');
  };

  function show(nodes) { body.replaceChildren(...nodes); if (!dlg.open) dlg.showModal(); }
  function close() { if (busy) busy.abort(); busy = null; if (dlg.open) dlg.close(); }
  dlg.addEventListener('cancel', () => { if (busy) busy.abort(); busy = null; });

  function confirmStep(to) {
    const T = PAGES[to];
    const h = el('h2', { id: 'uis-h' }, to === 'edison' ? 'Switch to Edison Growth?' : 'Switch back to Classic?');
    const p = el('p', {}, 'Only the layout and look change. Everything else comes with you:');
    const ul = el('ul', { class: 'uis-list' });
    for (const t of ['Same password and markets', 'Alerts, forecast log and track record', 'Telegram switches', 'Risk helper inputs, chart symbol and theme']) {
      const li = el('li'); li.append(icon('ok'), document.createTextNode(t)); ul.append(li);
    }
    const p2 = el('p', {}, 'You can switch back any time from the top of the page.');
    const btns = el('div', { class: 'uis-btns' });
    const stay = el('button', { type: 'button' }, 'Stay'), go = el('button', { type: 'button', class: 'main' }, 'Switch');
    stay.addEventListener('click', close);
    go.addEventListener('click', () => check(to));
    btns.append(stay, go);
    show([h, p, ul, p2, btns]);
    go.focus();
  }

  async function check(to) {
    const T = PAGES[to];
    const s = state();
    const id = s.CUR_ID || 'NATGAS';
    const steps = [
      { label: `${T.name} page loaded` },
      { label: 'Your saved key opens the data' },
      { label: `${id === 'NATGAS' ? 'NATGAS' : id.replace(/-.*/, '')} has a live price` },
      { label: 'Markets list is complete' }
    ];
    const h = el('h2', { id: 'uis-h' }, 'Checking it can open your data');
    const ul = el('ul', { class: 'uis-list', 'aria-live': 'polite' });
    const btns = el('div', { class: 'uis-btns' });
    const cancel = el('button', { type: 'button' }, 'Cancel');
    cancel.addEventListener('click', close);
    btns.append(cancel);
    const paint = () => ul.replaceChildren(...steps.map((st) => { const li = el('li', { class: st.k || 'wait' }); li.append(icon(st.k || 'wait'), document.createTextNode(st.label)); return li; }));
    paint();
    show([h, ul, btns]);
    const ctl = new AbortController(); busy = ctl;
    const timeout = setTimeout(() => ctl.abort(), 15000);
    let i = 0, why = '';
    const run = async (fn) => { steps[i].k = 'run'; paint(); await fn(); if (ctl.signal.aborted) throw new Error('took too long'); steps[i].k = 'ok'; paint(); i++; };
    let idx = null, target = id;
    try {
      await run(async () => {
        const r = await fetch(T.url + (T.url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store', signal: ctl.signal });
        if (!r.ok) throw new Error(`the ${T.name} page did not load (HTTP ${r.status})`);
        const txt = await r.text();
        if (!txt.includes(`name="ui-page" content="${to}"`)) throw new Error(`the ${T.name} page is not on this site yet`);
      });
      await run(async () => {
        if (!window.MW) throw new Error('the page code did not start');
        try { idx = await window.MW.peek('data/index.json'); } catch (e) { throw new Error(/no saved key/.test(e.message) ? 'no saved key: unlock the site again first' : /HTTP/.test(e.message) ? `the market list did not load (${e.message})` : 'your saved key could not open the data'); }
        if (!idx || !Array.isArray(idx.markets)) throw new Error('the market list is empty');
      });
      await run(async () => {
        const m = idx.markets.find((x) => x.id === id);
        if (m && m.last == null) target = (idx.markets.find((x) => x.last != null) || m).id; // a market still preparing: check one that has data
        let d = null;
        try { d = await window.MW.peek(`data/m/${target}.json`); } catch (e) { if (target === 'NATGAS') d = await window.MW.peek('data/latest.json'); else throw e; }
        if (!d || !d.price || d.price.last == null) throw new Error(`${target} has no price yet`);
      });
      await run(async () => {
        if (!idx.markets.length) throw new Error('no markets on the list');
      });
    } catch (e) {
      why = ctl.signal.aborted ? 'it took longer than 15 seconds' : e.message || 'unknown problem';
      if (steps[i]) steps[i].k = 'bad';
    } finally { clearTimeout(timeout); }
    if (busy !== ctl) return; // cancelled
    busy = null;
    if (why) return failStep(to, steps, why);
    const hash = idx.markets.some((m) => m.id === id) ? hashNow() : '';
    const done = el('h2', { id: 'uis-h' }, `Opening ${T.name}`);
    const p = el('p', {}, `${steps.length} of ${steps.length} checks passed. Same market and horizon as before.`);
    show([done, ul, p]);
    try { localStorage.setItem('ui', to); } catch { /* private mode: the switch still works for this visit */ }
    setTimeout(() => { location.href = T.url + hash; }, 450);
  }

  function failStep(to, steps, why) {
    const H = PAGES[here];
    const h = el('h2', { id: 'uis-h' }, `Staying on ${H.name}`);
    const ul = el('ul', { class: 'uis-list' });
    steps.filter((s) => s.k).forEach((st) => { const li = el('li', { class: st.k === 'run' ? 'bad' : st.k }); li.append(icon(st.k === 'run' ? 'bad' : st.k), document.createTextNode(st.label)); ul.append(li); });
    const w = el('p', { class: 'uis-why', role: 'alert' }, 'Reason: ' + why + '.');
    const p = el('p', {}, 'Nothing changed and your settings are untouched.');
    const btns = el('div', { class: 'uis-btns' });
    const c = el('button', { type: 'button' }, 'Close'), again = el('button', { type: 'button', class: 'main' }, 'Try again');
    c.addEventListener('click', close); again.addEventListener('click', () => check(to));
    btns.append(c, again);
    const esc = el('p', { class: 'uis-esc' }, 'Escape hatch: add ?ui=classic to any address to open Classic.');
    show([h, ul, w, p, btns, esc]);
    again.focus();
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ui-target]');
    if (!b) return;
    e.preventDefault();
    const to = b.getAttribute('data-ui-target');
    if (!PAGES[to] || to === here) return;
    confirmStep(to);
  });
})();
