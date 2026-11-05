// Search on the real sqlite3 CLI, with no client. Skips with a printed reason when the binary is absent.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Raindrop } from "../src/api/types";
import { buildQuery } from "../src/search/collections";
import { parseSearch } from "../src/search/parse";
import { defaultBinary, SqliteStore } from "../src/store/sqlite";
import type { CollectionRow } from "../src/store/types";

const binary = defaultBinary();
const hasBinary = existsSync(binary);
if (!hasBinary) console.log(`Skipping the search store tests: no sqlite3 binary at ${binary} (set TINYDROP_SQLITE3).`);

const COLLECTIONS: CollectionRow[] = [
  { id: 11, title: "Dev", sort: 0, count: 2, group: "My", groupOrder: 0 },
  { id: 12, title: "Rust", parentId: 11, sort: 0, count: 1 },
];

function bookmark(id: number, over: Partial<Raindrop> = {}): Raindrop {
  return {
    _id: id,
    link: `https://example.com/${id}`,
    title: `Bookmark ${id}`,
    domain: "example.com",
    type: "link",
    tags: [],
    collection: { $id: -1 },
    created: `2026-01-${String((id % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    lastUpdate: "2026-11-01T00:00:00.000Z",
    ...over,
  };
}

const LIBRARY: Raindrop[] = [
  bookmark(1, {
    title: "Rust ownership explained",
    type: "article",
    tags: ["rust", "Long Read"],
    collection: { $id: 12 },
    important: true,
    highlights: [{ _id: "h1", text: "the borrow checker says no", note: "zebracorn" }],
  }),
  bookmark(2, { title: "Cooking pasta", tags: ["food"], excerpt: "Boil water, add salt" }),
  bookmark(3, { title: "Rust in video", type: "video", tags: ["rust", "old"], collection: { $id: 11 } }),
  bookmark(4, { title: "Java spring guide", tags: ["java"], collection: { $id: 11 }, note: "rust free zone" }),
];

describe.skipIf(!hasBinary)("search on the real sqlite3", () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tinydrop-search-"));
    store = new SqliteStore({ path: join(dir, "tinydrop.sqlite"), binary });
    await store.upsertPage(LIBRARY);
    await store.replaceCollections(COLLECTIONS);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const ids = async (text: string, dropdown?: string) => {
    const built = buildQuery(parseSearch(text), COLLECTIONS, dropdown);
    if (!built.ok) throw new Error(built.error);
    return (await store.search(built.query)).map((r) => r.id).sort((a, b) => a - b);
  };

  it("finds a bookmark by a word that occurs only in its highlight", async () => {
    expect(await ids("zebrac")).toEqual([1]);
    expect(await ids("checker")).toEqual([1]);
  });

  it("each operator filters on the store", async () => {
    expect(await ids("#rust")).toEqual([1, 3]);
    expect(await ids('#"long read"')).toEqual([1]);
    expect(await ids("type:video")).toEqual([3]);
    expect(await ids("in:rust")).toEqual([1]);
    expect(await ids("in:dev")).toEqual([3, 4]);
    expect(await ids("is:fav")).toEqual([1]);
    expect(await ids("rust -video")).toEqual([1, 4]);
    expect(await ids("-#rust")).toEqual([2, 4]);
    expect(await ids('"borrow checker"')).toEqual([1]);
    expect(await ids('"checker borrow"')).toEqual([]);
  });

  it("combines operators with AND", async () => {
    expect(await ids("rust #rust -#old type:article is:fav in:Rust")).toEqual([1]);
    expect(await ids("rust in:dev -java")).toEqual([3]);
  });

  it("the dropdown and in: combine with AND", async () => {
    expect(await ids("rust", "11")).toEqual([3, 4]);
    expect(await ids("in:Rust", "12")).toEqual([1]);
    expect(await ids("in:Rust", "11")).toEqual([]);
    expect(await ids("", "-1")).toEqual([2]);
  });

  it("a bookmark opened three times ranks above one opened once for the same query", async () => {
    // Two rows with the same text, so bm25 ties; the older one gets the three opens.
    await store.upsertPage([
      bookmark(20, { title: "Kotlin coroutines", created: "2026-01-01T00:00:00.000Z" }),
      bookmark(21, { title: "Kotlin coroutines", created: "2026-02-01T00:00:00.000Z" }),
    ]);
    await store.recordOpen(21, 1000);
    for (const at of [1000, 2000, 3000]) await store.recordOpen(20, at);
    const rows = await store.search({ words: ["kotlin"] });
    expect(rows.map((r) => r.id)).toEqual([20, 21]);
    expect(rows.map((r) => r.openCount)).toEqual([3, 1]);
  });

  it("an empty query lists the most-opened bookmarks, then the newest", async () => {
    await store.recordOpen(2);
    await store.recordOpen(2);
    await store.recordOpen(3);
    const rows = await store.search({ words: [] });
    expect(rows.map((r) => r.id)).toEqual([2, 3, 4, 1]);
    expect((await store.topOpened()).map((r) => r.id)).toEqual([2, 3, 4, 1]);
  });

  it("hostile input through the parser never breaks the SQL or the database", async () => {
    const hostile = [
      "'); DROP TABLE bookmarks; --",
      `#"x'); DROP TABLE bookmarks; --"`,
      "in:\"Dev'; DELETE FROM opens; --\"",
      `-"'); DROP TABLE tags; --" -#'`,
      'type:video" OR 1=1 --',
      "\"unterminated ' phrase",
      "NEAR(a b) AND OR NOT * ^ : ( ) \"\"",
      "a\nb\r\nc ; .tables",
      "\\\" \\\\ \"\\\"",
      "-",
      "#",
      "in:",
    ];
    for (const text of hostile) {
      const built = buildQuery(parseSearch(text), COLLECTIONS);
      if (!built.ok) continue; // an unknown in: name never reaches SQL
      await expect(store.search(built.query), text).resolves.toBeInstanceOf(Array);
    }
    expect(await store.count()).toBe(LIBRARY.length);
    expect((await store.collections()).length).toBe(2);
    expect((await store.search({ words: [] })).length).toBe(LIBRARY.length);
  });

  it("a hostile tag that matches stored text finds the row as plain text", async () => {
    await store.upsertPage([bookmark(30, { title: "Odd", tags: ["x'); DROP TABLE bookmarks; --"] })]);
    expect(await ids(`#"x'); DROP TABLE bookmarks; --"`)).toEqual([30]);
  });
});
