// Your own market data keys, optional. The free public sources stay the default; a key you add
// takes over the charts it covers, and the public sources stay behind it as the fallback.
//
// Keys live in data/feeds.json on this computer (the data folder is never in git and an update
// keeps it). Each key is only ever sent to its own provider, in a request header:
//
//   {
//     "alpaca":  { "keyId": "PK...", "secretKey": "...", "feed": "iex" },
//     "polygon": { "apiKey": "..." }
//   }
//
//   Alpaca   US stocks. A free Alpaca account gives live prices on the IEX feed ("feed": "sip" if
//            you pay for Alpaca's full feed).
//   Polygon  US stocks, and CME futures (NQ, MNQ, ES, MES) on a Polygon futures plan. Polygon is
//            now called Massive; same keys. Live or delayed depends on your Polygon plan: the free
//            plan is end-of-day only.

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./store.js";
import {
  parseTf,
  resample,
  nativeBase,
  isIntraday,
} from "../public/lib/series.js";

export const FEEDS_FILE = path.join(DATA_DIR, "feeds.json");
const TIMEOUT_MS = Number(process.env.QT_TIMEOUT_MS) || 10000;
const ALPACA = "https://data.alpaca.markets";
const POLYGON = "https://api.massive.com";

// Re-read when the file changes, so a key you add works without a restart.
let memo = { mtime: -1, value: {} };
export function feedConfig() {
  let st;
  try {
    st = fs.statSync(FEEDS_FILE);
  } catch {
    return {};
  }
  if (st.mtimeMs !== memo.mtime) {
    let value = {};
    try {
      value = JSON.parse(fs.readFileSync(FEEDS_FILE, "utf8")) || {};
    } catch (e) {
      console.error(
        `data/feeds.json isn't valid JSON, so your own keys are off: ${e.message}`,
      );
    }
    memo = { mtime: st.mtimeMs, value };
  }
  return memo.value;
}
const alpacaCfg = () => {
  const a = feedConfig().alpaca;
  return a?.keyId && a?.secretKey ? a : null;
};
const polygonCfg = () => {
  const c = feedConfig();
  const p = c.polygon || c.massive;
  return p?.apiKey ? p : null;
};
// Names only: the keys themselves never leave this module.
export const configured = () =>
  [alpacaCfg() && "alpaca", polygonCfg() && "polygon"].filter(Boolean);
export const alpacaName = () =>
  `Alpaca (${String(alpacaCfg()?.feed || "iex").toUpperCase()})`;
// Every name a key provider can show on a chart, so fallback notes can say "your key".
export const isKeyProvider = (name) => /^(Alpaca|Polygon)\b/.test(String(name));

// ---------- requests ----------
const feedError = (message, status) =>
  Object.assign(new Error(message), { status, upstream: true });
// A provider that rate limits or refuses the key is skipped for a minute, so every chart on screen
// doesn't hit it again; the public sources carry the charts meanwhile.
const resting = new Map(); // name -> { until, why }

async function getFeed(name, url, headers) {
  const rest = resting.get(name);
  if (rest && rest.until > Date.now()) throw feedError(rest.why, rest.status);
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw feedError(`${name} couldn't be reached`, e.name === "TimeoutError" ? "timeout" : e.cause?.code);
  }
  if (!res.ok) {
    // Plain words for the chart; the provider's own message stays on the error for logs.
    let detail = "";
    try {
      const j = await res.json();
      detail = String(j.message || j.error || "").slice(0, 200);
    } catch {
      /* no body */
    }
    const why =
      res.status === 401
        ? `${name} refused your key`
        : res.status === 403
          ? `your ${name} plan doesn't include this`
          : res.status === 429
            ? `${name} is rate limiting your key`
            : `${name} returned an error`;
    if (res.status === 401 || res.status === 429)
      resting.set(name, { until: Date.now() + 60e3, why, status: res.status });
    throw Object.assign(feedError(why, res.status), { detail });
  }
  return res.json();
}

// ---------- shared ----------
// New York's UTC offset for each day, worked out once per day rather than once per bar.
const nyOffset = new Map();
function nyOffsetHours(sec) {
  const day = Math.floor(sec / 86400);
  if (!nyOffset.has(day)) {
    const h = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        hourCycle: "h23",
      }).format(new Date((day * 86400 + 12 * 3600) * 1000)),
    );
    nyOffset.set(day, 12 - h);
  }
  return nyOffset.get(day);
}
// 09:30 to 16:00 New York, the same session the free sources chart.
export function inUsSession(sec) {
  const local = (((sec - nyOffsetHours(sec) * 3600) % 86400) + 86400) % 86400;
  return local >= 34200 && local < 57600;
}

// How far back to ask for `want` bars of `base`, with room for weekends, holidays and a stock's
// 6.5-hour day.
function startFor(base, want, earliest) {
  const sec = parseTf(base).seconds;
  const tradingDays = isIntraday(base) ? want / (23400 / sec) : want;
  const days = Math.ceil(tradingDays * 1.5) + 5;
  const t = Math.max(Date.now() - days * 86400e3, earliest);
  return new Date(t).toISOString().slice(0, 10);
}

// Daily bars carry the trading date as UTC midnight, like every other source in the app.
const dayOf = (sec) => Math.floor(sec / 86400) * 86400;

function finish(bars, base, tf, limit) {
  const asc = bars.sort((a, b) => a.time - b.time);
  const out = [];
  for (const b of asc) if (!out.length || b.time > out.at(-1).time) out.push(b);
  return base === tf ? out.slice(-limit) : resample(out, tf).slice(-limit);
}

// ---------- Alpaca (US stocks) ----------
const ALPACA_TF = {
  "1m": "1Min",
  "5m": "5Min",
  "15m": "15Min",
  "30m": "30Min",
  "1D": "1Day",
};

export async function alpacaCandles(ticker, tf, limit) {
  const k = alpacaCfg();
  if (!k) throw new Error("No Alpaca key in data/feeds.json");
  const base = nativeBase(tf, Object.keys(ALPACA_TF));
  if (!base) throw new Error(`Alpaca can't build a ${tf} chart`);
  const intraday = isIntraday(base);
  const ratio = Math.max(
    1,
    Math.round(parseTf(tf).seconds / parseTf(base).seconds),
  );
  const want = Math.min(limit * ratio + ratio, 60000);
  const headers = {
    "APCA-API-KEY-ID": k.keyId,
    "APCA-API-SECRET-KEY": k.secretKey,
  };
  const out = [];
  let token = null;
  for (let page = 0; page < 12 && out.length < want; page++) {
    const q = new URLSearchParams({
      symbols: ticker,
      timeframe: ALPACA_TF[base],
      start: startFor(base, want, Date.UTC(2016, 0, 1)),
      limit: "10000",
      feed: String(k.feed || "iex"),
      adjustment: "split",
      sort: "desc",
    });
    if (token) q.set("page_token", token);
    const j = await getFeed("Alpaca", `${ALPACA}/v2/stocks/bars?${q}`, headers);
    for (const b of j?.bars?.[ticker] || []) {
      const t = Math.floor(Date.parse(b.t) / 1000);
      if (intraday && !inUsSession(t)) continue;
      out.push({
        time: intraday ? t : dayOf(t),
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v || 0,
      });
    }
    token = j?.next_page_token;
    if (!token) break;
  }
  return finish(out, base, tf, limit);
}

// ---------- Polygon / Massive (US stocks) ----------
const POLYGON_TF = {
  "1m": [1, "minute"],
  "5m": [5, "minute"],
  "15m": [15, "minute"],
  "30m": [30, "minute"],
  "1D": [1, "day"],
};

async function polygonPages(firstUrl, want, eachRow) {
  const headers = { Authorization: `Bearer ${polygonCfg().apiKey}` };
  let url = firstUrl,
    n = 0;
  for (let page = 0; url && page < 6 && n < want; page++) {
    const j = await getFeed("Polygon", url, headers);
    for (const r of j?.results || []) if (eachRow(r)) n++;
    // next_url is Polygon's own link to the next page; the key goes in the header, never the URL.
    url =
      j?.next_url && new URL(j.next_url).host === new URL(POLYGON).host
        ? j.next_url
        : null;
  }
}

export async function polygonCandles(ticker, tf, limit) {
  if (!polygonCfg()) throw new Error("No Polygon key in data/feeds.json");
  const base = nativeBase(tf, Object.keys(POLYGON_TF));
  if (!base) throw new Error(`Polygon can't build a ${tf} chart`);
  const intraday = isIntraday(base);
  const ratio = Math.max(
    1,
    Math.round(parseTf(tf).seconds / parseTf(base).seconds),
  );
  const want = Math.min(limit * ratio + ratio, 60000);
  const [mult, span] = POLYGON_TF[base];
  const from = startFor(base, want, Date.UTC(2003, 0, 1));
  const to = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
  const out = [];
  await polygonPages(
    `${POLYGON}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${mult}/${span}/${from}/${to}?adjusted=true&sort=desc&limit=50000`,
    want,
    (r) => {
      const t = Math.floor(r.t / 1000);
      if (intraday && !inUsSession(t)) return false;
      out.push({
        time: intraday ? t : dayOf(t),
        open: r.o,
        high: r.h,
        low: r.l,
        close: r.c,
        volume: r.v || 0,
      });
      return true;
    },
  );
  return finish(out, base, tf, limit);
}

// Sources to try before the public ones for a US stock, in this order.
export function stockChain(ticker, tf, limit) {
  const chain = [];
  if (alpacaCfg())
    chain.push([alpacaName(), () => alpacaCandles(ticker, tf, limit)]);
  if (polygonCfg())
    chain.push(["Polygon", () => polygonCandles(ticker, tf, limit)]);
  return chain;
}

// ---------- Polygon / Massive (CME futures) ----------
// Equity index futures expire on the third Friday of March, June, September and December. Trading
// moves to the next contract 8 days before expiry (CME's roll date), so that's when the front contract changes.
const MONTH_CODES = "FGHJKMNQUVXZ";
const thirdFriday = (y, m) => {
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
  return Date.UTC(y, m, 1 + ((12 - first) % 7) + 14, 13, 30);
};
export function frontContract(root, now = Date.now()) {
  let y = new Date(now).getUTCFullYear();
  for (let k = 0; k < 12; k++) {
    const m = 2 + 3 * (k % 4);
    if (k && k % 4 === 0) y++;
    if (now < thirdFriday(y, m) - 8 * 86400e3) return `${root}${MONTH_CODES[m]}${y % 10}`;
  }
  return null;
}

const FUT_RES = { "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1hour", "1D": "1session" };

export async function polygonFuturesCandles(contract, tf, limit) {
  if (!polygonCfg()) throw new Error("No Polygon key in data/feeds.json");
  const base = nativeBase(tf, Object.keys(FUT_RES));
  if (!base) throw new Error(`Polygon can't build a ${tf} futures chart`);
  const intraday = isIntraday(base);
  const sec = parseTf(base).seconds;
  const ratio = Math.max(1, Math.round(parseTf(tf).seconds / sec));
  const want = Math.min(limit * ratio + ratio, 60000);
  // Futures trade about 23 hours a day, 5 days a week.
  const days = intraday ? Math.ceil(((want * sec) / 82800) * 1.5) + 4 : Math.ceil(want * 1.5) + 5;
  const since = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
  const out = [];
  await polygonPages(
    `${POLYGON}/futures/v1/aggs/${encodeURIComponent(contract)}?resolution=${FUT_RES[base]}&window_start.gte=${since}&sort=window_start.desc&limit=50000`,
    want,
    (r) => {
      const t = intraday
        ? Math.floor(Number(r.window_start) / 1e9)
        : Date.parse(`${r.session_end_date}T00:00:00Z`) / 1000;
      if (!Number.isFinite(t) || r.close == null) return false;
      out.push({ time: t, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume || 0 });
      return true;
    },
  );
  return finish(out, base, tf, limit);
}

// Sources to try before Yahoo's delayed chart for a CME future. The provider name carries the
// contract, so the chart's legend shows which one it is.
export function futuresChain(root, tf, limit) {
  if (!polygonCfg()) return [];
  const contract = frontContract(root);
  return [[`Polygon ${contract}`, () => polygonFuturesCandles(contract, tf, limit)]];
}

// For `npm run doctor`: does each key you added work?
export function probes() {
  const out = {};
  const since = new Date(Date.now() - 10 * 86400e3).toISOString().slice(0, 10);
  const k = alpacaCfg();
  if (k)
    out["Alpaca (your key)"] = () =>
      getFeed(
        "Alpaca",
        `${ALPACA}/v2/stocks/bars?symbols=SPY&timeframe=1Day&limit=1&start=${since}&feed=${encodeURIComponent(k.feed || "iex")}`,
        {
          "APCA-API-KEY-ID": k.keyId,
          "APCA-API-SECRET-KEY": k.secretKey,
        },
      );
  if (polygonCfg())
    out["Polygon (your key)"] = () =>
      getFeed(
        "Polygon",
        `${POLYGON}/v2/aggs/ticker/SPY/range/1/day/${since}/${new Date().toISOString().slice(0, 10)}?limit=1`,
        {
          Authorization: `Bearer ${polygonCfg().apiKey}`,
        },
      );
  return out;
}
