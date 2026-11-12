// NATGAS live forecast builder.
// Runs in GitHub Actions about every 5 minutes. No dependencies (Node 20+).
// 1. Fetches prices: CNBC live quote + self-maintained daily history for futures, Twelve Data for other markets.
//    (Yahoo Finance blocks GitHub's servers with HTTP 429; it is only tried when USE_YAHOO=1.)
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
const USE_YAHOO = process.env.USE_YAHOO === '1'; // off: Yahoo answers HTTP 429 to GitHub Actions on every run

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, { type = 'text', timeout = 15000, retries = 1 } = {}) {
  if (OFFLINE) return offline(url, type);
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeout);
      const res = await fetch(url, { headers: type === 'json' ? { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*', 'Accept-Language': 'en-US,en;q=0.9' } : { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/rss+xml,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Upgrade-Insecure-Requests': '1', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' }, signal: ctl.signal });
      clearTimeout(t);
      if (!res.ok) { let msg = ''; try { const t = await res.text(); msg = (JSON.parse(t).message || '').slice(0, 160); } catch { /* not json */ } throw new Error(`HTTP ${res.status}${msg ? ' - ' + msg : ''}`); }
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
// ---------- exchange holidays ----------
// 'us': NYSE / Nasdaq full closures, which CME also uses for energy settlements (NATGAS): on these days there is
//       no settlement and trading counts towards the next day.
// 'ice': ICE Brent: only New Year's Day, Good Friday and Christmas Day stop it.
// 'none': currencies, spot metals and crypto.
function easterSunday(y) { // anonymous Gregorian algorithm
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(y, month - 1, day);
}
const HOL_CACHE = new Map();
function exchangeHolidays(y, kind) {
  const key = `${kind}:${y}`;
  if (HOL_CACHE.has(key)) return HOL_CACHE.get(key);
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const nth = (mon, wd, n) => { const first = new Date(Date.UTC(y, mon, 1)).getUTCDay(); return Date.UTC(y, mon, 1 + ((wd - first + 7) % 7) + 7 * (n - 1)); };
  const lastMon = (mon) => { const last = new Date(Date.UTC(y, mon + 1, 0)); return Date.UTC(y, mon, last.getUTCDate() - ((last.getUTCDay() + 6) % 7)); };
  // a fixed-date holiday on Saturday is observed on Friday, on Sunday on Monday (New Year's Day on a Saturday is not moved into December)
  const observed = (mon, day, moveBack = true) => { const t = Date.UTC(y, mon, day), w = new Date(t).getUTCDay(); return w === 6 ? (moveBack ? t - 864e5 : null) : w === 0 ? t + 864e5 : t; };
  const goodFriday = easterSunday(y) - 2 * 864e5;
  let days = [];
  if (kind === 'us') days = [observed(0, 1, false), nth(0, 1, 3), nth(1, 1, 3), goodFriday, lastMon(4), observed(5, 19), observed(6, 4), nth(8, 1, 1), nth(10, 4, 4), observed(11, 25)];
  else if (kind === 'ice') days = [observed(0, 1, false), goodFriday, observed(11, 25)];
  const set = new Set(days.filter((t) => t != null).map(iso));
  HOL_CACHE.set(key, set);
  return set;
}
// which holiday calendar a market follows
function holKind(m) {
  const c = m?.category;
  if (m?.id === 'NATGAS' || /natural gas|nat-?gas/i.test(`${m?.name || ''}`)) return 'us';
  if (c === 'energy') return 'ice';
  if (c === 'equity' || c === 'etf' || c === 'index') return 'us';
  return 'none';
}
const isSession = (t, kind, everyDay) => { const d = new Date(t); const w = d.getUTCDay(); if (!everyDay && (w === 0 || w === 6)) return false; return kind === 'none' || !kind || !exchangeHolidays(d.getUTCFullYear(), kind).has(d.toISOString().slice(0, 10)); };
function nextSessions(now, h, everyDay, kind) {
  // h-th next daily close after today (weekends and exchange holidays skipped unless the market trades every day, e.g. crypto)
  let d = new Date(new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z');
  for (let k = 0; k < h;) { d = new Date(d.getTime() + 864e5); if (isSession(d, kind, everyDay)) k++; }
  return d;
}
const US_CASH = ['equity', 'etf', 'index']; // close 16:00 New York; currencies, metals and oil roll at 17:00
function targetClose(now, h, calendar, category, kind) {
  // Same rule for every market: the h-th daily close that is at least ~6 hours away.
  // Before this, non-futures markets counted from the UTC date, so late in the US evening the "1-day" forecast pointed two closes ahead.
  if (calendar === 'ng') return targetSettle(new Date(now), h, 8 * 60 + 30, kind);
  if (calendar === 'daily') { // crypto: daily bars close at 24:00 UTC
    const d = new Date(now); let t = Date.parse(d.toISOString().slice(0, 10) + 'T00:00:00Z');
    if (d.getUTCHours() >= 18) t += 864e5;
    return new Date(t + (h - 1) * 864e5);
  }
  return targetSettle(new Date(now), h, US_CASH.includes(category) ? 10 * 60 : 11 * 60, kind);
}
function targetSettle(now, h, cutoffMin = 8 * 60 + 30, kind = 'none') {
  // NG settles at 14:30 ET. Horizon h = the h-th settlement at least ~6 hours from now (weekends and the market's exchange holidays skipped).
  // cutoffMin = the close minus 6 hours, in New York minutes of the day (08:30 for NG).
  const p = nyParts(now);
  let d = new Date(Date.UTC(p.y, p.m - 1, p.d));
  const isWeekend = (x) => !isSession(x, kind);
  const nowMin = p.h * 60 + p.min;
  if (isWeekend(d) || nowMin > cutoffMin) { do { d = new Date(d.getTime() + 864e5); } while (isWeekend(d)); }
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
async function yahoo(range, interval, sym = 'NG=F') {
  if (OFFLINE) return parseYahoo(await get(`https://query2.finance.yahoo.com/v8/finance/chart/${sym}?range=${range}&interval=${interval}`, { type: 'json' }));
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let err;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ses = attempt === 0 ? { cookies: '', crumb: '' } : await yahooSession();
    for (const h of hosts) {
      try {
        const url = `https://${h}/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}&includePrePost=false${ses.crumb ? '&crumb=' + encodeURIComponent(ses.crumb) : ''}`;
        const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...(ses.cookies ? { Cookie: ses.cookies } : {}) }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}${attempt ? ' (with cookie)' : ''}`);
        return parseYahoo(await res.json());
      } catch (e) { err = new Error(`${h}: ${e.message}`); }
    }
  }
  throw err;
}
async function cnbcLast(sym = '@NG.1') {
  const j = await get(`https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${encodeURIComponent(sym)}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`, { type: 'json' });
  const q = j?.FormattedQuoteResult?.FormattedQuote?.[0];
  const num = (v) => { const x = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isFinite(x) && x > 0 ? x : null; };
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
async function seedDaily(file = 'seed-daily.json') {
  const j = JSON.parse(await readFile(join(ROOT, 'data', file), 'utf8'));
  return j.rows.map(([D, o, h, l, c]) => ({ t: Date.parse(D + 'T22:00:00Z'), o, h, l, c }));
}

async function loadPrices(prev, now, cfg = { yahoo: 'NG=F', cnbc: '@NG.1', seed: 'seed-daily.json' }) {
  const status = [];
  let daily = null, intraday = null, meta = {}, last = null, prevClose = null, source = null, q = null;
  if (USE_YAHOO && cfg.yahoo) {
    try {
      const d = await yahoo('1y', '1d', cfg.yahoo);
      daily = d.rows; meta = d.meta; source = `Yahoo Finance (${cfg.yahoo})`;
      status.push({ name: 'Yahoo Finance daily', ok: true });
    } catch (e) { status.push({ name: 'Yahoo Finance daily', ok: false, error: e.message }); }
  }
  if (daily) {
    try { const i = await yahoo('5d', '5m', cfg.yahoo); intraday = i.rows; meta = { ...meta, ...i.meta }; status.push({ name: 'Yahoo Finance intraday', ok: true }); }
    catch (e) { status.push({ name: 'Yahoo Finance intraday', ok: false, error: e.message }); }
  }
  if (meta.regularMarketPrice) { last = meta.regularMarketPrice; prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null; }
  if (intraday?.length) last = intraday.at(-1).c;
  if (last == null) {
    try { q = await cnbcLast(cfg.cnbc); last = q.last; prevClose = q.prev; status.push({ name: `CNBC live quote (${cfg.cnbc})`, ok: true }); }
    catch (e) { status.push({ name: `CNBC live quote (${cfg.cnbc})`, ok: false, error: e.message }); }
  }
  let stale = false;
  if (last == null && prev?.price?.last != null) { last = prev.price.last; prevClose = prev.price.prevClose; stale = true; }

  if (!daily) {
    // Self-maintained history: bootstrap file + bars kept from earlier runs, with today's bar updated from the live quote.
    const byDate = new Map();
    try { for (const r of await seedDaily(cfg.seed)) byDate.set(new Date(r.t).toISOString().slice(0, 10), r); } catch { /* no seed */ }
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
    const pts = (prev?.price?.intraday || []).filter(([t]) => now - t < INTRADAY_KEEP_MS);
    // each sample also keeps the session's high and low so far (when the quote has them): the page turns new extremes into candle wicks
    if (last != null && !stale && marketStatus(new Date(now)) === 'open') pts.push([now, last, q?.high ?? null, q?.low ?? null]);
    intraday = pts.map(([t, c, h, l]) => ({ t, c, h, l }));
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

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', mdash: '-', ndash: '-', hellip: '...', eacute: 'e', ntilde: 'n', deg: ' deg' };
function decodeEntities(s) {
  return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ').trim();
}
function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/g)) {
    const it = m[0];
    const tag = (n) => { const r = it.match(new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)<\\/${n}>`)); return r ? decodeEntities(r[1]) : ''; };
    const srcUrl = (it.match(/<source[^>]*url="([^"]+)"/) || [])[1] || '';
    items.push({ title: tag('title'), link: tag('link'), pubDate: tag('pubDate'), source: tag('source'), sourceUrl: srcUrl, description: tag('description'), content: tag('content:encoded') });
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
  [/\b(stout|hefty|sizable|sizeable|large|big|heavy|bloated) (storage )?(build|injection)s?\b/i, -0.9],
  [/\b(above[- ](average|normal)|ample|bloated) (inventor\w*|stocks|storage)\b/i, -1.0],
  [/\b(storage|inventor\w*|stocks) (levels? )?(decline|declines|fall|falls|drop|drops|shrink\w*)\b/i, +1.2],
  [/\b(high note|finish(es|ed)? (higher|up)|weekly gain|best week)\b/i, +0.6],
  [/\b(low note|finish(es|ed)? (lower|down)|weekly loss|worst week)\b/i, -0.6],
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
function scoreHeadline(title, lex = LEX) {
  let s = 0; const hits = [];
  for (const [re, w] of lex) { const m = title.match(re); if (m) { s += w; hits.push(m[0].toLowerCase()); } }
  return { score: clamp(s, -2.5, 2.5), hits };
}

const PRICE_UP = LEX[LEX.length - 2], PRICE_DOWN = LEX[LEX.length - 1];
const GENERIC = [
  [/\b(upgrade[sd]?|beats? (estimates|expectations|forecasts)|tops? estimates|record high|all[- ]time high|strong demand|buybacks?|raises? (guidance|outlook|forecast)|bullish|breaks? out|breakout|inflows?)\b/i, +1.0],
  [/\b(downgrade[sd]?|miss(es|ed)? (estimates|expectations|forecasts)|cuts? (guidance|outlook|forecast)|bearish|sell-?off|recession (fears?|risk)|weak demand|profit warning|outflows?|investigation|lawsuit|recall|bankruptcy)\b/i, -1.0],
  [/\b(support (holds|level)|oversold|bargain hunting|short covering)\b/i, +0.4],
  [/\b(resistance|overbought|profit[- ]taking)\b/i, -0.4]
];
const RATES_RISK = [ // rate cuts help risk assets and gold
  [/\b(rate cuts?|dovish|stimulus|easing|soft landing)\b/i, +0.6],
  [/\b(rate hikes?|hawkish|tightening|higher for longer|sticky inflation)\b/i, -0.6]
];
const CAT_LEX = {
  energy: [
    [/\b(opec\+? (cuts?|curbs?)|output cuts?|supply (disruption|outage|risk)s?|inventor(y|ies) (draw|drop|fall)s?|crude draws?|sanctions?|attack on|escalat\w*|hurricane)\b/i, +1.0],
    [/\b(opec\+? (hikes?|raises?|boosts?)|output (hike|increase)s?|inventor(y|ies) (build|rise)s?|crude builds?|glut|oversuppl\w*|ceasefire|peace (talks|deal|hopes)|demand (worries|concerns))\b/i, -1.0]
  ],
  metal: [
    [/\b(safe[- ]haven|geopolitical (tension|risk)s?|dollar (weakens|slips|falls|drops)|weaker dollar|central bank (buying|purchases)|haven demand)\b/i, +1.0],
    [/\b(dollar (strengthens|rises|gains|jumps)|stronger dollar|risk[- ]on|yields? (rise|climb|jump)|etf outflows?)\b/i, -1.0],
    ...RATES_RISK
  ],
  crypto: [
    [/\b(etf (inflows?|approval)|institutional (buying|adoption)|halving|treasury (buys|purchases))\b/i, +1.0],
    [/\b(hack(ed)?|exploit|etf outflows?|crackdown|ban(s|ned)?|liquidations?)\b/i, -1.0],
    ...RATES_RISK
  ],
  equity: [...RATES_RISK],
  index: [...RATES_RISK],
  fx: []
};
function lexFor(category) { return [...(CAT_LEX[category] || []), ...GENERIC, PRICE_UP, PRICE_DOWN]; }

// Publisher feeds with direct article links (no Google redirect to resolve)
const DIRECT_FEEDS = [
  { name: 'EIA Today in Energy', url: 'https://www.eia.gov/rss/todayinenergy.xml', source: 'EIA' },
  { name: 'Nasdaq commodities (Barchart, RTTNews)', url: 'https://www.nasdaq.com/feed/rssoutbound?category=Commodities', source: 'Nasdaq' },
  { name: 'Rigzone', url: 'https://www.rigzone.com/news/rss/rigzone_latest.aspx', source: 'Rigzone' },
  { name: 'OilPrice.com', url: 'https://oilprice.com/rss/main', source: 'OilPrice.com' },
  { name: 'Natural Gas Intelligence', url: 'https://naturalgasintel.com/feed/', source: 'Natural Gas Intelligence' }
];
const READER_VERSION = 3;
const MAX_NEW_ARTICLES = 30;   // per refresh; earlier results are cached by link
const READ_CONCURRENCY = 5;

// Google News RSS links point to news.google.com; resolve them to the publisher's URL.
async function resolveGoogleNews(link) {
  const m = String(link).match(/news\.google\.com\/(?:rss\/)?articles\/([^?#]+)/);
  if (!m) return link;
  const id = m[1];
  const page = await get(`https://news.google.com/rss/articles/${id}?oc=5&hl=en-US&gl=US&ceid=US:en`, { timeout: 10000, retries: 0 });
  const sig = (page.match(/data-n-a-sg="([^"]+)"/) || [])[1];
  const ts = (page.match(/data-n-a-ts="([^"]+)"/) || [])[1];
  if (!sig || !ts) {
    const direct = (page.match(/data-n-au="([^"]+)"/) || [])[1];
    if (direct) return direct;
    throw new Error('google redirect: no signature');
  }
  const inner = JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts), sig]);
  const body = 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]));
  const res = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST', body, signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': UA, Referer: 'https://news.google.com/' }
  });
  const txt = await res.text();
  for (const line of txt.split('\n')) {
    if (!line.startsWith('[[')) continue;
    try {
      const arr = JSON.parse(line);
      const row = arr.find((r) => r[0] === 'wrb.fr' && typeof r[2] === 'string');
      const url = row && JSON.parse(row[2])[1];
      if (typeof url === 'string' && /^https?:\/\//.test(url)) return url;
    } catch { /* try next line */ }
  }
  throw new Error(`google redirect: HTTP ${res.status}, no url`);
}

// Pull the article body out of a publisher page: JSON-LD articleBody first, else <article>/<p> text.
function extractArticle(html) {
  let best = '';
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) return o.forEach(walk);
        if (typeof o.articleBody === 'string' && o.articleBody.length > best.length) best = o.articleBody;
        Object.values(o).forEach((v) => typeof v === 'object' && walk(v));
      };
      walk(JSON.parse(m[1].trim()));
    } catch { /* bad json */ }
  }
  best = decodeEntities(best);
  const clean = html.replace(/<(script|style|noscript|svg|nav|footer|header|aside|form)\b[\s\S]*?<\/\1>/gi, ' ');
  const scopes = [...clean.matchAll(/<article\b[\s\S]*?<\/article>/gi)].map((m) => m[0]);
  const paras = (src) => [...src.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => decodeEntities(m[1]))
    .filter((t) => t.length > 60 && !/(cookie|subscribe|sign up|newsletter|all rights reserved|enable javascript|log ?in to|create an account|advertis)/i.test(t));
  let fromHtml = paras(scopes.sort((a, b) => b.length - a.length)[0] || '').join('\n');
  if (fromHtml.length < 400) fromHtml = paras(clean).join('\n');
  const text = best.length > fromHtml.length * 0.8 ? best : fromHtml;
  const paywall = /(subscribe to (continue|read)|to continue reading|unlock this article|subscriber[- ]only|premium content|keep reading)/i.test(html);
  return { text: text.slice(0, 30000), paywall };
}

const GAS_SENTENCE = /(natural gas|nat-?gas|henry hub|\blng\b|feedgas|storage|inventor|injection|withdrawal|heating|weather|temperature|forecast|production|output|futures|nymex|prices?|demand|supply|freeport|el ni)/i;
function scoreBody(text, prof = GAS_PROFILE) {
  const LEXP = prof.lex;
  const PRICE_ACTION = new Set([LEXP.length - 2, LEXP.length - 1]);
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/).filter((x) => x.length > 30 && prof.sentence.test(x));
  let sum = 0, hitSentences = 0; const hits = new Map();
  for (const sen of sentences) {
    let sc = 0, fundamental = false; const found = [];
    LEXP.forEach(([re, w], i) => { const m = sen.match(re); if (m) { sc += PRICE_ACTION.has(i) ? w * 0.5 : w; if (!PRICE_ACTION.has(i)) fundamental = true; found.push(m[0].toLowerCase()); } });
    if (!found.length) continue;
    hitSentences++; sum += clamp(sc, -2, 2);
    if (fundamental) found.forEach((h) => hits.set(h, (hits.get(h) || 0) + 1));
  }
  // average over sentences that carry a signal, scaled up when many sentences agree
  const avg = sum / Math.max(3, hitSentences);
  const coverage = Math.min(1, hitSentences / 6);
  const score = clamp(avg * 1.6 * (0.5 + 0.5 * coverage), -2.5, 2.5);
  const top = [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([h]) => h);
  return { score, sentences: sentences.length, hitSentences, top };
}

const titleKey = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 90);
async function readArticle(item, feedText, prof) {
  return { v: READER_VERSION, ...(await readArticleInner(item, feedText, prof)) };
}
async function readArticleInner(item, feedText, prof) {
  let url = item.link, text = '', paywall = false, reason = '', via = 'page';
  try { url = await resolveGoogleNews(item.link); } catch (e) { reason = e.message; }
  if (!reason) {
    try { ({ text, paywall } = extractArticle(await get(url, { timeout: 12000, retries: 0 }))); }
    catch (e) { reason = e.message; }
  }
  const pageWords = text ? text.split(/\s+/).length : 0;
  const fw = feedText ? feedText.split(/\s+/).length : 0;
  if (fw > Math.max(pageWords, 60)) { text = feedText; via = 'publisher feed'; paywall = false; }
  const words = text ? text.split(/\s+/).length : 0;
  if (words < 60) {
    // Paywalled publishers (e.g. NGI) only expose a lead summary in their feed: use it rather than nothing.
    if (fw >= 20) {
      const body = scoreBody(feedText, prof);
      return { status: 'summary', via: 'publisher feed summary', url, words: fw, reason: reason || 'paywall', bodyScore: round(body.score, 2), keyPhrases: body.top };
    }
    return { status: 'headline', url, reason: reason || (paywall ? 'paywall' : 'no article text found'), words };
  }
  const body = scoreBody(text, prof);
  return { status: words < 250 || (paywall && via === 'page') ? 'partial' : 'full', via, url, words, bodyScore: round(body.score, 2), sentences: body.sentences, signalSentences: body.hitSentences, keyPhrases: body.top };
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

const GAS_PROFILE = { id: 'NATGAS', queries: QUERIES, relevant: RELEVANT, lex: LEX, sentence: GAS_SENTENCE, directFeeds: DIRECT_FEEDS, maxStories: 50 };
const GENERAL_FEEDS = DIRECT_FEEDS.filter((f) => !/naturalgasintel/.test(f.url));
function escapeRe(x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function profileFor(m) {
  const kw = (m.keywords && m.keywords.length ? m.keywords : [m.name.split(/[\s(),.\-\/]+/).filter((w) => w.length > 3 && !/^(inc|corp|class|common|stock|spot|the|limited|group|holdings?|plc|index|performance|ordinary|shares?)$/i.test(w)).slice(0, 3).join(' '), ...m.symbol.split(/[\/:]/).filter((w) => w.length > 2)]).filter(Boolean);
  const relevant = new RegExp(kw.map((k) => `\\b${escapeRe(k)}`).join('|'), 'i');
  const q = m.newsQuery || kw[0];
  return {
    id: m.id,
    queries: [`"${q}" when:3d`, `${q.replace(/ price$/i, '')} price outlook when:3d`],
    relevant, lex: lexFor(m.category),
    sentence: new RegExp(`${relevant.source}|price|market|demand|supply|rate|forecast|outlook|investor|trader`, 'i'),
    directFeeds: m.category === 'energy' || m.category === 'metal' ? GENERAL_FEEDS : [],
    maxStories: 25, maxReads: 10
  };
}
// One story's score. Keywords: the headline sets the angle and the article body carries most of the weight once read.
// AI-scored stories (see aiScoreNews): the AI's reading of the headline counts 75%, the keyword score of the body 25%;
// a story the AI judged not to be about this market scores 0 and is left out of the news signal.
function storyScore(it) {
  const body = it.read && it.read.status !== 'headline' && it.read.bodyScore != null;
  if (it.ai && it.ai.v === NEWS_AI_VERSION) {
    if (it.ai.rel === false) return 0;
    return round(body ? clamp(0.75 * it.ai.s + 0.25 * it.read.bodyScore, -2.5, 2.5) : it.ai.s, 2);
  }
  const wBody = it.read && it.read.status === 'summary' ? 0.5 : 0.7;
  return round(body ? clamp((1 - wBody) * it.headlineScore + wBody * it.read.bodyScore, -2.5, 2.5) : it.headlineScore, 2);
}
const FEEDTEXT = new Map();
async function loadNews(prev, now, prof = GAS_PROFILE) {
  const status = [];
  const prevAt = prev?.news?.fetchedAt ? Date.parse(prev.news.fetchedAt) : 0;
  const minuteSlot = new Date(now).getUTCMinutes() % NEWS_EVERY_MIN < 5;
  const prevHasReads = (prev?.news?.items || []).some((x) => x.read && x.read.v === READER_VERSION);
  const due = !prev?.news?.items?.length || !prevHasReads || now - prevAt > (NEWS_EVERY_MIN - 1) * 60e3 || (minuteSlot && now - prevAt > 9 * 60e3);
  if (!due) return { ...prev.news, reused: true, status: [{ name: 'News (reused, refreshes every ~15 min)', ok: true }] };

  const all = [];
  for (const q of prof.queries) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
    try { all.push(...parseRss(await get(url))); status.push({ name: `Google News: ${q}`, ok: true }); }
    catch (e) { status.push({ name: `Google News: ${q}`, ok: false, error: e.message }); }
  }
  for (const f of prof.directFeeds) {
    try {
      const got = parseRss(await get(f.url, { timeout: 12000, retries: 0 })).map((x) => ({ ...x, source: x.source || f.source, sourceUrl: f.url, direct: true }));
      for (const x of got) { const txt = decodeEntities(x.content || x.description || ''); if (txt.split(/\s+/).length >= 20) FEEDTEXT.set(titleKey(decodeEntities(x.title)), txt); }
      all.push(...got); status.push({ name: `${f.name} feed`, ok: true });
    } catch (e) { status.push({ name: `${f.name} feed`, ok: false, error: e.message }); }
  }

  const seen = new Set();
  const items = [];
  for (const it of all) {
    let title = decodeEntities(it.title); const source = it.source;
    const dash = title.lastIndexOf(' - ');
    if (dash > 20 && source && title.slice(dash + 3).trim().toLowerCase() === source.toLowerCase()) title = title.slice(0, dash);
    if (!prof.relevant.test(title)) continue;
    if (!isTrusted(source, it.sourceUrl)) continue;
    const t = Date.parse(it.pubDate);
    if (!isFinite(t) || now - t > 7 * 864e5 || t - now > 36e5) continue;
    const key = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 90);
    if (seen.has(key)) continue;
    seen.add(key);
    const sc = scoreHeadline(title, prof.lex);
    items.push({ title, source, link: it.link, publishedAt: new Date(t).toISOString(), headlineScore: round(sc.score, 2), hits: sc.hits, _key: key });
  }
  items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const top = items.slice(0, prof.maxStories || 50);

  // Read full articles: reuse earlier reads, read new ones (newest first)
  const cache = new Map((prev?.news?.items || []).filter((x) => x.read && x.read.v === READER_VERSION).map((x) => [x.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 90), x.read]));
  const toRead = [];
  for (const it of top) {
    const c = cache.get(it._key);
    if (c && (c.status !== 'headline' || now - Date.parse(it.publishedAt) > 6 * 36e5)) it.read = c;
    else if (toRead.length < (prof.maxReads ?? MAX_NEW_ARTICLES)) toRead.push(it);
  }
  if (OFFLINE) toRead.forEach((it) => { it.read = { status: 'headline', reason: 'offline test' }; });
  else await pool(toRead, READ_CONCURRENCY, async (it) => { it.read = await readArticle(it, FEEDTEXT.get(titleKey(it.title)), prof); });
  for (const it of top) {
    delete it._key;
    if (!it.read) it.read = { status: 'headline', reason: 'not read yet (queued for next refresh)' };
    it.score = storyScore(it);
  }
  const full = top.filter((x) => x.read.status === 'full').length, part = top.filter((x) => x.read.status === 'partial').length, summ = top.filter((x) => x.read.status === 'summary').length;
  status.push({ name: `Article reader: ${full} full, ${part} partial, ${summ} paywalled (summary only) of ${top.length} stories`, ok: full + part > 0 || !top.length, error: full + part ? '' : 'no article bodies could be read' });
  const failReasons = {};
  for (const x of top) if (x.read.status === 'headline' && x.read.reason) failReasons[x.read.reason.slice(0, 60)] = (failReasons[x.read.reason.slice(0, 60)] || 0) + 1;
  if (Object.keys(failReasons).length) console.log(`::notice title=Articles not read (${prof.id})::${Object.entries(failReasons).map(([k, v]) => `${v}x ${k}`).join(' | ')}`);
  if (!top.length && prev?.news?.items?.length) return { ...prev.news, reused: true, status: [...status, { name: 'No fresh trusted headlines; kept previous', ok: false }] };
  return { fetchedAt: new Date(now).toISOString(), items: top, reused: false, status };
}

// ---------- signals + forecast ----------
function rsi(closes, n = 14) {
  // Wilder's smoothing: the same formula as the chart's RSI panel and the analyst note
  if (closes.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
// Lowest daily volatility the model will assume, per asset class. One floor for everything (1.2%) made
// the ranges of calm markets (currencies, indices) about twice too wide.
const SIGMA_FLOOR = { fx: 0.0025, index: 0.005, etf: 0.005, metal: 0.005, equity: 0.008, energy: 0.012, crypto: 0.012 };

const WEIGHT = { news: 0.45, trend: 0.2, momentum: 0.15, rsi: 0.2 };
const DRIFT_K = 0.25; // drift per day = score x DRIFT_K x daily volatility. Backtest fit (Nov 2026, 5 markets, ~980 forecasts): 0.20 +/- 0.17, so 0.25 stays
// Width of the wide (90%) range in volatility units. A normal curve says 1.645, but over the last year only 87-89% of closes
// landed inside that; 1.75 gives 90.5% / 90.1% / 89.5% at 1 / 3 / 5 days. The 68% range (z = 1) covered 69-70% and is unchanged.
const Z90 = 1.75;
// Volatility and the three price signals from a series of daily closes (last element = the price being forecast from).
function techCore(series, category) {
  const rets = [];
  for (let i = 1; i < series.length; i++) rets.push(clamp(Math.log(series[i] / series[i - 1]), -0.12, 0.12)); // caps contract-roll jumps
  const sigma20 = stdev(rets.slice(-20));
  const sigma60 = stdev(rets.slice(-60));
  const sigma = clamp(Math.sqrt(0.6 * sigma20 ** 2 + 0.4 * sigma60 ** 2), SIGMA_FLOOR[category] ?? 0.012, 0.09);
  const last = series.at(-1);
  const s20 = sma(series, 20), s50 = sma(series, 50), s200 = sma(series, 200);
  const r = rsi(series, 14);
  const ret5 = series.length > 5 ? Math.log(last / series.at(-6)) : 0;
  const trendSig = s20 ? Math.tanh((last / s20 - 1) / (sigma * Math.sqrt(5))) : 0;
  const momSig = Math.tanh(ret5 / (sigma * Math.sqrt(5)));
  const rsiSig = r == null ? 0 : r < 30 ? clamp((30 - r) / 15, 0, 1) : r > 70 ? -clamp((r - 70) / 15, 0, 1) : 0;
  return { sigma, s20, s50, s200, r, ret5, trendSig, momSig, rsiSig };
}

function buildForecast(px, news, now, opts = { calendar: 'ng' }) {
  const closes = px.daily.map((r) => r.c);
  const series = [...closes];
  // replace/append today's live price
  const lastDay = new Date(px.daily.at(-1).t).toISOString().slice(0, 10);
  const today = opts.calendar === 'ng' ? (() => { const p = nyParts(new Date(now)); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; })() : (opts.today || new Date(now).toISOString().slice(0, 10));
  if (lastDay >= today) series[series.length - 1] = px.last; else series.push(px.last);
  const last = px.last;
  const { sigma, s20, s50, s200, r, ret5, trendSig, momSig, rsiSig } = techCore(series, opts.category);

  // News sentiment: recency-weighted (half-life ~ 18h), trusted headlines from the last 72h
  const recentAll = (news.items || []).filter((n) => now - Date.parse(n.publishedAt) < 72 * 36e5);
  const recent = recentAll.filter((n) => !(n.ai && n.ai.rel === false)); // stories the AI judged not to be about this market
  const nAi = recent.filter((n) => n.ai).length, offTopic = recentAll.length - recent.length;
  let wsum = 0, ssum = 0;
  for (const n of recent) { const age = (now - Date.parse(n.publishedAt)) / 36e5; const w = Math.pow(0.5, age / 18); wsum += w; ssum += w * n.score; }
  const newsRaw = wsum > 0 ? ssum / wsum : 0;
  const newsSig = Math.tanh(newsRaw * 0.9);

  const signals = [
    { id: 'news', name: 'News sentiment', weight: WEIGHT.news, value: newsSig, detail: `${recent.length} trusted stories in the last 72h (${recent.filter((n) => n.read && ['full', 'partial'].includes(n.read.status)).length} read in full or in part, ${recent.filter((n) => n.read && n.read.status === 'summary').length} paywalled summaries${nAi ? `, ${nAi} scored by AI` : ''}${offTopic ? `; ${offTopic} set aside as not about this market` : ''}), recency-weighted score ${newsRaw.toFixed(2)}` },
    { id: 'trend', name: 'Trend vs 20-day average', weight: WEIGHT.trend, value: trendSig, detail: s20 ? `Price ${(100 * (last / s20 - 1)).toFixed(1)}% vs 20-day average $${s20.toFixed(3)}` : 'Not enough history' },
    { id: 'momentum', name: '5-day momentum', weight: WEIGHT.momentum, value: momSig, detail: `${(100 * (Math.exp(ret5) - 1)).toFixed(1)}% over 5 sessions` },
    { id: 'rsi', name: 'Overbought / oversold (RSI 14)', weight: WEIGHT.rsi, value: rsiSig, detail: r == null ? 'Not enough history' : `RSI ${r.toFixed(0)} (below 30 oversold, above 70 overbought)` }
  ].map((s) => ({ ...s, value: round(s.value, 3), contribution: round(s.value * s.weight, 3) }));
  const score = clamp(signals.reduce((t, s) => t + s.value * s.weight, 0), -1, 1);
  const driftPerDay = score * DRIFT_K * sigma;
  const rd = (x) => round(x, last >= 20 ? 3 : 5); // currencies and low-priced markets need more than 3 decimals

  const horizons = {};
  for (const h of [1, 3, 5]) {
    const mu = driftPerDay * h, sd = sigma * Math.sqrt(h);
    const target = targetClose(now, h, opts.calendar, opts.category, opts.hol);
    horizons[h] = {
      days: h,
      targetDate: target.toISOString().slice(0, 10),
      center: rd(last * Math.exp(mu)),
      changePct: round(100 * (Math.exp(mu) - 1), 2),
      lo68: rd(last * Math.exp(mu - sd)), hi68: rd(last * Math.exp(mu + sd)),
      lo90: rd(last * Math.exp(mu - Z90 * sd)), hi90: rd(last * Math.exp(mu + Z90 * sd)),
      pUp: round(normCdf(mu / sd), 3)
    };
  }
  const bias = score > 0.15 ? 'Bullish lean' : score < -0.15 ? 'Bearish lean' : 'Neutral';

  // Key levels
  const prevBar = px.daily.length > 1 ? (lastDay === today ? px.daily.at(-2) : px.daily.at(-1)) : null;
  const levels = [];
  const add = (label, price, kind) => { if (price != null && isFinite(price)) levels.push({ label, price: rd(price), kind }); };
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

// ---------- scheduled events ----------
// What is known ahead of time and can move a market: weekly EIA reports, Fed decisions, a stock's next earnings date.
// They are shown on the forecast and given to the analyst. Ranges are NOT widened for them: over the last year the EIA
// report days were no more volatile at the close than other days (Thursday 0.96x for natural gas, Wednesday 1.13x for Brent).
const FOMC_DAYS = ['2026-12-09', '2027-01-27', '2027-03-17', '2027-04-28', '2027-06-09', '2027-07-28', '2027-09-15', '2027-10-27', '2027-12-08', '2028-01-26']; // decision days (14:00 New York), from federalreserve.gov; 2027 is tentative
// US Bureau of Labor Statistics release schedules (8:30 New York), from bls.gov/schedule; BLS can move a date.
const CPI_DAYS = ['2026-12-10', '2027-01-13', '2027-02-11', '2027-03-10', '2027-04-13', '2027-05-12', '2027-06-10', '2027-07-14', '2027-08-11', '2027-09-14', '2027-10-14', '2027-11-10', '2027-12-10'];
const JOBS_DAYS = ['2026-12-04', '2027-01-08', '2027-02-05', '2027-03-05', '2027-04-02', '2027-05-07', '2027-06-04', '2027-07-02', '2027-08-06', '2027-09-03', '2027-10-08', '2027-11-05', '2027-12-03'];
let CAL_WARNED = false;
function calendarsRunningOut(now) { // remind in the log a month before a date list ends
  if (CAL_WARNED) return; CAL_WARNED = true;
  for (const [name, list] of [['Fed decision days (FOMC_DAYS)', FOMC_DAYS], ['CPI dates (CPI_DAYS)', CPI_DAYS], ['jobs report dates (JOBS_DAYS)', JOBS_DAYS]])
    if (Date.parse(list.at(-1)) - now < 30 * 864e5) console.log(`::warning title=Calendar::${name} end on ${list.at(-1)}: add the next dates in scripts/update.mjs`);
}
const pad2 = (n) => String(n).padStart(2, '0');
function nyToUtc(date, h, min) { // a New York wall-clock time as a UTC instant (handles daylight saving)
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, h + 5, min);
  return nyParts(new Date(guess)).h === h ? guess : guess - 36e5;
}
function usHolidays(y) { // US federal holidays: EIA reports usually move a day in these weeks
  const nth = (mon, wd, n) => { const first = new Date(Date.UTC(y, mon, 1)).getUTCDay(); return 1 + ((wd - first + 7) % 7) + 7 * (n - 1); };
  const lastMon = (mon) => { const last = new Date(Date.UTC(y, mon + 1, 0)); return last.getUTCDate() - ((last.getUTCDay() + 6) % 7); };
  return new Set([[0, 1], [0, nth(0, 1, 3)], [1, nth(1, 1, 3)], [4, lastMon(4)], [5, 19], [6, 4], [8, nth(8, 1, 1)], [9, nth(9, 1, 2)], [10, 11], [10, nth(10, 4, 4)], [11, 25]].map(([mo, d]) => `${y}-${pad2(mo + 1)}-${pad2(d)}`));
}
function marketEvents(m, now, earnings) {
  calendarsRunningOut(now);
  const text = `${m.id} ${m.name} ${(m.keywords || []).join(' ')}`;
  const gas = m.id === 'NATGAS' || /natural gas|nat-?gas/i.test(text);
  const oil = !gas && m.category === 'energy' && /brent|crude|wti|\boil\b/i.test(text);
  const p = nyParts(new Date(now)), today = Date.UTC(p.y, p.m - 1, p.d), out = [];
  for (let k = 0; k <= 9; k++) {
    const d = new Date(today + k * 864e5), date = d.toISOString().slice(0, 10), wd = d.getUTCDay();
    const hol = usHolidays(d.getUTCFullYear());
    // a federal holiday earlier in the same week (or on the day) pushes the weekly EIA reports
    const shifted = [...Array(wd).keys()].some((b) => hol.has(new Date(d.getTime() - b * 864e5).toISOString().slice(0, 10)));
    const note = shifted ? 'US holiday week: the release usually moves by a day' : '';
    if (gas && wd === 4) out.push({ id: 'eia-gas', name: 'EIA natural gas storage report', date, at: new Date(nyToUtc(date, 10, 30)).toISOString(), note });
    if (oil && wd === 3) out.push({ id: 'eia-oil', name: 'EIA weekly oil inventories', date, at: new Date(nyToUtc(date, 10, 30)).toISOString(), note });
    if (FOMC_DAYS.includes(date) && !gas) out.push({ id: 'fomc', name: 'Fed interest-rate decision', date, at: new Date(nyToUtc(date, 14, 0)).toISOString(), note: '' });
    if (CPI_DAYS.includes(date) && !gas) out.push({ id: 'cpi', name: 'US inflation report (CPI)', date, at: new Date(nyToUtc(date, 8, 30)).toISOString(), note: '' });
    if (JOBS_DAYS.includes(date) && !gas) out.push({ id: 'jobs', name: 'US jobs report (payrolls)', date, at: new Date(nyToUtc(date, 8, 30)).toISOString(), note: '' });
    if (earnings?.date === date) out.push({ id: 'earnings', name: 'Earnings report (expected date)', date, at: new Date(nyToUtc(date, 9, 30)).toISOString(), allDay: true, note: 'Ranges do not include the earnings move' });
  }
  return out.filter((e) => e.allDay ? e.date >= `${p.y}-${pad2(p.m)}-${pad2(p.d)}` : Date.parse(e.at) > now - 36e5);
}
// Next earnings date for US stocks, asked once a day from Nasdaq's public page data (free, no key; best effort).
async function earningsDate(m, prev, now) {
  if (m.category !== 'equity' || !/^(NASDAQ|NYSE)/i.test(m.exchange || '')) return null;
  const today = ymd(now), had = prev?.meta?.earnings;
  if (had && had.checked === today && (had.ok || now - Date.parse(had.at || 0) < 6 * 36e5)) return had; // one lookup a day; a failed one is retried after 6 hours
  const keep = had?.date && had.date >= today ? had.date : null; // keep a date we already know if today's lookup fails
  try {
    const j = await get(`https://api.nasdaq.com/api/analyst/${encodeURIComponent(m.symbol)}/earnings-date`, { type: 'json', timeout: 8000, retries: 0 });
    const txt = JSON.stringify(j?.data || {});
    const a = txt.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* (\d{1,2}), (\d{4})/), b = txt.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
    const t = a ? Date.parse(`${a[1]} ${a[2]}, ${a[3]} 12:00 UTC`) : b ? Date.UTC(+b[3], +b[1] - 1, +b[2], 12) : NaN;
    if (isFinite(t) && t - now > -2 * 864e5 && t - now < 200 * 864e5) return { date: ymd(t), checked: today, at: new Date(now).toISOString(), ok: true };
    // Right after a report Nasdaq answers normally but has no next date yet ("...hasn't provided us with the upcoming earnings report date")
    if (/hasn.t provided|Earnings announcement\* for [^:"]+: ?"/i.test(txt)) return { date: keep, checked: today, at: new Date(now).toISOString(), ok: true, pending: true };
    return { date: keep, checked: today, at: new Date(now).toISOString(), ok: false, error: 'no date in the answer' };
  } catch (e) { return { date: keep, checked: today, at: new Date(now).toISOString(), ok: false, error: e.message }; }
}
async function attachEvents(m, out, prev, now) {
  const earn = await earningsDate(m, prev, now);
  if (earn) { out.meta.earnings = earn; out.sources.push({ name: earn.pending && !earn.date ? 'Next earnings date (Nasdaq): not announced yet' : 'Next earnings date (Nasdaq)', ok: !!earn.ok, error: earn.error }); }
  out.events = marketEvents(m, now, earn);
  for (const h of Object.values(out.forecast.horizons)) h.events = out.events.filter((e) => e.date <= h.targetDate).map((e) => e.id);
}

// ---------- track record ----------
// Published log: once per session, at the close, the 1/3/5-day forecasts are written down; each is scored against
// the close 1/3/5 sessions later. Backtest: the price signals replayed on the stored daily history (news cannot be replayed).
let BASE = null;           // live site URL, set in main()
let TRACK_UNSAFE = false;  // the log could not be read back from the live site: do not publish over it
const ymd = (t) => new Date(t).toISOString().slice(0, 10);
function justClosed(now, calendar, category, kind) {
  // Session date that closed within the last 3 hours, else null (no session on weekends and exchange holidays).
  const d = new Date(now);
  if (calendar === 'daily') return d.getUTCHours() < 3 ? ymd(d.getTime() - 864e5) : null;
  const p = nyParts(d);
  if (p.wd === 'Sat' || p.wd === 'Sun') return null;
  if (!isSession(Date.UTC(p.y, p.m - 1, p.d), kind)) return null;
  const close = calendar === 'ng' ? 17 * 60 : (US_CASH.includes(category) ? 16 * 60 : 17 * 60) + 15; // +15 min so the closing quote has arrived
  const hm = p.h * 60 + p.min;
  return hm >= close && hm <= close + 180 ? `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}` : null;
}
function trackStats(done) {
  const out = {};
  for (const h of [1, 3, 5]) {
    const a = done.filter((x) => x.h === h);
    const dir = a.filter((x) => x.actual !== x.p0 && x.c !== x.p0);
    out[h] = {
      n: a.length, dirN: dir.length, dirHit: dir.filter((x) => (x.actual > x.p0) === (x.c > x.p0)).length,
      in68: a.filter((x) => x.actual >= x.lo68 && x.actual <= x.hi68).length,
      in90: a.filter((x) => x.actual >= x.lo90 && x.actual <= x.hi90).length,
      mae: a.length ? round(100 * mean(a.map((x) => Math.abs(x.actual - x.c) / x.p0)), 2) : null,
      maeNaive: a.length ? round(100 * mean(a.map((x) => Math.abs(x.actual - x.p0) / x.p0)), 2) : null,
      signals: (() => { // per signal: [times it pointed the right way, times it pointed anywhere]
        const s = {};
        for (const x of a) {
          if (!x.sig || x.actual === x.p0) continue;
          for (const [id, v] of Object.entries(x.sig)) { if (!(Math.abs(v) > 0.02)) continue; const e = (s[id] ||= [0, 0]); e[1]++; if ((v > 0) === (x.actual > x.p0)) e[0]++; }
        }
        return s;
      })()
    };
  }
  return out;
}
function backtest(px, opts) {
  // Completed sessions only (the last bar is still moving). Each forecast uses only the closes up to its own day.
  const bars = px.daily.slice(0, -1).filter((b) => b.c > 0);
  const closes = bars.map((b) => b.c), done = [];
  const START = 60;
  for (let t = START; t < closes.length - 1; t++) {
    const k = techCore(closes.slice(0, t + 1), opts.category);
    const score = clamp(WEIGHT.trend * k.trendSig + WEIGHT.momentum * k.momSig + WEIGHT.rsi * k.rsiSig, -1, 1);
    const p0 = closes[t];
    for (const h of [1, 3, 5]) {
      if (t + h >= closes.length) continue;
      const mu = score * DRIFT_K * k.sigma * h, sd = k.sigma * Math.sqrt(h);
      done.push({ h, p0, c: p0 * Math.exp(mu), lo68: p0 * Math.exp(mu - sd), hi68: p0 * Math.exp(mu + sd), lo90: p0 * Math.exp(mu - Z90 * sd), hi90: p0 * Math.exp(mu + Z90 * sd), actual: closes[t + h], sig: { trend: k.trendSig, momentum: k.momSig, rsi: k.rsiSig } });
    }
  }
  const sessions = Math.max(0, closes.length - 1 - START);
  return { sessions, from: sessions ? ymd(bars[START].t) : null, to: sessions ? ymd(bars.at(-1).t) : null, ...trackStats(done) };
}
async function loadTrack(id, prev, now) {
  const empty = () => ({ id, since: null, open: [], done: [] });
  const valid = (j) => (j && Array.isArray(j.open) && Array.isArray(j.done) ? j : null);
  if (BASE && !OFFLINE) {
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(`${BASE}data/h/${id}.json?t=${now}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
        // "not found" is only believed while the site itself says no log exists yet
        if (res.status === 404 && !prev?.track?.since) return empty();
        if (res.ok) { const j = valid(await res.json()); if (j) return j; }
      } catch { /* retry */ }
      await sleep(1500);
    }
    return null;
  }
  try { return valid(JSON.parse(await readFile(join(DATA_DIR, `h/${id}.json`), 'utf8'))) || empty(); } catch { return empty(); }
}
// Called as soon as a market's previous state is loaded: re-saves it unchanged, so a market that fails to build on this run
// keeps its page data and its forecast log in the next deploy instead of losing them. A successful build overwrites both.
async function carryForward(id, prev, now) {
  if (prev) await save(`m/${id}.json`, prev);
  const log = await loadTrack(id, prev, now);
  if (log) await save(`h/${id}.json`, log);
  else {
    // Never publish an empty log over a real one: this run is not deployed and the next refresh tries again.
    TRACK_UNSAFE = true;
    console.log(`::error title=${id} forecast log::could not be read back from the live site; skipping this deploy so nothing is lost`);
  }
  return log;
}
async function trackRecord(m, px, fc, out, prev, log, now, opts) {
  const bt = backtest(px, opts);
  if (!log) {
    out.track = prev?.track ? { ...prev.track, backtest: bt } : { since: null, live: trackStats([]), backtest: bt, open: [], recent: [] };
    return;
  }
  const bars = px.daily.filter((b) => b.c > 0).map((b) => ({ date: ymd(b.t), c: b.c }));
  // 1) score forecasts whose target session has closed (a later bar exists, so the close is final)
  const still = [];
  for (const f of log.open) {
    const i = bars.findIndex((b) => b.date >= f.target);
    if (i >= 0 && i < bars.length - 1) log.done.push({ ...f, actual: round(bars[i].c, 6), actualDate: bars[i].date });
    else if (now - Date.parse(f.made) < 30 * 864e5) still.push(f); // drop forecasts that can no longer be scored
  }
  log.open = still;
  // 2) log today's forecasts once, just after the close of a session that actually traded
  const d0 = justClosed(now, opts.calendar, opts.category, opts.hol);
  const logged = (d) => log.open.some((f) => f.d0 === d) || log.done.some((f) => f.d0 === d);
  if (d0 && !px.stale && px.last > 0 && bars.some((b) => b.date === d0) && !logged(d0)) {
    for (const h of [1, 3, 5]) {
      const z = fc.horizons[h];
      log.open.push({ h, d0, made: new Date(now).toISOString(), target: ymd(nextSessions(Date.parse(d0 + 'T12:00:00Z'), h, opts.calendar === 'daily', opts.hol)),
        p0: round(px.last, 6), c: z.center, lo68: z.lo68, hi68: z.hi68, lo90: z.lo90, hi90: z.hi90, pUp: z.pUp, score: fc.score,
        sig: Object.fromEntries(fc.signals.map((s) => [s.id, s.value])) }); // kept so each signal, news included, can be scored later
    }
    if (!log.since) log.since = d0;
  }
  log.done = log.done.slice(-900); // about 300 sessions x 3 horizons
  log.updatedAt = new Date(now).toISOString();
  await save(`h/${m.id}.json`, log);
  out.track = { since: log.since, live: trackStats(log.done), backtest: bt, open: log.open,
    recent: [1, 3, 5].flatMap((h) => log.done.filter((x) => x.h === h).slice(-8)) };
}

// ---------- main ----------
function siteUrl() {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/?$/, '/');
  const repo = process.env.GITHUB_REPOSITORY; // owner/name
  if (!repo) return null;
  const [owner, name] = repo.split('/');
  return name.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${owner}.github.io/` : `https://${owner}.github.io/${name}/`;
}

const DATA_DIR = join(ROOT, 'site', 'data');
const INTRADAY_KEEP_MS = 7 * 864e5; // price samples kept for the chart's day and week views
const INTRADAY_FULL_MS = 864e5;      // samples arrive every few minutes: all kept for the last day, then one per 5 minutes
// Older than a day, keep only the latest sample in each 5-minute slot: it carries the session high/low so far,
// so the chart's wicks are unchanged and the market files stay small.
function thinIntraday(rows, now) {
  const out = [];
  for (const r of rows) {
    const p = out.at(-1);
    if (p && now - r.t > INTRADAY_FULL_MS && Math.floor(p.t / 3e5) === Math.floor(r.t / 3e5)) out[out.length - 1] = r;
    else out.push(r);
  }
  return out;
}
const METHOD = 'Ranges = live price x exp(drift x days +/- z x daily volatility x sqrt(days)); volatility blends 20- and 60-session realised volatility; drift = weighted signal score x 0.25 x daily volatility. 68% band z=1, 90% band z=1.75 (wider than the textbook 1.645, which covered only 87-89% of closes in the backtest). Signals: news sentiment from trusted outlets (45%), trend vs 20-day average (20%), 5-day momentum (15%), RSI mean reversion (20%). Each horizon targets the daily close that many sessions ahead (the first one is the next close at least 6 hours away). Volatility has a floor per asset class (0.25% a day for currencies up to 1.2% for energy and crypto). The higher/lower split is a model lean, not a calibrated probability: by construction it stays between 40% and 60% at 1 day and between 29% and 71% at 5 days.';

async function loadPrev(base, rel, now) {
  if (base && !OFFLINE) { try { const j = await get(`${base}data/${rel}?t=${now}`, { type: 'json', retries: 0 }); if (j?.price) return j; } catch { /* none */ } }
  try { const j = JSON.parse(await readFile(join(DATA_DIR, rel), 'utf8')); if (j?.price) return j; } catch { /* none */ }
  return null;
}
async function save(rel, obj) { const f = join(DATA_DIR, rel); await mkdir(dirname(f), { recursive: true }); await writeFile(f, JSON.stringify(obj)); }

function cleanBar(r) {
  const c = r.c; if (!(c > 0)) return r;
  const ok = (v) => v != null && isFinite(v) && v > c * 0.5 && v < c * 2 ? v : null; // drop zeros and wild ticks
  const o = ok(r.o) ?? c;
  return { ...r, o, h: Math.max(ok(r.h) ?? c, o, c), l: Math.min(ok(r.l) ?? c, o, c) };
}
function packOutput(m, px, news, fc, now, market, extra = {}) {
  px.daily = px.daily.map(cleanBar);
  const dd = px.last >= 20 ? 3 : 6; // currencies and low-priced markets lose real information at 3 decimals
  const daily = px.daily.slice(-260).map((r) => ({ date: new Date(r.t).toISOString().slice(0, 10), o: round(r.o, dd), h: round(r.h, dd), l: round(r.l, dd), c: round(r.c, dd) }));
  const lastSession = px.intraday.length ? (() => { const lastT = px.intraday.at(-1).t; return thinIntraday(px.intraday, now).filter((x) => lastT - x.t < INTRADAY_KEEP_MS && x.c > 0).map((x) => (x.h > 0 && x.l > 0 ? [x.t, round(x.c, 6), round(Math.max(x.h, x.c), 6), round(Math.min(x.l, x.c), 6)] : [x.t, round(x.c, 6)])); })() : [];
  const dec = m.category === 'fx' ? (px.last >= 20 ? 3 : 5) : px.last >= 10 ? 2 : px.last >= 1 ? 3 : 5;
  return {
    generatedAt: new Date(now).toISOString(),
    meta: { id: m.id, name: m.name, symbol: m.symbol, category: m.category, exchange: m.exchange || '', provider: m.provider, decimals: dec, tv: m.tv || undefined, ...extra.meta },
    instrument: m.instrument || `${m.name} (${m.symbol})`,
    market,
    price: {
      last: round(px.last, 6), prevClose: round(px.prevClose, 6),
      change: px.prevClose ? round(px.last - px.prevClose, 6) : null,
      changePct: px.prevClose ? round(100 * (px.last / px.prevClose - 1), 2) : null,
      asOf: new Date(px.lastTime).toISOString(), source: px.source, stale: px.stale,
      daily, intraday: lastSession, ...extra.price
    },
    forecast: fc,
    news: { fetchedAt: news.fetchedAt, items: news.items, scorer: news.scorer },
    sources: [...px.status, ...news.status],
    method: METHOD
  };
}

// ---------- AI analyst (Claude API) ----------
const AI_KEY = process.env.ANTHROPIC_API_KEY || '';           // optional upgrade (paid)
const AI_MODEL = process.env.AI_MODEL || 'claude-sonnet-5-5';
const GROQ_KEY = process.env.GROQ_API_KEY || '';               // Groq: free key, backup
const GROQ_MODELS = (process.env.GROQ_MODELS || 'openai/gpt-oss-120b,openai/gpt-oss-20b').split(',').map((x) => x.trim()).filter(Boolean);
const AI_PROVIDERS = (process.env.AI_PROVIDERS || 'anthropic,groq').split(',').map((x) => x.trim().toLowerCase());
const aiConfigured = () => AI_PROVIDERS.some((p) => (p === 'anthropic' && AI_KEY) || (p === 'groq' && GROQ_KEY));
const exhausted = new Set(); // models that hit a daily/minute limit during this run

const GROQ_URL = process.env.GROQ_URL || 'https://api.groq.com/openai/v1/chat/completions'; // overridable for local tests
async function openAIChat(url, key, model, system, user, extraHeaders = {}, extraBody = {}) {
  const reasoning = /gpt-5|\/o\d|gpt-oss/i.test(model);
  const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  if (/gpt-5|\/o\d/i.test(model)) body.max_completion_tokens = 4000; else { body.max_tokens = reasoning ? 4000 : 1800; body.temperature = 0.3; }
  if (/gpt-oss/i.test(model)) body.reasoning_effort = 'low';
  Object.assign(body, extraBody);
  const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(90000), headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) });
  const raw = await res.text(); let j = null; try { j = JSON.parse(raw); } catch { /* not json */ }
  if (!res.ok) { const e = new Error(`HTTP ${res.status} ${(j?.error?.message || j?.message || raw).toString().slice(0, 160)}`); e.status = res.status; throw e; }
  const msg = j?.choices?.[0]?.message || {};
  const text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((c) => c.text || '').join('') : '';
  const info = `[${res.status} ${res.headers.get('content-type') || '?'} ${res.url}]`;
  return { text, raw: text ? '' : `${info} ${raw.slice(0, 200)}`, usage: j?.usage ? { input: j.usage.prompt_tokens, output: j.usage.completion_tokens } : undefined };
}
// Tries the configured providers in order; a model that is rate-limited is skipped for the rest of the run.
async function callLLM(system, user) {
  const errors = [];
  for (const p of AI_PROVIDERS) {
    const attempts = p === 'anthropic' && AI_KEY ? [AI_MODEL] : p === 'groq' && GROQ_KEY ? GROQ_MODELS : [];
    for (const model of attempts) {
      const key = `${p}/${model}`;
      if (exhausted.has(key)) continue;
      try {
        let r;
        if (p === 'anthropic') {
          const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST', signal: AbortSignal.timeout(60000),
            headers: { 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            body: JSON.stringify({ model, max_tokens: 1500, system, messages: [{ role: 'user', content: user }] })
          });
          const j = await res.json();
          if (!res.ok) { const e = new Error(`HTTP ${res.status} ${j?.error?.message || ''}`); e.status = res.status; throw e; }
          r = { text: (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), usage: j.usage ? { input: j.usage.input_tokens, output: j.usage.output_tokens } : undefined };
        } else {
          r = await openAIChat(GROQ_URL, GROQ_KEY, model, system, user);
        }
        if (!r.text.includes('{')) throw new Error(`reply had no JSON: ${(r.text || r.raw || '').replace(/\s+/g, ' ').slice(0, 220)}`);
        return { ...r, provider: p, model };
      } catch (e) {
        if ([429, 403, 413].includes(e.status)) exhausted.add(key); // daily/minute limit or request too large: skip for this run
        errors.push(`${key}: ${e.message}`);
      }
    }
  }
  throw new Error(errors.length ? errors.join(' | ') : 'no AI provider configured');
}
const AI_EVERY_MIN = Number(process.env.AI_EVERY_MIN) || 60;    // regular cadence while the market is open
const AI_MOVE_PCT = Number(process.env.AI_MOVE_PCT) || 1.5;     // earlier refresh after a move this big
let aiCallsLeft = Number(process.env.AI_MAX_PER_RUN) || 1;      // spreads notes across runs and markets

function techIndicators(daily, last) {
  const c = daily.map((r) => r.c); if (last != null) c[c.length - 1] = last;
  const smaA = (n) => (c.length >= n ? c.slice(-n).reduce((a, b) => a + b, 0) / n : null);
  const emaS = (arr, n) => { const k = 2 / (n + 1); const o = []; let e = null; arr.forEach((v, i) => { if (i === n - 1) e = arr.slice(0, n).reduce((a, b) => a + b, 0) / n; else if (i >= n) e = v * k + e * (1 - k); o.push(i >= n - 1 ? e : null); }); return o; };
  let g = 0, l = 0, rsiV = null;
  for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0); if (i <= 14) { g += up; l += dn; if (i === 14) { g /= 14; l /= 14; } } else { g = (g * 13 + up) / 14; l = (l * 13 + dn) / 14; } if (i >= 14) rsiV = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  const e12 = emaS(c, 12), e26 = emaS(c, 26); const line = c.map((_, i) => (e12[i] == null || e26[i] == null ? null : e12[i] - e26[i]));
  const st = line.findIndex((v) => v != null); const sig = new Array(c.length).fill(null); if (st >= 0) emaS(line.slice(st), 9).forEach((v, j) => { sig[st + j] = v; });
  const hist = line.map((v, i) => (v == null || sig[i] == null ? null : v - sig[i]));
  let crossAgo = null; for (let i = hist.length - 1; i > 0; i--) { if (hist[i] != null && hist[i - 1] != null && Math.sign(hist[i]) !== Math.sign(hist[i - 1])) { crossAgo = hist.length - 1 - i; break; } }
  const w = c.slice(-20); const m20 = smaA(20); const sdv = m20 ? Math.sqrt(w.reduce((a, b) => a + (b - m20) ** 2, 0) / w.length) : null;
  const trs = daily.slice(-15).map((r, i, a) => (i ? Math.max(r.h - r.l, Math.abs(r.h - a[i - 1].c), Math.abs(r.l - a[i - 1].c)) : null)).filter((x) => x != null && isFinite(x));
  const ret = (n) => (c.length > n ? round(100 * (c[c.length - 1] / c[c.length - 1 - n] - 1), 2) : null);
  const hiLo = (n) => { const a = daily.slice(-n); return { high: round(Math.max(...a.map((r) => r.h ?? r.c))), low: round(Math.min(...a.map((r) => r.l ?? r.c))) }; };
  return {
    sma20: round(m20), sma50: round(smaA(50)), sma200: round(smaA(200)), rsi14: round(rsiV, 1),
    macd: { line: round(line.at(-1), 4), signal: round(sig.at(-1), 4), histogram: round(hist.at(-1), 4), lastCrossSessionsAgo: crossAgo, histogramTrend: hist.at(-1) != null && hist.at(-2) != null ? (hist.at(-1) > hist.at(-2) ? 'rising' : 'falling') : null },
    bollinger20: m20 ? { upper: round(m20 + 2 * sdv), lower: round(m20 - 2 * sdv), percentB: round((c.at(-1) - (m20 - 2 * sdv)) / (4 * sdv), 2) } : null,
    atr14: trs.length ? round(trs.reduce((a, b) => a + b, 0) / trs.length) : null,
    returnsPct: { d1: ret(1), d5: ret(5), d20: ret(20), d60: ret(60) },
    range20: hiLo(20), range52w: hiLo(252)
  };
}

const AI_SYSTEM = `You are a senior cross-asset market analyst writing a short, live note for a CFD trader's dashboard.
Weigh the chart (trend, momentum, levels) and the news flow together, and say where they agree or conflict.
Rules:
- Use only the data provided. Do not invent prices, events, quotes or sources. If information is thin, say so.
- News items may be headline-only (not fully read) - treat those as weaker evidence.
- The quant model forecast is one input, not the truth; you may disagree with it and explain why.
- Be concrete: cite levels and numbers from the data. Plain English, no hype.
- scheduledEvents lists known releases ahead (reports, central-bank decisions, earnings). If one falls inside an outlook window, name it in that outlook or in risks.
- This is market commentary, not personal advice: no position sizing, no "you should buy/sell".
Respond with ONLY a JSON object, no markdown, matching:
{"stance":"bullish|bearish|neutral","confidence":"low|medium|high","headline":"<=90 chars","summary":"2-3 sentences",
 "chart":["3-5 short bullets on trend, momentum, volatility, levels"],"news":["2-4 short bullets on what the news flow implies"],
 "levels":{"support":[numbers],"resistance":[numbers]},
 "outlook":{"1d":"one sentence","3d":"one sentence","5d":"one sentence"},
 "flip":["1-2 things that would change this view"],"risks":["1-2 key risks or events to watch"]}`;

async function aiFor(m, out, prevAi, now) {
  if (!aiConfigured()) { if (!aiFor.warned) { aiFor.warned = true; console.log(`::warning title=AI analyst::off - no key reached the script (GROQ_API_KEY ${GROQ_KEY ? 'set' : 'empty'}, ANTHROPIC_API_KEY ${AI_KEY ? 'set' : 'empty'}, providers ${AI_PROVIDERS.join(',')})`); } return { status: 'off' }; }
  const prevOk = prevAi && prevAi.status === 'ok' && prevAi.at;
  const ageMin = prevOk ? (now - Date.parse(prevAi.at)) / 60e3 : Infinity;
  const moved = prevOk && prevAi.price ? Math.abs(out.price.last / prevAi.price - 1) * 100 : 0;
  const every = out.market === 'open' ? AI_EVERY_MIN : Math.max(AI_EVERY_MIN, 360);
  const due = !prevOk || ageMin >= every - 4 || (moved >= AI_MOVE_PCT && ageMin >= 20);
  if (!due) return prevAi;
  if (aiCallsLeft <= 0 || OFFLINE) return prevAi || { status: 'pending' };
  aiCallsLeft--;
  const f = out.forecast;
  const payload = {
    market: { name: m.name, symbol: m.symbol, category: m.category, exchange: m.exchange || '', instrument: out.instrument },
    asOf: out.price.asOf, marketStatus: out.market,
    price: { last: out.price.last, previousClose: out.price.prevClose, changePct: out.price.changePct },
    scheduledEvents: (out.events || []).slice(0, 5).map((e) => ({ name: e.name, date: e.date, hoursAway: Math.max(0, Math.round((Date.parse(e.at) - now) / 36e5)), note: e.note || undefined })),
    indicators: techIndicators(out.price.daily.map((r) => ({ h: r.h, l: r.l, c: r.c })), out.price.last),
    last30Closes: out.price.daily.slice(-30).map((r) => [r.date, r.c]),
    keyLevels: f.levels,
    quantModel: { bias: f.bias, score: f.score, dailyVolatilityPct: round(f.sigmaDaily * 100, 2), signals: f.signals.map((x) => ({ name: x.name, value: x.value, detail: x.detail })), horizons: f.horizons },
    news: (out.news.items || []).filter((n) => !(n.ai && n.ai.rel === false)).slice(0, 15).map((n) => ({ title: n.title, source: n.source, hoursAgo: round((now - Date.parse(n.publishedAt)) / 36e5, 1), read: n.read?.status || 'headline', modelScore: n.score, scoredBy: n.ai ? 'ai' : 'keywords', keyPhrases: n.read?.keyPhrases || [] }))
  };
  try {
    let userMsg = `Write the analyst note for this market data:\n${JSON.stringify(payload)}`;
    if (userMsg.length > 14000) { payload.news = payload.news.slice(0, 8); payload.last30Closes = payload.last30Closes.slice(-15); userMsg = `Write the analyst note for this market data:\n${JSON.stringify(payload)}`; } // free tiers cap ~8k tokens per request
    const llm = await callLLM(AI_SYSTEM, userMsg);
    const text = llm.text;
    const note = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const clip = (x, n) => String(x ?? '').slice(0, n);
    const list = (a, k, n) => (Array.isArray(a) ? a.slice(0, k).map((x) => clip(x, n)) : []);
    const nums = (a) => (Array.isArray(a) ? a.map(Number).filter(isFinite).slice(0, 4) : []);
    console.log(`::notice title=AI analyst ${m.id}::note written by ${llm.provider}/${llm.model} (${llm.usage ? llm.usage.input + ' in / ' + llm.usage.output + ' out tokens' : 'usage n/a'})`);
    return {
      status: 'ok', at: new Date(now).toISOString(), provider: llm.provider, model: llm.model, price: out.price.last,
      stance: ['bullish', 'bearish', 'neutral'].includes(note.stance) ? note.stance : 'neutral',
      confidence: ['low', 'medium', 'high'].includes(note.confidence) ? note.confidence : 'low',
      headline: clip(note.headline, 140), summary: clip(note.summary, 700),
      chart: list(note.chart, 5, 240), news: list(note.news, 4, 240),
      levels: { support: nums(note.levels?.support), resistance: nums(note.levels?.resistance) },
      outlook: { '1d': clip(note.outlook?.['1d'], 240), '3d': clip(note.outlook?.['3d'], 240), '5d': clip(note.outlook?.['5d'], 240) },
      flip: list(note.flip, 2, 240), risks: list(note.risks, 2, 240),
      usage: llm.usage
    };
  } catch (e) {
    console.log(`::warning title=AI analyst ${m.id}::${String(e.message).slice(0, 300)}`);
    return prevOk ? { ...prevAi, lastError: String(e.message).slice(0, 200), lastErrorAt: new Date(now).toISOString() } : { status: 'error', error: String(e.message).slice(0, 200), at: new Date(now).toISOString() };
  }
}

// ---------- AI news scoring (stocks) ----------
// The keyword lists are built for natural gas and commodities; for a company they mostly catch generic words.
// Here a free Groq model reads each new headline once and says (a) whether the story is really about this market
// and (b) its likely effect on the price over 1-5 sessions (-2..+2). Results are cached per headline, so only new
// headlines are sent, in one batch per market per news refresh. gpt-oss-20b goes first (the analyst note starts on
// gpt-oss-120b, and each Groq model has its own free daily allowance). Groq's Llama models left the free plan on
// 16 Aug 2026. A model Groq does not serve is skipped for the rest of the run. Any failure keeps the keyword scores.
const NEWS_AI_VERSION = 1;
const NEWS_AI_MODELS = (process.env.NEWS_AI_MODELS || 'openai/gpt-oss-20b,openai/gpt-oss-120b').split(',').map((x) => x.trim()).filter(Boolean);
const NEWS_AI_CATEGORIES = (process.env.NEWS_AI_CATEGORIES || 'equity,etf').split(',').map((x) => x.trim()).filter(Boolean);
const NEWS_AI_BATCH = 20;          // headlines per request
const NEWS_AI_RETRY_MIN = 14;      // after a failed attempt, wait for the next news refresh
let newsAiCallsLeft = Number(process.env.NEWS_AI_MAX_PER_RUN) || 6;
const NEWS_AI_SYSTEM = `You score news headlines for a trader who watches one market.
For each numbered headline return:
- "about": true if the story is mainly about this company or directly affects its share price; false if it only mentions the company in passing, lists many stocks, or is mainly about something else.
- "score": the likely effect on this market's price over the next 1 to 5 trading days, an integer from -2 to 2: -2 clearly negative, -1 mildly negative, 0 neutral, mixed, unclear or already priced in, 1 mildly positive, 2 clearly positive. A headline that only reports a past price move ("shares fall 5%") gets at most 1 point in that direction. Opinion pieces and "should you buy" articles get at most 1 point.
- "why": the reason in at most 12 plain words.
Judge only from the headline and source. Do not assume facts that are not in the headline.
Answer with only a JSON object: {"items":[{"i":1,"about":true,"score":0,"why":"..."}]}`;

async function aiScoreNews(m, news, prevNews, now) {
  const items = news.items || [];
  if (!NEWS_AI_CATEGORIES.includes(m.category) || !items.length) return;
  // reuse earlier AI scores for the same headline
  const cache = new Map((prevNews?.items || []).filter((x) => x.ai && x.ai.v === NEWS_AI_VERSION).map((x) => [titleKey(x.title), x.ai]));
  for (const it of items) if (!it.ai || it.ai.v !== NEWS_AI_VERSION) { const c = cache.get(titleKey(it.title)); if (c) it.ai = c; else delete it.ai; }
  const prevScorer = news.scorer || prevNews?.scorer || {};
  news.scorer = { kind: 'ai', model: prevScorer.model, triedAt: prevScorer.triedAt, error: prevScorer.error };
  const todo = items.filter((it) => !it.ai).slice(0, NEWS_AI_BATCH); // newest first
  const retryOk = !news.reused || !prevScorer.error || !prevScorer.triedAt || now - Date.parse(prevScorer.triedAt) > NEWS_AI_RETRY_MIN * 60e3;
  if (todo.length && !GROQ_KEY) news.scorer = { kind: 'keywords', error: 'no GROQ_API_KEY' };
  else if (todo.length && retryOk && newsAiCallsLeft > 0) {
    newsAiCallsLeft--;
    const what = `${m.name} (${m.symbol}${m.exchange ? ', ' + m.exchange : ''}${m.category === 'etf' ? ', ETF' : m.category === 'equity' ? ' shares' : ''})`;
    const user = `Market: ${what}\nHeadlines:\n` + todo.map((it, k) => `${k + 1}. [${it.source}, ${Math.max(0, Math.round((now - Date.parse(it.publishedAt)) / 36e5))}h ago] ${it.title}`).join('\n');
    const errors = [];
    let done = false;
    for (const model of NEWS_AI_MODELS) {
      const key = `groq/${model}`;
      if (exhausted.has(key)) continue;
      try {
        const r = await openAIChat(GROQ_URL, GROQ_KEY, model, NEWS_AI_SYSTEM, user, {}, { temperature: 0, max_tokens: (/gpt-oss|qwen/i.test(model) ? 1200 : 100) + 60 * todo.length, response_format: { type: 'json_object' } });
        const j = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1));
        let n = 0;
        for (const x of Array.isArray(j.items) ? j.items : []) {
          const it = todo[Number(x.i) - 1];
          const s = Math.round(Number(x.score));
          if (!it || it.ai || !isFinite(s)) continue;
          it.ai = { v: NEWS_AI_VERSION, s: clamp(s, -2, 2), rel: x.about !== false && x.about !== 'false', why: String(x.why ?? '').replace(/\s+/g, ' ').trim().slice(0, 100), m: model.replace(/^.*\//, '') };
          n++;
        }
        if (!n) throw new Error(`no usable scores in the reply: ${r.text.replace(/\s+/g, ' ').slice(0, 160)}`);
        news.scorer = { kind: 'ai', model, triedAt: new Date(now).toISOString() };
        console.log(`::notice title=AI news ${m.id}::${n} of ${todo.length} new headlines scored by ${model} (${r.usage ? r.usage.input + ' in / ' + r.usage.output + ' out tokens' : 'usage n/a'})`);
        done = true;
        break;
      } catch (e) {
        if ([429, 403, 413, 404].includes(e.status) || /does not exist|model_not_found|decommissioned/i.test(e.message)) exhausted.add(key);
        errors.push(`${model}: ${String(e.message).slice(0, 160)}`);
      }
    }
    if (!done && !errors.length) errors.push('every AI model is unavailable or at its limit for this run');
    if (!done) {
      news.scorer = { kind: 'ai', model: prevScorer.model, triedAt: new Date(now).toISOString(), error: errors.join(' | ').slice(0, 300) };
      console.log(`::warning title=AI news ${m.id}::keyword scores kept for new headlines - ${errors.join(' | ').slice(0, 300)}`);
    }
  }
  for (const it of items) it.score = storyScore(it);
  const nAi = items.filter((it) => it.ai).length, off = items.filter((it) => it.ai && it.ai.rel === false).length;
  news.status = [...(news.status || []).filter((s) => !/^AI news scoring/.test(s.name)),
    { name: `AI news scoring: ${nAi} of ${items.length} stories scored${off ? `, ${off} not about this market` : ''}${news.scorer.model ? ` (${news.scorer.model} on Groq)` : ''}`, ok: nAi === items.length || !news.scorer.error, error: news.scorer.error || (nAi < items.length ? 'the rest keep keyword scores until the next refresh' : '') }];
}

// ---------- Alerts (shown on the page; sent to Telegram when a bot is set up) ----------
// Each build compares the new data with the previous build's and records what changed. A small memory kept in the
// market's own data file (alerts.state) makes every alert fire once. The first build that has no memory yet only
// records the current state, so deploying this never sends a burst of old news.
const ALERTS_VERSION = 1;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const TG_API = process.env.TELEGRAM_API || 'https://api.telegram.org'; // overridable for local tests
const ALERT_TYPES = (process.env.ALERT_TYPES || 'move,step,level,flip,analyst,event').split(',').map((x) => x.trim()).filter(Boolean);
const ALERT_MARKETS = (process.env.ALERT_MARKETS || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean); // empty = all
const ALERT_TZ = process.env.ALERT_TZ || 'Europe/Bucharest';
const ALERT_QUIET = (process.env.ALERT_QUIET_HOURS || '').match(/^(\d{1,2})-(\d{1,2})$/); // e.g. 23-7: sent silently
const ALERT_EVENT_LEAD_MIN = Number(process.env.ALERT_EVENT_LEAD_MIN) || 60;
// price steps: an alert each time the price has moved this many % from the price at the market's previous step alert
const ALERT_STEP_PCT = process.env.ALERT_STEP_PCT === undefined || process.env.ALERT_STEP_PCT === '' ? 0.5 : Number(process.env.ALERT_STEP_PCT) || 0; // 0 = off
const ALERT_STEP_MARKETS = (process.env.ALERT_STEP_MARKETS || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean); // empty = all
const ALERT_STEP_LOG_KEEP = 10; // the page keeps the last 10 step alerts besides the other alerts
const ALERT_LEVEL_COOLDOWN_H = 6, ALERT_FLIP_COOLDOWN_H = 2, ALERT_ANALYST_COOLDOWN_H = 4, ALERT_LOG_KEEP = 25;
const OUTBOX = [];             // alerts found in this build, sent at the end of main()
const TG_OFF = new Set();      // markets whose Telegram alerts were switched off on the page (watchlist.json telegramOff)
const tzTime = (t, opts = {}) => new Intl.DateTimeFormat('en-GB', { timeZone: ALERT_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...opts }).format(new Date(t));
const dirOf = (bias) => (/^Bullish/.test(bias || '') ? 1 : /^Bearish/.test(bias || '') ? -1 : 0);

function alertsFor(m, out, prev, now) {
  const dec = out.meta.decimals ?? 2;
  const f = (x) => Number(x).toFixed(dec);
  const prevA = prev?.alerts?.v === ALERTS_VERSION ? prev.alerts : null;
  const seed = !prevA;                              // no memory yet: record only
  const st = seed ? { side: {}, sent: {} } : structuredClone(prevA.state || { side: {}, sent: {} });
  st.side ||= {}; st.sent ||= {};
  const found = [];
  const fire = (type, key, text, extra = {}) => {
    if (st.sent[key]) return false;
    st.sent[key] = new Date(now).toISOString();
    if (!seed) found.push({ t: new Date(now).toISOString(), type, text, ...extra });
    return true;
  };
  const hoursSince = (key) => (st.sent[key] ? (now - Date.parse(st.sent[key])) / 36e5 : Infinity);
  const last = out.price.last, prevClose = out.price.prevClose, sigma = out.forecast.sigmaDaily;
  const daily = out.price.daily || [];
  const session = daily.at(-1)?.date || ymd(now);

  // 1. Unusual move: today's change beyond the range that holds on about 90% of days, and beyond 3 sigma
  if (last && prevClose && sigma) {
    const z = Math.log(last / prevClose) / sigma, pct = 100 * (last / prevClose - 1);
    const band = 100 * (Math.exp(Z90 * sigma) - 1);
    // both thresholds crossed at once give one line (the larger); each fires once per session and direction
    const lvl = Math.abs(z) >= 3 ? 2 : Math.abs(z) >= Z90 ? 1 : 0;
    if (lvl && !st.sent[`move:${session}:${Math.sign(z)}:${lvl}`]) {
      for (let k = 1; k < lvl; k++) st.sent[`move:${session}:${Math.sign(z)}:${k}`] ||= new Date(now).toISOString();
      fire('move', `move:${session}:${Math.sign(z)}:${lvl}`, `${pct > 0 ? 'Up' : 'Down'} ${Math.abs(pct).toFixed(1)}% today: ${lvl === 2 ? 'a very large' : 'an unusual'} move (90% of days stay within ±${band.toFixed(1)}%)`);
    }
  }

  // 1b. Price steps: every ALERT_STEP_PCT move from the price at the previous step alert, in either direction.
  //     A jump of several steps between two builds is one alert with the whole move. Prices are sampled about
  //     every 5 minutes, so a spike that reverses between two samples is not seen.
  if (ALERT_STEP_PCT > 0 && last > 0 && (!ALERT_STEP_MARKETS.length || ALERT_STEP_MARKETS.includes(String(m.id).toUpperCase()))) {
    if (!(st.anchor > 0)) st.anchor = last;      // first sight: remember the price, no alert
    else {
      const mv = 100 * (last / st.anchor - 1);
      if (Math.abs(mv) >= ALERT_STEP_PCT - 1e-9) {
        const today = out.price.changePct;
        const text = `${mv > 0 ? '▲ +' : '▼ '}${mv.toFixed(2)}% since the last price alert: ${f(st.anchor)} → ${f(last)}${today != null ? ` (today ${today > 0 ? '+' : ''}${today.toFixed(2)}%)` : ''}`;
        if (!seed) found.push({ t: new Date(now).toISOString(), type: 'step', text });
        st.anchor = last;
      }
    }
  }

  // 2. Key level breaks: the 50- and 200-day averages and the high/low of the previous 20 sessions.
  //    A side only changes once the price is clearly past the level (a quarter of a day's typical move), and a
  //    break only counts when the price itself moved through it (a level that moved past a still price is ignored).
  if (last && sigma) {
    const prior = daily.length > 21 ? daily.slice(-21, -1) : []; // the newest bar is the live session
    const lv = out.forecast.levels || [];
    const L = [
      ['50-day average', lv.find((x) => x.label === '50-day average')?.price],
      ['200-day average', lv.find((x) => x.label === '200-day average')?.price],
      ['20-day high', prior.length ? Math.max(...prior.map((x) => x.h ?? x.c)) : null],
      ['20-day low', prior.length ? Math.min(...prior.map((x) => x.l ?? x.c)) : null]
    ];
    const prevLast = prev?.price?.last;
    for (const [label, p] of L) {
      if (!(p > 0)) continue;
      const buf = 0.25 * sigma * p;
      const side = last > p + buf ? 'above' : last < p - buf ? 'below' : null;
      if (!side) continue;                          // too close to call: keep the old side
      const old = st.side[label];
      st.side[label] = side;
      if (!old || old === side) continue;
      const movedThrough = prevLast != null && (side === 'above' ? prevLast <= p + buf : prevLast >= p - buf);
      if (!movedThrough || hoursSince(`lvl:${label}`) < ALERT_LEVEL_COOLDOWN_H) continue;
      delete st.sent[`lvl:${label}`];
      const what = label === '20-day high' ? 'New 20-day high: broke above' : label === '20-day low' ? 'New 20-day low: broke below' : `Crossed ${side}`;
      fire('level', `lvl:${label}`, `${what} the ${label === '20-day high' || label === '20-day low' ? 'previous ' : ''}${label} at ${f(p)}`);
    }
  }

  // 3. Model lean flips between bullish and bearish (passing through Neutral does not count as a flip)
  const d = dirOf(out.forecast.bias);
  if (d) {
    if (!st.dir) st.dir = d;
    else if (d !== st.dir && hoursSince('flip') >= ALERT_FLIP_COOLDOWN_H) {
      const h1 = out.forecast.horizons?.[1];
      delete st.sent.flip;
      fire('flip', 'flip', `Model lean flipped to ${d > 0 ? 'bullish' : 'bearish'} (was ${st.dir > 0 ? 'bullish' : 'bearish'})${h1 ? `: 1-day centre ${f(h1.center)}, ${Math.round(100 * h1.pUp)}% chance of closing higher` : ''}`);
      st.dir = d;
    }
  }

  // 4. AI analyst switches between bullish and bearish in a new note. Hourly notes often wobble through
  //    "neutral", so neutral is ignored (like the model lean) and there is at most one such alert per 4 hours.
  const ai = out.ai;
  const side = (x) => (/bull/i.test(x || '') ? 'bullish' : /bear/i.test(x || '') ? 'bearish' : null);
  if (ai?.status === 'ok' && side(ai.stance)) {
    if (!side(st.stance)) st.stance = side(ai.stance);
    else if (side(ai.stance) !== st.stance && ai.at !== prev?.ai?.at && hoursSince('analyst') >= ALERT_ANALYST_COOLDOWN_H) {
      delete st.sent.analyst;
      fire('analyst', 'analyst', `AI analyst turned ${side(ai.stance)} (was ${st.stance})${ai.headline ? `: ${ai.headline}` : ''}`);
      st.stance = side(ai.stance);
    }
  }

  // 5. Scheduled events: a reminder shortly before (all-day events such as earnings: from 18:00 UTC the day before)
  for (const e of out.events || []) {
    const at = Date.parse(e.at);
    const due = e.allDay ? now >= Date.parse(e.date + 'T00:00:00Z') - 6 * 36e5 && now < Date.parse(e.date + 'T00:00:00Z') + 864e5
      : at > now && at - now <= ALERT_EVENT_LEAD_MIN * 60e3;
    if (!due) continue;
    const when = e.allDay ? `on ${new Date(e.date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })} (time not announced)` : `at ${tzTime(at)} ${ALERT_TZ.split('/').pop().replace(/_/g, ' ')} time (in ${Math.max(1, Math.round((at - now) / 60e3))} min)`;
    fire('event', `ev:${e.id}:${e.date}`, `${e.name} ${when}`, { event: `${e.id}:${e.date}`, eventName: e.name, eventWhen: when });
  }

  // forget sent markers older than 3 days, except the ones that hold state
  for (const [k, t] of Object.entries(st.sent)) if (now - Date.parse(t) > 3 * 864e5 && !/^(lvl:|flip$|analyst$)/.test(k)) delete st.sent[k];
  let nStep = 0, nOther = 0; // step alerts can be frequent: keep them from pushing the other alerts off the page
  const log = [...found.slice().reverse(), ...(prevA?.log || [])].filter((x) => now - Date.parse(x.t) < 7 * 864e5)
    .filter((x) => (x.type === 'step' ? nStep++ < ALERT_STEP_LOG_KEEP : nOther++ < ALERT_LOG_KEEP));
  if (found.length) OUTBOX.push({ id: m.id, name: m.name, last, changePct: out.price.changePct, dec, items: found });
  return { v: ALERTS_VERSION, state: st, log, telegram: !!(TG_TOKEN && TG_CHAT), muted: TG_OFF.has(String(m.id).toUpperCase()) || undefined };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function alertMessages(base) {
  const want = (a) => !TG_OFF.has(a.id.toUpperCase()) && (!ALERT_MARKETS.length || ALERT_MARKETS.includes(a.id.toUpperCase()));
  const boxes = OUTBOX.filter(want).map((b) => ({ ...b, items: b.items.filter((x) => ALERT_TYPES.includes(x.type)) })).filter((b) => b.items.length);
  // a release shared by several markets (Fed day) becomes one line
  const events = new Map();
  for (const b of boxes) for (const x of b.items.filter((x) => x.type === 'event')) {
    const e = events.get(x.event) || { name: x.eventName, when: x.eventWhen, ids: [] };
    e.ids.push(b.id); events.set(x.event, e);
  }
  const parts = [];
  for (const b of boxes) {
    const items = b.items.filter((x) => x.type !== 'event');
    if (!items.length) continue;
    const icon = { move: '📈', level: '🧱', flip: '🔄', analyst: '🧠', step: '' };
    const chg = b.changePct != null ? ` (${b.changePct > 0 ? '+' : ''}${b.changePct.toFixed(2)}%)` : '';
    parts.push(`<b>${esc(b.name)}</b> ${Number(b.last).toFixed(b.dec)}${chg}\n` + items.map((x) => `${icon[x.type] ?? '•'} ${esc(x.text)}`.trim()).join('\n') + (base ? `\n<a href="${esc(base)}#${encodeURIComponent(b.id)}/1d">Open ${esc(b.id)}</a>` : ''));
  }
  for (const e of events.values()) parts.push(`🗓 <b>${esc(e.name)}</b> ${esc(e.when)}\nMarkets: ${esc(e.ids.join(', '))}`);
  if (!parts.length) return [];
  const msgs = [];
  let cur = '';
  for (const p of parts) { if (cur && (cur + '\n\n' + p).length > 3800) { msgs.push(cur); cur = p; } else cur = cur ? cur + '\n\n' + p : p; }
  if (cur) msgs.push(cur);
  return msgs;
}
async function sendAlerts(base, now) {
  const total = OUTBOX.reduce((n, b) => n + b.items.length, 0);
  if (!total) return;
  const msgs = alertMessages(base);
  if (!TG_TOKEN || !TG_CHAT) { console.log(`::notice title=Alerts::${total} new alert(s), shown on the site only (Telegram not set up: add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)`); return; }
  if (!msgs.length) { console.log(`::notice title=Alerts::${total} new alert(s), none selected for Telegram (switched off on the page, ALERT_TYPES or ALERT_MARKETS)`); return; }
  let quiet = false;
  if (ALERT_QUIET) {
    const h = Number(tzTime(now, { minute: undefined })), a = Number(ALERT_QUIET[1]), b = Number(ALERT_QUIET[2]);
    quiet = a > b ? h >= a || h < b : h >= a && h < b;
  }
  let sent = 0;
  for (const text of msgs) {
    try {
      const res = await fetch(`${TG_API}/bot${TG_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: quiet }), signal: AbortSignal.timeout(15000) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(`HTTP ${res.status} ${j.description || ''}`.trim());
      sent++;
    } catch (e) { console.log(`::warning title=Telegram::message not sent - ${String(e.message).replace(TG_TOKEN, '***').slice(0, 200)}`); }
  }
  console.log(`::notice title=Alerts::${total} new alert(s); ${sent} of ${msgs.length} Telegram message(s) sent${quiet ? ' silently (quiet hours)' : ''}`);
}

// ---------- NATGAS (CNBC quote + self-maintained history) ----------
const NATGAS = { id: 'NATGAS', name: 'Natural gas (Henry Hub)', symbol: 'NG front month', category: 'energy', provider: 'cnbc', tv: 'OANDA:NATGASUSD', instrument: 'Henry Hub natural gas, NYMEX front-month futures (NG=F)' };
async function buildNatgas(base, now) {
  const prev = (await loadPrev(base, 'm/NATGAS.json', now)) || (await loadPrev(base, 'latest.json', now));
  const log = await carryForward('NATGAS', prev, now);
  const px = await loadPrices(prev, now);
  const news = await loadNews(prev, now, GAS_PROFILE);
  const fc = buildForecast(px, news, now, { calendar: 'ng', category: 'energy', hol: holKind(NATGAS) });
  const out = packOutput(NATGAS, px, news, fc, now, marketStatus(new Date(now)));
  await trackRecord(NATGAS, px, fc, out, prev, log, now, { calendar: 'ng', category: 'energy', hol: holKind(NATGAS) });
  await attachEvents(NATGAS, out, prev, now);
  out.ai = await aiFor(NATGAS, out, prev?.ai, now);
  out.alerts = alertsFor(NATGAS, out, prev, now);
  await save('m/NATGAS.json', out);
  await save('latest.json', out); // kept for older links
  return out;
}
// Other futures on the same free route: CNBC live quote + bootstrapped daily history (data/<seed>)
async function buildCnbcFutures(m, base, now, plan) {
  const prev = await loadPrev(base, `m/${m.id}.json`, now);
  const log = await carryForward(m.id, prev, now);
  const px = await loadPrices(prev, now, { yahoo: m.yahoo, cnbc: m.cnbc, seed: m.seed });
  const prof = profileFor(m);
  prof.maxReads = Math.min(prof.maxReads, plan.readsLeft);
  const news = await loadNews(prev, now, prof);
  plan.readsLeft = Math.max(0, plan.readsLeft - (news.reused ? 0 : prof.maxReads));
  await aiScoreNews(m, news, prev?.news, now);
  const fc = buildForecast(px, news, now, { calendar: 'ng', category: m.category, hol: holKind(m) });
  const out = packOutput(m, px, news, fc, now, marketStatus(new Date(now)));
  await trackRecord(m, px, fc, out, prev, log, now, { calendar: 'ng', category: m.category, hol: holKind(m) });
  await attachEvents(m, out, prev, now);
  out.ai = await aiFor(m, out, prev?.ai, now);
  out.alerts = alertsFor(m, out, prev, now);
  await save(`m/${m.id}.json`, out);
  return out;
}

// ---------- Twelve Data markets ----------
const TD_KEY = process.env.TWELVE_DATA_KEY || '';
const TD_DAILY_BUDGET = 760, TD_PER_RUN = 4; // free plan: 800 credits/day, 8/minute (builds can start <1 min apart, so 4 per build)
let tdCredits = TD_PER_RUN;
async function td(path, params) {
  if (tdCredits <= 0) throw new Error('per-minute API budget used; next refresh');
  tdCredits--;
  const u = new URL('https://api.twelvedata.com' + path);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
  u.searchParams.set('apikey', TD_KEY);
  const j = await get(u.toString(), { type: 'json', timeout: 15000, retries: 0 });
  if (j?.status === 'error' || (j?.code && j?.message)) throw new Error(`Twelve Data ${j.code || ''}: ${j.message}`);
  return j;
}
const tdArgs = (m) => ({ symbol: m.symbol, exchange: ['equity', 'etf'].includes(m.category) ? m.exchange : '' });
// Friday quotes run until 23:00 UTC so the US close (21:00 UTC in winter) and the currency close (22:00 UTC) are both captured
const weekendClosed = (now) => { const d = new Date(now), w = d.getUTCDay(), h = d.getUTCHours(); return w === 6 || (w === 0 && h < 21) || (w === 5 && h >= 23); };
const num = (v) => { const x = parseFloat(v); return isFinite(x) && x > 0 ? x : null; };

async function buildTwelveData(m, prev, now, plan) {
  const log = await carryForward(m.id, prev, now);
  const status = [];
  const byDate = new Map((prev?.price?.daily || []).map((r) => [r.date, { t: Date.parse(r.date + 'T22:00:00Z'), o: r.o, h: r.h, l: r.l, c: r.c }]));
  let last = prev?.price?.last ?? null, prevClose = prev?.price?.prevClose ?? null, lastTime = prev?.price?.asOf ? Date.parse(prev.price.asOf) : now;
  let market = prev?.market || 'closed', historyDate = prev?.meta?.historyDate || '', quotedAt = prev?.price?.quotedAt ? Date.parse(prev.price.quotedAt) : 0;
  let intraday = (prev?.price?.intraday || []).filter(([t]) => now - t < INTRADAY_KEEP_MS).map(([t, c, h, l]) => ({ t, c, h, l }));
  const todayUTC = new Date(now).toISOString().slice(0, 10);
  if (!TD_KEY) status.push({ name: 'Twelve Data', ok: false, error: 'API key missing: add the TWELVE_DATA_KEY repository secret' });
  else {
    if ((historyDate !== todayUTC || byDate.size < 30) && tdCredits > 0) {
      try {
        const j = await td('/time_series', { ...tdArgs(m), interval: '1day', outputsize: 260 });
        for (const v of j.values || []) byDate.set(v.datetime.slice(0, 10), { t: Date.parse(v.datetime.slice(0, 10) + 'T22:00:00Z'), o: num(v.open), h: num(v.high), l: num(v.low), c: num(v.close) });
        historyDate = todayUTC; status.push({ name: 'Twelve Data daily history', ok: true });
        if (last == null && j.values?.length) { last = num(j.values[0].close); lastTime = Date.parse(j.values[0].datetime); }
      } catch (e) { status.push({ name: 'Twelve Data daily history', ok: false, error: e.message }); }
    }
    const due = now - quotedAt >= (plan.intervalMin - 0.5) * 60e3 && !(m.category !== 'crypto' && weekendClosed(now) && last != null && now - quotedAt < 12 * 36e5);
    if (due && tdCredits <= 0) status.push({ name: 'Twelve Data quote (queued for the next refresh: per-minute API limit)', ok: true });
    else if (due) {
      try {
        const q = await td('/quote', tdArgs(m));
        last = num(q.close); prevClose = num(q.previous_close) ?? prevClose; lastTime = (q.last_quote_at || q.timestamp) * 1000 || now; quotedAt = now;
        market = q.is_market_open ? 'open' : 'closed';
        const day = String(q.datetime || todayUTC).slice(0, 10);
        const bar = byDate.get(day) || { t: Date.parse(day + 'T22:00:00Z'), o: num(q.open) ?? last };
        bar.c = last; bar.h = Math.max(bar.h ?? last, num(q.high) ?? last, last); bar.l = Math.min(bar.l ?? last, num(q.low) ?? last, last);
        byDate.set(day, bar);
        if (market === 'open') intraday.push({ t: now, c: last, h: num(q.high), l: num(q.low) });
        status.push({ name: 'Twelve Data live quote', ok: true });
      } catch (e) { status.push({ name: 'Twelve Data live quote', ok: false, error: e.message }); }
    } else status.push({ name: `Twelve Data quote (refreshes every ${plan.intervalMin} min to stay on the free plan)`, ok: true });
  }
  const daily = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, r]) => r).filter((r) => r.c != null).slice(-260);
  if (!daily.length || last == null) return { error: status.find((x) => !x.ok)?.error || 'no price data yet', status };
  if (prevClose == null && daily.length > 1) prevClose = daily.at(-2).c;
  const px = { daily, intraday, last, prevClose, lastTime, source: 'Twelve Data', stale: !TD_KEY, status };
  const prof = profileFor(m);
  prof.maxReads = Math.min(prof.maxReads, plan.readsLeft);
  const news = await loadNews(prev, now, prof);
  plan.readsLeft = Math.max(0, plan.readsLeft - (news.reused ? 0 : prof.maxReads));
  await aiScoreNews(m, news, prev?.news, now);
  const fc = buildForecast(px, news, now, { category: m.category, hol: holKind(m), calendar: m.category === 'crypto' ? 'daily' : 'weekday', today: daily.at(-1) ? new Date(daily.at(-1).t).toISOString().slice(0, 10) : todayUTC });
  const out = packOutput({ ...m, provider: 'twelvedata' }, px, news, fc, now, market, { meta: { historyDate }, price: { quotedAt: quotedAt ? new Date(quotedAt).toISOString() : null } });
  await trackRecord(m, px, fc, out, prev, log, now, { calendar: m.category === 'crypto' ? 'daily' : 'weekday', category: m.category, hol: holKind(m) });
  await attachEvents(m, out, prev, now);
  return { out };
}

function summary(out, m, error) {
  if (!out) return { id: m.id, name: m.name, symbol: m.symbol, category: m.category, exchange: m.exchange || '', tv: m.tv || undefined, error };
  const h = out.forecast.horizons;
  return { id: m.id, name: m.name, symbol: m.symbol, category: m.category, exchange: m.exchange || '', tv: m.tv || undefined, last: out.price.last, changePct: out.price.changePct, decimals: out.meta.decimals,
    market: out.market, ai: out.ai?.status === 'ok' ? { stance: out.ai.stance, headline: out.ai.headline } : null, bias: out.forecast.bias, score: out.forecast.score, h: Object.fromEntries(Object.entries(h).map(([k, v]) => [k, { center: v.center, changePct: v.changePct, pUp: v.pUp, lo68: v.lo68, hi68: v.hi68, events: v.events && v.events.length ? v.events : undefined }])),
    rsi: out.forecast.rsi, next: out.events && out.events[0] ? { id: out.events[0].id, name: out.events[0].name, date: out.events[0].date, at: out.events[0].at, allDay: out.events[0].allDay || undefined } : null, asOf: out.price.asOf, tgOff: TG_OFF.has(String(m.id).toUpperCase()) || undefined, error };
}

async function main() {
  const now = Date.now();
  const base = siteUrl();
  BASE = base;
  let watch = { markets: [] };
  try { watch = JSON.parse(await readFile(join(ROOT, 'watchlist.json'), 'utf8')); } catch { /* default */ }
  for (const id of watch.telegramOff || []) TG_OFF.add(String(id).toUpperCase());
  const markets = (watch.markets || []).filter((m) => m.provider === 'twelvedata');
  const futures = (watch.markets || []).filter((m) => m.provider === 'cnbc');
  const index = { generatedAt: new Date(now).toISOString(), keyConfigured: !!TD_KEY, maxMarkets: 8, markets: [] };

  try { const out = await buildNatgas(base, now); index.markets.push(summary(out, NATGAS)); console.log(`OK NATGAS last=${out.price.last} bias=${out.forecast.bias}`); for (const s of out.sources) if (!s.ok) console.log(`::warning title=NATGAS ${s.name}::${(s.error || 'no answer').replace(/\n/g, ' ')}`); }
  catch (e) { index.markets.push(summary(null, NATGAS, e.message)); console.log(`::error title=NATGAS failed::${e.message}`); FAILED.length = 0; }

  const n = Math.max(1, markets.length);
  const plan = { intervalMin: Math.max(10, Math.ceil((n * 1440) / (TD_DAILY_BUDGET - n) / 5) * 5), readsLeft: 30 };
  for (const m of futures) {
    try { FAILED.length = 0; const out = await buildCnbcFutures(m, base, now, plan); index.markets.push(summary(out, m)); console.log(`OK ${m.id} last=${out.price.last} bias=${out.forecast.bias}`); for (const s of out.sources) if (!s.ok && /CNBC|history/.test(s.name)) console.log(`::warning title=${m.id} ${s.name}::${s.error || ''}`); }
    catch (e) { index.markets.push(summary(null, m, e.message)); console.log(`::warning title=${m.id} failed::${e.message} ${FAILED.map((x) => x.name + ': ' + x.error).join(' | ')}`); }
  }
  index.quoteIntervalMin = plan.intervalMin;
  // markets quoted longest ago go first so the per-minute API budget is shared fairly
  const prevs = await Promise.all(markets.map((m) => loadPrev(base, `m/${m.id}.json`, now)));
  const order = markets.map((m, i) => i).sort((a, b) => Date.parse(prevs[a]?.price?.quotedAt || 0) - Date.parse(prevs[b]?.price?.quotedAt || 0));
  const results = new Array(markets.length);
  for (const i of order) {
    const m = markets[i];
    try {
      const r = await buildTwelveData(m, prevs[i], now, plan);
      if (r.out) { r.out.ai = await aiFor(m, r.out, prevs[i]?.ai, now); r.out.alerts = alertsFor(m, r.out, prevs[i], now); await save(`m/${m.id}.json`, r.out); results[i] = summary(r.out, m, r.out.sources.find((x) => !x.ok && /Twelve Data/.test(x.name))?.error); console.log(`OK ${m.id} last=${r.out.price.last} bias=${r.out.forecast.bias}`); }
      else { results[i] = summary(null, m, r.error); console.log(`::warning title=${m.id}::${r.error}`); }
    } catch (e) { results[i] = summary(null, m, e.message); console.log(`::warning title=${m.id} failed::${e.message}`); }
  }
  index.markets.push(...results);
  await save('index.json', index);
  // alerts go out only when this build will be published, so the record of what was sent is kept
  if (!TRACK_UNSAFE) await sendAlerts(base, now);
  if (TRACK_UNSAFE) { console.log('::error title=Not published::the forecast log could not be read back from the live site, so this refresh is not deployed (the site keeps its previous data; the next refresh retries)'); process.exitCode = 1; }
}

main().catch(async (e) => {
  console.log(`::error title=Build failed::${String(e?.message || e).replace(/\n/g, ' ')}`);
  process.exit(0);
});
