// Step 3: turns the totals (data/stats-<patch>.json) into the published files
// (public/builds-<patch>.json + public/index.json), read by I-Hub.
//
// Per champion and role, for each category (starting items, core items in
// order, boots, runes, summoner spells, skill start, skill max order):
//   best    = best win rate among options with enough games (config:
//             minOptionGames, and minOptionShare of the role's games), so a
//             "100 %" on 3 games never wins;
//   popular = the most played option;
//   options = the 5 most played, each [key, games, wins].
// Situational items: the 8 most bought after the core, with games and wins.
// "low": fewer games than minRoleGames → I-Hub shows a warning and, on a
// new patch, the previous patch's build.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES } from "./aggregate.mjs";
import { readJson, writeJson, savedPatches } from "./store.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/** Roles with fewer games than this aren't published at all (noise). */
const MIN_PUBLISHED = 10;

export function pickOptions(map, roleGames, config) {
  const entries = Object.entries(map ?? {}).map(([key, [g, w]]) => [key, g, w]);
  if (!entries.length) return null;
  const byGames = [...entries].sort((a, b) => b[1] - a[1] || b[2] - a[2]);
  const threshold = Math.max(config.minOptionGames ?? 20, Math.ceil((config.minOptionShare ?? 0.03) * roleGames));
  const qualified = entries.filter((e) => e[1] >= threshold);
  const best = qualified.sort((a, b) => b[2] / b[1] - a[2] / a[1] || b[1] - a[1])[0] ?? null;
  return { best, popular: byGames[0], options: byGames.slice(0, 5) };
}

export function buildPatch(stats, config, updatedAt) {
  const champions = {};
  for (const [champion, roles] of Object.entries(stats.champions ?? {})) {
    for (const [role, s] of Object.entries(roles)) {
      const [games, wins] = s.n;
      if (games < MIN_PUBLISHED) continue;
      const out = { games, wins, low: games < (config.minRoleGames ?? 150) };
      for (const c of CATEGORIES) {
        if (c === "items") continue;
        out[c] = pickOptions(s[c], games, config);
      }
      out.items = Object.entries(s.items ?? {})
        .map(([key, [g, w]]) => [Number(key), g, w])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);
      (champions[champion] ??= {})[role] = out;
    }
  }
  return { v: 1, patch: stats.patch, updatedAt, games: stats.games, minRoleGames: config.minRoleGames ?? 150, champions };
}

export function buildAll({ dataDir, outDir, config, now = new Date() }) {
  const updatedAt = now.toISOString();
  const lastRun = readJson(path.join(dataDir, "last-run.json"), null);
  const patches = [];
  fs.mkdirSync(outDir, { recursive: true });
  for (const patch of savedPatches(dataDir).slice(0, config.patchesKept ?? 3)) {
    const stats = readJson(path.join(dataDir, `stats-${patch}.json`), null);
    if (!stats) continue;
    const file = `builds-${patch}.json`;
    writeJson(path.join(outDir, file), buildPatch(stats, config, updatedAt));
    patches.push({ patch, games: stats.games, file });
  }
  const index = { v: 1, updatedAt, lastRun, patches };
  writeJson(path.join(outDir, "index.json"), index);
  return index;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const config = readJson(path.join(ROOT, "config.json"), {});
  const index = buildAll({
    dataDir: path.resolve(process.env.DATA_DIR ?? path.join(ROOT, "data")),
    outDir: path.resolve(process.env.OUT_DIR ?? path.join(ROOT, "public")),
    config,
  });
  console.log(`Published: ${index.patches.map((p) => `${p.patch} (${p.games} games)`).join(", ") || "nothing yet"}.`);
}
