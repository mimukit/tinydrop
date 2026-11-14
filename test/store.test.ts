// Runs the real sqlite3 CLI. Skips with a printed reason when the binary is absent.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Raindrop } from "../src/api/types";
import { markLinkLive } from "../src/cleanup/manual";
import { runProcess } from "../src/store/run";
import { CHECKS_VERSION, SCHEMA_VERSION } from "../src/store/schema";
import { checkFeatures, defaultBinary, deleteDatabase, SqliteStore } from "../src/store/sqlite";
import { StoreFeatureError } from "../src/store/types";

const binary = defaultBinary();
const hasBinary = existsSync(binary);
if (!hasBinary) console.log(`Skipping the store tests: no sqlite3 binary at ${binary} (set TINYDROP_SQLITE3).`);

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

describe.skipIf(!hasBinary)("SqliteStore on the real sqlite3", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tinydrop-store-"));
    path = join(dir, "tinydrop.sqlite");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("finds an upserted bookmark by a prefix of its title, tag, note and highlight", async () => {
    const store = new SqliteStore({ path, binary });
    await store.upsertPage([
      bookmark(1, {
        title: "Rust ownership explained",
        tags: ["programming", "long read"],
        note: "it's a 'quoted' note -- with ; stuff",
        highlights: [{ _id: "h1", text: "borrow checker", note: "zebracorn" }],
      }),
      bookmark(2, { title: "Cooking pasta" }),
    ]);
    expect(await store.count()).toBe(2);
    expect((await store.search({ words: ["own"] })).map((r) => r.id)).toEqual([1]);
    expect((await store.search({ words: ["progr"] })).map((r) => r.id)).toEqual([1]);
    expect((await store.search({ words: ["zebra"] })).map((r) => r.id)).toEqual([1]);
    expect((await store.search({ words: ["past"] })).map((r) => r.id)).toEqual([2]);
    const [row] = await store.search({ words: ["rust", "borrow"] });
    expect(row).toMatchObject({
      id: 1,
      title: "Rust ownership explained",
      tags: ["programming", "long read"],
      note: "it's a 'quoted' note -- with ; stuff",
      highlights: [{ text: "borrow checker", note: "zebracorn" }],
    });
    expect(store.queryTimes()).toHaveLength(5);
  });

  it("updates a row on a second upsert and drops the old FTS text", async () => {
    const store = new SqliteStore({ path, binary });
    await store.upsertPage([bookmark(1, { title: "Old title" })]);
    await store.upsertPage([bookmark(1, { title: "New title\nsecond line" })]);
    expect(await store.count()).toBe(1);
    expect(await store.search({ words: ["old"] })).toEqual([]);
    expect((await store.getBookmark(1))?.title).toBe("New title\nsecond line");
  });

  it("treats hostile search words as plain text, with no SQL or FTS syntax error", async () => {
    const store = new SqliteStore({ path, binary });
    await store.upsertPage([bookmark(1, { title: "NEAR AND OR NOT" })]);
    for (const w of ['"', "*", "^", ":", "(", ")", "NEAR", "AND", "OR", "NOT", "'", "--", ";", "a'b", "x\ny"]) {
      await expect(store.search({ words: [w] })).resolves.toBeInstanceOf(Array);
    }
    expect((await store.search({ words: ["NEAR"] })).map((r) => r.id)).toEqual([1]);
    expect(await store.count()).toBe(1);
  });

  it("keeps the opens rows when the schema version changes, and drops the mirror tables", async () => {
    const store = new SqliteStore({ path, binary });
    await store.upsertPage([bookmark(1), bookmark(2)]);
    await store.recordOpen(1, 1000);
    await store.recordOpen(1, 2000);
    await store.setSyncState({ mark: "2026-11-01" });
    // Pretend an older build wrote this file.
    await store.setSyncState({ schema_version: String(SCHEMA_VERSION - 1) });

    const reopened = new SqliteStore({ path, binary });
    await reopened.open();
    expect(await reopened.count()).toBe(0);
    expect(await reopened.getSyncState("mark")).toBeUndefined();
    expect(await reopened.getSyncState("schema_version")).toBe(String(SCHEMA_VERSION));
    expect(await reopened.getSyncState("opens_version")).toBe("1");
    const opens = await runProcess(binary, ["-json", path, "SELECT bookmark_id, count, last_opened FROM opens;"]);
    expect(JSON.parse(opens.stdout)).toEqual([{ bookmark_id: 1, count: 2, last_opened: 2000 }]);
  });

  it("keeps the mirror tables when the schema version is the same", async () => {
    const store = new SqliteStore({ path, binary });
    await store.upsertPage([bookmark(1)]);
    const reopened = new SqliteStore({ path, binary });
    expect(await reopened.count()).toBe(1);
  });

  it("deletes a bookmark with its opens row", async () => {
    const store = new SqliteStore({ path, binary });
    await store.upsertPage([bookmark(1), bookmark(2)]);
    await store.recordOpen(1);
    await store.deleteIds([1]);
    expect((await store.topOpened()).map((r) => r.id)).toEqual([2]);
    const opens = await runProcess(binary, ["-json", path, "SELECT count(*) AS n FROM opens;"]);
    expect(JSON.parse(opens.stdout)).toEqual([{ n: 0 }]);
  });

  it("trashLocal moves a set of IDs to Trash and restoreLocal puts each back in its own collection", async () => {
    const store = new SqliteStore({ path, binary });
    await store.upsertPage([
      bookmark(1, { collection: { $id: 5 } }),
      bookmark(2, { collection: { $id: -1 } }),
      bookmark(3, { collection: { $id: 7 }, title: "Quokka" }),
      bookmark(4, { collection: { $id: 5 } }),
    ]);
    await store.trashLocal([1, 2, 3]);
    expect((await store.cleanupRows()).map((r) => r.id)).toEqual([4]);
    expect((await store.getBookmark(3))?.collectionId).toBe(-99);
    await store.restoreLocal([
      { id: 1, collectionId: 5 },
      { id: 2, collectionId: -1 },
      { id: 3, collectionId: 7 },
      { id: 99, collectionId: 7 },
    ]);
    const rows = await store.cleanupRows();
    expect(rows.map((r) => [r.id, r.collectionId])).toEqual([[1, 5], [2, -1], [3, 7], [4, 5]]);
    expect((await store.search({ words: ["quokka"] })).map((r) => r.id)).toEqual([3]);
    expect(await store.count()).toBe(4);
    await store.trashLocal([]);
    await store.restoreLocal([]);
  });

  it("cleanupRows reads every bookmark outside Trash with the keeper fields", async () => {
    const store = new SqliteStore({ path, binary });
    await store.upsertPage([
      bookmark(1, {
        link: "https://www.example.com/a/",
        title: "It's a 'title'",
        collection: { $id: 12 },
        important: true,
        tags: ["read", "dev"],
        note: "  four  ",
        highlights: [
          { _id: "h1", text: "one" },
          { _id: "h2", text: "two", note: "n" },
        ],
      }),
      bookmark(2, { note: "   " }),
      bookmark(3, { collection: { $id: -99 } }),
    ]);
    expect(await store.cleanupRows()).toEqual([
      {
        id: 1,
        link: "https://www.example.com/a/",
        title: "It's a 'title'",
        collectionId: 12,
        created: "2026-01-02T00:00:00.000Z",
        important: true,
        tags: ["read", "dev"],
        noteLength: 4,
        highlightCount: 2,
      },
      {
        id: 2,
        link: "https://example.com/2",
        title: "Bookmark 2",
        collectionId: -1,
        created: "2026-01-03T00:00:00.000Z",
        important: false,
        tags: [],
        noteLength: 0,
        highlightCount: 0,
      },
    ]);
  });

  it("findByHost finds the www. and bare host forms outside Trash", async () => {
    const store = new SqliteStore({ path, binary });
    await store.upsertPage([
      bookmark(1, { link: "https://www.example.com/a", domain: "www.example.com" }),
      bookmark(2, { link: "http://example.com/b", domain: "example.com" }),
      bookmark(3, { link: "https://example.com/c", collection: { $id: -99 } }),
      bookmark(4, { link: "https://other.org/d", domain: "other.org" }),
    ]);
    expect((await store.findByHost("example.com")).map((r) => r.id).sort()).toEqual([1, 2]);
  });

  it("keeps link_checks, ignored_hosts and checks_version through a mirror schema reset", async () => {
    const store = new SqliteStore({ path, binary });
    await store.upsertPage([bookmark(1)]);
    await store.saveLinkCheck({ bookmarkId: 1, url: "https://example.com/1", class: "ok", status: 200, reason: "HTTP 200", checkedAt: 5 });
    await store.addIgnoredHost("Blocked.Example.");
    expect(await store.getSyncState("checks_version")).toBe(String(CHECKS_VERSION));
    // A marker value: open() writes the key only when it is missing, so this proves the reset kept the stored value.
    await store.setSyncState({ schema_version: String(SCHEMA_VERSION - 1), checks_version: "kept" });

    const reopened = new SqliteStore({ path, binary });
    await reopened.open();
    expect(await reopened.count()).toBe(0);
    expect(await reopened.getSyncState("checks_version")).toBe("kept");
    expect(await reopened.ignoredHosts()).toEqual(["blocked.example"]);
    // The check waits for the next sync to bring its bookmark back.
    await reopened.upsertPage([bookmark(1)]);
    expect(await reopened.linkChecks()).toEqual([
      { bookmarkId: 1, url: "https://example.com/1", class: "ok", status: 200, reason: "HTTP 200", checkedAt: 5, title: "Bookmark 1" },
    ]);
  });

  it("saves, replaces and lists link checks, with pending retry fields", async () => {
    const store = new SqliteStore({ path, binary });
    await store.upsertPage([bookmark(1, { title: "It's 'quoted'" }), bookmark(2), bookmark(3, { collection: { $id: -99 } })]);
    await store.saveLinkCheck({
      bookmarkId: 1,
      url: "https://example.com/1",
      class: "pending",
      status: 404,
      reason: "HTTP 404, retry pending",
      checkedAt: 1000,
      firstDeadStatus: 404,
      firstDeadAt: 1000,
      retryDue: 121_000,
    });
    await store.saveLinkCheck({ bookmarkId: 2, url: "https://example.com/2", class: "unsure", reason: "network error: it's down", checkedAt: 2000 });
    await store.saveLinkCheck({ bookmarkId: 3, url: "https://example.com/3", class: "dead", status: 404, reason: "HTTP 404", checkedAt: 3000 });
    expect(await store.linkChecks()).toEqual([
      {
        bookmarkId: 1,
        url: "https://example.com/1",
        class: "pending",
        status: 404,
        reason: "HTTP 404, retry pending",
        checkedAt: 1000,
        firstDeadStatus: 404,
        firstDeadAt: 1000,
        retryDue: 121_000,
        title: "It's 'quoted'",
      },
      { bookmarkId: 2, url: "https://example.com/2", class: "unsure", reason: "network error: it's down", checkedAt: 2000, title: "Bookmark 2" },
    ]);
    await store.saveLinkCheck({ bookmarkId: 1, url: "https://example.com/1", class: "dead", status: 410, reason: "HTTP 410", checkedAt: 121_000 });
    expect((await store.linkChecks())[0]).toEqual({
      bookmarkId: 1,
      url: "https://example.com/1",
      class: "dead",
      status: 410,
      reason: "HTTP 410",
      checkedAt: 121_000,
      title: "It's 'quoted'",
    });
  });

  it("lists due work: missing, older than 30 days, changed URL, and pending retries", async () => {
    const day = 24 * 60 * 60 * 1000;
    const now = 100 * day;
    const store = new SqliteStore({ path, binary });
    await store.upsertPage([1, 2, 3, 4, 5, 6].map((id) => bookmark(id)).concat(bookmark(7, { collection: { $id: -99 } })));
    await store.saveLinkCheck({ bookmarkId: 2, url: "https://example.com/2", class: "ok", reason: "HTTP 200", checkedAt: now - day });
    await store.saveLinkCheck({ bookmarkId: 3, url: "https://example.com/3", class: "ok", reason: "HTTP 200", checkedAt: now - 31 * day });
    await store.saveLinkCheck({ bookmarkId: 4, url: "https://example.com/old-4", class: "dead", reason: "HTTP 404", checkedAt: now - day });
    await store.saveLinkCheck({
      bookmarkId: 5,
      url: "https://example.com/5",
      class: "pending",
      status: 404,
      reason: "HTTP 404, retry pending",
      checkedAt: now - 1000,
      firstDeadStatus: 404,
      firstDeadAt: now - 1000,
      retryDue: now + 119_000,
    });
    await store.saveLinkCheck({
      bookmarkId: 6,
      url: "https://example.com/old-6",
      class: "pending",
      reason: "HTTP 404, retry pending",
      checkedAt: now - 1000,
      firstDeadAt: now - 1000,
      retryDue: now + 119_000,
    });
    expect(await store.linkCheckWork(now)).toEqual([
      { id: 1, link: "https://example.com/1" },
      { id: 3, link: "https://example.com/3" },
      { id: 4, link: "https://example.com/4" },
      { id: 5, link: "https://example.com/5", pending: { firstDeadStatus: 404, firstDeadAt: now - 1000, retryDue: now + 119_000 } },
      { id: 6, link: "https://example.com/6" },
    ]);
  });

  it("persists a manual live decision and checks it again after 30 days or a URL change", async () => {
    const day = 24 * 60 * 60 * 1000;
    const now = 100 * day;
    const store = new SqliteStore({ path, binary });
    await store.upsertPage([bookmark(1)]);
    await store.saveLinkCheck({ bookmarkId: 1, url: "https://example.com/1", class: "unsure", status: 403, reason: "HTTP 403", checkedAt: 1 });
    expect(await markLinkLive(store, { bookmarkId: 1, url: "https://example.com/1" }, now)).toBe(true);
    const reopened = new SqliteStore({ path, binary });
    expect(await reopened.linkChecks()).toEqual([{
      bookmarkId: 1, url: "https://example.com/1", title: "Bookmark 1", class: "ok", reason: "Marked as live by you", checkedAt: now,
    }]);
    expect(await reopened.linkCheckWork(now + 29 * day)).toEqual([]);
    expect(await reopened.linkCheckWork(now + 31 * day)).toEqual([{ id: 1, link: "https://example.com/1" }]);
    await reopened.upsertPage([bookmark(1, { link: "https://example.com/new" })]);
    expect(await reopened.linkChecks()).toEqual([]);
    expect(await reopened.linkCheckWork(now + day)).toEqual([{ id: 1, link: "https://example.com/new" }]);
  });

  it("a changed bookmark URL invalidates its old check", async () => {
    const store = new SqliteStore({ path, binary });
    await store.upsertPage([bookmark(1), bookmark(2)]);
    await store.saveLinkCheck({ bookmarkId: 1, url: "https://example.com/1", class: "dead", status: 404, reason: "HTTP 404", checkedAt: 1 });
    await store.saveLinkCheck({ bookmarkId: 2, url: "https://example.com/2", class: "ok", reason: "HTTP 200", checkedAt: 1 });
    // A check of a bookmark the store does not hold (such as after a mirror reset) stays.
    await store.saveLinkCheck({ bookmarkId: 9, url: "https://example.com/9", class: "ok", reason: "HTTP 200", checkedAt: 1 });
    await store.upsertPage([bookmark(1, { link: "https://example.com/moved" })]);
    expect((await store.linkChecks()).map((r) => r.bookmarkId)).toEqual([2]);
    expect(await store.invalidateLinkChecks()).toBe(1);
    const rows = await runProcess(binary, ["-json", path, "SELECT bookmark_id FROM link_checks ORDER BY bookmark_id;"]);
    expect(JSON.parse(rows.stdout)).toEqual([{ bookmark_id: 2 }, { bookmark_id: 9 }]);
  });

  it("adds, lists and removes ignored hosts; removal frees the ignored-host skips for a recheck", async () => {
    const store = new SqliteStore({ path, binary });
    await store.upsertPage([bookmark(1)]);
    await store.addIgnoredHost(" Zeta.Example ");
    await store.addIgnoredHost("alpha.example");
    await store.addIgnoredHost("ALPHA.example.");
    await store.addIgnoredHost("o'brien.example");
    expect(await store.ignoredHosts()).toEqual(["alpha.example", "o'brien.example", "zeta.example"]);
    await store.saveLinkCheck({ bookmarkId: 1, url: "https://example.com/1", class: "skipped", reason: "ignored host", checkedAt: 1 });
    await store.removeIgnoredHost("Zeta.example");
    expect(await store.ignoredHosts()).toEqual(["alpha.example", "o'brien.example"]);
    expect(await store.linkChecks()).toEqual([]);
    expect((await store.linkCheckWork(2)).map((t) => t.id)).toEqual([1]);
  });

  it("runs in WAL mode", async () => {
    const store = new SqliteStore({ path, binary });
    await store.open();
    const r = await runProcess(binary, ["-json", path, "PRAGMA journal_mode;"]);
    expect(JSON.parse(r.stdout)).toEqual([{ journal_mode: "wal" }]);
  });

  it("deleteDatabase removes the file and its WAL files", async () => {
    const store = new SqliteStore({ path, binary });
    await store.upsertPage([bookmark(1)]);
    // A clean sqlite3 exit removes the WAL files, so make them as a crash would leave them.
    writeFileSync(`${path}-wal`, "");
    writeFileSync(`${path}-shm`, "");
    deleteDatabase(path);
    expect(existsSync(path) || existsSync(`${path}-wal`) || existsSync(`${path}-shm`)).toBe(false);
  });
});

describe("the feature check", () => {
  it("raises a StoreFeatureError that names FTS5 when the module is missing", async () => {
    const runner = async (_bin: string, args: string[]) =>
      args.some((a) => a.includes("fts5"))
        ? { status: 1, stdout: "", stderr: "Parse error: no such module: fts5" }
        : { status: 0, stdout: '[{"ok":1}]\n', stderr: "" };
    const error = await checkFeatures("/fake/no-fts5", runner).catch((e) => e);
    expect(error).toBeInstanceOf(StoreFeatureError);
    expect(error.feature).toBe("FTS5");
  });

  it("raises a StoreFeatureError that names -json when the option is unknown", async () => {
    const runner = async () => ({ status: 1, stdout: "", stderr: "sqlite3: Error: unknown option: -json" });
    const error = await checkFeatures("/fake/no-json", runner).catch((e) => e);
    expect(error).toBeInstanceOf(StoreFeatureError);
    expect(error.feature).toBe("-json");
  });

  it("raises a StoreFeatureError when the binary does not exist", async () => {
    const store = new SqliteStore({ path: join(tmpdir(), "never.sqlite"), binary: "/nonexistent/sqlite3" });
    const error = await store.open().catch((e) => e);
    expect(error).toBeInstanceOf(StoreFeatureError);
    expect(error.feature).toBe("a working binary");
  });
});
