// Turns one ranked game (match-v5 match + timeline) into what the builds need,
// for each of the 10 players: champion, role, win, starting items, completed
// items in order, boots, runes, summoner spells and skill order.
// No player name or id is kept.

export const ROLES = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
export const SOLO_QUEUE = 420;
const MIN_GAME_SECONDS = 300;
const START_MS = 60_000;
const SKILLS = { 1: "Q", 2: "W", 3: "E", 4: "R" };

/** "16.23.712.1234" → "16.23" */
export function patchOf(gameVersion) {
  const m = /^(\d+)\.(\d+)/.exec(gameVersion ?? "");
  return m ? `${m[1]}.${m[2]}` : null;
}

/**
 * Item categories from Data Dragon's item.json "data":
 * boots = 2nd tier boots (made from Boots, id 1001), legendary = finished
 * Summoner's Rift item of 2000 gold or more; trinkets and consumables apart.
 */
export function itemKinds(itemData) {
  const kinds = new Map();
  for (const [id, item] of Object.entries(itemData ?? {})) {
    const tags = item.tags ?? [];
    const onRift = item.maps?.["11"] !== false;
    if (!onRift) continue;
    if (tags.includes("Trinket")) kinds.set(Number(id), "trinket");
    else if (tags.includes("Consumable") || item.consumed) kinds.set(Number(id), "consumable");
    else if (tags.includes("Boots") && (item.from ?? []).includes("1001")) kinds.set(Number(id), "boots");
    else if (!(item.into ?? []).length && item.gold?.purchasable && (item.gold?.total ?? 0) >= 2000 && !tags.includes("Boots")) kinds.set(Number(id), "legendary");
    else kinds.set(Number(id), "other");
  }
  return kinds;
}

/** Order in which Q, W, E reach rank 5 (e.g. "QEW"); null if too short a game. */
export function maxOrder(skills) {
  if (skills.length < 11) return null;
  const count = { Q: 0, W: 0, E: 0 };
  const maxedAt = {};
  skills.forEach((s, i) => {
    if (!(s in count)) return;
    count[s]++;
    if (count[s] === 5 && maxedAt[s] === undefined) maxedAt[s] = i;
  });
  return ["Q", "W", "E"]
    .sort((a, b) => (maxedAt[a] ?? 99) - (maxedAt[b] ?? 99) || count[b] - count[a])
    .join("");
}

function runePage(perks) {
  const styles = perks?.styles ?? [];
  const primary = styles.find((s) => s.description === "primaryStyle");
  const sub = styles.find((s) => s.description === "subStyle");
  if (!primary || !sub) return null;
  const list = (s) => s.selections.map((x) => x.perk).join(",");
  const shards = perks.statPerks ? `${perks.statPerks.offense},${perks.statPerks.flex},${perks.statPerks.defense}` : "";
  return `${primary.style}:${list(primary)}|${sub.style}:${list(sub)}|${shards}`;
}

/**
 * Returns { patch, players: [...] } or null when the game doesn't count
 * (other queue, remake, early surrender, missing data).
 */
export function extractGame(match, timeline, kinds) {
  const info = match?.info;
  if (!info || info.queueId !== SOLO_QUEUE || info.gameDuration < MIN_GAME_SECONDS) return null;
  if (info.participants?.some((p) => p.gameEndedInEarlySurrender)) return null;
  const patch = patchOf(info.gameVersion);
  if (!patch) return null;

  // Purchases and skill ups per participant, from the timeline.
  const purchases = new Map();
  const skills = new Map();
  for (const frame of timeline?.info?.frames ?? []) {
    for (const e of frame.events ?? []) {
      const id = e.participantId;
      if (e.type === "ITEM_PURCHASED") {
        if (!purchases.has(id)) purchases.set(id, []);
        purchases.get(id).push({ item: e.itemId, t: e.timestamp });
      } else if (e.type === "ITEM_UNDO" && e.beforeId) {
        const list = purchases.get(id) ?? [];
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].item === e.beforeId) {
            list.splice(i, 1);
            break;
          }
        }
      } else if (e.type === "SKILL_LEVEL_UP" && e.levelUpType === "NORMAL" && SKILLS[e.skillSlot]) {
        if (!skills.has(id)) skills.set(id, []);
        skills.get(id).push(SKILLS[e.skillSlot]);
      }
    }
  }

  const players = [];
  for (const p of info.participants) {
    if (!ROLES.includes(p.teamPosition)) continue;
    const bought = purchases.get(p.participantId) ?? [];
    // Starting items: bought in the first minute (potions included, free trinkets not).
    const start = bought
      .filter((b) => b.t < START_MS && kinds.get(b.item) !== "trinket")
      .map((b) => b.item)
      .sort((a, b) => a - b);
    const finished = [];
    let boots = null;
    for (const b of bought) {
      const kind = kinds.get(b.item);
      if (kind === "boots" && boots === null) boots = b.item;
      if (kind === "legendary" && !finished.includes(b.item)) finished.push(b.item);
    }
    const order = skills.get(p.participantId) ?? [];
    players.push({
      champion: p.championId,
      role: p.teamPosition,
      win: !!p.win,
      start: start.length ? start.join("-") : null,
      core: finished.length >= 3 ? finished.slice(0, 3).join("-") : null,
      situational: finished.slice(3, 6),
      boots,
      runes: runePage(p.perks),
      spells: [p.summoner1Id, p.summoner2Id].sort((a, b) => a - b).join(","),
      skillStart: order.length >= 3 ? order.slice(0, 3).join("") : null,
      skillMax: maxOrder(order),
    });
  }
  return { patch, players };
}
