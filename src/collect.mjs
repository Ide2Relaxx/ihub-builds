// Daily collector (run by GitHub Actions, see .github/workflows/collect.yml).
//
// For each region of config.json:
//   1. lists the Challenger, Grandmaster and Master players (league-v4);
//   2. for each player, from where the previous run stopped, lists their
//      ranked solo games of the last days (match-v5 ids);
//   3. downloads each game never analysed before (match + timeline) and adds
//      it to its patch's totals.
// Stops by itself before the job's time limit, saves every 5 minutes.
// Riot key refused → saves what was done, stops, keeps every saved data.
//
// Environment: RIOT_API_KEY (GitHub secret), DATA_DIR (default ./data),
// for tests only: RIOT_BASE, DDRAGON_BASE, MAX_MINUTES.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Riot, RiotKeyError, OutOfTime, RiotUnavailable } from "./riot.mjs";
import { extractGame, itemKinds } from "./extract.mjs";
import { addGame, emptyStats, prune } from "./aggregate.mjs";
import { readJson, writeJson, readSeen, writeSeen, savedPatches } from "./store.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REGIONAL = {
  euw1: "europe", eun1: "europe", tr1: "europe", ru: "europe", me1: "europe",
  na1: "americas", br1: "americas", la1: "americas", la2: "americas",
  kr: "asia", jp1: "asia",
  oc1: "sea", sg2: "sea", tw2: "sea", vn2: "sea",
};
const TIERS = { challenger: "challengerleagues", grandmaster: "grandmasterleagues", master: "masterleagues" };

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
/** Games are remembered by a one-way hash: the public data holds no game id. */
const hashId = (id) => crypto.createHash("sha256").update(id).digest("base64url").slice(0, 12);

export async function run({ env = process.env, fetchImpl = fetch, sleep } = {}) {
  const config = readJson(path.join(ROOT, "config.json"), {});
  const dataDir = path.resolve(env.DATA_DIR ?? path.join(ROOT, "data"));
  const riotBase = env.RIOT_BASE; // tests only
  const ddragon = env.DDRAGON_BASE ?? "https://ddragon.leagueoflegends.com";
  const maxMinutes = Number(env.MAX_MINUTES ?? config.maxMinutes ?? 320);
  const startedAt = Date.now();
  const deadline = startedAt + maxMinutes * 60_000;

  const key = env.RIOT_API_KEY?.trim();
  if (!key) {
    console.log("::error::No RIOT_API_KEY secret: nothing done, saved data untouched.");
    return 1;
  }

  // Saved data (a damaged file stops everything here, before any change).
  const state = readJson(path.join(dataDir, "state.json"), { platforms: {} });
  const seenList = readSeen(path.join(dataDir, "seen.txt"));
  const seen = new Set(seenList);
  const stats = new Map();
  for (const patch of savedPatches(dataDir)) stats.set(patch, readJson(path.join(dataDir, `stats-${patch}.json`), emptyStats(patch)));

  const url = (host, p) => (riotBase ? `${riotBase}/${host}${p}` : `https://${host}.api.riotgames.com${p}`);
  const riot = new Riot(key, { fetchImpl, deadline, log, ...(sleep ? { sleep } : {}) });
  let added = 0;
  let lastSave = Date.now();

  // Data Dragon (Riot's public files, no key): item categories per patch.
  const versions = await (await fetchImpl(`${ddragon}/api/versions.json`)).json();
  const kindsByPatch = new Map();
  async function kindsFor(patch) {
    if (!kindsByPatch.has(patch)) {
      const version = versions.find((v) => v.startsWith(`${patch}.`)) ?? versions[0];
      const items = await (await fetchImpl(`${ddragon}/cdn/${version}/data/en_US/item.json`)).json();
      kindsByPatch.set(patch, itemKinds(items.data));
    }
    return kindsByPatch.get(patch);
  }

  function save(final) {
    const kept = [...stats.keys()].sort((a, b) => {
      const [a1, a2] = a.split(".").map(Number);
      const [b1, b2] = b.split(".").map(Number);
      return b1 - a1 || b2 - a2;
    });
    for (const patch of kept.slice(0, config.patchesKept ?? 3)) writeJson(path.join(dataDir, `stats-${patch}.json`), prune(stats.get(patch)));
    if (final) {
      // Only patches older than the last ones are removed (current builds keep their data).
      for (const old of kept.slice(config.patchesKept ?? 3)) fs.rmSync(path.join(dataDir, `stats-${old}.json`), { force: true });
    }
    writeSeen(path.join(dataDir, "seen.txt"), seenList, config.seenMax ?? 600000);
    writeJson(path.join(dataDir, "state.json"), state);
    lastSave = Date.now();
  }

  let result = "done";
  let exitCode = 0;
  try {
    const platforms = config.platforms ?? ["euw1"];
    for (const [index, platform] of platforms.entries()) {
      const regional = REGIONAL[platform];
      if (!regional) {
        log(`Unknown region "${platform}", skipped.`);
        continue;
      }
      // Each region gets its share of the remaining time.
      const share = (deadline - Date.now()) / (platforms.length - index);
      const regionDeadline = Date.now() + share;
      const saved = (state.platforms[platform] ??= { cursor: 0 });

      // 1. High-elo players, best first.
      const players = [];
      for (const tier of config.tiers ?? Object.keys(TIERS)) {
        const league = await riot.get(url(platform, `/lol/league/v4/${TIERS[tier]}/by-queue/RANKED_SOLO_5x5`));
        for (const e of league?.entries ?? []) if (e.puuid) players.push([e.leaguePoints ?? 0, e.puuid, tier]);
      }
      players.sort((a, b) => (tier(b[2]) - tier(a[2])) || b[0] - a[0]);
      log(`${platform}: ${players.length} players.`);
      if (!players.length) continue;

      // 2-3. Their games, from where the last run stopped.
      const since = Math.floor((Date.now() - (config.lookbackDays ?? 3) * 86_400_000) / 1000);
      let cursor = saved.cursor % players.length;
      for (let done = 0; done < players.length && Date.now() < regionDeadline; done++) {
        const puuid = players[cursor][1];
        const ids = (await riot.get(url(regional, `/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&type=ranked&startTime=${since}&count=100`))) ?? [];
        for (const id of ids) {
          if (Date.now() >= regionDeadline) break;
          const h = hashId(id);
          if (seen.has(h)) continue;
          const match = await riot.get(url(regional, `/lol/match/v5/matches/${id}`));
          const quick = match ? extractGame(match, null, new Map()) : null;
          if (quick) {
            const timeline = await riot.get(url(regional, `/lol/match/v5/matches/${id}/timeline`));
            if (!timeline) continue; // try again another day
            const game = extractGame(match, timeline, await kindsFor(quick.patch));
            if (!stats.has(game.patch)) stats.set(game.patch, emptyStats(game.patch));
            addGame(stats.get(game.patch), game);
            added++;
          }
          seen.add(h);
          seenList.push(h);
          if (Date.now() - lastSave > 5 * 60_000) {
            save(false);
            log(`${added} games added, ${riot.requests} requests.`);
          }
        }
        cursor = (cursor + 1) % players.length;
        saved.cursor = cursor;
      }
    }
  } catch (e) {
    if (e instanceof OutOfTime) {
      result = "time budget used";
    } else if (e instanceof RiotKeyError) {
      result = "key refused";
      exitCode = 1;
      console.log(`::error::${e.message} Saved data kept.`);
    } else if (e instanceof RiotUnavailable) {
      result = `Riot unavailable (${e.message})`;
      console.log(`::warning::${e.message} Saved data kept, next run tomorrow.`);
    } else {
      throw e;
    }
  }
  save(true);
  const summary = { startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(), result, gamesAdded: added, requests: riot.requests };
  writeJson(path.join(dataDir, "last-run.json"), summary);
  log(`End: ${result}. ${added} games added, ${riot.requests} requests.`);
  return exitCode;
}

function tier(name) {
  return { challenger: 3, grandmaster: 2, master: 1 }[name] ?? 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().then(
    (code) => process.exit(code),
    (e) => {
      console.log(`::error::${e.message}`);
      process.exit(1);
    },
  );
}
