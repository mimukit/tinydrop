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

/** A search. Phase 5 adds the operators; this phase knows free-text prefix words and a collection. */
export interface SearchQuery {
  /** Free-text words; each one matches as an FTS5 prefix term. */
  words: string[];
  collectionId?: number;
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
  /** Free-text search, ranked by bm25, then by open count. At most 50 rows. */
  search(query: SearchQuery): Promise<BookmarkRow[]>;
  /** The most-opened bookmarks, then the newest. */
  topOpened(limit?: number): Promise<BookmarkRow[]>;
  getBookmark(id: number): Promise<BookmarkRow | undefined>;
  /**
   * Inserts or updates one page of API bookmarks, with highlights and the FTS row, in one transaction.
   * The same transaction marks the IDs as seen by a full resync and writes `syncState`, when given.
   */
  upsertPage(items: Raindrop[], options?: UpsertOptions): Promise<void>;
  /** Deletes bookmarks, their highlights, FTS rows and `opens` rows. Resolves to the count of bookmarks it removed. */
  deleteIds(ids: number[]): Promise<number>;
  /** Forgets the IDs a full resync has seen. A full resync calls it once at its start. */
  clearSeen(): Promise<void>;
  /**
   * Ends a full resync: deletes every bookmark it has not seen (with highlights, FTS and `opens` rows),
   * deletes `opens` rows with no bookmark, and forgets the seen IDs. Resolves to the count of bookmarks removed.
   */
  deleteUnseen(): Promise<number>;
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
