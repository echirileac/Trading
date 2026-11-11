// Applies a watchlist change requested through a GitHub issue opened from the site.
// Title: "watchlist: add <SYMBOL>" or "watchlist: remove <ID>"; body contains a ```json``` block.
import { readFile, writeFile, appendFile } from 'node:fs/promises';

const MAX = 8;
const CATS = ['energy', 'metal', 'fx', 'crypto', 'equity', 'etf', 'index'];
const out = async (msg, ok) => {
  console.log(msg);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `message<<EOF\n${msg}\nEOF\nchanged=${ok ? 'true' : 'false'}\n`);
};

const CCY = { EUR: 'euro', USD: 'dollar', GBP: 'pound', JPY: 'yen', CHF: 'franc', AUD: 'Australian dollar', NZD: 'New Zealand dollar', CAD: 'Canadian dollar', RON: 'leu', PLN: 'zloty', HUF: 'forint', CNY: 'yuan', TRY: 'lira', SEK: 'krona', NOK: 'krone', MXN: 'peso', ZAR: 'rand' };
const METAL = { XAU: 'gold', XAG: 'silver', XPT: 'platinum', XPD: 'palladium', HG1: 'copper', GAU: 'gold' };
const ENERGY = { 'WTI/USD': ['crude oil', 'WTI', 'oil prices'], 'BRENT/USD': ['Brent', 'oil prices', 'crude'], 'URALS/USD': ['Urals', 'Russian oil'], 'XBR/USD': ['Brent', 'oil prices'], 'XTI/USD': ['crude oil', 'WTI'] };
const COIN = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'XRP', ADA: 'cardano', DOGE: 'dogecoin', BNB: 'BNB', LTC: 'litecoin' };

function newsSetup(m) {
  const [b, q] = m.symbol.split('/');
  const clean = m.name.replace(/\b(Inc|Corp|Corporation|Ltd|PLC|plc|N\.V|S\.A|AG|SE|Class [A-C]|Common Stock|Ordinary Shares|Spot|Holdings?)\b\.?/g, '').replace(/[.,]+/g, ' ').replace(/\s+/g, ' ').trim();
  switch (m.category) {
    case 'fx': return { newsQuery: `${b}/${q}`, keywords: [`${b}/${q}`, `${b}${q}`, CCY[b], CCY[q]].filter(Boolean) };
    case 'metal': { const w = METAL[b] || clean.split(' ')[0].toLowerCase(); return { newsQuery: `${w} price`, keywords: [w, b] }; }
    case 'energy': { const e = ENERGY[m.symbol] || [clean, b]; return { newsQuery: e[e.length > 2 ? 2 : 0], keywords: e.slice(0, 2) }; }
    case 'crypto': { const w = COIN[b] || clean; return { newsQuery: w, keywords: [w, b] }; }
    case 'index': return { newsQuery: clean, keywords: [clean.split(' ').slice(0, 2).join(' '), m.symbol] };
    default: return { newsQuery: `${clean} stock`, keywords: [clean.split(' ').slice(0, 2).join(' '), m.symbol] };
  }
}

// Asks Twelve Data for a quote with the site's own key. Returns the reason when the plan does not cover the listing, '' otherwise
// (also '' when there is no key or no answer: an add is never blocked by a network problem).
async function planProblem(symbol, exchange) {
  const key = process.env.TWELVE_DATA_KEY;
  if (!key) return '';
  try {
    const u = new URL('https://api.twelvedata.com/quote');
    u.searchParams.set('symbol', symbol); if (exchange) u.searchParams.set('exchange', exchange); u.searchParams.set('apikey', key);
    const j = await (await fetch(u, { signal: AbortSignal.timeout(15000) })).json();
    const msg = String(j?.message || '');
    return j?.status === 'error' && /plan|upgrad|pricing/i.test(msg) ? msg.replace(/\s*Consider upgrading.*$/i, '').slice(0, 140) : '';
  } catch { return ''; }
}

async function main() {
  const title = String(process.env.ISSUE_TITLE || '');
  const body = String(process.env.ISSUE_BODY || '');
  const action = (title.match(/^watchlist:\s*(add|remove)\b/i) || [])[1]?.toLowerCase();
  if (!action) return out('Not a watchlist request (title must start with "watchlist: add" or "watchlist: remove").', false);
  let req = {};
  try { req = JSON.parse((body.match(/```json\s*([\s\S]*?)```/) || [])[1] || '{}'); } catch { return out('Could not read the request details (the JSON block was changed).', false); }

  const file = new URL('../watchlist.json', import.meta.url);
  const wl = JSON.parse(await readFile(file, 'utf8'));
  wl.markets = wl.markets || [];

  if (action === 'remove') {
    const id = String(req.id || title.replace(/^watchlist:\s*remove\s*/i, '')).trim();
    if (id === 'NATGAS') return out('NATGAS is built in and stays on the site.', false);
    const before = wl.markets.length;
    wl.markets = wl.markets.filter((m) => m.id !== id);
    if (wl.markets.length === before) return out(`${id} is not on the watchlist.`, false);
    await writeFile(file, JSON.stringify(wl, null, 2) + '\n');
    return out(`Removed ${id} from the watchlist. The site updates in about 2 minutes.`, true);
  }

  const symbol = String(req.symbol || '').trim();
  if (!/^[A-Za-z0-9.\/^=\-]{1,24}$/.test(symbol)) return out('That symbol does not look valid.', false);
  const category = CATS.includes(req.category) ? req.category : 'equity';
  const exchange = String(req.exchange || '').replace(/[^A-Za-z0-9 _\-]/g, '').slice(0, 30);
  const name = String(req.name || symbol).replace(/[<>`]/g, '').slice(0, 80);
  const id = (symbol + (['equity', 'etf', 'index'].includes(category) && exchange ? '-' + exchange : '')).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toUpperCase();
  if (wl.markets.some((m) => m.id === id)) return out(`${name} (${symbol}) is already on the watchlist.`, false);
  if (wl.markets.length >= MAX) return out(`The watchlist already has ${MAX} markets, the most the free Twelve Data plan can refresh. Remove one first.`, false);
  const blocked = await planProblem(symbol, ['equity', 'etf'].includes(category) ? exchange : '');
  if (blocked) return out(`${name} (${symbol}${exchange ? ' on ' + exchange : ''}) was not added: this listing is not in the free Twelve Data plan (${blocked}). Search again and pick the US listing (NASDAQ or NYSE), which is free.`, false);
  const m = { id, symbol, name, category, exchange, type: String(req.type || '').slice(0, 40), provider: 'twelvedata', ...newsSetup({ symbol, name, category }) };
  wl.markets.push(m);
  await writeFile(file, JSON.stringify(wl, null, 2) + '\n');
  return out(`Added ${name} (${symbol}) to the watchlist. Prices, forecast and news appear on the site in about 2 minutes.`, true);
}
main().catch((e) => out(`Something went wrong: ${e.message}`, false));
