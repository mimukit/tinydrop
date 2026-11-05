# Review of tinydrop v1

Reviewed 2026-11-05. Range `origin/main...645920dac492fd7b6638a4c4e9a24091a85f3f70`. The worktree is clean before verification. Local HEAD and GitHub HEAD match.

The verdict is needs-work. Two blockers affect bookmark writes. Two should-fix findings affect ranking and sync recovery.

## Findings

### 1. Blocker. Concurrent Trash actions can permanently delete a bookmark

Location [src/write/writer.ts:135](../../src/write/writer.ts#L135). The correctness pass finds this defect.

```ts
const before = await this.current(row);
if (before.collectionId === TRASH_COLLECTION) return true;
```

The API call is the only operation inside the queue at line 73.

```ts
reply = await this.queue.run(String(before.id), async () => send(await this.client()));
```

Two concurrent Trash actions both read the original collection. They each schedule a DELETE request. The reproduction records `["DELETE 1","DELETE 1"]` and two undo entries.

The plan requires a move to Trash with undo. The [Raindrop API documentation](https://developer.raindrop.io/v1/raindrops/single) states that DELETE permanently removes an item already in Trash. The repository uses the same sequence in `scripts/probe.mjs:100-104` for permanent removal.

Serialize the complete operation for each bookmark. Read the row and check its collection inside that operation. Prevent a second request after the first action moves the bookmark to Trash.

### 2. Blocker. Overlapping failures restore a failed change

Location [src/write/writer.ts:77](../../src/write/writer.ts#L77). The correctness pass finds this defect.

```ts
await this.store.saveRow(before).catch(() => undefined);
```

Start a Favorite update. Start a Title update while the first request waits. Fail both requests.

The second update captures the first update's optimistic favorite value. Its rollback restores that value after the first rollback removes it. The reproduction ends with `important=true`, `title="Old"`, and an empty undo stack. The original favorite value is false.

The plan requires a failed write to restore the previous state. Serialize the read, local update, API call, reply, and rollback for each bookmark. This finding shares the incomplete queue boundary with finding 1.

### 3. Should-fix. Rounded scores put open count before relevance

Location [src/store/sql.ts:123](../../src/store/sql.ts#L123). The completeness and correctness passes find this defect.

```ts
const order = match ? `round(${bm25}, 1), open_count DESC, ${bm25}, b.created DESC` : OPENED_ORDER;
```

The binding plan requires BM25 before open count at `docs/plans/0001-plan-tinydrop-features-2026-11-04.md:49`.

The reproduction stores one title match and one note match for `rust`. Their BM25 scores are `-1.9748653500897667e-6` and `-1.5492957746478875e-6`. Both rounded values equal zero. One open on the note match gives result IDs `[2,1]`, although the title match has better relevance.

Keep raw BM25 before open count. Obtain a separate decision if the project needs a different ranking rule.

### 4. Should-fix. A metadata failure repeats one request per bookmark

Locations [src/sync/sync.ts:204](../../src/sync/sync.ts#L204) and [src/store/sqlite.ts:356](../../src/store/sqlite.ts#L356). The correctness pass finds this defect.

```ts
removed = await store.deleteUnseen();
```

The cleanup includes this statement.

```ts
"DELETE FROM sync_seen;",
```

The metadata requests and final resume-state update follow cleanup. A metadata failure preserves the saved page position but removes the seen IDs.

The resumed run reaches the final page and treats all stored rows as unseen. It requests each bookmark separately. The two-row reproduction records `["page 1","item 1","item 2"]`.

A 10,000-row library can need 10,000 extra requests. At two requests per second, those requests take about 83 minutes before network overhead.

Preserve the seen IDs until the run completes. Alternatively, persist a separate metadata phase and resume that phase directly.

## Pass results and scope

The fresh reviewer reads the branch change and the binding plan. The review covers issue #1, Phases 1 through 8. Issue #2 keeps the attended Mac acceptance checks separate.

- Convention. No separate finding. The module boundaries, SQL helpers, secret storage design, package manager, and bundle format follow the repository rules.
- Slop. No separate finding. The review finds no additional unsupported dependency, unused abstraction, or implementation placeholder.
- Completeness. Finding 3 changes the binding ranking rule. The remaining Phase 1 through 8 behaviors have implementations and local test coverage.
- Correctness. Findings 1, 2, and 4 fail targeted reproductions. The existing suite does not detect these defects.

The lockfile and generated icon receive inspection of selected parts. The review does not establish every external API limit or native render behavior.

## Verified results

At the reviewed head, the parent agent verifies 124 passing tests in 10 files, typecheck, build, and all 22 smoke flows. No tests skip. Each command bundle stays below 300 KB.

The Mac benchmark uses 10,000 synthetic rows and the system SQLite 3.54.0. Write p95 is 17.3 ms. Query p95 is 13.7 ms for prefixes, 11.7 ms for operators, and 13.6 ms for an empty query.

The parent agent independently repeats the four defect reproductions. The review aid uses fake clients and temporary SQLite data. It makes no real-account requests.

Run the local review aid from this worktree.

```sh
node --input-type=module < /private/tmp/tinydrop-review-repro.mjs
```

The review aid remains outside the repository. Temporary-file cleanup can remove it. The evidence above records its results.

## Coverage limits

This is a fresh review by a separate agent. The parent agent verifies its reproduced findings. Neither agent changes implementation files.

The missing source `.env` prevents the declared setup copy. The locked dependencies install separately without a token. The live probe remains blocked by the absent token and this request's prohibition on real-account writes.

The review does not test the Swift renderer, real Keychain persistence, real-account writes, simultaneous command contexts, or the real library. The machine runs macOS 27.2 and Node 26.13.0. This run does not establish macOS 26 or Node 24 compatibility.

GitHub reports no CI checks and no review threads. No merge, push, implementation fix, or real-account write occurs.

The updated [QA plan](../qa/0001-qa-tinydrop-v1-2026-11-05.md) records the commands, measurements, and remaining checks. The four manual cases remain unmarked.
