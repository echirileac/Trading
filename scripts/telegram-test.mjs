// Telegram setup helper, run by the "Telegram test" workflow (Actions tab -> Telegram test -> Run workflow).
// - Only TELEGRAM_BOT_TOKEN set: replies to everyone who has messaged the bot with their own chat ID, inside
//   Telegram (the ID never appears in this public log). Add that number as the TELEGRAM_CHAT_ID secret.
// - Both secrets set: sends a test message to TELEGRAM_CHAT_ID.
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT = process.env.TELEGRAM_CHAT_ID || '';
const API = process.env.TELEGRAM_API || 'https://api.telegram.org';
const SITE = process.env.SITE_URL || 'https://echirileac.github.io/Trading/';
const hide = (s) => (TOKEN ? String(s).split(TOKEN).join('***') : String(s));
async function tg(method, body) {
  const r = await fetch(`${API}/bot${TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(`${method}: HTTP ${r.status} ${j.description || ''}`.trim());
  return j.result;
}
const fail = (msg) => { console.log(`::error title=Telegram test::${hide(msg)}`); process.exit(1); };
if (!TOKEN) fail('TELEGRAM_BOT_TOKEN is not set. Add it under Settings -> Secrets and variables -> Actions -> New repository secret.');
let me;
try { me = await tg('getMe'); } catch (e) { fail(`The bot token was refused (${e.message}). Copy it again from @BotFather.`); }
console.log(`Bot: @${me.username}`);
if (!CHAT) {
  let updates = [];
  try { updates = await tg('getUpdates', { limit: 100, allowed_updates: ['message'] }); }
  catch (e) { fail(`Could not read the bot's messages (${e.message}). If another program is running this bot, stop it for a minute and run this again.`); }
  const chats = new Map();
  for (const u of updates) { const c = u.message?.chat; if (c && c.type === 'private') chats.set(c.id, c); }
  if (!chats.size) fail(`No messages found. Open @${me.username} in Telegram, press Start (or send "hi"), then run this workflow again.`);
  for (const c of chats.values()) await tg('sendMessage', { chat_id: c.id, text: `Your chat ID is ${c.id}\n\nIn GitHub add it as the repository secret TELEGRAM_CHAT_ID, then run "Telegram test" again.` });
  console.log(`::notice title=Telegram test::Sent the chat ID by Telegram to ${chats.size} chat(s) that messaged @${me.username}. Add it as TELEGRAM_CHAT_ID and run this again.`);
  process.exit(0);
}
try {
  await tg('sendMessage', { chat_id: CHAT, parse_mode: 'HTML', disable_web_page_preview: true,
    text: `✅ <b>Trading site alerts are connected.</b>\n\nYou will get unusual moves, key level breaks, model lean flips, AI analyst stance changes and reminders before reports, usually within 5 minutes.\n<a href="${SITE}">Open the site</a>` });
} catch (e) {
  fail(/chat not found/i.test(e.message) ? `Telegram says "chat not found": check TELEGRAM_CHAT_ID, and press Start in @${me.username} first.`
    : /blocked/i.test(e.message) ? `You blocked @${me.username} in Telegram: unblock it and run this again.` : e.message);
}
console.log(`::notice title=Telegram test::Test message sent through @${me.username}. Alerts will now go to Telegram.`);
