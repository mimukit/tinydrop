// Runs the real sqlite3 CLI. Skips with a printed reason when the binary is absent.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Raindrop } from "../src/api/types";
import { runProcess } from "../src/store/run";
import { SCHEMA_VERSION } from "../src/store/schema";
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
