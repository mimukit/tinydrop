# tinydrop

A [Raindrop.io](https://raindrop.io) extension for the [Tinycast](https://github.com/abue-ammar/tinycast) launcher on macOS. It keeps your bookmarks in a local SQLite database, so search never waits on the network and works offline. Writes go straight to the Raindrop API.

- Type a few letters and open the bookmark you want, from a local full-text index over titles, links, tags, notes, excerpts and highlights
- Save a link in one line: `https://example.com #read ~Dev !fav`
- Edit, move, tag, favorite or delete from the keyboard, and undo with `⌘Z`
- Bookmarks you open often rank first

## Status

Planned, not built yet. Nothing here installs today. The v1 plan is [docs/plans/0001-plan-tinydrop-features-2026-11-04.md](docs/plans/0001-plan-tinydrop-features-2026-11-04.md). This README describes v1 as the plan defines it, and it changes as the build lands.

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
| Search Bookmarks | Search the local store. An empty search shows the bookmarks you open most. A dropdown filters by collection. |
| Add Bookmark | A form with the URL from the clipboard, title, note, collection, tags and favorite. Raindrop fills in the title, excerpt and cover it finds on the page. |
| Quick Add | Type one line, check the preview, press Enter. |
| Sync | Fetch the changes since the last sync and show the counts. |

## Search syntax

| Write | Example | Matches |
|-------|---------|---------|
| Words | `rust async` | Bookmarks with words starting with `rust` and `async` |
| A tag | `#read` | Tagged `read` |
| A type | `type:video` | Links, articles, images, videos, documents or audio |
| A collection | `in:Dev` | Bookmarks in Dev |
| Favorites | `is:fav` | Favorites only |
| A phrase | `"error handling"` | That exact phrase |
| An exclusion | `-draft` | Leaves out bookmarks with `draft` |

## Quick Add syntax

| Write | Example | Result |
|-------|---------|--------|
| A URL | `https://example.com/a` | The link. With no URL in the line, the clipboard URL. |
| A tag | `#read`, `#"long tag"` | Tag, new ones allowed |
| A collection | `~Dev`, `~"Side projects"` | That collection. An unknown or ambiguous name blocks the save. |
| A favorite | `!fav` | Marked as favorite |
| An escape | `\#1` | A literal `#` in the title |
| Anything else | `a good read` | The title. Left empty, Raindrop fills it in. |

With no collection, the bookmark goes to Unsorted. If the link is already saved, the preview says where, and a second Enter saves it again.

## Keys on a bookmark row

| Key | Action |
|-----|--------|
| `↵` | Open in your browser |
| `⌘I` | Show or hide details: excerpt, note, highlights, dates |
| `⌘O` | Open in the Raindrop web app |
| `⌘⇧C` | Copy the URL |
| `⌘⇧L` | Copy a Markdown link |
| `⌘E` | Edit |
| `⌘M` | Move to a collection |
| `⌘T` | Toggle tags |
| `⌘F` | Toggle favorite |
| `⌘⌫` | Move to Trash |
| `⌘Z` | Undo the last change (up to 10, while the window is open) |
| `⌘N` | Add Bookmark |
| `⌘⇧N` | Quick Add |
| `⌘R` | Sync |
| `⌘⇧R` | Full resync, after a confirmation |
| `⌘⇧A` | Account |

## Not planned for v1

Browse Collections, Unsorted triage and a random bookmark command are planned for v1.1. Save Browser Tab, server-side full-text search, the permanent copy, bulk edits and the Raycast AI tools are out of scope.

## Development

The build follows [tinytick](https://github.com/mimukit/tinytick): pnpm, TypeScript, esbuild and Vitest, with no Raycast CLI. The commands:

```sh
pnpm install
pnpm test                # Vitest; store tests need a sqlite3 binary
pnpm build               # dist/, one CommonJS bundle per command, each under 300 KB
pnpm build:install       # copies dist/ into Tinycast's extensions folder (macOS)
pnpm smoke ../tinycast   # runs the bundles in Tinycast's JS runtime against a fake Raindrop
pnpm bench               # p50 and p95 query time on 10,000 seeded bookmarks
```

The store uses `/usr/bin/sqlite3`. Set `TINYDROP_SQLITE3` to use another binary. `pnpm build:install` honors `TINYCAST_BUNDLE_ID` and `TINYCAST_EXT_DIR`. `pnpm smoke` answers `/usr/bin/security` from memory, so it never touches the Keychain.

## License

MIT.
