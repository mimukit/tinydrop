import { describe, expect, it } from "vitest";
import { groupDuplicates } from "../src/cleanup/duplicates";
import {
  CLEANUP_VIEWS,
  applyKeepers,
  bulkDeadTargets,
  canIgnoreHost,
  checkRowText,
  checkToast,
  checkedAgo,
  cleanupDoneText,
  clockTime,
  deadConfirm,
  duplicateConfirm,
  duplicatePlan,
  groupText,
  hostOf,
  needsSyncFirst,
  trashConfirm,
  visibleChecks,
} from "../src/cleanup/view";
import type { CheckProgress } from "../src/cleanup/linkcheck";
import type { CleanupRow, LinkCheckListRow } from "../src/store/types";

const NOW = new Date(2026, 10, 14, 15, 0, 0).getTime();
const MIN = 60_000;

function row(id: number, link: string, over: Partial<CleanupRow> = {}): CleanupRow {
  return {
    id,
    link,
    title: `Bookmark ${id}`,
    collectionId: 12,
    created: `2026-01-0${id % 9 || 1}T00:00:00.000Z`,
    important: false,
    tags: [],
    noteLength: 0,
    highlightCount: 0,
    ...over,
  };
}

function check(id: number, url: string, cls: LinkCheckListRow["class"], over: Partial<LinkCheckListRow> = {}): LinkCheckListRow {
  return { bookmarkId: id, url, class: cls, reason: cls === "dead" ? "HTTP 404 on the first check and the retry" : "HTTP 403", checkedAt: NOW - 5 * MIN, title: `Check ${id}`, ...over };
}

const progress = (over: Partial<CheckProgress>): CheckProgress => ({ phase: "first", done: 0, total: 0, pendingRetries: 0, retryDone: 0, retryTotal: 0, ...over });

describe("cleanup views", () => {
  it("lists the five dropdown entries in plan order", () => {
    expect(CLEANUP_VIEWS.map((v) => v.title)).toEqual(["Duplicates", "Dead Links", "Unsure", "Skipped", "Ignored Hosts"]);
  });
});

describe("hosts", () => {
  it("reads a normalized http(s) host and nothing for other links", () => {
    expect(hostOf("https://WWW.Example.com./a")).toBe("www.example.com");
    expect(hostOf("ftp://example.com/x")).toBeUndefined();
    expect(hostOf("not a url")).toBeUndefined();
  });

  it("offers Ignore Host for a checked http(s) host, not for an exclusion skip", () => {
    expect(canIgnoreHost(check(1, "https://a.test/x", "dead"))).toBe(true);
    expect(canIgnoreHost(check(1, "https://a.test/x", "pending"))).toBe(true);
    expect(canIgnoreHost(check(1, "https://a.test/x", "unsure"))).toBe(true);
    expect(canIgnoreHost(check(1, "https://a.test/x", "skipped", { reason: "redirected to an excluded host (localhost)" }))).toBe(true);
    expect(canIgnoreHost(check(1, "http://localhost/x", "skipped", { reason: "localhost" }))).toBe(false);
    expect(canIgnoreHost(check(1, "ftp://a.test/x", "skipped", { reason: "not an http(s) link" }))).toBe(false);
  });
});

describe("visible checks", () => {
  const rows = [
    check(1, "https://a.test/1", "pending", { retryDue: NOW + 2 * MIN }),
    check(2, "https://a.test/2", "dead"),
    check(3, "https://b.test/3", "unsure"),
    check(4, "https://c.test/4", "skipped", { reason: "ignored host" }),
    check(5, "https://d.test/5", "ok", { reason: "HTTP 200" }),
    check(6, "https://ignored.test/6", "dead"),
  ];
  const ignored = new Set(["ignored.test", "c.test"]);

  it("shows dead then pending rows in Dead Links, and hides rows of ignored hosts", () => {
    expect(visibleChecks(rows, "dead", ignored).map((r) => r.bookmarkId)).toEqual([2, 1]);
    expect(visibleChecks(rows, "unsure", ignored).map((r) => r.bookmarkId)).toEqual([3]);
    expect(visibleChecks(rows, "skipped", ignored).map((r) => r.bookmarkId)).toEqual([]);
    expect(visibleChecks(rows, "skipped", new Set()).map((r) => r.bookmarkId)).toEqual([4]);
  });

  it("selects only class dead for Trash All Dead, with the current collection, never pending", () => {
    const store = [row(1, "https://a.test/1"), row(2, "https://a.test/2", { collectionId: -1 }), row(6, "https://ignored.test/6")];
    expect(bulkDeadTargets(rows, store, ignored)).toEqual([{ id: 2, collectionId: -1 }]);
  });

  it("leaves out a dead row whose bookmark is no longer in the store", () => {
    expect(bulkDeadTargets([check(9, "https://a.test/9", "dead")], [], new Set())).toEqual([]);
  });
});

describe("row text", () => {
  it("formats the clock time and the check age", () => {
    expect(clockTime(new Date(2026, 10, 14, 9, 5).getTime())).toBe("09:05");
    expect(checkedAgo(NOW - 20_000, NOW)).toBe("Checked just now");
    expect(checkedAgo(NOW - 5 * MIN, NOW)).toBe("Checked 5 min ago");
    expect(checkedAgo(NOW - 3 * 60 * MIN, NOW)).toBe("Checked 3 h ago");
    expect(checkedAgo(NOW - 2 * 24 * 60 * MIN, NOW)).toBe("Checked 2 days ago");
  });

  it("shows host, reason and check time, and Retry pending with its retry time", () => {
    expect(checkRowText(check(2, "https://a.test/2", "dead"), NOW)).toEqual({
      title: "Check 2",
      host: "a.test",
      reason: "HTTP 404 on the first check and the retry",
      time: "Checked 5 min ago",
    });
    const pending = checkRowText(check(1, "https://a.test/1", "pending", { reason: "HTTP 404, retry pending", retryDue: new Date(2026, 10, 14, 15, 2).getTime() }), NOW);
    expect(pending.reason).toBe("Retry pending");
    expect(pending.time).toBe("Retry after 15:02");
  });

  it("falls back to the URL for an empty title", () => {
    expect(checkRowText(check(2, "https://a.test/2", "dead", { title: "" }), NOW).title).toBe("https://a.test/2");
  });
});

describe("check toast", () => {
  it("shows first-pass progress and the pending retries", () => {
    expect(checkToast(progress({ done: 3, total: 10 }))).toEqual({ style: "animated", title: "Checking links", message: "3 of 10" });
    expect(checkToast(progress({ done: 3, total: 10, pendingRetries: 2 }))?.message).toBe("3 of 10 · 2 retries pending");
  });

  it("shows the waiting state with the earliest retry time", () => {
    const t = checkToast(progress({ phase: "waiting", done: 10, total: 10, pendingRetries: 1, nextRetryAt: new Date(2026, 10, 14, 15, 2).getTime() }));
    expect(t).toEqual({ style: "animated", title: "Waiting to retry 1 dead link", message: "Next retry at 15:02. Closing keeps it pending." });
  });

  it("shows the waiting state again when a retry ends and the next one is not due", () => {
    const due = new Date(2026, 10, 14, 15, 2).getTime();
    const p = progress({ phase: "retry", retryDone: 1, retryTotal: 2, pendingRetries: 1, nextRetryAt: due });
    expect(checkToast(p, NOW)?.title).toBe("Waiting to retry 1 dead link");
    expect(checkToast(p, due)?.title).toBe("Retrying dead links");
  });

  it("shows retry progress and the end", () => {
    expect(checkToast(progress({ phase: "retry", retryDone: 1, retryTotal: 3, pendingRetries: 2 }))).toEqual({ style: "animated", title: "Retrying dead links", message: "1 of 3" });
    expect(checkToast(progress({ phase: "done", done: 10, total: 10, retryDone: 2, retryTotal: 2 }))).toEqual({ style: "success", title: "Link check done", message: "10 checked, 2 retried" });
    expect(checkToast(progress({ phase: "done" }))).toEqual({ style: "success", title: "Link check done", message: "Nothing to check" });
    expect(checkToast(progress({ phase: "stopped" }))).toBeUndefined();
  });
});

describe("duplicate plan and confirmation", () => {
  const groups = groupDuplicates([
    row(1, "https://a.test/x", { important: true }),
    row(2, "https://a.test/x"),
    row(3, "https://a.test/x", { noteLength: 4 }),
    row(4, "https://b.test/y", { important: true }),
    row(5, "https://b.test/y", { highlightCount: 1 }),
  ]);

  it("skips annotated extras until the group is approved", () => {
    const plan = duplicatePlan(groups, new Set());
    expect(plan).toMatchObject({ count: 1, skippedAnnotated: 2 });
    expect(plan.groups.map((g) => g.key)).toEqual(["https://a.test/x"]);
    const approved = duplicatePlan(groups, new Set(["https://b.test/y"]));
    expect(approved).toMatchObject({ count: 2, skippedAnnotated: 1 });
  });

  it("names the count, the sync age and the tag-merge undo limit", () => {
    const c = duplicateConfirm(duplicatePlan(groups, new Set()), "Synced 2 h ago");
    expect(c.title).toBe("Move 1 duplicate to Trash?");
    expect(c.message).toContain("Synced 2 h ago.");
    expect(c.message).toContain("Undo puts the bookmarks back but leaves the merged tags on the keeper.");
    expect(c.message).toContain("2 extras with notes or highlights stay");
  });

  it("describes a group with its count, keeper and annotation state", () => {
    const [a, b] = groups;
    expect(groupText(a, new Set())).toEqual({ title: "Bookmark 1", host: "a.test", count: "3 bookmarks", annotated: "1 annotated" });
    expect(groupText(b, new Set([b.key])).annotated).toBe("1 annotated, approved");
    expect(groupText(groupDuplicates([row(7, "https://c.test/"), row(8, "https://c.test")])[0], new Set()).annotated).toBeUndefined();
  });

  it("applies the keeper the owner chose and ignores a stale choice", () => {
    const keepers = new Map([["https://a.test/x", 2], ["https://b.test/y", 99]]);
    const out = applyKeepers(groups, keepers);
    expect(out.map((g) => g.keeper.id)).toEqual([2, 4]);
  });
});

describe("other confirmations", () => {
  it("names the dead count and the sync age", () => {
    expect(deadConfirm(3, "Synced 5 min ago")).toEqual({
      title: "Move 3 dead links to Trash?",
      message: "Synced 5 min ago. Each one returned HTTP 404 or 410 on the check and on the retry. Undo with ⌘Z.",
    });
  });

  it("names one bookmark and the sync age", () => {
    expect(trashConfirm("Gone page", "Never synced")).toEqual({ title: "Move bookmark to Trash?", message: "Gone page. Never synced." });
  });

  it("reports a finished operation, and nothing for a partial one the writer reports", () => {
    expect(cleanupDoneText({ requested: 4, trashed: 4, failed: 0, unresolved: 0, skipped: 0 })).toBe("Moved 4 bookmarks to Trash");
    expect(cleanupDoneText({ requested: 1, trashed: 1, failed: 0, unresolved: 0, skipped: 0 })).toBe("Moved 1 bookmark to Trash");
    expect(cleanupDoneText({ requested: 0, trashed: 0, failed: 0, unresolved: 0, skipped: 0 })).toBe("Nothing to move");
    expect(cleanupDoneText({ requested: 4, trashed: 2, failed: 2, unresolved: 0, skipped: 0 })).toBeUndefined();
  });

  it("asks for Sync first when the last sync is an hour old or missing", () => {
    expect(needsSyncFirst(NOW - 59 * MIN, NOW)).toBe(false);
    expect(needsSyncFirst(NOW - 60 * MIN, NOW)).toBe(true);
    expect(needsSyncFirst(undefined, NOW)).toBe(true);
  });
});
