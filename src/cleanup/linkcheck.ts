// Dead-link checks for the cleanup command: host exclusions, response classes, and the
// resumable checker. Pure: the fetch function and the clock come in from the caller.
// No @raycast/api import.
//
// Tinycast facts (docs/research/0002-research-cleanup-api-runtime-2026-11-14.md):
// - fetch follows redirects natively; `response.url` is the final URL, `redirected` is always false.
// - AbortSignal does not end a native request, so the 10-second timeout is a timer race.
// - DNS and TLS errors arrive as a localized message only, so a thrown error is never `dead`.
import type { LinkCheckRow, LinkCheckTarget } from "../store/types";

/** The result classes the checker reports. */
export type LinkClass = "ok" | "dead" | "unsure" | "skipped";

export interface Classification {
  class: LinkClass;
  status?: number;
  reason: string;
}

/** The Safari User-Agent the research file settles on. */
export const SAFARI_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15";

/** A hostname as the ignore list stores it: trimmed, lowercase, with no trailing dot. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, "");
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function privateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** The eight 16-bit groups of an IPv6 literal (no brackets), or undefined. WHATWG URL writes hex groups only. */
function ipv6Groups(text: string): number[] | undefined {
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const part = (s: string) => (s === "" ? [] : s.split(":").map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN)));
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return undefined;
  const groups = [...head, ...Array<number>(fill).fill(0), ...rest];
  return groups.every((g) => !Number.isNaN(g)) ? groups : undefined;
}

function privateIPv6(host: string): boolean {
  if (!host.startsWith("[") || !host.endsWith("]")) return false;
  const g = ipv6Groups(host.slice(1, -1));
  if (!g) return false;
  if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    // ::ffff:a.b.c.d, an IPv4-mapped address
    return privateIPv4(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
  }
  return false;
}

/**
 * Why the checker must not send a request to this URL, or undefined when it may. Literal hosts
 * only: a public name that resolves to a private address cannot be seen from the runtime.
 */
export function excludedReason(url: string, ignoredHosts: ReadonlySet<string>): string | undefined {
  const u = parseUrl(url.trim());
  if (!u) return "invalid link";
  if (u.protocol !== "http:" && u.protocol !== "https:") return "not an http(s) link";
  const host = normalizeHost(u.hostname);
  if (!host) return "invalid link";
  if (host === "localhost" || host.endsWith(".localhost")) return "localhost";
  if (privateIPv4(host) || privateIPv6(host)) return "private address";
  if (host.endsWith(".local")) return ".local host";
  if (ignoredHosts.has(host)) return "ignored host";
  return undefined;
}

/** The host without `www.`, so http://example.com and https://www.example.com count as one site. */
function siteOf(u: URL): string {
  return normalizeHost(u.hostname).replace(/^www\./, "");
}

const isRoot = (u: URL) => u.pathname === "" || u.pathname === "/";

/** The class of one final HTTP response, per the plan's Result rules and the redirect decisions. */
export function classifyResponse(
  requestUrl: string,
  response: { status: number; url: string },
  ignoredHosts: ReadonlySet<string>,
): Classification {
  const status = response.status;
  const finalText = (response.url ?? "").trim();
  if (!finalText) return { class: "unsure", status, reason: "no final URL" };
  const excluded = excludedReason(finalText, ignoredHosts);
  if (excluded) return { class: "skipped", status, reason: `redirected to an excluded host (${excluded})` };
  const from = parseUrl(requestUrl.trim());
  const to = parseUrl(finalText);
  const redirected = !!from && !!to && from.href !== to.href;
  if (redirected && from && to && !isRoot(from) && isRoot(to) && siteOf(from) === siteOf(to)) {
    return { class: "unsure", status, reason: "redirected to the home page" };
  }
  const label = `HTTP ${status}`;
  if (status === 404 || status === 410) return { class: "dead", status, reason: label };
  if (status >= 200 && status <= 299) {
    return { class: "ok", status, reason: redirected && to ? `${label} after a redirect to ${to.href}` : label };
  }
  return { class: "unsure", status, reason: label };
}

// ─── The checker ────────────────────────────────────────────────────

/** The part of a fetch Response the checker reads. */
export interface FetchResult {
  status: number;
  /** The final URL after native redirects. */
  url: string;
}

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<FetchResult>;

/** Time for the checker. `setTimer` resolves no promise itself; it returns a cancel function. */
export interface CheckClock {
  now(): number;
  setTimer(fn: () => void, ms: number): () => void;
}

export const systemClock: CheckClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
};

export const MAX_IN_FLIGHT = 6;
export const REQUEST_TIMEOUT_MS = 10_000;
export const RETRY_DELAY_MS = 2 * 60_000;

/** The run state for the toast. */
export interface CheckProgress {
  /** `first`: the first pass. `waiting`: first pass done, retries wait for their due time. `retry`: a retry runs. */
  phase: "first" | "waiting" | "retry" | "done" | "stopped";
  /** First-pass bookmarks with a result, and all first-pass bookmarks. */
  done: number;
  total: number;
  /** Retries not yet finished: first dead results of this run plus resumed pending retries. */
  pendingRetries: number;
  /** The earliest due time of a retry not yet started. */
  nextRetryAt?: number;
  /** Finished retries, and all retries of this run. */
  retryDone: number;
  retryTotal: number;
}

export interface LinkCheckerOptions {
  /** Default: the global fetch. */
  fetch?: FetchFn;
  /** Default: Date.now and setTimeout. */
  clock?: CheckClock;
  /** Hosts to skip, normalized here. */
  ignoredHosts?: Iterable<string>;
  /** Called with each result as it arrives, in order. The checker waits for each call before the next. */
  save: (row: LinkCheckRow) => void | Promise<void>;
  onProgress?: (progress: CheckProgress) => void;
  /** Called when `save` throws. Without it, run() rejects with the first save error at its end. */
  onSaveError?: (error: unknown) => void;
  maxInFlight?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
}

type Outcome = { kind: "response"; result: FetchResult } | { kind: "error"; message: string } | { kind: "timeout" } | { kind: "stopped" };

const STOPPED: Outcome = { kind: "stopped" };

/**
 * One run over a list of targets. The first pass sends HEAD, then a one-byte GET on 405, 501 or a
 * thrown error. A first dead result is saved as `pending` with a retry due `retryDelayMs` later;
 * after the first pass the checker sends the GET retry for each pending item when it is due.
 * Both dead makes `dead`; otherwise the retry's class stands. At most `maxInFlight` requests
 * run at once, and one per host.
 */
export class LinkChecker {
  private readonly fetchFn: FetchFn;
  private readonly clock: CheckClock;
  private readonly ignored: Set<string>;
  private readonly opts: LinkCheckerOptions;
  private readonly maxInFlight: number;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;

  private inFlight = 0;
  private readonly busyHosts = new Set<string>();
  private waiters: { host: string; start: (ok: boolean) => void }[] = [];
  private readonly cancels = new Set<() => void>();
  private saving: Promise<void> = Promise.resolve();
  private saveError: unknown;
  private stoppedFlag = false;
  private progress: CheckProgress = { phase: "first", done: 0, total: 0, pendingRetries: 0, retryDone: 0, retryTotal: 0 };
  private readonly retryDue = new Map<number, number>();

  constructor(options: LinkCheckerOptions) {
    this.opts = options;
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
    this.clock = options.clock ?? systemClock;
    this.ignored = new Set([...(options.ignoredHosts ?? [])].map(normalizeHost));
    this.maxInFlight = options.maxInFlight ?? MAX_IN_FLIGHT;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  }

  get stopped(): boolean {
    return this.stoppedFlag;
  }

  /** Ends the run: queued requests never start, timers stop, and late results are dropped. */
  stop(): void {
    if (this.stoppedFlag) return;
    this.stoppedFlag = true;
    for (const cancel of [...this.cancels]) cancel();
    this.cancels.clear();
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.start(false);
    this.emit({ phase: "stopped" });
  }

  /** Checks the targets and resolves with the last progress when every result is saved, or on stop. */
  async run(targets: LinkCheckTarget[]): Promise<CheckProgress> {
    const fresh = targets.filter((t) => !t.pending);
    const resumed = targets.filter((t) => t.pending);
    for (const t of resumed) this.retryDue.set(t.id, t.pending!.retryDue);
    this.emit({ phase: "first", done: 0, total: fresh.length, retryTotal: resumed.length });

    const retries: LinkCheckTarget[] = [...resumed];
    await Promise.all(
      fresh.map(async (target) => {
        const pending = await this.firstPass(target);
        if (pending) retries.push(pending);
      }),
    );
    if (!this.stoppedFlag && retries.length > 0) {
      this.emit({ phase: "waiting" });
      await Promise.all(retries.map((t) => this.retry(t)));
    }
    await this.saving;
    if (this.stoppedFlag) return this.progress;
    this.emit({ phase: "done" });
    if (this.saveError !== undefined && !this.opts.onSaveError) throw this.saveError;
    return this.progress;
  }

  private emit(patch: Partial<CheckProgress>): void {
    const pending = [...this.retryDue.values()];
    this.progress = {
      ...this.progress,
      ...patch,
      pendingRetries: pending.length,
      nextRetryAt: pending.length > 0 ? Math.min(...pending) : undefined,
    };
    if (this.progress.nextRetryAt === undefined) delete this.progress.nextRetryAt;
    this.opts.onProgress?.({ ...this.progress });
  }

  private save(row: LinkCheckRow): void {
    if (this.stoppedFlag) return;
    this.saving = this.saving.then(async () => {
      try {
        await this.opts.save(row);
      } catch (error) {
        if (this.opts.onSaveError) this.opts.onSaveError(error);
        else if (this.saveError === undefined) this.saveError = error;
      }
    });
  }

  /** Returns the target as a pending retry when the first result is dead. */
  private async firstPass(target: LinkCheckTarget): Promise<LinkCheckTarget | undefined> {
    const excluded = excludedReason(target.link, this.ignored);
    let result: Classification;
    if (excluded) {
      result = { class: "skipped", reason: excluded };
    } else {
      let outcome = await this.request(target.link, "HEAD");
      if (outcome.kind === "error" || (outcome.kind === "response" && (outcome.result.status === 405 || outcome.result.status === 501))) {
        outcome = await this.request(target.link, "GET");
      }
      if (outcome.kind === "stopped") return undefined;
      result = this.classify(target.link, outcome);
    }
    if (this.stoppedFlag) return undefined;
    const now = this.clock.now();
    let pending: LinkCheckTarget | undefined;
    if (result.class === "dead") {
      const retryDue = now + this.retryDelayMs;
      pending = { id: target.id, link: target.link, pending: { firstDeadStatus: result.status, firstDeadAt: now, retryDue } };
      this.retryDue.set(target.id, retryDue);
      this.save({
        bookmarkId: target.id,
        url: target.link,
        class: "pending",
        status: result.status,
        reason: `${result.reason}, retry pending`,
        checkedAt: now,
        firstDeadStatus: result.status,
        firstDeadAt: now,
        retryDue,
      });
    } else {
      this.save(this.row(target, result, now));
    }
    this.emit({ done: this.progress.done + 1, ...(pending ? { retryTotal: this.progress.retryTotal + 1 } : {}) });
    return pending;
  }

  private async retry(target: LinkCheckTarget): Promise<void> {
    const due = target.pending!.retryDue;
    const wait = due - this.clock.now();
    if (wait > 0 && !(await this.sleep(wait))) return;
    if (this.stoppedFlag) return;
    if (this.progress.phase !== "retry") this.emit({ phase: "retry" });
    const excluded = excludedReason(target.link, this.ignored);
    let result: Classification;
    if (excluded) {
      result = { class: "skipped", reason: excluded };
    } else {
      const outcome = await this.request(target.link, "GET");
      if (outcome.kind === "stopped" || this.stoppedFlag) return;
      result = this.classify(target.link, outcome);
      if (result.class === "dead") result = { ...result, reason: `${result.reason} on the first check and the retry` };
    }
    this.retryDue.delete(target.id);
    this.save(this.row(target, result, this.clock.now()));
    this.emit({ retryDone: this.progress.retryDone + 1 });
  }

  private row(target: LinkCheckTarget, result: Classification, now: number): LinkCheckRow {
    return {
      bookmarkId: target.id,
      url: target.link,
      class: result.class,
      ...(result.status !== undefined ? { status: result.status } : {}),
      reason: result.reason,
      checkedAt: now,
    };
  }

  private classify(url: string, outcome: Outcome): Classification {
    if (outcome.kind === "response") return classifyResponse(url, outcome.result, this.ignored);
    if (outcome.kind === "timeout") return { class: "unsure", reason: "timeout" };
    if (outcome.kind === "error") return { class: "unsure", reason: `network error: ${outcome.message}` };
    return { class: "unsure", reason: "stopped" };
  }

  /** Resolves true after `ms`, or false when the run stops first. */
  private sleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const cancelTimer = this.clock.setTimer(() => {
        this.cancels.delete(cancel);
        resolve(!this.stoppedFlag);
      }, ms);
      const cancel = () => {
        cancelTimer();
        resolve(false);
      };
      this.cancels.add(cancel);
    });
  }

  /** Waits for a global slot and the host's slot. Resolves false when the run stops first. */
  private acquire(host: string): Promise<boolean> {
    if (this.stoppedFlag) return Promise.resolve(false);
    return new Promise((start) => {
      this.waiters.push({ host, start });
      this.pump();
    });
  }

  private pump(): void {
    while (this.inFlight < this.maxInFlight) {
      const i = this.waiters.findIndex((w) => !this.busyHosts.has(w.host));
      if (i < 0) return;
      const [w] = this.waiters.splice(i, 1);
      this.inFlight++;
      this.busyHosts.add(w.host);
      w.start(true);
    }
  }

  /**
   * One request with the timeout race. On the timer the global slot frees at once; the host's
   * slot frees only when the native call settles, so a slow host never has two requests at once.
   */
  private async request(url: string, method: "HEAD" | "GET"): Promise<Outcome> {
    const host = hostKey(url);
    if (!(await this.acquire(host))) return STOPPED;
    if (this.stoppedFlag) {
      this.inFlight--;
      this.busyHosts.delete(host);
      this.pump();
      return STOPPED;
    }
    let globalHeld = true;
    const releaseGlobal = () => {
      if (!globalHeld) return;
      globalHeld = false;
      this.inFlight--;
      this.pump();
    };
    const headers: Record<string, string> = { "User-Agent": SAFARI_USER_AGENT, Accept: "text/html" };
    if (method === "GET") headers.Range = "bytes=0-0";

    return new Promise<Outcome>((resolve) => {
      let settled = false;
      const finish = (outcome: Outcome) => {
        if (settled) return;
        settled = true;
        cancelTimer();
        this.cancels.delete(onStop);
        releaseGlobal();
        resolve(outcome);
      };
      const cancelTimer = this.clock.setTimer(() => finish({ kind: "timeout" }), this.timeoutMs);
      const onStop = () => finish(STOPPED);
      this.cancels.add(onStop);
      let call: Promise<FetchResult>;
      try {
        call = Promise.resolve(this.fetchFn(url, { method, headers }));
      } catch (error) {
        call = Promise.reject(error);
      }
      call.then(
        (result) => finish({ kind: "response", result: { status: Number(result?.status), url: String(result?.url ?? "") } }),
        (error) => finish({ kind: "error", message: errorMessage(error) }),
      ).finally(() => {
        this.busyHosts.delete(host);
        this.pump();
      });
    });
  }
}

function hostKey(url: string): string {
  return normalizeHost(parseUrl(url)?.hostname ?? url);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || "unknown error";
}
