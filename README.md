# Quant Terminal

A free trading terminal that runs on your own computer: charts, 87 indicators, 13 drawing tools, alerts, a screener, a heatmap, seasonals, earnings and dividend calendars, news, company financials, a strategy tester with quant checks, bar replay and paper trading. No account, no subscription, no ads, no limit on indicators per chart.

It's one small Node.js app with no dependencies. Your watchlists, drawings, alerts and paper account are plain files in the `data` folder, on your machine.

## Install

**With an AI coding agent (easiest).** Paste the setup prompt into Claude Code or Codex. It checks your machine, installs this, tests it, opens it in your browser and sets up your watchlist. It takes a couple of minutes.

**By hand.**

1. Install Node.js 18 or newer from [nodejs.org](https://nodejs.org) (the LTS version is fine).
2. Download [quant-terminal.zip](https://part-timequant.com/kit/quant-terminal.zip) from part-timequant.com, the only official source, and unzip it. To check it's the real file, run `shasum -a 256 quant-terminal.zip` and compare it with [quant-terminal-sha256.txt](https://part-timequant.com/kit/quant-terminal-sha256.txt).
3. In that folder, run:

```bash
npm run doctor
```

```bash
npm start
```

There's no `npm install` step. Next time, double-click `start.command` (Mac), `start.bat` (Windows) or run `./start.sh` (Linux).

## What's in it

| You get | Notes |
|---|---|
| 15 chart types | Candles, hollow candles, bars, Heikin Ashi, line, line with markers, step, area, baseline, columns, Renko, line break, range bars, Kagi, point & figure |
| Spreads and ratios | Type `BTCUSDT/ETHUSDT`, `AAPL - MSFT` or `SPY*2` to chart one symbol against another |
| Any timeframe | 1m to 1M plus custom ones like 7m, 2h, 3D, 2W. 1-second bars on Binance crypto |
| Up to 16 charts at once | 1, 2, 3, 4, 6, 8 or 16 charts, with symbol sync and crosshair sync |
| 87 built-in indicators, no cap per chart | Moving averages, RSI, MACD, Bollinger, Ichimoku, Supertrend, VWAP and anchored VWAP, session and visible-range volume profiles, ADX, pivots, volume tools, candlestick patterns and more. Formulas follow the Pine Script reference |
| Indicators on indicators, any timeframe | Build one indicator on another's output (an SMA of RSI), or show a higher timeframe's value (daily RSI on a 1h chart) without look-ahead |
| Volume profile | Visible-range profile with point of control and value area |
| Your own indicators | Write one in the Indicator editor tab, or ask your AI agent to add a file to `custom/` |
| 13 drawing tools | Trend line, ray, extended line, horizontal line and ray, vertical line, parallel channel, rectangle, fib retracement, measure, long and short position, text |
| Alerts | Up to 5 price or indicator conditions (all or any), or price crossing a drawn trend line, ray or horizontal line. Checked every 15 seconds on your machine. Desktop pop-up, sound, and an optional Discord, Slack or Telegram webhook |
| Strategy tester | Rule builder or JSON, fees and slippage, stop loss, take profit, trailing stop, long and short, equity curve, trade list, CSV export |
| Bar replay | Pick a start bar, then step or play forward at 0.5x to 10x, on one chart or every chart in the layout. Paper trade while it plays, in a separate practice account |
| Screener | Crypto (Binance USDT pairs), US stocks and US ETFs, with a technical filter such as RSI below 30 |
| Heatmap | The 200 largest US companies by sector, or the 100 most traded crypto pairs |
| Paper trading | Market, limit and stop orders, bracket stop and target, positions and P&L |
| Calendars | Economic events by impact, plus US earnings and dividends for the next five trading days |
| News and financials | Headlines for crypto and US stocks; income statement, balance sheet, cash flow, ratios and key stats for US companies |
| Seasonals | Each year's path from 1 January, the average year, and a monthly returns table |
| Also | Compare symbols, log scale, chart image download, CSV export of bars and indicator values, light and dark themes |

## Where the data comes from

All free and public, with automatic fallbacks:

| Market | Sources | Limits |
|---|---|---|
| Crypto | Binance, then Binance's market-data mirror, Binance.US, Coinbase, Kraken | Live. If Binance is blocked where you are, Coinbase and Kraken take over |
| US stocks, ETFs, NDX | Yahoo when reachable, Nasdaq's public API | About 10 years of daily history. Intraday history is today's session only unless Yahoo is reachable |
| Forex | Yahoo, then Kraken | Kraken gives the last 720 bars per timeframe |
| CME futures: NQ, MNQ, ES, MES | Yahoo's continuous front month (type `NQ`, `MNQ`, `MES` or `ES1!`) | About 10 minutes delayed, and the chart says so. Live with your own Polygon futures key (below) |
| Indices, other futures, non-US stocks | Yahoo (type `YAHOO:^FTSE`, `YAHOO:GC=F`, `YAHOO:VOD.L`) | Only when Yahoo isn't rate limiting your connection |
| Economic calendar | Forex Factory's weekly feed | This week only |

`npm run doctor` tells you which sources work from your connection.

## Your own data feed (optional)

The public sources need no account. If you have a market data key, add it and charts use it first. When your key can't load a chart, the public sources carry it and the chart says why. Every chart's legend names the source it's on.

| Provider | Covers | What it costs |
|---|---|---|
| Alpaca | US stocks and ETFs, any timeframe | A free account at alpaca.markets gives live prices on the IEX feed. Alpaca's paid plan adds the full market feed (`"feed": "sip"`) |
| Polygon (now called Massive) | US stocks, any timeframe | The free plan is end-of-day only, 5 requests a minute. Paid plans are 15-minute delayed or live |
| Polygon futures | NQ, MNQ, ES and MES, 1m to 1D | A Polygon futures plan; the Advanced plan is live. Charts the front contract (NQZ6 and so on), which moves to the next one 8 days before expiry |

Put your keys in `data/feeds.json` (make the file with any text editor, and leave out the provider you don't use):

```json
{
  "alpaca": { "keyId": "PK...", "secretKey": "...", "feed": "iex" },
  "polygon": { "apiKey": "..." }
}
```

For Alpaca, sign up at alpaca.markets and generate an API key pair in your dashboard (a paper trading account's keys read market data too). Quant Terminal only reads prices with it.

The file stays on your computer. The data folder isn't in git, updates leave it alone, and each key goes only to its own provider, in a request header. A change to the file applies on the next chart load. `npm run doctor` checks each key you added.

## Your own data files

The strategy tester's **Your own data** row imports two kinds of CSV, kept in `data/imports/` on your computer.

- **Bars.** Columns `time, open, high, low, close, volume`, one symbol per file. An Alpaca export (`symbol, timestamp, open, ...`), a TradingView export and MetaTrader's separate date and time columns all read as they are. Times can be ISO (`2026-10-14T14:30:00Z`), `2026-10-14 14:30:00` (read as UTC) or Unix seconds. The file charts as `CSV:NAME` on its own timeframe and any longer one, built from its bars (1-minute bars give 5m, 1h, 1D and the rest), and backtests like any other symbol. Charts and tests use the most recent 20,000 bars at the timeframe you pick.
- **Signal.** Columns `time, position`, where position is `1` (long), `0` (flat) or `-1` (short), or the words long, short and flat. Each row is the position to hold from that bar's close; it fills at the next bar's open, like every signal in the tester. The file becomes an indicator (`custom/signal-<name>.js`) and loads into the tester as rules, so **Run on chart** and **Run quant checks** test your strategy exactly as your own code decided it. Open the bars the signal was made on first.

With no settings to vary, a signal gets the deflated Sharpe, cost stress and Monte Carlo checks; walk-forward, overfitting and nearby settings need a setting like an indicator's length. `POST /api/import/bars?name=NAME` and `POST /api/import/signal?name=NAME` take the CSV as the request body, for scripts (see [`docs/api.md`](docs/api.md)).

## Your own indicators

Each custom indicator is a JavaScript file in `custom/`, in one standard format: [`docs/custom-indicators.md`](docs/custom-indicators.md) sets out the inputs, outputs, plotting and how to add one, and [`docs/indicator-template.js`](docs/indicator-template.js) is a file to start from. Every indicator is checked against the format before it loads, and a file that doesn't fit is refused with each problem named. This one is included as an example:

```js
export default {
  name: 'EMA ribbon squeeze',
  overlay: true,
  inputs: [{ key: 'fast', label: 'Fast EMA', type: 'int', default: 8 }, { key: 'slow', label: 'Slow EMA', type: 'int', default: 34 }],
  outputs: [{ key: 'fast', label: 'Fast', kind: 'line', color: '#26a69a' }, { key: 'slow', label: 'Slow', kind: 'line', color: '#ef5350' }],
  calc(bars, p, ta) {
    const close = ta.source(bars, 'close');
    return { fast: ta.ema(close, p.fast), slow: ta.ema(close, p.slow) };
  },
};
```

`ta` has `sma, ema, rma, wma, hma, rsi, atr, stdev, highest, lowest, crossover, crossunder, source` and `compute(id, bars, params)` for any built-in indicator. Return `markers` to put arrows or labels on the chart.

## Strategy format

The tester, alerts and screener share one rule format, so an AI agent can write strategies for you:

```json
{
  "indicators": { "fast": { "id": "ema", "params": { "length": 9 } }, "slow": { "id": "ema", "params": { "length": 21 } } },
  "entryLong": [{ "left": "fast", "op": "crossesAbove", "right": "slow" }],
  "exitLong": [{ "left": "fast", "op": "crossesBelow", "right": "slow" }],
  "stopLossPct": 5, "feePct": 0.1, "slippagePct": 0.05
}
```

Entry conditions must all be true. Exits need all of theirs too, unless you set `"exitMatch": "any"` to exit on whichever one fires first. `"maxBarsInTrade": 10` closes a trade after 10 bars if nothing else has.

`"spreadPct"` is the bid to ask spread: buys fill at the ask, sells at the bid, and stops trigger on that side (the tester's Live spread button reads it from Binance, Coinbase or Kraken). `"intrabar"` sets how stops and targets fill inside a bar: `"worst"` (stop first when a bar touches both, the default), `"ohlc"` (TradingView's path: open, the nearer of high and low, the other, close) or `"magnifier"` (the real lower-timeframe bars inside each bar, like TradingView's bar magnifier).

Operators: `>`, `<`, `>=`, `<=`, `crossesAbove`, `crossesBelow`, `crosses`. Operands: a number, a price field (`close`, `high`, `hl2`...), an indicator key, or `key.output` such as `macd.signal`. Signals use a bar's close and fill at the next bar's open.

A backtest shows how rules did on past prices. It doesn't tell you whether the result was luck.

## Drive it from your own code

Everything in the app runs through a local HTTP API on your computer, so your own scripts can use it: bars and quotes, backtests with the quant checks (`POST /api/backtest`), alerts with webhooks, and a live stream of alerts as they fire. [`docs/api.md`](docs/api.md) lists every request. `examples/` has working Python and Rust programs, with nothing extra to install:

```bash
python3 examples/python/quant_terminal.py
cd examples/rust && cargo run --release
```

Add `--listen` to either one to print alerts as they fire. Trading real money happens in PTQ (below).

## Works with PTQ

If you run [PTQ](https://www.part-timequant.com/) on the same computer (`ptq serve`), Quant Terminal finds it automatically:

- **Check with PTQ** appears under every strategy tester result. It sends the rules to PTQ, which backtests them on its own engine and checks whether the result was luck: walk-forward, overfitting (PBO), deflated Sharpe and higher costs. The strategy is saved in your PTQ.
- **The PTQ tab** shows your PTQ account, positions, armed strategies and recent orders, with a button that stops all PTQ trading.
- **Trading it** happens in PTQ. Connect your account in PTQ, then arm the strategy on the command line (`ptq arm-strategy <id> --max-notional 100`). PTQ shows what you're agreeing to before anything trades.

Quant Terminal never sees your PTQ licence key or your exchange keys, never places an order and never arms a strategy. It can only make PTQ do less: engage its stop, or disarm a strategy. It reads the lease `ptq activate` saved on this computer and talks to PTQ on `127.0.0.1:8787` (set `PTQ_URL` to change that). PTQ's builder takes SMA, EMA, RSI, ATR, ROC, standard deviation, Bollinger Bands, MACD, Donchian highs and lows and volume; anything else is refused with the reason rather than approximated.

## Commands

| Command | What it does |
|---|---|
| `npm start` | Start and open your browser (http://localhost:3777, or the next free port) |
| `npm run serve` | Start without opening a browser |
| `npm run doctor` | Check Node and which data sources you can reach |
| `npm test` | Offline tests (indicators, backtester, server) |
| `npm run smoke` | Start the server and check it serves live data |
| `PTQ_URL=http://127.0.0.1:8787 npm start` | Point the PTQ connector somewhere else |
| `npm run compare -- BTCUSDT 1D 2026-10-10` | Print indicator values for one bar, to check against another charting tool |

`PORT=4000 npm start` picks a port. `HOST=0.0.0.0 npm start` lets a phone on your home network open it (only do that on a network you trust).

## Limits

- It runs on your computer. Close the laptop and alerts stop.
- No broker connection. Paper trading only, on purpose.
- Free data: crypto is strong, US stocks are daily-first, and non-US markets depend on Yahoo.
- No social feed, no mobile app, no cloud sync.

## Licence and credits

MIT for this project's code. The chart engine is TradingView's open-source [Lightweight Charts](https://github.com/tradingview/lightweight-charts) (Apache 2.0), and the chart keeps TradingView's attribution logo as its licence asks. Quant Terminal isn't affiliated with or endorsed by TradingView, Inc. See `NOTICE`.

Nothing here is financial advice.
