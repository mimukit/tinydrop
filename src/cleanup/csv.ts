import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LinkCheckListRow } from "../store/types";
import { visibleChecks } from "./view";

/** Quote every cell and prevent bookmark text from becoming a spreadsheet formula. */
function cell(value: string | number | undefined): string {
  let text = value === undefined ? "" : String(value);
  if (/^\s*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** A snapshot of confirmed dead links, independent of the list's search filter. */
export function deadLinksCsv(rows: readonly LinkCheckListRow[], ignored: ReadonlySet<string>): { csv: string; count: number } {
  const dead = visibleChecks(rows, "dead", ignored).filter((row) => row.class === "dead");
  const records: (string | number | undefined)[][] = [["bookmark_id", "title", "url", "http_status", "reason", "checked_at"]];
  for (const row of dead) {
    records.push([row.bookmarkId, row.title, row.url, row.status, row.reason, new Date(row.checkedAt).toISOString()]);
  }
  // The BOM lets spreadsheet apps detect UTF-8 titles. CRLF separates CSV records.
  return { csv: `\uFEFF${records.map((record) => record.map(cell).join(",")).join("\r\n")}\r\n`, count: dead.length };
}

/** Save a new file without replacing an earlier export. An empty snapshot writes nothing. */
export function saveDeadLinksCsv(
  directory: string,
  rows: readonly LinkCheckListRow[],
  ignored: ReadonlySet<string>,
  now: number = Date.now(),
): { path: string; count: number } | undefined {
  const { csv, count } = deadLinksCsv(rows, ignored);
  if (count === 0) return undefined;
  mkdirSync(directory, { recursive: true });
  const name = `tinydrop-dead-links-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
  let path = join(directory, `${name}.csv`);
  for (let suffix = 2; existsSync(path); suffix++) path = join(directory, `${name}-${suffix}.csv`);
  writeFileSync(path, csv, "utf8");
  return { path, count };
}
