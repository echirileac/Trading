// Checks for mtf.mjs on hand-built bars. Run: node --test scripts/mtf.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from './mtf.mjs';

const H = 36e5;
// a bar series from closes; open = previous close, wicks = 0.1 beyond the body unless given
function mk(closes, tfMs = H, wick = 0.1) {
  return closes.map((c, i) => { const o = i ? closes[i - 1] : c; return { t: Date.UTC(2026, 0, 5) + i * tfMs, o, h: Math.max(o, c) + wick, l: Math.min(o, c) - wick, c }; });
}
const rise = (n, from = 100, step = 0.5, wobble = 0.8) => Array.from({ length: n }, (_, i) => from + i * step + Math.sin(i / 2.3) * wobble);
const fall = (n, from = 200, step = 0.5, wobble = 0.8) => Array.from({ length: n }, (_, i) => from - i * step + Math.sin(i / 2.3) * wobble);
const has = (st, id, dir, at) => st.events.some((e) => e.id === id && e.dir === dir && (at == null || e.i === at));

test('steady rise reads up, steady fall reads down, flat noise reads sideways', () => {
  const up = M.study(mk(rise(140)), '1h'), dn = M.study(mk(fall(140)), '1h');
  assert.equal(M.labelOf(up.S.at(-1)), 'up'); assert.equal(M.labelOf(dn.S.at(-1)), 'down');
  // a tight range has no lasting direction: up and down readings balance out and neither dominates
  const flat = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i * 1.7) * 0.6 + Math.cos(i * 0.9) * 0.4);
  const S = M.study(mk(flat), '1h').S.filter((v) => v != null), ups = S.filter((v) => v >= 0.25).length / S.length, dns = S.filter((v) => v <= -0.25).length / S.length;
  assert.ok(ups < 0.45 && dns < 0.45 && Math.abs(ups - dns) < 0.1, `range: ${ups.toFixed(2)} up, ${dns.toFixed(2)} down`);
});

test('nothing is read before 55 bars', () => {
  const st = M.study(mk(rise(54)), '1h');
  assert.ok(st.S.every((v) => v == null)); assert.equal(M.snapshot(st, mk(rise(54))).ready, false);
  assert.notEqual(M.study(mk(rise(56)), '1h').S.at(-1), null);
});

test('every value is causal: adding later bars never changes an earlier score or pattern', () => {
  let p = 100, seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const closes = Array.from({ length: 400 }, () => (p *= 1 + (rnd() - 0.5) * 0.02));
  const bars = mk(closes).map((b) => ({ ...b, h: b.h + rnd() * 0.5, l: b.l - rnd() * 0.5 }));
  const full = M.study(bars, '1h');
  for (const cut of [120, 200, 310]) {
    const part = M.study(bars.slice(0, cut), '1h');
    for (let i = 0; i < cut; i++) assert.equal(part.S[i], full.S[i], `score at ${i} with ${cut} bars`);
    assert.deepEqual(part.events, full.events.filter((e) => e.i < cut));
  }
  assert.ok(full.events.length > 20, 'the random walk produced patterns: ' + full.events.length);
});

test('a forming last bar never produces a pattern', () => {
  const closes = fall(80, 200, 0.6, 0.2); const bars = mk(closes);
  const i = bars.length - 1; // make the last bar a big bullish engulfing bar
  bars[i - 1] = { ...bars[i - 1], o: bars[i - 2].c, c: bars[i - 2].c - 1, h: bars[i - 2].c + 0.05, l: bars[i - 2].c - 1.05 };
  bars[i] = { ...bars[i], o: bars[i - 1].c, c: bars[i - 1].o + 1.5, h: bars[i - 1].o + 1.6, l: bars[i - 1].c - 0.05 };
  assert.ok(has(M.study(bars, '1h'), 'engulf', 1, i), 'completed bar: engulfing found');
  assert.ok(!has(M.study(bars, '1h', { forming: true }), 'engulf', 1, i), 'forming bar: not counted');
});

test('hammer after a slide, shooting star after a climb', () => {
  const d = mk(fall(80, 200, 0.6, 0.2)); let i = d.length - 1;
  d[i] = { ...d[i], o: d[i - 1].c, c: d[i - 1].c + 0.1, h: d[i - 1].c + 0.2, l: d[i - 1].c - 3 };
  assert.ok(has(M.study(d, '1h'), 'pin', 1, i));
  const u = mk(rise(80, 100, 0.6, 0.2)); i = u.length - 1;
  u[i] = { ...u[i], o: u[i - 1].c, c: u[i - 1].c - 0.1, l: u[i - 1].c - 0.2, h: u[i - 1].c + 3 };
  assert.ok(has(M.study(u, '1h'), 'pin', -1, i));
});

test('breakout fires once, on the first close beyond the last 20 bars', () => {
  const closes = [...Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 2) * 1.2), 103, 104, 105];
  const st = M.study(mk(closes), '1h');
  assert.ok(has(st, 'breakout', 1, 80)); assert.ok(!has(st, 'breakout', 1, 81)); assert.ok(!has(st, 'breakout', 1, 82));
});

test('double bottom is confirmed by the close above the middle peak, not before', () => {
  // slide to 80, bounce to 90, back to 80.3, then up through 90
  const seg = (a, b, n) => Array.from({ length: n }, (_, i) => a + (b - a) * (i + 1) / n);
  const closes = [...seg(120, 100, 60), ...seg(100, 80, 12), ...seg(80, 90, 8), ...seg(90, 80.3, 8), ...seg(80.3, 89, 6), 91.5, 92, 93];
  const st = M.study(mk(closes, H, 0.3), '1h');
  const e = st.events.find((x) => x.id === 'double' && x.dir === 1);
  assert.ok(e, 'double bottom found: ' + JSON.stringify(st.events.map((x) => [x.i, x.id, x.dir])));
  assert.ok(closes[e.i] > 90 && closes[e.i - 1] <= 90.4, 'fires on the bar that closes above the neckline');
  assert.equal(st.events.filter((x) => x.id === 'double' && x.dir === 1).length, 1, 'once per formation');
});

test('head and shoulders top is confirmed below the neckline', () => {
  const seg = (a, b, n) => Array.from({ length: n }, (_, i) => a + (b - a) * (i + 1) / n);
  const closes = [...seg(60, 100, 60), ...seg(100, 110, 6), ...seg(110, 104, 5), ...seg(104, 118, 7), ...seg(118, 104.5, 7), ...seg(104.5, 110.5, 6), ...seg(110.5, 105, 5), 102, 100, 99];
  const st = M.study(mk(closes, H, 0.3), '1h');
  assert.ok(st.events.some((x) => x.id === 'hs' && x.dir === -1), JSON.stringify(st.events.map((x) => [x.i, x.id, x.dir])));
});

test('bars from samples: wicks from session extremes, open = previous close, gaps do not invent bars', () => {
  const t0 = Date.UTC(2026, 10, 12, 14, 0), m = 60e3;
  const s = [
    { t: t0 + 1 * m, c: 3.30, h: 3.35, l: 3.20 }, { t: t0 + 6 * m, c: 3.31, h: 3.35, l: 3.20 }, { t: t0 + 12 * m, c: 3.29, h: 3.35, l: 3.20 },
    { t: t0 + 16 * m, c: 3.32, h: 3.36, l: 3.20 },   // session high moved 3.35 -> 3.36 since the last sample: wick on the 14:15 bar
    { t: t0 + 29 * m, c: 3.33, h: 3.36, l: 3.20 },
    { t: t0 + 61 * m, c: 3.34, h: 3.36, l: 3.20 }    // 15:00 bar after a gap
  ];
  const b = M.barsFromSamples(s);
  assert.equal(b.length, 3);
  assert.deepEqual([b[0].o, b[0].h, b[0].l, b[0].c], [3.30, 3.31, 3.29, 3.29]);
  assert.deepEqual([b[1].o, b[1].h, b[1].l, b[1].c], [3.29, 3.36, 3.29, 3.33]);
  assert.equal(b[2].o, 3.34, 'after a gap the bar opens at its own first sample');
  const hour = M.aggregate(b, H);
  assert.equal(hour.length, 2); assert.deepEqual([hour[0].o, hour[0].h, hour[0].l, hour[0].c], [3.30, 3.36, 3.29, 3.33]);
  const us = M.aggregate([{ t: Date.UTC(2026, 10, 12, 14, 30), o: 1, h: 2, l: 1, c: 2 }, { t: Date.UTC(2026, 10, 12, 15, 15), o: 2, h: 3, l: 2, c: 3 }, { t: Date.UTC(2026, 10, 12, 15, 30), o: 3, h: 4, l: 3, c: 4 }], H, 30 * m);
  assert.equal(us.length, 2, 'US shares: hours run from half past'); assert.equal(us[0].c, 3);
});

test('exchange candles are continued by newer samples', () => {
  const t = Date.UTC(2026, 10, 12, 15, 0), q = 15 * 60e3;
  const base = [{ t, o: 10, h: 11, l: 9, c: 10.5 }, { t: t + q, o: 10.5, h: 10.8, l: 10.4, c: 10.6 }];
  const live = [{ t: t + q, o: 10.7, h: 11.2, l: 10.7, c: 11.1 }, { t: t + 2 * q, o: 11.1, h: 11.3, l: 11, c: 11.2 }];
  const m = M.mergeBars(base, live);
  assert.equal(m.length, 3); assert.deepEqual(m[1], { t: t + q, o: 10.5, h: 11.2, l: 10.4, c: 11.1 }); assert.equal(base[1].c, 10.6, 'input untouched');
});

test('verdicts', () => {
  const sn = (d, h, m) => ({ '1d': { ready: true, label: d }, '1h': { ready: true, label: h }, '15m': { ready: true, label: m } });
  assert.equal(M.verdict(sn('up', 'up', 'up')).id, 'aligned'); assert.equal(M.verdict(sn('down', 'down', 'down')).dir, -1);
  const setup = M.verdict(sn('up', 'down', 'up')); assert.equal(setup.id, 'setup'); assert.equal(setup.dir, 1); assert.match(setup.title, /Pullback buy setup/);
  assert.match(M.verdict(sn('down', 'side', 'down')).title, /Bounce sell setup/);
  const pb = M.verdict(sn('up', 'down', 'down')); assert.equal(pb.id, 'pullback'); assert.equal(pb.dir, 0);
  assert.equal(M.verdict(sn('side', 'up', 'down')).id, 'mixed'); assert.equal(M.verdict(sn('side', 'down', 'down')).dir, -1);
  assert.equal(M.verdict({ '1d': { ready: true, label: 'up' }, '1h': { ready: false }, '15m': { ready: false } }).id, 'partial');
  assert.equal(M.verdict({}).id, 'none');
  assert.equal(M.alignScore({ '1d': 1, '1h': null, '15m': null }), 1); assert.ok(Math.abs(M.alignScore({ '1d': 1, '1h': -1, '15m': -1 }) - (-0.1)) < 1e-9);
});

test('hit rates count a pattern only when the scoring bar exists, and tallies count each pattern once', () => {
  let p = 100, seed = 3; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const closes = Array.from({ length: 600 }, () => (p *= 1 + (rnd() - 0.5) * 0.02));
  const bars = mk(closes).map((b) => ({ ...b, h: b.h + rnd() * 0.5, l: b.l - rnd() * 0.5 }));
  const st = M.study(bars, '1h'), r = M.hitRates(st);
  const scorable = st.events.filter((e) => e.i + 4 < st.done && st.c[e.i + 4] !== st.c[e.i]).length;
  assert.equal(r.all[1], scorable); assert.equal(Object.values(r.pat).reduce((s, x) => s + x[1], 0), scorable);
  assert.ok(r.all[0] <= r.all[1] && r.up > 0.3 && r.up < 0.7);
  // tally: start at bar 300, then feed the history in steps; the total must equal the patterns after bar 300 that could be scored
  let live = null;
  for (const n of [300, 301, 350, 351, 480, 600]) { const s = M.study(bars.slice(0, n), '1h'); live = M.tally(live, { '1h': s }, { '1h': bars.slice(0, n) }, 'x'); }
  const want = st.events.filter((e) => e.i > 299 && e.i + 4 < 600 && st.c[e.i + 4] !== st.c[e.i]).length;
  assert.equal(Object.values(live.pat['1h']).reduce((s, x) => s + x[1], 0), want);
});
