import { describe, expect, it } from "vitest";
import { RaindropClient, Pacer } from "../src/api/client";
import { RaindropApiError, isTokenRejected } from "../src/api/errors";
import { percentile, TimeRing } from "../src/store/timing";

function fakeFetch(replies: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = replies.shift() ?? { status: 200, body: { result: true, items: [] } };
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  };
  return { fetch, calls };
}

const noWait = { pacer: new Pacer(0), sleep: async () => undefined, now: () => 1_700_000_000_000 };

describe("RaindropApiError", () => {
  it("maps 401 to a distinct token-rejected case", () => {
    const e = new RaindropApiError(401, "/user", "");
    expect(e.isTokenRejected).toBe(true);
    expect(isTokenRejected(e)).toBe(true);
    expect(e.message).toMatch(/Token rejected/);
  });

  it("does not treat 403, 404 or 500 as token rejected", () => {
    for (const s of [403, 404, 500]) {
      expect(new RaindropApiError(s, "/x", "").isTokenRejected).toBe(false);
      expect(new RaindropApiError(s, "/x", "").message).not.toMatch(/Token rejected/);
    }
    expect(isTokenRejected(new Error("401"))).toBe(false);
  });

  it("is what the client throws on a 401 reply", async () => {
    const { fetch } = fakeFetch([{ status: 401, body: { result: false } }]);
    const error = await new RaindropClient("bad", { ...noWait, fetch }).getUser().catch((e) => e);
    expect(error).toBeInstanceOf(RaindropApiError);
    expect(error.isTokenRejected).toBe(true);
  });
});

describe("RaindropClient", () => {
  it("adds a nonce to every GET and none to a write", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { result: true, user: { _id: 1, fullName: "A" } } },
      { status: 200, body: { result: true, items: [] } },
      { status: 200, body: { result: true, item: { _id: 5 } } },
    ]);
    const client = new RaindropClient("tok", { ...noWait, fetch });
    await client.getUser();
    await client.getRaindrops(0, { sort: "-lastUpdate", page: 2 });
    await client.updateRaindrop(5, { important: true });
    expect(calls[0].url).toBe("https://api.raindrop.io/rest/v1/user?_=1700000000000");
    expect(calls[1].url).toMatch(/\/raindrops\/0\?sort=-lastUpdate&perpage=50&page=2&_=1700000000000$/);
    expect(calls[2].url).toBe("https://api.raindrop.io/rest/v1/raindrop/5");
    expect(calls[2].init?.method).toBe("PUT");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("waits for X-RateLimit-Reset on a 429 and tries again", async () => {
    const waits: number[] = [];
    const { fetch, calls } = fakeFetch([
      { status: 429, headers: { "x-ratelimit-reset": "1700000010" } },
      { status: 200, body: { result: true, items: [{ _id: "a", count: 1 }] } },
    ]);
    const client = new RaindropClient("tok", { ...noWait, fetch, sleep: async (ms) => void waits.push(ms) });
    expect(await client.getTags()).toEqual([{ _id: "a", count: 1 }]);
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([11_000]);
  });

  it("keeps call starts 500 ms apart through the pacer", async () => {
    let clock = 0;
    const waits: number[] = [];
    const pacer = new Pacer(500, () => clock, async (ms) => {
      waits.push(ms);
      clock += ms;
    });
    await pacer.next();
    clock += 100;
    await pacer.next();
    await pacer.next();
    expect(waits).toEqual([400, 500]);
  });
});

describe("query timing", () => {
  it("keeps the last 50 times and gives the nearest-rank p95", () => {
    const ring = new TimeRing(50);
    for (let i = 1; i <= 60; i++) ring.push(i);
    expect(ring.values()).toHaveLength(50);
    expect(ring.values()[0]).toBe(11);
    expect(percentile(ring.values(), 95)).toBe(58);
    expect(percentile([], 95)).toBeUndefined();
  });
});
