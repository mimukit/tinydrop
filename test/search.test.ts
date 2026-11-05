import { describe, expect, it } from "vitest";
import {
  ALL_VALUE,
  buildQuery,
  collectionChoices,
  collectionPath,
  dropdownCollection,
  resolveCollection,
} from "../src/search/collections";
import { detailMarkdown, markdownLink, syncAgo, tagText, webAppUrl } from "../src/search/format";
import { emptySearch, isEmptySearch, parseSearch } from "../src/search/parse";
import { compileSearch, ftsMatch } from "../src/store/sql";
import type { CollectionRow } from "../src/store/types";

const COLLECTIONS: CollectionRow[] = [
  { id: 11, title: "Dev", sort: 0, count: 2, group: "My", groupOrder: 1 },
  { id: 12, title: "Rust", parentId: 11, sort: 1, count: 1 },
  { id: 13, title: "Go", parentId: 11, sort: 0, count: 1 },
  { id: 17, title: "Golang tools", parentId: 11, sort: 2, count: 1 },
  { id: 14, title: "Reading list", sort: 0, count: 5, group: "My", groupOrder: 0 },
  { id: 15, title: "Bob's \"best\" links", sort: 0, count: 1, group: "Other", groupOrder: 10_000 },
  { id: 16, title: "Recipes", sort: 0, count: 1, group: "Other", groupOrder: 10_001 },
];

describe("parseSearch: each operator alone", () => {
  it("free text becomes prefix words", () => {
    expect(parseSearch("rust  own")).toEqual({ ...emptySearch(), words: ["rust", "own"] });
  });

  it("#tag and #\"long tag\"", () => {
    expect(parseSearch("#rust").tags).toEqual(["rust"]);
    expect(parseSearch('#"long read"').tags).toEqual(["long read"]);
    expect(parseSearch('#"long read"').words).toEqual([]);
  });

  it("type: with each known type, case-insensitive; an unknown type is free text", () => {
    for (const t of ["link", "article", "image", "video", "document", "audio"]) {
      expect(parseSearch(`type:${t}`).types).toEqual([t]);
    }
    expect(parseSearch("TYPE:Video").types).toEqual(["video"]);
    expect(parseSearch("type:foo")).toEqual({ ...emptySearch(), words: ["type:foo"] });
  });

  it("in: with a plain and a quoted name", () => {
    expect(parseSearch("in:Dev").collections).toEqual(["Dev"]);
    expect(parseSearch('in:"Reading list"').collections).toEqual(["Reading list"]);
  });

  it("is:fav; another is: value is free text", () => {
    expect(parseSearch("is:fav").favorite).toBe(true);
    expect(parseSearch("is:favorite").favorite).toBe(true);
    expect(parseSearch("is:read")).toEqual({ ...emptySearch(), words: ["is:read"] });
  });

  it("-exclude for a word, a phrase and a tag", () => {
    expect(parseSearch("-java").excludes).toEqual(["java"]);
    expect(parseSearch('-"spring boot"').excludes).toEqual(["spring boot"]);
    expect(parseSearch("-#old").excludeTags).toEqual(["old"]);
    expect(parseSearch("-java").words).toEqual([]);
  });

  it("\"exact phrase\"", () => {
    expect(parseSearch('"borrow checker"')).toEqual({ ...emptySearch(), phrases: ["borrow checker"] });
  });

  it("a lone dash or hash is no term", () => {
    expect(isEmptySearch(parseSearch(" - # "))).toBe(true);
    expect(isEmptySearch(parseSearch(""))).toBe(true);
  });
});

describe("parseSearch: combined", () => {
  it("reads every operator in one line", () => {
    expect(parseSearch('rust "borrow checker" #read type:article in:"Reading list" is:fav -java -#old own')).toEqual({
      words: ["rust", "own"],
      phrases: ["borrow checker"],
      excludes: ["java"],
      tags: ["read"],
      excludeTags: ["old"],
      types: ["article"],
      collections: ["Reading list"],
      favorite: true,
    });
  });

  it("keeps two types as OR and drops a repeat", () => {
    expect(parseSearch("type:video type:audio type:video").types).toEqual(["video", "audio"]);
  });
});

describe("parseSearch: an operator value that carries a quote", () => {
  it("a single quote in a tag and a collection", () => {
    expect(parseSearch("#o'reilly").tags).toEqual(["o'reilly"]);
    expect(parseSearch("in:Bob's").collections).toEqual(["Bob's"]);
  });

  it("an escaped double quote inside a quoted value", () => {
    const p = parseSearch('in:"Bob\'s \\"best\\" links" #"say \\"hi\\""');
    expect(p.collections).toEqual(['Bob\'s "best" links']);
    expect(p.tags).toEqual(['say "hi"']);
  });

  it("a quote with no end runs to the end of the text", () => {
    expect(parseSearch('#"long tag').tags).toEqual(["long tag"]);
    expect(parseSearch('"open phrase').phrases).toEqual(["open phrase"]);
  });

  it("a quoted value reaches the SQL only through sqlString()", () => {
    const built = buildQuery(parseSearch('in:"Bob\'s \\"best\\" links" #o\'reilly'), COLLECTIONS);
    expect(built.ok && built.query.collectionSets).toEqual([[15]]);
    const sql = compileSearch(built.ok ? built.query : { words: [] });
    expect(sql).toContain("lower('o''reilly')");
    expect(sql).toContain("b.collection_id IN (15)");
  });
});

describe("resolveCollection", () => {
  it("matches the title exactly, case-insensitive, before a prefix", () => {
    expect(resolveCollection("dev", COLLECTIONS)).toEqual({ ok: true, ids: [11] });
    expect(resolveCollection("RUST", COLLECTIONS)).toEqual({ ok: true, ids: [12] });
    expect(resolveCollection("go", COLLECTIONS)).toEqual({ ok: true, ids: [13] });
  });

  it("then a unique prefix", () => {
    expect(resolveCollection("read", COLLECTIONS)).toEqual({ ok: true, ids: [14] });
  });

  it("an ambiguous prefix and an unknown name are errors", () => {
    const amb = resolveCollection("re", COLLECTIONS);
    expect(amb.ok).toBe(false);
    expect(!amb.ok && amb.error).toMatch(/matches 2 collections/);
    expect(resolveCollection("nope", COLLECTIONS)).toEqual({ ok: false, error: 'No collection named "nope"' });
  });

  it("Unsorted resolves to -1 when no collection has that title", () => {
    expect(resolveCollection("unsorted", COLLECTIONS)).toEqual({ ok: true, ids: [-1] });
    const later = [...COLLECTIONS, { id: 18, title: "Unsorted later", sort: 0, count: 0 }];
    expect(resolveCollection("Unsorted", later)).toEqual({ ok: true, ids: [-1] });
    expect(resolveCollection("unsorted l", later)).toEqual({ ok: true, ids: [18] });
  });
});

describe("buildQuery: the dropdown combined with in:", () => {
  it("adds the dropdown collection and the in: set, both required (AND)", () => {
    const built = buildQuery(parseSearch("in:Rust"), COLLECTIONS, "11");
    expect(built).toMatchObject({ ok: true, query: { collectionId: 11, collectionSets: [[12]] } });
    const sql = compileSearch(built.ok ? built.query : { words: [] });
    expect(sql).toMatch(/b\.collection_id IN \(12\)\s+AND b\.collection_id = 11/);
  });

  it("\"All\" adds no dropdown filter", () => {
    const built = buildQuery(parseSearch("in:Rust"), COLLECTIONS, ALL_VALUE);
    expect(built.ok && built.query.collectionId).toBeUndefined();
    expect(dropdownCollection("-1")).toBe(-1);
    expect(dropdownCollection("x")).toBeUndefined();
  });

  it("an unknown in: name gives the error, not a query", () => {
    expect(buildQuery(parseSearch("rust in:nope"), COLLECTIONS, "11")).toEqual({ ok: false, error: 'No collection named "nope"' });
  });
});

describe("compileSearch", () => {
  it("free text and phrases go into one MATCH, words as prefixes", () => {
    expect(ftsMatch({ words: ["rust", "own"], phrases: ["borrow checker"] })).toBe('"rust"* "own"* "borrow checker"');
  });

  it("ranks by bm25, then open count, with a match; by open count, then newest, without", () => {
    expect(compileSearch({ words: ["rust"] })).toMatch(/ORDER BY round\(bm25\(bookmarks_fts, [^)]*\), 1\), open_count DESC, bm25\(bookmarks_fts, [^)]*\), b\.created DESC/);
    const none = compileSearch({ words: [] });
    expect(none).not.toContain("MATCH");
    expect(none).toMatch(/ORDER BY open_count DESC, o\.last_opened DESC, b\.created DESC/);
  });

  it("caps the rows at 50", () => {
    expect(compileSearch({ words: ["a"] })).toMatch(/LIMIT 50;$/);
    expect(compileSearch({ words: ["a"], limit: 500 })).toMatch(/LIMIT 50;$/);
  });

  it("each filter adds its condition", () => {
    const sql = compileSearch({ words: [], types: ["video", "audio"], favorite: true, excludes: ["java"], excludeTags: ["old"] });
    expect(sql).toContain("b.type IN ('video', 'audio')");
    expect(sql).toContain("b.important = 1");
    expect(sql).toContain(`b.id NOT IN (SELECT rowid FROM bookmarks_fts WHERE bookmarks_fts MATCH '"java"')`);
    expect(sql).toContain("NOT EXISTS (SELECT 1 FROM json_each(b.tags) t WHERE lower(t.value) = lower('old'))");
  });

  it("hostile text stays inside the literals", () => {
    const sql = compileSearch(
      (buildQuery(parseSearch(`'); DROP TABLE bookmarks; -- #"x'); DROP TABLE tags; --" -"y'"`), COLLECTIONS) as { ok: true; query: never }).query,
    );
    // Every single quote in the SQL is part of a doubled pair or opens/closes a literal: strip literals, then look.
    const outside = sql.replace(/'(?:[^']|'')*'/g, "''");
    expect(outside).not.toMatch(/DROP|--|;\s*\S/);
  });
});

describe("collectionChoices and collectionPath", () => {
  it("\"All\" first, then Unsorted, then the tree in user.groups order with Parent > Child labels", () => {
    expect(collectionChoices(COLLECTIONS).map((c) => c.title)).toEqual([
      "All",
      "Unsorted",
      "Reading list",
      "Dev",
      "Dev > Go",
      "Dev > Rust",
      "Dev > Golang tools",
      'Bob\'s "best" links',
      "Recipes",
    ]);
    expect(collectionChoices(COLLECTIONS).slice(0, 2).map((c) => c.value)).toEqual(["all", "-1"]);
  });

  it("builds the path of a nested collection", () => {
    expect(collectionPath(12, COLLECTIONS)).toBe("Dev > Rust");
    expect(collectionPath(-1, COLLECTIONS)).toBe("Unsorted");
    expect(collectionPath(99, COLLECTIONS)).toBeUndefined();
  });
});

describe("format", () => {
  it("tags show two, then +N", () => {
    expect(tagText(["a", "b", "c", "d"])).toBe("#a #b +2");
    expect(tagText(["a"])).toBe("#a");
    expect(tagText([])).toBeUndefined();
  });

  it("a Markdown link escapes brackets in the title and parentheses in the URL", () => {
    expect(markdownLink("Rust [book]", "https://x.dev/a_(b)")).toBe("[Rust \\[book\\]](https://x.dev/a_%28b%29)");
    expect(markdownLink("", "https://x.dev")).toBe("[https://x.dev](https://x.dev)");
  });

  it("the web app URL names the collection and the item", () => {
    expect(webAppUrl({ id: 101, collectionId: 12 })).toBe("https://app.raindrop.io/my/12/item/101/web");
  });

  it("the details Markdown holds the excerpt, the note and each highlight with its note", () => {
    const md = detailMarkdown({
      title: "T",
      link: "https://x",
      excerpt: "An excerpt",
      note: "# not a heading",
      highlights: [{ text: "borrow checker", note: "zebra" }, { text: "plain" }],
    });
    expect(md).toContain("An excerpt");
    expect(md).toContain("\\# not a heading");
    expect(md).toContain("> borrow checker\n\nzebra");
    expect(md).toContain("> plain");
  });

  it("the sync time reads in minutes, hours, days", () => {
    const now = 10 * 86_400_000;
    expect(syncAgo(undefined, now)).toBe("Never synced");
    expect(syncAgo(now - 30_000, now)).toBe("Synced just now");
    expect(syncAgo(now - 5 * 60_000, now)).toBe("Synced 5 min ago");
    expect(syncAgo(now - 3 * 3_600_000, now)).toBe("Synced 3 h ago");
    expect(syncAgo(now - 2 * 86_400_000, now)).toBe("Synced 2 days ago");
  });
});
