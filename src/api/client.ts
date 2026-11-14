// A typed client for the Raindrop REST API. Every call goes through one pacer
// (2 calls per second), every GET carries a `_=<timestamp>` nonce against the
// server cache, and a 429 waits for `X-RateLimit-Reset` before it tries again.
import { BulkGuardError, RaindropApiError } from "./errors";
import { MIN_GAP_MS, paceWaitMs, resetWaitMs, withNonce } from "./pace";
import { ALL_COLLECTION, TRASH_COLLECTION } from "./types";
import type {
  BulkReply,
  Collection,
  ItemReply,
  ItemsReply,
  Raindrop,
  RaindropPatch,
  Tag,
  User,
  UserReply,
} from "./types";

export const API_BASE = "https://api.raindrop.io/rest/v1";
export const WEB_BASE = "https://app.raindrop.io";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Keeps call starts at least `gapMs` apart. One pacer serves every client in a JS context. */
export class Pacer {
  private lastStart: number | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly gapMs: number = MIN_GAP_MS,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Resolves when the next call may start, and books that start. */
  next(): Promise<void> {
    const turn = this.chain.then(async () => {
      const wait = paceWaitMs(this.lastStart, this.now(), this.gapMs);
      if (wait > 0) await this.sleep(wait);
      this.lastStart = this.now();
    });
    this.chain = turn.catch(() => undefined);
    return turn;
  }
}

const sharedPacer = new Pacer();

/** The most IDs one bulk call carries. */
export const BULK_LIMIT = 100;

/**
 * Throws BulkGuardError for a bulk write the client must never send. A bulk write is any non-GET call
 * on `/raindrops/{collectionId}`. It needs 1 to 100 integer `ids` and no `search`, so it never touches
 * a whole collection. A DELETE to -99 deletes for good and a DELETE to 0 is unsupported: both are refused.
 */
export function assertSafeBulk(method: string, path: string, body: unknown): void {
  const match = /^\/raindrops\/(-?\d+)(?:[/?]|$)/.exec(path);
  if (!match || method === "GET") return;
  const collectionId = Number(match[1]);
  if (method === "DELETE" && (collectionId === TRASH_COLLECTION || collectionId === ALL_COLLECTION)) {
    throw new BulkGuardError(`Refused a bulk DELETE to collection ${collectionId}`);
  }
  const fields = (body ?? {}) as { ids?: unknown; search?: unknown };
  if ("search" in fields) throw new BulkGuardError("Refused a bulk call with a search");
  const ids = fields.ids;
  if (!Array.isArray(ids) || ids.length === 0) throw new BulkGuardError("Refused a bulk call without ids");
  if (ids.length > BULK_LIMIT) throw new BulkGuardError(`Refused a bulk call with ${ids.length} ids (at most ${BULK_LIMIT})`);
  if (!ids.every((id) => Number.isSafeInteger(id) && id > 0)) throw new BulkGuardError("Refused a bulk call with an invalid id");
}

export interface ClientOptions {
  fetch?: FetchLike;
  pacer?: Pacer;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
  /** Tries after a 429 before the error goes to the caller. */
  rateLimitRetries?: number;
}

export interface PageQuery {
  page?: number;
  perpage?: number;
  sort?: string;
  search?: string;
}

export class RaindropClient {
  private readonly fetchImpl: FetchLike;
  private readonly pacer: Pacer;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;
  private readonly rateLimitRetries: number;

  constructor(
    private readonly token: string,
    options: ClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.pacer = options.pacer ?? sharedPacer;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.baseUrl = options.baseUrl ?? API_BASE;
    this.rateLimitRetries = options.rateLimitRetries ?? 2;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    assertSafeBulk(method, path, body);
    for (let attempt = 0; ; attempt++) {
      await this.pacer.next();
      let url = `${this.baseUrl}${path}`;
      if (method === "GET") url = withNonce(url, this.now());
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 429 && attempt < this.rateLimitRetries) {
        await this.sleep(resetWaitMs(res.headers.get("x-ratelimit-reset"), this.now()));
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new RaindropApiError(res.status, path, text, res.headers.get("x-ratelimit-reset"));
      if (!text) return undefined as T;
      return JSON.parse(text) as T;
    }
  }

  async getUser(): Promise<User> {
    return (await this.request<UserReply>("GET", "/user")).user;
  }

  /** Reads page metadata without creating a bookmark. */
  async parseUrl(url: string): Promise<{ title: string; excerpt: string }> {
    const reply = await this.request<ItemReply<{ title?: string; excerpt?: string }>>("GET", `/import/url/parse?url=${encodeURIComponent(url)}`);
    if (!reply?.result || !reply.item) throw new Error("Could not read the page details");
    const title = typeof reply.item.title === "string" ? reply.item.title : "";
    const excerpt = typeof reply.item.excerpt === "string" ? reply.item.excerpt : "";
    if (!title && !excerpt) throw new Error("The page has no title or description");
    return { title, excerpt };
  }

  /** One page of bookmarks in a collection (0 = all, -1 = Unsorted, -99 = Trash). */
  async getRaindrops(collectionId: number, query: PageQuery = {}): Promise<ItemsReply<Raindrop>> {
    const params = new URLSearchParams();
    if (query.sort) params.set("sort", query.sort);
    params.set("perpage", String(query.perpage ?? 50));
    params.set("page", String(query.page ?? 0));
    if (query.search) params.set("search", query.search);
    const reply = await this.request<ItemsReply<Raindrop>>("GET", `/raindrops/${collectionId}?${params}`);
    return { ...reply, items: reply?.items ?? [] };
  }

  async getRaindrop(id: number): Promise<Raindrop> {
    return (await this.request<ItemReply<Raindrop>>("GET", `/raindrop/${id}`)).item;
  }

  async createRaindrop(patch: RaindropPatch): Promise<Raindrop> {
    return (await this.request<ItemReply<Raindrop>>("POST", "/raindrop", patch)).item;
  }

  async updateRaindrop(id: number, patch: RaindropPatch): Promise<Raindrop> {
    return (await this.request<ItemReply<Raindrop>>("PUT", `/raindrop/${id}`, patch)).item;
  }

  /** Moves a bookmark to Trash, or removes it for good when it is in Trash already. */
  async deleteRaindrop(id: number): Promise<void> {
    await this.request<unknown>("DELETE", `/raindrop/${id}`);
  }

  /**
   * Moves bookmarks to Trash: `DELETE /raindrops/{sourceCollectionId}` with `{ ids }`. Every ID must
   * be in that collection now. Never `0` (unsupported) or `-99` (that deletes for good).
   */
  async trashRaindrops(sourceCollectionId: number, ids: number[]): Promise<BulkReply> {
    return this.request<BulkReply>("DELETE", `/raindrops/${sourceCollectionId}`, { ids });
  }

  /** Brings bookmarks back from Trash: `PUT /raindrops/-99` with `{ ids, collection: { $id } }`. */
  async restoreRaindrops(toCollectionId: number, ids: number[]): Promise<BulkReply> {
    return this.request<BulkReply>("PUT", `/raindrops/${TRASH_COLLECTION}`, { ids, collection: { $id: toCollectionId } });
  }

  async getCollections(): Promise<Collection[]> {
    return (await this.request<ItemsReply<Collection>>("GET", "/collections"))?.items ?? [];
  }

  async getChildCollections(): Promise<Collection[]> {
    return (await this.request<ItemsReply<Collection>>("GET", "/collections/childrens"))?.items ?? [];
  }

  async getTags(collectionId = 0): Promise<Tag[]> {
    return (await this.request<ItemsReply<Tag>>("GET", `/tags/${collectionId}`))?.items ?? [];
  }
}
