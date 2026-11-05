import { UNSORTED_COLLECTION } from "../api/types";
import type { CollectionRow } from "../store/types";

export function defaultCollection(collections: CollectionRow[], last?: string): string {
  if (last !== undefined && (last === String(UNSORTED_COLLECTION) || collections.some((c) => String(c.id) === last))) return last;
  const named = collections.filter((c) => c.title.toLowerCase() === "bookmarks");
  return String((named.find((c) => c.parentId === undefined) ?? named[0])?.id ?? UNSORTED_COLLECTION);
}
