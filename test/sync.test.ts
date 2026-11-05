// The sync planner against a fake client, with a fake store or the real sqlite3 store.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PageQuery } from "../src/api/client";
import { RaindropApiError } from "../src/api/errors";
import { resetWaitMs } from "../src/api/pace";
import type { Collection, ItemsReply, Raindrop, Tag, User } from "../src/api/types";
import { runProcess } from "../src/store/run";
import { defaultBinary, SqliteStore } from "../src/store/sqlite";
import type { CollectionRow, TagRow, UpsertOptions } from "../src/store/types";
import { collectionRows, runSync, SYNC_KEYS, trashCutoff, type SyncClient, type SyncStore } from "../src/sync/sync";
import { fullResyncDue, isStale, progressText, resyncEstimate, syncSummary } from "../src/sync/text";

const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const MIN = 60_000;

/** A bookmark changed `minutesAgo` minutes before NOW. */
function bm(id: number, minutesAgo: number): Raindrop {
  return {
    _id: id,
    link: `https://example.com/${id}`,
    title: `Bookmark ${id}`,
    collection: { $id: -1 },
    created: "2026-01-01T00:00:00.000Z",
    lastUpdate: new Date(NOW - minutesAgo * MIN).toISOString(),
  };
}

type Failure = { at: (call: string) => boolean; error: () => Error; times: number };

class FakeClient implements SyncClient {
  calls: string[] = [];
  failures: Failure[] = [];
  /** Runs after a library page is served, to change the server in the middle of a run. */
  afterPage?: (page: number) => void;
  constructor(
    public library: Raindrop[] = [],
    public trash: Raindrop[] = [],
  ) {}

  private record(call: string) {
    this.calls.push(call);
    const f = this.failures.find((x) => x.times > 0 && x.at(call));
    if (f) {
      f.times -= 1;
      throw f.error();
    }
  }

  async getRaindrops(collectionId: number, query: PageQuery = {}): Promise<ItemsReply<Raindrop>> {
    const page = query.page ?? 0;
    const perpage = query.perpage ?? 50;
    this.record(`raindrops/${collectionId} page=${page}${query.search ? ` search=${query.search}` : ""}`);
    let items: Raindrop[];
    if (collectionId === -99) {
      const cutoff = query.search?.match(/^lastUpdate:>(\d{4}-\d{2}-\d{2})$/)?.[1];
      items = this.trash.filter((r) => !cutoff || (r.lastUpdate ?? "") > cutoff);
    } else {
      items = [...this.library].sort((a, b) => Date.parse(b.lastUpdate!) - Date.parse(a.lastUpdate!));
    }
    const reply = { result: true, items: items.slice(page * perpage, (page + 1) * perpage), count: items.length };
    if (collectionId !== -99) this.afterPage?.(page);
    return reply;
  }
  async getRaindrop(id: number): Promise<Raindrop> {
    this.record(`raindrop/${id}`);
    const found = this.library.find((r) => r._id === id) ?? this.trash.find((r) => r._id === id);
    if (!found) throw new RaindropApiError(404, `/raindrop/${id}`, "{}");
    return found;
  }
  async getCollections(): Promise<Collection[]> {
    this.record("collections");
    return [{ _id: 11, title: "Dev" }];
  }
  async getChildCollections(): Promise<Collection[]> {
    this.record("collections/childrens");
    return [{ _id: 12, title: "Rust", parent: { $id: 11 } }];
  }
  async getUser(): Promise<User> {
    this.record("user");
    return { _id: 7, groups: [{ title: "My", collections: [11] }] };
  }
  async getTags(): Promise<Tag[]> {
    this.record("tags/0");
    return [{ _id: "rust", count: 1 }];
  }
}

class FakeStore implements SyncStore {
  rows = new Map<number, Raindrop>();
  opens = new Set<number>();
  seen = new Set<number>();
  state = new Map<string, string>();
  collections: CollectionRow[] = [];
  tags: TagRow[] = [];
  upserts: number[][] = [];
  deleted: number[][] = [];

  async upsertPage(items: Raindrop[], options: UpsertOptions = {}) {
    this.upserts.push(items.map((i) => i._id));
    for (const i of items) {
      this.rows.set(i._id, i);
      if (options.seen) this.seen.add(i._id);
    }
    for (const [k, v] of Object.entries(options.syncState ?? {})) this.state.set(k, v);
  }
  async deleteIds(ids: number[]) {
    this.deleted.push(ids);
    let n = 0;
    for (const id of ids) {
      if (this.rows.delete(id)) n += 1;
      this.opens.delete(id);
    }
    return n;
  }
  async clearSeen() {
    this.seen.clear();
  }
  async unseenIds() {
    return [...this.rows.keys()].filter((id) => !this.seen.has(id));
  }
  async deleteUnseen() {
    const gone = [...this.rows.keys()].filter((id) => !this.seen.has(id));
    for (const id of gone) this.rows.delete(id);
    for (const id of [...this.opens]) if (!this.rows.has(id)) this.opens.delete(id);
    this.seen.clear();
    return gone.length;
  }
  async replaceCollections(c: CollectionRow[]) {
    this.collections = c;
  }
  async replaceTags(t: TagRow[]) {
    this.tags = t;
  }
  async getSyncState(key: string) {
    return this.state.get(key);
  }
  async setSyncState(entries: Record<string, string>) {
    for (const [k, v] of Object.entries(entries)) this.state.set(k, v);
  }
}

const opts = { now: () => NOW, sleep: async () => undefined };
const pageCalls = (c: FakeClient) => c.calls.filter((x) => x.startsWith("raindrops/0 "));

describe("runSync, incremental", () => {
  it("stops at the first page whose last row is older than the sync mark", async () => {
    // 150 bookmarks, one minute apart; the mark sits between rows 60 and 61.
    const library = Array.from({ length: 150 }, (_, i) => bm(i + 1, i + 1));
    const client = new FakeClient(library);
    const store = new FakeStore();
    store.state.set(SYNC_KEYS.mark, new Date(NOW - 60.5 * MIN).toISOString());
    const result = await runSync(client, store, opts);
    expect(result.kind).toBe("incremental");
    expect(pageCalls(client)).toEqual(["raindrops/0 page=0", "raindrops/0 page=1"]);
    expect(result.changed).toBe(60);
    expect(store.rows.size).toBe(60);
    expect(store.state.get(SYNC_KEYS.mark)).toBe(library[0].lastUpdate);
  });

  it("dedupes the Trash search by _id and drops those rows, with the cutoff one day before the mark", async () => {
    const mark = "2026-11-03T05:00:00.000Z";
    const trashed = [bm(5, 10), bm(6, 20)];
    // The same IDs come back on two Trash pages: 50 rows on page 0, then repeats on page 1.
    const trash = [...Array.from({ length: 48 }, (_, i) => bm(1000 + i, 30)), ...trashed, trashed[0], trashed[1]];
    const client = new FakeClient([bm(1, 3000)], trash);
    const store = new FakeStore();
    store.state.set(SYNC_KEYS.mark, mark);
    for (const r of [bm(5, 9000), bm(6, 9000), bm(7, 9000)]) store.rows.set(r._id, r);
    store.opens.add(5);
    const result = await runSync(client, store, opts);
    expect(trashCutoff(mark)).toBe("2026-11-02");
    expect(client.calls).toContain("raindrops/-99 page=0 search=lastUpdate:>2026-11-02");
    expect(client.calls).toContain("raindrops/-99 page=1 search=lastUpdate:>2026-11-02");
    const ids = store.deleted.at(-1)!;
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === 5 || id === 6)).toHaveLength(2);
    expect(result.removed).toBe(2);
    expect([...store.rows.keys()].sort()).toEqual([1, 7]);
    expect(store.opens.has(5)).toBe(false);
  });

  it("makes 6 calls or fewer on a second sync with no changes", async () => {
    const client = new FakeClient(Array.from({ length: 120 }, (_, i) => bm(i + 1, i + 1)));
    const store = new FakeStore();
    await runSync(client, store, opts);
    client.calls = [];
    const second = await runSync(client, store, opts);
    expect(second).toMatchObject({ kind: "incremental", changed: 0, removed: 0 });
    expect(client.calls.length).toBeLessThanOrEqual(6);
  });
});

describe("runSync, rate limit and resume", () => {
  const rateLimited = () => new RaindropApiError(429, "/raindrops/0", "", "30");

  it("waits for X-RateLimit-Reset on a 429 mid-run and goes on from the next page", async () => {
    const client = new FakeClient(Array.from({ length: 150 }, (_, i) => bm(i + 1, i + 1)));
    client.failures.push({ at: (c) => c === "raindrops/0 page=2", error: rateLimited, times: 1 });
    const store = new FakeStore();
    const waits: number[] = [];
    const result = await runSync(client, store, { now: () => NOW, sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([resetWaitMs("30", NOW)]);
    expect(pageCalls(client)).toEqual(["raindrops/0 page=0", "raindrops/0 page=1", "raindrops/0 page=2", "raindrops/0 page=2", "raindrops/0 page=3"]);
    expect(store.upserts.flat()).toHaveLength(150);
    expect(result.changed).toBe(150);
  });

  it("resumes a stopped run from the last stored page on the next sync", async () => {
    const client = new FakeClient(Array.from({ length: 150 }, (_, i) => bm(i + 1, i + 1)));
    // More 429s than one run waits for: the first run gives up on page 2.
    client.failures.push({ at: (c) => c === "raindrops/0 page=2", error: rateLimited, times: 6 });
    const store = new FakeStore();
    const error = await runSync(client, store, opts).catch((e) => e);
    expect(error).toBeInstanceOf(RaindropApiError);
    expect(JSON.parse(store.state.get(SYNC_KEYS.run)!)).toMatchObject({ kind: "full", page: 2, changed: 100 });
    client.calls = [];
    const result = await runSync(client, store, opts);
    expect(result).toMatchObject({ kind: "full", resumed: true, changed: 150, removed: 0 });
    expect(pageCalls(client)[0]).toBe("raindrops/0 page=2");
    expect(store.rows.size).toBe(150);
    expect(store.state.get(SYNC_KEYS.run)).toBe("");
  });
});

describe("runSync, collections and tags", () => {
  it("stores collections with the user.groups title and the tags", async () => {
    const store = new FakeStore();
    await runSync(new FakeClient([bm(1, 1)]), store, opts);
    expect(store.collections).toEqual([
      { id: 11, title: "Dev", sort: 0, count: 0, parentId: undefined, group: "My", groupOrder: 0 },
      { id: 12, title: "Rust", sort: 0, count: 0, parentId: 11 },
    ]);
    expect(store.tags).toEqual([{ name: "rust", count: 1 }]);
    expect(collectionRows([{ _id: 1, title: "A" }, { _id: 2, title: "B" }], [], {
      _id: 1,
      groups: [
        { title: "Second", sort: 1, collections: [1] },
        { title: "First", sort: 0, collections: [2] },
      ],
    }).map((c) => [c.title, c.group, c.groupOrder])).toEqual([
      ["A", "Second", 10_000],
      ["B", "First", 0],
    ]);
  });
});

const binary = defaultBinary();
const hasBinary = existsSync(binary);
if (!hasBinary) console.log(`Skipping the sqlite3 sync test: no sqlite3 binary at ${binary}.`);

describe.skipIf(!hasBinary)("runSync on the real sqlite3 store", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tinydrop-sync-"));
    path = join(dir, "tinydrop.sqlite");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a full resync removes an ID the server no longer has, and its opens row", async () => {
    const store = new SqliteStore({ path, binary });
    await store.upsertPage([bm(1, 5), bm(2, 4), bm(3, 3)]);
    await store.recordOpen(3, 1000);
    await store.recordOpen(1, 1000);
    await store.setSyncState({ [SYNC_KEYS.mark]: bm(3, 3).lastUpdate! });
    const client = new FakeClient([bm(1, 5), bm(2, 4)]);
    const result = await runSync(client, store, { ...opts, full: true });
    expect(result).toMatchObject({ kind: "full", changed: 2, removed: 1 });
    expect(await store.count()).toBe(2);
    expect(await store.getBookmark(3)).toBeUndefined();
    const opens = await runProcess(binary, ["-json", path, "SELECT bookmark_id FROM opens ORDER BY bookmark_id;"]);
    expect(JSON.parse(opens.stdout)).toEqual([{ bookmark_id: 1 }]);
    const seen = await runProcess(binary, ["-json", path, "SELECT count(*) AS n FROM sync_seen;"]);
    expect(JSON.parse(seen.stdout)).toEqual([{ n: 0 }]);
    expect(await store.getSyncState(SYNC_KEYS.lastFull)).toBe(String(NOW));
  });

  it("a server edit during a full resync keeps the moved bookmark and its opens row", async () => {
    const library = Array.from({ length: 150 }, (_, i) => bm(i + 1, i + 1));
    const store = new SqliteStore({ path, binary });
    await store.upsertPage(library);
    await store.recordOpen(140, 1000);
    const client = new FakeClient(library.map((b) => ({ ...b })));
    // After page 0, bookmark 140 (on page 2) changes, so it moves to page 0, which the run already read.
    client.afterPage = (page) => {
      if (page === 0) client.library.find((b) => b._id === 140)!.lastUpdate = new Date(NOW).toISOString();
    };
    const result = await runSync(client, store, { ...opts, full: true });
    expect(result.removed).toBe(0);
    expect(await store.getBookmark(140)).toBeDefined();
    const opens = await runProcess(binary, ["-json", path, "SELECT bookmark_id FROM opens;"]);
    expect(JSON.parse(opens.stdout)).toEqual([{ bookmark_id: 140 }]);
  });

  it("a server delete during a full resync keeps the bookmark that shifts up a page", async () => {
    const library = Array.from({ length: 150 }, (_, i) => bm(i + 1, i + 1));
    const store = new SqliteStore({ path, binary });
    await store.upsertPage(library);
    await store.recordOpen(51, 1000);
    const client = new FakeClient(library.map((b) => ({ ...b })));
    // After page 0, bookmark 1 (on page 0) goes away, so bookmark 51 shifts up into page 0.
    client.afterPage = (page) => {
      if (page === 0) client.library = client.library.filter((b) => b._id !== 1);
    };
    const result = await runSync(client, store, { ...opts, full: true });
    // Bookmark 1 was read before the delete, so a later sync removes it; this run removes nothing.
    expect(result.removed).toBe(0);
    expect(await store.getBookmark(51)).toBeDefined();
    const opens = await runProcess(binary, ["-json", path, "SELECT bookmark_id FROM opens;"]);
    expect(JSON.parse(opens.stdout)).toEqual([{ bookmark_id: 51 }]);
  });

  it("a full resync drops an unseen bookmark the server has in Trash", async () => {
    const store = new SqliteStore({ path, binary });
    await store.upsertPage([bm(1, 5), bm(2, 4)]);
    const client = new FakeClient([bm(1, 5)], [{ ...bm(2, 4), collection: { $id: -99 } }]);
    const result = await runSync(client, store, { ...opts, full: true });
    expect(result.removed).toBe(1);
    expect(await store.getBookmark(2)).toBeUndefined();
  });

  it("deleteIds counts only the rows it removed", async () => {
    const store = new SqliteStore({ path, binary });
    await store.upsertPage([bm(1, 5)], { syncState: { k: "v" } });
    expect(await store.deleteIds([1, 2])).toBe(1);
    expect(await store.getSyncState("k")).toBe("v");
  });
});

describe("sync text", () => {
  it("writes the HUD summary", () => {
    expect(syncSummary({ changed: 37, removed: 2 })).toBe("Synced 37 changes, 2 removed");
    expect(syncSummary({ changed: 1, removed: 0 })).toBe("Synced 1 change");
    expect(syncSummary({ changed: 0, removed: 0 })).toBe("Synced 0 changes");
  });

  it("writes the progress line", () => {
    expect(progressText(1250, 10_000)).toBe("Synced 1,250 of 10,000");
    expect(progressText(50)).toBe("Synced 50");
  });

  it("scales the full-resync estimate from the stored total", () => {
    expect(resyncEstimate(10_000)).toBe("Full resync: about 200 calls, 2 minutes");
    expect(resyncEstimate(100)).toBe("Full resync: about 6 calls, 1 minute");
    expect(resyncEstimate(undefined)).toBe("Full resync: it pages every bookmark");
  });

  it("tells when the store is stale and when a full resync is due", () => {
    expect(isStale(undefined, "1h", NOW)).toBe(true);
    expect(isStale(NOW - 30 * MIN, "1h", NOW)).toBe(false);
    expect(isStale(NOW - 61 * MIN, "1h", NOW)).toBe(true);
    expect(isStale(NOW - 5 * 60 * MIN, "6h", NOW)).toBe(false);
    expect(isStale(NOW - 23 * 60 * MIN, "1d", NOW)).toBe(false);
    expect(fullResyncDue(NOW - 8 * 1440 * MIN, NOW, NOW)).toBe(true);
    expect(fullResyncDue(NOW - 6 * 1440 * MIN, NOW, NOW)).toBe(false);
    expect(fullResyncDue(undefined, undefined, NOW)).toBe(false);
  });
});
