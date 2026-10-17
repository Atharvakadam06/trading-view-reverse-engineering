// Your own data files: OHLCV bars from a CSV (chart and backtest them on any longer timeframe) and a
// position signal (+1/0/-1) that the strategy tester and quant checks run exactly as written.
// From a Skool comment: 1-minute bars exported from Alpaca, and a strategy written elsewhere.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.QT_OFFLINE = "1";
process.env.QT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "qt-imports-"));
const M = await import("../lib/imports.js");
const { validateIndicator } = await import("../public/lib/indicators.js");
const { start } = await import("../server.js");

// 1-minute bars the way alpaca-py's DataFrame.to_csv() writes them.
const T0 = Date.UTC(2026, 9, 14, 13, 30) / 1000;
const minute = Array.from({ length: 600 }, (_, i) => {
  const c = 60000 + 50 * Math.sin(i / 20) + i;
  return {
    time: T0 + i * 60,
    open: c - 3,
    high: c + 10,
    low: c - 10,
    close: c,
    volume: 1 + (i % 7),
  };
});
const alpacaCsv =
  "symbol,timestamp,open,high,low,close,volume,trade_count,vwap\n" +
  minute
    .map(
      (b) =>
        `BTC/USD,${new Date(b.time * 1000).toISOString().replace("T", " ").replace(".000Z", "+00:00")},${b.open},${b.high},${b.low},${b.close},${b.volume},12,${b.close}`,
    )
    .join("\n");

let server, base;
const H = { "x-qt": "1" };
const CUSTOM = fileURLToPath(new URL("../custom/", import.meta.url));
before(async () => {
  const s = await start(39000 + Math.floor(Math.random() * 1000));
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});
after(() => {
  server.close();
  for (const f of fs.readdirSync(CUSTOM))
    if (f.startsWith("signal-test")) fs.rmSync(path.join(CUSTOM, f));
});

test("times: ISO with or without a zone, Unix seconds or milliseconds, dotted dates with a separate time", () => {
  const t = Date.UTC(2026, 9, 14, 14, 30) / 1000;
  for (const s of [
    "2026-10-14 14:30:00",
    "2026-10-14T14:30:00Z",
    "2026-10-14T14:30:00.000Z",
    "2026-10-14 14:30:00+00:00",
    "2026-10-14T10:30:00-04:00",
    String(t),
    String(t * 1000),
  ])
    assert.equal(M.parseTime(s), t, s);
  assert.equal(M.parseTime("2026.10.14", "14:30"), t);
  assert.equal(M.parseTime("2026-10-14"), Date.UTC(2026, 9, 14) / 1000);
  assert.ok(Number.isNaN(M.parseTime("14/10/2026")));
});

test("an Alpaca 1-minute export parses, and its timeframe is found from the bars", () => {
  const p = M.parseBars(alpacaCsv);
  assert.equal(p.bars.length, 600);
  assert.equal(p.baseSeconds, 60);
  assert.deepEqual(p.bars[0], minute[0]);
});

test("headerless TradingView-style rows and semicolon MetaTrader rows parse too", () => {
  const tv = minute
    .slice(0, 20)
    .map((b) => [b.time, b.open, b.high, b.low, b.close, b.volume].join(","))
    .join("\n");
  assert.equal(M.parseBars(tv).bars.length, 20);
  const mt =
    "Date;Time;Open;High;Low;Close;Volume\n" +
    minute
      .slice(0, 20)
      .map((b) => {
        const d = new Date(b.time * 1000).toISOString();
        return `${d.slice(0, 10).replace(/-/g, ".")};${d.slice(11, 16)};${b.open};${b.high};${b.low};${b.close};${b.volume}`;
      })
      .join("\n");
  const p = M.parseBars(mt);
  assert.equal(p.bars[5].time, minute[5].time);
});

test("a file that can't be read is refused with the row and what to change", () => {
  assert.throws(
    () => M.parseBars("time,open,high,low,close\n14/10/2026,1,2,0,1\n"),
    /Row 2: couldn't read the time "14\/10\/2026"\. Use a time like/,
  );
  assert.throws(
    () => M.parseBars(alpacaCsv.replace(/\nBTC\/USD,(.+)$/m, "\nETH/USD,$1")),
    /2 symbols .* Import one symbol per file/,
  );
  assert.throws(
    () => M.parseBars(alpacaCsv.split("\n").slice(0, 5).join("\n")),
    /It needs at least 10/,
  );
  assert.throws(
    () => M.parseBars("a,b\n1,2"),
    /Couldn't find the time and close columns/,
  );
});

test("imported bars chart as CSV:NAME on their own timeframe and longer, never shorter", async () => {
  const r = await (
    await fetch(
      `${base}/api/import/bars?name=${encodeURIComponent("btc 1m (alpaca).csv")}`,
      { method: "POST", headers: H, body: alpacaCsv },
    )
  ).json();
  assert.equal(r.symbol, "CSV:BTC_1M_ALPACA");
  assert.equal(r.tf, "1m");
  assert.equal(r.bars, 600);
  const m1 = await (
    await fetch(`${base}/api/candles?symbol=CSV:BTC_1M_ALPACA&tf=1m&limit=1000`)
  ).json();
  assert.equal(m1.candles.length, 600);
  assert.match(m1.provider, /Your file BTC_1M_ALPACA\.csv/);
  const m5 = await (
    await fetch(`${base}/api/candles?symbol=CSV:BTC_1M_ALPACA&tf=5m&limit=1000`)
  ).json();
  assert.equal(m5.candles.length, 120);
  assert.deepEqual(m5.candles[0], {
    time: minute[0].time,
    open: minute[0].open,
    high: Math.max(...minute.slice(0, 5).map((b) => b.high)),
    low: Math.min(...minute.slice(0, 5).map((b) => b.low)),
    close: minute[4].close,
    volume: minute.slice(0, 5).reduce((a, b) => a + b.volume, 0),
  });
  assert.ok(m5.notes[0].includes("built from its 1m bars"));
  const s30 = await fetch(
    `${base}/api/candles?symbol=CSV:BTC_1M_ALPACA&tf=30s`,
  );
  assert.equal(s30.status, 400);
  assert.match(
    (await s30.json()).error,
    /BTC_1M_ALPACA has 1m bars, so it charts at 1m and longer/,
  );
  const list = await (await fetch(`${base}/api/imports`)).json();
  assert.ok(
    list.some((x) => x.symbol === "CSV:BTC_1M_ALPACA" && x.bars === 600),
  );
  assert.ok(
    (await (await fetch(`${base}/api/search?q=btc_1m`)).json()).some(
      (x) => x.symbol === "CSV:BTC_1M_ALPACA",
    ),
  );
});

test("signals: words or numbers, only the changes are kept, anything else is refused", () => {
  const s = M.parseSignals(
    "time,position\n2026-10-14 13:30,0\n2026-10-14 13:31,1\n2026-10-14 13:32,1\n2026-10-14 13:33,short\n2026-10-14 13:34,flat\n",
  );
  assert.equal(s.rows, 5);
  assert.deepEqual(
    s.changes.map((c) => c[1]),
    [0, 1, -1, 0],
  );
  assert.throws(
    () => M.parseSignals("time,position\n2026-10-14 13:30,2\n"),
    /Row 2: the position "2" isn't one of 1 \(long\), 0 \(flat\) or -1 \(short\)/,
  );
});

test("a signal becomes a valid indicator: each bar takes the position set by its close", async () => {
  const s = M.parseSignals(
    "time,position\n" +
      [
        [0, 0],
        [10, 1],
        [17, -1],
        [22, 0],
      ]
        .map(([k, p]) => `${minute[k].time},${p}`)
        .join("\n"),
  );
  const file = path.join(os.tmpdir(), `qt-signal-${process.pid}.mjs`);
  fs.writeFileSync(file, M.signalIndicatorSource("TEST", s, "test.csv"));
  const def = (await import(pathToFileURL(file).href)).default;
  fs.rmSync(file);
  validateIndicator(def);
  const bars = minute.slice(0, 30);
  const pos = def.calc(bars).position;
  assert.equal(pos[9], 0);
  assert.equal(pos[10], 1);
  assert.equal(pos[16], 1);
  assert.equal(pos[17], -1);
  assert.equal(pos[22], 0);
  // 5-minute bars: bar 2 covers minutes 10-14 (long by its close), bar 3 covers 15-19 (short by its close).
  const five = (await import("../public/lib/series.js")).resample(bars, "5m");
  assert.deepEqual(def.calc(five).position, [0, 0, 1, -1, 0, 0]);
});

test("an imported signal backtests exactly as written, and the quant checks run on it", async () => {
  // Long from minute 100's close, short from 300's, flat from 450's.
  const csv =
    "time,position\n" +
    [
      [0, 0],
      [100, 1],
      [300, -1],
      [450, 0],
    ]
      .map(([k, p]) => `${new Date(minute[k].time * 1000).toISOString()},${p}`)
      .join("\n");
  const r = await (
    await fetch(`${base}/api/import/signal?name=test%20v10`, {
      method: "POST",
      headers: H,
      body: csv,
    })
  ).json();
  assert.equal(r.id, "custom:signal-test_v10");
  assert.equal(r.changes, 4);
  const bt = await (
    await fetch(`${base}/api/backtest`, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "CSV:BTC_1M_ALPACA",
        tf: "1m",
        limit: 1000,
        strategy: { ...r.strategy, feePct: 0, slippagePct: 0 },
        quantChecks: true,
      }),
    })
  ).json();
  assert.deepEqual(
    bt.trades.map((t) => [t.side, t.entryTime, t.exitTime]),
    [
      ["long", minute[101].time, minute[301].time],
      ["short", minute[301].time, minute[451].time],
    ],
    "fills at the next bar's open after each change",
  );
  assert.equal(bt.trades[0].entryPrice, minute[101].open);
  assert.ok(bt.quantChecks.gates.some((g) => g.label === "Cost stress"));
  const bad = await fetch(`${base}/api/import/signal?name=broken`, {
    method: "POST",
    headers: H,
    body: "time,position\n2026-10-14,9\n",
  });
  assert.equal(bad.status, 400);
  assert.ok(!fs.existsSync(path.join(CUSTOM, "signal-broken.js")));
});
