import { describe, expect, it, vi } from "vitest";
import { markLinkLive } from "../src/cleanup/manual";
import type { BookmarkRow, LinkCheckListRow } from "../src/store/types";

const check: LinkCheckListRow = {
  bookmarkId: 42, url: "https://example.com/page", title: "Example", class: "unsure", status: 403,
  reason: "HTTP 403", checkedAt: 1,
};

describe("mark a link as live", () => {
  it("saves an owner decision without inventing an HTTP status or retaining retry state", async () => {
    const store = {
      getBookmark: vi.fn().mockResolvedValue({ id: 42, link: check.url, collectionId: 11 } as BookmarkRow),
      saveLinkCheck: vi.fn().mockResolvedValue(undefined),
    };
    expect(await markLinkLive(store, check, 1234)).toBe(true);
    expect(store.getBookmark).toHaveBeenCalledWith(42);
    expect(store.saveLinkCheck).toHaveBeenCalledExactlyOnceWith({
      bookmarkId: 42, url: check.url, class: "ok", reason: "Marked as live by you", checkedAt: 1234,
    });
  });

  it.each([
    undefined,
    { id: 42, link: check.url, collectionId: -99 },
    { id: 42, link: "https://example.com/changed", collectionId: 11 },
  ])("does not mark a missing, trashed, or changed bookmark as live (%j)", async (row) => {
    const store = { getBookmark: vi.fn().mockResolvedValue(row), saveLinkCheck: vi.fn() };
    expect(await markLinkLive(store, check, 1234)).toBe(false);
    expect(store.saveLinkCheck).not.toHaveBeenCalled();
  });

  it("reports a save failure instead of claiming success", async () => {
    const store = {
      getBookmark: vi.fn().mockResolvedValue({ id: 42, link: check.url, collectionId: 11 }),
      saveLinkCheck: vi.fn().mockRejectedValue(new Error("disk full")),
    };
    await expect(markLinkLive(store, check, 1234)).rejects.toThrow("disk full");
  });
});
