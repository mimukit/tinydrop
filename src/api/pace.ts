// Pure helpers for the request pacer and the cache nonce.
// Plain erasable TypeScript, so Node can load this file from scripts/probe.mjs
// through its built-in type stripping, and Phase 3's client can reuse it.

/** Gap between call starts for 2 calls per second. */
export const MIN_GAP_MS = 500;

/** Add `_=<now>` to a URL so the server cache does not answer it. Replaces an existing `_`. */
export function withNonce(url: string, now: number): string {
  const u = new URL(url);
  u.searchParams.set("_", String(now));
  return u.toString();
}

/** Milliseconds to wait before the next call, given the start time of the last call. */
export function paceWaitMs(lastStart: number | undefined, now: number, minGapMs: number = MIN_GAP_MS): number {
  if (lastStart === undefined) return 0;
  return Math.max(0, lastStart + minGapMs - now);
}

/**
 * Milliseconds to wait after a 429, from the `X-RateLimit-Reset` header.
 * Raindrop sends a Unix time in seconds. A small value is read as seconds from now.
 * A missing or bad header waits a fallback of 60 seconds.
 */
export function resetWaitMs(header: string | null | undefined, now: number, fallbackMs = 60_000): number {
  if (header === null || header === undefined || header.trim() === "") return fallbackMs;
  const n = Number(header);
  if (!Number.isFinite(n) || n < 0) return fallbackMs;
  const ms = n > 1_000_000_000 ? n * 1000 - now : n * 1000;
  return Math.max(0, Math.ceil(ms)) + 1000;
}

/** Page calls for a library: Raindrop pages hold at most 50 items. */
export function pagesFor(count: number, perPage = 50): number {
  return Math.ceil(count / perPage);
}

/** Scale a measured page pass to a library of `target` bookmarks, by page count. */
export function scaleByPages(elapsedMs: number, pages: number, target = 10_000, perPage = 50): number {
  if (pages <= 0) return 0;
  return (elapsedMs / pages) * pagesFor(target, perPage);
}
