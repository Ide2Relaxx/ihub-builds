// Totals per patch, champion and role: for every option (starting items, core,
// boots, situational items, runes, spells, skill order) the number of games
// and wins. Only totals are kept: never a player or a game id.
//
// stats = { patch, games, champions: { "<championId>": { "<ROLE>": {
//   n: [games, wins], start: { key: [g, w] }, core, boots, items, runes,
//   spells, skillStart, skillMax } } } }

export const CATEGORIES = ["start", "core", "boots", "items", "runes", "spells", "skillStart", "skillMax"];
/** Options kept per category (the rarest are dropped when saving). */
const KEEP = 120;

export function emptyStats(patch) {
  return { patch, games: 0, champions: {} };
}

function add(map, key, win) {
  if (key === null || key === undefined || key === "") return;
  const k = String(key);
  const c = map[k] ?? (map[k] = [0, 0]);
  c[0]++;
  if (win) c[1]++;
}

/** Adds one game (output of extractGame) to the patch's totals. */
export function addGame(stats, game) {
  stats.games++;
  for (const p of game.players) {
    const champion = stats.champions[p.champion] ?? (stats.champions[p.champion] = {});
    const s = champion[p.role] ?? (champion[p.role] = Object.fromEntries([["n", [0, 0]], ...CATEGORIES.map((c) => [c, {}])]));
    s.n[0]++;
    if (p.win) s.n[1]++;
    add(s.start, p.start, p.win);
    add(s.core, p.core, p.win);
    add(s.boots, p.boots, p.win);
    for (const item of p.situational ?? []) add(s.items, item, p.win);
    add(s.runes, p.runes, p.win);
    add(s.spells, p.spells, p.win);
    add(s.skillStart, p.skillStart, p.win);
    add(s.skillMax, p.skillMax, p.win);
  }
}

/** Keeps the KEEP most played options per category (keeps the files small). */
export function prune(stats) {
  for (const roles of Object.values(stats.champions)) {
    for (const s of Object.values(roles)) {
      for (const c of CATEGORIES) {
        const entries = Object.entries(s[c] ?? {});
        if (entries.length > KEEP) s[c] = Object.fromEntries(entries.sort((a, b) => b[1][0] - a[1][0]).slice(0, KEEP));
      }
    }
  }
  return stats;
}
