// Text and selection rules for the Clean Up Bookmarks screen: the dropdown entries, the rows each
// view shows, the toast text of a link check, the bulk confirmations, and the result text.
// Pure: no @raycast/api import, so Vitest runs it in Node.
import { bulkTrashIds, withKeeper, type DuplicateGroup } from "./duplicates";
import { normalizeHost, type CheckProgress } from "./linkcheck";
import type { CleanupRow, CollectionMove, LinkCheckListRow } from "../store/types";
import { TRASH_COLLECTION } from "../api/types";

export type CleanupViewId = "duplicates" | "dead" | "unsure" | "skipped" | "ignored";

/** The dropdown entries, in plan order. */
export const CLEANUP_VIEWS: readonly { value: CleanupViewId; title: string }[] = [
  { value: "duplicates", title: "Duplicates" },
  { value: "dead", title: "Dead Links" },
  { value: "unsure", title: "Unsure" },
  { value: "skipped", title: "Skipped" },
  { value: "ignored", title: "Ignored Hosts" },
];

/** The views that list link checks. Opening one starts or resumes a check. */
export const CHECK_VIEWS: ReadonlySet<CleanupViewId> = new Set(["dead", "unsure", "skipped"]);

/** The age at which the screen puts Sync first as the first action. */
export const SYNC_FIRST_MS = 3_600_000;

export function needsSyncFirst(lastSync: number | undefined, now: number): boolean {
  return lastSync === undefined || now - lastSync >= SYNC_FIRST_MS;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The normalized host of an http(s) link, or undefined. */
export function hostOf(link: string): string | undefined {
  try {
    const u = new URL(link.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return normalizeHost(u.hostname) || undefined;
  } catch {
    return undefined;
  }
}

/** True when Ignore Host makes sense: the row has an http(s) host the checker sent a request to. */
export function canIgnoreHost(row: Pick<LinkCheckListRow, "url" | "class" | "reason">): boolean {
  if (!hostOf(row.url)) return false;
  return row.class !== "skipped" || row.reason.startsWith("redirected");
}

const CLASS_ORDER: Record<string, number> = { dead: 0, pending: 1 };

/**
 * The rows a check view lists. Dead Links lists `dead`, then `pending` (Retry pending). A row whose
 * host is on the ignore list is hidden, so Ignore Host takes effect at once.
 */
export function visibleChecks(rows: readonly LinkCheckListRow[], view: CleanupViewId, ignored: ReadonlySet<string>): LinkCheckListRow[] {
  const classes = view === "dead" ? ["dead", "pending"] : view === "unsure" ? ["unsure"] : view === "skipped" ? ["skipped"] : [];
  return rows
    .filter((r) => classes.includes(r.class))
    .filter((r) => {
      const host = hostOf(r.url);
      return !host || !ignored.has(host);
    })
    .sort((a, b) => (CLASS_ORDER[a.class] ?? 0) - (CLASS_ORDER[b.class] ?? 0) || a.bookmarkId - b.bookmarkId);
}

/** The targets of Trash All Dead: only class `dead` (never `pending`), visible, with the bookmark's current collection. */
export function bulkDeadTargets(rows: readonly LinkCheckListRow[], store: readonly CleanupRow[], ignored: ReadonlySet<string>): CollectionMove[] {
  const collection = new Map(store.map((r) => [r.id, r.collectionId]));
  return visibleChecks(rows, "dead", ignored)
    .filter((r) => r.class === "dead")
    .flatMap((r) => {
      const collectionId = collection.get(r.bookmarkId);
      return collectionId === undefined || collectionId === TRASH_COLLECTION ? [] : [{ id: r.bookmarkId, collectionId }];
    });
}

/** "09:05", local time. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function checkedAgo(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "Checked just now";
  if (minutes < 60) return `Checked ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Checked ${hours} h ago`;
  return `Checked ${plural(Math.floor(hours / 24), "day")} ago`;
}

/** The title, host, result reason and time of one checked bookmark. A pending row shows its retry time. */
export function checkRowText(row: LinkCheckListRow, now: number): { title: string; host: string; reason: string; time: string } {
  const host = hostOf(row.url) ?? "";
  if (row.class === "pending") {
    return { title: row.title || row.url, host, reason: "Retry pending", time: row.retryDue !== undefined ? `Retry after ${clockTime(row.retryDue)}` : checkedAgo(row.checkedAt, now) };
  }
  return { title: row.title || row.url, host, reason: row.reason, time: checkedAgo(row.checkedAt, now) };
}

export interface ToastText {
  style: "animated" | "success";
  title: string;
  message?: string;
}

/**
 * The toast of a link check run: first-pass progress, the waiting state, retry progress, the end.
 * The checker stays in `retry` after one retry ends; when the next one is not due yet, this shows
 * the waiting state again.
 */
export function checkToast(p: CheckProgress, now: number = Date.now()): ToastText | undefined {
  const phase = p.phase === "retry" && p.nextRetryAt !== undefined && p.nextRetryAt > now ? "waiting" : p.phase;
  switch (phase) {
    case "first":
      return {
        style: "animated",
        title: "Checking links",
        message: `${p.done} of ${p.total}${p.pendingRetries > 0 ? ` · ${plural(p.pendingRetries, "retry", "retries")} pending` : ""}`,
      };
    case "waiting":
      return {
        style: "animated",
        title: `Waiting to retry ${plural(p.pendingRetries, "dead link")}`,
        message: p.nextRetryAt !== undefined ? `Next retry at ${clockTime(p.nextRetryAt)}. Closing keeps it pending.` : undefined,
      };
    case "retry":
      return { style: "animated", title: "Retrying dead links", message: `${p.retryDone} of ${p.retryTotal}` };
    case "done": {
      if (p.total === 0 && p.retryTotal === 0) return { style: "success", title: "Link check done", message: "Nothing to check" };
      const parts = [`${p.total} checked`];
      if (p.retryTotal > 0) parts.push(`${p.retryDone} retried`);
      return { style: "success", title: "Link check done", message: parts.join(", ") };
    }
    default:
      return undefined;
  }
}

export interface DuplicatePlan {
  /** Bookmarks the operation sends to Trash. */
  count: number;
  /** Groups with at least one extra to trash. */
  groups: DuplicateGroup[];
  /** Annotated extras left out because their group is not approved. */
  skippedAnnotated: number;
}

/** What Trash Extras or Trash All Extras moves: annotated extras only in approved groups. */
export function duplicatePlan(groups: readonly DuplicateGroup[], approved: ReadonlySet<string>): DuplicatePlan {
  let count = 0;
  let skippedAnnotated = 0;
  const out: DuplicateGroup[] = [];
  for (const g of groups) {
    const ok = approved.has(g.key);
    const ids = bulkTrashIds(g, ok);
    if (!ok) skippedAnnotated += g.warnings.length;
    if (ids.length === 0) continue;
    count += ids.length;
    out.push(g);
  }
  return { count, groups: out, skippedAnnotated };
}

/** One confirmation per duplicate cleanup: the count, the sync age, and the tag-merge undo limit. */
export function duplicateConfirm(plan: DuplicatePlan, syncAge: string): { title: string; message: string } {
  const parts = [
    `${syncAge}.`,
    "Tags from the extras go to the keeper first.",
    "Undo puts the bookmarks back but leaves the merged tags on the keeper.",
  ];
  if (plan.skippedAnnotated > 0) {
    parts.push(`${plural(plan.skippedAnnotated, "extra")} with notes or highlights stay until you approve their group.`);
  }
  return { title: `Move ${plural(plan.count, "duplicate")} to Trash?`, message: parts.join(" ") };
}

/** The list text of one duplicate group. */
export function groupText(group: DuplicateGroup, approved: ReadonlySet<string>): { title: string; host: string; count: string; annotated?: string } {
  const n = group.warnings.length;
  return {
    title: group.keeper.title || group.keeper.link,
    host: hostOf(group.keeper.link) ?? group.key,
    count: plural(group.rows.length, "bookmark"),
    ...(n > 0 ? { annotated: `${n} annotated${approved.has(group.key) ? ", approved" : ""}` } : {}),
  };
}

/** The groups with the keeper the owner chose, where that bookmark is still in the group. */
export function applyKeepers(groups: readonly DuplicateGroup[], keepers: ReadonlyMap<string, number>): DuplicateGroup[] {
  return groups.map((g) => {
    const id = keepers.get(g.key);
    return id !== undefined && id !== g.keeper.id && g.rows.some((r) => r.id === id) ? withKeeper(g, id) : g;
  });
}

export function deadConfirm(count: number, syncAge: string): { title: string; message: string } {
  return {
    title: `Move ${plural(count, "dead link")} to Trash?`,
    message: `${syncAge}. Each one returned HTTP 404 or 410 on the check and on the retry. Undo with ⌘Z.`,
  };
}

export function trashConfirm(title: string, syncAge: string): { title: string; message: string } {
  return { title: "Move bookmark to Trash?", message: `${title}. ${syncAge}.` };
}

/** The success toast of a cleanup, or undefined when the writer already reported a partial result. */
export function cleanupDoneText(r: { requested: number; trashed: number; failed: number; unresolved: number; skipped: number }): string | undefined {
  if (r.failed + r.unresolved + r.skipped > 0) return undefined;
  if (r.trashed === 0) return "Nothing to move";
  return `Moved ${plural(r.trashed, "bookmark")} to Trash`;
}
