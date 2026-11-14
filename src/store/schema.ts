// The database schema. The server-mirror tables hold what Raindrop holds, so a
// SCHEMA_VERSION change drops them and the next sync fills them again. `opens`
// lives only on this Mac: it has its own OPENS_VERSION and survives a schema
// version change. `link_checks` and `ignored_hosts` (dead-link check state and
// the ignore list) also live only here, share CHECKS_VERSION, and survive too.

/** Bump when a server-mirror table changes. */
export const SCHEMA_VERSION = 1;
/** Bump when the `opens` table changes; that needs a migration, not a drop. */
export const OPENS_VERSION = 1;
/** Bump when `link_checks` or `ignored_hosts` changes; that needs a migration, not a drop. */
export const CHECKS_VERSION = 1;

/** Tables that mirror the server, dropped on a schema version change. */
export const MIRROR_TABLES = ["bookmarks", "bookmarks_fts", "highlights", "collections", "tags", "sync_seen"] as const;

/** Columns of `bookmarks_fts`, in order. bm25 weights follow the same order. */
export const FTS_COLUMNS = ["title", "domain", "link", "tags", "note", "excerpt", "highlights"] as const;
export const FTS_WEIGHTS = [10, 4, 2, 6, 3, 1, 1] as const;

/** Tables that survive a schema version change. */
export const LOCAL_DDL = `
CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS opens (
  bookmark_id INTEGER PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  last_opened INTEGER NOT NULL DEFAULT 0
);
-- The latest dead-link check of each bookmark. A row whose url differs from the
-- bookmark's link is stale. first_dead_* and retry_due are set only while the
-- class is 'pending' (a first dead result that waits for its GET retry).
CREATE TABLE IF NOT EXISTS link_checks (
  bookmark_id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  class TEXT NOT NULL,
  status INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  checked_at INTEGER NOT NULL,
  first_dead_status INTEGER,
  first_dead_at INTEGER,
  retry_due INTEGER
);
CREATE TABLE IF NOT EXISTS ignored_hosts (
  host TEXT PRIMARY KEY
);
`;

export const MIRROR_DDL = `
CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY,
  link TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'link',
  collection_id INTEGER NOT NULL DEFAULT -1,
  tags TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  important INTEGER NOT NULL DEFAULT 0,
  broken INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL DEFAULT '',
  last_update TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS bookmarks_collection ON bookmarks(collection_id);
CREATE INDEX IF NOT EXISTS bookmarks_created ON bookmarks(created);
CREATE TABLE IF NOT EXISTS highlights (
  id TEXT PRIMARY KEY,
  bookmark_id INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS highlights_bookmark ON highlights(bookmark_id);
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  parent_id INTEGER,
  sort INTEGER NOT NULL DEFAULT 0,
  count INTEGER NOT NULL DEFAULT 0,
  grp TEXT,
  grp_order INTEGER
);
CREATE TABLE IF NOT EXISTS tags (
  name TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);
-- The IDs a full resync has seen so far. It survives a resumed run, so the
-- delete of the IDs the server no longer has stays right after a restart.
CREATE TABLE IF NOT EXISTS sync_seen (
  id INTEGER PRIMARY KEY
);
CREATE VIRTUAL TABLE IF NOT EXISTS bookmarks_fts USING fts5(
  ${FTS_COLUMNS.join(", ")},
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);
`;
