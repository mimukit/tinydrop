// Every bookmark write a window makes. Each one changes the store first, pushes
// its undo entry, sends only the changed fields through the WriteQueue, and
// replaces the row from the server reply. On failure it puts the old row back,
// drops the undo entry and reports the error. Online only: no offline queue.
// Bulk cleanup (trashBookmarks, cleanupDuplicates) moves rows in batches of at most
// 100, tracks each confirmed, failed and unresolved ID, and keeps one undo entry.
// No @raycast/api import here, so vitest runs it with a fake client.
import { BULK_LIMIT, type RaindropClient } from "../api/client";
import { BulkGuardError, RaindropApiError, isTokenRejected } from "../api/errors";
import { WriteQueue } from "../api/queue";
import { TRASH_COLLECTION, type BulkReply, type Raindrop, type RaindropPatch } from "../api/types";
import { bulkTrashIds, type DuplicateGroup } from "../cleanup/duplicates";
import type { BookmarkRow, BookmarkStore, CollectionMove } from "../store/types";
import { UndoStack, applyFields, changedFields, previousFields, type CleanupUndoEntry, type UndoEntry } from "../undo/stack";

export type WriterClient = Pick<
  RaindropClient,
  "updateRaindrop" | "deleteRaindrop" | "createRaindrop" | "getRaindrop" | "trashRaindrops" | "restoreRaindrops"
>;
export type WriterStore = Pick<BookmarkStore, "getBookmark" | "saveRow" | "upsertPage" | "trashLocal" | "restoreLocal">;

/** The outcome of a bulk trash. Counts, then the IDs behind each count. */
export interface CleanupResult {
  /** Bookmarks the operation tried to move to Trash. */
  requested: number;
  /** Raindrop confirmed these in Trash. The undo entry holds exactly these. */
  trashed: number;
  /** Raindrop confirmed these outside Trash. Their local rows are back in their collections. */
  failed: number;
  /** The state is unknown after a timeout or a short `modified` and a failed re-read. Sync to check them. */
  unresolved: number;
  /** Extras left untouched, in Raindrop and in the store, because their keeper's tag update failed. */
  skipped: number;
  /** Duplicate groups whose keeper tag update failed. */
  tagFailures: number;
  ids: { trashed: number[]; failed: number[]; unresolved: number[]; skipped: number[] };
  /** The first error a call raised, if any. A rejected token stops the operation. */
  error?: unknown;
  /** The undo entry for the trashed bookmarks, when there are any. */
  entry?: CleanupUndoEntry;
}

/** The outcome of restoring one cleanup undo entry. */
export interface RestoreResult {
  /** Bookmarks the entry held. */
  requested: number;
  /** Raindrop confirmed these outside Trash. */
  restored: number;
  /** Still in Trash, or unknown after a failed re-read. The retry entry holds these. */
  remaining: number;
  ids: { restored: number[]; remaining: number[] };
  error?: unknown;
  /** The entry for the IDs not restored yet, when some remain. `undoLast` puts it back on the stack. */
  retry?: CleanupUndoEntry;
}

/** An undo restored some bookmarks of a cleanup, not all. `result` holds the counts. */
export class PartialRestoreError extends Error {
  constructor(readonly result: RestoreResult) {
    super(`Restored ${result.restored} of ${result.requested}. ${result.remaining} still in Trash. Undo again to retry.`);
    this.name = "PartialRestoreError";
  }
}

export interface CleanupOptions {
  /** The undo label, such as "Trash All Extras". */
  label?: string;
}

export interface DuplicateCleanupOptions extends CleanupOptions {
  /** True, or the keys of the groups whose annotated extras the owner approved for Trash. */
  approvedAnnotated?: boolean | ReadonlySet<string>;
}

/** A bulk operation did not finish. `result` holds the counts. */
export class PartialCleanupError extends Error {
  constructor(readonly result: CleanupResult) {
    super(PartialCleanupError.describe(result));
    this.name = "PartialCleanupError";
  }

  private static describe(r: CleanupResult): string {
    const parts = [`Moved ${r.trashed} of ${r.requested + r.skipped} to Trash.`];
    if (r.failed) parts.push(`${r.failed} failed.`);
    if (r.unresolved) parts.push(`${r.unresolved} unresolved: sync to check them.`);
    if (r.skipped) parts.push(`${r.skipped} skipped after ${r.tagFailures} tag update${r.tagFailures === 1 ? "" : "s"} failed.`);
    return parts.join(" ");
  }
}

/** The keeper's tags, then each other tag it lacks, compared without case. */
export function mergeTags(keeperTags: readonly string[], otherTags: readonly string[]): string[] {
  const out = [...keeperTags];
  const have = new Set(keeperTags.map((t) => t.toLowerCase()));
  for (const tag of otherTags) {
    const lower = tag.toLowerCase();
    if (have.has(lower)) continue;
    have.add(lower);
    out.push(tag);
  }
  return out;
}

/** One chunk of a bulk operation: at most BULK_LIMIT IDs that share a collection. */
interface Chunk {
  collectionId: number;
  ids: number[];
}

interface BulkOp {
  bulk: (client: WriterClient, chunk: Chunk) => Promise<BulkReply>;
  /** The same move for one bookmark on the existing endpoint, when the API lacks the bulk route. */
  single: (client: WriterClient, collectionId: number, id: number) => Promise<unknown>;
  /** True when a re-read item shows the move happened. */
  settled: (collectionId: number | undefined) => boolean;
}

/** The collection of an API item. */
function collectionOf(item: Raindrop | undefined): number | undefined {
  return item?.collection?.$id ?? item?.collectionId;
}

interface BulkOutcome {
  done: number[];
  failed: number[];
  unresolved: number[];
  error?: unknown;
}

/** What a failed call means for its IDs. */
type FailureKind = "auth" | "failed" | "ambiguous" | "unsupported";

/**
 * A rejected token stops the operation. A 4xx reply or a guard refusal means nothing moved. A bulk 404,
 * 405 or 501 means the API lacks the bulk route. A 5xx reply or a thrown error (timeout, network) may
 * have moved some IDs: those need a re-read.
 */
export function classifyFailure(error: unknown, bulk: boolean): FailureKind {
  if (error instanceof BulkGuardError) return "failed";
  if (!(error instanceof RaindropApiError)) return "ambiguous";
  if (error.status === 401) return "auth";
  if (bulk && (error.status === 404 || error.status === 405 || error.status === 501)) return "unsupported";
  if (error.status >= 500) return "ambiguous";
  return "failed";
}

/** Groups moves by collection, then splits each group into chunks of at most `limit` IDs. */
export function chunkByCollection(moves: readonly CollectionMove[], limit = BULK_LIMIT): Chunk[] {
  const byCollection = new Map<number, number[]>();
  for (const m of moves) {
    const list = byCollection.get(m.collectionId);
    if (list) list.push(m.id);
    else byCollection.set(m.collectionId, [m.id]);
  }
  const chunks: Chunk[] = [];
  for (const [collectionId, ids] of byCollection) {
    for (let i = 0; i < ids.length; i += limit) chunks.push({ collectionId, ids: ids.slice(i, i + limit) });
  }
  return chunks;
}

export interface WriterHooks {
  /** The store or the undo stack changed: query the rows again. */
  onChange?: () => void;
  /** The store took a write; the server call is still out. */
  onApplied?: (message: string) => void | Promise<void>;
  /** A write failed. The row is back in its old state. */
  onFailure?: (title: string, error: unknown) => void | Promise<void>;
}

export interface WriteOptions {
  /** The undo label, such as "Favorite". */
  label?: string;
  /** The toast text once the store took the write. */
  message?: string;
  /** False for the write an undo makes. */
  undo?: boolean;
}

export class BookmarkWriter {
  readonly undo: UndoStack;
  private readonly queue = new WriteQueue();

  constructor(
    private readonly client: () => Promise<WriterClient>,
    private readonly store: WriterStore,
    private readonly hooks: WriterHooks = {},
    undo: UndoStack = new UndoStack(),
  ) {
    this.undo = undo;
  }

  private changed(): void {
    this.hooks.onChange?.();
  }

  /** The store's copy of the row, so a write on a stale screen row starts from the latest state. */
  private async current(row: BookmarkRow): Promise<BookmarkRow> {
    return (await this.store.getBookmark(row.id)) ?? row;
  }

  /**
   * The shared path: store first, undo entry, the server call in the row's queue, the reply into
   * the store. On a server error the old row goes back and the entry drops.
   */
  private async write(
    before: BookmarkRow,
    after: BookmarkRow,
    send: (client: WriterClient) => Promise<Raindrop | void>,
    entry: UndoEntry | undefined,
    message: string | undefined,
    failTitle: string,
  ): Promise<boolean> {
    await this.store.saveRow(after);
    if (entry) this.undo.push(entry);
    this.changed();
    if (message) void this.hooks.onApplied?.(message);
    let reply: Raindrop | void;
    try {
      reply = await this.queue.run(String(before.id), async () => send(await this.client()));
    } catch (error) {
      if (entry) this.undo.remove(entry);
      // The failure toast shows either way; a store error here only leaves the row for the next sync.
      await this.store.saveRow(before).catch(() => undefined);
      this.changed();
      await this.hooks.onFailure?.(failTitle, error);
      return false;
    }
    if (reply && typeof reply === "object" && typeof reply._id === "number") {
      try {
        await this.store.upsertPage([reply]);
      } catch (error) {
        await this.hooks.onFailure?.("Saved, but the store did not take the reply", error);
      }
    }
    this.changed();
    return true;
  }

  /** Changes some fields with one `PUT /raindrop/{id}` that carries only the changed ones. */
  async update(row: BookmarkRow, patch: RaindropPatch, options: WriteOptions = {}): Promise<boolean> {
    const before = await this.current(row);
    const changed = changedFields(before, patch);
    if (Object.keys(changed).length === 0) return true;
    const label = options.label ?? "Edit";
    const entry: UndoEntry | undefined =
      options.undo === false ? undefined : { kind: "fields", label, bookmarkId: before.id, previous: previousFields(before, changed) };
    return this.write(
      before,
      applyFields(before, changed),
      (client) => client.updateRaindrop(before.id, changed),
      entry,
      options.message,
      `Could not save: ${label}`,
    );
  }

  /** Moves a bookmark to another collection: `PUT /raindrop/{id}` with `collection.$id` only. */
  async move(row: BookmarkRow, toCollectionId: number, options: WriteOptions = {}): Promise<boolean> {
    const before = await this.current(row);
    if (before.collectionId === toCollectionId) return true;
    const patch: RaindropPatch = { collection: { $id: toCollectionId } };
    const label = options.label ?? "Move";
    const entry: UndoEntry | undefined =
      options.undo === false
        ? undefined
        : { kind: "move", label, bookmarkId: before.id, fromCollectionId: before.collectionId, toCollectionId };
    return this.write(
      before,
      applyFields(before, patch),
      (client) => client.updateRaindrop(before.id, patch),
      entry,
      options.message,
      `Could not save: ${label}`,
    );
  }

  /**
   * Moves a bookmark to Trash with `DELETE /raindrop/{id}`, no confirmation. The row stays in
   * the store under Trash, which search leaves out, until a sync drops it.
   */
  async trash(row: BookmarkRow, options: WriteOptions = {}): Promise<boolean> {
    const before = await this.current(row);
    if (before.collectionId === TRASH_COLLECTION) return true;
    const label = options.label ?? "Delete";
    const entry: UndoEntry | undefined =
      options.undo === false ? undefined : { kind: "trash", label, bookmarkId: before.id, collectionId: before.collectionId };
    return this.write(
      before,
      { ...before, collectionId: TRASH_COLLECTION },
      (client) => client.deleteRaindrop(before.id),
      entry,
      options.message,
      `Could not save: ${label}`,
    );
  }

  /**
   * Reverts the last write of this window with one API call. Undo of a delete sends
   * `PUT /raindrop/{id}` with the old `collection.$id`, which brings it back from Trash.
   * On failure the entry goes back on the stack. Resolves to the entry it reverted.
   */
  async undoLast(options: { message?: (entry: UndoEntry) => string } = {}): Promise<UndoEntry | undefined> {
    const entry = this.undo.pop();
    this.changed();
    if (!entry) return undefined;
    if (entry.kind === "cleanup") return this.undoCleanup(entry);
    const row = await this.store.getBookmark(entry.bookmarkId);
    if (!row) {
      await this.hooks.onFailure?.(`Could not undo: ${entry.label}`, new Error("The bookmark is no longer in the store. Sync, then try again."));
      return undefined;
    }
    const message = options.message?.(entry);
    let ok: boolean;
    if (entry.kind === "fields") {
      ok = await this.update(row, entry.previous, { label: `Undo ${entry.label}`, message, undo: false });
    } else if (entry.kind === "move") {
      ok = await this.move(row, entry.fromCollectionId, { label: `Undo ${entry.label}`, message, undo: false });
    } else {
      ok = await this.move(row, entry.collectionId, { label: `Undo ${entry.label}`, message, undo: false });
    }
    if (!ok) {
      this.undo.push(entry);
      this.changed();
      return undefined;
    }
    return entry;
  }

  /**
   * Runs chunks of a bulk operation in the write queue, one key per bookmark ID. A rejected token stops
   * the rest, which count as failed. An unsupported bulk route switches this and every later chunk to
   * single calls. Uncertain IDs get a re-read before they count.
   */
  private async sendBulk(chunks: Chunk[], op: BulkOp): Promise<BulkOutcome> {
    const out: BulkOutcome = { done: [], failed: [], unresolved: [] };
    let stopped = false;
    let bulkSupported = true;
    for (const chunk of chunks) {
      if (stopped) {
        out.failed.push(...chunk.ids);
        continue;
      }
      const uncertain: number[] = [];
      if (bulkSupported) {
        const kind = await this.sendChunk(chunk, op, out, uncertain);
        if (kind === "auth") stopped = true;
        if (kind === "unsupported") bulkSupported = false;
      }
      if (!bulkSupported) stopped = await this.sendSingles(chunk, op, out, uncertain);
      if (uncertain.length > 0) stopped = (await this.reconcile(uncertain, op, out)) || stopped;
    }
    return out;
  }

  /** One bulk call. Resolves to the failure kind, or undefined after a reply. */
  private async sendChunk(chunk: Chunk, op: BulkOp, out: BulkOutcome, uncertain: number[]): Promise<FailureKind | undefined> {
    try {
      const reply = await this.queue.runAll(chunk.ids.map(String), async () => op.bulk(await this.client(), chunk));
      // Only a full `modified` count is a success. A short count, even 0, leaves the batch to a re-read.
      if (reply?.result === true && reply.modified === chunk.ids.length) out.done.push(...chunk.ids);
      else uncertain.push(...chunk.ids);
      return undefined;
    } catch (error) {
      const kind = classifyFailure(error, true);
      if (kind === "unsupported") return kind;
      out.error ??= error;
      if (kind === "ambiguous") uncertain.push(...chunk.ids);
      else out.failed.push(...chunk.ids);
      return kind;
    }
  }

  /**
   * The fallback: one call per bookmark on the existing endpoint, through the same pacer (two calls
   * per second). Ambiguous failures go to `uncertain` for a re-read. Resolves to true when the token
   * was rejected; the rest of the chunk then counts as failed.
   */
  private async sendSingles(chunk: Chunk, op: BulkOp, out: BulkOutcome, uncertain: number[]): Promise<boolean> {
    for (let i = 0; i < chunk.ids.length; i++) {
      const id = chunk.ids[i];
      try {
        await this.queue.run(String(id), async () => op.single(await this.client(), chunk.collectionId, id));
        out.done.push(id);
      } catch (error) {
        out.error ??= error;
        const kind = classifyFailure(error, false);
        if (kind === "ambiguous") uncertain.push(id);
        else out.failed.push(id);
        if (kind === "auth") {
          out.failed.push(...chunk.ids.slice(i + 1));
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Re-reads each uncertain ID with `GET /raindrop/{id}`: a settled item is done, an unsettled one
   * failed, and a failed read leaves it unresolved. Resolves to true when the token was rejected.
   */
  private async reconcile(ids: number[], op: BulkOp, out: BulkOutcome): Promise<boolean> {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      try {
        const item = await (await this.client()).getRaindrop(id);
        (op.settled(collectionOf(item)) ? out.done : out.failed).push(id);
      } catch (error) {
        out.unresolved.push(id);
        if (classifyFailure(error, false) === "auth") {
          out.error ??= error;
          out.unresolved.push(...ids.slice(i + 1));
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Moves bookmarks to Trash with `DELETE /raindrops/{collectionId}`, one call per current collection
   * and batch of at most 100. The store moves the rows first. One undo entry keeps every confirmed ID
   * with its original collection. Rows already in Trash are left out.
   */
  async trashBookmarks(targets: readonly CollectionMove[], options: CleanupOptions = {}): Promise<CleanupResult> {
    const label = options.label ?? "Trash";
    const result = await this.trashMany(targets, label);
    await this.reportPartial(label, result);
    return result;
  }

  /**
   * Cleans up duplicate groups. For each group: the extras bulk cleanup may trash (annotated extras only
   * with approval), a `PUT /raindrop/{keeper}` that sends only `tags` (the keeper's tags plus the extras'),
   * then one bulk trash of every group's extras. A failed tag update leaves that group's extras untouched.
   * Notes and highlights do not merge. Undo restores collections and leaves the merged tags.
   */
  async cleanupDuplicates(groups: readonly DuplicateGroup[], options: DuplicateCleanupOptions = {}): Promise<CleanupResult> {
    const label = options.label ?? "Trash Extras";
    const approved = options.approvedAnnotated ?? false;
    const plan = groups
      .map((g) => {
        const ids = new Set(bulkTrashIds(g, typeof approved === "boolean" ? approved : approved.has(g.key)));
        return { keeper: g.keeper, extras: g.extras.filter((r) => ids.has(r.id)) };
      })
      .filter((p) => p.extras.length > 0);
    let targets: CollectionMove[] = [];
    const skipped: number[] = [];
    let tagFailures = 0;
    let tagError: unknown;
    for (let i = 0; i < plan.length; i++) {
      const { keeper, extras } = plan[i];
      try {
        await this.mergeKeeperTags(keeper.id, keeper.tags, extras.flatMap((r) => r.tags));
      } catch (error) {
        tagFailures++;
        tagError ??= error;
        skipped.push(...extras.map((r) => r.id));
        if (isTokenRejected(error)) {
          // Every later call would fail the same way: leave every extra untouched.
          skipped.push(...targets.map((t) => t.id), ...plan.slice(i + 1).flatMap((p) => p.extras.map((r) => r.id)));
          targets = [];
          break;
        }
        continue;
      }
      targets.push(...extras.map((r) => ({ id: r.id, collectionId: r.collectionId })));
    }
    const result = await this.trashMany(targets, label);
    result.skipped = skipped.length;
    result.ids.skipped = skipped;
    result.tagFailures = tagFailures;
    result.error ??= tagError;
    await this.reportPartial(label, result);
    return result;
  }

  /** Sends the merged tags with only `tags` in the body, in the keeper's queue. Throws when the update fails. */
  private async mergeKeeperTags(keeperId: number, fallbackTags: readonly string[], extraTags: readonly string[]): Promise<void> {
    const current = (await this.store.getBookmark(keeperId))?.tags ?? fallbackTags;
    const tags = mergeTags(current, extraTags);
    if (tags.length === current.length) return;
    const reply = await this.queue.run(String(keeperId), async () => (await this.client()).updateRaindrop(keeperId, { tags }));
    try {
      if (reply && typeof reply._id === "number") await this.store.upsertPage([reply]);
      else {
        const row = await this.store.getBookmark(keeperId);
        if (row) await this.store.saveRow({ ...row, tags });
      }
    } catch {
      // Raindrop has the tags; the next sync brings them into the store.
    }
    this.changed();
  }

  /** One failure report for a bulk operation that did not finish. */
  private async reportPartial(label: string, result: CleanupResult): Promise<void> {
    if (result.failed + result.unresolved + result.skipped === 0) return;
    // A rejected token goes to the hook as itself, so the toast offers the Account action.
    const error = isTokenRejected(result.error) ? result.error : new PartialCleanupError(result);
    await this.hooks.onFailure?.(`Could not finish: ${label}`, error);
  }

  /** The bulk trash without the failure report. */
  private async trashMany(targets: readonly CollectionMove[], label: string): Promise<CleanupResult> {
    const seen = new Set<number>();
    const items = targets.filter((t) => t.collectionId !== TRASH_COLLECTION && !seen.has(t.id) && seen.add(t.id));
    const original = new Map(items.map((t) => [t.id, t.collectionId]));
    const result: CleanupResult = {
      requested: items.length,
      trashed: 0,
      failed: 0,
      unresolved: 0,
      skipped: 0,
      tagFailures: 0,
      ids: { trashed: [], failed: [], unresolved: [], skipped: [] },
    };
    if (items.length === 0) return result;
    await this.store.trashLocal(items.map((t) => t.id));
    this.changed();
    const outcome = await this.sendBulk(chunkByCollection(items), {
      bulk: (client, chunk) => client.trashRaindrops(chunk.collectionId, chunk.ids),
      single: (client, _collectionId, id) => client.deleteRaindrop(id),
      settled: (collectionId) => collectionId === TRASH_COLLECTION,
    });
    const back = [...outcome.failed, ...outcome.unresolved].map((id) => ({ id, collectionId: original.get(id)! }));
    // A store error here only leaves the rows in Trash until the next sync.
    if (back.length > 0) await this.store.restoreLocal(back).catch(() => undefined);
    result.error = outcome.error;
    result.ids = { trashed: outcome.done, failed: outcome.failed, unresolved: outcome.unresolved, skipped: [] };
    result.trashed = outcome.done.length;
    result.failed = outcome.failed.length;
    result.unresolved = outcome.unresolved.length;
    if (outcome.done.length > 0) {
      result.entry = { kind: "cleanup", label, items: outcome.done.map((id) => ({ id, collectionId: original.get(id)! })) };
      this.undo.push(result.entry);
    }
    this.changed();
    return result;
  }

  /** Undo of a cleanup. A partial restore goes back on the stack with only the IDs not restored. */
  private async undoCleanup(entry: CleanupUndoEntry): Promise<UndoEntry | undefined> {
    const result = await this.restoreCleanup(entry);
    if (result.retry) {
      this.undo.push(result.retry);
      this.changed();
      const error = isTokenRejected(result.error) ? result.error : new PartialRestoreError(result);
      await this.hooks.onFailure?.(`Could not undo: ${entry.label}`, error);
      return undefined;
    }
    this.changed();
    return entry;
  }

  /**
   * Brings a cleanup's bookmarks back from Trash, each to its original collection: `PUT /raindrops/-99`
   * per collection and batch of at most 100. It reads no local row, so it works after a sync dropped the
   * Trash rows. Only collection membership comes back; merged tags stay on the keeper. Leaves the undo stack alone.
   */
  async restoreCleanup(entry: CleanupUndoEntry): Promise<RestoreResult> {
    const original = new Map(entry.items.map((m) => [m.id, m.collectionId]));
    const outcome = await this.sendBulk(chunkByCollection(entry.items), {
      bulk: (client, chunk) => client.restoreRaindrops(chunk.collectionId, chunk.ids),
      single: (client, collectionId, id) => client.updateRaindrop(id, { collection: { $id: collectionId } }),
      settled: (collectionId) => collectionId !== undefined && collectionId !== TRASH_COLLECTION,
    });
    const restored = outcome.done.map((id) => ({ id, collectionId: original.get(id)! }));
    // Rows a sync dropped stay out; the next sync brings them back.
    if (restored.length > 0) await this.store.restoreLocal(restored).catch(() => undefined);
    const remaining = [...outcome.failed, ...outcome.unresolved];
    const result: RestoreResult = {
      requested: entry.items.length,
      restored: outcome.done.length,
      remaining: remaining.length,
      ids: { restored: outcome.done, remaining },
      error: outcome.error,
    };
    if (remaining.length > 0) {
      const left = new Set(remaining);
      result.retry = { ...entry, items: entry.items.filter((m) => left.has(m.id)) };
    }
    return result;
  }

  /** `POST /raindrop`, then the reply into the store, so Search finds it before the next sync. */
  async create(patch: RaindropPatch): Promise<Raindrop | undefined> {
    let reply: Raindrop;
    try {
      reply = await (await this.client()).createRaindrop(patch);
    } catch (error) {
      await this.hooks.onFailure?.("Could not save the bookmark", error);
      return undefined;
    }
    if (reply && typeof reply._id === "number") {
      try {
        await this.store.upsertPage([reply]);
      } catch (error) {
        await this.hooks.onFailure?.("Saved, but the store did not take the reply", error);
      }
    }
    this.changed();
    return reply;
  }
}
