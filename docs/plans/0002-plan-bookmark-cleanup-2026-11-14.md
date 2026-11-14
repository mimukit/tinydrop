# Plan: Clean Up Bookmarks (duplicates and dead links)

Grilled: 2026-11-14

## Context and scope

The 2026-11-05 probe records 1,927 bookmarks. This count is historical. The owner expects duplicate links and dead links in the library. The existing plan records a free Raindrop account, so this feature must work without the Pro broken-link flag.

Add a Clean Up Bookmarks command to tinydrop. The command finds duplicate links from the local SQLite store and checks dead links through Tinycast. Cleanup moves bookmarks to Raindrop Trash. It never permanently deletes an owner bookmark.

This session delivers only the final plan. Implementation runs on a separate machine. The owner supplies a Tinycast checkout there before implementation starts. Feature code stays in tinydrop. The checkout supplies the runtime source and the existing smoke test runner.

After cleanup, a duplicate rescan must find zero groups among the groups the owner approves for cleanup. Any groups the owner skips remain visible. Phase 6 records the remaining group count and the number of dead links moved to Trash.

## Settled decisions

The following decisions include the choices from both grill rounds. Asked decisions record owner answers. Defaulted decisions record the published defaults that the owner leaves unchanged.

| Decision | Resolution | Source |
|---|---|---|
| Command | Add the view command `clean-up-bookmarks`, named Clean Up Bookmarks. It reads the local store. Duplicate detection works offline. | Initial planning |
| Duplicate scope | Compare all bookmarks outside Trash, across collections. Two or more bookmarks with the same key form a group. | Initial planning |
| Duplicate key | Lowercase the host. Remove `www.`. Treat HTTP and HTTPS as equal. Remove trailing path slashes and ordinary fragments. Preserve fragments that start with `#/` or `#!`. Sort retained query parameters by name, with stable order for repeated names. Preserve other URL distinctions, including credentials and non-default ports. Return invalid URL text trimmed. | Initial planning; Q1 defaulted |
| Tracking parameters | Remove `utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, and `ref_src`. Preserve `ref`. Use the same key in the Add form warning. | Q8 asked |
| Keeper | Prefer favorite, most highlights, a non-empty note, a named collection instead of Unsorted, most tags, then oldest `created`. Use the bookmark ID to settle equal values. The owner can choose another keeper. | Q9 asked |
| Tags and annotations | Add the extras' tags to the keeper before trash. Send only `tags` in that update. Do not merge notes or highlights. Skip annotated extras in bulk cleanup until the owner opens the group and approves their removal. | Initial planning |
| Requests | Send HEAD first. On 405, 501, or a network error, try GET. Follow redirects subject to the host exclusions below. Each request has a 10-second timeout. | Initial planning |
| Request headers | Use a current Safari User-Agent and `Accept: text/html`, if Tinycast supports these headers. Phase 1 records the supported headers and the User-Agent value. | Q3 defaulted |
| Dead eligibility | A first dead result requires one GET retry before bulk trash can select the bookmark. Run that retry after the first pass, at least two minutes after the first result. Both results must be dead. | Q5 asked; Q11 defaulted |
| Home-page redirect | Classify a redirect from a non-root path to `/` on the same site as `unsure`. A successful HTTP status does not override this rule. | Q6 asked |
| Exclusions | Skip non-HTTP links, localhost, private IP addresses, and `.local` hosts. Show the reason as skipped. Ignore Host adds an exact host to a local list for dead-link checks. | Q2 defaulted; Q7 asked |
| Ignore management | Ignore Host affects only dead-link checks. Duplicate groups remain visible. An Ignored Hosts dropdown entry has a Stop Ignoring action. | Q12 and Q13 defaulted |
| Request pace | Run at most six requests at once and one request per host. Raindrop writes use the existing API pacer. Link checks use a separate limiter. | Initial planning |
| Local state | Add `link_checks` and `ignored_hosts`. Both use `CHECKS_VERSION` and survive a mirror schema reset. Store bookmark data in SQLite, never Cache. | Initial planning; Q14 defaulted |
| Resume | Save each result as it arrives. Resume missing results, results older than 30 days, and pending retries. A changed bookmark URL invalidates its old result. | Initial planning |
| Bulk confirmation | Show one confirmation with the bookmark count and sync age for each bulk operation. Send batches of at most 100, subject to Phase 1 verification. | Q10 asked |
| Stale store | If the last sync is older than one hour, show Sync first as the first action. Include the sync age in trash confirmations. | Initial planning |
| Undo | One `⌘Z` restores the bookmarks from one cleanup operation to their original collections. Keep the ten-entry limit. The stack ends when the window closes. Raindrop Trash remains available afterward. | Q4 defaulted; Q10 asked |
| API probe approval | Phase 1 may create two probe bookmarks in Unsorted, trash them, restore them, and permanently delete only those probe bookmarks. | Q15 asked |
| Tinycast prerequisite | The owner supplies the checkout on the implementation machine. The build reads it as a test dependency and stops if it is missing. The build does not clone it. | Q17 asked |
| Attendance | Phases 1 through 5 run without attendance once the prerequisites exist. Phase 6 requires the owner and the real library. | Q16 asked |
| Tests | Use Vitest for pure logic and writer tests. Use real SQLite for store tests. Use `pnpm smoke <tinycast-checkout>` for runtime flows. | Initial planning |

## Result rules

- `dead` means HTTP 404, HTTP 410, or a confirmed nonexistent host. A pending GET retry does not qualify for bulk trash.
- `unsure` includes HTTP 401, 403, 429, 5xx, timeout, TLS failure, and connection refusal. Unknown errors and unclassified responses also belong here.
- `ok` means a successful final HTTP response, unless the home-page redirect rule applies. Unresolved redirects remain `unsure`.
- `skipped` means the scheme or host prevents a check. Show the exclusion reason without a network request.

Do not infer DNS failure from a generic network error. Phase 1 must prove which runtime error identifies a nonexistent host. If Tinycast cannot distinguish it, classify that error as `unsure`.

A 200 response can contain a soft 404 page. Version 1 does not inspect page text for this case. Bot blocks can also return 404. The retry reduces temporary failures but cannot prove that a page is dead. The results screen shows the reason and provides Open before trash.

Before a retry finishes, show Retry pending and its earliest retry time. If the first pass ends early, show the waiting state. Closing the command preserves the pending retry. Use a fake clock in tests instead of waiting two minutes.

## Code and data changes

Keep pure logic in `src/cleanup/`. Add this directory to the rule that prohibits `@raycast/api` imports. Put the screen in `src/components/CleanupView.tsx` and the command in `src/commands/clean-up-bookmarks.tsx`.

Reuse the following code:

- `src/parse/link.ts` supplies `normalizeLink()` and `findDuplicate()`. Replace the normalization rules and keep the existing exports. Verify that the host lookup finds both host forms.
- `src/store/types.ts` and `src/store/sqlite.ts` gain cleanup row reads, bulk trash updates, and check state reads and writes. Cleanup rows include the ID, URL, title, collection, creation time, favorite flag, tags, note length, and highlight count.
- `src/store/schema.ts` supplies `LOCAL_DDL` and the local version pattern. Keep SQL values inside `sqlString()` and search terms inside `ftsTerm()`.
- `src/api/client.ts` supplies the Raindrop client and pacer. Extend the client with bulk trash and restore methods.
- `src/write/writer.ts` and `src/undo/stack.ts` gain a batch operation and its undo entry. Keep writes in the existing queue.
- `src/components/sync.ts` supplies Sync first. `src/components/failure.ts` supplies failure messages.

`link_checks` stores the bookmark ID, checked URL, class, HTTP status, error reason, and check time. It also stores the first dead result and retry due time until the retry finishes. `ignored_hosts` stores normalized hostnames. Both tables use `CHECKS_VERSION`, initially 1, recorded in `sync_state`.

The proposed bulk endpoints are `DELETE /raindrops/0` with `{ "ids": [...] }` and `PUT /raindrops/-99` with IDs and `collection.$id`. Restore groups IDs by their original collection. Phase 1 verifies these endpoints and their batch limits before implementation depends on them.

If the API lacks bulk support, use the existing single-bookmark endpoints at two calls per second. Do not switch to this fallback for authentication errors or ambiguous timeouts. Reconcile uncertain results before retrying writes.

Bulk calls do not make the whole operation atomic. Track each confirmed success and each unresolved write. On failure, restore failed local updates and reconcile the store with Raindrop. Keep successful trash operations in one undo entry. Report partial completion with counts. Do not show every bookmark as restored when the server still holds some in Trash.

A failed tag update leaves that group's extras untouched. Batch undo restores collection membership. It leaves merged tags on the keeper. Show this limit before duplicate cleanup.

## Implementation phases

### Phase 1: verify the API and Tinycast runtime

Prerequisites: the implementation machine has dependencies, an ignored `.env` with `RAINDROP_TOKEN`, and the owner-supplied Tinycast checkout.

- Extend `scripts/probe.mjs` to create two identifiable probe bookmarks in Unsorted.
- Test bulk trash and restore against only those IDs.
- Clean up probe bookmarks in a `finally` block.
- Verify the API batch limit from primary documentation and the probe.
- Inspect Tinycast's fetch bridge and runtime tests.
- Verify HEAD, request headers, timeout cancellation, redirect handling, final URL access, DNS errors, and TLS errors.
- Verify whether closing or hiding the command destroys its runtime context.
- Verify whether redirects can reach excluded hosts before the checker can reject them.
- Allocate a research filename under `docs/research/` with the repository serial rule when the artifact is created.
- Record the Tinycast commit, API results, and supported fetch features in that research file.

Done when the report records evidence for every required capability and the library and Trash contain no probe bookmarks. A missing capability requires a documented safe fallback. If Tinycast cannot enforce a timeout or the host exclusions, stop the affected checker work. Do not claim that a Node test proves native fetch behavior.

### Phase 2: duplicate detection

- Extend `normalizeLink()` with the settled key rules.
- Add `src/cleanup/duplicates.ts` for groups, keeper selection, and annotation warnings.
- Add the cleanup row read to the store.

Done when tests cover scheme and host variants, fragments, hash routes, tracking parameters, retained `ref`, query order, repeated parameters, and invalid input. Tests also cover keeper order, equal values, collection preference, annotation warnings, and the Add form warning.

### Phase 3: resumable dead-link checks

- Add both local tables and their version handling.
- Add `src/cleanup/linkcheck.ts` with an injectable fetch function and clock.
- Add response classification, host exclusions, request limits, and request cancellation.
- Save pending retries and completed results as they occur.
- Invalidate results when the URL changes.
- Cancel requests when the view closes, if Tinycast preserves the runtime after closure.

Done when tests prove each result class, GET fallback, delayed retry, pending retry resume, and the request limits. Include host exclusion and redirect tests. Store tests must prove that both tables survive a mirror reset and changed URLs invalidate old checks.

### Phase 4: bulk cleanup and undo

- Add verified bulk methods to the API client.
- Add tag merge and batch trash to the writer.
- Add batch restore grouped by original collection.
- Preserve recoverable undo state after partial failures.

Done when tests cover 150 bookmarks across two batches, multiple original collections, failed tag updates, partial trash failure, and ambiguous responses. Include partial undo failure and retry. Verify that tag updates send only `tags` and undo works after sync removes local Trash rows.

### Phase 5: command and runtime checks

- Add the command to `src/manifest.json`.
- Build the screen with the existing Raycast List components.
- Add dropdown entries for Duplicates, Dead Links, Unsure, Skipped, and Ignored Hosts.
- Show each duplicate group's count and keeper title.
- Add Trash Extras, Choose Keeper, Open All, and Trash All Extras.
- Require explicit approval before bulk cleanup includes annotated extras.
- Show each checked bookmark's title, host, result reason, and check time.
- Add Open, Recheck, Trash, Trash All Dead, and Ignore Host where applicable.
- Add Stop Ignoring to the Ignored Hosts view.
- Show first-pass progress, pending retries, and retry progress in the toast.
- Add Sync first, the bulk confirmation, and `⌘Z`.
- Add `flowCleanupDuplicates` and `flowCleanupDeadLinks` to `scripts/smoke.mjs`.

Done when `pnpm typecheck`, `pnpm test`, and `pnpm build` pass. Every bundle must stay below 300 KB. Run all smoke flows with the owner-supplied checkout. The duplicate flow seeds five groups, approves cleanup, rescans, and finds zero groups. The dead-link flow proves that 404 and confirmed DNS failure require a GET retry before bulk selection. It also covers 403, 200, home-page redirects, ignored hosts, and resume. If the runtime does not identify DNS failure, assert `unsure` for it.

No mockup is required. Tinycast supplies the List layout, and the command follows the existing Search view.

### Phase 6: check the real library on macOS

Attended: the owner checks the installed command and approves each operation against real bookmarks.

- Run `pnpm build:install` on the Mac.
- Sync the library.
- Inspect duplicate groups and annotation warnings.
- Approve cleanup and rescan.
- Run a dead-link scan.
- Close the command during the scan and verify resume.
- Inspect result reasons before moving dead links to Trash.
- Test `⌘Z` and inspect the restored bookmarks in Raindrop.
- Allocate a QA filename under `docs/qa/` with the repository serial rule.
- Record scan time, group counts, skipped groups, dead count, and undo results.

Done when approved duplicate groups disappear after rescan and undo restores the last operation to its original collections. Record remaining unapproved groups instead of claiming that the full library has zero duplicates.

## Migration and rollback

Add `link_checks` and `ignored_hosts` through `LOCAL_DDL` with `CREATE TABLE IF NOT EXISTS`. Keep `SCHEMA_VERSION` at 1. No mirror reset or full resync is required. Keep local check state and ignore settings through later mirror resets.

An older build ignores both new tables. Removing `link_checks` clears check history. Removing `ignored_hosts` clears exclusions. Remove the `checks_version` key only when removing both tables. No rollback step changes owner bookmarks in Raindrop.

The duplicate key is computed on read. It does not rewrite stored URLs.

## Remaining verification

No product decision remains open. Phase 1 must verify runtime and API behavior. These are implementation prerequisites, not permission to omit a required check.

The owner supplies Tinycast on the implementation machine. This plan grants no clone approval. The approved live probe touches only its own two bookmarks. Real-library cleanup remains attended in Phase 6.

## Non-goals

- Permanent deletion of owner bookmarks.
- Merge of notes or highlights.
- Duplicate detection by title or page contents.
- Background or scheduled scans.
- Archive or Wayback Machine lookups.
- Replacement URLs for dead links.
- Cleanup of empty collections or unused tags.
- Page-text detection of soft 404 responses.

Raindrop Pro is an alternative to this feature. This plan keeps the existing `broken` column but does not require a subscription.
