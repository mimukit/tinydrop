# Research: Raindrop API probe (Phase 1)

Date: 2026-11-05. Plan: [0001-plan-tinydrop-features-2026-11-04.md](../plans/0001-plan-tinydrop-features-2026-11-04.md), Phase 1 and the "Open facts as tests" table. Issue: #1.

## Method

`pnpm probe` runs `scripts/probe.mjs` against `https://api.raindrop.io/rest/v1` with the test token from `RAINDROP_TOKEN`. Every call goes through one pacer that keeps call starts 500 ms apart (2 per second) and waits for `X-RateLimit-Reset` on a 429. Every GET carries a `_=<timestamp>` nonce, except the two plain GETs of the nonce check. The pacer and nonce helpers live in `src/api/pace.ts`, so Phase 3's client can reuse them, and `test/pace.test.ts` covers them.

The probe made one bookmark, title `tinydrop probe`, link `https://example.com/tinydrop-probe`, in Unsorted, with one highlight (`Example Domain`, note `tinydrop probe highlight`) in the `POST /raindrop` body. It ran each check on that bookmark only, then deleted it twice. Before it creates the bookmark it removes any leftover with the same link from an earlier run, and cleanup runs in a `finally` block.

The probe ran twice on 2026-11-05. The first run found the Trash search miss described below. The second run added diagnostics to that check, and its output is the record: `.afkkit/logs/probe.json` (bookmark `1914022902`, 67 calls, 43 s, no 429). Both runs gave the same result for every other fact.

## Results

| Fact | Test | Result | Verdict |
|------|------|--------|---------|
| Free plan keeps highlights | Create the probe with one highlight in `POST /raindrop`, read it back through `GET /raindrops/0` and `GET /highlights` | The `POST` reply held 1 highlight. The page call returned the probe with `highlights[]` of length 1 (`Example Domain`). `GET /highlights` returned the same highlight with `raindropRef` set to the probe ID. The account is not Pro. | Pass. The `highlights` table and its FTS column stay, filled from the page call. No extra highlights call per sync. |
| `sort=-lastUpdate` works | Edit the probe's note, then `GET /raindrops/0?sort=-lastUpdate&perpage=50` | The probe was item 0, with the new note. | Pass. Incremental sync keeps the stop-at-mark design. |
| Nonce defeats the server cache | Prime `GET /raindrops/0?sort=-lastUpdate&perpage=50` with no nonce, edit the note, then GET the same page with no nonce and with `_=` | Both GETs showed the edit. No stale reply was seen, in either run. | Pass. The design keeps the nonce on every GET. The probe saw no cache on this page, so the nonce costs nothing and guards against a cache the probe did not hit. |
| Trash search finds recent deletes | `DELETE /raindrop/{id}`, then `GET /raindrops/-99?search=lastUpdate:>2026-11-04` | The search right after the delete returned 0 items, in both runs. A plain Trash page (`sort=-lastUpdate`) held the probe at once, so the delete had worked. Four other searches (`created:>2026-11-04`, `lastUpdate:2026-11-05`, `tinydrop`, `lastUpdate:>2026-11-04T00:00:00Z`) also missed it at about 1 to 3 s. The same `lastUpdate:>` search found the probe after a 5 s wait, about 8 s after the delete. | Pass, with a lag. The search index trails the delete by a few seconds. See the note below. |
| `PUT` restores from Trash | `PUT /raindrop/{id}` with `collection: { $id: -1 }`, then `GET /raindrop/{id}` | The `PUT` reply and the GET both gave collection `-1`. | Pass. Undo of a delete stays in v1, and `⌘⌫` keeps no confirmation. |
| Test token expiry | Record the date the token was first seen working; `GET /user` | `GET /user` returned 200 on 2026-11-05. | Recorded: first seen working on 2026-11-05. Phase 9 calls `GET /user` again; it passes if the token still works on or after 2026-12-05. |
| First-sync time (network) | Page every bookmark read-only, `GET /raindrops/0?perpage=50&page=N`, with the pacer and the nonce | 1,927 bookmarks, 39 page calls, 22.1 s, 0.567 s per page. Scaled to 10,000 bookmarks (200 pages): 113.4 s, 1.89 minutes. The first run gave 22.6 s and 1.93 minutes. | Near the target. See the note below. |

### Trash search lag

The Raindrop search index updates a few seconds after a delete. A plain Trash page shows the change at once, but `search=` does not. For sync this lag does no harm. The Trash search uses a cutoff one day back, so a delete that one sync misses comes back in the next sync's search. A delete made in tinydrop itself changes the store first, so it never depends on the Trash search. No fallback applies, and the plan's Design decisions stay as they are.

The fallback, a full Trash page pass, would also be cheap today: the Trash held 45 items, one page. If Phase 4 or later use shows missed deletes, that fallback costs one call per 50 trashed items.

### First-sync time

The pass rule is "about 1.7 minutes for 10,000 (network)". The measured 1.89 minutes is 13 % over the 1.67-minute floor that 200 calls at 2 per second give. The pacer counts its 500 ms gap from the start of each call, so a reply slower than 500 ms pushes the next call back. That accounts for the extra 67 ms per page. The plan's fallback ("keep the progress toast and resume; record the number") is already in the design, so nothing changes. The number to compare in Phase 9 is 1.89 minutes for the network part.

For the real library of 1,927 bookmarks, the network part of a first sync is 22 s.

## Cleanup

After the checks the probe deleted the bookmark twice (to Trash, then from Trash), both with status 200. `GET /raindrop/1914022902` then returned 404 with `result: false`. A Trash search for `tinydrop` and a full Trash page pass both held no bookmark with the probe link. The first run's bookmark, `1914022215`, got the same cleanup and the same 404, and the second run found no leftover.

## Plan changes

None. Every Phase 1 fact passed, so no Design decisions row changes.
