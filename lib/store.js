// Everything you save (layouts, watchlists, drawings, alerts, paper account) lives in ./data as
// plain JSON files you own. Writes go to a temp file first so a crash can't corrupt them.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR =
  process.env.QT_DATA_DIR ||
  (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
    ? path.join(os.tmpdir(), "qt-data")
    : path.join(root, "data"));

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {
  // Read-only filesystem on serverless
}

export function read(name, fallback) {
  try {
    const file = path.join(DATA_DIR, `${name}.json`);
    if (!fs.existsSync(file)) {
      const seed = path.join(root, "data", `${name}.json`);
      if (fs.existsSync(seed)) {
        return JSON.parse(fs.readFileSync(seed, "utf8"));
      }
    }
    return JSON.parse(
      fs.readFileSync(file, "utf8"),
    );
  } catch {
    return fallback;
  }
}

export function write(name, value) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
  const file = path.join(DATA_DIR, `${name}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  const text = JSON.stringify(value, null, 2);
  try {
    fs.writeFileSync(tmp, text);
    try {
      fs.renameSync(tmp, file);
    } catch (e) {
      // Windows refuses to rename over a file that antivirus or the indexer has open.
      // Fall back to writing in place rather than losing the save.
      if (!["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      fs.writeFileSync(file, text);
      fs.rmSync(tmp, { force: true });
    }
  } catch (err) {
    console.warn("store.write failed:", err.message);
  }
}