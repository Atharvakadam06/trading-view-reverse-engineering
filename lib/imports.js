// Your own data files, kept in data/imports/ on this computer:
//   - Bars: an OHLCV CSV (1-minute bars exported from Alpaca, a broker, anywhere). It charts as
//     CSV:<NAME> on its own timeframe and any longer one (built from its bars), and backtests like
//     any other symbol.
//   - Signals: a CSV of time and position (+1 long, 0 flat, -1 short). It becomes an indicator
//     (custom/signal-<name>.js), so the strategy tester and the quant checks run on your strategy
//     exactly as your own code decided it.

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./store.js";
import { parseTf, resample } from "../public/lib/series.js";

export const IMPORTS_DIR = path.join(DATA_DIR, "imports");
const bad = (message, status = 400) =>
  Object.assign(new Error(message), { status });

// "btc 1m (Alpaca).csv" -> "BTC_1M_ALPACA": safe as a file name and as a ticker.
export function cleanName(raw) {
  const n = String(raw || "")
    .replace(/\.(csv|txt)$/i, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30);
  if (!n) throw bad("Give the file a name made of letters or digits");
  return n;
}

// ---------- CSV ----------
function rowsOf(text) {
  const lines = String(text)
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith("#"));
  if (!lines.length) throw bad("The file is empty");
  const first = lines[0];
  const delim = [",", ";", "\t"].sort(
    (a, b) => first.split(b).length - first.split(a).length,
  )[0];
  return lines.map((l) =>
    l.split(delim).map((c) => c.trim().replace(/^"(.*)"$/, "$1")),
  );
}

const norm = (h) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
const ALIASES = {
  time: [
    "time",
    "timestamp",
    "datetime",
    "date",
    "t",
    "opentime",
    "datetimeutc",
    "dateutc",
    "timeutc",
    "ts",
    "unix",
    "barstart",
  ],
  open: ["open", "o", "openprice"],
  high: ["high", "h", "highprice"],
  low: ["low", "l", "lowprice"],
  close: ["close", "c", "closeprice", "last", "price"],
  volume: ["volume", "v", "vol", "basevolume"],
  position: [
    "position",
    "pos",
    "signal",
    "side",
    "target",
    "direction",
    "value",
  ],
  symbol: ["symbol", "ticker"],
};
function columns(header) {
  const h = header.map(norm);
  const col = {};
  for (const [k, names] of Object.entries(ALIASES)) {
    const i = names.map((n) => h.indexOf(n)).find((i) => i >= 0);
    if (i !== undefined) col[k] = i;
  }
  // MetaTrader-style exports: a date column and a separate time-of-day column.
  if (h.includes("date") && h.includes("time")) {
    col.time = h.indexOf("date");
    col.timeOfDay = h.indexOf("time");
  }
  return col;
}

// Seconds since 1970 (UTC). Unix seconds, milliseconds, microseconds or nanoseconds; ISO 8601 with
// or without a zone (no zone means UTC); dates with -, / or . between year, month and day.
export function parseTime(cell, timeOfDay) {
  const s = String(cell).trim();
  if (/^\d+(\.\d+)?$/.test(s) && !timeOfDay) {
    const n = Number(s);
    if (n > 1e17) return Math.floor(n / 1e9);
    if (n > 1e14) return Math.floor(n / 1e6);
    if (n > 1e11) return Math.floor(n / 1e3);
    if (n > 1e8) return Math.floor(n);
  }
  const m =
    /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2}|UTC)?$/i.exec(
      timeOfDay ? `${s} ${String(timeOfDay).trim()}` : s,
    );
  if (!m) return NaN;
  const [, y, mo, d, hh = "0", mi = "0", ss = "0", zone] = m;
  let t = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss) / 1000;
  if (zone && !/^(Z|UTC)$/i.test(zone)) {
    const z = /([+-])(\d{2}):?(\d{2})/.exec(zone);
    t -= (z[1] === "-" ? -1 : 1) * (+z[2] * 3600 + +z[3] * 60);
  }
  return t;
}

const TIME_HELP =
  "Use a time like 2026-10-14 14:30:00 (UTC), an ISO time like 2026-10-14T14:30:00Z, or Unix seconds.";

export function tfLabel(sec) {
  if (sec % 2592000 === 0) return `${sec / 2592000}M`;
  if (sec % 604800 === 0) return `${sec / 604800}W`;
  if (sec % 86400 === 0) return `${sec / 86400}D`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

// Bars from CSV text. Throws with the row number and what to change when a row can't be read.
export function parseBars(text) {
  const rows = rowsOf(text);
  let col = columns(rows[0]);
  let start = 1;
  if (col.time === undefined || col.close === undefined) {
    if (Number.isFinite(parseTime(rows[0][0])) && rows[0].length >= 5) {
      col = {
        time: 0,
        open: 1,
        high: 2,
        low: 3,
        close: 4,
        volume: rows[0].length > 5 ? 5 : undefined,
      };
      start = 0;
    } else
      throw bad(
        "Couldn't find the time and close columns. Name them time, open, high, low, close and volume in the first row.",
      );
  }
  const symbols = new Set();
  const bars = [];
  let skipped = 0;
  for (let r = start; r < rows.length; r++) {
    const row = rows[r];
    const time = parseTime(
      row[col.time],
      col.timeOfDay !== undefined ? row[col.timeOfDay] : undefined,
    );
    if (!Number.isFinite(time))
      throw bad(
        `Row ${r + 1}: couldn't read the time "${String(row[col.time]).slice(0, 40)}". ${TIME_HELP}`,
      );
    const close = Number(row[col.close]);
    const open = col.open !== undefined ? Number(row[col.open]) : close;
    const high =
      col.high !== undefined ? Number(row[col.high]) : Math.max(open, close);
    const low =
      col.low !== undefined ? Number(row[col.low]) : Math.min(open, close);
    if (
      ![open, high, low, close].every(Number.isFinite) ||
      row[col.close] === ""
    ) {
      skipped++;
      continue;
    }
    if (col.symbol !== undefined && row[col.symbol])
      symbols.add(row[col.symbol]);
    bars.push({
      time,
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close,
      volume: col.volume !== undefined ? Number(row[col.volume]) || 0 : 0,
    });
  }
  if (symbols.size > 1)
    throw bad(
      `The file has ${symbols.size} symbols (${[...symbols].slice(0, 3).join(", ")}...). Import one symbol per file.`,
    );
  bars.sort((a, b) => a.time - b.time);
  const out = [];
  for (const b of bars) {
    if (out.length && b.time === out.at(-1).time) out[out.length - 1] = b;
    else out.push(b);
  }
  if (out.length < 10)
    throw bad(
      `Only ${out.length} usable bars in the file. It needs at least 10.`,
    );
  // The file's own timeframe: the most common gap between bars.
  const gaps = new Map();
  for (let i = 1; i < Math.min(out.length, 5000); i++) {
    const g = out[i].time - out[i - 1].time;
    gaps.set(g, (gaps.get(g) || 0) + 1);
  }
  const base = [...gaps.entries()].sort(
    (a, b) => b[1] - a[1] || a[0] - b[0],
  )[0][0];
  return { bars: out, baseSeconds: base, skipped };
}

// ---------- bars: store, list, chart ----------
const parsed = new Map(); // name -> { mtime, bars, baseSeconds, byTf: Map }
function load(name) {
  const file = path.join(IMPORTS_DIR, `${name}.csv`);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw bad(
      `There's no imported file called ${name}. Import it from the strategy tester's "Your own data" row.`,
      404,
    );
  }
  const hit = parsed.get(name);
  if (hit && hit.mtime === st.mtimeMs) return hit;
  const p = {
    mtime: st.mtimeMs,
    ...parseBars(fs.readFileSync(file, "utf8")),
    byTf: new Map(),
  };
  parsed.set(name, p);
  return p;
}

export function importBars(rawName, text) {
  const name = cleanName(rawName);
  const p = parseBars(text);
  fs.mkdirSync(IMPORTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(IMPORTS_DIR, `${name}.csv`), text);
  parsed.delete(name);
  return summary(name, p);
}

const summary = (name, p) => ({
  name,
  symbol: `CSV:${name}`,
  bars: p.bars.length,
  tf: tfLabel(p.baseSeconds),
  from: p.bars[0].time,
  to: p.bars.at(-1).time,
  skipped: p.skipped,
});

export function listImports() {
  let files = [];
  try {
    files = fs.readdirSync(IMPORTS_DIR).filter((f) => f.endsWith(".csv"));
  } catch {
    return [];
  }
  return files.flatMap((f) => {
    const name = f.replace(/\.csv$/, "");
    try {
      return [summary(name, load(name))];
    } catch (e) {
      return [{ name, symbol: `CSV:${name}`, error: e.message }];
    }
  });
}

export function csvCandles(name, tf, limit) {
  const p = load(name);
  const want = parseTf(tf).seconds;
  if (want < p.baseSeconds)
    throw bad(
      `${name} has ${tfLabel(p.baseSeconds)} bars, so it charts at ${tfLabel(p.baseSeconds)} and longer.`,
    );
  if (!p.byTf.has(tf)) p.byTf.set(tf, resample(p.bars, tf));
  const built = want > p.baseSeconds;
  return {
    symbol: `CSV:${name}`,
    tf,
    provider: `Your file ${name}.csv`,
    candles: p.byTf.get(tf).slice(-limit),
    notes: [
      built
        ? `Your own bars from ${name}.csv, built from its ${tfLabel(p.baseSeconds)} bars.`
        : `Your own bars from ${name}.csv.`,
    ],
  };
}

// ---------- signals ----------
const POSITION_WORDS = {
  long: 1,
  buy: 1,
  short: -1,
  sell: -1,
  flat: 0,
  none: 0,
  exit: 0,
  close: 0,
};

// Time and position per row; only the changes are kept (the position holds until the next one).
export function parseSignals(text) {
  const rows = rowsOf(text);
  let col = columns(rows[0]);
  let start = 1;
  if (col.time === undefined || col.position === undefined) {
    if (Number.isFinite(parseTime(rows[0][0])) && rows[0].length >= 2) {
      col = { time: 0, position: rows[0].length - 1 };
      start = 0;
    } else
      throw bad(
        "Couldn't find the time and position columns. Name them time and position in the first row.",
      );
  }
  const pts = [];
  for (let r = start; r < rows.length; r++) {
    const row = rows[r];
    const time = parseTime(
      row[col.time],
      col.timeOfDay !== undefined ? row[col.timeOfDay] : undefined,
    );
    if (!Number.isFinite(time))
      throw bad(
        `Row ${r + 1}: couldn't read the time "${String(row[col.time]).slice(0, 40)}". ${TIME_HELP}`,
      );
    const cell = String(row[col.position] ?? "")
      .trim()
      .toLowerCase();
    const pos = cell in POSITION_WORDS ? POSITION_WORDS[cell] : Number(cell);
    if (!Number.isFinite(pos) || pos < -1 || pos > 1)
      throw bad(
        `Row ${r + 1}: the position "${String(row[col.position]).slice(0, 20)}" isn't one of 1 (long), 0 (flat) or -1 (short).`,
      );
    pts.push([time, pos]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  const changes = [];
  for (const [t, p] of pts)
    if (!changes.length || changes.at(-1)[1] !== p) changes.push([t, p]);
  if (!pts.length) throw bad("The file has no rows");
  return { rows: pts.length, changes, from: pts[0][0], to: pts.at(-1)[0] };
}

// The indicator file a signal becomes. Each bar takes the last position set before the next bar
// starts, so on a longer timeframe it's the position at the bar's close.
export function signalIndicatorSource(name, s, fileName) {
  return `// Position signal imported from ${String(fileName || name).replace(/[\r\n]/g, " ")} on ${new Date().toISOString().slice(0, 10)}.
// +1 long, 0 flat, -1 short, each holding until the next change. Import the CSV again to replace it.
const T = ${JSON.stringify(s.changes.map((c) => c[0]))};
const P = ${JSON.stringify(s.changes.map((c) => c[1]))};

export default {
  name: ${JSON.stringify(`Signal: ${name}`)},
  overlay: false,
  inputs: [],
  outputs: [{ key: "position", label: "Position", kind: "histogram", color: "#2962ff" }],
  levels: [0],
  calc(bars) {
    const position = new Array(bars.length).fill(NaN);
    const colors = new Array(bars.length).fill("#787b86");
    let k = -1;
    for (let i = 0; i < bars.length; i++) {
      const end = i + 1 < bars.length ? bars[i + 1].time : bars[i].time + (i ? bars[i].time - bars[i - 1].time : 86400);
      while (k + 1 < T.length && T[k + 1] < end) k++;
      if (k < 0) continue;
      position[i] = P[k];
      colors[i] = P[k] > 0 ? "#089981" : P[k] < 0 ? "#f23645" : "#787b86";
    }
    return { position, colors };
  },
};
`;
}

// The tester rules that trade a signal exactly: long while it's above 0, short while it's below.
export function signalStrategy(id) {
  return {
    indicators: { signal: { id } },
    entryLong: [{ left: "signal", op: ">", right: 0 }],
    exitLong: [{ left: "signal", op: "<=", right: 0 }],
    entryShort: [{ left: "signal", op: "<", right: 0 }],
    exitShort: [{ left: "signal", op: ">=", right: 0 }],
  };
}
