// Collection names for search: `in:` resolution, the dropdown choices, the
// collection path in the details panel, and the store query. No @raycast/api import.
import { UNSORTED_COLLECTION } from "../api/types";
import type { CollectionRow, SearchQuery } from "../store/types";
import type { ParsedSearch } from "./parse";

export const UNSORTED_TITLE = "Unsorted";
/** The dropdown value for no collection filter. */
export const ALL_VALUE = "all";

export interface CollectionChoice {
  /** The dropdown value: ALL_VALUE or the collection ID as text. */
  value: string;
  title: string;
}

export type Resolved = { ok: true; ids: number[] } | { ok: false; error: string };

/**
 * Resolves one `in:` name to collection IDs: every collection whose title equals the name
 * (case-insensitive), else the one collection whose title starts with it. "Unsorted" matches
 * the Unsorted collection when no collection has that title.
 */
export function resolveCollection(name: string, collections: CollectionRow[]): Resolved {
  const want = name.trim().toLowerCase();
  if (!want) return { ok: false, error: "in: needs a collection name" };
  const exact = collections.filter((c) => c.title.toLowerCase() === want);
  if (exact.length > 0) return { ok: true, ids: exact.map((c) => c.id) };
  if (UNSORTED_TITLE.toLowerCase() === want) return { ok: true, ids: [UNSORTED_COLLECTION] };
  const prefix = collections.filter((c) => c.title.toLowerCase().startsWith(want));
  if (prefix.length === 1) return { ok: true, ids: [prefix[0].id] };
  if (prefix.length === 0 && UNSORTED_TITLE.toLowerCase().startsWith(want)) return { ok: true, ids: [UNSORTED_COLLECTION] };
  if (prefix.length === 0) return { ok: false, error: `No collection named "${name}"` };
  return { ok: false, error: `"${name}" matches ${prefix.length} collections: ${prefix.map((c) => c.title).join(", ")}` };
}

export type BuiltQuery = { ok: true; query: SearchQuery } | { ok: false; error: string };

/**
 * The store query for a parsed search and the dropdown value. The dropdown and each
 * `in:` combine with AND.
 */
export function buildQuery(parsed: ParsedSearch, collections: CollectionRow[], dropdown: string = ALL_VALUE): BuiltQuery {
  const collectionSets: number[][] = [];
  for (const name of parsed.collections) {
    const r = resolveCollection(name, collections);
    if (!r.ok) return r;
    collectionSets.push(r.ids);
  }
  const query: SearchQuery = {
    words: parsed.words,
    phrases: parsed.phrases,
    excludes: parsed.excludes,
    tags: parsed.tags,
    excludeTags: parsed.excludeTags,
    types: parsed.types,
    collectionSets,
    favorite: parsed.favorite,
  };
  const id = dropdownCollection(dropdown);
  if (id !== undefined) query.collectionId = id;
  return { ok: true, query };
}

/** The collection ID of a dropdown value, or undefined for "All" or a bad value. */
export function dropdownCollection(value: string | undefined): number | undefined {
  if (!value || value === ALL_VALUE) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}

function byPlace(a: CollectionRow, b: CollectionRow): number {
  const ga = a.groupOrder ?? Number.MAX_SAFE_INTEGER;
  const gb = b.groupOrder ?? Number.MAX_SAFE_INTEGER;
  return ga - gb || a.sort - b.sort || a.title.localeCompare(b.title);
}

/**
 * The dropdown choices: "All", then Unsorted, then the tree as `Parent > Child` labels.
 * Roots follow the `user.groups` order; children follow their parent in `sort` order.
 */
export function collectionChoices(collections: CollectionRow[]): CollectionChoice[] {
  const ids = new Set(collections.map((c) => c.id));
  const children = new Map<number, CollectionRow[]>();
  const roots: CollectionRow[] = [];
  for (const c of collections) {
    if (c.parentId !== undefined && ids.has(c.parentId)) {
      const list = children.get(c.parentId) ?? [];
      list.push(c);
      children.set(c.parentId, list);
    } else {
      roots.push(c);
    }
  }
  const out: CollectionChoice[] = [
    { value: ALL_VALUE, title: "All" },
    { value: String(UNSORTED_COLLECTION), title: UNSORTED_TITLE },
  ];
  const seen = new Set<number>();
  const walk = (c: CollectionRow, prefix: string) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    const title = prefix ? `${prefix} > ${c.title}` : c.title;
    out.push({ value: String(c.id), title });
    for (const child of (children.get(c.id) ?? []).sort(byPlace)) walk(child, title);
  };
  for (const root of roots.sort(byPlace)) walk(root, "");
  return out;
}

/** "Dev > Rust" for a collection ID; "Unsorted" for -1; undefined when unknown. */
export function collectionPath(id: number, collections: CollectionRow[]): string | undefined {
  if (id === UNSORTED_COLLECTION) return UNSORTED_TITLE;
  const byId = new Map(collections.map((c) => [c.id, c]));
  const names: string[] = [];
  const seen = new Set<number>();
  let at = byId.get(id);
  while (at && !seen.has(at.id)) {
    seen.add(at.id);
    names.unshift(at.title);
    at = at.parentId !== undefined ? byId.get(at.parentId) : undefined;
  }
  return names.length ? names.join(" > ") : undefined;
}
