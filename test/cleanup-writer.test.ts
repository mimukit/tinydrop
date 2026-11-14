// Bulk cleanup and its undo: the BookmarkWriter against a fake Raindrop server and a fake store.
// The fake server runs the client's real bulk guard, so a refused call fails here as it would live.
import { describe, expect, it } from "vitest";
import { assertSafeBulk } from "../src/api/client";
import { RaindropApiError } from "../src/api/errors";
import type { BulkReply, Raindrop, RaindropPatch } from "../src/api/types";
import type { DuplicateGroup } from "../src/cleanup/duplicates";
import type { BookmarkRow, CleanupRow, CollectionMove } from "../src/store/types";
import { BookmarkWriter, type WriterClient, type WriterStore } from "../src/write/writer";

const TRASH = -99;

function bookmarkRow(id: number, collectionId: number, tags: string[] = []): BookmarkRow {
  return {
    id, link: `https://example.com/${id}`, title: `Bookmark ${id}`, domain: "example.com", type: "link", collectionId, tags,
    note: "", excerpt: "", cover: "", important: false, created: "2026-01-01T00:00:00.000Z", lastUpdate: "2026-11-01T00:00:00.000Z",
    highlights: [], openCount: 0,
  };
}

type BulkHook = (collectionId: number, ids: number[]) => BulkReply | Promise<BulkReply>;

/** An in-memory Raindrop: bookmark ID to collection and tags. Records every call. */
class FakeServer implements WriterClient {
  calls: Array<{ method: string; path: string; body?: unknown }> = [];
  collections = new Map<number, number>();
  tags = new Map<number, string[]>();
  /** Replaces the default bulk trash once per call, in order. */
  trashHooks: BulkHook[] = [];
  restoreHooks: BulkHook[] = [];
  failUpdate = new Map<number, Error>();
  failGet = new Set<number>();
  failDelete = new Map<number, Error>();

  add(id: number, collectionId: number, tags: string[] = []): void {
    this.collections.set(id, collectionId);
    this.tags.set(id, tags);
  }

  private item(id: number): Raindrop {
    return { _id: id, link: `https://example.com/${id}`, title: `Bookmark ${id}`, tags: this.tags.get(id) ?? [], collection: { $id: this.collections.get(id)! } };
  }

  private move(ids: number[], from: (c: number) => boolean, to: number): BulkReply {
    let modified = 0;
    for (const id of ids) {
      const c = this.collections.get(id);
      if (c !== undefined && from(c)) {
        this.collections.set(id, to);
        modified++;
      }
    }
    return { result: true, matched: modified, modified };
  }

  async trashRaindrops(collectionId: number, ids: number[]): Promise<BulkReply> {
    const body = { ids };
    assertSafeBulk("DELETE", `/raindrops/${collectionId}`, body);
    this.calls.push({ method: "DELETE", path: `/raindrops/${collectionId}`, body });
    const hook = this.trashHooks.shift();
    if (hook) return hook(collectionId, ids);
    return this.move(ids, (c) => c === collectionId, TRASH);
  }

  async restoreRaindrops(toCollectionId: number, ids: number[]): Promise<BulkReply> {
    const body = { ids, collection: { $id: toCollectionId } };
    assertSafeBulk("PUT", `/raindrops/${TRASH}`, body);
    this.calls.push({ method: "PUT", path: `/raindrops/${TRASH}`, body });
    const hook = this.restoreHooks.shift();
    if (hook) return hook(toCollectionId, ids);
    return this.move(ids, (c) => c === TRASH, toCollectionId);
  }

  async getRaindrop(id: number): Promise<Raindrop> {
    this.calls.push({ method: "GET", path: `/raindrop/${id}` });
    if (this.failGet.has(id)) throw new TypeError("network down");
    if (!this.collections.has(id)) throw new RaindropApiError(404, `/raindrop/${id}`, "");
    return this.item(id);
  }

  async updateRaindrop(id: number, patch: RaindropPatch): Promise<Raindrop> {
    this.calls.push({ method: "PUT", path: `/raindrop/${id}`, body: patch });
    const fail = this.failUpdate.get(id);
    if (fail) throw fail;
    if (patch.tags) this.tags.set(id, patch.tags);
    if (patch.collection) this.collections.set(id, patch.collection.$id);
    return this.item(id);
  }

  async deleteRaindrop(id: number): Promise<void> {
    this.calls.push({ method: "DELETE", path: `/raindrop/${id}` });
    const fail = this.failDelete.get(id);
    if (fail) throw fail;
    this.collections.set(id, TRASH);
  }

  async createRaindrop(): Promise<Raindrop> {
    throw new Error("not used");
  }

  bulk(method: string): Array<{ path: string; ids: number[]; to?: number }> {
    return this.calls
      .filter((c) => c.method === method && c.path.startsWith("/raindrops/"))
      .map((c) => {
        const b = c.body as { ids: number[]; collection?: { $id: number } };
        return { path: c.path, ids: b.ids, ...(b.collection ? { to: b.collection.$id } : {}) };
      });
  }
}

/** The writer's store methods over a map of rows. */
class FakeStore implements WriterStore {
  rows = new Map<number, BookmarkRow>();
  async getBookmark(id: number) {
    const r = this.rows.get(id);
    return r ? { ...r, tags: [...r.tags] } : undefined;
  }
  async saveRow(r: BookmarkRow) {
    if (this.rows.has(r.id)) this.rows.set(r.id, { ...r, tags: [...r.tags] });
  }
  async upsertPage(items: Raindrop[]) {
    for (const i of items) {
      const old = this.rows.get(i._id) ?? bookmarkRow(i._id, -1);
      this.rows.set(i._id, { ...old, tags: i.tags ?? [], collectionId: i.collection?.$id ?? old.collectionId });
    }
  }
  async trashLocal(ids: number[]) {
    for (const id of ids) {
      const r = this.rows.get(id);
      if (r) this.rows.set(id, { ...r, collectionId: TRASH });
    }
  }
  async restoreLocal(moves: CollectionMove[]) {
    for (const m of moves) {
      const r = this.rows.get(m.id);
      if (r) this.rows.set(m.id, { ...r, collectionId: m.collectionId });
    }
  }
  collectionOf(id: number): number | undefined {
    return this.rows.get(id)?.collectionId;
  }
}

/** A server and a store that both hold these bookmarks: [id, collection, tags]. */
function setup(bookmarks: Array<[number, number, string[]?]>) {
  const server = new FakeServer();
  const store = new FakeStore();
  for (const [id, c, tags = []] of bookmarks) {
    server.add(id, c, tags);
    store.rows.set(id, bookmarkRow(id, c, tags));
  }
  const failures: Array<{ title: string; error: unknown }> = [];
  const writer = new BookmarkWriter(async () => server, store, { onFailure: (title, error) => void failures.push({ title, error }) });
  return { server, store, writer, failures };
}

const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);

describe("bulk trash", () => {
  it("sends 150 bookmarks in two batches of at most 100 and keeps one undo entry with each original collection", async () => {
    const ids = range(1, 150);
    const { server, store, writer } = setup(ids.map((id) => [id, 5]));
    const result = await writer.trashBookmarks(ids.map((id) => ({ id, collectionId: 5 })), { label: "Trash Dead" });
    expect(server.bulk("DELETE").map((c) => [c.path, c.ids.length])).toEqual([["/raindrops/5", 100], ["/raindrops/5", 50]]);
    expect(result).toMatchObject({ requested: 150, trashed: 150, failed: 0, unresolved: 0 });
    expect(ids.every((id) => store.collectionOf(id) === TRASH)).toBe(true);
    expect(writer.undo.size).toBe(1);
    const entry = writer.undo.peek();
    expect(entry).toMatchObject({ kind: "cleanup", label: "Trash Dead" });
    expect(entry?.kind === "cleanup" && entry.items).toEqual(ids.map((id) => ({ id, collectionId: 5 })));
  });
});

function cleanupRow(id: number, collectionId: number, tags: string[] = [], over: Partial<CleanupRow> = {}): CleanupRow {
  return { id, link: `https://example.com/dup`, title: `Bookmark ${id}`, collectionId, created: "2026-01-01T00:00:00.000Z", important: false, tags, noteLength: 0, highlightCount: 0, ...over };
}

function group(keeper: CleanupRow, extras: CleanupRow[]): DuplicateGroup {
  return { key: `k${keeper.id}`, keeper, extras, rows: [keeper, ...extras], warnings: extras.filter((e) => e.noteLength > 0 || e.highlightCount > 0) };
}

describe("duplicate cleanup", () => {
  it("adds the extras' tags to the keeper with a PUT that sends only `tags`, then trashes the extras", async () => {
    const { server, store, writer } = setup([[1, 5, ["a", "B"]], [2, -1, ["b", "c"]], [3, 7, ["d"]]]);
    const g = group(cleanupRow(1, 5, ["a", "B"]), [cleanupRow(2, -1, ["b", "c"]), cleanupRow(3, 7, ["d"])]);
    const result = await writer.cleanupDuplicates([g], { label: "Trash Extras" });
    const tagCall = server.calls.find((c) => c.path === "/raindrop/1")!;
    expect(tagCall.method).toBe("PUT");
    expect(tagCall.body).toEqual({ tags: ["a", "B", "c", "d"] });
    expect(server.calls.indexOf(tagCall)).toBe(0);
    expect(server.bulk("DELETE")).toEqual([{ path: "/raindrops/-1", ids: [2] }, { path: "/raindrops/7", ids: [3] }]);
    expect(store.rows.get(1)?.tags).toEqual(["a", "B", "c", "d"]);
    expect(result).toMatchObject({ requested: 2, trashed: 2, failed: 0, unresolved: 0, skipped: 0, tagFailures: 0 });
  });

  it("leaves a group's extras untouched when its tag update fails, and still cleans up the other groups", async () => {
    const { server, store, writer, failures } = setup([[1, 5, ["a"]], [2, 5, ["b"]], [10, 5, ["x"]], [11, 6, ["x"]]]);
    server.failUpdate.set(1, new RaindropApiError(500, "/raindrop/1", "boom"));
    const result = await writer.cleanupDuplicates([
      group(cleanupRow(1, 5, ["a"]), [cleanupRow(2, 5, ["b"])]),
      group(cleanupRow(10, 5, ["x"]), [cleanupRow(11, 6, ["x"])]),
    ]);
    expect(server.calls.filter((c) => c.path === "/raindrop/10")).toEqual([]);
    expect(server.bulk("DELETE")).toEqual([{ path: "/raindrops/6", ids: [11] }]);
    expect(store.collectionOf(2)).toBe(5);
    expect(server.collections.get(2)).toBe(5);
    expect(store.rows.get(1)?.tags).toEqual(["a"]);
    expect(result).toMatchObject({ requested: 1, trashed: 1, skipped: 1, tagFailures: 1, ids: { skipped: [2] } });
    expect(failures).toHaveLength(1);
  });

  it("skips annotated extras unless the owner approved them", async () => {
    const g = group(cleanupRow(1, 5), [cleanupRow(2, 5), cleanupRow(3, 5, [], { noteLength: 4 })]);
    const plain = setup([[1, 5], [2, 5], [3, 5]]);
    await plain.writer.cleanupDuplicates([g]);
    expect(plain.server.bulk("DELETE")).toEqual([{ path: "/raindrops/5", ids: [2] }]);
    const approved = setup([[1, 5], [2, 5], [3, 5]]);
    await approved.writer.cleanupDuplicates([g], { approvedAnnotated: new Set([g.key]) });
    expect(approved.server.bulk("DELETE")).toEqual([{ path: "/raindrops/5", ids: [2, 3] }]);
  });
});

describe("bulk trash failures", () => {
  it("a failed batch keeps the other batches: its rows go back locally and only confirmed IDs enter the undo entry", async () => {
    const { server, store, writer, failures } = setup([[1, 5], [2, 6], [3, 6], [4, 7]]);
    server.trashHooks = [
      (_c, ids) => ({ result: true, matched: ids.length, modified: ids.length }),
      () => {
        throw new RaindropApiError(400, "/raindrops/6", "bad request");
      },
    ];
    const result = await writer.trashBookmarks([
      { id: 1, collectionId: 5 },
      { id: 2, collectionId: 6 },
      { id: 3, collectionId: 6 },
      { id: 4, collectionId: 7 },
    ]);
    expect(server.bulk("DELETE").map((c) => c.path)).toEqual(["/raindrops/5", "/raindrops/6", "/raindrops/7"]);
    expect(result).toMatchObject({ requested: 4, trashed: 2, failed: 2, unresolved: 0, ids: { trashed: [1, 4], failed: [2, 3] } });
    expect([1, 2, 3, 4].map((id) => store.collectionOf(id))).toEqual([TRASH, 6, 6, TRASH]);
    expect(result.entry?.items).toEqual([{ id: 1, collectionId: 5 }, { id: 4, collectionId: 7 }]);
    expect(writer.undo.size).toBe(1);
    expect(failures).toHaveLength(1);
    expect((failures[0].error as Error).message).toBe("Moved 2 of 4 to Trash. 2 failed.");
  });

  it("stops at a rejected token: no later batch goes out, no fallback, and every row comes back", async () => {
    const { server, store, writer } = setup([[1, 5], [2, 6]]);
    server.trashHooks = [
      () => {
        throw new RaindropApiError(401, "/raindrops/5", "");
      },
    ];
    const result = await writer.trashBookmarks([
      { id: 1, collectionId: 5 },
      { id: 2, collectionId: 6 },
    ]);
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["DELETE /raindrops/5"]);
    expect(result).toMatchObject({ trashed: 0, failed: 2, unresolved: 0 });
    expect([store.collectionOf(1), store.collectionOf(2)]).toEqual([5, 6]);
    expect(writer.undo.size).toBe(0);
  });
});

describe("ambiguous bulk replies", () => {
  it("re-reads each ID after a timeout: confirmed Trash counts, the rest go back, a failed re-read stays unresolved", async () => {
    const { server, store, writer, failures } = setup([[1, 5], [2, 5], [3, 5]]);
    server.trashHooks = [
      () => {
        server.collections.set(1, TRASH);
        server.collections.set(3, TRASH);
        throw new Error("timeout");
      },
    ];
    server.failGet.add(3);
    const result = await writer.trashBookmarks([1, 2, 3].map((id) => ({ id, collectionId: 5 })));
    expect(server.calls.filter((c) => c.method === "GET").map((c) => c.path)).toEqual(["/raindrop/1", "/raindrop/2", "/raindrop/3"]);
    expect(server.calls.filter((c) => c.path.startsWith("/raindrop/") && c.method === "DELETE")).toEqual([]);
    expect(result).toMatchObject({ trashed: 1, failed: 1, unresolved: 1, ids: { trashed: [1], failed: [2], unresolved: [3] } });
    expect([1, 2, 3].map((id) => store.collectionOf(id))).toEqual([TRASH, 5, 5]);
    expect(result.entry?.items).toEqual([{ id: 1, collectionId: 5 }]);
    expect((failures[0].error as Error).message).toBe("Moved 1 of 3 to Trash. 1 failed. 1 unresolved: sync to check them.");
  });

  it("treats a 200 with `modified` below the ID count as unresolved and re-reads the batch", async () => {
    const { server, writer } = setup([[1, 5], [2, 5]]);
    server.trashHooks = [
      () => {
        server.collections.set(2, TRASH);
        return { result: true, matched: 1, modified: 1 };
      },
    ];
    const result = await writer.trashBookmarks([1, 2].map((id) => ({ id, collectionId: 5 })));
    expect(server.calls.filter((c) => c.method === "GET")).toHaveLength(2);
    expect(result).toMatchObject({ trashed: 1, failed: 1, unresolved: 0, ids: { trashed: [2], failed: [1] } });
  });

  it("does not count a 200 with `modified: 0` as success", async () => {
    const { server, writer } = setup([[1, 5]]);
    server.trashHooks = [() => ({ result: true, matched: 0, modified: 0 })];
    const result = await writer.trashBookmarks([{ id: 1, collectionId: 5 }]);
    expect(result).toMatchObject({ trashed: 0, failed: 1 });
    expect(writer.undo.size).toBe(0);
  });
});

describe("single-bookmark fallback", () => {
  it("falls back to DELETE /raindrop/{id} when the bulk route is unsupported, for this batch and the next", async () => {
    const { server, store, writer } = setup([[1, 5], [2, 5], [3, 6], [4, 6]]);
    server.trashHooks = [
      () => {
        throw new RaindropApiError(405, "/raindrops/5", "");
      },
    ];
    server.failDelete.set(2, new RaindropApiError(404, "/raindrop/2", ""));
    server.failDelete.set(4, new RaindropApiError(502, "/raindrop/4", ""));
    const result = await writer.trashBookmarks([1, 2, 3, 4].map((id) => ({ id, collectionId: id < 3 ? 5 : 6 })));
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "DELETE /raindrops/5",
      "DELETE /raindrop/1",
      "DELETE /raindrop/2",
      "DELETE /raindrop/3",
      "DELETE /raindrop/4",
      "GET /raindrop/4",
    ]);
    expect(result).toMatchObject({ trashed: 2, failed: 2, unresolved: 0, ids: { trashed: [1, 3], failed: [2, 4] } });
    expect(store.collectionOf(2)).toBe(5);
    expect(result.entry?.items).toEqual([{ id: 1, collectionId: 5 }, { id: 3, collectionId: 6 }]);
  });
});

describe("cleanup undo", () => {
  it("restores every ID to its original collection with one PUT /raindrops/-99 per collection", async () => {
    const { server, store, writer } = setup([[1, 5], [2, -1], [3, 5], [4, 7]]);
    await writer.trashBookmarks([
      { id: 1, collectionId: 5 },
      { id: 2, collectionId: -1 },
      { id: 3, collectionId: 5 },
      { id: 4, collectionId: 7 },
    ], { label: "Trash All Dead" });
    const undone = await writer.undoLast();
    expect(undone).toMatchObject({ kind: "cleanup", label: "Trash All Dead" });
    expect(server.bulk("PUT")).toEqual([
      { path: "/raindrops/-99", ids: [1, 3], to: 5 },
      { path: "/raindrops/-99", ids: [2], to: -1 },
      { path: "/raindrops/-99", ids: [4], to: 7 },
    ]);
    expect([1, 2, 3, 4].map((id) => server.collections.get(id))).toEqual([5, -1, 5, 7]);
    expect([1, 2, 3, 4].map((id) => store.collectionOf(id))).toEqual([5, -1, 5, 7]);
    expect(writer.undo.size).toBe(0);
  });

  it("restores 150 bookmarks in two batches", async () => {
    const ids = range(1, 150);
    const { server, writer } = setup(ids.map((id) => [id, 9]));
    await writer.trashBookmarks(ids.map((id) => ({ id, collectionId: 9 })));
    await writer.undoLast();
    expect(server.bulk("PUT").map((c) => [c.ids.length, c.to])).toEqual([[100, 9], [50, 9]]);
    expect(ids.every((id) => server.collections.get(id) === 9)).toBe(true);
  });

  it("works after a sync removed the local Trash rows", async () => {
    const { server, store, writer, failures } = setup([[1, 5], [2, 6]]);
    await writer.trashBookmarks([
      { id: 1, collectionId: 5 },
      { id: 2, collectionId: 6 },
    ]);
    store.rows.clear();
    expect(await writer.undoLast()).toMatchObject({ kind: "cleanup" });
    expect([server.collections.get(1), server.collections.get(2)]).toEqual([5, 6]);
    expect(failures).toEqual([]);
  });

  it("keeps the IDs still in Trash in a retryable entry after a partial undo failure, and the retry sends only those", async () => {
    const { server, store, writer, failures } = setup([[1, 5], [2, 6], [3, 6]]);
    await writer.trashBookmarks([
      { id: 1, collectionId: 5 },
      { id: 2, collectionId: 6 },
      { id: 3, collectionId: 6 },
    ], { label: "Trash Extras" });
    server.restoreHooks = [
      (to, ids) => {
        for (const id of ids) server.collections.set(id, to);
        return { result: true, matched: ids.length, modified: ids.length };
      },
      () => {
        throw new RaindropApiError(503, "/raindrops/-99", "unavailable");
      },
    ];
    expect(await writer.undoLast()).toBeUndefined();
    expect(server.collections.get(1)).toBe(5);
    expect([server.collections.get(2), server.collections.get(3)]).toEqual([TRASH, TRASH]);
    expect(store.collectionOf(1)).toBe(5);
    expect(writer.undo.size).toBe(1);
    const retry = writer.undo.peek();
    expect(retry?.kind === "cleanup" && retry.items).toEqual([{ id: 2, collectionId: 6 }, { id: 3, collectionId: 6 }]);
    expect(failures).toHaveLength(1);
    expect((failures[0].error as Error).message).toBe("Restored 1 of 3. 2 still in Trash. Undo again to retry.");

    server.calls = [];
    expect(await writer.undoLast()).toMatchObject({ kind: "cleanup" });
    expect(server.bulk("PUT")).toEqual([{ path: "/raindrops/-99", ids: [2, 3], to: 6 }]);
    expect([server.collections.get(2), server.collections.get(3)]).toEqual([6, 6]);
    expect(writer.undo.size).toBe(0);
  });

  it("re-reads after a short `modified` on restore and keeps only the IDs still in Trash", async () => {
    const { server, writer } = setup([[1, 5], [2, 5]]);
    await writer.trashBookmarks([1, 2].map((id) => ({ id, collectionId: 5 })));
    server.restoreHooks = [
      () => {
        server.collections.set(1, 5);
        return { result: true, matched: 1, modified: 1 };
      },
    ];
    expect(await writer.undoLast()).toBeUndefined();
    const retry = writer.undo.peek();
    expect(retry?.kind === "cleanup" && retry.items).toEqual([{ id: 2, collectionId: 5 }]);
  });

  it("restores collections only and leaves the merged tags on the keeper", async () => {
    const { server, writer } = setup([[1, 5, ["a"]], [2, 6, ["b"]]]);
    await writer.cleanupDuplicates([group(cleanupRow(1, 5, ["a"]), [cleanupRow(2, 6, ["b"])])]);
    server.calls = [];
    await writer.undoLast();
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /raindrops/-99"]);
    expect(server.tags.get(1)).toEqual(["a", "b"]);
    expect(server.collections.get(2)).toBe(6);
  });

  it("shares the ten-entry limit with single-bookmark writes", async () => {
    const { writer } = setup(range(1, 12).map((id) => [id, 5]));
    for (const id of range(1, 12)) await writer.trashBookmarks([{ id, collectionId: 5 }]);
    expect(writer.undo.size).toBe(10);
  });
});

describe("duplicate cleanup with a rejected token", () => {
  it("stops at the first rejected tag update: no later call goes out and nothing is trashed", async () => {
    const { server, writer, failures } = setup([[1, 5, ["a"]], [2, 5, ["b"]], [3, 5, ["c"]], [4, 5, ["d"]]]);
    server.failUpdate.set(1, new RaindropApiError(401, "/raindrop/1", ""));
    const result = await writer.cleanupDuplicates([
      group(cleanupRow(1, 5, ["a"]), [cleanupRow(2, 5, ["b"])]),
      group(cleanupRow(3, 5, ["c"]), [cleanupRow(4, 5, ["d"])]),
    ]);
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /raindrop/1"]);
    expect(result).toMatchObject({ requested: 0, trashed: 0, skipped: 2, tagFailures: 1 });
    expect((failures[0].error as RaindropApiError).isTokenRejected).toBe(true);
  });
});

describe("the bulk guard through the writer", () => {
  it("counts a refused bulk DELETE to collection 0 as failed with no request, and sends nothing for no IDs", async () => {
    const { server, store, writer } = setup([[1, 0]]);
    const result = await writer.trashBookmarks([{ id: 1, collectionId: 0 }]);
    expect(server.calls).toEqual([]);
    expect(result).toMatchObject({ trashed: 0, failed: 1, unresolved: 0 });
    expect(store.collectionOf(1)).toBe(0);
    expect(await writer.trashBookmarks([])).toMatchObject({ requested: 0, trashed: 0 });
    expect(await writer.trashBookmarks([{ id: 1, collectionId: TRASH }])).toMatchObject({ requested: 0 });
    expect(server.calls).toEqual([]);
    expect(writer.undo.size).toBe(0);
  });
});
