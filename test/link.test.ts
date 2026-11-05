import { describe, expect, it } from "vitest";
import { findDuplicate, isHttpUrl, normalizeLink } from "../src/parse/link";
import { mergeTags } from "../src/parse/tags";
import type { BookmarkRow, CollectionRow } from "../src/store/types";

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

describe("form tags", () => {
  it("merges new tags without case-insensitive duplicates", () => {
    expect(mergeTags(["read"], " later, #Read ,x")).toEqual(["read", "later", "x"]);
  });
});
