// Every bookmark write a window makes. Each one changes the store first, pushes
// its undo entry, sends only the changed fields through the WriteQueue, and
// replaces the row from the server reply. On failure it puts the old row back,
// drops the undo entry and reports the error. Online only: no offline queue.
// No @raycast/api import here, so vitest runs it with a fake client.
import type { RaindropClient } from "../api/client";
import { WriteQueue } from "../api/queue";
import { TRASH_COLLECTION, type Raindrop, type RaindropPatch } from "../api/types";
import type { BookmarkRow, BookmarkStore } from "../store/types";
import { UndoStack, applyFields, changedFields, previousFields, type UndoEntry } from "../undo/stack";

export type WriterClient = Pick<RaindropClient, "updateRaindrop" | "deleteRaindrop" | "createRaindrop">;
export type WriterStore = Pick<BookmarkStore, "getBookmark" | "saveRow" | "upsertPage">;

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
