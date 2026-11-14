# tinydrop

A [Raindrop.io](https://raindrop.io) extension for the [Tinycast](https://github.com/abue-ammar/tinycast) launcher on macOS. It keeps your bookmarks in a local SQLite database, so search never waits on the network and works offline. Writes go straight to the Raindrop API.

- Type a few letters and open the bookmark you want, from a local full-text index over titles, links, tags, notes, excerpts and highlights
- Save a link with Add Bookmark and fetch its title and description before saving
- Edit, move, tag, favorite or delete from the keyboard, and undo with `⌘Z`
- Bookmarks you open often rank first

## Status

Built, not yet checked on a Mac. All three commands exist, and `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm smoke` pass on Linux, where the smoke run drives the bundles through Tinycast's JavaScript runtime against a fake Raindrop server. The check in real Tinycast on macOS 26 (the rendered look, the Keychain, the macOS `sqlite3`, and the query time on a real library) is still to do, in [issue #2](https://github.com/mimukit/tinydrop/issues/2). The v1 plan is [docs/plans/0001-plan-tinydrop-features-2026-11-04.md](docs/plans/0001-plan-tinydrop-features-2026-11-04.md).

## Install

You need Tinycast with extensions turned on, Node 24, and pnpm.

```sh
git clone https://github.com/mimukit/tinydrop
cd tinydrop
pnpm install
pnpm build
```

In Tinycast, open Settings › Extensions › Install New › Add from folder, and pick `dist/`. After that, `pnpm build:install` rebuilds and copies `dist/` over the installed copy, so you do not need to add it again. It writes to `~/Library/Application Support/com.tinycast.app/extensions/tinydrop`. Set `TINYCAST_BUNDLE_ID=com.tinycast.app.dev` for a debug build of Tinycast, or `TINYCAST_EXT_DIR` for any other folder.

Then open Search Bookmarks, sign in (below), and press `⌘R` for the first sync.

## How it works

The Raycast extension for Raindrop calls the API on every keystroke. With a large library that makes search slow, and a network hiccup leaves you with an empty list. tinydrop splits reads from writes instead:

- **Reads** come from a SQLite file in the extension's support folder, through the `/usr/bin/sqlite3` that ships with macOS. Each search runs one short query against an FTS5 index and returns at most 50 rows. The target is under 40 ms at p95 for 10,000 bookmarks.
- **Writes** go to the Raindrop API at once. The local row changes first and is replaced by the server's reply. If the call fails, the row goes back to how it was and a toast shows the error. There is no offline write queue.
- **Sync** is manual: the Sync command or `⌘R`. It fetches only what changed since the last sync, sorted by last update, plus one Trash search to drop deleted bookmarks. A first sync of 10,000 bookmarks takes about 1.7 minutes, because the API allows 120 calls a minute and returns 50 bookmarks per call. A sync with few changes takes about 6 calls.
- **Full resync** (`⌘⇧R`) pages through every bookmark. It is the only way to catch a bookmark deleted for good, since the API has no change feed. tinydrop suggests one when the last was more than 7 days ago.

Open counts stay on your Mac and never go to Raindrop.

## Sign in

tinydrop uses a Raindrop test token. In Raindrop, open Settings › Integrations › For Developers, create an app, and create a test token. Paste it in tinydrop's Account screen (`⌘⇧A`).

The token goes in your login Keychain under the service `tinydrop`, through `/usr/bin/security`. Tinycast keeps preferences, LocalStorage and Cache as plaintext JSON, so the token never goes there. There is no OAuth sign-in: Raindrop's OAuth needs a client secret and has no PKCE, and Tinycast no longer supports extension OAuth.

## Commands

| Command | What it does |
|---------|--------------|
| Search Bookmarks | Search the local store. An empty search lists the bookmarks you open most, then the newest. A dropdown in the search bar filters by collection. Account and the sync actions live here. |
| Add Bookmark | A form with the URL from the clipboard, title, note, collection (the last one you used, or Bookmarks), tags and favorite. Raindrop fills in the title, excerpt and cover it finds on the page. |
| Sync | Fetch the changes since the last sync and show the counts in a HUD, such as "Synced 37 changes, 2 removed". |

Two preferences control refresh on open. "Refresh on open" (off by default) runs a sync when Search Bookmarks opens and the last sync is older than "Stale after": 1 hour, 6 hours or 1 day (default 1 day).

## Search syntax

| Write | Example | Matches |
|-------|---------|---------|
| Words | `rust async` | Words starting with `rust` and `async`, in the title, link, tags, note, excerpt or highlights |
| A tag | `#read`, `#"long tag"` | Tagged `read`. The whole tag, any case. |
| A type | `type:video` | One of `link`, `article`, `image`, `video`, `document`, `audio`. Two `type:` terms match either. |
| A collection | `in:Dev`, `in:"Side projects"` | Bookmarks in that collection, not its children. Exact title first, then a unique prefix. `in:unsorted` means Unsorted. |
| Favorites | `is:fav` | Favorites only |
| A phrase | `"error handling"` | That exact phrase. Write `\"` for a quote inside it. |
| An exclusion | `-draft`, `-"old notes"`, `-#later` | Leaves out that exact word, phrase or tag |

Terms combine with AND, and so do `in:` and the collection dropdown. An unknown collection name or an ambiguous prefix shows an error row. An operator with a value it does not know, such as `type:foo`, counts as plain words. Results rank by text match, then by how often you opened the bookmark, then by date.

Type `#` to show up to ten stored tags. Type more letters to narrow the suggestions by prefix. Select a tag with the arrow keys and press Enter to insert it. The search keeps earlier filters and quotes tag names that contain spaces. Suggestions use the local store and work offline.

## Add Bookmark fields

The form selects the last saved collection if it still exists. Otherwise, it selects Bookmarks. If Bookmarks does not exist, it selects Unsorted.

Use the Tags picker to search and select existing tags. To add a new name, select Create Tag from Actions. Enter the name and select Add Tag to Bookmark. The new tag joins the selected tags. Raindrop receives it only when you save the bookmark.

### Page details

Enter a URL in Add Bookmark. Press `⌘R` or select Fetch Page Details from Actions. The form uses Raindrop's read-only URL parser to fill empty Title and Description fields. Existing text stays unchanged. You can edit both fields before saving. Description saves as the bookmark excerpt; Note stays separate. Fetching requires a network connection and a valid token. Fetching does not save a bookmark.

## Keys on a bookmark row

| Key | Action |
|-----|--------|
| `↵` | Open in your browser, and count an open |
| `⌘I` | Show or hide details: excerpt, note, highlights, dates, collection path |
| `⌘O` | Open in the Raindrop web app |
| `⌘⇧C` | Copy the URL |
| `⌘⇧L` | Copy a Markdown link `[title](url)` |
| `⌘E` | Edit |
| `⌘M` | Move to a collection |
| `⌘T` | Toggle a tag |
| `⌘F` | Add to or remove from favorites |
| `⌘⌫` | Move to Trash, after a confirmation |
| `⌘Z` | Undo the last change (up to 10, while the window is open). Shows only when there is something to undo. |
| `⌘N` | Add Bookmark |
| `⌘R` | Sync |
| `⌘⇧R` | Full resync, after a confirmation |
| `⌘⇧A` | Account |

`⌘↵` is not bound. The Add and Edit forms submit with the Tinycast form default.

## Edit checked links

Clean Up Bookmarks opens in Duplicates. Select Dead Links or Unsure to start or resume the link check.

The list uses short result labels to leave space for bookmark titles and hosts. Hover over a result label to read the full reason.

In Clean Up Bookmarks, select a bookmark in Dead Links or Unsure. Press `⌘E` or select Edit Bookmark from Actions. Change the URL or other fields, then press `⌘S` to save. Press `⌘Z` in the list to undo the edit. The form uses the same fields as the Search editor.

A changed URL no longer shows its old check result. Open the check view again to check the new URL. Pending retries in Dead Links also offer Edit Bookmark.

In Unsure, open the link to inspect it. If it works, press `⌘L` or select Mark as Live. This action removes the result from Unsure and keeps the bookmark in Raindrop. It saves your decision locally without an HTTP status. The app checks the link again after 30 days or when its URL changes. An active scan cannot replace your decision.

## Export dead links

Open Clean Up Bookmarks and select Dead Links. Select Export Dead Links CSV from Actions. The export includes all confirmed dead links, regardless of the search filter. It excludes pending retries and ignored hosts. During a scan, it includes only the confirmed results saved so far.

The CSV contains the bookmark ID, title, URL, HTTP status, result reason, and check time in UTC. Each export creates a UTF-8 file in the `exports` directory under tinydrop's support directory. Select Open Export Folder in the success message to access the file. The export preserves earlier files and does not change your bookmarks. Spreadsheet formula prefixes receive a leading apostrophe.

## Not planned for v1

Browse Collections, Unsorted triage and a random bookmark command are planned for v1.1. Save Browser Tab, server-side full-text search, the permanent copy, bulk edits and the Raycast AI tools are out of scope.

## Development

The build follows [tinytick](https://github.com/mimukit/tinytick): pnpm, TypeScript, esbuild and Vitest, with no Raycast CLI. The commands:

```sh
pnpm install
pnpm typecheck
pnpm test                # Vitest; store tests run a real sqlite3 and skip when there is none
pnpm build               # dist/, one CommonJS bundle per command; fails over 300 KB
pnpm build:install       # builds and copies dist/ into Tinycast's extensions folder (macOS)
pnpm smoke ../tinycast   # runs the bundles in Tinycast's JS runtime against a fake Raindrop
pnpm bench               # p50 and p95 write and query times on 10,000 seeded bookmarks
pnpm probe               # Phase 1 facts on the live API: one probe bookmark, deleted after; needs RAINDROP_TOKEN
```

`pnpm smoke` needs a Tinycast checkout (`git clone --depth 1 https://github.com/abue-ammar/tinycast`) and a fresh `pnpm build`. It runs Tinycast's own Raycast shim and React reconciler in Node, with a real `sqlite3`, so it catches API and render problems without a Mac. It does not cover the Swift renderer. It answers `/usr/bin/security` from memory, so it never touches the Keychain. To run one flow, name it: `ONLY=flowEndToEnd pnpm smoke ../tinycast`. The flow names are the `flow*` functions in `scripts/smoke.mjs`.

The store uses `/usr/bin/sqlite3`. Set `TINYDROP_SQLITE3` to use another binary.

## License

MIT. See [LICENSE](LICENSE).
