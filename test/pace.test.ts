import { describe, expect, it } from "vitest";
import { paceWaitMs, pagesFor, resetWaitMs, scaleByPages, withNonce } from "../src/api/pace";

describe("withNonce", () => {
  it("adds _=<now> and keeps the other query parameters", () => {
    const u = new URL(withNonce("https://api.raindrop.io/rest/v1/raindrops/0?sort=-lastUpdate&perpage=50", 1234));
    expect(u.searchParams.get("_")).toBe("1234");
    expect(u.searchParams.get("sort")).toBe("-lastUpdate");
    expect(u.searchParams.get("perpage")).toBe("50");
  });

  it("replaces an existing nonce instead of adding a second one", () => {
    const u = new URL(withNonce("https://x.test/a?_=1", 2));
    expect(u.searchParams.getAll("_")).toEqual(["2"]);
  });
});

describe("paceWaitMs", () => {
  it("waits nothing before the first call", () => {
    expect(paceWaitMs(undefined, 1000)).toBe(0);
  });

  it("keeps call starts 500 ms apart for 2 calls per second", () => {
    expect(paceWaitMs(1000, 1200)).toBe(300);
    expect(paceWaitMs(1000, 1500)).toBe(0);
    expect(paceWaitMs(1000, 2000)).toBe(0);
  });
});

describe("resetWaitMs", () => {
  it("reads X-RateLimit-Reset as a Unix time in seconds, plus a 1 s margin", () => {
    const now = 1_800_000_000_000;
    expect(resetWaitMs(String(now / 1000 + 30), now)).toBe(31_000);
  });

  it("waits only the margin when the reset time has passed", () => {
    const now = 1_800_000_000_000;
    expect(resetWaitMs(String(now / 1000 - 5), now)).toBe(1000);
  });

  it("reads a small value as seconds from now", () => {
    expect(resetWaitMs("12", 0)).toBe(13_000);
  });

  it("falls back to 60 s for a missing or bad header", () => {
    expect(resetWaitMs(null, 0)).toBe(60_000);
    expect(resetWaitMs("soon", 0)).toBe(60_000);
  });
});

describe("first-sync scaling", () => {
  it("counts 50 bookmarks per page, so 10,000 needs 200 pages", () => {
    expect(pagesFor(10_000)).toBe(200);
    expect(pagesFor(1927)).toBe(39);
  });

  it("scales a measured page pass to 10,000 bookmarks by page count", () => {
    expect(scaleByPages(22_100, 39)).toBeCloseTo((22_100 / 39) * 200);
    expect(scaleByPages(1000, 0)).toBe(0);
  });
});
