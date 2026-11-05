#!/usr/bin/env node
// Phase 1 live API probe. Runs each Phase 1 row of the plan's "Open facts as tests"
// against the real Raindrop API and prints one JSON result object to stdout.
//
// The token comes only from process.env.RAINDROP_TOKEN. This script never logs a
// request header and never prints the token.
//
// Usage: set -a; . ./.env; set +a; pnpm probe > .afkkit/logs/probe.json

import { MIN_GAP_MS, paceWaitMs, pagesFor, resetWaitMs, scaleByPages, withNonce } from "../src/api/pace.ts";

const BASE = "https://api.raindrop.io/rest/v1";
const PROBE_TITLE = "tinydrop probe";
const PROBE_LINK = "https://example.com/tinydrop-probe";
const HIGHLIGHT = { text: "Example Domain", note: "tinydrop probe highlight" };
const TOKEN_FIRST_SEEN = "2026-11-05";
const UNSORTED = -1;
const TRASH = -99;

const token = process.env.RAINDROP_TOKEN;
if (!token) {
  console.error("RAINDROP_TOKEN is not set. Load .env inside the command: set -a; . ./.env; set +a; pnpm probe");
  process.exit(2);
}

const log = (msg) => console.error(`[probe] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let calls = 0;
let lastStart;
let rateLimitWaits = 0;

/** One paced API call. GETs get a nonce unless `nonce: false`. Returns { status, ok, body }. */
async function api(method, path, { body, nonce = true } = {}) {
  let url = BASE + path;
  if (method === "GET" && nonce) url = withNonce(url, Date.now());
  for (;;) {
    const wait = paceWaitMs(lastStart, Date.now(), MIN_GAP_MS);
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
    calls++;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429) {
      const ms = resetWaitMs(res.headers.get("X-RateLimit-Reset"), Date.now());
      rateLimitWaits++;
      log(`429 on ${method} ${path}; waiting ${Math.round(ms / 1000)} s`);
      await sleep(ms);
      continue;
    }
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 200) };
    }
    return { status: res.status, ok: res.ok && parsed.result !== false, body: parsed };
  }
}

const isProbe = (item) => item && item.link === PROBE_LINK;
const findProbe = (items, id) => (items ?? []).find((it) => (id === undefined ? isProbe(it) : it._id === id));
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const errText = (e) => (e instanceof Error ? e.message : String(e));

const result = {
  probeDate: new Date().toISOString().slice(0, 10),
  tokenFirstSeenWorking: TOKEN_FIRST_SEEN,
  token: {},
  leftoversRemoved: 0,
  create: {},
  highlights: {},
  sortLastUpdate: {},
  nonce: {},
  trashSearch: {},
  putRestore: {},
  cleanup: {},
  pagePass: {},
  totals: {},
  errors: [],
};

/** Find probe bookmarks left by an earlier failed run, in the library and in the Trash. */
async function findLeftovers() {
  const found = [];
  for (const coll of [0, TRASH]) {
    const r = await api("GET", `/raindrops/${coll}?search=${encodeURIComponent("tinydrop")}&perpage=50`);
    for (const it of r.body.items ?? []) if (isProbe(it)) found.push({ id: it._id, collection: coll });
  }
  return found;
}

/** Delete a bookmark for good: once to Trash, once from Trash. A bookmark already in Trash needs one call. */
async function deleteForGood(id, inTrash) {
  const steps = [];
  if (!inTrash) steps.push((await api("DELETE", `/raindrop/${id}`)).status);
  steps.push((await api("DELETE", `/raindrop/${id}`)).status);
  return steps;
}

async function checkToken() {
  const r = await api("GET", "/user");
  result.token = { status: r.status, works: r.ok, pro: Boolean(r.body.user?.pro) };
  if (!r.ok) throw new Error(`GET /user failed with ${r.status}`);
}

async function removeLeftovers() {
  const left = await findLeftovers();
  for (const l of left) await deleteForGood(l.id, l.collection === TRASH);
  result.leftoversRemoved = left.length;
}

async function createProbe() {
  const r = await api("POST", "/raindrop", {
    body: { title: PROBE_TITLE, link: PROBE_LINK, collection: { $id: UNSORTED }, highlights: [HIGHLIGHT] },
  });
  if (!r.ok || !r.body.item?._id) throw new Error(`POST /raindrop failed with ${r.status}`);
  const item = r.body.item;
  result.create = {
    status: r.status,
    id: item._id,
    collectionId: item.collection?.$id,
    highlightsInPostReply: (item.highlights ?? []).length,
    highlightMethod: null,
  };
  if ((item.highlights ?? []).length > 0) {
    result.create.highlightMethod = "POST /raindrop body";
  } else {
    const p = await api("PUT", `/raindrop/${item._id}`, { body: { highlights: [HIGHLIGHT] } });
    const n = (p.body.item?.highlights ?? []).length;
    result.create.putHighlightStatus = p.status;
    result.create.highlightsInPutReply = n;
    result.create.highlightMethod = n > 0 ? "PUT /raindrop/{id} body" : "neither";
  }
  return item._id;
}

async function checkHighlights(id) {
  const page = await api("GET", "/raindrops/0?sort=-lastUpdate&perpage=50");
  const onPage = findProbe(page.body.items, id);
  const hl = await api("GET", "/highlights?perpage=50");
  const fromHl = (hl.body.items ?? []).filter((h) => h.raindropRef === id);
  result.highlights = {
    probeFoundOnPage: Boolean(onPage),
    pageCallHighlights: (onPage?.highlights ?? []).length,
    pageCallHighlightText: onPage?.highlights?.[0]?.text ?? null,
    highlightsEndpointStatus: hl.status,
    highlightsEndpointHits: fromHl.length,
    highlightsEndpointText: fromHl[0]?.text ?? null,
  };
}

async function checkSortLastUpdate(id) {
  // Ensure another bookmark is not the most recent by editing the probe now.
  const note = `sort check ${Date.now()}`;
  const e = await api("PUT", `/raindrop/${id}`, { body: { note } });
  const page = await api("GET", "/raindrops/0?sort=-lastUpdate&perpage=50");
  const items = page.body.items ?? [];
  const index = items.findIndex((it) => it._id === id);
  result.sortLastUpdate = {
    editStatus: e.status,
    pageStatus: page.status,
    probeIndex: index,
    probeIsFirst: index === 0,
    firstItemIsProbe: isProbe(items[0]),
    noteOnPage: items[index]?.note === note,
  };
}

async function checkNonce(id) {
  const path = "/raindrops/0?sort=-lastUpdate&perpage=50";
  // Prime the un-nonced URL, so a cache (if any) holds the old note.
  const prime = await api("GET", path, { nonce: false });
  const before = findProbe(prime.body.items, id)?.note ?? null;
  const note = `nonce check ${Date.now()}`;
  const e = await api("PUT", `/raindrop/${id}`, { body: { note } });
  const plain = await api("GET", path, { nonce: false });
  const nonced = await api("GET", path);
  const plainNote = findProbe(plain.body.items, id)?.note ?? null;
  const noncedNote = findProbe(nonced.body.items, id)?.note ?? null;
  result.nonce = {
    editStatus: e.status,
    noteBeforeEdit: before === note ? "unexpected: already new" : "old",
    withoutNonceShowsEdit: plainNote === note,
    withNonceShowsEdit: noncedNote === note,
    withoutNonceWasStale: plainNote !== note,
  };
}

async function checkTrashSearch(id) {
  const d = await api("DELETE", `/raindrop/${id}`);
  const since = yesterday();
  const today = new Date().toISOString().slice(0, 10);
  const search = `lastUpdate:>${since}`;
  const trashGet = (q) => api("GET", `/raindrops/${TRASH}?search=${encodeURIComponent(q)}&perpage=50`);
  const hitIn = (r) => Boolean(findProbe(r.body.items, id));
  const t = await trashGet(search);
  const hit = findProbe(t.body.items, id);
  result.trashSearch = {
    deleteStatus: d.status,
    search,
    searchStatus: t.status,
    replyCount: (t.body.items ?? []).length,
    probeInReply: Boolean(hit),
    probeCollectionInReply: hit?.collection?.$id ?? null,
  };
  if (hit) return;
  // Diagnostics: is the probe in the Trash at all, and does a later or different search find it?
  const diag = {};
  const plain = await api("GET", `/raindrops/${TRASH}?sort=-lastUpdate&perpage=50`);
  diag.plainTrashPageHasProbe = hitIn(plain);
  diag.plainTrashPageCount = (plain.body.items ?? []).length;
  diag.probeLastUpdate = findProbe(plain.body.items, id)?.lastUpdate ?? null;
  for (const q of [`created:>${since}`, `lastUpdate:${today}`, `tinydrop`, `lastUpdate:>${since}T00:00:00Z`]) {
    diag[`search ${q}`] = hitIn(await trashGet(q));
  }
  let waited = 0;
  for (const waitS of [5, 20, 60]) {
    await sleep(waitS * 1000);
    waited += waitS;
    const r = await trashGet(search);
    diag[`afterWait${waited}s`] = hitIn(r);
    if (hitIn(r)) break;
  }
  result.trashSearch.diagnostics = diag;
}

async function checkPutRestore(id) {
  const p = await api("PUT", `/raindrop/${id}`, { body: { collection: { $id: UNSORTED } } });
  const g = await api("GET", `/raindrop/${id}`);
  result.putRestore = {
    putStatus: p.status,
    collectionInPutReply: p.body.item?.collection?.$id ?? null,
    collectionAfterGet: g.body.item?.collection?.$id ?? null,
    backInUnsorted: g.body.item?.collection?.$id === UNSORTED,
  };
}

async function cleanup(id) {
  const c = { id };
  try {
    const g = await api("GET", `/raindrop/${id}`);
    const inTrash = g.ok && g.body.item?.collection?.$id === TRASH;
    const gone = !g.ok;
    c.stateBefore = gone ? "already gone" : inTrash ? "in Trash" : `in collection ${g.body.item?.collection?.$id}`;
    if (!gone) c.deleteStatuses = await deleteForGood(id, inTrash);
    const after = await api("GET", `/raindrop/${id}`);
    c.getAfterStatus = after.status;
    c.getAfterResult = after.body.result ?? null;
    c.getAfterNotFound = !after.ok;
    const trash = await api("GET", `/raindrops/${TRASH}?search=${encodeURIComponent("tinydrop")}&perpage=50`);
    const trashFull = await pageAll(TRASH);
    c.trashSearchHasProbe = (trash.body.items ?? []).some(isProbe);
    c.trashPagesChecked = trashFull.pages;
    c.trashFullPassHasProbe = trashFull.items.some(isProbe);
    c.gone = c.getAfterNotFound && !c.trashSearchHasProbe && !c.trashFullPassHasProbe;
  } catch (e) {
    c.error = errText(e);
  }
  result.cleanup = c;
}

/** Page every bookmark of one collection. Returns the items, the page count and the API `count`. */
async function pageAll(collection) {
  const items = [];
  let pages = 0;
  let count = null;
  for (let page = 0; ; page++) {
    const r = await api("GET", `/raindrops/${collection}?perpage=50&page=${page}`);
    if (!r.ok) throw new Error(`GET /raindrops/${collection} page ${page} failed with ${r.status}`);
    pages++;
    count ??= r.body.count ?? null;
    const got = r.body.items ?? [];
    items.push(...got);
    if (got.length < 50) break;
  }
  return { items, pages, count };
}

async function pagePass() {
  const callsBefore = calls;
  const t0 = Date.now();
  let seen = 0;
  let pages = 0;
  let count = null;
  for (let page = 0; ; page++) {
    const r = await api("GET", `/raindrops/0?perpage=50&page=${page}`);
    if (!r.ok) throw new Error(`page pass page ${page} failed with ${r.status}`);
    pages++;
    count ??= r.body.count ?? null;
    const got = (r.body.items ?? []).length;
    seen += got;
    if (got < 50) break;
  }
  const elapsedMs = Date.now() - t0;
  const scaledMs = scaleByPages(elapsedMs, pages);
  result.pagePass = {
    bookmarks: seen,
    apiCount: count,
    calls: calls - callsBefore,
    pages,
    elapsedSeconds: +(elapsedMs / 1000).toFixed(1),
    secondsPerPage: +(elapsedMs / pages / 1000).toFixed(3),
    pagesFor10000: pagesFor(10_000),
    scaledTo10000Seconds: +(scaledMs / 1000).toFixed(1),
    scaledTo10000Minutes: +(scaledMs / 60_000).toFixed(2),
  };
}

async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    result.errors.push({ step: name, error: errText(e) });
    log(`${name} failed: ${errText(e)}`);
  }
}

async function main() {
  const t0 = Date.now();
  await checkToken();
  await removeLeftovers();
  let id;
  try {
    id = await createProbe();
    log(`created probe bookmark ${id}`);
    await step("highlights", () => checkHighlights(id));
    await step("sortLastUpdate", () => checkSortLastUpdate(id));
    await step("nonce", () => checkNonce(id));
    await step("trashSearch", () => checkTrashSearch(id));
    await step("putRestore", () => checkPutRestore(id));
  } catch (e) {
    result.errors.push({ step: "create", error: errText(e) });
  } finally {
    if (id !== undefined) await cleanup(id);
  }
  await step("pagePass", pagePass);
  result.totals = { calls, rateLimitWaits, elapsedSeconds: +((Date.now() - t0) / 1000).toFixed(1) };
}

try {
  await main();
} catch (e) {
  result.errors.push({ step: "main", error: errText(e) });
}
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
process.exit(result.errors.length === 0 ? 0 : 1);
