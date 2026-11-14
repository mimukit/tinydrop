// The store interface. Commands use only this, so tests can pass a fake store.
// No @raycast/api import here: vitest runs src/store/ in Node.
import type { Collection, Raindrop, RaindropType, Tag } from "../api/types";

export interface HighlightRow {
  text: string;
  note?: string;
}

export interface BookmarkRow {
  id: number;
  link: string;
  title: string;
  domain: string;
  type: RaindropType;
  collectionId: number;
  tags: string[];
  note: string;
  excerpt: string;
  cover: string;
  important: boolean;
  created: string;
  lastUpdate: string;
  highlights: HighlightRow[];
  openCount: number;
  lastOpened?: number;
}

/** One bookmark as the cleanup command reads it: the fields duplicate grouping and keeper choice need. */
export interface CleanupRow {
  id: number;
  link: string;
  title: string;
  collectionId: number;
  /** The ISO creation time from Raindrop. */
  created: string;
  /** The favorite flag. */
  important: boolean;
  tags: string[];
  /** The length of the note without surrounding white space. */
  noteLength: number;
  highlightCount: number;
}

/** A stored dead-link check class. `pending` is a first dead result that waits for its GET retry. */
export type LinkCheckClass = "ok" | "dead" | "unsure" | "skipped" | "pending";

/** One row of `link_checks`: the latest check of one bookmark. Times are ms since the epoch. */
export interface LinkCheckRow {
  bookmarkId: number;
  /** The bookmark link the check used. A row whose URL differs from the current link is stale. */
  url: string;
  class: LinkCheckClass;
  /** The HTTP status, when a response came back. */
  status?: number;
  /** Why the check got its class, such as "HTTP 404", "timeout" or "localhost". */
  reason: string;
  checkedAt: number;
  /** The first dead result's status, kept while the retry is pending. */
  firstDeadStatus?: number;
  /** When the first dead result came back, kept while the retry is pending. */
  firstDeadAt?: number;
  /** The earliest time the GET retry may run, kept while the retry is pending. */
  retryDue?: number;
}

/** A stored check with the bookmark title, for the results list. */
export interface LinkCheckListRow extends LinkCheckRow {
  title: string;
}

/** A bookmark the checker must check: missing, stale, changed, or a pending retry. */
export interface LinkCheckTarget {
  id: number;
  link: string;
  /** Set when a first dead result waits for its retry. The checker then sends only the GET retry. */
  pending?: { firstDeadStatus?: number; firstDeadAt: number; retryDue: number };
}

/** Check state and the ignore list. A separate interface, so fake BookmarkStores stay as they are. */
export interface LinkCheckStore {
  /** Inserts or replaces the check of one bookmark. */
  saveLinkCheck(row: LinkCheckRow): Promise<void>;
  /** Every stored check whose URL is the bookmark's current link, outside Trash, by bookmark ID. */
  linkChecks(): Promise<LinkCheckListRow[]>;
  /**
   * The work for a run, by bookmark ID: bookmarks outside Trash with no check, a check of another
   * URL, a check older than `maxAgeMs` (default 30 days), or a pending retry (due or not).
   */
  linkCheckWork(now: number, maxAgeMs?: number): Promise<LinkCheckTarget[]>;
  /** Deletes checks whose URL differs from the stored bookmark's link. Checks of missing bookmarks stay. Resolves to the count deleted. */
  invalidateLinkChecks(): Promise<number>;
  /** The ignored hosts, normalized, sorted. */
  ignoredHosts(): Promise<string[]>;
  /** Adds one exact host to the ignore list (normalized). */
  addIgnoredHost(host: string): Promise<void>;
  /** Removes one host, and deletes the `ignored host` skipped checks so the next run checks them again. */
  removeIgnoredHost(host: string): Promise<void>;
}

/** A bookmark and the collection it goes back to. */
export interface CollectionMove {
  id: number;
  collectionId: number;
}

export interface CollectionRow {
  id: number;
  title: string;
  parentId?: number;
  sort: number;
  count: number;
  /** The `user.groups` title the collection sits in, for a root collection. */
  group?: string;
  /** The position of the collection in its group's list, or of the group, for ordering. */
  groupOrder?: number;
}

export interface TagRow {
  name: string;
  count: number;
}

/** A search. src/search/ builds it from the search bar text; src/store/sql.ts compiles it. */
export interface SearchQuery {
  /** Free-text words; each one matches as an FTS5 prefix term. */
  words: string[];
  /** Exact FTS5 phrases. */
  phrases?: string[];
  /** Words or phrases the text must not hold (exact terms, not prefixes). */
  excludes?: string[];
  /** Every tag must be on the bookmark (case-insensitive). */
  tags?: string[];
  /** No tag here may be on the bookmark. */
  excludeTags?: string[];
  /** Any of these types. */
  types?: RaindropType[];
  /** Each set is one `in:`: the bookmark is in one of its IDs. Sets combine with AND. */
  collectionSets?: number[][];
  /** The dropdown collection. */
  collectionId?: number;
  favorite?: boolean;
  limit?: number;
}

export interface UpsertOptions {
  /** Mark the page's IDs as seen by the full resync in progress. */
  seen?: boolean;
  /** `sync_state` entries to write in the same transaction, such as the resume point. */
  syncState?: Record<string, string>;
}

export interface BookmarkStore {
  /** Opens the database: the feature check, WAL, the schema and its version. Safe to call twice. */
  open(): Promise<void>;
  /**
   * Search with operators, ranked by bm25, then by open count. With no text term, the
   * most-opened rows, then the newest. At most 50 rows.
   */
  search(query: SearchQuery): Promise<BookmarkRow[]>;
  /** The most-opened bookmarks, then the newest. */
  topOpened(limit?: number): Promise<BookmarkRow[]>;
  getBookmark(id: number): Promise<BookmarkRow | undefined>;
  /**
   * Writes a row's own fields (link, title, domain, collection, tags, note, favorite) and its FTS
   * row, before the server answers a write or after a write fails. Highlights stay as they are.
   * A row that is not in the store stays out.
   */
  saveRow(row: BookmarkRow): Promise<void>;
  /** The bookmarks whose domain or link holds `host` (lowercase), not in Trash, for the duplicate check. */
  findByHost(host: string): Promise<BookmarkRow[]>;
  /** Every bookmark outside Trash, by ID, for duplicate detection. */
  cleanupRows(): Promise<CleanupRow[]>;
  /**
   * Inserts or updates one page of API bookmarks, with highlights and the FTS row, in one transaction.
   * The same transaction marks the IDs as seen by a full resync and writes `syncState`, when given.
   */
  upsertPage(items: Raindrop[], options?: UpsertOptions): Promise<void>;
  /** Moves the stored rows of these IDs to Trash in one transaction, before a bulk trash call goes out. Missing IDs are skipped. */
  trashLocal(ids: number[]): Promise<void>;
  /** Puts each stored row back in its collection in one transaction. Missing IDs are skipped, so a sync that dropped them does no harm. */
  restoreLocal(moves: CollectionMove[]): Promise<void>;
  /** Deletes bookmarks, their highlights, FTS rows and `opens` rows. Resolves to the count of bookmarks it removed. */
  deleteIds(ids: number[]): Promise<number>;
  /** Forgets the IDs a full resync has seen. A full resync calls it once at its start. */
  clearSeen(): Promise<void>;
  /**
   * Ends a full resync: deletes every bookmark it has not seen (with highlights, FTS and `opens` rows),
   * deletes `opens` rows with no bookmark, and forgets the seen IDs. Resolves to the count of bookmarks removed.
   */
  deleteUnseen(): Promise<number>;
  /** The IDs of stored bookmarks a full resync has not seen yet. */
  unseenIds(): Promise<number[]>;
  count(): Promise<number>;
  collections(): Promise<CollectionRow[]>;
  replaceCollections(collections: CollectionRow[]): Promise<void>;
  tags(): Promise<TagRow[]>;
  replaceTags(tags: TagRow[]): Promise<void>;
  recordOpen(id: number, at?: number): Promise<void>;
  getSyncState(key: string): Promise<string | undefined>;
  setSyncState(entries: Record<string, string>): Promise<void>;
  /** The times in ms of the last 50 searches, oldest first. */
  queryTimes(): number[];
}

/** The store cannot work on this machine: the sqlite3 binary is missing or lacks a feature. */
export class StoreFeatureError extends Error {
  readonly feature: string;

  constructor(feature: string, detail: string) {
    super(`sqlite3 lacks ${feature}: ${detail}`);
    this.name = "StoreFeatureError";
    this.feature = feature;
  }
}

/** A sqlite3 process failed. */
export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

/** Maps API collections to store rows. */
export function collectionRow(c: Collection): CollectionRow {
  return { id: c._id, title: c.title, parentId: c.parent?.$id, sort: c.sort ?? 0, count: c.count ?? 0 };
}

export function tagRow(t: Tag): TagRow {
  return { name: t._id, count: t.count };
}
