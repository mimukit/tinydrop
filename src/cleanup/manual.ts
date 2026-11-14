import type { BookmarkStore, LinkCheckListRow, LinkCheckStore } from "../store/types";

/** Record the owner's decision only for the bookmark URL they inspect. */
export async function markLinkLive(
  store: Pick<BookmarkStore, "getBookmark"> & Pick<LinkCheckStore, "saveLinkCheck">,
  check: Pick<LinkCheckListRow, "bookmarkId" | "url">,
  now: number = Date.now(),
): Promise<boolean> {
  const row = await store.getBookmark(check.bookmarkId);
  if (!row || row.collectionId === -99 || row.link !== check.url) return false;
  await store.saveLinkCheck({
    bookmarkId: row.id, url: row.link, class: "ok", reason: "Marked as live by you", checkedAt: now,
  });
  return true;
}
