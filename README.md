# Market watch: live CFD outlooks

A free, self-updating web page for Henry Hub natural gas (the NATGAS CFD's underlying): live front-month price, 1 / 3 / 5-day forecast ranges, the signals behind them, and the latest headlines from trusted outlets.

- **Hosting:** GitHub Pages (free).
- **Server refresh:** GitHub Actions every ~5 minutes — prices every run, news about every 15 minutes.
- **Page refresh:** the open page checks for new data every minute.
- **Forecast:** a transparent rules-based model (volatility ranges + news sentiment + trend, momentum and RSI). See "How the forecast works" on the page.

## Set up (about 5 minutes)

1. Create a **public** repository on GitHub (e.g. `natgas-live`). It must be public: scheduled Actions are free and unlimited only on public repos.
2. Upload everything in this folder to it (keep the folder structure, including `.github/workflows/update.yml`).
   - Web: on the repo page choose **Add file → Upload files**, drag the folder contents in, commit.
   - Or command line: `git init && git add . && git commit -m "NATGAS live" && git branch -M main && git remote add origin https://github.com/echirileac/Trading.git && git push -u origin main`
3. In the repo go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
4. Go to **Actions**, open **Update NATGAS forecast**, click **Run workflow**. After ~1 minute the page is live at `https://echirileac.github.io/Trading/`.

From then on it refreshes itself every ~5 minutes.

## Watchlist: any market (added November 2026)

- NATGAS is built in. Add up to 8 more markets (stocks, ETFs, indices, forex, crypto, metals, oil) from the page: **+ Add market** → search → **Add**. That opens a pre-filled GitHub issue; press **Create** and the `Watchlist change` workflow updates `watchlist.json`, rebuilds the site and closes the issue (about 2 minutes). Only the repository owner's requests are applied.
- Remove a market with the **Remove** button next to its name (same GitHub flow), or edit `watchlist.json` directly.
- Prices for these markets come from **Twelve Data**. Add your free API key once: GitHub repo → Settings → Secrets and variables → Actions → **New repository secret**, name `TWELVE_DATA_KEY`.
- Free plan limits (800 requests/day, 8/minute) mean live quotes refresh every 10–15 minutes depending on how many markets you watch; daily history is fetched once a day. Some indices need a paid Twelve Data plan.

## Pro chart and AI analyst (added November 2026)

- **Chart:** daily candlesticks (TradingView Lightweight Charts, bundled in `site/vendor`), 1M/3M/6M/1Y, zoom and pan, toggles for 20/50/200-day averages, Bollinger bands, the model's forecast lines, and RSI / MACD panels. Your choices are remembered per browser.
- **AI analyst:** each market's indicators, key levels, quant forecast and latest trusted news (with what was read in full) go to an AI model, which writes a short note: stance, summary, chart and news bullets, levels to watch, 1/3/5-day outlook, what would change the view, risks. The note says which model wrote it.
  - **Free by default:** GitHub Models through the workflow's own token (`models: read` permission), no key needed. Tries `openai/gpt-4.1` (50 requests/day on the free plan), then `openai/gpt-4.1-mini` / `openai/gpt-4o-mini` (150/day each).
  - **Free backup (optional):** add a free Groq key (console.groq.com → API keys) as repository secret `GROQ_API_KEY`. Used when GitHub's daily limit runs out: `openai/gpt-oss-120b`, then `llama-3.3-70b-versatile`.
  - **Paid upgrade (optional):** repository secret `ANTHROPIC_API_KEY` puts Claude (`AI_MODEL`, default `claude-sonnet-5-5`) first in line; about 1 cent per note.
  - Cadence: about every 2 hours per market while it trades (6 hours when closed), sooner after a 1.5% move, at most 2 notes per refresh. Change with repository variables `AI_EVERY_MIN`, `AI_PROVIDERS` (order, e.g. `github,groq`), `GH_MODELS`, `GROQ_MODELS`.
  - A model that hits its limit is skipped until the next refresh; if every option is exhausted the page keeps showing the previous note.

## Good to know

- Refresh timing: GitHub's own 5-minute schedule is unreliable, so the `Refresh ticker` workflow starts an update every 5 minutes. It runs ~5.5 hours, then starts a fresh copy of itself; every update also restarts it if it ever stops. To pause the site's updates, disable both `Refresh ticker` and `Update NATGAS forecast` on the Actions tab.
- The page shows how old its data is and warns if it's over 30 minutes.
- GitHub pauses scheduled workflows in a repo with no commits for 60 days. If that happens, click **Enable workflow** on the Actions tab (or push any small change).
- The price feed (Yahoo Finance's public chart endpoint) is unofficial and free. If it stops answering, the script falls back to CNBC and Stooq, then to the last good price, and the page flags it.
- The trusted-outlet list and the keyword scoring live at the top of `scripts/update.mjs` (`TRUSTED`, `QUERIES`, `LEX`) — edit them to tune the model.
- Test locally: `node scripts/update.mjs` then serve `site/` (e.g. `npx serve site`).

Not financial advice.
