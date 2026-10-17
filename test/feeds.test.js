// Your own data keys (data/feeds.json), with a fake network: no live calls and no real keys.
// Viewers asked to plug in their own feed instead of the free public sources (YouTube, Oct 2026).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.QT_TIMEOUT_MS = "300";
process.env.QT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "qt-feeds-"));
const FILE = path.join(process.env.QT_DATA_DIR, "feeds.json");
let stamp = Date.now() / 1000;
function writeFeeds(obj) {
  if (obj == null) fs.rmSync(FILE, { force: true });
  else {
    fs.writeFileSync(FILE, JSON.stringify(obj));
    stamp += 5; // a clearly newer mtime, whatever the file system's clock resolution
    fs.utimesSync(FILE, stamp, stamp);
  }
}
const KEYS = {
  keyId: "PKTESTKEYID",
  secretKey: "TESTSECRET",
  apiKey: "POLYTESTKEY",
};

// 5-minute bars for one day, 08:00 to 19:55 New York (EDT, UTC-4): pre-market, the session, after hours.
const DAY = Date.UTC(2026, 9, 14) / 1000;
const fiveMin = Array.from(
  { length: 144 },
  (_, i) => DAY + 12 * 3600 + i * 300,
);
const bar = (t, k) => ({
  o: 100 + k,
  h: 101 + k,
  l: 99 + k,
  c: 100.5 + k,
  v: 1000 + k,
});

let alpacaStatus = 200;
let polygonFuturesStatus = 200;
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  calls.push({ host: u.host, url: String(url), headers: opts.headers || {} });
  if (u.host === "data.alpaca.markets") {
    if (alpacaStatus !== 200)
      return Response.json({ message: "forbidden." }, { status: alpacaStatus });
    const sym = u.searchParams.get("symbols");
    const tf = u.searchParams.get("timeframe");
    let rows;
    if (tf === "1Day")
      rows = Array.from({ length: 30 }, (_, i) => ({
        t: new Date((DAY - i * 86400 + 4 * 3600) * 1000).toISOString(),
        ...bar(0, i),
      }));
    else
      rows = fiveMin
        .map((t, i) => ({ t: new Date(t * 1000).toISOString(), ...bar(t, i) }))
        .reverse();
    assert.equal(u.searchParams.get("sort"), "desc");
    const page2 = u.searchParams.get("page_token") === "p2";
    const half = Math.ceil(rows.length / 2);
    return Response.json({
      bars: { [sym]: page2 ? rows.slice(half) : rows.slice(0, half) },
      next_page_token: page2 ? null : "p2",
    });
  }
  if (u.host === "api.massive.com" && u.pathname.startsWith("/futures/")) {
    if (polygonFuturesStatus !== 200) return Response.json({ status: "NOT_AUTHORIZED" }, { status: polygonFuturesStatus });
    assert.equal(u.searchParams.get("sort"), "window_start.desc");
    const rows = fiveMin
      .map((t, i) => ({ window_start: t * 1e9, open: 20000 + i, high: 20001 + i, low: 19999 + i, close: 20000.5 + i, volume: 50 }))
      .reverse();
    return Response.json({ results: rows, status: "OK" });
  }
  if (u.host === "query1.finance.yahoo.com") {
    const ts = fiveMin;
    return Response.json({
      chart: {
        result: [
          {
            meta: { gmtoffset: -14400 },
            timestamp: ts,
            indicators: { quote: [{ open: ts.map(() => 25000), high: ts.map(() => 25010), low: ts.map(() => 24990), close: ts.map(() => 25005), volume: ts.map(() => 7) }] },
          },
        ],
      },
    });
  }
  if (u.host === "api.massive.com") {
    const rows = fiveMin
      .map((t, i) => ({ t: t * 1000, ...bar(t, i) }))
      .reverse();
    return Response.json({ results: rows, status: "OK" });
  }
  return new Response("not mocked", { status: 404 });
};
const P = await import("../lib/providers.js");
const F = await import("../lib/feeds.js");

const leaks = () =>
  calls.filter((c) => {
    const sentTo = c.host;
    const carries = JSON.stringify(c.headers) + c.url;
    const own =
      {
        "data.alpaca.markets": [KEYS.keyId, KEYS.secretKey],
        "api.massive.com": [KEYS.apiKey],
      }[sentTo] || [];
    return Object.values(KEYS).some(
      (k) => carries.includes(k) && !own.includes(k),
    );
  });

test("with no feeds.json, stock charts use only the public sources", async () => {
  writeFeeds(null);
  assert.deepEqual(F.configured(), []);
  assert.equal(F.stockChain("AAPL", "1D", 100).length, 0);
});

test("an Alpaca key takes over US stock charts: session bars only, keys in headers only", async () => {
  writeFeeds({ alpaca: { keyId: KEYS.keyId, secretKey: KEYS.secretKey } });
  calls.length = 0;
  const r = await P.getCandles("US:AAPL", "5m", 50);
  assert.equal(r.provider, "Alpaca (IEX)");
  assert.equal(r.candles.length, 50);
  assert.ok(
    r.candles.every((b) => F.inUsSession(b.time)),
    "pre-market and after-hours bars are left out",
  );
  assert.equal(
    r.candles.at(-1).time,
    DAY + 19 * 3600 + 55 * 60,
    "last bar is 15:55 New York",
  );
  for (let i = 1; i < r.candles.length; i++)
    assert.ok(r.candles[i].time > r.candles[i - 1].time);
  assert.ok(
    r.notes.some((n) => /IEX/.test(n)),
    "the chart says it's the IEX feed",
  );
  const alpaca = calls.filter((c) => c.host === "data.alpaca.markets");
  assert.equal(alpaca.length, 2, "follows Alpaca's next_page_token");
  assert.equal(alpaca[0].headers["APCA-API-KEY-ID"], KEYS.keyId);
  assert.ok(
    alpaca.every(
      (c) => !c.url.includes(KEYS.secretKey) && !c.url.includes(KEYS.keyId),
    ),
    "keys never go in the URL",
  );
  assert.deepEqual(leaks(), []);
  assert.equal(
    JSON.stringify(F.configured()),
    '["alpaca"]',
    "health lists names, never keys",
  );
});

test("daily bars from a key land on the trading date at UTC midnight, like the public sources", async () => {
  const r = await P.getCandles("US:MSFT", "1D", 20);
  assert.equal(r.provider, "Alpaca (IEX)");
  assert.ok(r.candles.every((b) => b.time % 86400 === 0));
  assert.equal(r.candles.at(-1).time, DAY);
});

test("weekly charts are built from the key's daily bars", async () => {
  const r = await P.getCandles("US:NVDA", "1W", 3);
  assert.equal(r.provider, "Alpaca (IEX)");
  assert.ok(r.candles.length >= 3);
});

test("a refused Alpaca key falls back to Polygon, and the chart says why in plain words", async () => {
  writeFeeds({
    alpaca: { keyId: KEYS.keyId, secretKey: KEYS.secretKey },
    polygon: { apiKey: KEYS.apiKey },
  });
  alpacaStatus = 401;
  calls.length = 0;
  const r = await P.getCandles("US:TSLA", "15m", 10);
  assert.equal(r.provider, "Polygon");
  assert.ok(r.candles.length > 0);
  assert.ok(r.candles.every((b) => F.inUsSession(b.time)));
  assert.ok(
    r.notes.includes("Alpaca refused your key, so this chart uses Polygon."),
    r.notes.join(" | "),
  );
  assert.doesNotMatch(r.notes.join(" "), /HTTP|401|\.com/);
  const poly = calls.find((c) => c.host === "api.massive.com");
  assert.equal(poly.headers.Authorization, `Bearer ${KEYS.apiKey}`);
  assert.ok(
    !poly.url.includes(KEYS.apiKey),
    "the Polygon key goes in a header, not the URL",
  );
  assert.deepEqual(leaks(), []);
  // A refused key rests for a minute instead of being asked again on every chart.
  calls.length = 0;
  await P.getCandles("US:AMD", "15m", 10);
  assert.equal(calls.filter((c) => c.host === "data.alpaca.markets").length, 0);
});

test("a broken feeds.json leaves the public sources working", async () => {
  fs.writeFileSync(FILE, "{ not json");
  stamp += 5;
  fs.utimesSync(FILE, stamp, stamp);
  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(m);
  try {
    assert.deepEqual(F.configured(), []);
  } finally {
    console.error = orig;
  }
  assert.ok(errors.some((m) => /feeds\.json/.test(m)));
});

// ---------- CME futures (NQ, MNQ, ES, MES) ----------
test("the front contract rolls 8 days before the third Friday of each quarter month", () => {
  const at = (d) => F.frontContract("NQ", Date.parse(d));
  assert.equal(at("2026-10-15T12:00:00Z"), "NQZ6");
  assert.equal(at("2026-12-09T12:00:00Z"), "NQZ6");
  assert.equal(at("2026-12-10T14:00:00Z"), "NQH7", "Dec 2026 expires Fri 18th, so it rolls Thu 10th");
  assert.equal(at("2027-03-12T12:00:00Z"), "NQM7");
  assert.equal(F.frontContract("MNQ", Date.parse("2026-01-02T12:00:00Z")), "MNQH6");
});

test("NQ, MNQ, ES and MES resolve and search as CME futures", async () => {
  for (const [typed, id] of [
    ["NQ", "CME:NQ1!"],
    ["nq1!", "CME:NQ1!"],
    ["MNQ", "CME:MNQ1!"],
    ["CME_MINI:NQ1!", "CME:NQ1!"],
    ["CME:ES1!", "CME:ES1!"],
    ["MES1!", "CME:MES1!"],
  ])
    assert.equal((await P.resolve(typed)).id, id, typed);
  assert.equal((await P.search("MNQ"))[0].symbol, "CME:MNQ1!");
  const es = await P.search("ES");
  assert.equal(es[0].symbol, "CME:ES1!");
  assert.equal(es[0].type, "futures");
});

test("without a Polygon key, futures chart Yahoo's delayed feed and say so", async () => {
  writeFeeds(null);
  const r = await P.getCandles("NQ1!", "5m", 30);
  assert.equal(r.provider, "Yahoo (delayed)");
  assert.equal(r.candles.length, 30);
  assert.ok(r.notes.some((n) => /^Delayed about 10 minutes/.test(n)), r.notes.join(" | "));
});

test("with a Polygon key, futures chart the live front contract, key in a header", async () => {
  writeFeeds({ polygon: { apiKey: KEYS.apiKey } });
  calls.length = 0;
  const r = await P.getCandles("CME:MNQ1!", "15m", 20);
  const contract = F.frontContract("MNQ");
  assert.equal(r.provider, `Polygon ${contract}`);
  assert.ok(r.candles.length > 0 && r.candles.length <= 20);
  assert.ok(r.notes.some((n) => n.includes(`Front contract ${contract}`)), r.notes.join(" | "));
  const c = calls.find((x) => x.url.includes("/futures/v1/aggs/"));
  assert.ok(c.url.includes(`/futures/v1/aggs/${contract}?`), c.url);
  assert.equal(c.headers.Authorization, `Bearer ${KEYS.apiKey}`);
  assert.deepEqual(leaks(), []);
});

test("a Polygon plan without futures falls back to the delayed chart, in plain words", async () => {
  polygonFuturesStatus = 403;
  const r = await P.getCandles("CME:ES1!", "1h", 20);
  assert.equal(r.provider, "Yahoo (delayed)");
  assert.ok(r.notes.includes("Your Polygon plan doesn't include this, so this chart uses Yahoo (delayed)."), r.notes.join(" | "));
  polygonFuturesStatus = 200;
});
