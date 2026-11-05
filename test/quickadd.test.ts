// The Quick Add grammar (one test per row of the plan's table) and link normalization.
import { describe, expect, it } from "vitest";
import { findDuplicate, isHttpUrl, normalizeLink } from "../src/parse/link";
import {
  blockReason,
  collectionToken,
  draftToPatch,
  mergeTags,
  parseQuickAdd,
  resolveTarget,
  trailingCollection,
} from "../src/parse/quickadd";
import type { BookmarkRow, CollectionRow } from "../src/store/types";

const COLLECTIONS: CollectionRow[] = [
  { id: 11, title: "Dev", sort: 0, count: 0 },
  { id: 12, title: "Design", sort: 1, count: 0 },
  { id: 13, title: "Side projects", sort: 2, count: 0 },
  { id: 14, title: "Go", sort: 3, count: 0 },
  { id: 15, title: "Golang tools", sort: 4, count: 0 },
];

describe("Quick Add grammar", () => {
  it("URL: the first http or https token is the link; a later one and a non-http one stay in the title", () => {
    const d = parseQuickAdd("see ftp://x.org https://example.com/a http://other.org");
    expect(d.link).toBe("https://example.com/a");
    expect(d.linkSource).toBe("text");
    expect(d.title).toBe("see ftp://x.org http://other.org");
    expect(parseQuickAdd("HTTP://Example.com").link).toBe("HTTP://Example.com");
  });

  it("URL: with none in the text, the clipboard URL; with neither, the save is blocked", () => {
    const fromClip = parseQuickAdd("#read", { clipboard: " https://clip.example/x \n" });
    expect(fromClip.link).toBe("https://clip.example/x");
    expect(fromClip.linkSource).toBe("clipboard");
    expect(parseQuickAdd("https://typed.example", { clipboard: "https://clip.example" }).link).toBe("https://typed.example");
    const none = parseQuickAdd("just words", { clipboard: "not a url" });
    expect(none.link).toBeUndefined();
    expect(blockReason(none, resolveTarget(none.collection, COLLECTIONS))).toMatch(/^No URL/);
  });

  it("Tag: #read and #\"long tag\" go to tags[], new tags allowed, repeats dropped", () => {
    const d = parseQuickAdd('https://e.com #read #"long tag" #brandnew #READ');
    expect(d.tags).toEqual(["read", "long tag", "brandnew"]);
    expect(d.title).toBe("");
    expect(draftToPatch(d, -1).tags).toEqual(["read", "long tag", "brandnew"]);
  });

  it("Collection: ~Dev and ~\"Side projects\" match the store, exact first, then a unique prefix", () => {
    expect(resolveTarget(parseQuickAdd("https://e.com ~Dev").collection, COLLECTIONS)).toEqual({ ok: true, id: 11, title: "Dev" });
    expect(parseQuickAdd('https://e.com ~"Side projects" x').collection).toBe("Side projects");
    expect(resolveTarget("Side projects", COLLECTIONS)).toMatchObject({ ok: true, id: 13 });
    expect(resolveTarget("side", COLLECTIONS)).toMatchObject({ ok: true, id: 13 });
    expect(resolveTarget("go", COLLECTIONS)).toMatchObject({ ok: true, id: 14 });
    expect(resolveTarget("gol", COLLECTIONS)).toMatchObject({ ok: true, id: 15 });
  });

  it("Collection: no match or two matches block the save", () => {
    const unknown = resolveTarget("Nope", COLLECTIONS);
    expect(unknown).toEqual({ ok: false, error: 'No collection named "Nope"' });
    const two = resolveTarget("De", COLLECTIONS);
    expect(two).toEqual({ ok: false, error: '"De" matches 2 collections: Dev, Design' });
    const twins = resolveTarget("Dev", [...COLLECTIONS, { id: 99, title: "dev", sort: 9, count: 0 }]);
    expect(twins.ok).toBe(false);
    const d = parseQuickAdd("https://example.com ~Nope");
    expect(blockReason(d, resolveTarget(d.collection, COLLECTIONS))).toBe('No collection named "Nope"');
  });

  it("Favorite: !fav sets important: true; another !word stays in the title", () => {
    const d = parseQuickAdd("https://e.com !fav !soon");
    expect(d.favorite).toBe(true);
    expect(d.title).toBe("!soon");
    expect(draftToPatch(d, -1).important).toBe(true);
    expect(draftToPatch(parseQuickAdd("https://e.com"), -1).important).toBeUndefined();
  });

  it("Escape: \\#1 is a literal # in the title, and so are \\~ and \\!fav", () => {
    const d = parseQuickAdd("https://e.com Issue \\#1 \\~home \\!fav");
    expect(d.title).toBe("Issue #1 ~home !fav");
    expect(d.tags).toEqual([]);
    expect(d.collection).toBeUndefined();
    expect(d.favorite).toBe(false);
    expect(parseQuickAdd("\\https://e.com").link).toBeUndefined();
  });

  it("Rest: the other words are the title; with none, the body leaves title out and pleaseParse fills it", () => {
    const d = parseQuickAdd("a good https://e.com read");
    expect(d.title).toBe("a good read");
    expect(draftToPatch(d, -1)).toMatchObject({ title: "a good read", pleaseParse: {} });
    const empty = draftToPatch(parseQuickAdd("https://e.com #x"), -1);
    expect("title" in empty).toBe(false);
    expect(empty.pleaseParse).toEqual({});
  });

  it("No ~: the bookmark goes to Unsorted", () => {
    const d = parseQuickAdd("https://e.com");
    const target = resolveTarget(d.collection, COLLECTIONS);
    expect(target).toEqual({ ok: true, id: -1, title: "Unsorted" });
    expect(draftToPatch(d, target.ok ? target.id : 0).collection).toEqual({ $id: -1 });
  });

  it("the plan's example line", () => {
    const d = parseQuickAdd("https://example.com #read ~Dev !fav");
    const t = resolveTarget(d.collection, COLLECTIONS);
    expect(t.ok && draftToPatch(d, t.id)).toEqual({ link: "https://example.com", collection: { $id: 11 }, pleaseParse: {}, tags: ["read"], important: true });
  });

  it("autocomplete helpers: the trailing ~name and the token it inserts", () => {
    expect(trailingCollection("https://e.com ~De")).toEqual({ query: "de", start: 14 });
    expect(trailingCollection('x ~"Side p')).toEqual({ query: "side p", start: 2 });
    expect(trailingCollection("x ~Dev more")).toBeUndefined();
    expect(collectionToken("Dev")).toBe("~Dev");
    expect(collectionToken("Side projects")).toBe('~"Side projects"');
    expect(mergeTags(["read"], " later, #Read ,x")).toEqual(["read", "later", "x"]);
  });
});

describe("link normalization", () => {
  it("lowercases the host, drops a trailing / and utm_* parameters, keeps the rest", () => {
    expect(normalizeLink("https://EXAMPLE.com/")).toBe("https://example.com");
    expect(normalizeLink("https://Example.COM/Path/?utm_source=x&utm_medium=y&id=3")).toBe("https://example.com/Path?id=3");
    expect(normalizeLink("https://example.com/a/?UTM_campaign=z")).toBe("https://example.com/a");
    expect(normalizeLink("https://example.com/a#part")).toBe("https://example.com/a#part");
    expect(normalizeLink("https://example.com/a")).not.toBe(normalizeLink("http://example.com/a"));
    expect(isHttpUrl("example.com")).toBe(false);
  });

  it("findDuplicate finds a stored row by its normalized link and names its collection", async () => {
    const stored = { id: 5, link: "https://example.com/pasta?utm_source=feed", collectionId: 12 } as BookmarkRow;
    const store = { findByHost: async (host: string) => (host === "example.com" ? [stored] : []) };
    const cols: CollectionRow[] = [{ id: 11, title: "Dev", sort: 0, count: 0 }, { id: 12, title: "Rust", parentId: 11, sort: 0, count: 0 }];
    expect(await findDuplicate(store, "https://www.EXAMPLE.com/pasta/", cols)).toBeUndefined();
    expect((await findDuplicate(store, "https://EXAMPLE.com/pasta/", cols))?.collection).toBe("Dev > Rust");
    expect(await findDuplicate(store, "https://example.com/other", cols)).toBeUndefined();
  });
});
