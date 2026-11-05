// The SQLite store, through the sqlite3 CLI:
//   reads:  sqlite3 -readonly -json -cmd ".timeout 2000" <db> "<sql>"
//   writes: sqlite3 -bail -cmd ".timeout 2000" <db>, with one BEGIN … COMMIT script on stdin
// Every literal comes from src/store/sql.ts. No @raycast/api import here.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { Raindrop, RaindropType } from "../api/types";
import { LOCAL_DDL, MIRROR_DDL, MIRROR_TABLES, FTS_COLUMNS, OPENS_VERSION, SCHEMA_VERSION } from "./schema";
import { BOOKMARK_COLUMNS, compileSearch, SEARCH_LIMIT, sqlBool, sqlInt, sqlIntList, sqlNullable, sqlString } from "./sql";
import { runProcess, type Runner } from "./run";
import { TimeRing } from "./timing";
import {
  StoreError,
  StoreFeatureError,
  type BookmarkRow,
  type BookmarkStore,
  type CollectionRow,
  type SearchQuery,
  type TagRow,
  type UpsertOptions,
} from "./types";

export const DEFAULT_SQLITE3 = "/usr/bin/sqlite3";
export const DB_FILE = "tinydrop.sqlite";
const TIMEOUT = [".timeout 2000"];
/** Trash. A row deleted from a window stays in the store with this collection until a sync drops it, so undo keeps its opens and highlights. */
const TRASH_ID = -99;
const TYPES: RaindropType[] = ["link", "article", "image", "video", "document", "audio"];

export interface SqliteStoreOptions {
  /** The database file, normally `environment.supportPath/tinydrop.sqlite`. */
  path: string;
  /** The sqlite3 binary. Default: TINYDROP_SQLITE3, else /usr/bin/sqlite3. */
  binary?: string;
  runner?: Runner;
  now?: () => number;
}

/** The binary the store uses when no option names one. */
export function defaultBinary(): string {
  const env = typeof process !== "undefined" ? process.env?.TINYDROP_SQLITE3 : undefined;
  return env && env.trim() ? env.trim() : DEFAULT_SQLITE3;
}

/** Deletes the database file and its WAL and SHM files. */
export function deleteDatabase(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${path}${suffix}`, { force: true });
}

// The feature check runs once per binary per JS context (one launch).
const checked = new Map<string, Promise<void>>();

/** Checks that the binary runs, prints JSON with -json, and has FTS5. Throws StoreFeatureError. */
export function checkFeatures(binary: string, runner: Runner = runProcess): Promise<void> {
  let check = checked.get(binary);
  if (!check) {
    check = (async () => {
      const json = await runner(binary, ["-json", ":memory:", "SELECT 1 AS ok;"]);
      if (json.spawnError) throw new StoreFeatureError("a working binary", `${binary} did not start (${json.spawnError})`);
      if (json.status !== 0 || !json.stdout.includes('"ok":1')) {
        throw new StoreFeatureError("-json", (json.stderr || json.stdout).trim().slice(0, 200) || `exit ${json.status}`);
      }
      const fts = await runner(binary, ["-json", ":memory:", "CREATE VIRTUAL TABLE temp.f USING fts5(x); SELECT 1 AS ok;"]);
      if (fts.status !== 0 || !fts.stdout.includes('"ok":1')) {
        throw new StoreFeatureError("FTS5", (fts.stderr || fts.stdout).trim().slice(0, 200) || `exit ${fts.status}`);
      }
    })();
    check.catch(() => checked.delete(binary));
    checked.set(binary, check);
  }
  return check;
}

type Row = Record<string, unknown>;

function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toBookmark(r: Row): BookmarkRow {
  const type = String(r.type) as RaindropType;
  return {
    id: Number(r.id),
    link: String(r.link ?? ""),
    title: String(r.title ?? ""),
    domain: String(r.domain ?? ""),
    type: TYPES.includes(type) ? type : "link",
    collectionId: Number(r.collection_id ?? -1),
    tags: parseJsonArray<string>(r.tags),
    note: String(r.note ?? ""),
    excerpt: String(r.excerpt ?? ""),
    cover: String(r.cover ?? ""),
    important: Number(r.important) === 1,
    created: String(r.created ?? ""),
    lastUpdate: String(r.last_update ?? ""),
    highlights: parseJsonArray<{ text: string; note?: string }>(r.highlights).map((h) => ({
      text: h.text ?? "",
      ...(h.note ? { note: h.note } : {}),
    })),
    openCount: Number(r.open_count ?? 0),
    ...(r.last_opened !== null && r.last_opened !== undefined ? { lastOpened: Number(r.last_opened) } : {}),
  };
}

function domainOf(item: Raindrop): string {
  if (item.domain) return item.domain;
  try {
    return new URL(item.link).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function collectionOf(item: Raindrop): number {
  return item.collection?.$id ?? item.collectionId ?? -1;
}

/** The SQL that writes one API bookmark, its highlights and its FTS row. */
export function upsertBookmarkSql(item: Raindrop): string {
  const id = sqlInt(item._id);
  const tags = item.tags ?? [];
  const highlights = item.highlights ?? [];
  const lines = [
    `INSERT INTO bookmarks (id, link, title, domain, type, collection_id, tags, note, excerpt, cover, important, broken, created, last_update) VALUES (${[
      id,
      sqlString(item.link ?? ""),
      sqlString(item.title ?? ""),
      sqlString(domainOf(item)),
      sqlString(item.type ?? "link"),
      sqlInt(collectionOf(item)),
      sqlString(JSON.stringify(tags)),
      sqlString(item.note ?? ""),
      sqlString(item.excerpt ?? ""),
      sqlString(item.cover ?? ""),
      sqlBool(item.important),
      sqlBool(item.broken),
      sqlString(item.created ?? ""),
      sqlString(item.lastUpdate ?? ""),
    ].join(", ")}) ON CONFLICT(id) DO UPDATE SET link = excluded.link, title = excluded.title, domain = excluded.domain, type = excluded.type, collection_id = excluded.collection_id, tags = excluded.tags, note = excluded.note, excerpt = excluded.excerpt, cover = excluded.cover, important = excluded.important, broken = excluded.broken, created = excluded.created, last_update = excluded.last_update;`,
    `DELETE FROM highlights WHERE bookmark_id = ${id};`,
    ...highlights.map(
      (h) =>
        `INSERT INTO highlights (id, bookmark_id, text, note, color, created) VALUES (${[
          sqlString(String(h._id)),
          id,
          sqlString(h.text ?? ""),
          sqlString(h.note ?? ""),
          sqlString(h.color ?? ""),
          sqlString(h.created ?? ""),
        ].join(", ")}) ON CONFLICT(id) DO UPDATE SET bookmark_id = excluded.bookmark_id, text = excluded.text, note = excluded.note, color = excluded.color, created = excluded.created;`,
    ),
    `DELETE FROM bookmarks_fts WHERE rowid = ${id};`,
    `INSERT INTO bookmarks_fts (rowid, ${FTS_COLUMNS.join(", ")}) VALUES (${[
      id,
      sqlString(item.title ?? ""),
      sqlString(domainOf(item)),
      sqlString(item.link ?? ""),
      sqlString(tags.join(" ")),
      sqlString(item.note ?? ""),
      sqlString(item.excerpt ?? ""),
      sqlString(highlights.flatMap((h) => [h.text ?? "", h.note ?? ""]).filter(Boolean).join("\n")),
    ].join(", ")});`,
  ];
  return lines.join("\n");
}

export class SqliteStore implements BookmarkStore {
  readonly path: string;
  readonly binary: string;
  private readonly runner: Runner;
  private readonly now: () => number;
  private readonly ring = new TimeRing(50);
  private opening: Promise<void> | undefined;

  constructor(options: SqliteStoreOptions) {
    this.path = options.path;
    this.binary = options.binary ?? defaultBinary();
    this.runner = options.runner ?? runProcess;
    this.now = options.now ?? Date.now;
  }

  open(): Promise<void> {
    if (!this.opening) {
      this.opening = this.doOpen();
      this.opening.catch(() => {
        this.opening = undefined;
      });
    }
    return this.opening;
  }

  private async doOpen(): Promise<void> {
    await checkFeatures(this.binary, this.runner);
    mkdirSync(dirname(this.path), { recursive: true });
    await this.exec(`PRAGMA journal_mode = WAL;\n${LOCAL_DDL}`, false);
    const versions = await this.readRaw(
      `SELECT key, value FROM sync_state WHERE key IN (${sqlString("schema_version")}, ${sqlString("opens_version")});`,
    );
    const stored = Object.fromEntries(versions.map((r) => [String(r.key), String(r.value)]));
    const script: string[] = [];
    if (stored.schema_version !== undefined && stored.schema_version !== String(SCHEMA_VERSION)) {
      // The server holds the truth for these, so a drop is safe; the next sync is a full one.
      for (const table of MIRROR_TABLES) script.push(`DROP TABLE IF EXISTS ${table};`);
      script.push(`DELETE FROM sync_state WHERE key <> ${sqlString("opens_version")};`);
    }
    script.push(MIRROR_DDL);
    script.push(this.syncStateSql({ schema_version: String(SCHEMA_VERSION) }));
    if (stored.opens_version === undefined) script.push(this.syncStateSql({ opens_version: String(OPENS_VERSION) }));
    await this.exec(script.join("\n"));
  }

  /** Runs one write script in a transaction. */
  private async exec(sql: string, transaction = true): Promise<void> {
    const script = transaction ? `BEGIN;\n${sql}\nCOMMIT;\n` : `${sql}\n`;
    const r = await this.runner(this.binary, ["-bail", "-cmd", ...TIMEOUT, this.path], script);
    if (r.spawnError) throw new StoreFeatureError("a working binary", `${this.binary} did not start (${r.spawnError})`);
    if (r.status !== 0) throw new StoreError(`sqlite3 write failed (${r.status}): ${r.stderr.trim().slice(0, 300)}`);
  }

  private async readRaw(sql: string): Promise<Row[]> {
    const r = await this.runner(this.binary, ["-readonly", "-json", "-cmd", ...TIMEOUT, this.path, sql]);
    if (r.spawnError) throw new StoreFeatureError("a working binary", `${this.binary} did not start (${r.spawnError})`);
    if (r.status !== 0) throw new StoreError(`sqlite3 read failed (${r.status}): ${r.stderr.trim().slice(0, 300)}`);
    const text = r.stdout.trim();
    if (!text) return [];
    return JSON.parse(text) as Row[];
  }

  private async read(sql: string): Promise<Row[]> {
    await this.open();
    return this.readRaw(sql);
  }

  private async write(sql: string): Promise<void> {
    await this.open();
    await this.exec(sql);
  }

  private syncStateSql(entries: Record<string, string>): string {
    return Object.entries(entries)
      .map(
        ([k, v]) =>
          `INSERT INTO sync_state (key, value) VALUES (${sqlString(k)}, ${sqlString(v)}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
      )
      .join("\n");
  }

  async search(query: SearchQuery): Promise<BookmarkRow[]> {
    const sql = compileSearch(query);
    await this.open();
    const start = this.now();
    const rows = await this.readRaw(sql);
    this.ring.push(this.now() - start);
    return rows.map(toBookmark);
  }

  async topOpened(limit = SEARCH_LIMIT): Promise<BookmarkRow[]> {
    const rows = await this.read(compileSearch({ words: [], limit }));
    return rows.map(toBookmark);
  }

  async getBookmark(id: number): Promise<BookmarkRow | undefined> {
    const rows = await this.read(`SELECT ${BOOKMARK_COLUMNS}
FROM bookmarks b LEFT JOIN opens o ON o.bookmark_id = b.id WHERE b.id = ${sqlInt(id)};`);
    return rows[0] ? toBookmark(rows[0]) : undefined;
  }

  async saveRow(row: BookmarkRow): Promise<void> {
    const id = sqlInt(row.id);
    const highlights = row.highlights.flatMap((h) => [h.text, h.note ?? ""]).filter(Boolean).join("\n");
    await this.write(
      [
        `UPDATE bookmarks SET ${[
          `link = ${sqlString(row.link)}`,
          `title = ${sqlString(row.title)}`,
          `domain = ${sqlString(row.domain)}`,
          `collection_id = ${sqlInt(row.collectionId)}`,
          `tags = ${sqlString(JSON.stringify(row.tags))}`,
          `note = ${sqlString(row.note)}`,
          `important = ${sqlBool(row.important)}`,
        ].join(", ")} WHERE id = ${id};`,
        `DELETE FROM bookmarks_fts WHERE rowid = ${id};`,
        `INSERT INTO bookmarks_fts (rowid, ${FTS_COLUMNS.join(", ")}) SELECT ${[
          id,
          sqlString(row.title),
          sqlString(row.domain),
          sqlString(row.link),
          sqlString(row.tags.join(" ")),
          sqlString(row.note),
          sqlString(row.excerpt),
          sqlString(highlights),
        ].join(", ")} WHERE EXISTS (SELECT 1 FROM bookmarks WHERE id = ${id});`,
      ].join("\n"),
    );
  }

  async findByHost(host: string): Promise<BookmarkRow[]> {
    const want = host.trim().toLowerCase();
    if (!want) return [];
    const rows = await this.read(`SELECT ${BOOKMARK_COLUMNS}
FROM bookmarks b LEFT JOIN opens o ON o.bookmark_id = b.id
WHERE b.collection_id <> ${sqlInt(TRASH_ID)} AND (lower(b.domain) = ${sqlString(want)} OR instr(lower(b.link), ${sqlString(want)}) > 0)
LIMIT 500;`);
    return rows.map(toBookmark);
  }

  async upsertPage(items: Raindrop[], options: UpsertOptions = {}): Promise<void> {
    const script = items.map(upsertBookmarkSql);
    if (options.seen && items.length > 0) {
      script.push(`INSERT OR IGNORE INTO sync_seen (id) VALUES ${items.map((i) => `(${sqlInt(i._id)})`).join(", ")};`);
    }
    if (options.syncState && Object.keys(options.syncState).length > 0) script.push(this.syncStateSql(options.syncState));
    if (script.length === 0) return;
    await this.write(script.join("\n"));
  }

  async deleteIds(ids: number[]): Promise<number> {
    if (ids.length === 0) return 0;
    const list = sqlIntList(ids);
    const found = await this.read(`SELECT count(*) AS n FROM bookmarks WHERE id IN (${list});`);
    await this.write(
      [
        `DELETE FROM bookmarks WHERE id IN (${list});`,
        `DELETE FROM highlights WHERE bookmark_id IN (${list});`,
        `DELETE FROM bookmarks_fts WHERE rowid IN (${list});`,
        `DELETE FROM opens WHERE bookmark_id IN (${list});`,
      ].join("\n"),
    );
    return Number(found[0]?.n ?? 0);
  }

  async clearSeen(): Promise<void> {
    await this.write("DELETE FROM sync_seen;");
  }

  async deleteUnseen(): Promise<number> {
    const unseen = "SELECT id FROM bookmarks WHERE id NOT IN (SELECT id FROM sync_seen)";
    const found = await this.read(`SELECT count(*) AS n FROM (${unseen});`);
    await this.write(
      [
        `DELETE FROM highlights WHERE bookmark_id IN (${unseen});`,
        `DELETE FROM bookmarks_fts WHERE rowid IN (${unseen});`,
        `DELETE FROM bookmarks WHERE id NOT IN (SELECT id FROM sync_seen);`,
        "DELETE FROM opens WHERE bookmark_id NOT IN (SELECT id FROM bookmarks);",
        "DELETE FROM sync_seen;",
      ].join("\n"),
    );
    return Number(found[0]?.n ?? 0);
  }

  async count(): Promise<number> {
    const rows = await this.read("SELECT count(*) AS n FROM bookmarks;");
    return Number(rows[0]?.n ?? 0);
  }

  async collections(): Promise<CollectionRow[]> {
    const rows = await this.read(
      "SELECT id, title, parent_id, sort, count, grp, grp_order FROM collections ORDER BY grp_order, sort, title;",
    );
    return rows.map((r) => ({
      id: Number(r.id),
      title: String(r.title),
      ...(r.parent_id !== null && r.parent_id !== undefined ? { parentId: Number(r.parent_id) } : {}),
      sort: Number(r.sort ?? 0),
      count: Number(r.count ?? 0),
      ...(r.grp !== null && r.grp !== undefined ? { group: String(r.grp) } : {}),
      ...(r.grp_order !== null && r.grp_order !== undefined ? { groupOrder: Number(r.grp_order) } : {}),
    }));
  }

  async replaceCollections(collections: CollectionRow[]): Promise<void> {
    await this.write(
      [
        "DELETE FROM collections;",
        ...collections.map(
          (c) =>
            `INSERT INTO collections (id, title, parent_id, sort, count, grp, grp_order) VALUES (${[
              sqlInt(c.id),
              sqlString(c.title),
              c.parentId === undefined ? "NULL" : sqlInt(c.parentId),
              sqlInt(c.sort),
              sqlInt(c.count),
              sqlNullable(c.group),
              c.groupOrder === undefined ? "NULL" : sqlInt(c.groupOrder),
            ].join(", ")}) ON CONFLICT(id) DO UPDATE SET title = excluded.title, parent_id = excluded.parent_id, sort = excluded.sort, count = excluded.count, grp = excluded.grp, grp_order = excluded.grp_order;`,
        ),
      ].join("\n"),
    );
  }

  async tags(): Promise<TagRow[]> {
    const rows = await this.read("SELECT name, count FROM tags ORDER BY count DESC, name;");
    return rows.map((r) => ({ name: String(r.name), count: Number(r.count ?? 0) }));
  }

  async replaceTags(tags: TagRow[]): Promise<void> {
    await this.write(
      [
        "DELETE FROM tags;",
        ...tags.map(
          (t) =>
            `INSERT INTO tags (name, count) VALUES (${sqlString(t.name)}, ${sqlInt(t.count)}) ON CONFLICT(name) DO UPDATE SET count = excluded.count;`,
        ),
      ].join("\n"),
    );
  }

  async recordOpen(id: number, at: number = this.now()): Promise<void> {
    await this.write(
      `INSERT INTO opens (bookmark_id, count, last_opened) VALUES (${sqlInt(id)}, 1, ${sqlInt(Math.trunc(at))}) ON CONFLICT(bookmark_id) DO UPDATE SET count = count + 1, last_opened = excluded.last_opened;`,
    );
  }

  async getSyncState(key: string): Promise<string | undefined> {
    const rows = await this.read(`SELECT value FROM sync_state WHERE key = ${sqlString(key)};`);
    return rows[0] ? String(rows[0].value) : undefined;
  }

  async setSyncState(entries: Record<string, string>): Promise<void> {
    if (Object.keys(entries).length === 0) return;
    await this.write(this.syncStateSql(entries));
  }

  queryTimes(): number[] {
    return this.ring.values();
  }

  /** True when the database file exists. */
  exists(): boolean {
    return existsSync(this.path);
  }
}
