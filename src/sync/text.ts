// Text and timing rules for the sync UI: the HUD summary, the progress line,
// the full-resync estimate, staleness and the 7-day reminder. No @raycast/api import.
import { pagesFor } from "../api/pace";
import type { SyncResult } from "./sync";

/** Calls a sync makes beside the bookmark pages: collections, children, user, tags. */
export const EXTRA_CALLS = 4;
/** Seconds per paced call, measured in Phase 1 (200 pages in 113.4 s). */
export const SECONDS_PER_CALL = 0.57;
export const FULL_RESYNC_DUE_MS = 7 * 86_400_000;

export const REFRESH_AGES = { "1h": 3_600_000, "6h": 6 * 3_600_000, "1d": 86_400_000 } as const;
export type RefreshAge = keyof typeof REFRESH_AGES;

const n = (value: number) => value.toLocaleString("en-US");
const plural = (count: number, word: string) => `${n(count)} ${word}${count === 1 ? "" : "s"}`;

/** "Synced 37 changes, 2 removed". */
export function syncSummary(result: Pick<SyncResult, "changed" | "removed">): string {
  const text = `Synced ${plural(result.changed, "change")}`;
  return result.removed > 0 ? `${text}, ${n(result.removed)} removed` : text;
}

/** "Synced 1,250 of 10,000", or "Synced 1,250" with no total. */
export function progressText(done: number, total?: number): string {
  return total !== undefined && total > 0 ? `Synced ${n(Math.min(done, total))} of ${n(total)}` : `Synced ${n(done)}`;
}

/** The confirmation text for a full resync, scaled from the stored bookmark total. */
export function resyncEstimate(total: number | undefined): string {
  if (total === undefined || !Number.isFinite(total) || total < 0) return "Full resync: it pages every bookmark";
  const exact = Math.max(1, pagesFor(total)) + EXTRA_CALLS;
  const calls = exact >= 100 ? Math.round(exact / 10) * 10 : exact;
  const minutes = Math.max(1, Math.round((exact * SECONDS_PER_CALL) / 60));
  return `Full resync: about ${n(calls)} calls, ${plural(minutes, "minute")}`;
}

/** Parses a stored ms timestamp; undefined when absent or bad. */
export function storedTime(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const t = Number(raw);
  return Number.isFinite(t) && t > 0 ? t : undefined;
}

/** True when the last sync is older than the age, or there was none. */
export function isStale(lastSync: number | undefined, age: RefreshAge | string | undefined, now: number): boolean {
  const ms = REFRESH_AGES[(age ?? "1d") as RefreshAge] ?? REFRESH_AGES["1d"];
  return lastSync === undefined || now - lastSync >= ms;
}

/** True when a library that has synced before last ran a full resync more than 7 days ago. */
export function fullResyncDue(lastFull: number | undefined, lastSync: number | undefined, now: number): boolean {
  if (lastSync === undefined) return false;
  return lastFull === undefined || now - lastFull > FULL_RESYNC_DUE_MS;
}

/** "9 days ago". */
export function daysAgo(then: number | undefined, now: number): string {
  if (then === undefined) return "never";
  const days = Math.floor((now - then) / 86_400_000);
  return days <= 0 ? "today" : `${plural(days, "day")} ago`;
}
