# AGENTS.md

## Project

tinydrop is a Raindrop.io extension for the [Tinycast](https://github.com/abue-ammar/tinycast) launcher. It keeps the bookmarks in a local SQLite database, read through the macOS `/usr/bin/sqlite3`, so search never waits on the network. Writes go straight to the Raindrop REST API. It is a Raycast-format extension: a `package.json` manifest plus one CommonJS bundle per command, with `react`, `react/jsx-runtime` and `@raycast/api` left external. Stack: TypeScript, React, esbuild, Vitest. Package manager: pnpm.

The code is not built yet. The v1 plan is [docs/plans/0001-plan-tinydrop-features-2026-11-04.md](docs/plans/0001-plan-tinydrop-features-2026-11-04.md). The build copies its tooling from [tinytick](https://github.com/mimukit/tinytick).

## Build and test

These commands exist once Phase 2 of the plan lands.

- `pnpm install`
- `pnpm typecheck`, `pnpm test`
- `pnpm build` writes `dist/`
- `pnpm build:install` builds and copies `dist/` into Tinycast's extensions folder (macOS only)
- `pnpm smoke <tinycast-checkout>` runs the built bundles in Tinycast's JS runtime against a fake Raindrop server
- `pnpm bench` seeds 10,000 bookmarks and prints the p50 and p95 query time

Store tests call a real `sqlite3` binary and skip with a printed reason when none exists.

## Rules for agents

- Do not add the Raycast CLI (`ray`) or `@raycast/utils`. The build is `scripts/build.mjs`.
- Keep `src/api/`, `src/store/`, `src/sync/`, `src/search/`, `src/parse/`, `src/undo/` and `src/write/` free of `@raycast/api` imports, so Vitest can run them in Node.
- Never store a secret in a preference, `LocalStorage` or `Cache`. Tinycast keeps those as plaintext JSON. The token goes through `src/auth/secrets.ts` to the Keychain.
- Never build a SQL literal by hand. Use `sqlString()` and `ftsTerm()` in `src/store/sql.ts`, because the `sqlite3` CLI has no bind parameters.
- Never put bookmark data in `Cache`. The store is the SQLite file in `environment.supportPath`.
- Keep each command bundle under 300 KB. `pnpm build` prints the sizes.
- Use pnpm only. Do not commit a lockfile from another package manager.
- Never commit a Raindrop token. Scripts read it from an environment variable, and `.env` stays ignored.

## Worktree setup

setup:
```sh
cp "$GITKIT_REPO/.env" .env
chmod 600 .env
if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; fi
```

update:
```sh
if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; fi
```

`.env` holds `RAINDROP_TOKEN` and stays ignored. Never print it or commit it.

## Docs artifact naming

- An artifact under `docs/<type>/` (a plan, a QA plan, a review, research) is named `NNNN-<type>-<slug>-YYYY-MM-DD.md`.
- `NNNN` is a four-digit serial, per directory, assigned in creation order and never reused. To get it, take the highest serial in that directory across this worktree, every other worktree that `git worktree list` names, and `origin/HEAD` (`git ls-tree --name-only origin/HEAD <dir>` after `git fetch origin`), and add one. Scan all three, because parallel worktrees otherwise take the same serial. Skip a source that fails, such as no remote, and without git list the directory only. An empty directory starts at `0001`.
- `YYYY-MM-DD` is the creation date. The whole name stays fixed after edits.
- An ADR uses its decision number as the serial: `docs/adr/NNNN-adr-<slug>-YYYY-MM-DD.md`.
- Reader-facing pages (`docs/wiki/`, how-to guides, runbooks) stay unnumbered.
