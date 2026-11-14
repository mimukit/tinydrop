// Duplicate groups for the cleanup command: the key, the keeper, and the annotation warnings.
// Pure functions over store rows. No @raycast/api import.
import { TRASH_COLLECTION, UNSORTED_COLLECTION } from "../api/types";
import { normalizeLink } from "../parse/link";
import type { CleanupRow } from "../store/types";

export interface DuplicateGroup {
  /** The duplicate key every row shares: `normalizeLink()` of its link. */
  key: string;
  /** The bookmark cleanup keeps. */
  keeper: CleanupRow;
  /** The other bookmarks, in keeper order. Cleanup moves them to Trash. */
  extras: CleanupRow[];
  /** The keeper, then the extras. */
  rows: CleanupRow[];
  /** The extras with a note or highlights. Bulk cleanup skips them until the owner approves. */
  warnings: CleanupRow[];
}

/** True when the bookmark has a note or highlights, which cleanup does not merge into the keeper. */
export function hasAnnotations(row: CleanupRow): boolean {
  return row.noteLength > 0 || row.highlightCount > 0;
}

/** The creation time in ms; a missing or bad time sorts last. */
function createdMs(row: CleanupRow): number {
  const ms = Date.parse(row.created);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * Keeper order, best first: favorite, most highlights, a non-empty note, a named collection over
 * Unsorted, most tags, oldest `created`, then the lower bookmark ID. Negative when `a` is the better keeper.
 */
export function compareKeeper(a: CleanupRow, b: CleanupRow): number {
  const named = (r: CleanupRow) => (r.collectionId === UNSORTED_COLLECTION ? 0 : 1);
  const hasNote = (r: CleanupRow) => (r.noteLength > 0 ? 1 : 0);
  const ca = createdMs(a);
  const cb = createdMs(b);
  return (
    Number(b.important) - Number(a.important) ||
    b.highlightCount - a.highlightCount ||
    hasNote(b) - hasNote(a) ||
    named(b) - named(a) ||
    b.tags.length - a.tags.length ||
    (ca === cb ? 0 : ca < cb ? -1 : 1) ||
    a.id - b.id
  );
}

/** The best keeper of the rows by `compareKeeper()`. The rows must not be empty. */
export function chooseKeeper(rows: readonly CleanupRow[]): CleanupRow {
  if (rows.length === 0) throw new Error("chooseKeeper needs at least one row");
  return rows.reduce((best, r) => (compareKeeper(r, best) < 0 ? r : best));
}

function groupOf(key: string, keeper: CleanupRow, extras: CleanupRow[]): DuplicateGroup {
  return { key, keeper, extras, rows: [keeper, ...extras], warnings: extras.filter(hasAnnotations) };
}

function rankedGroup(key: string, rows: readonly CleanupRow[]): DuplicateGroup {
  const [keeper, ...extras] = [...rows].sort(compareKeeper);
  return groupOf(key, keeper, extras);
}

/** The group with the owner's keeper. The other rows become extras, in keeper order. Throws when the ID is not in the group. */
export function withKeeper(group: DuplicateGroup, keeperId: number): DuplicateGroup {
  const keeper = group.rows.find((r) => r.id === keeperId);
  if (!keeper) throw new RangeError(`Bookmark ${keeperId} is not in the duplicate group ${group.key}`);
  const extras = group.rows.filter((r) => r.id !== keeperId).sort(compareKeeper);
  return groupOf(group.key, keeper, extras);
}

/**
 * The extras bulk cleanup moves to Trash. Extras with a note or highlights stay out
 * until the owner opens the group and approves their removal.
 */
export function bulkTrashIds(group: DuplicateGroup, approvedAnnotated = false): number[] {
  return group.extras.filter((r) => approvedAnnotated || !hasAnnotations(r)).map((r) => r.id);
}

/**
 * The groups of two or more bookmarks with the same key, across collections. Rows in Trash stay out.
 * The largest group comes first, then by key.
 */
export function groupDuplicates(rows: readonly CleanupRow[]): DuplicateGroup[] {
  const byKey = new Map<string, CleanupRow[]>();
  for (const row of rows) {
    if (row.collectionId === TRASH_COLLECTION) continue;
    const key = normalizeLink(row.link);
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }
  return [...byKey]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => rankedGroup(key, list))
    .sort((a, b) => b.rows.length - a.rows.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
