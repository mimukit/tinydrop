// Smoke test: drives tinydrop's built bundles through Tinycast's own JavaScript
// runtime (the Raycast shim and React reconciler Tinycast ships), with a fake
// Raindrop server. Adapted from tinytick's smoke script.
//
//   git clone --depth 1 https://github.com/abue-ammar/tinycast ../tinycast
//   pnpm build && pnpm smoke ../tinycast
//
// sqlite3 runs for real, on a database in a temp supportPath. /usr/bin/security
// is answered from memory, so the run never touches a Keychain (and works on
// Linux, which has none). The Swift renderer is not covered.
//
// Each flow is one async function in FLOWS. A later phase adds a flow there.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadStore } from "./lib/load-store.mjs";

const tinycastDir = resolve(process.argv[2] ?? process.env.TINYCAST_DIR ?? "../tinycast");
const harnessPath = join(tinycastDir, "Scripts/raycast-runtime/test.mjs");
if (!existsSync(harnessPath)) {
  console.error(`No Tinycast checkout at ${tinycastDir}. Pass its path: pnpm smoke <path>`);
  process.exit(1);
}
const dist = resolve(import.meta.dirname, "../dist");
if (!existsSync(join(dist, "package.json"))) {
  console.error("No dist/. Run pnpm build first.");
  process.exit(1);
}
const { createHarness, bootConfig, describeTree, preferenceDefault } = await import(pathToFileURL(harnessPath).href);
const manifest = JSON.parse(readFileSync(join(dist, "package.json"), "utf8"));
const { SqliteStore, DB_FILE } = await loadStore();

const API = "https://api.raindrop.io/rest/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Fake Raindrop ──────────────────────────────────────────────────

const USER = { _id: 7, fullName: "Test User", email: "test@example.com", pro: false, groups: [{ title: "My", collections: [11] }] };
const COLLECTIONS = [{ _id: 11, title: "Dev", sort: 0, count: 2 }];
const CHILDREN = [{ _id: 12, title: "Rust", parent: { $id: 11 }, sort: 0, count: 1 }];
const BOOKMARKS = [
  {
    _id: 101, link: "https://doc.rust-lang.org/book/", title: "Rust ownership explained", domain: "doc.rust-lang.org",
    type: "article", tags: ["rust", "read"], collection: { $id: 12 }, created: "2026-10-01T00:00:00.000Z",
    lastUpdate: "2026-11-01T00:00:00.000Z", highlights: [{ _id: "h1", text: "borrow checker", note: "" }],
  },
  {
    _id: 102, link: "https://example.com/pasta", title: "Cooking pasta", domain: "example.com", type: "link",
    tags: [], collection: { $id: -1 }, important: true, created: "2026-10-02T00:00:00.000Z", lastUpdate: "2026-11-02T00:00:00.000Z",
  },
];
/** On the server only: an incremental sync picks it up. */
const NEW_ON_SERVER = {
  _id: 103, link: "https://ziglang.org/comptime", title: "Zig comptime", domain: "ziglang.org", type: "article",
  tags: ["zig"], collection: { $id: 11 }, created: "2026-11-03T00:00:00.000Z", lastUpdate: "2026-11-03T00:00:00.000Z",
};
/** In the seeded store and in the server's Trash: a sync removes it. */
const TRASHED = {
  _id: 104, link: "https://example.com/old", title: "Old trashed page", domain: "example.com", type: "link",
  tags: [], collection: { $id: -99 }, created: "2026-09-01T00:00:00.000Z", lastUpdate: "2026-11-04T00:00:00.000Z",
};
const SERVER_BOOKMARKS = [...BOOKMARKS, NEW_ON_SERVER];
const SERVER_TRASH = [TRASHED];
/** The sync mark of a seeded store that synced before: older than 103, newer than 101. */
const SYNCED_MARK = "2026-11-01T12:00:00.000Z";
/** Tokens the fake server accepts. Any other token gets a 401. */
const GOOD_TOKENS = new Set(["tok", "new-token"]);

/**
 * The fake Raindrop API. `server.items` adds bookmarks the server holds (cleanup flows).
 * `server.links` answers every request outside the API, as a link check sends it: a map from
 * URL to `(method) => ({ status, url? })`, which may throw to act as a network error. Each such
 * request goes to `linkCalls` as "METHOD url"; a URL with no entry gets a thrown error.
 */
function fakeRaindrop(calls, server = {}, linkCalls = []) {
  // Each run gets its own copy of the server bookmarks, so a PUT reply carries the earlier writes.
  const items = new Map([...SERVER_BOOKMARKS, ...(server.items ?? [])].map((b) => [b._id, structuredClone(b)]));
  return async ([spec]) => {
    if (!spec.url.startsWith(API)) {
      linkCalls.push(`${spec.method} ${spec.url}`);
      const answer = server.links?.[spec.url];
      if (!answer) throw new Error(`fake link server: no answer for ${spec.url}`);
      const { status, url } = await answer(spec.method, spec.headers ?? {});
      return { status, statusText: String(status), headers: { "content-type": "text/html" }, url: url ?? spec.url, bodyBase64: "" };
    }
    const url = new URL(spec.url);
    url.searchParams.delete("_");
    const path = url.href.replace(API, "");
    const body = spec.bodyBase64 ? JSON.parse(Buffer.from(spec.bodyBase64, "base64").toString()) : undefined;
    const auth = spec.headers?.Authorization ?? spec.headers?.authorization ?? "";
    calls.push(`${spec.method} ${path}${body ? " " + JSON.stringify(body) : ""}`);
    const reply = (status, json) => ({
      status, statusText: status === 200 ? "OK" : "Error", headers: { "content-type": "application/json" }, url: spec.url,
      bodyBase64: Buffer.from(JSON.stringify(json)).toString("base64"),
    });
    if (!GOOD_TOKENS.has(auth.replace(/^Bearer /, ""))) return reply(401, { result: false, error: "Unauthorized" });
    const p = url.pathname.replace("/rest/v1", "");
    if (p === "/import/url/parse") {
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (url.searchParams.get("url")?.includes("/failure")) return reply(200, { result: false });
      return reply(200, { result: true, item: { title: "Fetched title", excerpt: "Fetched description" } });
    }
    if (p === "/user") return reply(200, { result: true, user: USER });
    // Bulk trash and restore, as Phase 1 verified them: the path collection filters the IDs.
    const bulk = p.match(/^\/raindrops\/(-?\d+)$/);
    if (bulk && (spec.method === "DELETE" || spec.method === "PUT") && Array.isArray(body?.ids)) {
      const from = Number(bulk[1]);
      const to = spec.method === "DELETE" ? -99 : body.collection?.$id;
      if (spec.method === "DELETE" && (from === -99 || from === 0)) return reply(400, { result: false, error: "fake server: refused bulk delete" });
      let modified = 0;
      for (const id of body.ids) {
        const item = items.get(id);
        if (item && item.collection.$id === from && typeof to === "number") {
          item.collection = { $id: to };
          modified++;
        }
      }
      return reply(200, { result: true, matched: modified, modified });
    }
    const page = Number(url.searchParams.get("page") ?? 0), perpage = Number(url.searchParams.get("perpage") ?? 50);
    const pageOf = (items) => ({ result: true, items: items.slice(page * perpage, (page + 1) * perpage), count: items.length });
    if (p === "/raindrops/0") {
      const sorted = [...SERVER_BOOKMARKS].sort((a, b) => Date.parse(b.lastUpdate) - Date.parse(a.lastUpdate));
      return reply(200, pageOf(sorted));
    }
    if (p === "/raindrops/-99") {
      const cutoff = (url.searchParams.get("search") ?? "").match(/^lastUpdate:>(\d{4}-\d{2}-\d{2})$/)?.[1] ?? "";
      return reply(200, pageOf(SERVER_TRASH.filter((b) => b.lastUpdate > cutoff)));
    }
    if (p === "/collections") return reply(200, { result: true, items: COLLECTIONS });
    if (p === "/collections/childrens") return reply(200, { result: true, items: CHILDREN });
    if (p === "/tags/0") return reply(200, { result: true, items: [{ _id: "rust", count: 1 }, { _id: "read", count: 1 }] });
    if (p === "/raindrop" && spec.method === "POST") {
      // As pleaseParse would: a title and a domain from the page.
      const { pleaseParse: _parse, ...fields } = body ?? {};
      const host = (() => { try { return new URL(fields.link).hostname; } catch { return ""; } })();
      return reply(200, {
        result: true, item: {
          _id: 900, collection: { $id: -1 }, type: "link", created: "2026-11-05T00:00:00.000Z", lastUpdate: "2026-11-05T00:00:00.000Z",
          ...fields, title: fields.title || "Example Domain", domain: host,
        }
      });
    }
    const one = p.match(/^\/raindrop\/(\d+)$/);
    if (one) {
      const found = items.get(Number(one[1]));
      if (!found) return reply(404, { result: false });
      if (spec.method === "PUT") {
        Object.assign(found, body);
        return reply(200, { result: true, item: found });
      }
      if (spec.method === "DELETE") return reply(200, { result: true });
      return reply(200, { result: true, item: found });
    }
    return reply(404, { result: false, error: `fake server: no route for ${spec.method} ${p}` });
  };
}

// ─── Fake Keychain ──────────────────────────────────────────────────

/** Reads one `"…"` argument of a `security -i` line, as secrets.ts quotes it. */
function unquote(line, flag) {
  const m = line.match(new RegExp(`${flag} "((?:[^"\\\\]|\\\\.)*)"`));
  return m ? m[1].replace(/\\(.)/g, "$1") : undefined;
}

// Answers /usr/bin/security from memory. child_process.spawnSync is a sync host
// call (proc.run), which the harness's async stubs do not cover, so this wraps
// invokeSync. Everything else, sqlite3 included, runs for real.
function fakeKeychain(harness, items) {
  const host = harness.context.__tinycastHost;
  const invokeSync = host.invokeSync.bind(host);
  const b64 = (s) => Buffer.from(s).toString("base64");
  host.invokeSync = (api, method, argsJson) => {
    const spec = JSON.parse(argsJson)[0];
    if (api !== "proc" || method !== "run" || spec?.command !== "/usr/bin/security") return invokeSync(api, method, argsJson);
    const [verb, ...rest] = spec.args;
    const account = rest[rest.indexOf("-a") + 1];
    let status = 0, stdout = "";
    if (verb === "find-generic-password") {
      if (items[account] === undefined) status = 44;
      else stdout = `${items[account]}\n`;
    } else if (verb === "delete-generic-password") {
      if (items[account] === undefined) status = 44;
      delete items[account];
    } else if (verb === "-i" && spec.input) {
      const line = Buffer.from(spec.input, "base64").toString();
      const a = unquote(line, "-a"), w = unquote(line, "-w");
      if (line.startsWith("add-generic-password") && unquote(line, "-s") === "tinydrop" && a && w !== undefined) items[a] = w;
      else status = 1;
    } else {
      status = 1;
    }
    return JSON.stringify({ ok: true, value: { stdout: b64(stdout), stderr: "", status } });
  };
}

// ─── Harness ────────────────────────────────────────────────────────

function findAll(node, pred, out = []) {
  if (!node || typeof node !== "object") return out;
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) findAll(c, pred, out);
  for (const v of Object.values(node.props ?? {})) if (v && typeof v === "object" && v.type) findAll(v, pred, out);
  return out;
}

/**
 * A fresh temp supportPath. `seed: true` fills the store with the fake bookmarks;
 * `seed: { bookmarks, state, collections, opens }` fills it with those rows, `sync_state`
 * entries, collection rows, and one open per ID in `opens`.
 */
async function supportDir({ seed = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tinydrop-smoke-"));
  if (seed) {
    const store = new SqliteStore({ path: join(dir, DB_FILE) });
    await store.upsertPage(seed === true ? BOOKMARKS : seed.bookmarks);
    if (seed.state) await store.setSyncState(seed.state);
    if (seed.collections) await store.replaceCollections(seed.collections);
    if (seed.tags) await store.replaceTags(seed.tags);
    for (const id of seed.opens ?? []) await store.recordOpen(id);
    for (const row of seed.checks ?? []) await store.saveLinkCheck(row);
    for (const host of seed.ignored ?? []) await store.addIgnoredHost(host);
  }
  return dir;
}

/** A store that synced before: the server has one new bookmark and one trashed. */
const SYNCED_SEED = { bookmarks: [...BOOKMARKS, TRASHED], state: { sync_mark: SYNCED_MARK } };

/** Reads the store a flow ran against. */
const storeOf = (ctx) => new SqliteStore({ path: join(ctx.supportPath, DB_FILE) });

const tempDirs = [];

/**
 * Runs one command in a fresh harness. `keychain` is the starting Keychain,
 * `interact` drives the screen. Returns the failure count.
 */
async function run(commandName, { args = {}, keychain = { "test-token": "tok" }, seed = false, server = {}, preferences = {}, storage: storageSeed, clipboard = "", confirmations = [], interact } = {}) {
  const cmd = manifest.commands.find((c) => c.name === commandName);
  assert.ok(cmd, `command ${commandName} is in the manifest`);
  const supportPath = await supportDir({ seed });
  tempDirs.push(supportPath);
  const calls = [], linkCalls = [], toasts = [], updates = [], alerts = [], opened = [], copied = [];
  const storage = { ...(storageSeed ?? {}) };
  const harness = createHarness({
    verbose: !!process.env.VERBOSE,
    stubs: {
      "fetch.request": fakeRaindrop(calls, server, linkCalls),
      "feedback.showToast": (a) => { toasts.push(a[0]); return `toast-${toasts.length}`; },
      "feedback.showHUD": (a) => { toasts.push({ hud: a[0] }); return null; },
      "feedback.updateToast": (a) => { updates.push(a[1]); return null; },
      "feedback.hideToast": () => null,
      "feedback.confirmAlert": (a) => { alerts.push(a[0]); return confirmations.shift() ?? true; },
      "storage.get": (a) => storage[a[0]] ?? null,
      "storage.set": (a) => { storage[a[0]] = a[1]; return null; },
      "storage.remove": (a) => { delete storage[a[0]]; return null; },
      "system.open": (a) => { opened.push(a[0]); return null; },
      "clipboard.copy": (a) => { copied.push(a[0]); return null; },
      "clipboard.readText": () => clipboard,
    },
  });
  fakeKeychain(harness, keychain);
  harness.boot(bootConfig({
    environment: { ...bootConfig().environment, extensionName: manifest.name, commandName, commandMode: cmd.mode, assetsPath: join(dist, "assets"), supportPath },
    preferences: { ...Object.fromEntries((manifest.preferences ?? []).map((p) => [p.name, preferenceDefault(p)])), ...preferences },
    launchProps: { arguments: args },
  }));
  const file = join(dist, `${commandName}.js`);
  harness.start("s1", readFileSync(file, "utf8"), file, dist, cmd.mode === "view" ? "view" : "no-view", { launchProps: { arguments: args } });
  await sleep(900);
  console.log(`\n=== ${commandName} ===`);
  if (harness.state.failures.length) console.log("FAILURES:", harness.state.failures);
  let failed = harness.state.failures.length;
  const ctx = { harness, calls, linkCalls, toasts, updates, alerts, opened, copied, storage, keychain, supportPath, tree: () => harness.state.trees.at(-1) };
  if (interact) {
    try {
      await interact(ctx);
      if (harness.state.failures.length > failed) throw new Error(`runtime failure: ${harness.state.failures.slice(failed).join("; ")}`);
    } catch (error) {
      console.log(`✗ ${error.message}`);
      failed += 1;
    }
  }
  const last = ctx.tree();
  if (last && process.env.TREE) console.log(describeTree(last));
  if (process.env.VERBOSE) console.log("calls:", calls, "toasts:", toasts);
  harness.stop("s1");
  return failed;
}

const actionNamed = (tree, title) => findAll(tree, (n) => n.props?.title === title && n.props?.onAction?.$fn)[0];

async function press(ctx, title, wait = 500) {
  const a = actionNamed(ctx.tree(), title);
  assert.ok(a, `action "${title}" exists`);
  ctx.harness.dispatch("s1", a.props.onAction.$fn, []);
  await sleep(wait);
}

async function typeSearch(ctx, text) {
  const list = findAll(ctx.tree(), (n) => n.type === "List" && n.props?.onSearchTextChange?.$fn).at(-1);
  assert.ok(list, "a search bar exists");
  ctx.harness.dispatch("s1", list.props.onSearchTextChange.$fn, [text]);
  await sleep(500);
}

async function setField(ctx, type, id, value) {
  const field = findAll(ctx.tree(), (n) => n.type === type && n.props?.id === id).at(-1);
  assert.ok(field, `${type} "${id}" exists`);
  ctx.harness.dispatch("s1", field.props.onTinycastChange.$fn, [value]);
  await sleep(100);
}

/** Polls until `pred()` is true; the pacer spaces API calls 500 ms apart, so a sync takes seconds. */
async function waitFor(pred, what, ms = 15_000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** Runs a toast's action, as Tinycast does when you press it. */
function runToastAction(ctx, action) {
  assert.ok(action?.token, "the toast action has a token");
  ctx.harness.call(`__tinycast.runToastAction(${JSON.stringify(action.token)})`);
}

const huds = (ctx) => ctx.toasts.filter((t) => t.hud).map((t) => t.hud);
const toastTitles = (ctx) => [...ctx.toasts, ...ctx.updates].map((t) => t.title).filter(Boolean);
const decoded = (calls) => calls.map((c) => decodeURIComponent(c));

/** Picks a value in the search bar's collection dropdown. */
async function pickDropdown(ctx, title) {
  const dropdown = findAll(ctx.tree(), (n) => n.type === "List.Dropdown").at(-1);
  assert.ok(dropdown, "a collection dropdown exists");
  const item = findAll(dropdown, (n) => n.type === "List.Dropdown.Item" && n.props.title === title)[0];
  assert.ok(item, `the dropdown has "${title}"`);
  ctx.harness.dispatch("s1", dropdown.props.onChange.$fn, [item.props.value]);
  await sleep(500);
}

const dropdownTitles = (ctx) =>
  findAll(ctx.tree(), (n) => n.type === "List.Dropdown.Item").map((n) => n.props.title);
const listNode = (ctx) => findAll(ctx.tree(), (n) => n.type === "List").at(-1);
/** The action titles of the first bookmark row. */
const rowActions = (ctx) => {
  const row = findAll(ctx.tree(), (n) => n.type === "List.Item")[0];
  return findAll(row, (n) => n.type === "Action").map((n) => `${n.props.title}${n.props.shortcut ? ` ${[...n.props.shortcut.modifiers, n.props.shortcut.key].join("+")}` : ""}`);
};

const rowTitles = (ctx) => findAll(ctx.tree(), (n) => n.type === "List.Item").map((n) => n.props.title);
const sent = (calls, re) => calls.some((c) => re.test(c));

// ─── Flows ──────────────────────────────────────────────────────────

/** Phase 2: with no token, Search renders the sign-in row. */
async function flowSignedOut() {
  return run("search-bookmarks", {
    keychain: {}, interact: async (ctx) => {
      assert.deepEqual(rowTitles(ctx), ["Sign in with a Raindrop test token"], "the sign-in row");
    }
  });
}

/** Phase 2: signed in, Search reads the store: the empty query lists every row, a word finds one. */
async function flowSearch() {
  return run("search-bookmarks", {
    seed: true, interact: async (ctx) => {
      const titles = rowTitles(ctx);
      assert.ok(titles.includes("Rust ownership explained") && titles.includes("Cooking pasta"), `the store rows: ${titles}`);
      await typeSearch(ctx, "borrow");
      assert.deepEqual(rowTitles(ctx), ["Rust ownership explained"], "a word from a highlight finds the row");
      assert.equal(ctx.calls.length, 0, `search sends no request: ${ctx.calls}`);
      await press(ctx, "Account");
      const query = findAll(ctx.tree(), (n) => n.type === "List.Item" && n.props.title === "Query time")[0];
      assert.match(query?.props.subtitle ?? "", /^p95 \d+ ms over the last 1 search$/, "Account shows the query p95");
    }
  });
}

/** Phase 3: sign in from Account with a pasted token; the account name renders. */
async function flowSignIn() {
  return run("search-bookmarks", {
    keychain: {}, interact: async (ctx) => {
      await press(ctx, "Open Account");
      await press(ctx, "Enter Test Token");
      await setField(ctx, "Form.PasswordField", "token", "new-token");
      await press(ctx, "Save Token", 900);
      assert.equal(ctx.keychain["test-token"], "new-token", "the token is in the Keychain");
      assert.ok(sent(ctx.calls, /^GET \/user$/), `GET /user checks the token: ${ctx.calls}`);
      const titles = rowTitles(ctx);
      assert.ok(titles.includes("Test User"), `Account shows the account name: ${titles}`);
      const plan = findAll(ctx.tree(), (n) => n.type === "List.Item" && n.props.title === "Plan")[0];
      assert.equal(plan?.props.subtitle, "Raindrop free plan", "Account shows the Pro state");
      assert.ok(ctx.toasts.some((t) => t.title === "Signed in as Test User"), "a success toast");
    }
  });
}

/** Phase 3: a token the server rejects shows "Token rejected". */
async function flowTokenRejected() {
  return run("search-bookmarks", {
    keychain: { "test-token": "revoked" }, interact: async (ctx) => {
      await press(ctx, "Account", 900);
      const toast = ctx.toasts.find((t) => t.title === "Token rejected");
      assert.ok(toast, `a "Token rejected" toast: ${JSON.stringify(ctx.toasts)}`);
      assert.ok(rowTitles(ctx).includes("Token rejected"), "Account shows the rejected state");
    }
  });
}

/** Phase 3: sign out deletes the Keychain entry and the database file. */
async function flowSignOut() {
  return run("search-bookmarks", {
    seed: true, interact: async (ctx) => {
      await press(ctx, "Account", 900);
      await press(ctx, "Sign Out", 900);
      assert.equal(ctx.keychain["test-token"], undefined, "the token is gone");
      assert.equal(existsSync(join(ctx.supportPath, DB_FILE)), false, "the database file is gone");
    }
  });
}

/** Phase 4: the Sync command on a store that synced before: one change page, the Trash search, a HUD with the counts. */
async function flowSyncCommand() {
  return run("sync", {
    seed: SYNCED_SEED, interact: async (ctx) => {
      await waitFor(() => huds(ctx).length > 0, "the HUD");
      assert.deepEqual(huds(ctx), ["Synced 2 changes, 1 removed"], "the HUD text");
      const calls = decoded(ctx.calls);
      assert.ok(calls.length <= 6, `6 calls or fewer: ${calls}`);
      assert.ok(calls.includes("GET /raindrops/0?sort=-lastUpdate&perpage=50&page=0"), `the change page: ${calls}`);
      assert.ok(calls.includes("GET /raindrops/-99?perpage=50&page=0&search=lastUpdate:>2026-10-31"), `the Trash search, one day back: ${calls}`);
      for (const path of ["/collections", "/collections/childrens", "/user", "/tags/0"]) assert.ok(calls.includes(`GET ${path}`), `GET ${path}`);
      const store = storeOf(ctx);
      assert.equal((await store.getBookmark(103))?.title, "Zig comptime", "the new bookmark is in the store");
      assert.equal(await store.getBookmark(104), undefined, "the trashed bookmark is gone");
      assert.equal(await store.getSyncState("sync_mark"), "2026-11-03T00:00:00.000Z", "the mark moved to the newest change");
    }
  });
}

/** Phase 4: the first Sync is a full one; then the Sync command with a rejected token. */
async function flowSyncFirstAndRejected() {
  let failed = await run("sync", {
    interact: async (ctx) => {
      await waitFor(() => huds(ctx).length > 0, "the HUD");
      assert.deepEqual(huds(ctx), ["Synced 3 changes"], "the first sync HUD");
      assert.equal(await storeOf(ctx).count(), 3, "the store holds every server bookmark");
      const names = (await storeOf(ctx).collections()).map((c) => c.title);
      assert.deepEqual(names.sort(), ["Dev", "Rust"], "the collections are stored");
    }
  });
  failed += await run("sync", {
    keychain: { "test-token": "revoked" }, interact: async (ctx) => {
      await waitFor(() => huds(ctx).length > 0, "the HUD");
      assert.match(huds(ctx)[0], /^Token rejected/, "the 401 HUD");
    }
  });
  return failed;
}

/** Phase 4: ⌘R in Search shows progress, then the summary, and Search queries the store again. */
async function flowSearchSync() {
  return run("search-bookmarks", {
    seed: SYNCED_SEED, interact: async (ctx) => {
      await typeSearch(ctx, "comptime");
      assert.deepEqual(rowTitles(ctx), ["No bookmark matches"], "no row before the sync");
      await press(ctx, "Sync Now", 100);
      await waitFor(() => toastTitles(ctx).includes("Synced 2 changes, 1 removed"), "the sync summary toast");
      assert.ok(ctx.toasts.some((t) => t.title === "Syncing"), "a progress toast");
      assert.ok(ctx.updates.some((t) => /^Synced \d+/.test(t.message ?? "")), `a progress line: ${JSON.stringify(ctx.updates)}`);
      await waitFor(() => rowTitles(ctx).includes("Zig comptime"), "the new row after the sync");
    }
  });
}

/** Phase 4: ⌘⇧R asks first, with the estimate, then resyncs every bookmark. */
async function flowFullResync() {
  return run("search-bookmarks", {
    seed: SYNCED_SEED, interact: async (ctx) => {
      await press(ctx, "Full Resync", 300);
      assert.equal(ctx.alerts.length, 1, "one confirmation");
      assert.equal(ctx.alerts[0].title, "Full resync: about 5 calls, 1 minute", "the estimate from the stored total");
      await waitFor(() => toastTitles(ctx).includes("Synced 3 changes, 1 removed"), "the full resync summary");
      assert.equal(await storeOf(ctx).getBookmark(104), undefined, "the bookmark the server lacks is gone");
      assert.ok((await storeOf(ctx).getSyncState("last_full_sync")) !== undefined, "the full resync time is stored");
    }
  });
}

/** Phase 4: the 7-day reminder toast; its action resyncs with no confirmation. */
async function flowResyncReminder() {
  const now = Date.now();
  const state = { sync_mark: SYNCED_MARK, last_sync: String(now), last_full_sync: String(now - 10 * 86_400_000) };
  return run("search-bookmarks", {
    seed: { bookmarks: SYNCED_SEED.bookmarks, state }, interact: async (ctx) => {
      await waitFor(() => ctx.toasts.some((t) => t.title === "Full resync suggested"), "the reminder toast");
      const toast = ctx.toasts.find((t) => t.title === "Full resync suggested");
      assert.equal(toast.message, "Last full resync: 10 days ago");
      assert.equal(toast.primaryAction?.title, "Run Full Resync");
      runToastAction(ctx, toast.primaryAction);
      await waitFor(() => toastTitles(ctx).includes("Synced 3 changes, 1 removed"), "the full resync summary");
      assert.equal(ctx.alerts.length, 0, "no confirmation from the reminder");
    }
  });
}

/** Phase 4: refresh on open syncs a stale store when the setting is on, and not when it is off. */
async function flowRefreshOnOpen() {
  let failed = await run("search-bookmarks", {
    seed: SYNCED_SEED, preferences: { refreshOnOpen: true, refreshAge: "1h" }, interact: async (ctx) => {
      await waitFor(() => toastTitles(ctx).includes("Synced 2 changes, 1 removed"), "the refresh-on-open sync");
      await waitFor(() => rowTitles(ctx).includes("Zig comptime"), "the new row");
    }
  });
  failed += await run("search-bookmarks", {
    seed: SYNCED_SEED, interact: async (ctx) => {
      await sleep(500);
      assert.equal(ctx.calls.length, 0, `no sync with the setting off: ${ctx.calls}`);
    }
  });
  return failed;
}

/** Phase 4: ⌘R with a rejected token shows "Token rejected" with Open Account, and the action opens Account. */
async function flowSearchSyncRejected() {
  return run("search-bookmarks", {
    seed: true, keychain: { "test-token": "revoked" }, interact: async (ctx) => {
      await press(ctx, "Sync Now", 100);
      await waitFor(() => ctx.toasts.some((t) => t.title === "Token rejected"), "the Token rejected toast");
      const toast = ctx.toasts.find((t) => t.title === "Token rejected");
      assert.equal(toast.primaryAction?.title, "Open Account", "the toast offers Open Account");
      runToastAction(ctx, toast.primaryAction);
      await waitFor(() => rowTitles(ctx).includes("Enter Test Token") || rowTitles(ctx).includes("Token rejected"), "the Account screen");
    }
  });
}


// ─── Phase 5: Search Bookmarks ──────────────────────────────────────

const SEARCH_COLLECTIONS = [
  { id: 11, title: "Dev", sort: 0, count: 2, group: "My", groupOrder: 0 },
  { id: 12, title: "Rust", parentId: 11, sort: 0, count: 1 },
];
/** A synced store: three bookmarks, the Dev > Rust tree, a sync 5 minutes ago. */
const searchSeed = (extra = {}) => ({
  bookmarks: [...BOOKMARKS, NEW_ON_SERVER],
  collections: SEARCH_COLLECTIONS,
  state: { sync_mark: "2026-11-03T00:00:00.000Z", last_sync: String(Date.now() - 5 * 60_000) },
  ...extra,
});

/** Phase 5: operators, the dropdown with in:, type icons, the sync time in the title, no request. */
async function flowSearchOperators() {
  return run("search-bookmarks", {
    seed: searchSeed(), interact: async (ctx) => {
      await waitFor(() => rowTitles(ctx).length === 3, "the three rows");
      assert.equal(listNode(ctx).props.navigationTitle, "Search Bookmarks · Synced 5 min ago", "the sync time in the title");
      assert.deepEqual(dropdownTitles(ctx), ["All", "Unsorted", "Dev", "Dev > Rust"], "the dropdown choices");
      await typeSearch(ctx, "#rust type:article");
      assert.deepEqual(rowTitles(ctx), ["Rust ownership explained"], "#tag with type:");
      const row = findAll(ctx.tree(), (n) => n.type === "List.Item")[0];
      assert.equal(row.props.subtitle, "doc.rust-lang.org", "the domain");
      assert.ok(JSON.stringify(row.props.icon).includes("paragraph"), `the article icon: ${JSON.stringify(row.props.icon)}`);
      assert.ok(JSON.stringify(row.props.accessories).includes("#rust #read"), "the tags");
      await typeSearch(ctx, "is:fav");
      assert.deepEqual(rowTitles(ctx), ["Cooking pasta"], "is:fav");
      await typeSearch(ctx, 'in:"dev" -zig');
      assert.deepEqual(rowTitles(ctx), ["No bookmark matches"], "in: is the collection itself, minus the excluded word");
      await typeSearch(ctx, "in:Dev");
      assert.deepEqual(rowTitles(ctx), ["Zig comptime"], "in:Dev");
      await pickDropdown(ctx, "Dev > Rust");
      assert.deepEqual(rowTitles(ctx), ["No bookmark matches"], "the dropdown and in: combine with AND");
      await typeSearch(ctx, "");
      assert.deepEqual(rowTitles(ctx), ["Rust ownership explained"], "the dropdown alone");
      await typeSearch(ctx, "in:nope");
      assert.deepEqual(rowTitles(ctx), ['No collection named "nope"'], "an unknown in: name");
      assert.equal(ctx.calls.length, 0, `search sends no request: ${ctx.calls}`);
    }
  });
}

/** Phase 5: ⌘I opens the details panel, LocalStorage keeps it, a new launch starts with it open. */
async function flowDetailsPanel() {
  let failed = await run("search-bookmarks", {
    seed: searchSeed(), interact: async (ctx) => {
      await typeSearch(ctx, "borrow");
      assert.equal(listNode(ctx).props.isShowingDetail, false, "the panel starts closed");
      const actions = rowActions(ctx);
      for (const want of ["Open in Browser", "Show Details cmd+i", "Open in Raindrop cmd+o", "Copy URL cmd+shift+c", "Copy Markdown Link cmd+shift+l", "Sync Now cmd+r", "Full Resync cmd+shift+r", "Account cmd+shift+a"]) {
        assert.ok(actions.includes(want), `row action "${want}": ${actions}`);
      }
      assert.ok(!actions.some((a) => a.endsWith("cmd+return") || a.endsWith("cmd+enter")), "no ⌘↵ binding");
      await press(ctx, "Show Details");
      assert.equal(listNode(ctx).props.isShowingDetail, true, "the panel is open");
      assert.equal(ctx.storage.showDetail, "1", "LocalStorage keeps the state");
      const detail = findAll(ctx.tree(), (n) => n.type === "List.Item.Detail")[0];
      assert.ok(detail, "the row has a detail");
      assert.match(detail.props.markdown, /> borrow checker/, "the highlight in the panel");
      const labels = Object.fromEntries(findAll(detail, (n) => n.type === "Detail.Metadata.Label").map((n) => [n.props.title, n.props.text]));
      assert.equal(labels.Collection, "Dev > Rust", "the collection path");
      assert.equal(labels.Created, "2026-10-01", "the created date");
      assert.equal(labels["Last update"], "2026-11-01", "the last-update date");
      await press(ctx, "Hide Details");
      assert.equal(listNode(ctx).props.isShowingDetail, false, "the panel closes");
      assert.equal(ctx.storage.showDetail, "0");
    }
  });
  failed += await run("search-bookmarks", {
    seed: searchSeed(), storage: { showDetail: "1" }, interact: async (ctx) => {
      await waitFor(() => listNode(ctx)?.props.isShowingDetail === true, "the panel open from LocalStorage");
    }
  });
  return failed;
}

/** Phase 5: ↵ opens the link and records an open, which moves the row up the empty-query list; ⌘O, ⌘⇧C, ⌘⇧L. */
async function flowOpenAndCopy() {
  return run("search-bookmarks", {
    seed: searchSeed({ opens: [102] }), interact: async (ctx) => {
      await waitFor(() => rowTitles(ctx).length === 3, "the three rows");
      assert.equal(rowTitles(ctx)[0], "Cooking pasta", "the opened row comes first");
      await typeSearch(ctx, "zig");
      await press(ctx, "Open in Browser");
      assert.deepEqual(ctx.opened, ["https://ziglang.org/comptime"], "the link opens in the browser");
      const store = storeOf(ctx);
      assert.equal((await store.getBookmark(103))?.openCount, 1, "the open is recorded");
      await press(ctx, "Open in Browser");
      assert.equal((await store.getBookmark(103))?.openCount, 2, "a second open is recorded");
      assert.equal((await store.topOpened())[0].id, 103, "the empty-query order follows the opens");
      await press(ctx, "Open in Raindrop");
      assert.equal(ctx.opened.at(-1), "https://app.raindrop.io/my/11/item/103/web", "the Raindrop web app");
      assert.equal((await store.getBookmark(103))?.openCount, 2, "⌘O counts no open");
      await press(ctx, "Copy URL");
      await press(ctx, "Copy Markdown Link");
      const texts = ctx.copied.map((c) => (typeof c === "string" ? c : c.text));
      assert.deepEqual(texts, ["https://ziglang.org/comptime", "[Zig comptime](https://ziglang.org/comptime)"], "the copied text");
      await typeSearch(ctx, "");
      assert.equal(rowTitles(ctx)[0], "Zig comptime", "a fresh empty query lists the most opened first");
    }
  });
}

// ─── Phase 6: row actions and undo ──────────────────────────────────

/** Presses the action whose title starts with `prefix`, such as "Undo". */
async function pressPrefix(ctx, prefix, wait = 300) {
  const a = findAll(ctx.tree(), (n) => typeof n.props?.title === "string" && n.props.title.startsWith(prefix) && n.props?.onAction?.$fn)[0];
  assert.ok(a, `an action starting with "${prefix}"`);
  ctx.harness.dispatch("s1", a.props.onAction.$fn, []);
  await sleep(wait);
}

const hasActionPrefix = (ctx, prefix) =>
  findAll(ctx.tree(), (n) => typeof n.props?.title === "string" && n.props.title.startsWith(prefix) && n.props?.onAction?.$fn).length > 0;

/** Waits until the fake server has `n` calls. */
const waitCalls = (ctx, n) => waitFor(() => ctx.calls.length >= n, `${n} API call(s): ${ctx.calls}`);

/**
 * Phase 6: favorite, move and delete three bookmarks, then ⌘Z three times. The fake server gets
 * the three writes and the three reverting writes, in order, and the store is back as it was.
 */
async function flowRowWritesAndUndo() {
  return run("search-bookmarks", {
    seed: searchSeed(), interact: async (ctx) => {
      await waitFor(() => rowTitles(ctx).length === 3, "the three rows");
      const actions = rowActions(ctx);
      for (const want of ["Edit Bookmark cmd+e", "Move to Collection… cmd+m", "Toggle Tag… cmd+t", "Move to Trash cmd+backspace", "Add Bookmark cmd+n"]) {
        assert.ok(actions.includes(want), `row action "${want}": ${actions}`);
      }
      assert.ok(actions.some((a) => / cmd\+f$/.test(a) && /Favorites/.test(a)), `a ⌘F favorite action: ${actions}`);
      assert.ok(!actions.some((a) => a.startsWith("Undo")), "no Undo before a write");

      await typeSearch(ctx, "rust ownership");
      await press(ctx, "Add to Favorites", 100);
      await waitCalls(ctx, 1);
      assert.ok(hasActionPrefix(ctx, "Undo"), "⌘Z shows once the stack has an entry");
      assert.ok(rowActions(ctx).includes("Undo Favorite cmd+z"), `the Undo action and key: ${rowActions(ctx)}`);

      await typeSearch(ctx, "pasta");
      await press(ctx, "Move to Collection…", 300);
      await setField(ctx, "Form.Dropdown", "choice", "11");
      await waitCalls(ctx, 2);

      await typeSearch(ctx, "zig");
      await press(ctx, "Move to Trash", 100);
      await waitCalls(ctx, 3);
      await waitFor(() => rowTitles(ctx)[0] === "No bookmark matches", "the trashed row leaves the list");

      for (let i = 0; i < 3; i++) {
        await pressPrefix(ctx, "Undo", 100);
        await waitCalls(ctx, 4 + i);
      }
      await sleep(300);
      assert.deepEqual(ctx.calls, [
        'PUT /raindrop/101 {"important":true}',
        'PUT /raindrop/102 {"collection":{"$id":11}}',
        "DELETE /raindrop/103",
        'PUT /raindrop/103 {"collection":{"$id":11}}',
        'PUT /raindrop/102 {"collection":{"$id":-1}}',
        'PUT /raindrop/101 {"important":false}',
      ], "three writes, then three reverting writes in reverse order");
      assert.ok(!hasActionPrefix(ctx, "Undo"), "the stack is empty after three undos");
      await waitFor(() => rowTitles(ctx).includes("Zig comptime"), "the restored row is back in the list");
      const store = storeOf(ctx);
      assert.equal((await store.getBookmark(101))?.important, false, "101 is not a favorite again");
      assert.deepEqual((await store.getBookmark(101))?.highlights.map((h) => h.text), ["borrow checker"], "the reply keeps the highlight");
      assert.equal((await store.getBookmark(102))?.collectionId, -1, "102 is back in Unsorted");
      assert.equal((await store.getBookmark(103))?.collectionId, 11, "103 is back in Dev");
      const titles = ctx.toasts.map((t) => t.title);
      for (const want of ["Added to favorites", "Moved to Dev", "Moved to Trash", "Undone: Delete"]) assert.ok(titles.includes(want), `toast "${want}": ${titles}`);
    }
  });
}

/** Phase 6: ⌘E sends only the changed field; ⌘T toggles a tag off; ⌘Z puts it back. */
async function flowEditAndTags() {
  return run("search-bookmarks", {
    seed: searchSeed(), interact: async (ctx) => {
      await typeSearch(ctx, "rust ownership");
      await press(ctx, "Edit Bookmark", 300);
      const link = findAll(ctx.tree(), (n) => n.type === "Form.TextField" && n.props.id === "link")[0];
      assert.equal(link?.props.value, "https://doc.rust-lang.org/book/", "the form holds the link");
      await setField(ctx, "Form.TextField", "title", "The Rust book");
      await press(ctx, "Save Changes", 100);
      await waitCalls(ctx, 1);
      await typeSearch(ctx, "rust book");
      await press(ctx, "Toggle Tag…", 300);
      await setField(ctx, "Form.Dropdown", "choice", "read");
      await waitCalls(ctx, 2);
      await pressPrefix(ctx, "Undo Tags", 100);
      await waitCalls(ctx, 3);
      await sleep(200);
      assert.deepEqual(ctx.calls, [
        'PUT /raindrop/101 {"title":"The Rust book"}',
        'PUT /raindrop/101 {"tags":["rust"]}',
        'PUT /raindrop/101 {"tags":["rust","read"]}',
      ], "only the changed fields");
      assert.equal((await storeOf(ctx).getBookmark(101))?.title, "The Rust book", "the store holds the new title");
    }
  });
}

// ─── Phase 7: Add Bookmark ────────────────────────────

const posts = (ctx) => ctx.calls.filter((c) => c.startsWith("POST /raindrop ")).map((c) => JSON.parse(c.slice("POST /raindrop ".length)));

/** The Add form keeps the last collection and warns about duplicates. */
async function flowAddBookmarkForm() {
  let failed = await run("add-bookmark", {
    seed: searchSeed(), clipboard: "https://example.com/new", storage: { lastCollection: "12" }, interact: async (ctx) => {
      await sleep(300);
      const field = (type, id) => findAll(ctx.tree(), (n) => n.type === type && n.props.id === id)[0];
      assert.equal(field("Form.TextField", "link")?.props.value, "https://example.com/new", "the clipboard URL");
      assert.equal(field("Form.Dropdown", "collection")?.props.value, "12", "the last used collection");
      await setField(ctx, "Form.Dropdown", "collection", "11");
      await setField(ctx, "Form.TextField", "title", "New page");
      await press(ctx, "Create Tag");
      await setField(ctx, "Form.TextField", "name", "later");
      await press(ctx, "Add Tag to Bookmark");
      await press(ctx, "Create Tag");
      await setField(ctx, "Form.TextField", "name", "read");
      await press(ctx, "Add Tag to Bookmark");
      await press(ctx, "Save Bookmark", 100);
      await waitCalls(ctx, 1);
      assert.deepEqual(posts(ctx), [{ link: "https://example.com/new", collection: { $id: 11 }, pleaseParse: {}, title: "New page", tags: ["later", "read"] }], "the POST body");
      await waitFor(() => huds(ctx).length > 0, "the HUD");
      assert.equal(ctx.storage.lastCollection, "11", "the collection is kept");
    }
  });
  failed += await run("add-bookmark", {
    seed: searchSeed(), clipboard: "https://ziglang.org/comptime/", confirmations: [false, false, true], interact: async (ctx) => {
      await sleep(300);
      const urlField = () => findAll(ctx.tree(), (n) => n.type === "Form.TextField" && n.props.id === "link")[0];
      assert.equal(urlField()?.props.error, "Duplicate bookmark. Already saved in Dev.", "the URL shows a native colored warning");
      await setField(ctx, "Form.TextField", "link", "https://example.com/unique");
      assert.equal(urlField()?.props.error, undefined, "a different URL clears the warning");
      await setField(ctx, "Form.TextField", "link", "https://ziglang.org/comptime/");
      await waitFor(() => !!urlField()?.props.error, "the duplicate warning returns");
      await press(ctx, "Save Bookmark", 400);
      assert.equal(ctx.alerts[0]?.title, "Bookmark already exists", "Save shows a duplicate confirmation");
      assert.ok(ctx.alerts[0]?.message.includes("Already saved in Dev"), "the confirmation names the collection");
      assert.equal(ctx.calls.length, 0, "Cancel sends no request");
      await press(ctx, "Save Bookmark", 100);
      assert.equal(ctx.calls.length, 0, "another submit still needs confirmation");
      await press(ctx, "Save Bookmark", 100);
      await waitCalls(ctx, 1);
      assert.equal(posts(ctx)[0].collection.$id, -1, "Unsorted with no stored collection");
    }
  });
  return failed;
}

// ─── Phase 8: one end-to-end run ────────────────────────────────────

/**
 * Phase 8: one window, one store, one fake server. Sign in from an empty Keychain, sync the
 * empty store, search, favorite a row, undo it with ⌘Z, then save a bookmark with Add Bookmark
 * that Search finds at once. The fake server sees every call in order.
 */
async function flowEndToEnd() {
  return run("search-bookmarks", {
    keychain: {}, interact: async (ctx) => {
      // Sign in.
      assert.deepEqual(rowTitles(ctx), ["Sign in with a Raindrop test token"], "the sign-in row");
      await press(ctx, "Open Account");
      await press(ctx, "Enter Test Token");
      await setField(ctx, "Form.PasswordField", "token", "new-token");
      await press(ctx, "Save Token", 900);
      assert.equal(ctx.keychain["test-token"], "new-token", "the token is in the Keychain");
      await waitFor(() => rowTitles(ctx).includes("Test User"), "the account name");
      ctx.harness.call('__tinycast.popNavigation("s1")');
      await sleep(500);
      await waitFor(() => rowTitles(ctx).includes("No bookmarks yet"), "Search, signed in, with an empty store");
      const afterSignIn = ctx.calls.length;
      assert.ok(ctx.calls.every((c) => c === "GET /user"), `sign-in calls only GET /user: ${ctx.calls}`);

      // Sync: the first one is a full one.
      await press(ctx, "Sync Now", 100);
      await waitFor(() => toastTitles(ctx).includes("Synced 3 changes"), "the first sync summary");
      await waitFor(() => rowTitles(ctx).length === 3, "the three synced rows");
      assert.equal(await storeOf(ctx).count(), 3, "the store holds every server bookmark");
      const syncCalls = decoded(ctx.calls.slice(afterSignIn));
      assert.ok(syncCalls.includes("GET /raindrops/0?sort=-lastUpdate&perpage=50&page=0"), `the sync pages the server: ${syncCalls}`);
      assert.ok(syncCalls.every((c) => c.startsWith("GET ")), `the sync only reads: ${syncCalls}`);

      // Search.
      await typeSearch(ctx, "rust owner");
      assert.deepEqual(rowTitles(ctx), ["Rust ownership explained"], "search finds the row");
      const afterSync = ctx.calls.length;

      // One row write, then ⌘Z.
      assert.ok(rowActions(ctx).includes("Add to Favorites cmd+f"), `⌘F on the row: ${rowActions(ctx)}`);
      await press(ctx, "Add to Favorites", 100);
      await waitCalls(ctx, afterSync + 1);
      assert.ok(rowActions(ctx).includes("Undo Favorite cmd+z"), `⌘Z after the write: ${rowActions(ctx)}`);
      await pressPrefix(ctx, "Undo", 100);
      await waitCalls(ctx, afterSync + 2);
      await sleep(200);
      assert.deepEqual(ctx.calls.slice(afterSync), [
        'PUT /raindrop/101 {"important":true}',
        'PUT /raindrop/101 {"important":false}',
      ], "the write, then the reverting write");
      assert.ok(!hasActionPrefix(ctx, "Undo"), "the stack is empty after the undo");
      assert.equal((await storeOf(ctx).getBookmark(101))?.important, false, "the store row is back");

      // Add Bookmark, then Search finds the new bookmark.
      await press(ctx, "Add Bookmark", 400);
      await setField(ctx, "Form.TextField", "link", "https://example.com");
      await press(ctx, "Create Tag");
      await setField(ctx, "Form.TextField", "name", "read");
      await press(ctx, "Add Tag to Bookmark");
      await setField(ctx, "Form.Dropdown", "collection", "11");
      await setField(ctx, "Form.Checkbox", "important", true);
      await press(ctx, "Save Bookmark", 100);
      await waitCalls(ctx, afterSync + 3);
      await sleep(600);
      assert.deepEqual(posts(ctx), [{ link: "https://example.com", collection: { $id: 11 }, pleaseParse: {}, tags: ["read"], important: true }], "one POST");
      await typeSearch(ctx, "example domain");
      assert.deepEqual(rowTitles(ctx), ["Example Domain"], "Search finds the Add Bookmark bookmark");
      assert.equal(ctx.calls.length, afterSync + 3, `no other request: ${ctx.calls.slice(afterSync)}`);
    }
  });
}

async function flowTagSuggestions() {
  return run("search-bookmarks", {
    seed: searchSeed({ tags: [{ name: "rust", count: 1 }, { name: "read later", count: 1 }] }),
    interact: async (ctx) => {
      await typeSearch(ctx, "#ru");
      assert.ok(rowTitles(ctx).includes("#rust"), "the stored tag appears");
      assert.ok(!rowTitles(ctx).includes("No bookmark matches"), "suggestions replace the empty row");
      await press(ctx, "Insert Tag");
      await waitFor(() => rowTitles(ctx).includes("Rust ownership explained"), "the completed tag finds bookmarks");
      const list = findAll(ctx.tree(), (n) => n.type === "List").at(-1);
      assert.equal(list.props.searchText, "#rust ", "the search bar receives the completed token");
      assert.ok(!rowTitles(ctx).includes("#rust"), "the trailing space dismisses suggestions");
      await typeSearch(ctx, "type:article #re");
      await press(ctx, "Insert Tag");
      const completed = findAll(ctx.tree(), (n) => n.type === "List").at(-1);
      assert.equal(completed.props.searchText, 'type:article #"read later" ', "other filters remain and spaces are quoted");
      assert.equal(ctx.calls.length, 0, "tag suggestions make no API requests");
    },
  });
}

async function flowTrashConfirmation() {
  return run("search-bookmarks", {
    seed: searchSeed(), confirmations: [false, true],
    interact: async (ctx) => {
      await typeSearch(ctx, "zig");
      await press(ctx, "Move to Trash");
      assert.equal(ctx.alerts.length, 1, "Trash asks for confirmation");
      assert.equal(ctx.alerts[0].title, "Move bookmark to Trash?");
      assert.equal(ctx.alerts[0].message, "Zig comptime");
      assert.equal(ctx.calls.length, 0, "Cancel sends no request");
      assert.equal((await storeOf(ctx).getBookmark(103)).collectionId, 11, "Cancel keeps the row");
      assert.ok(!hasActionPrefix(ctx, "Undo"), "Cancel adds no undo entry");
      await press(ctx, "Move to Trash");
      await waitCalls(ctx, 1);
      assert.equal(ctx.alerts.length, 2, "the next attempt asks again");
      assert.deepEqual(ctx.calls, ["DELETE /raindrop/103"], "confirmation sends one delete");
      await waitFor(() => rowTitles(ctx).includes("No bookmark matches"), "the confirmed row leaves the list");
      assert.ok(hasActionPrefix(ctx, "Undo"), "the confirmed action supports undo");
    },
  });
}

async function flowPageDetails() {
  return run("add-bookmark", {
    seed: searchSeed(), interact: async (ctx) => {
      const value = (type, id) => findAll(ctx.tree(), (n) => n.type === type && n.props.id === id)[0]?.props.value;
      await setField(ctx, "Form.TextField", "link", "invalid");
      await press(ctx, "Fetch Page Details");
      assert.equal(ctx.calls.length, 0, "invalid URLs send no request");
      await setField(ctx, "Form.TextField", "link", "https://example.com/failure");
      await press(ctx, "Fetch Page Details", 600);
      assert.ok(toastTitles(ctx).includes("Could not fetch page details"), "parse failure shows a toast");
      assert.equal(value("Form.TextField", "title"), "", "failure leaves the title unchanged");
      await setField(ctx, "Form.TextField", "link", "https://example.com/old");
      await press(ctx, "Fetch Page Details", 50);
      await setField(ctx, "Form.TextField", "link", "https://example.com/new");
      await sleep(600);
      assert.equal(value("Form.TextField", "title"), "", "an old URL reply does not fill the form");
      await press(ctx, "Fetch Page Details", 600);
      assert.equal(value("Form.TextField", "title"), "Fetched title");
      assert.equal(value("Form.TextArea", "excerpt"), "Fetched description");
      await setField(ctx, "Form.TextField", "title", "My title");
      await setField(ctx, "Form.TextArea", "excerpt", "My description");
      await setField(ctx, "Form.TextArea", "note", "My note");
      await press(ctx, "Fetch Page Details", 600);
      assert.equal(value("Form.TextField", "title"), "My title", "existing titles stay unchanged");
      assert.equal(value("Form.TextArea", "excerpt"), "My description", "existing descriptions stay unchanged");
      assert.ok(ctx.calls.every((call) => call.startsWith("GET /import/url/parse?")), "fetching never creates a bookmark");
      await press(ctx, "Save Bookmark", 700);
      assert.equal(posts(ctx)[0].title, "My title");
      assert.equal(posts(ctx)[0].excerpt, "My description");
      assert.equal(posts(ctx)[0].note, "My note", "notes stay separate from descriptions");
    }
  });
}

async function flowAddDefaultsAndTags() {
  return run("add-bookmark", {
    seed: searchSeed({ collections: [{ id: 11, title: "Bookmarks", sort: 0, count: 0 }], tags: [{ name: "Read", count: 1 }] }),
    clipboard: "https://example.com/new",
    interact: async (ctx) => {
      const field = (type, id) => findAll(ctx.tree(), (n) => n.type === type && n.props.id === id)[0];
      assert.equal(field("Form.Dropdown", "collection").props.value, "11", "Bookmarks is the default");
      assert.equal(field("Form.TextField", "newTags"), undefined, "one field handles all tags");
      assert.ok(findAll(ctx.tree(), (n) => n.type === "Form.TagPicker.Item" && n.props.value === "Read").length > 0, "the picker offers stored tags");
      const pickerId = field("Form.TagPicker", "tags").id;
      await setField(ctx, "Form.TagPicker", "tags", ["Read"]);
      assert.notEqual(field("Form.TagPicker", "tags").id, pickerId, "selection recreates the native picker to clear its private search text");
      assert.deepEqual(field("Form.TagPicker", "tags").props.value, ["Read"], "clearing the search keeps the selected tag");
      await press(ctx, "Create Tag");
      await setField(ctx, "Form.TextField", "name", "brand new");
      await press(ctx, "Add Tag to Bookmark");
      assert.deepEqual(field("Form.TagPicker", "tags").props.value, ["Read", "brand new"], "the new tag joins the selected tags");
      assert.equal(ctx.calls.length, 0, "adding a tag to the draft sends no request");
      await press(ctx, "Create Tag");
      await setField(ctx, "Form.TextField", "name", "read");
      await press(ctx, "Add Tag to Bookmark");
      assert.deepEqual(field("Form.TagPicker", "tags").props.value, ["Read", "brand new"], "existing names do not create duplicates");
      await press(ctx, "Save Bookmark", 700);
      assert.deepEqual(posts(ctx)[0].tags, ["Read", "brand new"], "existing and new tags share one field");
      assert.equal(posts(ctx)[0].collection.$id, 11);
      assert.equal(ctx.storage.lastCollection, "11", "save remembers the selected collection");
    },
  });
}

// ─── Plan 0002 Phase 5: Clean Up Bookmarks ──────────────────────────

/** A server bookmark for the cleanup flows. */
function cleanupItem(id, link, title, collectionId, over = {}) {
  return {
    _id: id, link, title, domain: new URL(link).hostname, type: "link", tags: [], collection: { $id: collectionId },
    created: "2026-10-01T00:00:00.000Z", lastUpdate: "2026-10-01T00:00:00.000Z", ...over,
  };
}

/** The List.Item with this title. */
const itemTitled = (ctx, title) => findAll(ctx.tree(), (n) => n.type === "List.Item" && n.props.title === title)[0];

/** The action titles of the List.Item with this title, in panel order. */
const itemActions = (ctx, title) => {
  const item = itemTitled(ctx, title);
  assert.ok(item, `a row titled "${title}": ${rowTitles(ctx)}`);
  return findAll(item, (n) => n.type === "Action" || n.type === "Action.Push").map((n) => n.props.title);
};

/** Presses an action of the List.Item with this title. */
async function pressIn(ctx, rowTitle, actionTitle, wait = 500) {
  const item = itemTitled(ctx, rowTitle);
  assert.ok(item, `a row titled "${rowTitle}": ${rowTitles(ctx)}`);
  const a = findAll(item, (n) => n.props?.title === actionTitle && n.props?.onAction?.$fn)[0];
  assert.ok(a, `row "${rowTitle}" has action "${actionTitle}"`);
  ctx.harness.dispatch("s1", a.props.onAction.$fn, []);
  await sleep(wait);
}

const accessoryTexts = (ctx, title) => (itemTitled(ctx, title)?.props.accessories ?? []).map((a) => a.text ?? a.tag?.value ?? a.tag);

/** Five duplicate groups and one single bookmark. 232 has a note, so bulk cleanup skips it until approval. */
const DUPLICATE_ITEMS = [
  cleanupItem(201, "https://alpha.test/post", "Alpha 201", 11, { tags: ["a"] }),
  cleanupItem(202, "http://www.alpha.test/post/", "Alpha 202", -1, { tags: ["b"] }),
  cleanupItem(211, "https://beta.test/x", "Beta 211", -1, { important: true }),
  cleanupItem(212, "https://beta.test/x?utm_source=news", "Beta 212", -1),
  cleanupItem(213, "https://beta.test/x#top", "Beta 213", -1),
  cleanupItem(221, "https://gamma.test/a", "Gamma 221", 11),
  cleanupItem(222, "https://gamma.test/a", "Gamma 222", 12),
  cleanupItem(231, "https://delta.test/p", "Delta 231", 11, { important: true }),
  cleanupItem(232, "https://delta.test/p", "Delta 232", 12, { note: "my reading note" }),
  cleanupItem(241, "https://eps.test/q", "Eps 241", -1),
  cleanupItem(242, "https://eps.test/q", "Eps 242", -1),
  cleanupItem(250, "https://single.test/", "Single 250", -1),
];

/**
 * Plan 0002 Phase 5: five duplicate groups. Sync First leads when the last sync is 3 h old. Choose
 * Keeper changes a group's keeper. Trash All Extras asks once with the count, the sync age and the
 * tag-merge undo limit, merges tags with a tags-only PUT, trashes in bulk and skips the annotated
 * extra. Approving that group and Trash Extras empties the list; the rescan finds zero groups.
 * ⌘Z restores the last operation to its original collection.
 */
async function flowCleanupDuplicates() {
  return run("clean-up-bookmarks", {
    seed: {
      bookmarks: DUPLICATE_ITEMS,
      state: { last_sync: String(Date.now() - 3 * 3_600_000) },
      checks: DUPLICATE_ITEMS.map((b) => ({ bookmarkId: b._id, url: b.link, class: "ok", status: 200, reason: "HTTP 200", checkedAt: Date.now() })),
    },
    server: { items: DUPLICATE_ITEMS },
    interact: async (ctx) => {
      assert.deepEqual(dropdownTitles(ctx), ["Duplicates", "Dead Links", "Unsure", "Skipped", "Ignored Hosts"], "the dropdown entries");
      await pickDropdown(ctx, "Duplicates");
      await waitFor(() => rowTitles(ctx).length === 5, `five groups: ${rowTitles(ctx)}`);
      assert.deepEqual(rowTitles(ctx), ["Beta 211", "Alpha 201", "Delta 231", "Eps 241", "Gamma 221"], "each group shows its keeper title");
      assert.deepEqual(accessoryTexts(ctx, "Beta 211"), ["3 bookmarks"], "each group shows its count");
      assert.deepEqual(accessoryTexts(ctx, "Delta 231"), ["1 annotated", "2 bookmarks"], "the annotated extra is flagged");
      const actions = itemActions(ctx, "Delta 231");
      assert.equal(actions[0], "Sync First", `Sync First is the first action when the sync is old: ${actions}`);
      for (const want of ["Trash Extras", "Include Annotated Extras", "Choose Keeper", "Open All", "Trash All Extras"]) {
        assert.ok(actions.includes(want), `group action "${want}": ${actions}`);
      }
      assert.match(listNode(ctx).props.navigationTitle, /Synced 3 h ago/, "the title shows the sync age");
      assert.equal(ctx.calls.length, 0, "duplicate detection sends no request");

      await pressIn(ctx, "Eps 241", "Open All");
      assert.deepEqual(ctx.opened, ["https://eps.test/q", "https://eps.test/q"], "Open All opens every bookmark of the group");

      await pressIn(ctx, "Gamma 221", "Choose Keeper", 300);
      await setField(ctx, "Form.Dropdown", "choice", "222");
      await waitFor(() => rowTitles(ctx).includes("Gamma 222"), "the chosen keeper titles the group");

      await pressIn(ctx, "Beta 211", "Trash All Extras", 100);
      await waitFor(() => toastTitles(ctx).includes("Moved 5 bookmarks to Trash"), `the result toast: ${toastTitles(ctx)}`);
      await waitFor(() => rowTitles(ctx).length === 1, `one group left: ${rowTitles(ctx)}`);
      assert.equal(ctx.alerts.length, 1, "one confirmation for the bulk operation");
      assert.equal(ctx.alerts[0].title, "Move 5 duplicates to Trash?", "the confirmation names the count");
      assert.match(ctx.alerts[0].message, /^Synced 3 h ago\./, "the confirmation names the sync age");
      assert.match(ctx.alerts[0].message, /leaves the merged tags on the keeper/, "the confirmation shows the tag-merge undo limit");
      assert.match(ctx.alerts[0].message, /1 extra with notes or highlights stay/, "the confirmation names the skipped annotated extra");
      const calls = ctx.calls.join("\n");
      assert.ok(ctx.calls.includes('PUT /raindrop/201 {"tags":["a","b"]}'), `the keeper tag merge sends only tags: ${calls}`);
      const trashed = ctx.calls.filter((c) => c.startsWith("DELETE /raindrops/")).flatMap((c) => JSON.parse(c.slice(c.indexOf("{"))).ids);
      assert.deepEqual(trashed.sort(), [202, 212, 213, 221, 242], `bulk trash of the extras, keeper 222 kept: ${calls}`);
      assert.ok(!sent(ctx.calls, /DELETE \/raindrops\/(-99|0) /), "no bulk delete on Trash or 0");
      assert.deepEqual(rowTitles(ctx), ["Delta 231"], "the rescan keeps only the group with the unapproved annotated extra");
      assert.ok(toastTitles(ctx).includes("Moved 5 bookmarks to Trash"), `the result toast: ${toastTitles(ctx)}`);

      await pressIn(ctx, "Delta 231", "Include Annotated Extras");
      assert.equal(ctx.alerts.length, 2, "approval asks first");
      assert.deepEqual(accessoryTexts(ctx, "Delta 231"), ["1 annotated, approved", "2 bookmarks"], "the group shows the approval");
      await pressIn(ctx, "Delta 231", "Trash Extras", 100);
      await waitFor(() => toastTitles(ctx).includes("Moved 1 bookmark to Trash"), `the second result toast: ${toastTitles(ctx)}`);
      await waitFor(() => rowTitles(ctx)[0] === "No duplicate groups", `zero groups after the rescan: ${rowTitles(ctx)}`);
      assert.equal(ctx.alerts.length, 3, "one confirmation for the second operation");
      assert.equal(ctx.alerts[2].title, "Move 1 duplicate to Trash?");
      assert.ok(ctx.calls.includes('DELETE /raindrops/12 {"ids":[232]}'), `the approved annotated extra goes to Trash: ${ctx.calls}`);
      const store = storeOf(ctx);
      for (const id of [202, 212, 213, 221, 232, 242]) assert.equal((await store.getBookmark(id))?.collectionId, -99, `${id} is in Trash`);

      await pressPrefix(ctx, "Undo Trash Extras", 100);
      await waitFor(() => rowTitles(ctx).includes("Delta 231"), "⌘Z brings the last operation back");
      assert.ok(ctx.calls.includes('PUT /raindrops/-99 {"ids":[232],"collection":{"$id":12}}'), `undo restores to the original collection: ${ctx.calls}`);
      assert.equal((await store.getBookmark(232))?.collectionId, 12, "232 is back in its collection");
      assert.equal((await store.getBookmark(202))?.collectionId, -99, "one ⌘Z undoes only the last operation");
      assert.ok(toastTitles(ctx).includes("Undone: Trash Extras"), `the undo toast: ${toastTitles(ctx)}`);
    },
  });
}

/** The link-check bookmarks: one per result class, with fake answers keyed by URL. */
const CHECK_ITEMS = [
  cleanupItem(301, "https://dead.test/old", "Old dead page", 11),
  cleanupItem(302, "https://dead.test/new", "New dead page", 11),
  cleanupItem(303, "https://nohost.test/x", "No such host", 11),
  cleanupItem(304, "https://forbidden.test/x", "Forbidden page", 11),
  cleanupItem(305, "https://fine.test/x", "Fine page", 11),
  cleanupItem(306, "https://moved.test/article/1", "Moved article", 11),
  cleanupItem(307, "https://ignored.test/page", "Ignored page", 11),
  cleanupItem(308, "http://localhost:3000/x", "Local page", 11),
  cleanupItem(309, "https://fresh.test/x", "Fresh page", 11),
];
const DNS_MESSAGE = "A server with the specified hostname could not be found.";
const CHECK_LINKS = {
  "https://dead.test/old": () => ({ status: 404 }),
  "https://dead.test/new": () => ({ status: 404 }),
  "https://nohost.test/x": () => { throw new Error(DNS_MESSAGE); },
  "https://forbidden.test/x": () => ({ status: 403 }),
  "https://fine.test/x": () => ({ status: 200 }),
  "https://moved.test/article/1": () => ({ status: 200, url: "https://moved.test/" }),
};

/**
 * Plan 0002 Phase 5: the dead-link check. Opening Dead Links starts the check. A first 404 is saved
 * as Retry pending and Trash All Dead leaves it out; a resumed pending row whose retry is due gets
 * its GET retry and becomes dead. A thrown DNS-like error is unsure (the runtime cannot identify DNS
 * failure). 403 is unsure, 200 is ok, a redirect to the home page is unsure, an ignored host and
 * localhost are skipped with no request, and a fresh result is not checked again (resume).
 */
async function flowCleanupDeadLinks() {
  const now = Date.now();
  return run("clean-up-bookmarks", {
    seed: {
      bookmarks: CHECK_ITEMS,
      state: { last_sync: String(now - 10 * 60_000) },
      ignored: ["ignored.test"],
      checks: [
        // Closed during a scan: the first 404 came back 3 minutes ago, and the retry is due.
        { bookmarkId: 301, url: "https://dead.test/old", class: "pending", status: 404, reason: "HTTP 404, retry pending", checkedAt: now - 180_000, firstDeadStatus: 404, firstDeadAt: now - 180_000, retryDue: now - 60_000 },
        { bookmarkId: 309, url: "https://fresh.test/x", class: "ok", status: 200, reason: "HTTP 200", checkedAt: now - 3_600_000 },
      ],
    },
    server: { items: CHECK_ITEMS, links: CHECK_LINKS },
    interact: async (ctx) => {
      const dropdown = findAll(ctx.tree(), (n) => n.type === "List.Dropdown").at(-1);
      assert.equal(dropdown.props.value, "duplicates", "Duplicates is the default view");
      assert.equal(ctx.linkCalls.length, 0, "the default view sends no link check");
      await pickDropdown(ctx, "Dead Links");
      await waitFor(() => toastTitles(ctx).includes("Waiting to retry 1 dead link"), `the waiting state: ${toastTitles(ctx)}`);
      const titles = toastTitles(ctx);
      assert.ok(titles.includes("Checking links"), `first-pass progress toast: ${titles}`);
      const firstPass = [...ctx.toasts, ...ctx.updates].filter((t) => t.title === "Checking links").map((t) => t.message).filter(Boolean);
      assert.ok(firstPass.some((m) => /^\d+ of 7/.test(m)), `first-pass progress counts the 7 new targets: ${firstPass}`);
      assert.ok(titles.includes("Retrying dead links"), `retry progress toast: ${titles}`);
      const waiting = [...ctx.toasts, ...ctx.updates].filter((t) => t.title === "Waiting to retry 1 dead link").at(-1);
      assert.match(waiting.message ?? "", /^Next retry at \d\d:\d\d\. Closing keeps it pending\.$/, "the waiting toast names the retry time");
      await waitFor(() => rowTitles(ctx).includes("New dead page") && rowTitles(ctx).includes("Old dead page"), `both dead rows: ${rowTitles(ctx)}`, 5000);

      const store = storeOf(ctx);
      const checks = new Map((await store.linkChecks()).map((c) => [c.bookmarkId, c]));
      assert.equal(checks.get(301)?.class, "dead", "the resumed retry confirms the first 404");
      assert.equal(checks.get(301)?.reason, "HTTP 404 on the first check and the retry");
      assert.equal(checks.get(302)?.class, "pending", "a first 404 waits for its GET retry");
      assert.ok((checks.get(302)?.retryDue ?? 0) >= now + 110_000, "the retry is due two minutes after the first result");
      assert.equal(checks.get(303)?.class, "unsure", "a DNS-like thrown error is unsure");
      // The harness passes a thrown stub error through JSON, so the message may arrive quoted.
      assert.match(checks.get(303)?.reason ?? "", /^network error: "?A server with the specified hostname could not be found\."?$/, "the reason keeps the runtime message");
      assert.deepEqual(checks.get(304) && [checks.get(304).class, checks.get(304).reason], ["unsure", "HTTP 403"], "403 is unsure");
      assert.equal(checks.get(305)?.class, "ok", "200 is ok");
      assert.deepEqual(checks.get(306) && [checks.get(306).class, checks.get(306).reason], ["unsure", "redirected to the home page"], "a home-page redirect is unsure");
      assert.deepEqual(checks.get(307) && [checks.get(307).class, checks.get(307).reason], ["skipped", "ignored host"], "an ignored host is skipped");
      assert.deepEqual(checks.get(308) && [checks.get(308).class, checks.get(308).reason], ["skipped", "localhost"], "localhost is skipped");
      assert.equal(checks.get(309)?.checkedAt, now - 3_600_000, "a fresh result is kept");
      const links = ctx.linkCalls;
      assert.ok(links.includes("HEAD https://nohost.test/x") && links.includes("GET https://nohost.test/x"), `GET fallback after the error: ${links}`);
      assert.deepEqual(links.filter((l) => l.includes("dead.test/old")), ["GET https://dead.test/old"], "resume sends only the GET retry");
      assert.deepEqual(links.filter((l) => l.includes("dead.test/new")), ["HEAD https://dead.test/new"], "no retry before it is due");
      for (const host of ["ignored.test", "localhost", "fresh.test"]) assert.ok(!links.some((l) => l.includes(host)), `no request to ${host}: ${links}`);
      assert.equal(ctx.calls.length, 0, "the check sends no Raindrop call");

      // Dead Links: the dead row and the Retry pending row with its retry time.
      assert.deepEqual(rowTitles(ctx), ["Old dead page", "New dead page"], "dead first, then Retry pending");
      assert.deepEqual(accessoryTexts(ctx, "Old dead page"), ["HTTP 404 on the first check and the retry", "Checked just now"], "reason and check time");
      const [pendingReason, pendingTime] = accessoryTexts(ctx, "New dead page");
      assert.equal(pendingReason, "Retry pending");
      assert.match(pendingTime, /^Retry after \d\d:\d\d$/, "Retry pending shows the earliest retry time");
      const sections = findAll(ctx.tree(), (n) => n.type === "List.Section").map((n) => n.props.title);
      assert.deepEqual(sections, ["Dead", "Retry pending"], "the sections");
      const deadActions = itemActions(ctx, "Old dead page");
      for (const want of ["Open", "Trash", "Trash All Dead", "Ignore Host"]) assert.ok(deadActions.includes(want), `check action "${want}": ${deadActions}`);
      assert.ok(!deadActions.includes("Sync First"), "no Sync First after a recent sync");
      await pressIn(ctx, "Old dead page", "Open");
      assert.deepEqual(ctx.opened, ["https://dead.test/old"], "Open before trash");

      // Unsure and Skipped.
      await pickDropdown(ctx, "Unsure");
      assert.deepEqual(rowTitles(ctx), ["No such host", "Forbidden page", "Moved article"], "Unsure lists the error, the 403 and the home-page redirect");
      await pickDropdown(ctx, "Skipped");
      assert.deepEqual(rowTitles(ctx), ["Local page"], "Skipped hides the ignored host's row");
      assert.ok(!itemActions(ctx, "Local page").includes("Ignore Host"), "no Ignore Host for an excluded link");

      // Ignore Host hides the host's rows; Ignored Hosts lists both hosts; Stop Ignoring removes one.
      await pickDropdown(ctx, "Unsure");
      await pressIn(ctx, "Forbidden page", "Ignore Host", 900);
      assert.deepEqual(rowTitles(ctx), ["No such host", "Moved article"], "the newly ignored host's row leaves the list");
      await pickDropdown(ctx, "Ignored Hosts");
      assert.deepEqual(rowTitles(ctx), ["forbidden.test", "ignored.test"], "the Ignored Hosts view");
      await pressIn(ctx, "ignored.test", "Stop Ignoring", 900);
      assert.deepEqual(rowTitles(ctx), ["forbidden.test"], "Stop Ignoring removes the host");
      assert.equal((await store.linkChecks()).some((c) => c.bookmarkId === 307), false, "its skipped result is gone, so the next check covers it");

      // Trash All Dead: one confirmation, only class dead; the pending 404 stays.
      await pickDropdown(ctx, "Dead Links");
      await pressIn(ctx, "New dead page", "Trash All Dead", 100);
      await waitFor(() => toastTitles(ctx).includes("Moved 1 bookmark to Trash"), `the result toast: ${toastTitles(ctx)}`);
      await waitFor(() => !rowTitles(ctx).includes("Old dead page"), "the trashed row leaves the list");
      const alert = ctx.alerts.at(-1);
      assert.equal(ctx.alerts.length, 1, "one confirmation");
      assert.equal(alert.title, "Move 1 dead link to Trash?", "the count leaves out the pending row");
      assert.match(alert.message, /^Synced 10 min ago\./, "the confirmation names the sync age");
      assert.deepEqual(ctx.calls, ['DELETE /raindrops/11 {"ids":[301]}'], "bulk trash of the confirmed dead row only");
      assert.deepEqual(rowTitles(ctx), ["New dead page"], "the pending row stays until its retry");
      assert.equal((await store.getBookmark(301))?.collectionId, -99, "301 is in Trash");
      assert.ok(itemActions(ctx, "New dead page").includes("Undo Trash All Dead"), "⌘Z offers the cleanup undo");
    },
  });
}

async function flowCleanupMarkLive() {
  const now = Date.now();
  const bookmark = cleanupItem(402, "https://blocked.test/page", "Blocked page", 11);
  let finishRequest;
  const response = new Promise((resolve) => { finishRequest = resolve; });
  try {
    return await run("clean-up-bookmarks", {
      seed: {
        bookmarks: [bookmark], state: { last_sync: String(now) },
        checks: [{ bookmarkId: 402, url: bookmark.link, class: "unsure", status: 403, reason: "HTTP 403", checkedAt: now - 31 * 86_400_000 }],
      },
      server: { links: { [bookmark.link]: () => response } },
      interact: async (ctx) => {
        await pickDropdown(ctx, "Unsure");
        await waitFor(() => ctx.linkCalls.length === 1, "the scan starts a request for the old result");
        const action = findAll(itemTitled(ctx, bookmark.title), (n) => n.props?.title === "Mark as Live")[0];
        assert.deepEqual(action?.props.shortcut, { modifiers: ["cmd"], key: "l" });
        await pressIn(ctx, bookmark.title, "Open");
        assert.deepEqual(ctx.opened, [bookmark.link], "the owner can inspect the link first");
        await pressIn(ctx, bookmark.title, "Mark as Live");
        await waitFor(() => !rowTitles(ctx).includes(bookmark.title), "the manually approved link leaves Unsure");
        assert.ok(toastTitles(ctx).includes("Marked as live"));
        finishRequest({ status: 403 });
        await waitFor(() => !listNode(ctx).props.isLoading, "the scan finishes");
        const [saved] = await storeOf(ctx).linkChecks();
        assert.equal(saved.class, "ok", "the late scan result cannot replace the manual decision");
        assert.equal(saved.reason, "Marked as live by you");
        assert.equal(saved.status, undefined, "manual approval does not invent an HTTP result");
        assert.ok(saved.checkedAt >= now);
        assert.equal((await storeOf(ctx).getBookmark(402)).collectionId, 11, "the bookmark stays in its collection");
        assert.equal(ctx.calls.length, 0, "the action sends no Raindrop request");
        await pickDropdown(ctx, "Dead Links");
        await pickDropdown(ctx, "Unsure");
        assert.ok(!rowTitles(ctx).includes(bookmark.title), "the decision remains after a view change");
      },
    });
  } finally {
    finishRequest({ status: 403 });
  }
}

async function flowCleanupEditLinks() {
  let failures = 0;
  for (const [view, classification] of [["Dead Links", "dead"], ["Unsure", "unsure"], ["Dead Links", "pending"]]) {
    const now = Date.now();
    const bookmark = cleanupItem(401, "https://edit.test/old", "Original title", 11, { note: "Keep this note", tags: ["read"] });
    failures += await run("clean-up-bookmarks", {
      seed: {
        bookmarks: [bookmark], collections: COLLECTIONS, tags: [{ name: "read", count: 1 }],
        state: { last_sync: String(now) },
        checks: [{
          bookmarkId: 401, url: bookmark.link, class: classification, status: classification === "unsure" ? 403 : 404,
          reason: classification === "unsure" ? "HTTP 403" : "HTTP 404", checkedAt: now,
          ...(classification === "pending" ? { firstDeadAt: now, retryDue: now + 120_000 } : {}),
        }],
      },
      server: { items: [bookmark] },
      interact: async (ctx) => {
        await pickDropdown(ctx, view);
        const edit = findAll(itemTitled(ctx, "Original title"), (n) => n.props?.title === "Edit Bookmark")[0];
        assert.ok(edit, `${view} offers Edit Bookmark for ${classification}`);
        assert.deepEqual(edit.props.shortcut, { modifiers: ["cmd"], key: "e" });
        await pressIn(ctx, "Original title", "Edit Bookmark");
        const fieldValue = (type, id) => findAll(ctx.tree(), (n) => n.type === type && n.props.id === id).at(-1)?.props.value;
        assert.equal(fieldValue("Form.TextField", "link"), bookmark.link, "the current URL fills the form");
        assert.equal(fieldValue("Form.TextArea", "note"), "Keep this note");
        assert.deepEqual(fieldValue("Form.TagPicker", "tags"), ["read"]);
        assert.equal(fieldValue("Form.Dropdown", "collection"), "11");
        const save = actionNamed(ctx.tree(), "Save Changes");
        assert.deepEqual(save.props.shortcut, { modifiers: ["cmd"], key: "s" });
        await setField(ctx, "Form.TextField", "title", "Edited title");
        await press(ctx, "Save Changes", 100);
        await waitCalls(ctx, 1);
        await waitFor(() => rowTitles(ctx).includes("Edited title"), "the updated title in the same check view");
        assert.equal(ctx.calls[0], 'PUT /raindrop/401 {"title":"Edited title"}', "only the changed field reaches Raindrop");
        assert.ok(rowActions(ctx).includes("Undo Edit cmd+z"), "the edit has a keyboard undo action");

        await pressIn(ctx, "Edited title", "Edit Bookmark");
        await setField(ctx, "Form.TextField", "link", "https://edit.test/new");
        await press(ctx, "Save Changes", 100);
        await waitCalls(ctx, 2);
        await waitFor(() => !rowTitles(ctx).includes("Edited title"), "the old result leaves the list after a URL change");
        assert.equal((await storeOf(ctx).getBookmark(401)).link, "https://edit.test/new");
        assert.equal(ctx.calls[1], 'PUT /raindrop/401 {"link":"https://edit.test/new"}');
        await pressPrefix(ctx, "Undo Edit", 100);
        await waitCalls(ctx, 3);
        await waitFor(() => rowTitles(ctx).includes("Edited title"), "undo restores the original URL and its check result");
        assert.equal((await storeOf(ctx).getBookmark(401)).link, bookmark.link);
        assert.equal(ctx.calls[2], 'PUT /raindrop/401 {"link":"https://edit.test/old"}');
      },
    });
  }
  return failures;
}

async function flowCleanupDeadLinksCsv() {
  const now = Date.now();
  return run("clean-up-bookmarks", {
    seed: {
      bookmarks: CHECK_ITEMS,
      ignored: ["ignored.test"],
      state: { last_sync: String(now) },
      checks: CHECK_ITEMS.map((b) => ({
        bookmarkId: b._id, url: b.link, checkedAt: now, status: 200, reason: "HTTP 200", class: "ok",
        ...(b._id === 301 || b._id === 307 ? { class: "dead", status: 404, reason: "HTTP 404 on the first check and the retry" } : {}),
        ...(b._id === 302 ? { class: "pending", status: 404, reason: "HTTP 404, retry pending", firstDeadAt: now, retryDue: now + 120_000 } : {}),
        ...(b._id === 303 ? { class: "unsure", reason: "network error" } : {}),
      })),
    },
    interact: async (ctx) => {
      await pickDropdown(ctx, "Dead Links");
      await pressIn(ctx, "Old dead page", "Export Dead Links CSV");
      const directory = join(ctx.supportPath, "exports");
      let files = readdirSync(directory);
      assert.equal(files.length, 1, "one CSV file");
      const csv = readFileSync(join(directory, files[0]), "utf8");
      assert.ok(csv.startsWith('\uFEFF"bookmark_id","title","url","http_status","reason","checked_at"\r\n'));
      assert.ok(csv.includes('"301","Old dead page","https://dead.test/old","404"'));
      assert.equal(csv.split("\r\n").length, 3, "header, one confirmed dead link, trailing CRLF");
      const toast = ctx.toasts.find((t) => t.title === "Exported 1 dead link");
      assert.ok(toast, "the success toast names the count");
      assert.equal(toast.primaryAction.title, "Open Export Folder");
      runToastAction(ctx, toast.primaryAction);
      await waitFor(() => ctx.opened.includes(directory), "the toast opens the export folder");
      await pressIn(ctx, "Old dead page", "Export Dead Links CSV");
      files = readdirSync(directory);
      assert.equal(files.length, 2, "another export preserves the first file");
      assert.ok(files.every((f) => readFileSync(join(directory, f), "utf8") === csv));

      rmSync(directory, { recursive: true });
      writeFileSync(directory, "not a directory");
      await pressIn(ctx, "Old dead page", "Export Dead Links CSV");
      assert.ok(toastTitles(ctx).includes("Could not export dead links"), "a filesystem error produces a failure toast");
      rmSync(directory);
      await pressIn(ctx, "Old dead page", "Ignore Host", 900);
      await press(ctx, "Export Dead Links CSV");
      assert.ok(toastTitles(ctx).includes("No confirmed dead links to export"), "the empty view still offers export");
      assert.equal(existsSync(directory), false, "an empty export writes no file");
      assert.equal(ctx.calls.length, 0, "export sends no Raindrop request");
    },
  });
}

const ONLY = process.env.ONLY;
const FLOWS_ALL = [
  flowSignedOut, flowSearch, flowSignIn, flowTokenRejected, flowSignOut,
  flowSyncCommand, flowSyncFirstAndRejected, flowSearchSync, flowFullResync, flowResyncReminder, flowRefreshOnOpen, flowSearchSyncRejected,
  flowSearchOperators, flowDetailsPanel, flowOpenAndCopy,
  flowRowWritesAndUndo, flowEditAndTags,
  flowAddBookmarkForm,
  flowEndToEnd,
  flowTagSuggestions,
  flowTrashConfirmation,
  flowPageDetails,
  flowAddDefaultsAndTags,
  flowCleanupDuplicates,
  flowCleanupDeadLinks,
  flowCleanupDeadLinksCsv,
  flowCleanupEditLinks,
  flowCleanupMarkLive,
];
/** `ONLY=flowName pnpm smoke …` runs one flow. */
const FLOWS = ONLY ? FLOWS_ALL.filter((f) => f.name === ONLY) : FLOWS_ALL;

let failures = 0;
try {
  for (const flow of FLOWS) {
    const failed = await flow();
    console.log(`${failed ? "✗" : "✓"} ${flow.name}`);
    failures += failed;
  }
} finally {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n✗ ${failures} failure(s)` : "\n✓ smoke passed");
process.exit(failures ? 1 : 0);
