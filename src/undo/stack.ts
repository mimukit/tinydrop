// The per-window undo stack. Copied from tinytick and adapted to bookmarks. It
// lives in memory, so it ends when the window closes. No @raycast/api import here.
import type { RaindropPatch } from "../api/types";
import type { BookmarkRow } from "../store/types";

export type UndoEntry =
  /** Restore these fields with one `PUT /raindrop/{id}`. */
  | { kind: "fields"; label: string; bookmarkId: number; previous: RaindropPatch }
  /** Move a bookmark back to the collection it came from. */
  | { kind: "move"; label: string; bookmarkId: number; fromCollectionId: number; toCollectionId: number }
  /** Bring a bookmark back from Trash: `PUT /raindrop/{id}` with its old `collection.$id`. */
  | { kind: "trash"; label: string; bookmarkId: number; collectionId: number };

export const UNDO_LIMIT = 10;

export class UndoStack {
  private entries: UndoEntry[] = [];

  constructor(private readonly limit = UNDO_LIMIT) {}

  push(entry: UndoEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
  }

  pop(): UndoEntry | undefined {
    return this.entries.pop();
  }

  /** Drops one entry, as when the write it would revert failed. */
  remove(entry: UndoEntry): void {
    this.entries = this.entries.filter((e) => e !== entry);
  }

  peek(): UndoEntry | undefined {
    return this.entries[this.entries.length - 1];
  }

  get size(): number {
    return this.entries.length;
  }
}

/** The fields of a row that a write can change, in API form. */
export function rowFields(row: BookmarkRow): Required<Pick<RaindropPatch, "link" | "title" | "note" | "tags" | "important" | "collection">> {
  return {
    link: row.link,
    title: row.title,
    note: row.note,
    tags: [...row.tags],
    important: row.important,
    collection: { $id: row.collectionId },
  };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Only the fields of `patch` that differ from the row. */
export function changedFields(row: BookmarkRow, patch: RaindropPatch): RaindropPatch {
  const current = rowFields(row) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || !(key in current)) continue;
    if (!same(current[key], value)) out[key] = value;
  }
  return out as RaindropPatch;
}

/** The old values of the fields a patch changes, so one update call restores them. */
export function previousFields(row: BookmarkRow, patch: RaindropPatch): RaindropPatch {
  const current = rowFields(row) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) if (key in current) out[key] = current[key];
  return out as RaindropPatch;
}

/** The domain the row shows for a link. */
export function domainOfLink(link: string): string {
  try {
    return new URL(link).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The row after a patch, as the store holds it before the server answers. */
export function applyFields(row: BookmarkRow, patch: RaindropPatch): BookmarkRow {
  const next: BookmarkRow = { ...row, tags: [...row.tags] };
  if (patch.link !== undefined) {
    next.link = patch.link;
    next.domain = domainOfLink(patch.link) || row.domain;
  }
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.note !== undefined) next.note = patch.note;
  if (patch.tags !== undefined) next.tags = [...patch.tags];
  if (patch.important !== undefined) next.important = patch.important;
  if (patch.collection !== undefined) next.collectionId = patch.collection.$id;
  return next;
}
