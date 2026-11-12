# Market watch: live CFD outlooks

A free, self-updating web page for Henry Hub natural gas (the NATGAS CFD's underlying): live front-month price, 1 / 3 / 5-day forecast ranges, the signals behind them, and the latest headlines from trusted outlets.

- **Hosting:** GitHub Pages (free).
- **Server refresh:** GitHub Actions about every minute — NATGAS and Brent prices every run, stock quotes every 10–15 minutes (free Twelve Data plan), news about every 15 minutes.
- **Page refresh:** the open page checks for new data every minute.
- **Forecast:** a transparent rules-based model (volatility ranges + news sentiment + trend, momentum and RSI). See "How the forecast works" on the page.

## Set up (about 5 minutes)

1. Create a **public** repository on GitHub (e.g. `natgas-live`). It must be public: scheduled Actions are free and unlimited only on public repos.
2. Upload everything in this folder to it (keep the folder structure, including `.github/workflows/update.yml`).
   - Web: on the repo page choose **Add file → Upload files**, drag the folder contents in, commit.
   - Or command line: `git init && git add . && git commit -m "NATGAS live" && git branch -M main && git remote add origin https://github.com/echirileac/Trading.git && git push -u origin main`
3. In the repo go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
4. Go to **Actions**, open **Update NATGAS forecast**, click **Run workflow**. After ~1 minute the page is live at `https://echirileac.github.io/Trading/`.

From then on it refreshes itself about every minute.

## Watchlist: any market (added November 2026)

- NATGAS is built in. Add up to 8 more markets (stocks, ETFs, indices, forex, crypto, metals, oil) from the page: **+ Add market** → search → **Add**. That opens a pre-filled GitHub issue; press **Create** and the `Watchlist change` workflow updates `watchlist.json`, rebuilds the site and closes the issue (about 2 minutes). Only the repository owner's requests are applied.
- Remove a market with the **Remove** button next to its name (same GitHub flow), or edit `watchlist.json` directly.
- Prices for these markets come from **Twelve Data**. Add your free API key once: GitHub repo → Settings → Secrets and variables → Actions → **New repository secret**, name `TWELVE_DATA_KEY`.
- Free plan limits (800 requests/day, 8/minute) mean live quotes refresh every 10–15 minutes depending on how many markets you watch; daily history is fetched once a day.
- The free plan covers US listings, forex and crypto. Listings on other exchanges (for example a US stock's Swiss or German line) and some indices need a paid plan: the search marks them "Paid data plan" and the watchlist job refuses them. Pick the NASDAQ or NYSE listing instead.

## Pro chart and AI analyst (added November 2026)

- **Live chart (default view):** TradingView's free Advanced Chart widget, loaded from tradingview.com with its own data, so it needs no key and has no request limit. Real candles on every timeframe, volume, 100+ indicators, drawing tools. Forex and crypto are real-time, stocks are delayed. Commodities and indices use CFD symbols (NATGAS: `OANDA:NATGASUSD`, Brent: `TVC:UKOIL`) because exchange futures are not in the free widget. The symbol is worked out from each market; set `"tv": "EXCHANGE:SYMBOL"` on a market in `watchlist.json` to fix it for everyone, or type one under the chart to change it in your own browser.
- **Forecast view:** daily candlesticks (TradingView Lightweight Charts, bundled in `site/vendor`), 1M/3M/6M/1Y, zoom and pan, toggles for 20/50/200-day averages, Bollinger bands, the model's forecast lines, and RSI / MACD panels. Your choices are remembered per browser.
- **AI analyst:** each market's indicators, key levels, quant forecast and latest trusted news (with what was read in full) go to an AI model, which writes a short note: stance, summary, chart and news bullets, levels to watch, 1/3/5-day outlook, what would change the view, risks. The note says which model wrote it.
  - **Free:** a Groq key (console.groq.com → API keys, no card needed) saved as repository secret `GROQ_API_KEY`. Uses `openai/gpt-oss-120b`, then `openai/gpt-oss-20b` (free plan: about 1,000 requests and 200K tokens a day per model, 8K tokens a minute). GitHub Models is not used: GitHub retired it on 2026-07-30.
  - **Paid upgrade (optional):** repository secret `ANTHROPIC_API_KEY` puts Claude (`AI_MODEL`, default `claude-sonnet-5-5`) first in line; about 1 cent per note.
  - Cadence: about every hour per market while it trades (6 hours when closed), sooner after a 1.5% move, at most 1 note per refresh. Change with repository variables `AI_EVERY_MIN`, `AI_PROVIDERS` (order, default `anthropic,groq`; a provider without a key is skipped), `GROQ_MODELS`.
  - A model that hits its limit is skipped until the next refresh; if every option is exhausted the page keeps showing the previous note.
- **AI news scoring for stocks:** the keyword lists are tuned for commodities, so for stocks and ETFs each new headline is read once by a free Groq model (`openai/gpt-oss-20b`, then `openai/gpt-oss-120b`; the analyst note starts on 120b and each model has its own free daily allowance; Groq's Llama models left the free plan on 16 Aug 2026). It marks stories that are not really about the company (left out of the forecast) and rates the rest from -2 to +2 for the next 1-5 sessions, with a short reason shown under each story. That rating is 75% of the story's score, the keyword score of the article text 25%. Scores are cached per headline, so only new headlines are sent, one batch per stock per news refresh (at most 6 requests per build). Uses the same `GROQ_API_KEY`; without it, or if Groq fails, keyword scoring is used and it retries at the next news refresh. Repository variables: `NEWS_AI_MODELS`, `NEWS_AI_CATEGORIES` (default `equity,etf`; add e.g. `energy,metal` to extend it).

## Alerts and Telegram (added November 2026)

Every build compares the new data with the previous build and records alerts in a **Recent alerts** card on each market page (last 7 days). Each alert fires once:

- **Unusual move:** today's change is beyond the range that holds on about 90% of days for that market (and a second, "very large" level at 3 standard deviations). One per day and direction.
- **Key level break:** the price moves clearly through the 50- or 200-day average, or above the previous 20-session high / below the 20-session low. A level that moves past a still price does not count; the same level waits 6 hours before alerting again.
- **Model lean flip:** the forecast lean changes between bullish and bearish (passing through Neutral is not a flip; at most one flip alert per 2 hours).
- **AI analyst stance change** in a new note.
- **Scheduled reports:** EIA storage and oil reports, Fed decisions, US inflation (CPI) and jobs reports an hour before; earnings dates from the evening before. A report shared by several markets is one message.

The first build after this was added only records the current state, so nothing old is sent.

**Get them on Telegram (free):**
1. In Telegram, message **@BotFather**, send `/newbot`, pick a name, and copy the token it gives you (or reuse the token of your existing alert bot).
2. Open your new bot and press **Start** (send it any message).
3. In a browser open `https://api.telegram.org/bot<TOKEN>/getUpdates` (your token in place of `<TOKEN>`) and find `"chat":{"id":` followed by a number: that is your chat id.
4. In the repository: **Settings → Secrets and variables → Actions → New repository secret**: `TELEGRAM_BOT_TOKEN` = the token, `TELEGRAM_CHAT_ID` = the number.

Alerts then arrive within about a minute or two of happening, with a link to the market. Optional repository **variables**: `ALERT_TYPES` (default `move,level,flip,analyst,event`), `ALERT_MARKETS` (e.g. `NATGAS,BRENT`; default all), `ALERT_QUIET_HOURS` (e.g. `23-7`: sent without sound during those hours, Bucharest time), `ALERT_EVENT_LEAD_MIN` (default 60), `ALERT_TZ` (default `Europe/Bucharest`). The site only sends messages, so the same bot can also run the separate alert bot.

## Trading calendars (added November 2026)

Forecast target dates and the track record count real trading sessions. Weekends are skipped, and so are exchange holidays: the NYSE calendar (including Good Friday and the Saturday/Sunday observance rules) for stocks, ETFs and natural gas, whose CME settlements follow the same days; ICE closures (New Year's Day, Good Friday, Christmas) for Brent; none for currencies, spot metals and crypto. Checked against NYSE's published 2026-2028 calendar. Half-days (the day after Thanksgiving, Christmas Eve) count as normal sessions.

## Risk helper (added November 2026)

A card on each market page works out a position size so that hitting the stop costs a chosen share of your account. Everything runs in your browser; your inputs are remembered there and never sent anywhere.

- **Inputs:** account balance and currency (RON, EUR or USD; the USD rate is the ECB reference rate from frankfurter.dev, or type your own), risk per trade in %, buy or sell, entry (live price by default) and stop: 1, 1.5, 2 or 3 × the 14-session ATR (average daily range), the edge of the 1-day 90% range, or your own price.
- **Output:** size in lots (XTB steps of 0.01) or shares, the loss at the stop, the stop price, and the margin XTB asks of retail clients (10% commodities, 20% stock CFDs, 5% indices and gold, 3.33-5% currencies, 50% crypto). It also says how often a daily close moves that far against you, the model's expected move as a multiple of the risk, and warns about reports before the next close.
- **Lot sizes:** stock CFDs are 1 share per lot. NATGAS is confirmed from xStation (12 Nov 2026): 30,000 MMBtu per lot, minimum 0.005 lot, maximum 95, leverage 1:10, with its daily swap (long −0.042833%, short −0.021056% of the position value) shown as an overnight cost, and a warning before XTB's monthly rollover (next: 20 Nov 2026). Swaps and rollover dates change: update `XTB` in `site/index.html`. Other commodities (OIL: 100 barrels assumed) ask you to confirm in xStation (instrument → Specification → nominal value of 1 lot), because brokers differ by up to 30× here. Type your own value to change it.
- Not included: spread, overnight costs, gaps past the stop.

## Track record (added November 2026)

- **Published log:** once per trading day, just after the close (16:15 New York for stocks, 17:00 for NATGAS and Brent, 17:15 for currencies and metals, 00:00 UTC for crypto), the build writes down that market's 1, 3 and 5-day forecasts. Each is scored against the actual close 1, 3 or 5 sessions later. The page shows, per horizon: how often the direction was right, how often the close landed inside the 68% and 90% ranges, and the average miss compared with assuming no change.
- **Backtest:** the same price signals (trend, momentum, RSI, volatility) replayed on the stored daily history, without news. It shows straight away whether the ranges are sized right; it says nothing about the news reading.
- The log lives on the site itself (`site/data/h/<market>.json`), like the price history. Each build reads it back from the live site first. If it cannot be read, that build is **not deployed** (the run shows as failed, the site keeps its previous data and the next refresh retries), so the log is never overwritten with an empty one.
- A market that fails to build on a run now keeps its previous page data and log instead of dropping them.
- Removing a market from the watchlist ends its log.

## Overview table (added November 2026)

"All markets at a glance" under the watchlist: price, today's change, the model's lean and likely range for the selected horizon, the AI analyst's stance, RSI and the next scheduled event, one row per market. Click a row to open the market, click a column name to sort. A market is marked "Disagrees with model" when the analyst and the quant model point in opposite directions; the same warning appears on that market's analyst card.

## Events (added November 2026)

- Each market lists the scheduled releases of the next 9 days: the EIA natural gas storage report (Thursday 10:30 New York) for NATGAS, EIA oil inventories (Wednesday 10:30) for oil, Fed decision days (list `FOMC_DAYS` in `scripts/update.mjs`, update it once a year from federalreserve.gov), US inflation (CPI) and jobs report days for every market except natural gas (lists `CPI_DAYS` and `JOBS_DAYS`, from bls.gov/schedule; the build log warns a month before any of these lists runs out), and the next earnings date for US stocks (Nasdaq public data, once a day, best effort: it shows under Data sources whether the lookup worked).
- A forecast whose target close comes after one of these shows a notice, and the AI analyst is told about them.
- Ranges are not widened for events: on the past year's closes the EIA report days were not more volatile than other days, and there is no earnings history to measure yet.
- "Events and economic calendar" at the bottom of the page also embeds TradingView's free economic calendar.

## Calibration (November 2026)

Checked against the backtest on the five markets then on the watchlist (about 980 forecasts per horizon):
- **Likely range (68%)** held 69-70% of closes: left as is.
- **Wide range (90%)** held only 87-89%: widened from 1.645 to 1.75 volatility units (`Z90` in `scripts/update.mjs`), which gives 90.5% / 90.1% / 89.5% at 1 / 3 / 5 days.
- **Volatility estimate:** five alternatives (20-day, 60-day, two EWMA speeds, a mix) were compared; none was clearly better, so it is unchanged.
- **Drift factor (`DRIFT_K`):** the data fits 0.20 +/- 0.17, so 0.25 is unchanged.
- **Price signals** (trend, momentum, RSI) pointed the right way about 50-51% of the time: no measurable edge on this sample. Weights are unchanged for now. Each signal's right-direction rate is shown under it on the page, and every logged forecast now stores its signal values so the news signal can be judged once enough days are logged.

Re-run this check when the watchlist changes or after a few months of new data.

## Good to know

- Refresh timing: GitHub's own 5-minute schedule is unreliable, so the `Refresh ticker` workflow starts an update every minute (a build takes ~30 s). It runs ~5.5 hours, then starts a fresh copy of itself; every update also restarts it if it ever stops. To pause the site's updates, disable both `Refresh ticker` and `Update NATGAS forecast` on the Actions tab.
- The page shows how old its data is and warns if it's over 30 minutes.
- GitHub pauses scheduled workflows in a repo with no commits for 60 days. If that happens, click **Enable workflow** on the Actions tab (or push any small change).
- NATGAS and Brent prices come from CNBC's public quote feed (unofficial and free) plus a daily history the site keeps itself. If the feed stops answering, the page shows the last good price and flags it. Yahoo Finance is no longer called: it blocks GitHub's servers (HTTP 429). To try it again, add `USE_YAHOO: "1"` to the `env` block in `update.yml`.
- The trusted-outlet list and the keyword scoring live at the top of `scripts/update.mjs` (`TRUSTED`, `QUERIES`, `LEX`) — edit them to tune the model.
- Test locally: `node scripts/update.mjs` then serve `site/` (e.g. `npx serve site`).

Not financial advice.
