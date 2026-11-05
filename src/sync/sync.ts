// The incremental and full sync planners. They take a client and a store, so
// tests run them against fakes. No @raycast/api import here.
//
// Incremental: page `GET /raindrops/0?sort=-lastUpdate&perpage=50&page=N` and
// stop at the first page whose last row is not newer than the sync mark; then
// page the Trash search `GET /raindrops/-99?search=lastUpdate:>YYYY-MM-DD`
// (cutoff one day before the mark), dedupe by `_id` and drop those rows.
// Full: page every bookmark and delete the IDs the server no longer has.
// Both then refresh `/collections`, `/collections/childrens`, `/user` and `/tags/0`.
//
// Each page and the resume point go to the store in one transaction. A 429
// waits for `X-RateLimit-Reset` and the run goes on from the last stored page;
// a run that stops (crash, closed window) goes on from there next time.
import type { RaindropClient } from "../api/client";
import { RaindropApiError } from "../api/errors";
import { resetWaitMs } from "../api/pace";
import { ALL_COLLECTION, TRASH_COLLECTION, type Collection, type Raindrop, type User } from "../api/types";
import { collectionRow, tagRow, type BookmarkStore, type CollectionRow } from "../store/types";

export type SyncClient = Pick<RaindropClient, "getRaindrops" | "getCollections" | "getChildCollections" | "getUser" | "getTags">;
export type SyncStore = Pick<
  BookmarkStore,
  "upsertPage" | "deleteIds" | "clearSeen" | "deleteUnseen" | "replaceCollections" | "replaceTags" | "getSyncState" | "setSyncState"
>;

/** `sync_state` keys the planner owns. */
export const SYNC_KEYS = {
  /** The `lastUpdate` of the newest bookmark the last finished sync saw (ISO text). */
  mark: "sync_mark",
  /** The resume point of a run in progress (JSON of RunState), or "" when none. */
  run: "sync_run",
  /** When the last sync finished (ms since epoch). */
  lastSync: "last_sync",
  /** When the last full resync finished (ms since epoch). */
  lastFull: "last_full_sync",
  /** The bookmark count the server reported in the last run. */
  total: "bookmark_total",
} as const;

export const PER_PAGE = 50;
export const SORT = "-lastUpdate";
const DAY_MS = 86_400_000;
/** 429 waits in one run before the error goes to the caller. */
export const MAX_RATE_LIMIT_WAITS = 5;

export type SyncKind = "incremental" | "full";

/** The resume point. `page` is the next page to fetch. */
export interface RunState {
  kind: SyncKind;
  page: number;
  /** The sync mark the incremental run compares with. */
  mark?: string;
  /** The mark this run stores when it finishes: the newest `lastUpdate` on page 0. */
  newMark?: string;
  changed: number;
  total?: number;
}

export interface SyncProgress {
  kind: SyncKind;
  done: number;
  total?: number;
}

export interface SyncResult {
  kind: SyncKind;
  changed: number;
  removed: number;
  total?: number;
  /** True when the run went on from a stored resume point. */
  resumed: boolean;
}

export interface SyncOptions {
  /** Run a full resync. A first sync (no mark) is always full. */
  full?: boolean;
  onProgress?: (progress: SyncProgress) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function timeOf(item: Raindrop): number {
  const t = item.lastUpdate ? Date.parse(item.lastUpdate) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function parseRun(raw: string | undefined): RunState | undefined {
  if (!raw) return undefined;
  try {
    const run = JSON.parse(raw) as RunState;
    if ((run.kind === "full" || run.kind === "incremental") && Number.isInteger(run.page) && run.page >= 0) return run;
  } catch {
    // A broken resume point starts a new run.
  }
  return undefined;
}

/** The Trash search cutoff: the UTC day before the mark, as YYYY-MM-DD. */
export function trashCutoff(mark: string): string {
  const t = Date.parse(mark);
  if (!Number.isFinite(t)) throw new Error(`Bad sync mark: ${mark}`);
  return new Date(t - DAY_MS).toISOString().slice(0, 10);
}

/** The later of two ISO times; undefined counts as the earliest. */
function laterMark(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/** Store rows for the collections, with the `user.groups` title and order on each root. */
export function collectionRows(roots: Collection[], children: Collection[], user: User): CollectionRow[] {
  const groups = (user.groups ?? [])
    .map((g, index) => ({ g, index }))
    .sort((a, b) => (a.g.sort ?? a.index) - (b.g.sort ?? b.index) || a.index - b.index);
  const place = new Map<number, { group: string; groupOrder: number }>();
  groups.forEach(({ g }, gi) => g.collections.forEach((id, ci) => place.set(id, { group: g.title, groupOrder: gi * 10_000 + ci })));
  return [
    ...roots.map((c) => ({ ...collectionRow(c), ...(place.get(c._id) ?? {}) })),
    ...children.map(collectionRow),
  ];
}

/** Runs one sync. Throws the API error (a 401 included) after it stores what it has. */
export async function runSync(client: SyncClient, store: SyncStore, options: SyncOptions = {}): Promise<SyncResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let waits = 0;
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (;;) {
      try {
        return await fn();
      } catch (error) {
        if (error instanceof RaindropApiError && error.isRateLimit && waits < MAX_RATE_LIMIT_WAITS) {
          waits += 1;
          await sleep(resetWaitMs(error.rateLimitReset, now()));
          continue;
        }
        throw error;
      }
    }
  };

  const mark = (await store.getSyncState(SYNC_KEYS.mark)) || undefined;
  let run = parseRun(await store.getSyncState(SYNC_KEYS.run));
  // A full resync asked for while an incremental run waits to resume replaces it.
  if (run && options.full && run.kind === "incremental") run = undefined;
  // An incremental run cannot resume without the mark it compares with.
  if (run?.kind === "incremental" && !run.mark) run = undefined;
  const resumed = run !== undefined;
  if (!run) {
    const kind: SyncKind = options.full || !mark ? "full" : "incremental";
    run = { kind, page: 0, changed: 0, ...(kind === "incremental" ? { mark } : {}) };
    if (kind === "full") await store.clearSeen();
    await store.setSyncState({ [SYNC_KEYS.run]: JSON.stringify(run) });
  }
  const state = run;
  const markMs = state.mark ? Date.parse(state.mark) : 0;

  // Bookmark pages, newest change first.
  for (;;) {
    const reply = await call(() => client.getRaindrops(ALL_COLLECTION, { sort: SORT, perpage: PER_PAGE, page: state.page }));
    const items = reply.items ?? [];
    if (typeof reply.count === "number") state.total = reply.count;
    if (state.page === 0 && items[0]) state.newMark = laterMark(state.newMark, items[0].lastUpdate);
    let done: boolean;
    if (state.kind === "incremental") {
      const fresh = items.filter((i) => timeOf(i) > markMs);
      const last = items.at(-1);
      done = items.length < PER_PAGE || !last || timeOf(last) <= markMs;
      state.changed += fresh.length;
      state.page += 1;
      await store.upsertPage(fresh, { syncState: { [SYNC_KEYS.run]: JSON.stringify(state) } });
    } else {
      done = items.length < PER_PAGE;
      state.changed += items.length;
      state.page += 1;
      await store.upsertPage(items, { seen: true, syncState: { [SYNC_KEYS.run]: JSON.stringify(state) } });
    }
    options.onProgress?.({ kind: state.kind, done: state.changed, total: state.kind === "full" ? state.total : undefined });
    if (done) break;
  }

  // Drop what the server no longer has.
  let removed: number;
  if (state.kind === "full") {
    removed = await store.deleteUnseen();
  } else {
    const search = `lastUpdate:>${trashCutoff(state.mark as string)}`;
    const trashed = new Set<number>();
    for (let page = 0; ; page++) {
      const reply = await call(() => client.getRaindrops(TRASH_COLLECTION, { perpage: PER_PAGE, page, search }));
      const items = reply.items ?? [];
      for (const item of items) trashed.add(item._id);
      if (items.length < PER_PAGE) break;
    }
    removed = await store.deleteIds([...trashed]);
  }

  // Collections, groups and tags.
  const roots = await call(() => client.getCollections());
  const children = await call(() => client.getChildCollections());
  const user = await call(() => client.getUser());
  const tags = await call(() => client.getTags(ALL_COLLECTION));
  await store.replaceCollections(collectionRows(roots, children, user));
  await store.replaceTags(tags.map(tagRow));

  const finished = String(Math.trunc(now()));
  await store.setSyncState({
    [SYNC_KEYS.mark]: laterMark(state.mark, state.newMark) ?? new Date(0).toISOString(),
    [SYNC_KEYS.run]: "",
    [SYNC_KEYS.lastSync]: finished,
    ...(state.kind === "full" ? { [SYNC_KEYS.lastFull]: finished } : {}),
    ...(state.total !== undefined ? { [SYNC_KEYS.total]: String(state.total) } : {}),
  });
  return { kind: state.kind, changed: state.changed, removed, total: state.total, resumed };
}
