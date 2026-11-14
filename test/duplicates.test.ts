import { describe, expect, it } from "vitest";
import { bulkTrashIds, chooseKeeper, compareKeeper, groupDuplicates, hasAnnotations, withKeeper } from "../src/cleanup/duplicates";
import type { CleanupRow } from "../src/store/types";

function row(id: number, link: string, over: Partial<CleanupRow> = {}): CleanupRow {
  return {
    id,
    link,
    title: `Bookmark ${id}`,
    collectionId: 12,
    created: "2026-01-01T00:00:00.000Z",
    important: false,
    tags: [],
    noteLength: 0,
    highlightCount: 0,
    ...over,
  };
}

const ids = (rows: CleanupRow[]) => rows.map((r) => r.id);

describe("duplicate groups", () => {
  it("groups two or more rows with the same key across collections, outside Trash", () => {
    const groups = groupDuplicates([
      row(1, "https://example.com/a", { collectionId: 11 }),
      row(2, "http://www.example.com/a/?utm_source=x", { collectionId: 12 }),
      row(3, "https://example.com/b"),
      row(4, "https://example.com/a#top", { collectionId: -1 }),
      row(5, "https://example.com/b?ref=hn"),
      row(6, "https://example.com/c"),
      row(7, "https://example.com/c", { collectionId: -99 }),
      row(8, " not a url "),
      row(9, "not a url"),
    ]);
    expect(groups.map((g) => ({ key: g.key, ids: ids(g.rows).sort() }))).toEqual([
      { key: "https://example.com/a", ids: [1, 2, 4] },
      { key: "not a url", ids: [8, 9] },
    ]);
  });

  it("returns no group when every key is unique", () => {
    expect(groupDuplicates([row(1, "https://a.com"), row(2, "https://b.com")])).toEqual([]);
    expect(groupDuplicates([])).toEqual([]);
  });
});

describe("the keeper", () => {
  const L = "https://example.com/a";
  // Each pair: the first row wins on this rule, and loses or ties on every later rule.
  const rules: [string, CleanupRow, CleanupRow][] = [
    [
      "favorite",
      row(9, L, { important: true, collectionId: -1, created: "2026-05-01" }),
      row(1, L, { highlightCount: 5, noteLength: 10, tags: ["a", "b"], created: "2026-01-01" }),
    ],
    [
      "most highlights",
      row(9, L, { highlightCount: 2, collectionId: -1, created: "2026-05-01" }),
      row(1, L, { highlightCount: 1, noteLength: 10, tags: ["a", "b"], created: "2026-01-01" }),
    ],
    ["a non-empty note", row(9, L, { noteLength: 1, collectionId: -1, created: "2026-05-01" }), row(1, L, { tags: ["a", "b"], created: "2026-01-01" })],
    ["a named collection over Unsorted", row(9, L, { collectionId: 12, created: "2026-05-01" }), row(1, L, { collectionId: -1, tags: ["a", "b"], created: "2026-01-01" })],
    ["most tags", row(9, L, { tags: ["a", "b"], created: "2026-05-01" }), row(1, L, { tags: ["a"], created: "2026-01-01" })],
    ["oldest created", row(9, L, { created: "2026-01-01T00:00:00.000Z" }), row(1, L, { created: "2026-01-02T00:00:00.000Z" })],
    ["the lower bookmark ID", row(1, L), row(9, L)],
  ];

  it.each(rules)("prefers %s", (_rule, winner, loser) => {
    expect(chooseKeeper([loser, winner]).id).toBe(winner.id);
    expect(chooseKeeper([winner, loser]).id).toBe(winner.id);
    expect(compareKeeper(winner, loser)).toBeLessThan(0);
    expect(compareKeeper(loser, winner)).toBeGreaterThan(0);
  });

  it("treats a longer note as equal to a short one and settles equal values by ID", () => {
    const short = row(1, L, { noteLength: 1 });
    const long = row(2, L, { noteLength: 500 });
    expect(chooseKeeper([long, short]).id).toBe(1);
    expect(compareKeeper(row(3, L, { collectionId: 11 }), row(3, L, { collectionId: 12 }))).toBe(0);
    expect(chooseKeeper([row(7, L), row(3, L), row(5, L)]).id).toBe(3);
  });

  it("compares created as a time, and puts a missing time last", () => {
    expect(chooseKeeper([row(1, L, { created: "2026-01-01T00:00:01Z" }), row(2, L, { created: "2026-01-01T00:00:00.500Z" })]).id).toBe(2);
    expect(chooseKeeper([row(1, L, { created: "" }), row(2, L, { created: "2026-06-01T00:00:00.000Z" })]).id).toBe(2);
    expect(compareKeeper(row(1, L, { created: "" }), row(2, L, { created: "bad" }))).toBeLessThan(0);
  });

  it("ranks two named collections as equal", () => {
    expect(chooseKeeper([row(2, L, { collectionId: 40 }), row(1, L, { collectionId: 11 })]).id).toBe(1);
  });

  it("puts the keeper first in a group and the extras after it in keeper order", () => {
    const [group] = groupDuplicates([
      row(1, L, { collectionId: -1 }),
      row(2, L, { tags: ["x"] }),
      row(3, L, { important: true }),
    ]);
    expect(group.keeper.id).toBe(3);
    expect(ids(group.extras)).toEqual([2, 1]);
    expect(ids(group.rows)).toEqual([3, 2, 1]);
  });
});

describe("another keeper and annotation warnings", () => {
  const L = "https://example.com/a";
  const group = () =>
    groupDuplicates([
      row(1, L, { important: true }),
      row(2, L, { noteLength: 3 }),
      row(3, L, { highlightCount: 1 }),
      row(4, L),
    ])[0];

  it("marks the extras with a note or highlights", () => {
    expect(hasAnnotations(row(1, L))).toBe(false);
    expect(hasAnnotations(row(1, L, { noteLength: 1 }))).toBe(true);
    expect(hasAnnotations(row(1, L, { highlightCount: 1 }))).toBe(true);
    const g = group();
    expect(g.keeper.id).toBe(1);
    expect(ids(g.warnings)).toEqual([3, 2]);
  });

  it("skips annotated extras in bulk cleanup until the owner approves them", () => {
    const g = group();
    expect(bulkTrashIds(g)).toEqual([4]);
    expect(bulkTrashIds(g, true)).toEqual([3, 2, 4]);
  });

  it("does not warn about an annotated keeper", () => {
    const [g] = groupDuplicates([row(1, L, { highlightCount: 2, noteLength: 9 }), row(2, L)]);
    expect(g.keeper.id).toBe(1);
    expect(g.warnings).toEqual([]);
    expect(bulkTrashIds(g)).toEqual([2]);
  });

  it("lets the owner choose another keeper and recomputes the extras and warnings", () => {
    const g = withKeeper(group(), 4);
    expect(g.keeper.id).toBe(4);
    expect(ids(g.extras)).toEqual([1, 3, 2]);
    expect(ids(g.rows)).toEqual([4, 1, 3, 2]);
    expect(ids(g.warnings)).toEqual([3, 2]);
    expect(bulkTrashIds(g)).toEqual([1]);
    const back = withKeeper(g, 3);
    expect(back.keeper.id).toBe(3);
    expect(ids(back.warnings)).toEqual([2]);
    expect(bulkTrashIds(back)).toEqual([1, 4]);
  });

  it("rejects a keeper ID outside the group", () => {
    expect(() => withKeeper(group(), 99)).toThrow(/99/);
  });
});
