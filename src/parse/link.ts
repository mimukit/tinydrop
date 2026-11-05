// Links for the Add form and Quick Add: the http(s) check, the normalized form
// the duplicate warning compares, and the duplicate lookup. No @raycast/api import.
import { UNSORTED_COLLECTION } from "../api/types";
import { collectionPath } from "../search/collections";
import type { BookmarkRow, BookmarkStore, CollectionRow } from "../store/types";

/** The text as an http or https URL, or undefined. */
export function httpUrl(text: string | undefined): URL | undefined {
  const value = text?.trim();
  if (!value || /\s/.test(value) || !/^https?:\/\//i.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** True when the text is one http or https URL. */
export function isHttpUrl(text: string | undefined): boolean {
  return httpUrl(text) !== undefined;
}

/**
 * The link the duplicate check compares: lowercase host, no `utm_*` parameters, no trailing `/`.
 * A text that is not a URL comes back trimmed.
 */
export function normalizeLink(link: string): string {
  const url = httpUrl(link);
  if (!url) return link.trim();
  for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key)) url.searchParams.delete(key);
  const search = url.searchParams.toString();
  const path = url.pathname.replace(/\/+$/, "");
  const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";
  return `${url.protocol}//${auth}${url.host.toLowerCase()}${path}${search ? `?${search}` : ""}${url.hash}`.replace(/\/+$/, "");
}

export interface Duplicate {
  row: BookmarkRow;
  /** "Dev > Rust", "Unsorted", or "Collection 42" when the store lacks it. */
  collection: string;
}

/** The first stored bookmark with the same normalized link, outside Trash. */
export async function findDuplicate(
  store: Pick<BookmarkStore, "findByHost">,
  link: string,
  collections: CollectionRow[],
): Promise<Duplicate | undefined> {
  const url = httpUrl(link);
  if (!url) return undefined;
  const want = normalizeLink(link);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const rows = await store.findByHost(host);
  const row = rows.find((r) => normalizeLink(r.link) === want);
  if (!row) return undefined;
  const collection =
    collectionPath(row.collectionId, collections) ?? (row.collectionId === UNSORTED_COLLECTION ? "Unsorted" : `Collection ${row.collectionId}`);
  return { row, collection };
}

/** The duplicate warning text. */
export function duplicateText(dup: Duplicate): string {
  return `Already saved in ${dup.collection}`;
}
