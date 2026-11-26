// Run with: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseLimits, waitNeeded, Riot, RiotKeyError } from "../src/riot.mjs";
import { extractGame, itemKinds, maxOrder, patchOf } from "../src/extract.mjs";
import { addGame, emptyStats } from "../src/aggregate.mjs";
import { pickOptions, buildAll } from "../src/build.mjs";
import { run } from "../src/collect.mjs";
import { ITEMS, makeMatch, makeTimeline, fakeRiot } from "./fixtures.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ihub-collector-"));

test("reads the key's limits from Riot (dev and personal keys alike)", () => {
  assert.deepEqual(parseLimits("20:1,100:120"), [[18, 1000], [90, 120000]]);
  assert.deepEqual(parseLimits("500:10,30000:600"), [[450, 10000], [27000, 600000]]);
  assert.equal(parseLimits(""), null);
  assert.equal(parseLimits("x,0:1"), null);
  // 90 requests in the last 100 s: the next one waits 20 s.
  const sent = Array.from({ length: 90 }, (_, i) => i * 1000);
  assert.equal(waitNeeded(sent, [[90, 120000]], 100000), 20000);
  assert.equal(waitNeeded([], [[18, 1000]], 0), 0);
});

test("waits on 429, stops on a refused key", async () => {
  const waits = [];
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 1) return { ok: false, status: 429, headers: new Map([["retry-after", "7"]]), json: async () => ({}) };
    return { ok: true, status: 200, headers: new Map([["x-app-rate-limit", "20:1,100:120"]]), json: async () => ({ fine: true }) };
  };
  const riot = new Riot("k", { fetchImpl, sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(await riot.get("https://europe.api.riotgames.com/x"), { fine: true });
  assert.ok(waits.includes(7000));
  assert.deepEqual(riot.bucket("europe.api.riotgames.com").limits, [[18, 1000], [90, 120000]]);

  const refused = new Riot("k", { fetchImpl: async () => ({ ok: false, status: 401, headers: new Map(), json: async () => ({}) }) });
  await assert.rejects(refused.get("https://euw1.api.riotgames.com/x"), RiotKeyError);
});

test("extracts a game's builds without any player id", () => {
  const game = extractGame(makeMatch("EUW1_1"), makeTimeline(), itemKinds(ITEMS));
  assert.equal(game.patch, "16.23");
  assert.equal(game.players.length, 10);
  const p = game.players[0];
  assert.deepEqual(
    { champion: p.champion, role: p.role, win: p.win, start: p.start, core: p.core, situational: p.situational, boots: p.boots, spells: p.spells, skillStart: p.skillStart, skillMax: p.skillMax },
    { champion: 100, role: "TOP", win: true, start: "1055-2003", core: "6672-3031-3153", situational: [3036], boots: 3006, spells: "4,14", skillStart: "QWE", skillMax: "QEW" },
  );
  assert.equal(p.runes, "8000:8008,9111,9104,8014|8300:8304,8345|5005,5008,5011");
  assert.ok(!JSON.stringify(game).includes("secret"), "no puuid or name kept");
  // Games that don't count.
  assert.equal(extractGame(makeMatch("x", { queue: 440 }), makeTimeline(), new Map()), null);
  assert.equal(extractGame(makeMatch("x", { duration: 200 }), makeTimeline(), new Map()), null);
  assert.equal(extractGame(makeMatch("x", { surrender: true }), makeTimeline(), new Map()), null);
  assert.equal(patchOf("16.9.1.2"), "16.9");
  assert.equal(maxOrder(["Q", "W", "E"]), null);
});

test("best option needs enough games: no fake 100 % on 3 games", () => {
  const map = { lucky: [3, 3], solid: [200, 110], popular: [500, 250] };
  const r = pickOptions(map, 800, { minOptionGames: 20, minOptionShare: 0.03 });
  assert.equal(r.best[0], "solid");
  assert.equal(r.popular[0], "popular");
  assert.equal(r.options.length, 3);
  assert.equal(pickOptions({ few: [5, 5] }, 10, { minOptionGames: 20 }).best, null);
});

test("collects, never analyses a game twice, keeps data when the key is refused", async () => {
  const dir = tmp();
  const env = { RIOT_API_KEY: "RGAPI-test", DATA_DIR: dir, RIOT_BASE: "http://riot.test", DDRAGON_BASE: "http://dd.test", MAX_MINUTES: "5" };
  const games = { EUW1_1: {}, EUW1_2: { blueWins: false }, EUW1_3: { patch: "16.22" }, EUW1_4: { queue: 440 } };

  const calls1 = [];
  assert.equal(await run({ env, fetchImpl: fakeRiot({ games, calls: calls1 }) }), 0);
  const stats = JSON.parse(fs.readFileSync(path.join(dir, "stats-16.23.json"), "utf8"));
  assert.equal(stats.games, 2);
  assert.deepEqual(stats.champions["100"].TOP.n, [2, 1]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "stats-16.22.json"), "utf8")).games, 1);
  const seen = fs.readFileSync(path.join(dir, "seen.txt"), "utf8");
  assert.equal(seen.trim().split("\n").length, 4);
  assert.ok(!seen.includes("EUW1_"), "game ids are only kept as hashes");
  for (const f of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, f), "utf8").includes("puuid"), `no player id in ${f}`);

  // Second day: same games listed again → nothing downloaded twice.
  const calls2 = [];
  assert.equal(await run({ env, fetchImpl: fakeRiot({ games, calls: calls2 }) }), 0);
  assert.equal(calls2.filter((u) => /\/matches\/EUW1_\d+$/.test(u)).length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "stats-16.23.json"), "utf8")).games, 2);

  // Key expired: stops with an error, every file stays as it was.
  const before = Object.fromEntries(fs.readdirSync(dir).filter((f) => f !== "last-run.json").map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));
  assert.equal(await run({ env, fetchImpl: fakeRiot({ games, refuseKey: true }) }), 1);
  for (const [f, text] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(dir, f), "utf8"), text, `${f} unchanged`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "last-run.json"), "utf8")).result, "key refused");

  // No key at all: nothing touched.
  assert.equal(await run({ env: { ...env, RIOT_API_KEY: "" }, fetchImpl: fakeRiot({ games }) }), 1);

  // A damaged file is never replaced by an empty one.
  fs.writeFileSync(path.join(dir, "stats-16.23.json"), "{broken");
  await assert.rejects(run({ env, fetchImpl: fakeRiot({ games }) }), /damaged/);
  assert.equal(fs.readFileSync(path.join(dir, "stats-16.23.json"), "utf8"), "{broken");
});

test("publishes one compact file per patch and an index", () => {
  const dir = tmp();
  const out = tmp();
  const stats = emptyStats("16.23");
  const kinds = itemKinds(ITEMS);
  for (let i = 0; i < 30; i++) addGame(stats, extractGame(makeMatch(`g${i}`, { blueWins: i % 3 !== 0 }), makeTimeline(), kinds));
  fs.writeFileSync(path.join(dir, "stats-16.23.json"), JSON.stringify(stats));
  const index = buildAll({ dataDir: dir, outDir: out, config: { minRoleGames: 150, minOptionGames: 20 }, now: new Date("2026-11-26T04:00:00Z") });
  assert.deepEqual(index.patches, [{ patch: "16.23", games: 30, file: "builds-16.23.json" }]);
  const builds = JSON.parse(fs.readFileSync(path.join(out, "builds-16.23.json"), "utf8"));
  const top = builds.champions["100"].TOP;
  assert.equal(top.games, 30);
  assert.equal(top.low, true, "30 games < 150: flagged");
  assert.deepEqual(top.core.best, ["6672-3031-3153", 30, 20]);
  assert.equal(top.skillMax.popular[0], "QEW");
  assert.deepEqual(top.items, [[3036, 30, 20]]);
  assert.equal(builds.updatedAt, "2026-11-26T04:00:00.000Z");
});
