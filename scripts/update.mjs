// NATGAS live forecast builder.
// Runs in GitHub Actions every ~5 minutes. No dependencies (Node 20+).
// 1. Fetches Henry Hub front-month prices (Yahoo Finance, fallbacks: CNBC quote, Stooq daily).
// 2. Fetches headlines from trusted outlets (Google News RSS filtered by source + EIA RSS) about every 15 min.
// 3. Scores news sentiment and technical signals, then builds 1/3/5-trading-day forecasts.
// 4. Writes site/data/latest.json for the static page.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'site', 'data', 'latest.json');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const NEWS_EVERY_MIN = Number(process.env.NEWS_EVERY_MIN || 15);
const OFFLINE = process.env.OFFLINE_FIXTURES; // folder with fixtures for local testing
const FAILED = []; // every failed source, for diagnostics

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, { type = 'text', timeout = 15000, retries = 1 } = {}) {
  if (OFFLINE) return offline(url, type);
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeout);
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: type === 'json' ? 'application/json,text/plain,*/*' : '*/*', 'Accept-Language': 'en-US,en;q=0.9' }, signal: ctl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return type === 'json' ? await res.json() : await res.text();
    } catch (e) {
      lastErr = e;
      await sleep(800);
    }
  }
  throw new Error(`${new URL(url).host}: ${lastErr?.message || lastErr}`);
}
async function offline(url, type) {
  const map = JSON.parse(await readFile(join(OFFLINE, 'map.json'), 'utf8'));
  const key = Object.keys(map).find((k) => url.includes(k));
  if (!key) throw new Error(`no fixture for ${url}`);
  const txt = await readFile(join(OFFLINE, map[key]), 'utf8');
  return type === 'json' ? JSON.parse(txt) : txt;
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const stdev = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const sma = (a, n) => (a.length >= n ? mean(a.slice(-n)) : null);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const round = (x, d = 3) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
function normCdf(x) { // Abramowitz-Stegun
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
function nyParts(date) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const o = Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
  return { wd: o.weekday, y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, min: +o.minute };
}
function marketStatus(now) {
  // CME Henry Hub (NG) Globex: Sun 18:00 – Fri 17:00 ET, daily break 17:00–18:00 ET.
  const p = nyParts(now);
  const hm = p.h * 60 + p.min;
  if (p.wd === 'Sat') return 'closed';
  if (p.wd === 'Sun') return hm >= 18 * 60 ? 'open' : 'closed';
  if (p.wd === 'Fri' && hm >= 17 * 60) return 'closed';
  if (hm >= 17 * 60 && hm < 18 * 60) return 'break';
  return 'open';
}
function targetSettle(now, h) {
  // NG settles at 14:30 ET. Horizon h = the h-th settlement at least ~6 hours from now (weekends skipped; US holidays not modelled).
  const p = nyParts(now);
  let d = new Date(Date.UTC(p.y, p.m - 1, p.d));
  const isWeekend = (x) => x.getUTCDay() === 0 || x.getUTCDay() === 6;
  const nowMin = p.h * 60 + p.min;
  if (isWeekend(d) || nowMin > 8 * 60 + 30) { do { d = new Date(d.getTime() + 864e5); } while (isWeekend(d)); }
  for (let k = 1; k < h; k++) { do { d = new Date(d.getTime() + 864e5); } while (isWeekend(d)); }
  return d;
}

// ---------- prices ----------
function parseYahoo(j) {
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error('yahoo: empty result');
  const q = r.indicators?.quote?.[0] || {};
  const rows = (r.timestamp || []).map((t, i) => ({ t: t * 1000, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i] }))
    .filter((x) => x.c != null && isFinite(x.c));
  return { meta: r.meta || {}, rows };
}
// Yahoo rate-limits cookie-less requests from cloud IPs (HTTP 429). Get a session cookie + crumb first, like a browser.
let YSESSION = null;
async function yahooSession() {
  if (YSESSION) return YSESSION;
  const r1 = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, redirect: 'manual' }).catch(() => null);
  const cookies = (r1?.headers?.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  let crumb = '';
  for (const h of ['query2', 'query1']) {
    try {
      const r2 = await fetch(`https://${h}.finance.yahoo.com/v1/test/getcrumb`, { headers: { 'User-Agent': UA, Cookie: cookies } });
      if (r2.ok) { crumb = (await r2.text()).trim(); if (crumb && !crumb.includes('<')) break; }
    } catch { /* try next */ }
  }
  YSESSION = { cookies, crumb };
  return YSESSION;
}
async function yahoo(range, interval) {
  if (OFFLINE) return parseYahoo(await get(`https://query2.finance.yahoo.com/v8/finance/chart/NG=F?range=${range}&interval=${interval}`, { type: 'json' }));
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let err;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ses = attempt === 0 ? { cookies: '', crumb: '' } : await yahooSession();
    for (const h of hosts) {
      try {
        const url = `https://${h}/v8/finance/chart/NG=F?range=${range}&interval=${interval}&includePrePost=false${ses.crumb ? '&crumb=' + encodeURIComponent(ses.crumb) : ''}`;
        const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...(ses.cookies ? { Cookie: ses.cookies } : {}) }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}${attempt ? ' (with cookie)' : ''}`);
        return parseYahoo(await res.json());
      } catch (e) { err = new Error(`${h}: ${e.message}`); }
    }
  }
  throw err;
}
async function cnbcLast() {
  const j = await get('https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=%40NG.1&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json', { type: 'json' });
  const q = j?.FormattedQuoteResult?.FormattedQuote?.[0];
  const num = (v) => { const x = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isFinite(x) ? x : null; };
  const last = num(q?.last);
  if (last == null) throw new Error('cnbc: no price');
  return { last, prev: num(q?.previous_day_closing), open: num(q?.open), high: num(q?.high), low: num(q?.low) };
}
function sessionDate(now) {
  // NY date the current/next NG session settles on (after 17:00 ET or at weekends it's the next weekday)
  const p = nyParts(now);
  let d = new Date(Date.UTC(p.y, p.m - 1, p.d));
  const wk = (x) => x.getUTCDay() === 0 || x.getUTCDay() === 6;
  if (p.h >= 17 || wk(d)) { do { d = new Date(d.getTime() + 864e5); } while (wk(d)); }
  return d.toISOString().slice(0, 10);
}
async function seedDaily() {
  const j = JSON.parse(await readFile(join(ROOT, 'data', 'seed-daily.json'), 'utf8'));
  return j.rows.map(([D, o, h, l, c]) => ({ t: Date.parse(D + 'T22:00:00Z'), o, h, l, c }));
}

async function loadPrices(prev, now) {
  const status = [];
  let daily = null, intraday = null, meta = {}, last = null, prevClose = null, source = null, q = null;
  try {
    const d = await yahoo('1y', '1d');
    daily = d.rows; meta = d.meta; source = 'Yahoo Finance (NG=F)';
    status.push({ name: 'Yahoo Finance daily', ok: true });
  } catch (e) { status.push({ name: 'Yahoo Finance daily', ok: false, error: e.message }); }
  if (daily) {
    try { const i = await yahoo('5d', '5m'); intraday = i.rows; meta = { ...meta, ...i.meta }; status.push({ name: 'Yahoo Finance intraday', ok: true }); }
    catch (e) { status.push({ name: 'Yahoo Finance intraday', ok: false, error: e.message }); }
  }
  if (meta.regularMarketPrice) { last = meta.regularMarketPrice; prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null; }
  if (intraday?.length) last = intraday.at(-1).c;
  if (last == null) {
    try { q = await cnbcLast(); last = q.last; prevClose = q.prev; status.push({ name: 'CNBC live quote (@NG.1)', ok: true }); }
    catch (e) { status.push({ name: 'CNBC live quote (@NG.1)', ok: false, error: e.message }); }
  }
  let stale = false;
  if (last == null && prev?.price?.last != null) { last = prev.price.last; prevClose = prev.price.prevClose; stale = true; }

  if (!daily) {
    // Self-maintained history: bootstrap file + bars kept from earlier runs, with today's bar updated from the live quote.
    const byDate = new Map();
    try { for (const r of await seedDaily()) byDate.set(new Date(r.t).toISOString().slice(0, 10), r); } catch { /* no seed */ }
    for (const r of prev?.price?.daily || []) byDate.set(r.date, { t: Date.parse(r.date + 'T22:00:00Z'), o: r.o, h: r.h, l: r.l, c: r.c });
    if (last != null && !stale) {
      const sd = sessionDate(new Date(now));
      const bar = byDate.get(sd) || { t: Date.parse(sd + 'T22:00:00Z'), o: q?.open ?? last, h: last, l: last, c: last };
      bar.c = last;
      bar.h = Math.max(bar.h ?? last, q?.high ?? last, last);
      bar.l = Math.min(bar.l ?? last, q?.low ?? last, last);
      byDate.set(sd, bar);
    }
    daily = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, r]) => r).slice(-260);
    source = 'CNBC live quote + self-maintained daily history';
    if (prevClose == null) {
      const sd = sessionDate(new Date(now));
      const before = daily.filter((r) => new Date(r.t).toISOString().slice(0, 10) < sd);
      prevClose = before.at(-1)?.c ?? null;
    }
  }
  if (!intraday?.length) {
    // Build the session chart from our own samples (one per run) when Yahoo intraday isn't available.
    const pts = (prev?.price?.intraday || []).filter(([t]) => now - t < 24 * 36e5);
    if (last != null && !stale && marketStatus(new Date(now)) === 'open') pts.push([now, last]);
    intraday = pts.map(([t, c]) => ({ t, c }));
  }
  if (!daily?.length || last == null) { FAILED.push(...status.filter((x) => !x.ok)); throw new Error('No price data from any source'); }
  if (prevClose == null && daily.length > 1) prevClose = daily.at(-2).c;
  const lastTime = intraday?.length ? intraday.at(-1).t : (meta.regularMarketTime ? meta.regularMarketTime * 1000 : now);
  return { daily, intraday: intraday || [], last, prevClose, lastTime, source: source || prev?.price?.source, stale, status };
}

// ---------- news ----------
const TRUSTED = [
  'reuters', 'bloomberg', 'natural gas intelligence', 'ngi', 'fxempire', 'fx empire', 'barchart', 'nasdaq', 'energy intelligence',
  's&p global', 'spglobal', 'eia', 'energy information administration', 'investing.com', 'marketwatch', 'wall street journal', 'wsj',
  'cnbc', 'financial times', 'argus', 'rbn energy', 'trading economics', 'tradingeconomics', 'oilprice', 'associated press', 'ap news',
  'rigzone', 'icis', 'platts', 'kpler', 'american gas association', 'aga', 'world oil', 'hart energy', 'forbes', 'yahoo finance', 'morningstar'
];
const QUERIES = [
  'natural gas futures when:3d',
  '"Henry Hub" natural gas when:3d',
  'natural gas storage EIA when:7d',
  'LNG feedgas when:5d',
  'natural gas prices weather forecast when:3d'
];
const RELEVANT = /(natural gas|nat-?gas|henry hub|\blng\b|feedgas|natgas|nymex|\bttf\b|european gas|storage (build|injection|draw|withdrawal)|\bgas (futures|market|storage|output|production|demand|exports?|supply|rig))/i;

function decodeEntities(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/<[^>]+>/g, '').trim();
}
function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/g)) {
    const it = m[0];
    const tag = (n) => { const r = it.match(new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)<\\/${n}>`)); return r ? decodeEntities(r[1]) : ''; };
    const srcUrl = (it.match(/<source[^>]*url="([^"]+)"/) || [])[1] || '';
    items.push({ title: tag('title'), link: tag('link'), pubDate: tag('pubDate'), source: tag('source'), sourceUrl: srcUrl });
  }
  return items;
}
function isTrusted(name, url) {
  const s = `${name} ${url}`.toLowerCase();
  return TRUSTED.some((t) => (t.length <= 4 ? new RegExp(`\\b${t}\\b`).test(s) : s.includes(t)));
}

// Sentiment lexicon for natural gas PRICE direction. Weight per phrase.
const LEX = [
  // weather / demand
  [/\b(colder|cold snap|cold blast|cold weather|cold front|cooler|chill|freez\w*|frigid|arctic|polar vortex|winter storm|snowstorm|below[- ]normal temp\w*)\b/i, +1.0],
  [/\b(warmer|warm(th)?|mild(er)?|above[- ]normal temp\w*|heat wave|el ni[nñ]o|balmy)\b/i, -1.0],
  [/\b(heating demand (rise|jump|climb|surge)s?|demand (rise|jump|surge|climb)s?|record demand)\b/i, +0.8],
  [/\b(weak demand|light demand|low demand|demand (falls|drops|slumps|eases))\b/i, -0.8],
  // storage
  [/\b((smaller|lighter)[- ]than[- ]expected|below[- ]average( storage)? (build|injection)|(bigger|larger)[- ]than[- ]expected( storage)? (draw|withdrawal)|storage deficit)\b/i, +1.2],
  [/\b((larger|bigger|heavier)[- ]than[- ]expected( storage)? (build|injection|rise)|above[- ](average|normal)( storage)? (build|injection)|storage surplus|surplus widens|bearish storage)\b/i, -1.2],
  [/\b(withdrawal|draws? from storage)\b/i, +0.4],
  // supply
  [/\b(output (drops?|dips?|falls?|declines?|slips?)|production (drops?|dips?|falls?|declines?|slips?)|lower output|lower production|curtail\w*|freeze[- ]offs?|9-month low in output|shut[- ]?ins?)\b/i, +1.0],
  [/\b(record (output|production)|output (rises?|climbs?|jumps?|hits record)|production (rises?|climbs?|jumps?|hits record)|oversuppl\w*|glut|ample suppl\w*|supply cushion)\b/i, -1.0],
  // LNG
  [/\b(record (lng|feedgas|exports?)|feedgas (record|rises?|climbs?|jumps?|surges?)|lng (exports?|flows?) (rise|climb|jump|surge|hit record)\w*|golden pass|ramp(s|ing)? up)\b/i, +0.8],
  [/\b(lng|exports?|feedgas)\b[^.]{0,30}\brecords?\b/i, +0.8],
  [/\b((lng|freeport|terminal|train)\b[^.]{0,40}\b(outage|trip|shut|offline|halt|cut)s?|feedgas (falls?|drops?|dips?|slips?))\b/i, -0.9],
  // geopolitics / global
  [/\b(ceasefire|peace (talks|deal|hopes)|de-?escalat\w*|reopen\w* (the )?strait)\b/i, -0.6],
  [/\b(strait of hormuz (closure|closed)|supply disruption|attack on|escalat\w*|sanction\w*)\b/i, +0.6],
  // price action (weaker evidence)
  [/\b(rall(y|ies|ied)|surg(e|es|ed)|jump(s|ed)?|soar(s|ed)?|climb(s|ed)?|rebound(s|ed)?|bounce(s|d)?|reclaim(s|ed)?|gain(s|ed)?|higher|rises?|rose|spikes?)\b/i, +0.45],
  [/\b(fall(s)?|fell|drop(s|ped)?|slide(s)?|slid|slump(s|ed)?|tumble(s|d)?|plunge(s|d)?|sink(s)?|sank|retreat(s|ed)?|lower|decline(s|d)?|weak(er)?|nosediv\w*|pressure(d)?)\b/i, -0.45]
];
function scoreHeadline(title) {
  let s = 0; const hits = [];
  for (const [re, w] of LEX) { const m = title.match(re); if (m) { s += w; hits.push(m[0].toLowerCase()); } }
  return { score: clamp(s, -2.5, 2.5), hits };
}

async function loadNews(prev, now) {
  const status = [];
  const prevAt = prev?.news?.fetchedAt ? Date.parse(prev.news.fetchedAt) : 0;
  const minuteSlot = new Date(now).getUTCMinutes() % NEWS_EVERY_MIN < 5;
  const due = !prev?.news?.items?.length || now - prevAt > (NEWS_EVERY_MIN - 1) * 60e3 || (minuteSlot && now - prevAt > 9 * 60e3);
  if (!due) return { ...prev.news, reused: true, status: [{ name: 'News (reused, refreshes every ~15 min)', ok: true }] };

  const all = [];
  for (const q of QUERIES) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
    try { all.push(...parseRss(await get(url))); status.push({ name: `Google News: ${q}`, ok: true }); }
    catch (e) { status.push({ name: `Google News: ${q}`, ok: false, error: e.message }); }
  }
  try {
    const eia = parseRss(await get('https://www.eia.gov/rss/todayinenergy.xml')).map((x) => ({ ...x, source: x.source || 'EIA', sourceUrl: 'https://www.eia.gov' }));
    all.push(...eia); status.push({ name: 'EIA Today in Energy RSS', ok: true });
  } catch (e) { status.push({ name: 'EIA Today in Energy RSS', ok: false, error: e.message }); }

  const seen = new Set();
  const items = [];
  for (const it of all) {
    // Google News titles end with " - Source"
    let title = it.title; let source = it.source;
    const dash = title.lastIndexOf(' - ');
    if (dash > 20 && source && title.slice(dash + 3).trim().toLowerCase() === source.toLowerCase()) title = title.slice(0, dash);
    if (!RELEVANT.test(title)) continue;
    if (!isTrusted(source, it.sourceUrl)) continue;
    const t = Date.parse(it.pubDate);
    if (!isFinite(t) || now - t > 7 * 864e5 || t - now > 36e5) continue;
    const key = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 90);
    if (seen.has(key)) continue;
    seen.add(key);
    const sc = scoreHeadline(title);
    items.push({ title, source, link: it.link, publishedAt: new Date(t).toISOString(), score: round(sc.score, 2), hits: sc.hits });
  }
  items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  if (!items.length && prev?.news?.items?.length) return { ...prev.news, reused: true, status: [...status, { name: 'No fresh trusted headlines; kept previous', ok: false }] };
  return { fetchedAt: new Date(now).toISOString(), items: items.slice(0, 60), reused: false, status };
}

// ---------- signals + forecast ----------
function rsi(closes, n = 14) {
  if (closes.length <= n) return null;
  let g = 0, l = 0;
  for (let i = closes.length - n; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  if (l === 0) return 100;
  const rs = g / l; return 100 - 100 / (1 + rs);
}

function buildForecast(px, news, now) {
  const closes = px.daily.map((r) => r.c);
  const series = [...closes];
  // replace/append today's live price
  const lastDay = new Date(px.daily.at(-1).t).toISOString().slice(0, 10);
  const today = (() => { const p = nyParts(new Date(now)); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; })();
  if (lastDay >= today) series[series.length - 1] = px.last; else series.push(px.last);
  const rets = [];
  for (let i = 1; i < series.length; i++) rets.push(clamp(Math.log(series[i] / series[i - 1]), -0.12, 0.12)); // caps contract-roll jumps
  const sigma20 = stdev(rets.slice(-20));
  const sigma60 = stdev(rets.slice(-60));
  const sigma = clamp(Math.sqrt(0.6 * sigma20 ** 2 + 0.4 * sigma60 ** 2), 0.012, 0.09);

  const last = px.last;
  const s20 = sma(series, 20), s50 = sma(series, 50), s200 = sma(series, 200);
  const r = rsi(series, 14);
  const ret5 = series.length > 5 ? Math.log(last / series.at(-6)) : 0;

  // News sentiment: recency-weighted (half-life ~ 18h), trusted headlines from the last 72h
  const recent = (news.items || []).filter((n) => now - Date.parse(n.publishedAt) < 72 * 36e5);
  let wsum = 0, ssum = 0;
  for (const n of recent) { const age = (now - Date.parse(n.publishedAt)) / 36e5; const w = Math.pow(0.5, age / 18); wsum += w; ssum += w * n.score; }
  const newsRaw = wsum > 0 ? ssum / wsum : 0;
  const newsSig = Math.tanh(newsRaw * 0.9);

  const trendSig = s20 ? Math.tanh((last / s20 - 1) / (sigma * Math.sqrt(5))) : 0;
  const momSig = Math.tanh(ret5 / (sigma * Math.sqrt(5)));
  const rsiSig = r == null ? 0 : r < 30 ? clamp((30 - r) / 15, 0, 1) : r > 70 ? -clamp((r - 70) / 15, 0, 1) : 0;
  const signals = [
    { id: 'news', name: 'News sentiment', weight: 0.45, value: newsSig, detail: `${recent.length} trusted headlines in the last 72h, recency-weighted score ${newsRaw.toFixed(2)}` },
    { id: 'trend', name: 'Trend vs 20-day average', weight: 0.2, value: trendSig, detail: s20 ? `Price ${(100 * (last / s20 - 1)).toFixed(1)}% vs 20-day average $${s20.toFixed(3)}` : 'Not enough history' },
    { id: 'momentum', name: '5-day momentum', weight: 0.15, value: momSig, detail: `${(100 * (Math.exp(ret5) - 1)).toFixed(1)}% over 5 sessions` },
    { id: 'rsi', name: 'Overbought / oversold (RSI 14)', weight: 0.2, value: rsiSig, detail: r == null ? 'Not enough history' : `RSI ${r.toFixed(0)} (below 30 oversold, above 70 overbought)` }
  ].map((s) => ({ ...s, value: round(s.value, 3), contribution: round(s.value * s.weight, 3) }));
  const score = clamp(signals.reduce((t, s) => t + s.value * s.weight, 0), -1, 1);
  const driftPerDay = score * 0.25 * sigma;

  const horizons = {};
  for (const h of [1, 3, 5]) {
    const mu = driftPerDay * h, sd = sigma * Math.sqrt(h);
    const target = targetSettle(new Date(now), h);
    horizons[h] = {
      days: h,
      targetDate: target.toISOString().slice(0, 10),
      center: round(last * Math.exp(mu)),
      changePct: round(100 * (Math.exp(mu) - 1), 2),
      lo68: round(last * Math.exp(mu - sd)), hi68: round(last * Math.exp(mu + sd)),
      lo90: round(last * Math.exp(mu - 1.645 * sd)), hi90: round(last * Math.exp(mu + 1.645 * sd)),
      pUp: round(normCdf(mu / sd), 3)
    };
  }
  const bias = score > 0.15 ? 'Bullish lean' : score < -0.15 ? 'Bearish lean' : 'Neutral';

  // Key levels
  const prevBar = px.daily.length > 1 ? (lastDay === today ? px.daily.at(-2) : px.daily.at(-1)) : null;
  const levels = [];
  const add = (label, price, kind) => { if (price != null && isFinite(price)) levels.push({ label, price: round(price), kind }); };
  add('20-day average', s20, last >= s20 ? 'support' : 'resistance');
  add('50-day average', s50, s50 && last >= s50 ? 'support' : 'resistance');
  add('200-day average', s200, s200 && last >= s200 ? 'support' : 'resistance');
  const win = px.daily.slice(-20);
  add('20-day high', Math.max(...win.map((x) => x.h ?? x.c)), 'resistance');
  add('20-day low', Math.min(...win.map((x) => x.l ?? x.c)), 'support');
  if (prevBar?.h && prevBar?.l) {
    const P = (prevBar.h + prevBar.l + prevBar.c) / 3;
    add('Daily pivot', P, last >= P ? 'support' : 'resistance');
    add('Pivot R1', 2 * P - prevBar.l, 'resistance');
    add('Pivot S1', 2 * P - prevBar.h, 'support');
  }
  levels.sort((a, b) => b.price - a.price);

  return { sigmaDaily: round(sigma, 4), score: round(score, 3), bias, signals, horizons, levels, rsi: round(r, 1) };
}

// ---------- main ----------
function siteUrl() {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/?$/, '/');
  const repo = process.env.GITHUB_REPOSITORY; // owner/name
  if (!repo) return null;
  const [owner, name] = repo.split('/');
  return name.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${owner}.github.io/` : `https://${owner}.github.io/${name}/`;
}

async function main() {
  const now = Date.now();
  let prev = null;
  const base = siteUrl();
  if (base && !OFFLINE) { try { prev = await get(`${base}data/latest.json?t=${now}`, { type: 'json', retries: 0 }); if (prev?.price) { await mkdir(dirname(OUT), { recursive: true }); await writeFile(OUT, JSON.stringify(prev)); } else prev = null; } catch { /* first run */ } }
  if (!prev) { try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* none */ } }

  const px = await loadPrices(prev, now);
  const news = await loadNews(prev, now);
  const fc = buildForecast(px, news, now);

  const daily = px.daily.slice(-260).map((r) => ({ date: new Date(r.t).toISOString().slice(0, 10), o: round(r.o), h: round(r.h), l: round(r.l), c: round(r.c) }));
  const lastSession = px.intraday.length ? (() => {
    const lastT = px.intraday.at(-1).t; return px.intraday.filter((x) => lastT - x.t < 24 * 36e5).map((x) => [x.t, round(x.c)]);
  })() : [];

  const out = {
    generatedAt: new Date(now).toISOString(),
    instrument: 'Henry Hub natural gas, NYMEX front-month futures (NG=F)',
    market: marketStatus(new Date(now)),
    price: {
      last: round(px.last), prevClose: round(px.prevClose),
      change: px.prevClose ? round(px.last - px.prevClose) : null,
      changePct: px.prevClose ? round(100 * (px.last / px.prevClose - 1), 2) : null,
      asOf: new Date(px.lastTime).toISOString(), source: px.source, stale: px.stale,
      daily, intraday: lastSession
    },
    forecast: fc,
    news: { fetchedAt: news.fetchedAt, items: news.items },
    sources: [...px.status, ...news.status],
    method: 'Ranges = live price x exp(drift x days +/- z x daily volatility x sqrt(days)); volatility blends 20- and 60-session realised volatility; drift = weighted signal score x 0.25 x daily volatility. 68% band z=1, 90% band z=1.645. Signals: news sentiment from trusted outlets (45%), trend vs 20-day average (20%), 5-day momentum (15%), RSI mean reversion (20%).'
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log(`OK ${out.generatedAt} last=${out.price.last} bias=${fc.bias} score=${fc.score} news=${news.items?.length} reused=${!!news.reused}`);
  for (const s of out.sources) if (!s.ok) console.log(`::warning title=${s.name}::${(s.error || 'no answer').replace(/\n/g, ' ')}`);
}

main().catch(async (e) => {
  // Never leave the site without data: publish an error state the page can show, and surface details as public annotations.
  console.log(`::error title=Forecast build failed::${String(e?.message || e).replace(/\n/g, ' ')}`);
  for (const s of FAILED) console.log(`::warning title=${s.name}::${(s.error || 'no answer').replace(/\n/g, ' ')}`);
  try {
    let prevOut = null;
    try { prevOut = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* none */ }
    if (!prevOut?.price) {
      await mkdir(dirname(OUT), { recursive: true });
      await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), error: String(e?.message || e), sources: FAILED }));
    }
  } catch { /* ignore */ }
  process.exit(0);
});
