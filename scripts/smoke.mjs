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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

function fakeRaindrop(calls) {
  // Each run gets its own copy of the server bookmarks, so a PUT reply carries the earlier writes.
  const items = new Map(SERVER_BOOKMARKS.map((b) => [b._id, structuredClone(b)]));
  return async ([spec]) => {
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
async function run(commandName, { args = {}, keychain = { "test-token": "tok" }, seed = false, preferences = {}, storage: storageSeed, clipboard = "", confirmations = [], interact } = {}) {
  const cmd = manifest.commands.find((c) => c.name === commandName);
  assert.ok(cmd, `command ${commandName} is in the manifest`);
  const supportPath = await supportDir({ seed });
  tempDirs.push(supportPath);
  const calls = [], toasts = [], updates = [], alerts = [], opened = [], copied = [];
  const storage = { ...(storageSeed ?? {}) };
  const harness = createHarness({
    verbose: !!process.env.VERBOSE,
    stubs: {
      "fetch.request": fakeRaindrop(calls),
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
  const ctx = { harness, calls, toasts, updates, alerts, opened, copied, storage, keychain, supportPath, tree: () => harness.state.trees.at(-1) };
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
