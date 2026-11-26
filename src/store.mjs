// Saved data (the "data" branch of the repository, checked out in ./data):
//   state.json         players' order and the games waiting, per region
//   seen.txt           ids of the games already analysed (never analysed twice)
//   stats-<patch>.json totals per champion and role (aggregate.mjs)
//
// A file that exists but can't be read stops the collector: it is never
// replaced by an empty one (no data is ever lost).

import fs from "node:fs";
import path from "node:path";

export function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const text = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${path.basename(file)} is damaged (${e.message}): stopping without touching the data.`);
  }
}

/** Writes through a temporary file, so a crash never leaves a half-written file. */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

export function readSeen(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
}

export function writeSeen(file, ids, max) {
  const kept = ids.length > max ? ids.slice(ids.length - max) : ids;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, kept.join("\n") + "\n");
  fs.renameSync(tmp, file);
}

/** Patches saved, newest first ("16.23" before "16.9"). */
export function savedPatches(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((f) => /^stats-(\d+\.\d+)\.json$/.exec(f)?.[1])
    .filter(Boolean)
    .sort(comparePatches);
}

export function comparePatches(a, b) {
  const [a1, a2] = a.split(".").map(Number);
  const [b1, b2] = b.split(".").map(Number);
  return b1 - a1 || b2 - a2;
}
