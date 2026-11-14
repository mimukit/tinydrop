import { describe, expect, it } from "vitest";
import { duplicateText, findDuplicate, isHttpUrl, normalizeLink } from "../src/parse/link";
import { mergeTags } from "../src/parse/tags";
import type { BookmarkRow, CollectionRow } from "../src/store/types";

describe("link normalization", () => {
  it("lowercases the host, drops a trailing / and utm_* parameters, keeps the rest", () => {
    expect(normalizeLink("https://EXAMPLE.com/")).toBe("https://example.com");
    expect(normalizeLink("https://Example.COM/Path/?utm_source=x&utm_medium=y&id=3")).toBe("https://example.com/Path?id=3");
    expect(normalizeLink("https://example.com/a/?UTM_campaign=z")).toBe("https://example.com/a");
    expect(isHttpUrl("example.com")).toBe(false);
  });

  it("treats http and https, www. and bare host, and host case as one key", () => {
    const key = normalizeLink("https://example.com/a");
    expect(normalizeLink("http://example.com/a")).toBe(key);
    expect(normalizeLink("https://www.example.com/a")).toBe(key);
    expect(normalizeLink("HTTP://WWW.Example.COM/a")).toBe(key);
    expect(normalizeLink("http://example.com:80/a")).toBe(key);
    expect(normalizeLink("https://example.com:443/a")).toBe(key);
    // Only a leading `www.` goes; the path keeps its case.
    expect(normalizeLink("https://www2.example.com/a")).toBe("https://www2.example.com/a");
    expect(normalizeLink("https://sub.www.example.com/a")).toBe("https://sub.www.example.com/a");
    expect(normalizeLink("https://example.com/A")).not.toBe(key);
  });

  it("drops an ordinary fragment and keeps a #/ or #! hash route", () => {
    expect(normalizeLink("https://example.com/a#part")).toBe("https://example.com/a");
    expect(normalizeLink("https://example.com/a/#")).toBe("https://example.com/a");
    expect(normalizeLink("https://example.com/a?x=1#top")).toBe("https://example.com/a?x=1");
    expect(normalizeLink("https://example.com/#/inbox/3")).toBe("https://example.com#/inbox/3");
    expect(normalizeLink("https://example.com/app/#!/item/7")).toBe("https://example.com/app#!/item/7");
    expect(normalizeLink("https://example.com/#/a")).not.toBe(normalizeLink("https://example.com/#/b"));
  });

  it("strips every trailing path slash but never touches the query or a hash route", () => {
    expect(normalizeLink("https://example.com/a///")).toBe("https://example.com/a");
    expect(normalizeLink("https://example.com/a?next=/b/")).toBe("https://example.com/a?next=/b/");
    expect(normalizeLink("https://example.com/#/list/")).toBe("https://example.com#/list/");
  });

  it("drops the tracking parameters and keeps ref", () => {
    const key = normalizeLink("https://example.com/a?id=3");
    for (const p of ["utm_source=x", "UTM_Medium=y", "utm_=z", "fbclid=1", "gclid=2", "mc_cid=3", "mc_eid=4", "ref_src=twsrc", "FBCLID=5"]) {
      expect(normalizeLink(`https://example.com/a?id=3&${p}`)).toBe(key);
      expect(normalizeLink(`https://example.com/a?${p}&id=3`)).toBe(key);
    }
    expect(normalizeLink("https://example.com/a?ref=hn")).toBe("https://example.com/a?ref=hn");
    expect(normalizeLink("https://example.com/a?ref=hn")).not.toBe(normalizeLink("https://example.com/a"));
    // A name that only starts like a tracking parameter stays.
    expect(normalizeLink("https://example.com/a?gclid_x=1&fbclidx=2")).toBe("https://example.com/a?fbclidx=2&gclid_x=1");
  });

  it("sorts the kept parameters by name and keeps the order of repeated names", () => {
    expect(normalizeLink("https://example.com/a?b=2&a=1")).toBe(normalizeLink("https://example.com/a?a=1&b=2"));
    expect(normalizeLink("https://example.com/a?b=2&a=1")).toBe("https://example.com/a?a=1&b=2");
    expect(normalizeLink("https://example.com/a?t=2&id=9&t=1")).toBe("https://example.com/a?id=9&t=2&t=1");
    expect(normalizeLink("https://example.com/a?t=2&t=1")).not.toBe(normalizeLink("https://example.com/a?t=1&t=2"));
    expect(normalizeLink("https://example.com/a?flag&b=1")).toBe("https://example.com/a?b=1&flag");
    expect(normalizeLink("https://example.com/a?&&b=1&")).toBe("https://example.com/a?b=1");
  });

  it("keeps credentials and a non-default port as distinctions", () => {
    const key = normalizeLink("https://example.com/a");
    expect(normalizeLink("https://user:pw@example.com/a")).toBe("https://user:pw@example.com/a");
    expect(normalizeLink("https://user@www.example.com/a")).toBe("https://user@example.com/a");
    expect(normalizeLink("https://user@example.com/a")).not.toBe(key);
    expect(normalizeLink("https://example.com:8443/a")).toBe("https://example.com:8443/a");
    expect(normalizeLink("http://example.com:8080/a")).not.toBe(key);
  });

  it("returns invalid or non-http input trimmed and unchanged", () => {
    expect(normalizeLink("  not a url  ")).toBe("not a url");
    expect(normalizeLink(" example.com/a/ ")).toBe("example.com/a/");
    expect(normalizeLink("ftp://Example.com/a/")).toBe("ftp://Example.com/a/");
    expect(normalizeLink("https://exa mple.com")).toBe("https://exa mple.com");
    expect(normalizeLink("https://")).toBe("https://");
    expect(normalizeLink("")).toBe("");
  });
});

describe("the Add form duplicate warning", () => {
  const cols: CollectionRow[] = [{ id: 11, title: "Dev", sort: 0, count: 0 }, { id: 12, title: "Rust", parentId: 11, sort: 0, count: 0 }];
  // Mirrors SqliteStore.findByHost: the domain equals the host, or the link holds it.
  const storeOf = (rows: BookmarkRow[]) => {
    const asked: string[] = [];
    return {
      asked,
      findByHost: async (host: string) => {
        asked.push(host);
        return rows.filter((r) => r.domain.toLowerCase() === host || r.link.toLowerCase().includes(host));
      },
    };
  };
  const row = (id: number, link: string, collectionId = 12) =>
    ({ id, link, domain: new URL(link).hostname.replace(/^www\./, ""), collectionId }) as BookmarkRow;

  it("finds a stored row by its duplicate key and names its collection", async () => {
    const store = storeOf([row(5, "https://example.com/pasta?utm_source=feed")]);
    const dup = await findDuplicate(store, "https://EXAMPLE.com/pasta/", cols);
    expect(dup?.row.id).toBe(5);
    expect(duplicateText(dup!)).toBe("Already saved in Dev > Rust");
    expect(await findDuplicate(store, "https://example.com/other", cols)).toBeUndefined();
    expect(await findDuplicate(store, "not a url", cols)).toBeUndefined();
  });

  it("finds the www. and bare host forms of each other, and asks the store for the bare host", async () => {
    const bare = storeOf([row(5, "http://example.com/pasta")]);
    expect((await findDuplicate(bare, "https://www.example.com/pasta#intro", cols))?.row.id).toBe(5);
    expect(bare.asked).toEqual(["example.com"]);
    const www = storeOf([row(6, "https://www.example.com/pasta/?fbclid=1", -1)]);
    const dup = await findDuplicate(www, "https://example.com/pasta?ref_src=x", cols);
    expect(dup?.row.id).toBe(6);
    expect(duplicateText(dup!)).toBe("Already saved in Unsorted");
  });

  it("keeps ref, credentials and a port as different bookmarks", async () => {
    const store = storeOf([row(5, "https://example.com/pasta?ref=hn")]);
    expect(await findDuplicate(store, "https://example.com/pasta", cols)).toBeUndefined();
    expect(await findDuplicate(store, "https://example.com:8443/pasta?ref=hn", cols)).toBeUndefined();
    expect((await findDuplicate(store, "https://example.com/pasta?ref=hn&utm_medium=x", cols))?.row.id).toBe(5);
  });
});

describe("form tags", () => {
  it("merges new tags without case-insensitive duplicates", () => {
    expect(mergeTags(["read"], " later, #Read ,x")).toEqual(["read", "later", "x"]);
  });
});
