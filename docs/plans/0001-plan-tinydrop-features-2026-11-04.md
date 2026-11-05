# Plan: tinydrop, a Raindrop.io extension for Tinycast

Grilled: 2026-11-05

## Context

I want to find, open and save my Raindrop.io bookmarks from the Tinycast launcher, with no wait on the network. The one Raycast extension for Raindrop, `raindrop-io`, has no local store. It calls the API on every keystroke, and its open issues about speed (#16011), empty collection dropdowns (#26089) and `fetch failed` errors (#25645) all come from that design.

tinydrop keeps an offline bookmark store that a manual sync fills. Search, the empty-query list and the Add form read only the store. A write goes to the Raindrop REST API at once and updates the store from the reply. The library is 2,000 to 10,000 bookmarks on the Raindrop free plan.

Success is three things I do every day:

- Type a few letters and open the bookmark I want, offline included.
- Save the URL on the clipboard with collection and tags in one line, such as `https://example.com #read ~Dev !fav`.
- Edit, move, tag, favorite or delete a bookmark from the keyboard, and undo it with `⌘Z`.

Targets:

- Target: a search query returns from the store in under 40 ms at p95 on 10,000 bookmarks (from NOTES.md). `pnpm bench` on the Mac records it in Phase 9, and the Account screen shows the p95 of real queries in Tinycast. A miss opens a follow-up plan; this plan has no store fallback.
- Target: a first sync of 10,000 bookmarks finishes in about 1.7 minutes, which is 200 page calls at the 120-per-minute limit (from NOTES.md). Phase 1 measures the network part, and Phase 9 measures the whole sync in Tinycast.
- Daily use without the Raindrop web app open: measured after release.

Sources, all in the ideas repo under `topics/tinydrop/`: `IDEA.md`, `NOTES.md` (the pre-plan decisions are binding), `docs/research/2026-11-04-research-raycast-raindrop-prior-art.md` and `docs/research/2026-11-04-research-local-storage.md`. The build, the auth and this format follow tinytick (`/home/dev/projects/tinytick` and its plan `0001-plan-tinytick-features-2026-10-07.md`).

## Design decisions (settled)

| Decision | Resolution |
|----------|-----------|
| Repo | `mimukit/tinydrop`, public, MIT. Personal use first, no store listing in v1. Stay Raycast-compatible where it costs nothing. |
| Tooling | The tinytick build: pnpm, TypeScript, esbuild, vitest. No Raycast CLI, no `@raycast/utils`. `@raycast/api` is a dev dependency for types only. Copy `scripts/build.mjs` (one CommonJS bundle per command, `react` and `@raycast/api` external, hashed icon names, 300 KB cap per bundle) and `scripts/smoke.mjs` (runs the bundles in Tinycast's JS runtime against a fake server). |
| Reuse | Copy these tinytick files now and adapt them: `src/auth/secrets.ts` (Keychain), `src/undo/stack.ts` (undo stack), `src/api/queue.ts` (per-record write order), `src/api/errors.ts` (error class), `src/components/Picker.tsx` (picker screen), and the symbol tokens of `src/parse/quickadd.ts` (`#tag`, `~"quoted list"`, `!flag`, `\` escape, without chrono). Extract a shared package only when a third extension needs one. |
| Auth | A Raindrop test token only. No OAuth, because Raindrop OAuth needs a client secret and has no PKCE. `GET /user` checks the token at sign-in and shows the account name and Pro state. |
| Token storage | The login Keychain through `/usr/bin/security`, as tinytick `src/auth/secrets.ts` does now, under the service `tinydrop`. NOTES.md says `PKCEClient.setTokens`, but Tinycast `v0.11.17-beta.115` removed `OAuth.PKCEClient` (tinytick commit `0497f9d`), so the copied wrapper is the only working path. No secret goes in a preference, `LocalStorage` or `Cache`. |
| Store | SQLite through `/usr/bin/sqlite3` and `child_process`, final. One file, `environment.supportPath/tinydrop.sqlite`, in WAL mode with an FTS5 index. No speed spike and no JSON fallback (grill Q20). If the Phase 9 bench misses 40 ms, or the macOS `sqlite3` lacks FTS5 or `-json`, a follow-up plan handles it. `Cache`, `sql.js` and `node:sqlite` are rejected (see the storage research). |
| Store check | When the store opens, it checks for FTS5 and `-json` support once per launch. A missing feature shows a toast that names it and stops the command. |
| Store interface | `src/store/` exposes one `BookmarkStore` interface (search, top opened, upsert a page, delete IDs, collections, tags, record an open, sync state). Commands use only the interface, so tests can pass a fake store. |
| Schema | Tables `bookmarks`, `bookmarks_fts`, `highlights`, `collections`, `tags`, `opens`, `sync_state`, as in the storage research. `sync_state` holds a `schema_version` and a separate `opens_version`. A schema version change drops only the server-mirror tables and runs a full sync. `opens` stays, because the server does not hold it (grill Q13). |
| SQL safety | The CLI has no bind parameters. One `sqlString()` function doubles every `'`, and one `ftsTerm()` function wraps each FTS term in double quotes with `"` doubled. No other code builds a SQL literal. Unit tests cover both with hostile input. |
| Reads | `sqlite3 -readonly -json -cmd ".timeout 2000" <db> "<sql>"` with `LIMIT 50`. The search bar waits 100 ms after the last key. The store keeps the times of the last 50 queries for the Account screen. |
| Writes to the store | One `BEGIN … COMMIT` script on stdin per sync page, with `INSERT … ON CONFLICT DO UPDATE`. `.timeout 2000` covers a Search window that reads while Sync writes. |
| API writes | Online only. The store changes first, the API call follows, and the server reply replaces the row. On failure the row reverts and a toast shows the error. No write queue for offline use. `WriteQueue` keeps the writes for one bookmark in order. |
| Sync during a write | Last write wins. Search reads a row again after its own write reply. Sync runs in a separate JS context and cannot see a write still in progress. |
| Sync | Incremental: `GET /raindrops/0?sort=-lastUpdate&perpage=50&page=N`, stop at the first page older than the sync mark, then one Trash search `GET /raindrops/-99?search=lastUpdate:>YYYY-MM-DD` (cutoff one day back, dedupe by `_id`) to drop trashed rows. Then `GET /collections`, `GET /collections/childrens`, `GET /user` (groups and order), `GET /tags/0`. Every GET carries a `_=<timestamp>` nonce against the server cache. A dropped bookmark also loses its `opens` row. |
| Full resync | Pages every bookmark and deletes the IDs the server no longer has. `⌘⇧R` shows a confirmation first ("Full resync: about 200 calls, 2 minutes"), because the same key syncs in tinytick (grill Q15). A toast suggests it when the last full resync is older than 7 days, and that toast's action runs it with no confirmation. |
| Rate limit | Pace at 2 calls per second. On 429, wait until `X-RateLimit-Reset`, then resume from the last stored page. A progress toast shows "Synced 1,250 of 10,000". |
| Sync triggers | A Sync command, `⌘R` in Search, and an optional refresh on open when the store is stale. That setting is off by default. When on, a dropdown sets the age: 1 hour, 6 hours or 1 day (default 1 day). |
| Endpoints | The documented `/collections` plus `/collections/childrens`, not the undocumented `/collections/all` that `raindrop-io` uses. |
| Stored fields | Excerpts and highlights go in SQLite and in the FTS index, with title, domain, link, tags and note. |
| Search | Local operators `#tag`, `type:`, `in:collection` and `is:fav`, plus `-exclude` and `"exact phrase"` (FTS5 `NOT` and phrase queries). Free text runs as FTS5 prefix terms. Rank by `bm25`, then by open count. An empty query shows the most-opened bookmarks, then the newest. No "Search online" action. |
| Collection dropdown | The search bar has a collection dropdown: "All" first, then Unsorted, then the tree as `Parent > Child` labels in the `user.groups` order. The dropdown and `in:` combine with AND (grill Q12). |
| Row | The type icon (link, article, image, video, document, audio), title, domain, tags with `+N`, and a favorite mark. No network favicon, so rows work offline (grill Q11). |
| Details panel | In v1. `⌘I` toggles a panel with the excerpt, note, highlights, dates and collection path. It starts closed, and `LocalStorage` keeps its state (grill Q10). |
| Open ranking | `opens` table with a count and the last open time per bookmark. `↵` records an open. The data stays on this Mac. |
| Quick Add | Syntax `url #tag ~collection !fav`. Collection names match against the store. An unknown `~collection` blocks the save. |
| Add form | URL from the clipboard when it holds a URL, title, note, collection, tags, favorite. `pleaseParse: {}` fills title, excerpt and cover. The last used collection is kept in `LocalStorage`. Inline collection create waits for v1.1. |
| Duplicate URL | The Add form and the Quick Add preview show "Already saved in Dev" when the normalized link (lowercase host, no trailing `/`, no `utm_*` parameters) is in the store. A second Enter saves the duplicate (grill Q14). |
| Save browser tab | Out. The Add form takes the URL from the clipboard. |
| Undo | Delete moves to Trash with no confirmation. `⌘Z` reverts the last of up to 10 writes in the open window, as in tinytick. The stack ends when the window closes. |
| Tests | vitest in Node for the pure modules (`src/search/`, `src/parse/`, `src/sync/`, `src/undo/`, `src/store/sql.ts`), beside tinytick's layout in `test/`. Store tests run the real `sqlite3` CLI through an injectable binary path, and skip with a printed reason when no binary exists. `pnpm smoke <tinycast-checkout>` runs the bundles against a fake Raindrop server. `pnpm bench` seeds 10,000 rows through the real store module and prints the p50 and p95 query time. |
| `sqlite3` on the dev box | Approved outward action (grill Q21). Phase 3 runs `sudo apt install sqlite3` for the session, and adds `sqlite3` to the devaloy repo's `Dockerfile` as an uncommitted change for the owner to review and rebuild. |
| Probe writes | Approved outward action (grill Q18). The Phase 1 probe makes its own bookmark, title `tinydrop probe`, link `https://example.com/tinydrop-probe`, in Unsorted. It edits, deletes and restores only that bookmark, and deletes it for good at the end. |
| GitHub repo | The owner creates `mimukit/tinydrop` in Phase 2. No build step creates it. |
| Attended phases | Phases 1 and 2 need the owner but not the Mac, and come first. Every Mac task is in Phase 9, attended, at the end (grill Q22). Phases 3 to 8 run unattended on this box. |
| Resource budget | No background `interval` command, no menu bar. Each command bundle stays under 300 KB. |

## Approach

The chosen shape is the tinytick shape with SQLite in place of `Cache`: a small core and four thin commands.

- `src/api/` holds the typed Raindrop client, the error class, the rate pacer and the write queue.
- `src/auth/` holds the Keychain wrapper.
- `src/store/` holds the `BookmarkStore` interface, the SQLite implementation (`sqlite.ts`), the SQL helpers (`sql.ts`) and the schema.
- `src/sync/` holds the incremental and full sync planners. They take a client and a store, so tests run them against fakes.
- `src/search/` parses the search text into a query object. `src/store/sql.ts` turns that object into SQL.
- `src/parse/` holds the Quick Add parser.
- `src/undo/` holds the undo stack, with bookmark entry kinds.
- `src/components/` and `src/commands/` hold the Raycast UI.

Keep `src/api/`, `src/store/`, `src/sync/`, `src/search/`, `src/parse/` and `src/undo/` free of `@raycast/api` imports, so vitest runs them in Node.

Rejected alternatives:

- Live fetch per keystroke, like `raindrop-io`. It is the cause of every speed and fetch-failure complaint in the research.
- `Cache` as the store. Tinycast keeps the whole store in app memory and rewrites the full file 250 ms after each change.
- `sql.js`. It loads about 1 MB of wasm and the whole database on every launch, and rewrites the whole file on every write.
- A JSON file, as the store or as a fallback. Every launch reads and parses 5 to 20 MB. The grill dropped it (Q20).
- A `sqlite3` speed spike before the build. The grill dropped it (Q20). The bench and the Account timing measure the same numbers in Phase 9.

### Feature list

| Area | Feature | Phase | Source |
|------|---------|-------|--------|
| Probe | Live checks of the API facts, real first-sync network time | 1 | API |
| Auth | Token sign-in, `GET /user` check, account name and Pro state | 3 | API |
| Auth | Sign out: delete the Keychain entry and the database | 3 | local |
| Auth | 401 handling: a toast "Token rejected" with an action to Account | 3 | API |
| Store | Query timing (p95 of the last 50 queries) on the Account screen | 3 | store |
| Sync | Incremental sync, Trash search, collections, tags, user groups | 4 | API |
| Sync | Full resync with a confirmation, and the 7-day reminder toast | 4 | API |
| Sync | Pacing, 429 wait, resume from the last page, progress toast | 4 | API |
| Sync | Sync command (HUD with counts) and `⌘R` in Search | 4 | local |
| Sync | Refresh on open when stale (setting, off by default) | 4 | local |
| Search | FTS5 search over title, domain, link, tags, note, excerpt, highlights | 5 | store |
| Search | Operators `#tag`, `type:`, `in:collection`, `is:fav`, `-exclude`, `"phrase"` | 5 | store |
| Search | Collection dropdown | 5 | store |
| Search | Rank by match, then open count; empty query shows most opened | 5 | store |
| Search | Row: type icon, title, domain, tags with `+N`, favorite mark | 5 | store |
| Search | Details panel: excerpt, note, highlights, dates, collection | 5 | store |
| Search | Open, copy URL, copy Markdown link, open in the Raindrop web app | 5 | local |
| Row actions | Edit form, move, tags, favorite, delete to Trash | 6 | API |
| Row actions | Undo stack of 10 writes with `⌘Z` | 6 | local |
| Add | Add Bookmark form with clipboard URL, last collection, duplicate warning | 7 | API |
| Add | Quick Add with `url #tag ~collection !fav`, a live preview and the duplicate warning | 7 | API |

### Commands

| Command | Mode | Purpose |
|---------|------|---------|
| Search Bookmarks | view | The main screen. Search, details, row actions, Sync and Account actions. |
| Add Bookmark | view | The Add form. |
| Quick Add | view | A `text` argument from the root search, a live preview row, collection autocomplete. Enter saves. A view, not no-view, so an unknown `~collection` shows its error before the save. |
| Sync | no-view | Incremental sync. A HUD with the counts. |

Account is a pushed screen from Search (`⌘⇧A`), as in tinytick.

### Quick Add grammar

| Token | Example | Result |
|-------|---------|--------|
| URL | `https://example.com/a` | `link`. The first token that parses as an `http` or `https` URL. With no URL, the clipboard URL, else the save is blocked. |
| Tag | `#read`, `#"long tag"` | `tags[]`. New tags are allowed. |
| Collection | `~Dev`, `~"Side projects"` | `collection.$id`, matched against the store, exact first, then a unique prefix. No match or two matches block the save. |
| Favorite | `!fav` | `important: true` |
| Escape | `\#1` | A literal `#` in the title |
| Rest | `a good read` | `title`. With no title, `pleaseParse` fills it. |

With no `~collection`, the bookmark goes to Unsorted.

### Key map on a bookmark row

Tinycast reserves `⌘W`, `⌘,`, `⌘.`, `⌘Q` and `⌃N/P/F/B`. `⌘↵` is not bound.

| Key | Action |
|-----|--------|
| `↵` | Open in the default browser and count an open |
| `⌘I` | Show or hide the details panel |
| `⌘O` | Open in the Raindrop web app |
| `⌘⇧C` | Copy URL |
| `⌘⇧L` | Copy Markdown link `[title](url)` |
| `⌘E` | Edit form |
| `⌘M` | Move to a collection (picker) |
| `⌘T` | Toggle tags (picker) |
| `⌘F` | Toggle favorite |
| `⌘⌫` | Delete to Trash, no confirmation |
| `⌘Z` | Undo the last write (shows only when the stack has an entry) |
| `⌘N` | Add Bookmark form |
| `⌘⇧N` | Quick Add |
| `⌘R` | Sync now |
| `⌘⇧R` | Full resync, after a confirmation |
| `⌘⇧A` | Account |

The Add form and the Edit form submit with the Tinycast form default. In Quick Add, `↵` saves.

### Open facts as tests

Each fact has a test, the phase that runs it, a pass rule and a fallback. A phase records each result in its `docs/research/` note, or in this plan when the result changes a decision.

| Fact | Test | Phase | Pass | Fallback |
|------|------|-------|------|----------|
| FTS5 and `-json` in macOS 26 `sqlite3` | `sqlite3 --version`, then open the installed extension; the store check runs at open | 9 | No store-check toast | A follow-up plan (no fallback in this plan) |
| `sqlite3` query time | `pnpm bench` on the Mac, and the Account p95 after 50 searches in Tinycast | 9 | p95 under 40 ms on both | A follow-up plan |
| Store write time | `pnpm bench` also times 200 batches of 50 rows | 9 | Under 50 ms per batch, so the store adds under 10 % to a 1.7-minute first sync | Write 4 pages (200 rows) per `sqlite3` process |
| First-sync time | Phase 1 pages the real library read-only with the pacer and scales to 10,000. Phase 9 times a real first sync in Tinycast | 1, then 9 | About 1.7 minutes for 10,000 (network); under 2 minutes end to end | Keep the progress toast and resume; record the number |
| `child_process` blocks the UI | Type in the Search bar while a full resync writes | 9 | Typing stays responsive | Smaller write batches, with a yield between them |
| Tinycast passes `⌘F` and `⌘T` | Press both on a row | 9 | Both reach the action | Pick other keys in a follow-up change |
| Test token expiry | Record the token's creation date in Phase 1. Call `GET /user` with it in Phase 9 | 1, then 9 | Still valid 30 days after creation | Phase 3 builds the 401 path anyway: the toast sends you to Account to paste a new token |
| Free plan keeps highlights | Add a highlight to the probe bookmark in the web app. Read it through `GET /raindrops/0` and `GET /highlights` | 1 | `highlights[]` comes back on the page call | Page call empty but `GET /highlights` works: one extra paged call per sync. Both empty: drop the `highlights` table and its FTS column |
| `sort=-lastUpdate` works | Edit the probe bookmark, then page with `sort=-lastUpdate` | 1 | The probe bookmark is first | Incremental sync falls back to a full ID pass with `sort=-created`, and only changed `lastUpdate` values are written |
| Trash search finds recent deletes | Delete the probe bookmark, then `GET /raindrops/-99?search=lastUpdate:>` yesterday | 1 | The probe bookmark is in the reply | Sync runs a full Trash page pass (Trash is small) |
| `PUT` restores from Trash | `PUT /raindrop/{id}` with the probe bookmark's old `collection.$id` | 1 | It returns to Unsorted | Undo of a delete is left out, and `⌘⌫` gets a confirmation |
| Nonce defeats the server cache | Two GETs of one page with an edit between, with and without `_=` | 1 | With the nonce the edit shows | Already in the design; the probe only confirms it |

### Phase 1: live API probe

Attended: needs a Raindrop test token from the owner, given as a secret, and one highlight the owner adds by hand to the probe bookmark in the Raindrop web app. No Mac needed.

- Create the local scaffold from tinytick: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `LICENSE`, `AGENTS.md` (rewritten for tinydrop).
- Write `scripts/probe.mjs`. It reads the token from an environment variable, never from a file in the repo, and runs each Phase 1 row in "Open facts as tests".
- The probe creates the probe bookmark, waits for the owner to add the highlight, runs the checks, and deletes the bookmark for good at the end.
- Page the real library with the 2-per-second pacer and the nonce, read-only. Print the bookmark count, the call count, the elapsed time, and the time scaled to 10,000.
- Record the token's creation date.
- Write the results to `docs/research/0001-research-api-probe-<date>.md`. Update a Design decisions row where a fallback applies.

Done when: the research note lists a pass or a fallback for each Phase 1 fact, with the measured first-sync network time for the real library and for 10,000, and the probe bookmark no longer exists in Raindrop or its Trash.

### Phase 2: repo, build and harness

Attended: the owner creates `mimukit/tinydrop` on GitHub. No build step creates the remote.

- Complete the scaffold: `scripts/build.mjs`, `src/manifest.json`, `README.md` with install and keys, `assets/icon.png`, `pnpm build:install`.
- Copy `scripts/smoke.mjs` and replace the fake TickTick server with a fake Raindrop server (`/user`, `/raindrops/0`, `/raindrops/-99`, `/collections`, `/collections/childrens`, `/tags/0`, `/raindrop`).
- Add `scripts/bench.mjs` as `pnpm bench`: seed 10,000 rows through the real store module, time 200 batch writes, and print p50 and p95 query time.
- Add a hello-world Search Bookmarks command.

Done when: `pnpm typecheck`, `pnpm test` and `pnpm build` pass, `pnpm build` prints each bundle under 300 KB, and `pnpm smoke <tinycast-checkout>` renders the hello-world command.

### Phase 3: client, auth and store

- Run `sudo apt install sqlite3` for this session. Add `sqlite3` to the devaloy repo's `Dockerfile` and leave that change uncommitted.
- Build the Raindrop client in `src/api/`: typed records, the error class, the pacer (2 per second, 429 wait on `X-RateLimit-Reset`), and the nonce on every GET.
- Copy `src/auth/secrets.ts` with the service `tinydrop` and one account, `test-token`.
- Build the Account screen: paste a token, check it with `GET /user`, show the name, the Pro state and the query p95, sign out.
- Build the 401 path: a toast "Token rejected" with an action to Account.
- Build `src/store/`: the `BookmarkStore` interface, the schema with `schema_version` and `opens_version`, the FTS5 and `-json` check at open, `sqlString()`, `ftsTerm()`, and the SQLite implementation.

Done when: `pnpm test` passes for `sqlString()` and `ftsTerm()` with quotes, newlines, `--`, `;` and FTS syntax characters, for an upsert-then-search round trip on the real CLI, and for a schema version change that keeps the `opens` rows. `pnpm smoke` signs in against the fake server and shows the account name.

### Phase 4: sync

- Build `src/sync/` with the incremental planner, the Trash search, the full resync, the resume point in `sync_state`, the collection and tag refresh, and the `opens` cleanup for dropped bookmarks.
- Build the Sync command with a HUD such as "Synced 37 changes, 2 removed".
- Add the progress toast during a long sync, the `⌘⇧R` confirmation, and the 7-day full-resync toast.
- Add the refresh-on-open setting, off by default, with the age dropdown.

Done when: vitest covers the planner against a fake client (stop at the sync mark, Trash dedupe, a 429 mid-run that resumes on the next page, a full resync that removes a missing ID and its `opens` row). A second sync with no changes makes 6 calls or fewer against the fake client. `pnpm smoke` runs the Sync command and checks the HUD text.

### Phase 5: Search Bookmarks

- Build `src/search/` to parse `#tag`, `type:`, `in:collection`, `is:fav`, `-exclude`, `"phrase"` and free text into a query object, and compile it to SQL in `src/store/sql.ts`.
- Build the list: the 100 ms wait, the row, the collection dropdown, the empty-query list from `opens`, and the last sync time in the navigation title.
- Build the details panel with `⌘I`.
- Add open (records an open), copy URL, copy Markdown link, open in the Raindrop web app, `⌘R` sync, `⌘⇧R` full resync, `⌘⇧A` Account.

Done when: vitest covers each operator alone and combined, an operator with a quote in it, and the dropdown combined with `in:`. A store test with no client finds a bookmark by a word that occurs only in its highlight. A bookmark opened three times ranks above one opened once for the same query.

### Phase 6: row actions and undo

- Build the Edit form (link, title, note, collection, tags, favorite), the move picker, the tag picker and the favorite toggle, from the copied `Picker.tsx`.
- Build delete to Trash with no confirmation.
- Each action changes the store, sends the changed fields through `WriteQueue`, pushes an undo entry, replaces the row from the reply, and reverts with a toast on failure.
- Copy `src/undo/stack.ts` with entry kinds `fields`, `move` and `trash`, and the `⌘Z` action.

Done when: `pnpm smoke` favorites, moves and deletes three bookmarks, presses `⌘Z` three times, and the fake server receives the three writes and the three reverting writes in order. A test with a failing client shows the row back in its old state after a favorite.

### Phase 7: Add Bookmark and Quick Add

- Build the Add Bookmark form with the clipboard URL, the stored collections and tags, the last used collection, the duplicate warning, and `pleaseParse`.
- Write the Quick Add parser in `src/parse/` with one unit test per grammar row.
- Build the Quick Add view with the live preview row, collection autocomplete from the store, the duplicate warning, and the blocking error for an unknown or ambiguous `~collection`.
- Insert the server reply into the store, so the new bookmark is searchable before the next sync.

Done when: `pnpm test` passes for every grammar row and for link normalization. In `pnpm smoke`, `https://example.com #read ~Dev !fav` sends one `POST /raindrop` with that collection, tag and `important: true`, and Search finds the new row at once. `https://example.com ~Nope` shows an error and sends no request.

### Phase 8: full smoke

- Extend `pnpm smoke` to drive sign-in, sync, search, one row write, undo and Quick Add in one run against the fake Raindrop server.
- Update `README.md` with the final key map and commands.

Done when: `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm smoke` pass in one run, with each bundle under 300 KB.

### Phase 9: Mac acceptance

Attended: needs the owner at a Mac on macOS 26 with Tinycast installed, a clone of `mimukit/tinydrop`, and the test token. Every Mac task in the plan is here.

- Run `pnpm build:install` and add the extension with "Add from folder".
- Run `sqlite3 --version` and open Search Bookmarks. Record the version and whether the store check passes.
- Sign in. Restart Tinycast. Check that Account still shows the account name, and that `extension-data/tinydrop.json` holds no token.
- Run a first sync of the real library and time it.
- Run 50 searches, then read the query p95 on the Account screen.
- Run `pnpm bench` and record the write time per batch and the query p95.
- Type in the Search bar during a full resync and note whether typing stalls.
- Press `⌘F` and `⌘T` on a row and note whether each fires.
- Favorite, move and delete three bookmarks, press `⌘Z` three times, and check the Raindrop web app after a reload.
- Save `https://example.com #read ~Dev !fav` with Quick Add and check it in the web app, then delete it.
- Check the Phase 1 token with `GET /user`.
- Write the results to `docs/research/0002-research-mac-acceptance-<date>.md`.

Done when: the research note records each Phase 9 row in "Open facts as tests" as pass or fail. `pnpm bench` prints a query p95 on 10,000 rows: under 40 ms passes the target, and over 40 ms opens a follow-up plan.

## Open questions

The grill settled every decision. One item stays with the owner:

- NOTES.md still says the token goes through `PKCEClient.setTokens`. The plan uses `/usr/bin/security`. The owner decides whether to update NOTES.md (deferred).

## Non-goals

- A `sqlite3` speed spike and a JSON-file store fallback.
- OAuth sign-in.
- Offline writes and a write queue that survives a closed window.
- An undo that survives a closed window.
- Server-side and Pro full-text search, and a "Search online" action.
- Network favicons.
- The permanent copy, reminders, file upload, collection sharing and export.
- Save Browser Tab.
- Inline collection create, Browse Collections, Unsorted triage and Random bookmark (v1.1).
- Bulk add, bulk move and bulk tag.
- The four Raycast AI tools. Tinycast has no AI API.
- A background `interval` command and a menu bar command.
- A Raycast store listing in v1.
- A shared package with tinytick.
