// Set writable data dir for Vercel serverless (read-only filesystem except /tmp)
process.env.QT_DATA_DIR = process.env.QT_DATA_DIR || '/tmp/qt-data';

// Vercel serverless entry-point for all /api/* routes.
// Re-uses route handler logic extracted from server.js.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as data from "../lib/providers.js";
import * as feeds from "../lib/feeds.js";
import * as imports from "../lib/imports.js";
import * as alerts from "../lib/alerts.js";
import * as store from "../lib/store.js";
import * as ptq from "../lib/ptq.js";
import * as info from "../lib/market-info.js";
import { registerIndicator, INDICATORS } from "../public/lib/indicators.js";
import { conditionFn, backtest, magnifierTf } from "../public/lib/backtest.js";
import { quantChecks } from "../public/lib/quant.js";
import { parseTf } from "../public/lib/series.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CUSTOM = path.join(ROOT, "custom");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

const httpError = (status, message) => Object.assign(new Error(message), { status });

function send(res, status, body) {
  const isStr = typeof body === "string" || Buffer.isBuffer(body);
  res.status(status);
  res.setHeader("Cache-Control", "no-store");
  if (isStr) { res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.end(body); }
  else { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); }
}

async function readBody(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error("Request too large"), { status: 413 })); return; } chunks.push(c); });
    req.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); if (!text) return resolve({}); try { const body = JSON.parse(text); if (!body || typeof body !== "object" || Array.isArray(body)) return reject(httpError(400, "The request body must be a JSON object")); resolve(body); } catch { reject(httpError(400, "The request body isn't valid JSON")); } });
    req.on("error", reject);
  });
}

async function readText(req, limit = 300e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(httpError(413, `The file is over ${Math.round(limit / 1e6)} MB`)); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "indicator";
const customErrors = {};

function listCustom() {
  try { fs.mkdirSync(CUSTOM, { recursive: true }); } catch {}
  try {
    return fs.readdirSync(CUSTOM).filter((f) => f.endsWith(".js")).map((f) => ({ file: f, id: `custom:${f.replace(/\.js$/, "")}`, mtime: fs.statSync(path.join(CUSTOM, f)).mtimeMs, error: customErrors[f] || null }));
  } catch { return []; }
}

async function loadCustom(file) {
  try {
    const full = path.join(CUSTOM, file);
    const mod = await import(`${new URL(`file://${full}`).href}?v=${fs.statSync(full).mtimeMs}`);
    registerIndicator({ ...mod.default, id: `custom:${file.replace(/\.js$/, "")}` });
    delete customErrors[file];
  } catch (e) { customErrors[file] = e.message; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-qt");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const url = new URL(req.url, `https://${req.headers.host}`);
  let p; try { p = decodeURIComponent(url.pathname); } catch { return send(res, 400, "Bad URL"); }
  const q = Object.fromEntries(url.searchParams);

  try {
    if (p === "/api/health") return send(res, 200, { ok: true, app: "quant-terminal", version: VERSION, node: process.version, platform: process.platform, providers: data.health, feeds: feeds.configured(), alerts: alerts.list().filter((a) => a.active).length });
    if (p === "/api/probe") return send(res, 200, await data.probeAll());
    if (p === "/api/resolve") return send(res, 200, await data.resolve(q.symbol));
    if (p === "/api/search") return send(res, 200, await data.search(q.q));
    if (p === "/api/spread") return send(res, 200, await data.getSpread(q.symbol));
    if (p === "/api/candles") return send(res, 200, await data.getCandles(q.symbol, q.tf || "1D", q.limit));
    if (p === "/api/quotes") return send(res, 200, await data.getQuotes((q.symbols || "").split(",").filter(Boolean).slice(0, 200)));
    if (p === "/api/calendar") return send(res, 200, await data.economicCalendar());
    if (p === "/api/earnings") return send(res, 200, await info.earnings(Number(q.days) || 5));
    if (p === "/api/dividends") return send(res, 200, await info.dividends(Number(q.days) || 5));
    if (p === "/api/news") return send(res, 200, await info.news(q.symbol));
    if (p === "/api/financials") return send(res, 200, await info.financials(q.symbol, q.frequency));
    if (p === "/api/screener") { const u = q.universe || "crypto"; const rows = u === "crypto" ? await data.cryptoScreener() : await data.nasdaqScreener(u === "etf" ? "etf" : "stocks"); return send(res, 200, rows); }
    if (p === "/api/indicators") return send(res, 200, INDICATORS.map((d) => ({ id: d.id, name: d.name, inputs: (d.inputs || []).map(({ key, type, default: def, options }) => ({ key, type, default: def, ...(options ? { options } : {}) })), outputs: (d.outputs || []).map((o) => o.key) })));
    if (p === "/api/state") {
      if (req.method === "GET") return send(res, 200, store.read("state", {}));
      if (req.method === "PUT") { const patch = await readBody(req, 20e6); const next = { ...store.read("state", {}), ...patch }; store.write("state", next); return send(res, 200, { ok: true }); }
    }
    if (p === "/api/events") { res.setHeader("Content-Type", "text/event-stream"); res.setHeader("Cache-Control", "no-cache"); res.status(200); res.end("retry: 3000\n\n"); return; }
    if (p === "/api/alerts") {
      if (req.method === "GET") return send(res, 200, alerts.list());
      if (req.method === "POST") return send(res, 200, alerts.add(await readBody(req)));
    }
    if (p === "/api/alerts/log") return send(res, 200, alerts.history());
    if (p === "/api/alerts/check" && req.method === "POST") { await alerts.evaluate(); return send(res, 200, { ok: true }); }
    if (p.startsWith("/api/alerts/")) { const id = p.split("/")[3]; if (req.method === "DELETE") { alerts.remove(id); return send(res, 200, { ok: true }); } if (req.method === "PATCH") return send(res, 200, alerts.update(id, await readBody(req))); }
    if (p === "/api/custom") {
      if (req.method === "GET") return send(res, 200, listCustom());
      if (req.method === "POST") { const { name, code } = await readBody(req); if (!code || !/export\s+default/.test(code)) throw Object.assign(new Error("The file must export default { name, calc(bars, params, ta) { ... } }"), { status: 400 }); const file = `${slug(name)}.js`; const full = path.join(CUSTOM, file); fs.mkdirSync(CUSTOM, { recursive: true }); const before = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null; fs.writeFileSync(full, code); await loadCustom(file); const error = customErrors[file]; if (error) { if (before == null) fs.rmSync(full, { force: true }); else fs.writeFileSync(full, before); delete customErrors[file]; return send(res, 400, { error, file }); } return send(res, 200, { ok: true, file, id: `custom:${file.replace(/\.js$/, "")}` }); }
    }
    if (p.startsWith("/api/custom/") && req.method === "DELETE") { fs.rmSync(path.join(CUSTOM, path.basename(p.slice(12))), { force: true }); return send(res, 200, { ok: true }); }
    if (p === "/api/ptq/status") return send(res, 200, await ptq.status());
    if (p === "/api/ptq/overview") return send(res, 200, await ptq.overview());
    if (p === "/api/ptq/kill-switch" && req.method === "POST") return send(res, 200, await ptq.engageKillSwitch());
    const disarmMatch = /^\/api\/ptq\/arms\/([^/]+)\/disarm$/.exec(p);
    if (disarmMatch && req.method === "POST") return send(res, 200, await ptq.disarm(decodeURIComponent(disarmMatch[1])));
    return send(res, 404, { error: "Unknown endpoint" });
  } catch (e) {
    const code = e.upstream ? 502 : e.status >= 400 && e.status < 600 ? e.status : 500;
    return send(res, code, { error: e.message });
  }
}
