import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deadLinksCsv, saveDeadLinksCsv } from "../src/cleanup/csv";
import type { LinkCheckListRow } from "../src/store/types";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const row = (bookmarkId: number, over: Partial<LinkCheckListRow> = {}): LinkCheckListRow => ({
  bookmarkId, title: "Old page", url: `https://example.com/${bookmarkId}`, class: "dead",
  status: 404, reason: "HTTP 404 on the first check and the retry", checkedAt: NOW, ...over,
});
const dirs: string[] = [];
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), "tinydrop-csv-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("dead-link CSV", () => {
  it("exports confirmed dead links in ID order, excluding pending retries and ignored hosts", () => {
    const result = deadLinksCsv([
      row(3, { status: 410 }), row(2, { class: "pending" }), row(1),
      row(4, { class: "unsure" }), row(5, { class: "ok" }), row(6, { class: "skipped" }),
      row(7, { url: "https://ignored.test/x" }),
    ], new Set(["ignored.test"]));
    expect(result.count).toBe(2);
    expect(result.csv).toBe('\uFEFF"bookmark_id","title","url","http_status","reason","checked_at"\r\n' +
      '"1","Old page","https://example.com/1","404","HTTP 404 on the first check and the retry","2026-11-14T12:00:00.000Z"\r\n' +
      '"3","Old page","https://example.com/3","410","HTTP 404 on the first check and the retry","2026-11-14T12:00:00.000Z"\r\n');
  });

  it("escapes commas, quotes, newlines and Unicode, and neutralizes spreadsheet formulas", () => {
    const { csv } = deadLinksCsv([
      row(1, { title: 'বাংলা, "title"\nnext', reason: '=HYPERLINK("bad")', status: undefined }),
      row(2, { title: " \t+SUM(1,2)" }), row(3, { title: "-1+2" }), row(4, { title: "@SUM(1)" }),
      row(5, { title: "\tformula" }), row(6, { title: "\rformula" }),
    ], new Set());
    expect(csv).toContain('"বাংলা, ""title""\nnext"');
    expect(csv).toContain('"","\'=HYPERLINK(""bad"")"');
    for (const title of [" \t+SUM(1,2)", "-1+2", "@SUM(1)", "\tformula", "\rformula"]) {
      expect(csv).toContain(`"'${title}"`);
    }
  });

  it("does not create a file when no confirmed dead links exist", () => {
    const dir = directory();
    expect(saveDeadLinksCsv(dir, [row(1, { class: "pending" })], new Set(), NOW)).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("writes UTF-8 files and preserves earlier exports with the same timestamp", () => {
    const dir = directory();
    const first = saveDeadLinksCsv(dir, [row(1)], new Set(), NOW)!;
    const second = saveDeadLinksCsv(dir, [row(2)], new Set(), NOW)!;
    expect(first.count).toBe(1);
    expect(second.path).not.toBe(first.path);
    expect(readFileSync(first.path, "utf8")).toBe(deadLinksCsv([row(1)], new Set()).csv);
    expect(readFileSync(second.path, "utf8")).toBe(deadLinksCsv([row(2)], new Set()).csv);
  });

  it("reports a filesystem failure to the caller", () => {
    const file = join(directory(), "file");
    writeFileSync(file, "occupied");
    expect(() => saveDeadLinksCsv(file, [row(1)], new Set(), NOW)).toThrow();
  });
});
