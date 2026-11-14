// Row writes and undo: the BookmarkWriter against a fake client, with a fake store
// or the real sqlite3 store.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RaindropApiError } from "../src/api/errors";
import type { BulkReply, Raindrop, RaindropPatch } from "../src/api/types";
import { defaultBinary, SqliteStore } from "../src/store/sqlite";
import type { BookmarkRow } from "../src/store/types";
import { UNDO_LIMIT, UndoStack, changedFields, previousFields, type UndoEntry } from "../src/undo/stack";
import { BookmarkWriter, type WriterClient, type WriterStore } from "../src/write/writer";

function row(id: number, over: Partial<BookmarkRow> = {}): BookmarkRow {
  return {
    id,
    link: `https://example.com/${id}`,
    title: `Bookmark ${id}`,
    domain: "example.com",
    type: "link",
    collectionId: -1,
    tags: ["read"],
    note: "",
    excerpt: "",
    cover: "",
    important: false,
    created: "2026-01-01T00:00:00.000Z",
    lastUpdate: "2026-11-01T00:00:00.000Z",
    highlights: [],
    openCount: 0,
    ...over,
  };
}

function toRaindrop(r: BookmarkRow): Raindrop {
  return {
    _id: r.id, link: r.link, title: r.title, domain: r.domain, type: r.type, tags: r.tags, note: r.note,
    important: r.important, collection: { $id: r.collectionId }, created: r.created, lastUpdate: r.lastUpdate,
  };
}

/** A server that records each write and answers with the merged item. */
class FakeClient implements WriterClient {
  calls: string[] = [];
  failWith: Error | undefined;
  constructor(private items: Map<number, Raindrop>) {}

  async updateRaindrop(id: number, patch: RaindropPatch): Promise<Raindrop> {
    this.calls.push(`PUT ${id} ${JSON.stringify(patch)}`);
    if (this.failWith) throw this.failWith;
    const item = { ...this.items.get(id)!, ...patch } as Raindrop;
    this.items.set(id, item);
    return item;
  }

  async deleteRaindrop(id: number): Promise<void> {
    this.calls.push(`DELETE ${id}`);
    if (this.failWith) throw this.failWith;
  }

  async createRaindrop(patch: RaindropPatch): Promise<Raindrop> {
    this.calls.push(`POST ${JSON.stringify(patch)}`);
    if (this.failWith) throw this.failWith;
    return { _id: 900, link: patch.link!, title: patch.title ?? "Parsed", collection: patch.collection, tags: patch.tags };
  }

  // Bulk cleanup has its own tests in cleanup-writer.test.ts.
  async getRaindrop(): Promise<Raindrop> {
    throw new Error("not used");
  }
  async trashRaindrops(): Promise<BulkReply> {
    throw new Error("not used");
  }
  async restoreRaindrops(): Promise<BulkReply> {
    throw new Error("not used");
  }
}

/** An in-memory store with the writer's three methods. */
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
      const old = this.rows.get(i._id) ?? row(i._id);
      this.rows.set(i._id, {
        ...old, link: i.link, title: i.title, tags: i.tags ?? [], note: i.note ?? "", important: !!i.important,
        collectionId: i.collection?.$id ?? -1,
      });
    }
  }
  async trashLocal() {}
  async restoreLocal() {}
}

function setup(rows: BookmarkRow[]) {
  const store = new FakeStore();
  for (const r of rows) store.rows.set(r.id, r);
  const client = new FakeClient(new Map(rows.map((r) => [r.id, toRaindrop(r)])));
  const failures: { title: string; error: unknown }[] = [];
  const writer = new BookmarkWriter(async () => client, store, { onFailure: (title, error) => void failures.push({ title, error }) });
  return { store, client, writer, failures };
}

describe("UndoStack", () => {
  it("keeps at most 10 entries and drops the oldest", () => {
    const stack = new UndoStack();
    for (let i = 1; i <= 12; i++) stack.push({ kind: "fields", label: `w${i}`, bookmarkId: i, previous: {} });
    expect(UNDO_LIMIT).toBe(10);
    expect(stack.size).toBe(10);
    const popped: number[] = [];
    let e: UndoEntry | undefined;
    while ((e = stack.pop())) if (e.kind !== "cleanup") popped.push(e.bookmarkId);
    expect(popped).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  });

  it("keeps 10 entries through the writer, and undo reverts the newest first", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(i + 1));
    const { writer } = setup(rows);
    for (const r of rows) await writer.update(r, { important: true }, { label: "Favorite" });
    expect(writer.undo.size).toBe(10);
    expect(writer.undo.peek()).toMatchObject({ bookmarkId: 12 });
  });

  it("changedFields and previousFields carry only what differs", () => {
    const r = row(1, { title: "A", note: "n" });
    const changed = changedFields(r, { title: "A", note: "m", tags: ["read"] });
    expect(changed).toEqual({ note: "m" });
    expect(previousFields(r, changed)).toEqual({ note: "n" });
  });
});

describe("BookmarkWriter undo kinds", () => {
  it("fields: a favorite, then undo sends one PUT with the old value", async () => {
    const { client, store, writer } = setup([row(1)]);
    expect(await writer.update(row(1), { important: true }, { label: "Favorite" })).toBe(true);
    expect((await store.getBookmark(1))?.important).toBe(true);
    const undone = await writer.undoLast();
    expect(undone?.kind).toBe("fields");
    expect(client.calls).toEqual(['PUT 1 {"important":true}', 'PUT 1 {"important":false}']);
    expect((await store.getBookmark(1))?.important).toBe(false);
    expect(writer.undo.size).toBe(0);
  });

  it("move: undo sends one PUT with the old collection", async () => {
    const { client, store, writer } = setup([row(2)]);
    await writer.move(row(2), 11);
    expect((await store.getBookmark(2))?.collectionId).toBe(11);
    expect((await writer.undoLast())?.kind).toBe("move");
    expect(client.calls).toEqual(['PUT 2 {"collection":{"$id":11}}', 'PUT 2 {"collection":{"$id":-1}}']);
    expect((await store.getBookmark(2))?.collectionId).toBe(-1);
  });

  it("trash: DELETE, then undo sends one PUT with the old collection.$id", async () => {
    const { client, store, writer } = setup([row(3, { collectionId: 12 })]);
    await writer.trash(row(3, { collectionId: 12 }));
    expect((await store.getBookmark(3))?.collectionId).toBe(-99);
    expect((await writer.undoLast())?.kind).toBe("trash");
    expect(client.calls).toEqual(["DELETE 3", 'PUT 3 {"collection":{"$id":12}}']);
    expect((await store.getBookmark(3))?.collectionId).toBe(12);
  });

  it("sends only the changed fields of an edit", async () => {
    const { client, writer } = setup([row(4, { title: "Old" })]);
    await writer.update(row(4, { title: "Old" }), { link: "https://example.com/4", title: "New", note: "", tags: ["read"], important: false, collection: { $id: -1 } });
    expect(client.calls).toEqual(['PUT 4 {"title":"New"}']);
  });

  it("puts the entry back when the undo call fails", async () => {
    const { client, writer, failures } = setup([row(5)]);
    await writer.update(row(5), { important: true }, { label: "Favorite" });
    client.failWith = new RaindropApiError(500, "/raindrop/5", "boom");
    expect(await writer.undoLast()).toBeUndefined();
    expect(writer.undo.size).toBe(1);
    expect(failures).toHaveLength(1);
  });
});

describe("BookmarkWriter failures", () => {
  it("a failing client restores the row's old state after a favorite, drops the undo entry and reports the error", async () => {
    const { client, store, writer, failures } = setup([row(6)]);
    client.failWith = new RaindropApiError(500, "/raindrop/6", "server down");
    expect(await writer.update(row(6), { important: true }, { label: "Favorite" })).toBe(false);
    expect((await store.getBookmark(6))?.important).toBe(false);
    expect(writer.undo.size).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0].title).toBe("Could not save: Favorite");
    expect((failures[0].error as Error).message).toContain("server down");
  });
});

const binary = defaultBinary();
const hasBinary = existsSync(binary);
if (!hasBinary) console.log(`Skipping the writer store tests: no sqlite3 binary at ${binary} (set TINYDROP_SQLITE3).`);

describe.skipIf(!hasBinary)("BookmarkWriter on the real sqlite3 store", () => {
  let dir: string;
  let store: SqliteStore;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tinydrop-writer-"));
    store = new SqliteStore({ path: join(dir, "tinydrop.sqlite") });
    await store.upsertPage([
      { _id: 1, link: "https://example.com/a", title: "Alpha page", tags: ["read"], collection: { $id: -1 }, highlights: [{ _id: "h1", text: "zebra stripes" }] },
    ]);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a failing client shows the row back in its old state after a favorite", async () => {
    const client = new FakeClient(new Map());
    client.failWith = new RaindropApiError(503, "/raindrop/1", "unavailable");
    const writer = new BookmarkWriter(async () => client, store);
    const before = (await store.getBookmark(1))!;
    expect(await writer.update(before, { important: true }, { label: "Favorite" })).toBe(false);
    const after = await store.getBookmark(1);
    expect(after?.important).toBe(false);
    expect(await store.search({ words: [], favorite: true })).toEqual([]);
    expect(writer.undo.size).toBe(0);
  });

  it("a trashed row leaves search and keeps its highlight; undo brings it back", async () => {
    const client = new FakeClient(new Map([[1, { _id: 1, link: "https://example.com/a", title: "Alpha page", collection: { $id: -1 }, highlights: [{ _id: "h1", text: "zebra stripes" }] }]]));
    const writer = new BookmarkWriter(async () => client, store);
    await writer.trash((await store.getBookmark(1))!);
    expect(await store.search({ words: ["alpha"] })).toEqual([]);
    expect(await store.topOpened()).toEqual([]);
    await writer.undoLast();
    expect((await store.search({ words: ["zebra"] })).map((r) => r.id)).toEqual([1]);
  });

  it("saveRow rewrites the FTS row: a new title is searchable before the server answers", async () => {
    const r = (await store.getBookmark(1))!;
    await store.saveRow({ ...r, title: "Quokka notes", tags: ["mammal"] });
    expect((await store.search({ words: ["quokka"] })).map((x) => x.id)).toEqual([1]);
    expect((await store.search({ words: ["alpha"] })).map((x) => x.id)).toEqual([]);
    expect((await store.search({ words: [], tags: ["mammal"] })).map((x) => x.id)).toEqual([1]);
    expect((await store.search({ words: ["zebra"] })).map((x) => x.id)).toEqual([1]);
  });
});
