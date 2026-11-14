// Links for the Add form: the http(s) check, the normalized form
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

/** Query parameters that only track a click. `ref` is not one: it can pick the page. */
const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|mc_cid|mc_eid|ref_src)$/i;

/** The decoded name of one raw `name=value` query pair. */
function paramName(pair: string): string {
  const name = pair.split("=", 1)[0];
  try {
    return decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    return name;
  }
}

/** The raw query pairs without tracking parameters, sorted by name; repeated names keep their order. */
function keptQuery(search: string): string[] {
  return search
    .slice(1)
    .split("&")
    .filter(Boolean)
    .map((pair) => ({ pair, name: paramName(pair) }))
    .filter((p) => !TRACKING_PARAM.test(p.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((p) => p.pair);
}

/**
 * The duplicate key. For an http(s) URL: the host in lowercase without a leading `www.`, http and
 * https as one, no trailing path `/`, no ordinary fragment (a `#/` or `#!` hash route stays), no
 * tracking parameters (`utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `ref_src`; `ref` stays), and
 * the other parameters sorted by name. Credentials and a non-default port stay.
 * A text that is not an http(s) URL comes back trimmed.
 */
export function normalizeLink(link: string): string {
  const url = httpUrl(link);
  if (!url) return link.trim();
  const query = keptQuery(url.search);
  const path = url.pathname.replace(/\/+$/, "");
  const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const port = url.port ? `:${url.port}` : "";
  const hash = /^#[/!]/.test(url.hash) ? url.hash : "";
  return `https://${auth}${host}${port}${path}${query.length ? `?${query.join("&")}` : ""}${hash}`;
}

export interface Duplicate {
  row: BookmarkRow;
  /** "Dev > Rust", "Unsorted", or "Collection 42" when the store lacks it. */
  collection: string;
}

/** The first stored bookmark with the same duplicate key (`normalizeLink()`), outside Trash. */
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
