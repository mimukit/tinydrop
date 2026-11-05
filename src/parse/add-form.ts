import { UNSORTED_COLLECTION } from "../api/types";
import type { CollectionRow } from "../store/types";
import { mergeTags } from "./tags";

export function defaultCollection(collections: CollectionRow[], last?: string): string {
  if (last !== undefined && (last === String(UNSORTED_COLLECTION) || collections.some((c) => String(c.id) === last))) return last;
  const named = collections.filter((c) => c.title.toLowerCase() === "bookmarks");
  return String((named.find((c) => c.parentId === undefined) ?? named[0])?.id ?? UNSORTED_COLLECTION);
}

/** Keep stored spelling for existing tags and accept new names unchanged. */
export function formTags(text: string, available: string[]): string[] {
  return mergeTags([], text).map((name) => available.find((tag) => tag.toLowerCase() === name.toLowerCase()) ?? name);
}

export function formTagSuggestions(text: string, available: string[]): { name: string; text: string }[] {
  const start = text.lastIndexOf(",") + 1;
  const prefix = text.slice(start).trim().replace(/^#/, "").toLowerCase();
  const selected = formTags(text.slice(0, start), available).map((name) => name.toLowerCase());
  return available.filter((name) => name.toLowerCase().startsWith(prefix) && !selected.includes(name.toLowerCase()))
    .slice(0, 8).map((name) => ({ name, text: `${text.slice(0, start)}${start ? " " : ""}${name}, ` }));
}
