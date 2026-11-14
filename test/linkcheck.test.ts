import { describe, expect, it } from "vitest";
import { classifyResponse, excludedReason, LinkChecker, normalizeHost, SAFARI_USER_AGENT, type CheckProgress } from "../src/cleanup/linkcheck";
import type { LinkCheckRow } from "../src/store/types";

describe("host exclusions", () => {
  const none = new Set<string>();

  it("skips links that are not http or https", () => {
    expect(excludedReason("ftp://example.com/a", none)).toBe("not an http(s) link");
    expect(excludedReason("mailto:me@example.com", none)).toBe("not an http(s) link");
    expect(excludedReason("not a url", none)).toBe("invalid link");
  });

  it("skips localhost", () => {
    expect(excludedReason("http://localhost:3000/x", none)).toBe("localhost");
    expect(excludedReason("http://app.localhost/x", none)).toBe("localhost");
  });

  it("skips private IPv4 literals", () => {
    for (const host of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1", "0.0.0.0", "100.64.0.1"]) {
      expect(excludedReason(`http://${host}/a`, none)).toBe("private address");
    }
    expect(excludedReason("http://172.32.0.1/a", none)).toBeUndefined();
    expect(excludedReason("http://8.8.8.8/a", none)).toBeUndefined();
  });

  it("skips private IPv6 literals", () => {
    for (const host of ["[::1]", "[::]", "[fd00::1]", "[fc12:3::4]", "[fe80::1]", "[::ffff:127.0.0.1]", "[::ffff:192.168.0.2]"]) {
      expect(excludedReason(`http://${host}/a`, none)).toBe("private address");
    }
    expect(excludedReason("http://[2606:4700::1111]/a", none)).toBeUndefined();
  });

  it("skips .local hosts", () => {
    expect(excludedReason("http://printer.local/status", none)).toBe(".local host");
  });

  it("skips an ignored host by exact, normalized name", () => {
    const ignored = new Set([normalizeHost("Blocked.Example.com.")]);
    expect(excludedReason("https://blocked.example.com/a", ignored)).toBe("ignored host");
    expect(excludedReason("https://www.blocked.example.com/a", ignored)).toBeUndefined();
  });

  it("allows an ordinary public link", () => {
    expect(excludedReason("https://example.com/a", none)).toBeUndefined();
  });
});

describe("response classification", () => {
  const none = new Set<string>();
  const at = (status: number, url = "https://example.com/page") => ({ status, url });

  it("classifies 404 and 410 as dead", () => {
    expect(classifyResponse("https://example.com/page", at(404), none)).toEqual({ class: "dead", status: 404, reason: "HTTP 404" });
    expect(classifyResponse("https://example.com/page", at(410), none).class).toBe("dead");
  });

  it("classifies 401, 403, 429, 5xx, 416 and unknown statuses as unsure", () => {
    for (const status of [401, 403, 429, 500, 503, 416, 418, 302, 101]) {
      expect(classifyResponse("https://example.com/page", at(status), none)).toEqual({
        class: "unsure",
        status,
        reason: `HTTP ${status}`,
      });
    }
  });

  it("classifies 200 and 206 as ok", () => {
    expect(classifyResponse("https://example.com/page", at(200), none)).toEqual({ class: "ok", status: 200, reason: "HTTP 200" });
    expect(classifyResponse("https://example.com/page", at(206), none).class).toBe("ok");
  });

  it("classifies an ordinary redirect by its final status", () => {
    expect(classifyResponse("http://example.com/page", at(200, "https://www.example.com/new-page"), none)).toEqual({
      class: "ok",
      status: 200,
      reason: "HTTP 200 after a redirect to https://www.example.com/new-page",
    });
  });

  it("classifies a redirect from a non-root path to the home page as unsure, even with 200", () => {
    expect(classifyResponse("https://example.com/old/post", at(200, "https://www.example.com/"), none)).toEqual({
      class: "unsure",
      status: 200,
      reason: "redirected to the home page",
    });
    // A root link that stays on the root is not a home-page redirect.
    expect(classifyResponse("http://example.com/", at(200, "https://example.com/"), none).class).toBe("ok");
    // The home page of another site is an ordinary redirect.
    expect(classifyResponse("https://example.com/old", at(200, "https://other.org/"), none).class).toBe("ok");
  });

  it("classifies a final URL on an excluded host as skipped", () => {
    expect(classifyResponse("https://example.com/a", at(200, "http://192.168.1.10/login"), none)).toEqual({
      class: "skipped",
      status: 200,
      reason: "redirected to an excluded host (private address)",
    });
    const ignored = new Set(["other.org"]);
    expect(classifyResponse("https://example.com/a", at(404, "https://other.org/a"), ignored).class).toBe("skipped");
  });

  it("classifies an empty final URL as unsure", () => {
    expect(classifyResponse("https://example.com/a", at(200, ""), none)).toEqual({
      class: "unsure",
      status: 200,
      reason: "no final URL",
    });
  });
});

// ─── The checker ────────────────────────────────────────────────────

type Reply = { status: number; url?: string } | Error | "hang";
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  at: number;
}

/** A clock whose timers fire only on advance(). */
class FakeClock {
  t = 1_000_000;
  private timers: { at: number; fn: () => void; seq: number }[] = [];
  private seq = 0;
  now = () => this.t;
  setTimer = (fn: () => void, ms: number) => {
    const timer = { at: this.t + ms, fn, seq: this.seq++ };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((x) => x !== timer);
    };
  };
  get pendingTimers() {
    return this.timers.length;
  }
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      await flush();
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = end;
    await flush();
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

/** A fetch that answers from a script keyed by "METHOD url". Unscripted calls answer 200. "hang" never settles until released. */
function fakeFetch(clock: FakeClock, script: Record<string, Reply | Reply[]> = {}) {
  const calls: Call[] = [];
  const open: { url: string; resolve: (r: { status: number; url: string }) => void; reject: (e: Error) => void }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const hostsInFlight = new Map<string, number>();
  let maxPerHost = 0;
  const fetch = (url: string, init: { method: string; headers: Record<string, string> }) => {
    calls.push({ url, method: init.method, headers: init.headers, at: clock.now() });
    const key = `${init.method} ${url}`;
    const entry = script[key];
    const reply: Reply = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]) : (entry ?? { status: 200 });
    const host = new URL(url).host;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    hostsInFlight.set(host, (hostsInFlight.get(host) ?? 0) + 1);
    maxPerHost = Math.max(maxPerHost, hostsInFlight.get(host)!);
    const done = () => {
      inFlight--;
      hostsInFlight.set(host, hostsInFlight.get(host)! - 1);
    };
    return new Promise<{ status: number; url: string }>((resolve, reject) => {
      const settle = {
        url,
        resolve: (r: { status: number; url: string }) => (done(), resolve(r)),
        reject: (e: Error) => (done(), reject(e)),
      };
      if (reply === "hang") open.push(settle);
      else if (reply instanceof Error) setImmediate(() => settle.reject(reply));
      else setImmediate(() => settle.resolve({ status: reply.status, url: reply.url ?? url }));
    });
  };
  return {
    fetch,
    calls,
    open,
    get maxInFlight() {
      return maxInFlight;
    },
    get maxPerHost() {
      return maxPerHost;
    },
  };
}

function setup(script: Record<string, Reply | Reply[]> = {}, options: { ignoredHosts?: string[] } = {}) {
  const clock = new FakeClock();
  const net = fakeFetch(clock, script);
  const saved: LinkCheckRow[] = [];
  const progress: CheckProgress[] = [];
  const checker = new LinkChecker({
    fetch: net.fetch,
    clock,
    ignoredHosts: options.ignoredHosts,
    save: (row) => {
      saved.push(row);
    },
    onProgress: (p) => progress.push(p),
  });
  const last = (id: number) => saved.filter((r) => r.bookmarkId === id).at(-1);
  return { clock, net, saved, progress, checker, last };
}

describe("LinkChecker first pass", () => {
  it("sends HEAD with the Safari User-Agent and Accept: text/html, and saves ok", async () => {
    const { net, checker, last } = setup();
    await checker.run([{ id: 1, link: "https://example.com/a" }]);
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]).toMatchObject({
      method: "HEAD",
      url: "https://example.com/a",
      headers: { "User-Agent": SAFARI_USER_AGENT, Accept: "text/html" },
    });
    expect(last(1)).toMatchObject({ bookmarkId: 1, url: "https://example.com/a", class: "ok", status: 200, reason: "HTTP 200" });
  });

  it("classifies 401, 403, 429 and 5xx as unsure", async () => {
    const links = [401, 403, 429, 502].map((s) => `https://s${s}.example/a`);
    const { checker, last } = setup(Object.fromEntries(links.map((l, i) => [`HEAD ${l}`, { status: [401, 403, 429, 502][i] }])));
    await checker.run(links.map((link, i) => ({ id: i + 1, link })));
    expect([1, 2, 3, 4].map((id) => [last(id)?.class, last(id)?.status])).toEqual([
      ["unsure", 401],
      ["unsure", 403],
      ["unsure", 429],
      ["unsure", 502],
    ]);
  });

  it("falls back to a one-byte GET on 405 and 501, and counts 206 as ok", async () => {
    const { net, checker, last } = setup({
      "HEAD https://a.example/x": { status: 405 },
      "GET https://a.example/x": { status: 206 },
      "HEAD https://b.example/x": { status: 501 },
      "GET https://b.example/x": { status: 403 },
    });
    await checker.run([
      { id: 1, link: "https://a.example/x" },
      { id: 2, link: "https://b.example/x" },
    ]);
    const gets = net.calls.filter((c) => c.method === "GET");
    expect(gets.map((c) => c.url).sort()).toEqual(["https://a.example/x", "https://b.example/x"]);
    expect(gets[0].headers).toEqual({ "User-Agent": SAFARI_USER_AGENT, Accept: "text/html", Range: "bytes=0-0" });
    expect(last(1)).toMatchObject({ class: "ok", status: 206 });
    expect(last(2)).toMatchObject({ class: "unsure", status: 403 });
  });

  it("falls back to GET on a thrown error, and a thrown GET is unsure, never dead", async () => {
    const { net, checker, last } = setup({
      "HEAD https://a.example/x": new Error("A server with the specified hostname could not be found."),
      "GET https://a.example/x": new Error("A server with the specified hostname could not be found."),
      "HEAD https://b.example/x": new Error("The network connection was lost."),
      "GET https://b.example/x": { status: 200 },
    });
    await checker.run([
      { id: 1, link: "https://a.example/x" },
      { id: 2, link: "https://b.example/x" },
    ]);
    expect(net.calls.map((c) => `${c.method} ${c.url}`).sort()).toEqual([
      "GET https://a.example/x",
      "GET https://b.example/x",
      "HEAD https://a.example/x",
      "HEAD https://b.example/x",
    ]);
    expect(last(1)).toMatchObject({ class: "unsure", reason: "network error: A server with the specified hostname could not be found." });
    expect(last(1)?.status).toBeUndefined();
    expect(last(2)).toMatchObject({ class: "ok", status: 200 });
  });

  it("records a timeout as unsure after 10 seconds and ignores the late result", async () => {
    const { clock, net, checker, saved, last } = setup({ "HEAD https://slow.example/x": "hang" });
    const run = checker.run([{ id: 1, link: "https://slow.example/x" }]);
    await clock.advance(9_999);
    expect(saved).toHaveLength(0);
    await clock.advance(1);
    await run;
    expect(last(1)).toMatchObject({ class: "unsure", reason: "timeout" });
    net.open[0].resolve({ status: 404, url: "https://slow.example/x" });
    await flush();
    expect(saved).toHaveLength(1);
    expect(net.calls).toHaveLength(1);
  });

  it("skips an excluded link without a request, for each kind and an ignored host", async () => {
    const { net, checker, saved } = setup({}, { ignoredHosts: ["Ignored.Example"] });
    await checker.run([
      { id: 1, link: "ftp://example.com/a" },
      { id: 2, link: "http://localhost/a" },
      { id: 3, link: "http://10.0.0.2/a" },
      { id: 4, link: "http://[fe80::1]/a" },
      { id: 5, link: "http://nas.local/a" },
      { id: 6, link: "https://ignored.example/a" },
    ]);
    expect(net.calls).toHaveLength(0);
    expect(saved.map((r) => [r.bookmarkId, r.class, r.reason])).toEqual([
      [1, "skipped", "not an http(s) link"],
      [2, "skipped", "localhost"],
      [3, "skipped", "private address"],
      [4, "skipped", "private address"],
      [5, "skipped", ".local host"],
      [6, "skipped", "ignored host"],
    ]);
  });

  it("classifies redirects: excluded final URL skipped, home page unsure, ordinary ok", async () => {
    const { checker, last } = setup({
      "HEAD https://a.example/x": { status: 200, url: "http://127.0.0.1/admin" },
      "HEAD https://b.example/post/1": { status: 200, url: "https://b.example/" },
      "HEAD https://c.example/old": { status: 200, url: "https://c.example/new" },
    });
    await checker.run([
      { id: 1, link: "https://a.example/x" },
      { id: 2, link: "https://b.example/post/1" },
      { id: 3, link: "https://c.example/old" },
    ]);
    expect(last(1)).toMatchObject({ class: "skipped", reason: "redirected to an excluded host (private address)" });
    expect(last(2)).toMatchObject({ class: "unsure", reason: "redirected to the home page" });
    expect(last(3)).toMatchObject({ class: "ok", status: 200 });
  });
});

describe("LinkChecker request limits", () => {
  it("runs at most six requests at once", async () => {
    const links = Array.from({ length: 10 }, (_, i) => `https://h${i}.example/a`);
    const { net, checker } = setup(Object.fromEntries(links.map((l) => [`HEAD ${l}`, "hang" as Reply])));
    const run = checker.run(links.map((link, i) => ({ id: i + 1, link })));
    await flush();
    expect(net.calls).toHaveLength(6);
    net.open.shift()!.resolve({ status: 200, url: links[0] });
    await flush();
    expect(net.calls).toHaveLength(7);
    while (net.calls.length < 10 || net.open.length > 0) {
      const next = net.open.shift();
      if (next) next.resolve({ status: 200, url: next.url });
      await flush();
    }
    await run;
    expect(net.maxInFlight).toBe(6);
  });

  it("sends one request per host at a time", async () => {
    const links = ["https://same.example/1", "https://same.example/2", "https://same.example/3", "https://other.example/1"];
    const { net, checker, saved } = setup(Object.fromEntries(links.map((l) => [`HEAD ${l}`, "hang" as Reply])));
    const run = checker.run(links.map((link, i) => ({ id: i + 1, link })));
    await flush();
    expect(net.calls.map((c) => c.url)).toEqual(["https://same.example/1", "https://other.example/1"]);
    while (saved.length < 4) {
      const next = net.open.shift();
      if (next) next.resolve({ status: 200, url: next.url });
      await flush();
    }
    await run;
    expect(net.maxPerHost).toBe(1);
  });

  it("frees the global slot at the timeout but keeps the host busy until the native call settles", async () => {
    const links = ["https://slow.example/1", "https://slow.example/2", ...Array.from({ length: 6 }, (_, i) => `https://h${i}.example/a`)];
    const { clock, net, checker } = setup(Object.fromEntries(links.map((l) => [`HEAD ${l}`, "hang" as Reply])));
    const run = checker.run(links.map((link, i) => ({ id: i + 1, link })));
    await flush();
    // slow/1 and five h* hosts run; slow/2 waits for its host, h5 for a global slot.
    expect(net.calls).toHaveLength(6);
    await clock.advance(10_000);
    // Every request timed out: the global slots are free, so h5 starts, but slow/2 still waits.
    expect(net.calls.map((c) => c.url)).toContain("https://h5.example/a");
    expect(net.calls.map((c) => c.url)).not.toContain("https://slow.example/2");
    const slow = net.open.find((o) => o.url === "https://slow.example/1")!;
    slow.resolve({ status: 200, url: slow.url });
    await flush();
    expect(net.calls.map((c) => c.url)).toContain("https://slow.example/2");
    await clock.advance(10_000);
    for (const o of net.open.splice(0)) o.resolve({ status: 200, url: o.url });
    await run;
    expect(net.maxPerHost).toBe(1);
  });
});

describe("LinkChecker dead retries", () => {
  it("saves a first dead result as pending, then sends the GET retry two minutes later; both dead is dead", async () => {
    const { clock, net, checker, saved, progress } = setup({
      "HEAD https://gone.example/a": { status: 404 },
      "GET https://gone.example/a": { status: 410 },
    });
    const start = clock.now();
    const run = checker.run([{ id: 1, link: "https://gone.example/a" }]);
    await flush();
    expect(saved).toEqual([
      {
        bookmarkId: 1,
        url: "https://gone.example/a",
        class: "pending",
        status: 404,
        reason: "HTTP 404, retry pending",
        checkedAt: start,
        firstDeadStatus: 404,
        firstDeadAt: start,
        retryDue: start + 120_000,
      },
    ]);
    expect(progress.at(-1)).toMatchObject({ phase: "waiting", done: 1, total: 1, pendingRetries: 1, nextRetryAt: start + 120_000 });
    await clock.advance(119_999);
    expect(net.calls).toHaveLength(1);
    await clock.advance(1);
    await run;
    expect(net.calls.map((c) => `${c.method} ${c.url} ${c.headers.Range ?? ""}`)).toEqual([
      "HEAD https://gone.example/a ",
      "GET https://gone.example/a bytes=0-0",
    ]);
    expect(saved[1]).toEqual({
      bookmarkId: 1,
      url: "https://gone.example/a",
      class: "dead",
      status: 410,
      reason: "HTTP 410 on the first check and the retry",
      checkedAt: start + 120_000,
    });
    expect(progress.map((p) => p.phase)).toContain("retry");
    expect(progress.at(-1)).toMatchObject({ phase: "done", pendingRetries: 0, retryDone: 1, retryTotal: 1 });
  });

  it("uses the retry's class when the retry is not dead", async () => {
    const { clock, checker, last } = setup({
      "HEAD https://a.example/x": { status: 404 },
      "GET https://a.example/x": { status: 200 },
      "HEAD https://b.example/x": { status: 410 },
      "GET https://b.example/x": new Error("The request timed out."),
    });
    const run = checker.run([
      { id: 1, link: "https://a.example/x" },
      { id: 2, link: "https://b.example/x" },
    ]);
    await clock.advance(120_000);
    await run;
    expect(last(1)).toMatchObject({ class: "ok", status: 200 });
    expect(last(2)).toMatchObject({ class: "unsure", reason: "network error: The request timed out." });
    expect(last(1)?.retryDue).toBeUndefined();
  });

  it("waits for the whole first pass before any retry", async () => {
    const { clock, net, checker } = setup({
      "HEAD https://dead.example/x": { status: 404 },
      "HEAD https://slow.example/x": "hang",
    });
    const run = checker.run([
      { id: 1, link: "https://dead.example/x" },
      { id: 2, link: "https://slow.example/x" },
    ]);
    await flush();
    // The slow first-pass request times out after 10 s, long before the retry is due.
    await clock.advance(200_000);
    await run;
    const getAt = net.calls.find((c) => c.method === "GET")!.at;
    expect(getAt).toBeGreaterThanOrEqual(1_000_000 + 120_000);
  });

  it("resumes a saved pending retry in a new run: GET only, at its due time", async () => {
    const { clock, net, checker, last, progress } = setup({ "GET https://gone.example/a": { status: 404 } });
    const due = clock.now() + 30_000;
    const run = checker.run([
      { id: 7, link: "https://gone.example/a", pending: { firstDeadStatus: 404, firstDeadAt: clock.now() - 90_000, retryDue: due } },
    ]);
    await flush();
    expect(net.calls).toHaveLength(0);
    expect(progress.at(-1)).toMatchObject({ phase: "waiting", total: 0, pendingRetries: 1, nextRetryAt: due, retryTotal: 1 });
    await clock.advance(30_000);
    await run;
    expect(net.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(last(7)).toMatchObject({ class: "dead", status: 404 });
  });

  it("runs an overdue resumed retry right after the first pass", async () => {
    const { net, checker, last } = setup({ "GET https://gone.example/a": { status: 200 } });
    await checker.run([{ id: 7, link: "https://gone.example/a", pending: { firstDeadAt: 0, retryDue: 5 } }]);
    expect(net.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(last(7)).toMatchObject({ class: "ok" });
  });
});

describe("LinkChecker stop", () => {
  it("ends the run, starts no queued request, and drops late results", async () => {
    const links = Array.from({ length: 8 }, (_, i) => `https://h${i}.example/a`);
    const { net, checker, saved, progress, clock } = setup(Object.fromEntries(links.map((l) => [`HEAD ${l}`, "hang" as Reply])));
    const run = checker.run(links.map((link, i) => ({ id: i + 1, link })));
    await flush();
    expect(net.calls).toHaveLength(6);
    checker.stop();
    const result = await run;
    expect(result.phase).toBe("stopped");
    expect(progress.at(-1)?.phase).toBe("stopped");
    for (const o of net.open.splice(0)) o.resolve({ status: 404, url: o.url });
    await clock.advance(300_000);
    expect(net.calls).toHaveLength(6);
    expect(saved).toHaveLength(0);
    expect(clock.pendingTimers).toBe(0);
  });

  it("stops while a retry waits, and keeps the saved pending row", async () => {
    const { clock, net, checker, saved } = setup({ "HEAD https://gone.example/a": { status: 404 } });
    const run = checker.run([{ id: 1, link: "https://gone.example/a" }]);
    await flush();
    checker.stop();
    await run;
    await clock.advance(300_000);
    expect(net.calls).toHaveLength(1);
    expect(saved.map((r) => r.class)).toEqual(["pending"]);
  });
});

describe("LinkChecker saving", () => {
  it("saves results one at a time, in arrival order, and waits for the last save", async () => {
    const clock = new FakeClock();
    const net = fakeFetch(clock);
    const order: string[] = [];
    let active = 0;
    const checker = new LinkChecker({
      fetch: net.fetch,
      clock,
      save: async (row) => {
        active++;
        expect(active).toBe(1);
        await flush();
        order.push(String(row.bookmarkId));
        active--;
      },
    });
    await checker.run([
      { id: 1, link: "https://a.example/" },
      { id: 2, link: "ftp://b.example/" },
      { id: 3, link: "https://c.example/" },
    ]);
    expect(order.sort()).toEqual(["1", "2", "3"]);
  });

  it("rejects the run with a save error when no onSaveError is given", async () => {
    const clock = new FakeClock();
    const checker = new LinkChecker({
      fetch: fakeFetch(clock).fetch,
      clock,
      save: () => {
        throw new Error("disk full");
      },
    });
    await expect(checker.run([{ id: 1, link: "https://a.example/" }])).rejects.toThrow("disk full");
  });
});
