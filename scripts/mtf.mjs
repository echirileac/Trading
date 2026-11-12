// Multi-timeframe chart reading: 15-minute, 1-hour and daily bars.
// For each timeframe: trend, momentum and the classic chart patterns, then one verdict on whether the three agree
// (Alexander Elder's "triple screen": the daily chart sets the direction, the 1-hour chart shows the pullback,
// the 15-minute chart times the turn).
// No I/O, no dependencies. Every value at bar i uses bars 0..i only, so the code that reads the live chart also
// replays history and counts how often each pattern was followed by a move in its direction. The rules are the
// textbook ones with fixed settings: nothing here is tuned on the markets it is scored on.

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const round = (x, d = 2) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const sgn = Math.sign;

// ahead = bars until a pattern is scored; life = bars a pattern stays on the board; k = bars on each side of a swing point
export const TFS = {
  '15m': { ms: 15 * 60e3, ahead: 4, life: 8, k: 3, label: '15 min', aheadText: '1 hour' },
  '1h': { ms: 36e5, ahead: 4, life: 6, k: 3, label: '1 hour', aheadText: '4 hours' },
  '1d': { ms: 864e5, ahead: 3, life: 5, k: 3, label: '1 day', aheadText: '3 sessions' }
};
export const TF_ORDER = ['15m', '1h', '1d'];
export const TF_WEIGHT = { '1d': 0.45, '1h': 0.35, '15m': 0.2 }; // share of each timeframe in the combined reading
const CALL = 0.25;  // a timeframe score beyond this is called up or down, inside it sideways
const WARM = 55;    // bars needed before a timeframe is read (50-bar average plus a few)

// name: [bullish version, bearish version]; w = weight inside the pattern part of a timeframe's score
export const PATTERNS = {
  engulf: { name: ['Bullish engulfing', 'Bearish engulfing'], w: 0.5 },
  pin: { name: ['Hammer', 'Shooting star'], w: 0.5 },
  star: { name: ['Morning star', 'Evening star'], w: 0.6 },
  double: { name: ['Double bottom', 'Double top'], w: 1 },
  hs: { name: ['Inverse head and shoulders', 'Head and shoulders'], w: 1 },
  breakout: { name: ['Breakout above the 20-bar high', 'Breakdown below the 20-bar low'], w: 0.8 },
  diverge: { name: ['Bullish RSI divergence', 'Bearish RSI divergence'], w: 0.7 },
  pullback: { name: ['Pullback ended in an uptrend', 'Bounce ended in a downtrend'], w: 0.7 },
  // the two crossovers are listed and scored like the rest but add nothing to the score: the momentum part already
  // counts the MACD histogram and the trend part the order of the averages
  macd: { name: ['MACD turned up', 'MACD turned down'], w: 0 },
  cross: { name: ['20-bar average crossed above the 50-bar', '20-bar average crossed below the 50-bar'], w: 0 },
  golden: { name: ['Golden cross (50-day above 200-day)', 'Death cross (50-day below 200-day)'], w: 0.6 }
};
export const patternName = (id, dir, tf) => { const n = PATTERNS[id]?.name[dir > 0 ? 0 : 1] || id; return tf === '1d' ? n.replace(/-bar/g, '-day') : n; };

// ---------- bars ----------
// Price samples ({t, c, h, l}: h and l are the session's high and low so far) -> bars. A bar opens at the previous
// bar's close when the two are back to back, so thinning old samples does not move it.
export function barsFromSamples(samples, ms = TFS['15m'].ms) {
  const out = []; let b = null, was = null;
  for (const s of samples) {
    if (!(s.c > 0)) continue;
    const k = Math.floor(s.t / ms) * ms;
    if (!b || b.t !== k) {
      const o = b && k - b.t === ms ? b.c : s.c;
      b = { t: k, o, h: Math.max(o, s.c), l: Math.min(o, s.c), c: s.c };
      out.push(b);
    } else { b.h = Math.max(b.h, s.c); b.l = Math.min(b.l, s.c); b.c = s.c; }
    // a session high or low that moved since the previous sample was traded in between: it becomes this bar's wick
    if (s.h > 0 && s.l > 0 && was && was.h > 0 && was.l > 0 && s.t - was.t <= 16 * 60e3 && s.h >= was.h && s.l <= was.l) {
      if (s.h > was.h && s.h < s.c * 1.25) b.h = Math.max(b.h, s.h);
      if (s.l < was.l && s.l > s.c * 0.8) b.l = Math.min(b.l, s.l);
    }
    was = s;
  }
  return out;
}
// Smaller bars -> bigger bars. offset shifts the bucket edges (US shares trade from half past the hour).
export function aggregate(bars, ms, offset = 0) {
  const out = []; let b = null;
  for (const r of bars) {
    const k = Math.floor((r.t - offset) / ms) * ms + offset;
    if (!b || b.t !== k) { b = { t: k, o: r.o, h: r.h, l: r.l, c: r.c }; out.push(b); }
    else { b.h = Math.max(b.h, r.h); b.l = Math.min(b.l, r.l); b.c = r.c; }
  }
  return out;
}
// Exchange candles (base) continued with bars built from newer samples (live).
export function mergeBars(base, live) {
  if (!base.length) return live.map((b) => ({ ...b }));
  const out = base.map((b) => ({ ...b })), lastT = out.at(-1).t;
  for (const b of live) {
    if (b.t < lastT) continue;
    if (b.t === lastT) { const x = out.at(-1); x.h = Math.max(x.h, b.h); x.l = Math.min(x.l, b.l); x.c = b.c; }
    else out.push({ ...b });
  }
  return out;
}

// ---------- indicators (arrays, null until there is enough history) ----------
function ema(v, n) {
  const out = new Array(v.length).fill(null); if (v.length < n) return out;
  let e = mean(v.slice(0, n)); out[n - 1] = e; const k = 2 / (n + 1);
  for (let i = n; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function smaArr(v, n) {
  const out = new Array(v.length).fill(null); let s = 0;
  for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= n) s -= v[i - n]; if (i >= n - 1) out[i] = s / n; }
  return out;
}
function rsiArr(c, n = 14) { // Wilder's smoothing, the same formula as the rest of the site
  const out = new Array(c.length).fill(null); if (c.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n; out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  return out;
}
const trueRange = (b, i) => Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
function atrArr(b, n = 14) {
  const out = new Array(b.length).fill(null); if (b.length <= n) return out;
  let a = 0; for (let i = 1; i <= n; i++) a += trueRange(b, i);
  a /= n; out[n] = a;
  for (let i = n + 1; i < b.length; i++) { a = (a * (n - 1) + trueRange(b, i)) / n; out[i] = a; }
  return out;
}
function adxArr(b, n = 14) { // Wilder's trend-strength index: above 25 a trend, below 20 a range
  const N = b.length, out = new Array(N).fill(null); let trS = 0, pS = 0, mS = 0, cnt = 0, sum = 0;
  for (let i = 1; i < N; i++) {
    const up = b[i].h - b[i - 1].h, dn = b[i - 1].l - b[i].l;
    const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0, tr = trueRange(b, i);
    if (i <= n) { trS += tr; pS += p; mS += m; if (i < n) continue; }
    else { trS += tr - trS / n; pS += p - pS / n; mS += m - mS / n; }
    const pdi = trS ? 100 * pS / trS : 0, mdi = trS ? 100 * mS / trS : 0, dx = pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
    cnt++;
    if (cnt <= n) { sum += dx; if (cnt === n) out[i] = sum / n; }
    else out[i] = (out[i - 1] * (n - 1) + dx) / n;
  }
  return out;
}
function macdHist(c) { // MACD 12, 26, 9: the line minus its signal
  const e12 = ema(c, 12), e26 = ema(c, 26), line = c.map((_, i) => (e26[i] == null ? null : e12[i] - e26[i]));
  const out = new Array(c.length).fill(null), st = line.findIndex((x) => x != null); if (st < 0) return out;
  ema(line.slice(st), 9).forEach((v, j) => { if (v != null) out[st + j] = line[st + j] - v; });
  return out;
}
function bandWidth(c, n = 20) { // Bollinger band width as a share of price
  const out = new Array(c.length).fill(null);
  for (let i = n - 1; i < c.length; i++) { const w = c.slice(i - n + 1, i + 1), m = mean(w); out[i] = m ? 4 * Math.sqrt(mean(w.map((x) => (x - m) ** 2))) / m : null; }
  return out;
}

// ---------- one timeframe ----------
// Returns the score of every bar (S, from -1 to +1 = half trend, 30% momentum, 20% patterns) and every pattern
// found (events). forming = the last bar is still moving: it counts for trend and momentum, never for a pattern.
export function study(bars, tfKey, { forming = false } = {}) {
  const tf = TFS[tfKey], n = bars.length, k = tf.k;
  const o = bars.map((b) => b.o), h = bars.map((b) => b.h), l = bars.map((b) => b.l), c = bars.map((b) => b.c);
  const e20 = ema(c, 20), e50 = ema(c, 50), rsi = rsiArr(c), hist = macdHist(c), atr = atrArr(bars), adx = adxArr(bars), bw = bandWidth(c);
  const s50 = tfKey === '1d' ? smaArr(c, 50) : null, s200 = tfKey === '1d' ? smaArr(c, 200) : null;
  const nul = () => new Array(n).fill(null);
  const T = nul(), M = nul(), P = nul(), S = nul(), ST = nul(), events = [], SH = [], SL = [], fired = new Set();
  const hi = (a, b) => { let m = -Infinity; for (let i = Math.max(0, a); i <= b; i++) if (h[i] > m) m = h[i]; return m; };
  const lo = (a, b) => { let m = Infinity; for (let i = Math.max(0, a); i <= b; i++) if (l[i] < m) m = l[i]; return m; };
  let lastPull = -99;
  for (let i = 0; i < n; i++) {
    // a swing high / low is known k bars after it happened
    const j = i - k;
    if (j >= k) {
      let isH = true, isL = true;
      for (let x = j - k; x <= j + k; x++) { if (x === j) continue; if (x < j ? h[x] > h[j] : h[x] >= h[j]) isH = false; if (x < j ? l[x] < l[j] : l[x] <= l[j]) isL = false; }
      if (isH) SH.push({ j, v: h[j] });
      if (isL) SL.push({ j, v: l[j] });
    }
    if (i < WARM - 1 || e50[i] == null || hist[i] == null || hist[i - 1] == null || atr[i] == null || rsi[i] == null) continue;
    const a = atr[i];

    // trend: price against its 20- and 50-bar averages, the slope of the 20, and the sequence of swing highs and lows (Dow)
    const ma = (sgn(c[i] - e20[i]) + sgn(e20[i] - e50[i]) + sgn(e20[i] - e20[i - 5])) / 3;
    let st = 0;
    if (SH.length >= 2 && SL.length >= 2) {
      const h1 = SH.at(-2), h2 = SH.at(-1), l1 = SL.at(-2), l2 = SL.at(-1);
      if (h2.v > h1.v && l2.v > l1.v) st = 1; else if (h2.v < h1.v && l2.v < l1.v) st = -1;
    }
    ST[i] = st;
    T[i] = (0.65 * ma + 0.35 * st) * (adx[i] != null && adx[i] < 18 ? 0.6 : 1); // a weak ADX means a range: the trend counts for less
    // momentum: RSI against its midline, and whether the MACD histogram is above zero and growing
    const mh = hist[i] > 0 ? (hist[i] >= hist[i - 1] ? 1 : 0.5) : hist[i] < 0 ? (hist[i] <= hist[i - 1] ? -1 : -0.5) : 0;
    M[i] = 0.5 * clamp((rsi[i] - 50) / 20, -1, 1) + 0.5 * mh;

    // patterns, on completed bars only
    if (!(forming && i === n - 1)) {
      const fire = (id, dir, key) => { if (key) { if (fired.has(key)) return; fired.add(key); } events.push({ i, t: bars[i].t, id, dir, px: c[i] }); };
      const body = Math.abs(c[i] - o[i]), range = h[i] - l[i], up = c[i] > o[i], dn = c[i] < o[i];
      const b1 = Math.abs(c[i - 1] - o[i - 1]);

      // engulfing (Nison): a bar whose body swallows the previous, opposite body, after a move the other way
      if (up && c[i - 1] < o[i - 1] && c[i] >= o[i - 1] && o[i] <= c[i - 1] + 0.1 * a && body > b1 && body >= 0.5 * a && c[i - 1] < c[i - 5]) fire('engulf', 1);
      if (dn && c[i - 1] > o[i - 1] && c[i] <= o[i - 1] && o[i] >= c[i - 1] - 0.1 * a && body > b1 && body >= 0.5 * a && c[i - 1] > c[i - 5]) fire('engulf', -1);

      // hammer / shooting star: a long wick that rejects a new 10-bar low / high
      if (range >= 0.8 * a) {
        const lw = Math.min(o[i], c[i]) - l[i], uw = h[i] - Math.max(o[i], c[i]);
        if (lw >= 2 * body && lw >= 0.6 * range && uw <= 0.25 * range && l[i] <= lo(i - 10, i - 1)) fire('pin', 1);
        if (uw >= 2 * body && uw >= 0.6 * range && lw <= 0.25 * range && h[i] >= hi(i - 10, i - 1)) fire('pin', -1);
      }

      // morning / evening star: long bar, small bar, then a bar that takes back more than half of the first
      const b2 = Math.abs(c[i - 2] - o[i - 2]);
      if (b2 >= 0.7 * a && b1 <= 0.35 * b2) {
        if (c[i - 2] < o[i - 2] && up && c[i] >= (o[i - 2] + c[i - 2]) / 2 && c[i - 2] < c[i - 6]) fire('star', 1);
        if (c[i - 2] > o[i - 2] && dn && c[i] <= (o[i - 2] + c[i - 2]) / 2 && c[i - 2] > c[i - 6]) fire('star', -1);
      }

      // double bottom / top: two similar swing points with a clear bounce between, confirmed by a close through the middle
      for (let q = SL.length - 1; q >= 1 && q >= SL.length - 3; q--) {
        const p1 = SL[q - 1], p2 = SL[q], gap = p2.j - p1.j;
        if (gap < 5 || gap > 60 || i - p2.j > 40 || Math.abs(p1.v - p2.v) > a) continue;
        const neck = hi(p1.j, p2.j), base = Math.min(p1.v, p2.v);
        if (neck - Math.max(p1.v, p2.v) < 2 * a || p1.v > lo(p1.j - 20, p1.j - 1) || lo(p2.j + 1, i) < base) continue;
        if (c[i] > neck && c[i - 1] <= neck) fire('double', 1, `db${p1.j}-${p2.j}`);
      }
      for (let q = SH.length - 1; q >= 1 && q >= SH.length - 3; q--) {
        const p1 = SH[q - 1], p2 = SH[q], gap = p2.j - p1.j;
        if (gap < 5 || gap > 60 || i - p2.j > 40 || Math.abs(p1.v - p2.v) > a) continue;
        const neck = lo(p1.j, p2.j), top = Math.max(p1.v, p2.v);
        if (Math.min(p1.v, p2.v) - neck < 2 * a || p1.v < hi(p1.j - 20, p1.j - 1) || hi(p2.j + 1, i) > top) continue;
        if (c[i] < neck && c[i - 1] >= neck) fire('double', -1, `dt${p1.j}-${p2.j}`);
      }

      // head and shoulders: three swing highs, the middle one clearly highest and the outer two alike, confirmed by a close
      // below both dips between them (the neckline). Inverse: the same upside down.
      for (let q = SH.length - 1; q >= 2 && q >= SH.length - 2; q--) {
        const A = SH[q - 2], B = SH[q - 1], C = SH[q];
        if (C.j - A.j < 10 || C.j - A.j > 100 || i - C.j > 40) continue;
        if (B.v < A.v + 0.5 * a || B.v < C.v + 0.5 * a || Math.abs(A.v - C.v) > 1.5 * a || A.v < hi(A.j - 20, A.j - 1) || hi(C.j + 1, i) > B.v) continue;
        const neck = Math.min(lo(A.j, B.j), lo(B.j, C.j));
        if (c[i] < neck && c[i - 1] >= neck) fire('hs', -1, `hs${A.j}-${C.j}`);
      }
      for (let q = SL.length - 1; q >= 2 && q >= SL.length - 2; q--) {
        const A = SL[q - 2], B = SL[q - 1], C = SL[q];
        if (C.j - A.j < 10 || C.j - A.j > 100 || i - C.j > 40) continue;
        if (B.v > A.v - 0.5 * a || B.v > C.v - 0.5 * a || Math.abs(A.v - C.v) > 1.5 * a || A.v > lo(A.j - 20, A.j - 1) || lo(C.j + 1, i) < B.v) continue;
        const neck = Math.max(hi(A.j, B.j), hi(B.j, C.j));
        if (c[i] > neck && c[i - 1] <= neck) fire('hs', 1, `ihs${A.j}-${C.j}`);
      }

      // range breakout (Donchian, the Turtle rule): the first close beyond the previous 20 bars
      if (c[i] > hi(i - 20, i - 1) && c[i - 1] <= hi(i - 21, i - 2)) fire('breakout', 1);
      if (c[i] < lo(i - 20, i - 1) && c[i - 1] >= lo(i - 21, i - 2)) fire('breakout', -1);

      // RSI divergence, checked when a new swing point is confirmed: price makes a lower low while RSI makes a higher one
      if (SL.length >= 2 && SL.at(-1).j === j) {
        const p1 = SL.at(-2), p2 = SL.at(-1), g = p2.j - p1.j;
        if (g >= 5 && g <= 60 && p2.v < p1.v && rsi[p1.j] != null && rsi[p1.j] < 40 && rsi[p2.j] > rsi[p1.j] + 2) fire('diverge', 1);
      }
      if (SH.length >= 2 && SH.at(-1).j === j) {
        const p1 = SH.at(-2), p2 = SH.at(-1), g = p2.j - p1.j;
        if (g >= 5 && g <= 60 && p2.v > p1.v && rsi[p1.j] != null && rsi[p1.j] > 60 && rsi[p2.j] < rsi[p1.j] - 2) fire('diverge', -1);
      }

      // trend pullback (Elder): in a trend, price came back to its 20-bar average and now closes beyond the previous bar
      if (i - lastPull > 5) {
        let nearUp = false, nearDn = false;
        for (let x = i - 4; x < i; x++) { if (l[x] - e20[x] <= 0.25 * a) nearUp = true; if (e20[x] - h[x] <= 0.25 * a) nearDn = true; }
        if (e20[i] > e50[i] && e50[i] > e50[i - 5] && c[i] > e50[i] && nearUp && up && c[i] > h[i - 1] && c[i] > e20[i] && c[i - 1] <= h[i - 2]) { fire('pullback', 1); lastPull = i; }
        else if (e20[i] < e50[i] && e50[i] < e50[i - 5] && c[i] < e50[i] && nearDn && dn && c[i] < l[i - 1] && c[i] < e20[i] && c[i - 1] >= l[i - 2]) { fire('pullback', -1); lastPull = i; }
      }

      // crossovers
      if (hist[i] > 0 && hist[i - 1] <= 0) fire('macd', 1); else if (hist[i] < 0 && hist[i - 1] >= 0) fire('macd', -1);
      if (e50[i - 1] != null) { if (e20[i] > e50[i] && e20[i - 1] <= e50[i - 1]) fire('cross', 1); else if (e20[i] < e50[i] && e20[i - 1] >= e50[i - 1]) fire('cross', -1); }
      if (s200 && s200[i - 1] != null) { if (s50[i] > s200[i] && s50[i - 1] <= s200[i - 1]) fire('golden', 1); else if (s50[i] < s200[i] && s50[i - 1] >= s200[i - 1]) fire('golden', -1); }
    }

    // patterns fade over their life
    let p = 0;
    for (let x = events.length - 1; x >= 0 && i - events[x].i < tf.life; x--) p += PATTERNS[events[x].id].w * events[x].dir * (1 - (i - events[x].i) / tf.life);
    P[i] = clamp(p, -1, 1);
    S[i] = 0.5 * T[i] + 0.3 * M[i] + 0.2 * P[i];
  }
  return { tf: tfKey, n, done: forming ? n - 1 : n, c, e20, e50, rsi, hist, adx, bw, T, M, P, S, ST, events, SH, SL };
}
export const labelOf = (s) => (s == null ? null : s >= CALL ? 'up' : s <= -CALL ? 'down' : 'side');

// The latest bar of a study, in the shape the page shows.
export function snapshot(st, bars) {
  const tf = TFS[st.tf], i = st.n - 1;
  if (i < 0 || st.S[i] == null) return { tf: st.tf, ready: false, bars: st.n, need: WARM };
  const win = st.bw.slice(Math.max(0, i - 99), i + 1).filter((x) => x != null).sort((x, y) => x - y);
  const squeeze = win.length >= 60 && st.bw[i] <= win[Math.floor(win.length * 0.1)]; // band width in its lowest tenth of the last 100 bars
  const rising = st.hist[i] >= st.hist[i - 1];
  // patterns still on the board, newest first; a pattern that repeated is listed once, at its latest appearance
  const seen = new Set(), recent = st.events.filter((e) => i - e.i < tf.life).reverse().filter((e) => { const k = e.id + e.dir; if (seen.has(k)) return false; seen.add(k); return true; });
  return {
    tf: st.tf, ready: true, bars: st.n, t: bars[i].t,
    score: round(st.S[i]), label: labelOf(st.S[i]), trend: round(st.T[i]), mom: round(st.M[i]), pat: round(st.P[i]),
    ma: [sgn(st.c[i] - st.e20[i]), sgn(st.e20[i] - st.e50[i])], struct: st.ST[i], adx: round(st.adx[i], 0),
    rsi: round(st.rsi[i], 1), macd: st.hist[i] > 0 ? (rising ? 2 : 1) : st.hist[i] < 0 ? (rising ? -1 : -2) : 0, squeeze,
    swingHigh: st.SH.length ? st.SH.at(-1).v : null, swingLow: st.SL.length ? st.SL.at(-1).v : null,
    patterns: recent.slice(0, 4).map((e) => ({ id: e.id, dir: e.dir, name: patternName(e.id, e.dir, st.tf), t: e.t, ago: i - e.i, px: e.px }))
  };
}
// One plain sentence per timeframe.
export function describe(sn) {
  if (!sn?.ready) return `Not enough history yet (${sn?.bars || 0} of ${sn?.need || WARM} bars).`;
  const [a, b] = sn.ma, u = sn.tf === '1d' ? 'day' : 'bar';
  const ma = a > 0 && b > 0 ? `price above its 20- and 50-${u} averages` : a < 0 && b < 0 ? `price below its 20- and 50-${u} averages` : a > 0 ? `price back above its 20-${u} average, which is still under the 50` : a < 0 ? `price under its 20-${u} average, which is still above the 50` : `price on its 20-${u} average`;
  const st = sn.struct > 0 ? ', higher highs and higher lows' : sn.struct < 0 ? ', lower highs and lower lows' : '';
  const strength = sn.adx == null ? '' : sn.adx >= 25 ? ` (strong trend, ADX ${sn.adx})` : sn.adx < 18 ? ` (no real trend, ADX ${sn.adx})` : '';
  const rsi = sn.rsi >= 70 ? `RSI ${sn.rsi.toFixed(0)} (overbought)` : sn.rsi <= 30 ? `RSI ${sn.rsi.toFixed(0)} (oversold)` : `RSI ${sn.rsi.toFixed(0)}`;
  const macd = { 2: 'MACD above its signal and rising', 1: 'MACD above its signal but fading', '-1': 'MACD below its signal but recovering', '-2': 'MACD below its signal and falling', 0: 'MACD flat' }[sn.macd];
  return `${ma[0].toUpperCase()}${ma.slice(1)}${st}${strength}. ${rsi}, ${macd}.${sn.squeeze ? ' Bollinger bands are unusually tight (a squeeze).' : ''}`;
}

// ---------- the three together ----------
export function alignScore(scores) { // weighted by TF_WEIGHT over the timeframes that are ready
  let w = 0, v = 0;
  for (const [k, wt] of Object.entries(TF_WEIGHT)) if (scores[k] != null) { w += wt; v += wt * scores[k]; }
  return w ? v / w : null;
}
export function verdict(sn) {
  const lab = (k) => (sn[k]?.ready ? sn[k].label : null);
  const d = lab('1d'), hh = lab('1h'), m = lab('15m');
  const ready = [d, hh, m].filter(Boolean);
  if (!ready.length) return { id: 'none', dir: 0, title: 'Not enough history yet', text: 'The timeframes fill in as price history builds up.' };
  if (!d || !hh || !m) {
    const have = TF_ORDER.filter((k) => lab(k)), up = have.filter((k) => lab(k) === 'up').length, dn = have.filter((k) => lab(k) === 'down').length;
    const dir = up && !dn ? 1 : dn && !up ? -1 : 0;
    return { id: 'partial', dir, title: dir > 0 ? 'Up on the charts read so far' : dir < 0 ? 'Down on the charts read so far' : 'No clear direction yet', text: `Only ${have.map((k) => TFS[k].label).join(' and ')} can be read so far; the rest need more price history.` };
  }
  const word = { up: 'up', down: 'down', side: 'sideways' };
  if (d === 'side') {
    if (hh === m && hh !== 'side') return { id: 'push', dir: hh === 'up' ? 1 : -1, title: `Short-term push ${word[hh]}`, text: `The 15-minute and 1-hour charts point ${word[hh]}, but the daily chart has no trend: moves inside a range often stall at its edges.` };
    return { id: 'mixed', dir: 0, title: 'No clear direction', text: `The daily chart is sideways, the 1-hour chart ${word[hh]} and the 15-minute chart ${word[m]}.` };
  }
  const s = d === 'up' ? 1 : -1, With = d, against = d === 'up' ? 'down' : 'up';
  const trend = s > 0 ? 'uptrend' : 'downtrend', back = s > 0 ? 'pullback' : 'bounce', turn = s > 0 ? 'turned up' : 'turned down', side = s > 0 ? 'buy' : 'sell';
  if (hh === With && m === With) return { id: 'aligned', dir: s, title: `All three timeframes point ${word[d]}`, text: `Daily, 1-hour and 15-minute charts agree. The trend is clear, but a move all three already show is no longer early: triple-screen traders prefer to enter after a ${back}.` };
  if (hh !== With && m === With) return { id: 'setup', dir: s, title: `${back[0].toUpperCase()}${back.slice(1)} ${side} setup`, text: `The daily ${trend} is intact, the 1-hour chart shows a ${back}, and the 15-minute chart has ${turn} again. This is the classic triple-screen entry: with the big trend, after a ${back}.` };
  if (hh === With && m === 'side') return { id: 'trend', dir: s, title: `${trend[0].toUpperCase()}${trend.slice(1)}, pausing short-term`, text: `Daily and 1-hour charts point ${word[d]}; the 15-minute chart is flat.` };
  if (hh === With && m === against) return { id: 'dip', dir: s, title: `${trend[0].toUpperCase()}${trend.slice(1)} with a small ${back}`, text: `Daily and 1-hour charts point ${word[d]}; the 15-minute chart is moving against them for now.` };
  if (hh === against) return { id: 'pullback', dir: 0, title: `${back[0].toUpperCase()}${back.slice(1)} inside a daily ${trend}`, text: `The daily chart points ${word[d]} but the 1-hour chart is moving ${word[against]}${m === against ? ' and so is the 15-minute chart' : ', and the 15-minute chart has not ' + turn + ' yet'}. Triple-screen traders wait for the 15-minute chart to turn before acting.` };
  return { id: 'pause', dir: 0, title: `Daily ${trend}, quiet short-term`, text: `The daily chart points ${word[d]}; the 1-hour chart is flat and the 15-minute chart ${m === 'side' ? 'too' : 'is moving ' + word[m]}.` };
}

// ---------- how often was it right? ----------
// For every pattern: was the close `ahead` bars later on the pattern's side? [times right, times seen] per pattern
// and direction. up = how often any bar was followed by a higher close (the base rate to compare against).
// call = the timeframe's own up/down reading, sampled every `ahead` bars so the samples do not overlap.
export function hitRates(st) {
  const a = TFS[st.tf].ahead, c = st.c, N = st.done, pat = {}, all = [0, 0], call = [0, 0];
  let up = 0, tot = 0;
  for (let i = WARM; i + a < N; i++) { if (st.S[i] == null || c[i + a] === c[i]) continue; tot++; if (c[i + a] > c[i]) up++; }
  for (const e of st.events) {
    if (e.i + a >= N || c[e.i + a] === c[e.i]) continue;
    const r = (pat[e.id + (e.dir > 0 ? '+' : '-')] ||= [0, 0]), ok = (c[e.i + a] > c[e.i]) === (e.dir > 0);
    r[1]++; all[1]++; if (ok) { r[0]++; all[0]++; }
  }
  for (let i = WARM; i + a < N; i += a) {
    const s = st.S[i]; if (s == null || Math.abs(s) < CALL || c[i + a] === c[i]) continue;
    call[1]++; if ((c[i + a] > c[i]) === (s > 0)) call[0]++;
  }
  return { bars: N, n: tot, up: tot ? round(up / tot, 3) : null, pat, all, call };
}
// The combined reading replayed at each daily close: did the next close (d1) and the close three sessions on (d3)
// go its way? Needs intraday history, so it covers only the days the 15-minute bars reach back to.
export function alignBacktest(b15, b1h, bd, s15, s1h, sd) {
  const d1 = [0, 0], d3 = [0, 0]; let days = 0, i15 = -1, i1h = -1;
  for (let di = 0; di < sd.done; di++) {
    const cut = bd[di].t; // daily bars are stamped 22:00 UTC, after every close used here
    while (i15 + 1 < b15.length && b15[i15 + 1].t + TFS['15m'].ms <= cut) i15++;
    while (i1h + 1 < b1h.length && b1h[i1h + 1].t + TFS['1h'].ms <= cut) i1h++;
    if (i15 < 0 || i1h < 0 || cut - b15[i15].t > 864e5 || cut - b1h[i1h].t > 864e5) continue; // no intraday bars that day
    const A = sd.S[di] == null || s1h.S[i1h] == null || s15.S[i15] == null ? null : alignScore({ '1d': sd.S[di], '1h': s1h.S[i1h], '15m': s15.S[i15] });
    if (A == null) continue;
    days++;
    if (Math.abs(A) < CALL) continue;
    for (const [hz, r] of [[1, d1], [3, d3]]) {
      if (di + hz >= sd.done || bd[di + hz].c === bd[di].c) continue;
      r[1]++; if ((bd[di + hz].c > bd[di].c) === (A > 0)) r[0]++;
    }
  }
  return { days, d1, d3 };
}
// Running count since launch: each pattern is counted once, when the bar that scores it has closed.
// live = { since, upTo: { tf: time of the last pattern counted }, pat: { tf: { 'id+': [right, seen] } } }
export function tally(live, studies, bars, nowIso) {
  const out = live && live.upTo ? live : { since: nowIso, upTo: {}, pat: {} };
  for (const tfKey of TF_ORDER) {
    const st = studies[tfKey], b = bars[tfKey]; if (!st || !b?.length) continue;
    if (out.upTo[tfKey] == null) { out.upTo[tfKey] = b[Math.max(0, st.done - 1)].t; continue; } // first sight: count from here on
    const a = TFS[tfKey].ahead, tbl = (out.pat[tfKey] ||= {}), from = out.upTo[tfKey];
    for (const e of st.events) {
      if (e.t <= from) continue;
      if (e.i + a >= st.done) break; // not scorable yet, and neither is anything after it
      out.upTo[tfKey] = e.t;         // patterns on the same bar become scorable together
      if (st.c[e.i + a] === st.c[e.i]) continue;
      const r = (tbl[e.id + (e.dir > 0 ? '+' : '-')] ||= [0, 0]);
      r[1]++; if ((st.c[e.i + a] > st.c[e.i]) === (e.dir > 0)) r[0]++;
    }
  }
  return out;
}

// ---------- everything for one market ----------
// b15: 15-minute bars; daily: daily bars; now: the time of this build. offset1h shifts the hourly buckets (30 minutes for US shares).
export function analyse({ b15, daily, now, formingDay = true, offset1h = 0 }) {
  const bars = { '15m': b15, '1h': aggregate(b15, TFS['1h'].ms, offset1h), '1d': daily };
  const open = (k) => bars[k].length > 0 && now < bars[k].at(-1).t + TFS[k].ms; // is the last bar still moving?
  const forming = { '15m': open('15m'), '1h': open('1h'), '1d': formingDay };
  const studies = {}, tfs = {};
  for (const k of TF_ORDER) { studies[k] = study(bars[k], k, { forming: forming[k] }); tfs[k] = snapshot(studies[k], bars[k]); tfs[k].text = describe(tfs[k]); }
  const v = verdict(tfs);
  const score = alignScore(Object.fromEntries(TF_ORDER.map((k) => [k, tfs[k].ready ? tfs[k].score : null])));
  return { bars, studies, tfs, verdict: v, score: round(score ?? 0, 3), ready: TF_ORDER.filter((k) => tfs[k].ready) };
}
