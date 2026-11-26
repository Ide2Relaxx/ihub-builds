// Riot API client for the collector, with no dependency (Node 20+ fetch).
//
// - Limits: every Riot answer carries the key's limits (X-App-Rate-Limit,
//   e.g. "20:1,100:120"), per routing host (euw1, europe…). They are
//   followed with a 10 % margin, so a development key and a personal key work
//   the same way. Until the first answer: 18/1 s and 90/120 s.
// - 429 "too many requests": waits Retry-After, then tries again.
// - 401/403: the key is refused (expired development key…) → RiotKeyError,
//   the collector stops cleanly and keeps every saved data.
// - Deadline: never starts a wait that would end after the job's time budget.

export class RiotKeyError extends Error {}
export class OutOfTime extends Error {}
export class RiotUnavailable extends Error {}

const DEFAULT_LIMITS = [
  [18, 1000],
  [90, 120000],
];

/** "20:1,100:120" → [[18, 1000], [90, 120000]] (10 % margin). */
export function parseLimits(header) {
  if (!header) return null;
  const limits = [];
  for (const part of String(header).split(",")) {
    const [count, seconds] = part.trim().split(":").map(Number);
    if (count > 0 && seconds > 0 && seconds <= 86400) limits.push([Math.max(1, Math.floor((count * 9) / 10)), seconds * 1000]);
  }
  return limits.length ? limits : null;
}

/** Time to wait (ms) before one more request fits in every window. */
export function waitNeeded(sent, limits, now) {
  let wait = 0;
  for (const [max, windowMs] of limits) {
    const inWindow = sent.filter((t) => now - t < windowMs);
    if (inWindow.length >= max) {
      const oldestThatMustLeave = inWindow[inWindow.length - max];
      wait = Math.max(wait, windowMs - (now - oldestThatMustLeave));
    }
  }
  return wait;
}

export class Riot {
  constructor(key, { fetchImpl = fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), deadline = Infinity, log = () => {} } = {}) {
    this.key = key;
    this.fetch = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.deadline = deadline;
    this.log = log;
    /** host → { limits, sent: [timestamps] } */
    this.hosts = new Map();
    this.requests = 0;
  }

  bucket(host) {
    if (!this.hosts.has(host)) this.hosts.set(host, { limits: DEFAULT_LIMITS, sent: [] });
    return this.hosts.get(host);
  }

  async pause(ms) {
    if (this.now() + ms > this.deadline) throw new OutOfTime("Time budget used up.");
    if (ms > 0) await this.sleep(ms);
  }

  /** GET → parsed JSON, or null when Riot has nothing (404) or refuses one item (400). */
  async get(url) {
    const host = new URL(url).host;
    const bucket = this.bucket(host);
    let serverErrors = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      const longest = Math.max(...bucket.limits.map(([, w]) => w));
      bucket.sent = bucket.sent.filter((t) => this.now() - t < longest);
      await this.pause(waitNeeded(bucket.sent, bucket.limits, this.now()));
      bucket.sent.push(this.now());
      this.requests++;
      let response;
      try {
        response = await this.fetch(url, { headers: { "X-Riot-Token": this.key } });
      } catch (e) {
        serverErrors++;
        if (serverErrors >= 3) throw new RiotUnavailable(`No connection to Riot (${e.message}).`);
        await this.pause(5000 * serverErrors);
        continue;
      }
      const learned = parseLimits(response.headers.get("x-app-rate-limit"));
      if (learned) bucket.limits = learned;
      if (response.ok) return await response.json();
      if (response.status === 401 || response.status === 403) {
        throw new RiotKeyError("Riot key expired or invalid: generate a new one and update the RIOT_API_KEY secret.");
      }
      if (response.status === 404 || response.status === 400) return null;
      if (response.status === 429) {
        const seconds = Math.min(Math.max(Number(response.headers.get("retry-after")) || 10, 1), 300);
        this.log(`Riot asked to wait ${seconds} s (429).`);
        await this.pause(seconds * 1000);
        continue;
      }
      if (response.status >= 500) {
        serverErrors++;
        if (serverErrors >= 3) throw new RiotUnavailable(`Riot's servers answered ${response.status}.`);
        await this.pause(5000 * serverErrors);
        continue;
      }
      return null;
    }
    throw new RiotUnavailable("Riot kept asking to wait.");
  }
}
