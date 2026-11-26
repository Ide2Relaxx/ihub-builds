# I-Hub builds collector

Daily League of Legends build statistics for I-Hub (a personal app for a small
private group of friends). Free: GitHub Actions on a public repository + GitHub Pages.

Once a day (`.github/workflows/collect.yml`):

1. **Collect** (`src/collect.mjs`): Challenger, Grandmaster and Master players of the
   regions in `config.json` (EUW by default), their ranked solo/duo games of the last
   days, each game analysed once (match + timeline). Follows the API key's limits
   (read from Riot's answers, 429 → waits), stops by itself after `maxMinutes`.
2. **Build** (`src/build.mjs`): per champion and role, starting items, core items (in
   order), boots, situational items, full rune pages, summoner spells, skill order;
   each option with its win rate and number of games. "Best" = best win rate among
   options with at least `minOptionGames` games (and `minOptionShare` of the role's
   games); the most played option is published too.
3. **Save** the totals on the `data` branch (yesterday's copy in `data-backup`).
4. **Publish** `index.json` + `builds-<patch>.json` on GitHub Pages.

Privacy: no player name, Riot ID or PUUID is saved or published. Games already
analysed are remembered by a one-way hash only.

If the Riot key is refused (expired development key…), the run stops with an error
and every saved data stays as it was. Update the `RIOT_API_KEY` secret, then run the
workflow again (Actions → Collect LoL builds → Run workflow).

## Settings (`config.json`)

| Field | Meaning |
|---|---|
| `platforms` | Regions, e.g. `["euw1"]` or `["euw1", "eun1"]` (time is shared between them) |
| `tiers` | `challenger`, `grandmaster`, `master` |
| `maxMinutes` | Collector's time budget per day (GitHub stops a job at 360 min) |
| `lookbackDays` | How many days back each player's games are listed |
| `patchesKept` | Patches kept (older totals are removed) |
| `minRoleGames` | Below this, a champion/role is flagged "few games" |
| `minOptionGames`, `minOptionShare` | Minimum games for an option to be "best" |

## Tests

```
node --test test/
```
