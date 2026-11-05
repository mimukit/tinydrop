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
/** Tokens the fake server accepts. Any other token gets a 401. */
const GOOD_TOKENS = new Set(["tok", "new-token"]);

function fakeRaindrop(calls) {
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
    if (p === "/user") return reply(200, { result: true, user: USER });
    if (p === "/raindrops/0") return reply(200, { result: true, items: BOOKMARKS, count: BOOKMARKS.length });
    if (p === "/raindrops/-99") return reply(200, { result: true, items: [], count: 0 });
    if (p === "/collections") return reply(200, { result: true, items: COLLECTIONS });
    if (p === "/collections/childrens") return reply(200, { result: true, items: CHILDREN });
    if (p === "/tags/0") return reply(200, { result: true, items: [{ _id: "rust", count: 1 }, { _id: "read", count: 1 }] });
    if (p === "/raindrop" && spec.method === "POST") return reply(200, { result: true, item: { _id: 900, collection: { $id: -1 }, ...body } });
    const one = p.match(/^\/raindrop\/(\d+)$/);
    if (one) {
      const found = BOOKMARKS.find((b) => b._id === Number(one[1]));
      if (!found) return reply(404, { result: false });
      if (spec.method === "PUT") return reply(200, { result: true, item: { ...found, ...body } });
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

/** A fresh temp supportPath; with `seed`, the store already holds the fake bookmarks. */
async function supportDir({ seed = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tinydrop-smoke-"));
  if (seed) await new SqliteStore({ path: join(dir, DB_FILE) }).upsertPage(BOOKMARKS);
  return dir;
}

const tempDirs = [];

/**
 * Runs one command in a fresh harness. `keychain` is the starting Keychain,
 * `interact` drives the screen. Returns the failure count.
 */
async function run(commandName, { args = {}, keychain = { "test-token": "tok" }, seed = false, interact } = {}) {
  const cmd = manifest.commands.find((c) => c.name === commandName);
  assert.ok(cmd, `command ${commandName} is in the manifest`);
  const supportPath = await supportDir({ seed });
  tempDirs.push(supportPath);
  const calls = [], toasts = [];
  const storage = {};
  const harness = createHarness({
    verbose: !!process.env.VERBOSE,
    stubs: {
      "fetch.request": fakeRaindrop(calls),
      "feedback.showToast": (a) => { toasts.push(a[0]); return `toast-${toasts.length}`; },
      "feedback.showHUD": (a) => { toasts.push({ hud: a[0] }); return null; },
      "feedback.confirmAlert": () => true,
      "storage.get": (a) => storage[a[0]] ?? null,
      "storage.set": (a) => { storage[a[0]] = a[1]; return null; },
      "storage.remove": (a) => { delete storage[a[0]]; return null; },
    },
  });
  fakeKeychain(harness, keychain);
  harness.boot(bootConfig({
    environment: { ...bootConfig().environment, extensionName: manifest.name, commandName, commandMode: cmd.mode, assetsPath: join(dist, "assets"), supportPath },
    preferences: Object.fromEntries((manifest.preferences ?? []).map((p) => [p.name, preferenceDefault(p)])),
    launchProps: { arguments: args },
  }));
  const file = join(dist, `${commandName}.js`);
  harness.start("s1", readFileSync(file, "utf8"), file, dist, cmd.mode === "view" ? "view" : "no-view", { launchProps: { arguments: args } });
  await sleep(900);
  console.log(`\n=== ${commandName} ===`);
  if (harness.state.failures.length) console.log("FAILURES:", harness.state.failures);
  let failed = harness.state.failures.length;
  const ctx = { harness, calls, toasts, keychain, supportPath, tree: () => harness.state.trees.at(-1) };
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

const rowTitles = (ctx) => findAll(ctx.tree(), (n) => n.type === "List.Item").map((n) => n.props.title);
const sent = (calls, re) => calls.some((c) => re.test(c));

// ─── Flows ──────────────────────────────────────────────────────────

/** Phase 2: with no token, Search renders the sign-in row. */
async function flowSignedOut() {
  return run("search-bookmarks", { keychain: {}, interact: async (ctx) => {
    assert.deepEqual(rowTitles(ctx), ["Sign in with a Raindrop test token"], "the sign-in row");
  }});
}

/** Phase 2: signed in, Search reads the store: the empty query lists every row, a word finds one. */
async function flowSearch() {
  return run("search-bookmarks", { seed: true, interact: async (ctx) => {
    const titles = rowTitles(ctx);
    assert.ok(titles.includes("Rust ownership explained") && titles.includes("Cooking pasta"), `the store rows: ${titles}`);
    await typeSearch(ctx, "borrow");
    assert.deepEqual(rowTitles(ctx), ["Rust ownership explained"], "a word from a highlight finds the row");
    assert.equal(ctx.calls.length, 0, `search sends no request: ${ctx.calls}`);
    await press(ctx, "Account");
    const query = findAll(ctx.tree(), (n) => n.type === "List.Item" && n.props.title === "Query time")[0];
    assert.match(query?.props.subtitle ?? "", /^p95 \d+ ms over the last 1 search$/, "Account shows the query p95");
  }});
}

/** Phase 3: sign in from Account with a pasted token; the account name renders. */
async function flowSignIn() {
  return run("search-bookmarks", { keychain: {}, interact: async (ctx) => {
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
  }});
}

/** Phase 3: a token the server rejects shows "Token rejected". */
async function flowTokenRejected() {
  return run("search-bookmarks", { keychain: { "test-token": "revoked" }, interact: async (ctx) => {
    await press(ctx, "Account", 900);
    const toast = ctx.toasts.find((t) => t.title === "Token rejected");
    assert.ok(toast, `a "Token rejected" toast: ${JSON.stringify(ctx.toasts)}`);
    assert.ok(rowTitles(ctx).includes("Token rejected"), "Account shows the rejected state");
  }});
}

/** Phase 3: sign out deletes the Keychain entry and the database file. */
async function flowSignOut() {
  return run("search-bookmarks", { seed: true, interact: async (ctx) => {
    await press(ctx, "Account", 900);
    await press(ctx, "Sign Out", 900);
    assert.equal(ctx.keychain["test-token"], undefined, "the token is gone");
    assert.equal(existsSync(join(ctx.supportPath, DB_FILE)), false, "the database file is gone");
  }});
}

/** Phase 2: the placeholder commands start with no runtime failure. */
async function flowPlaceholders() {
  let failed = 0;
  failed += await run("add-bookmark", { interact: async (ctx) => assert.ok(ctx.tree(), "Add Bookmark renders") });
  failed += await run("quick-add", { args: { text: "https://example.com #read" }, interact: async (ctx) => assert.ok(ctx.tree(), "Quick Add renders") });
  failed += await run("sync", { interact: async (ctx) => assert.ok(ctx.toasts.some((t) => t.hud), "Sync shows a HUD") });
  return failed;
}

const FLOWS = [flowSignedOut, flowSearch, flowSignIn, flowTokenRejected, flowSignOut, flowPlaceholders];

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
