// The only place that builds a SQL literal. The sqlite3 CLI has no bind
// parameters, so every value goes into the SQL text through these functions.
//
// sqlString() doubles every `'`. It also turns a line break into `char(10)` and
// a carriage return into `char(13)`, so a literal never spans two lines of a
// CLI script, and it drops NUL, which a command line cannot carry.
// ftsTerm() wraps one FTS5 term in double quotes with every `"` doubled, so
// FTS5 reads it as a plain string and never as syntax (AND, NEAR, *, ^, :).
import { FTS_WEIGHTS } from "./schema";
import type { SearchQuery } from "./types";

/** A SQL string literal (an expression when the value holds a line break). */
export function sqlString(value: string): string {
  const parts = value.replace(/\u0000/g, "").split(/(\r|\n)/);
  const out: string[] = [];
  for (const part of parts) {
    if (part === "\n") out.push("char(10)");
    else if (part === "\r") out.push("char(13)");
    else if (part !== "" || parts.length === 1) out.push(`'${part.replace(/'/g, "''")}'`);
  }
  return out.join(" || ");
}

/** A SQL integer literal. Throws on anything that is not a safe integer. */
export function sqlInt(value: number): string {
  if (!Number.isSafeInteger(value)) throw new TypeError(`Not a safe integer for SQL: ${value}`);
  return String(value);
}

/** A SQL real literal. Throws on NaN and Infinity. */
export function sqlReal(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError(`Not a finite number for SQL: ${value}`);
  return String(value);
}

/** 1 or 0. */
export function sqlBool(value: boolean | undefined): string {
  return value ? "1" : "0";
}

/** A string literal, or NULL for undefined and null. */
export function sqlNullable(value: string | null | undefined): string {
  return value === undefined || value === null ? "NULL" : sqlString(value);
}

/** A comma list of integer literals for `IN (…)`. */
export function sqlIntList(values: number[]): string {
  return values.map(sqlInt).join(", ");
}

/** One FTS5 string term: the text in double quotes, with `"` doubled. Control characters become spaces. */
export function ftsTerm(term: string): string {
  const clean = term.replace(/[\u0000-\u001f\u007f]/g, " ");
  return `"${clean.replace(/"/g, '""')}"`;
}

/** An FTS5 query that needs every word as a prefix: `"foo"* "bar"*`. Empty words drop out. */
export function ftsPrefixQuery(words: string[]): string {
  return words
    .map((w) => w.trim())
    .filter((w) => w !== "")
    .map((w) => `${ftsTerm(w)}*`)
    .join(" ");
}

// ─── Search ─────────────────────────────────────────────────────────

/** The bookmark columns every read selects (alias `b` for bookmarks, `o` for opens). */
export const BOOKMARK_COLUMNS = `b.id, b.link, b.title, b.domain, b.type, b.collection_id, b.tags, b.note, b.excerpt, b.cover,
  b.important, b.created, b.last_update, coalesce(o.count, 0) AS open_count, o.last_opened,
  (SELECT json_group_array(json_object('text', h.text, 'note', h.note)) FROM highlights h WHERE h.bookmark_id = b.id) AS highlights`;

export const SEARCH_LIMIT = 50;

/** The order with no text term: most opened, last opened, newest. */
const OPENED_ORDER = "open_count DESC, o.last_opened DESC, b.created DESC";

const clean = (values: string[] | undefined) => (values ?? []).map((v) => v.trim()).filter((v) => v !== "");

/** The FTS5 MATCH text for the positive terms: words as prefixes, phrases exact, all with AND. */
export function ftsMatch(query: Pick<SearchQuery, "words" | "phrases">): string {
  const words = ftsPrefixQuery(query.words);
  const phrases = clean(query.phrases).map(ftsTerm);
  return [words, ...phrases].filter(Boolean).join(" ");
}

function tagExists(tag: string): string {
  return `EXISTS (SELECT 1 FROM json_each(b.tags) t WHERE lower(t.value) = lower(${sqlString(tag)}))`;
}

/**
 * The SELECT for one search. With a text term it ranks by bm25 rounded to 0.1 (so near ties
 * go to the open count), then by open count, then by raw bm25, then the newest. The raw bm25
 * key keeps the LIMIT sorter from computing the full row of every tied match (measured: 37 ms
 * against 57 ms on 10,000 rows for a two-letter prefix). With no text term it lists the
 * most-opened rows, then the newest. Every value goes through sqlString(), sqlInt() or ftsTerm().
 */
export function compileSearch(query: SearchQuery): string {
  const match = ftsMatch(query);
  const where: string[] = [];
  if (match) where.push(`bookmarks_fts MATCH ${sqlString(match)}`);
  const excludes = clean(query.excludes);
  if (excludes.length > 0) {
    const not = excludes.map(ftsTerm).join(" OR ");
    where.push(`b.id NOT IN (SELECT rowid FROM bookmarks_fts WHERE bookmarks_fts MATCH ${sqlString(not)})`);
  }
  for (const tag of clean(query.tags)) where.push(tagExists(tag));
  for (const tag of clean(query.excludeTags)) where.push(`NOT ${tagExists(tag)}`);
  const types = query.types ?? [];
  if (types.length > 0) where.push(`b.type IN (${types.map((t) => sqlString(t)).join(", ")})`);
  for (const set of query.collectionSets ?? []) {
    where.push(set.length > 0 ? `b.collection_id IN (${sqlIntList(set)})` : "0");
  }
  if (query.collectionId !== undefined) where.push(`b.collection_id = ${sqlInt(query.collectionId)}`);
  if (query.favorite) where.push("b.important = 1");

  const limit = sqlInt(Math.max(1, Math.min(query.limit ?? SEARCH_LIMIT, SEARCH_LIMIT)));
  const from = match
    ? "bookmarks_fts JOIN bookmarks b ON b.id = bookmarks_fts.rowid LEFT JOIN opens o ON o.bookmark_id = b.id"
    : "bookmarks b LEFT JOIN opens o ON o.bookmark_id = b.id";
  const bm25 = `bm25(bookmarks_fts, ${FTS_WEIGHTS.map((w) => sqlReal(w)).join(", ")})`;
  const order = match ? `round(${bm25}, 1), open_count DESC, ${bm25}, b.created DESC` : OPENED_ORDER;
  return `SELECT ${BOOKMARK_COLUMNS}
FROM ${from}
${where.length > 0 ? `WHERE ${where.join("\n  AND ")}\n` : ""}ORDER BY ${order}
LIMIT ${limit};`;
}
