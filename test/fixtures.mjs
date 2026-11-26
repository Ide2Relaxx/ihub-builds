// Fake Riot data for the tests (same shape as match-v5, timeline and Data Dragon).

export const ITEMS = {
  1001: { tags: ["Boots"], into: ["3006", "3047"], gold: { total: 300, purchasable: true }, maps: { 11: true } },
  3006: { tags: ["Boots"], from: ["1001"], into: ["3172"], gold: { total: 1100, purchasable: true }, maps: { 11: true } },
  3047: { tags: ["Boots"], from: ["1001"], into: ["3174"], gold: { total: 1200, purchasable: true }, maps: { 11: true } },
  1055: { tags: ["Lane"], gold: { total: 450, purchasable: true }, maps: { 11: true } },
  2003: { tags: ["Consumable"], consumed: true, gold: { total: 50, purchasable: true }, maps: { 11: true } },
  3340: { tags: ["Trinket"], gold: { total: 0, purchasable: true }, maps: { 11: true } },
  1038: { tags: ["Damage"], into: ["3031"], gold: { total: 1300, purchasable: true }, maps: { 11: true } },
  3031: { tags: ["Damage"], from: ["1038"], gold: { total: 3500, purchasable: true }, maps: { 11: true } },
  6672: { tags: ["Damage"], gold: { total: 3000, purchasable: true }, maps: { 11: true } },
  3087: { tags: ["Damage"], gold: { total: 3000, purchasable: true }, maps: { 11: true } },
  3153: { tags: ["Damage"], gold: { total: 3200, purchasable: true }, maps: { 11: true } },
  3036: { tags: ["Damage"], gold: { total: 3000, purchasable: true }, maps: { 11: true } },
};

const ROLES = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
const PERKS = {
  statPerks: { offense: 5005, flex: 5008, defense: 5011 },
  styles: [
    { description: "primaryStyle", style: 8000, selections: [{ perk: 8008 }, { perk: 9111 }, { perk: 9104 }, { perk: 8014 }] },
    { description: "subStyle", style: 8300, selections: [{ perk: 8304 }, { perk: 8345 }] },
  ],
};

/** A ranked game: blue (participants 1-5) wins unless blueWins is false. */
export function makeMatch(id, { patch = "16.23", queue = 420, duration = 1800, blueWins = true, surrender = false } = {}) {
  return {
    metadata: { matchId: id },
    info: {
      gameVersion: `${patch}.712.1234`,
      queueId: queue,
      gameDuration: duration,
      participants: Array.from({ length: 10 }, (_, i) => ({
        participantId: i + 1,
        championId: 100 + i, // champions 100-104 blue, 105-109 red
        teamPosition: ROLES[i % 5],
        win: i < 5 ? blueWins : !blueWins,
        gameEndedInEarlySurrender: surrender,
        summoner1Id: 14,
        summoner2Id: 4,
        perks: PERKS,
        puuid: `secret-puuid-${i}`,
        riotIdGameName: `SecretName${i}`,
      })),
    },
  };
}

/** Each player: Doran's Blade + potion + trinket at 0 s, then a full build. */
export function makeTimeline() {
  const events = [];
  for (let p = 1; p <= 10; p++) {
    events.push({ type: "ITEM_PURCHASED", participantId: p, itemId: 1055, timestamp: 1000 });
    events.push({ type: "ITEM_PURCHASED", participantId: p, itemId: 2003, timestamp: 1500 });
    events.push({ type: "ITEM_PURCHASED", participantId: p, itemId: 3340, timestamp: 1600 });
    // Bought then undone: must not count.
    events.push({ type: "ITEM_PURCHASED", participantId: p, itemId: 3087, timestamp: 300000 });
    events.push({ type: "ITEM_UNDO", participantId: p, beforeId: 3087, afterId: 0, timestamp: 301000 });
    events.push({ type: "ITEM_PURCHASED", participantId: p, itemId: 1001, timestamp: 400000 });
    events.push({ type: "ITEM_PURCHASED", participantId: p, itemId: 6672, timestamp: 600000 });
    events.push({ type: "ITEM_PURCHASED", participantId: p, itemId: 3006, timestamp: 700000 });
    events.push({ type: "ITEM_PURCHASED", participantId: p, itemId: 1038, timestamp: 800000 });
    events.push({ type: "ITEM_PURCHASED", participantId: p, itemId: 3031, timestamp: 900000 });
    events.push({ type: "ITEM_PURCHASED", participantId: p, itemId: 3153, timestamp: 1100000 });
    events.push({ type: "ITEM_PURCHASED", participantId: p, itemId: 3036, timestamp: 1300000 });
    // Q W E, then Q maxed first, then E, then W (R at 6, 11, 16).
    const order = [1, 2, 3, 1, 1, 4, 1, 1, 3, 3, 4, 3, 3, 2, 2, 4, 2, 2];
    order.forEach((slot, i) => events.push({ type: "SKILL_LEVEL_UP", participantId: p, skillSlot: slot, levelUpType: "NORMAL", timestamp: 2000 + i * 60000 }));
  }
  return { info: { frames: [{ events }] } };
}

/**
 * Fake fetch for Riot + Data Dragon. `games` = { matchId: options for makeMatch },
 * every player has played every game. `refuseKey` → 403 everywhere.
 */
export function fakeRiot({ games, players = 3, refuseKey = false, calls = [] }) {
  const json = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([["x-app-rate-limit", "100000:1"]]),
    json: async () => body,
  });
  return async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.host === "dd.test") {
      if (u.pathname === "/api/versions.json") return json(["16.23.1", "16.22.1"]);
      if (u.pathname.endsWith("/item.json")) return json({ data: ITEMS });
    }
    if (refuseKey) return json({ status: { message: "Forbidden" } }, 403);
    const p = u.pathname;
    if (p.includes("/lol/league/v4/challengerleagues/")) {
      return json({ entries: Array.from({ length: players }, (_, i) => ({ puuid: `puuid-${i}`, leaguePoints: 1000 - i })) });
    }
    if (p.includes("/lol/league/v4/")) return json({ entries: [] });
    if (p.includes("/ids")) return json(Object.keys(games));
    const timeline = /\/matches\/([^/]+)\/timeline$/.exec(p);
    if (timeline) return json(makeTimeline());
    const match = /\/matches\/([^/]+)$/.exec(p);
    if (match && games[match[1]]) return json(makeMatch(match[1], games[match[1]]));
    return json({}, 404);
  };
}
