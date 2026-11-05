// pnpm bench: seeds 10,000 synthetic bookmarks through the real store module
// (src/store/sqlite.ts, bundled by esbuild, see scripts/lib/load-store.mjs) in
// 200 batches of 50, timing each batch, then runs 50 FTS queries of 1 to 3
// prefix words, 50 queries with the Phase 5 operators (tag, type, collection,
// favorite, exclude, phrase), and 50 empty queries (most opened, then newest)
// over 100 opened bookmarks. Prints p50, p95 and max for the writes and the queries.
// The plan's targets: a query p95 under 40 ms, a batch under 50 ms (on the Mac).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { loadStore } from "./lib/load-store.mjs";

const { SqliteStore, defaultBinary } = await loadStore();
const percentile = (v, p) => [...v].sort((a, b) => a - b)[Math.max(1, Math.ceil((p / 100) * v.length)) - 1];

const BATCHES = 200;
const PER_BATCH = 50;
const QUERIES = 50;

// A fixed seed, so two runs search the same data.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (list) => list[Math.floor(rand() * list.length)];

const WORDS = (
  "rust swift typescript react sqlite search index launcher bookmark design pattern guide tutorial review " +
  "performance database cache network browser keyboard shortcut terminal editor python golang kotlin docker " +
  "kubernetes linux macos window layout color typography grid animation testing deploy release version " +
  "security privacy token oauth server client protocol stream buffer memory thread async promise closure " +
  "recipe pasta coffee travel camera music podcast video article paper history science math physics garden"
).split(" ");
const DOMAINS = ["github.com", "example.com", "medium.com", "dev.to", "news.ycombinator.com", "youtube.com", "arxiv.org", "nytimes.com"];
const TAGS = ["read", "dev", "later", "ref", "fav", "tools", "learn", "work", "home", "video"];
const TYPES = ["link", "article", "image", "video", "document", "audio"];

const sentence = (n) => Array.from({ length: n }, () => pick(WORDS)).join(" ");

function bookmark(id) {
  const domain = pick(DOMAINS);
  const highlights = rand() < 0.2 ? [{ _id: `h${id}`, text: sentence(8), note: rand() < 0.5 ? sentence(4) : "" }] : [];
  return {
    _id: id,
    link: `https://${domain}/${sentence(3).replace(/ /g, "-")}-${id}`,
    title: sentence(4 + Math.floor(rand() * 6)),
    domain,
    type: pick(TYPES),
    tags: Array.from({ length: Math.floor(rand() * 4) }, () => pick(TAGS)),
    note: rand() < 0.3 ? sentence(10) : "",
    excerpt: sentence(25),
    collection: { $id: Math.floor(rand() * 20) + 1 },
    important: rand() < 0.1,
    created: new Date(Date.UTC(2020, 0, 1) + id * 3_600_000).toISOString(),
    lastUpdate: new Date(Date.UTC(2026, 0, 1) + id * 60_000).toISOString(),
    highlights,
  };
}

const stats = (label, times) =>
  console.log(
    `${label.padEnd(28)} n=${String(times.length).padStart(3)}  p50 ${percentile(times, 50).toFixed(1).padStart(6)} ms  p95 ${percentile(times, 95).toFixed(1).padStart(6)} ms  max ${Math.max(...times).toFixed(1).padStart(6)} ms`,
  );

const dir = mkdtempSync(join(tmpdir(), "tinydrop-bench-"));
try {
  const binary = defaultBinary();
  const store = new SqliteStore({ path: join(dir, "tinydrop.sqlite"), binary });
  console.log(`sqlite3: ${binary}`);
  const openStart = performance.now();
  await store.open();
  console.log(`open (feature check, WAL, schema): ${(performance.now() - openStart).toFixed(1)} ms`);

  const writes = [];
  let id = 1;
  const seedStart = performance.now();
  for (let b = 0; b < BATCHES; b++) {
    const page = Array.from({ length: PER_BATCH }, () => bookmark(id++));
    const t = performance.now();
    await store.upsertPage(page);
    writes.push(performance.now() - t);
  }
  const seedMs = performance.now() - seedStart;
  const count = await store.count();
  if (count !== BATCHES * PER_BATCH) throw new Error(`expected ${BATCHES * PER_BATCH} rows, found ${count}`);
  console.log(`seeded ${count} bookmarks in ${(seedMs / 1000).toFixed(2)} s`);

  const queries = [];
  for (let q = 0; q < QUERIES; q++) {
    const n = 1 + Math.floor(rand() * 3);
    const words = Array.from({ length: n }, () => {
      const w = pick(WORDS);
      return w.slice(0, Math.max(2, Math.min(w.length, 2 + Math.floor(rand() * 4))));
    });
    const t = performance.now();
    await store.search({ words });
    queries.push(performance.now() - t);
  }

  for (let o = 0; o < 100; o++) await store.recordOpen(1 + Math.floor(rand() * count));

  const prefix = () => {
    const w = pick(WORDS);
    return w.slice(0, Math.max(2, Math.min(w.length, 2 + Math.floor(rand() * 4))));
  };
  const operators = [];
  for (let q = 0; q < QUERIES; q++) {
    const query = { words: rand() < 0.8 ? [prefix()] : [] };
    if (rand() < 0.5) query.tags = [pick(TAGS)];
    if (rand() < 0.3) query.types = [pick(TYPES)];
    if (rand() < 0.3) query.collectionSets = [[Math.floor(rand() * 20) + 1]];
    if (rand() < 0.2) query.collectionId = Math.floor(rand() * 20) + 1;
    if (rand() < 0.2) query.favorite = true;
    if (rand() < 0.3) query.excludes = [pick(WORDS)];
    if (rand() < 0.2) query.phrases = [`${pick(WORDS)} ${pick(WORDS)}`];
    const t = performance.now();
    await store.search(query);
    operators.push(performance.now() - t);
  }
  const empty = [];
  for (let q = 0; q < QUERIES; q++) {
    const t = performance.now();
    await store.search({ words: [] });
    empty.push(performance.now() - t);
  }

  stats(`write batch (${PER_BATCH} rows)`, writes);
  stats("query (1-3 prefix words)", queries);
  stats("query (operators)", operators);
  stats("query (empty: most opened)", empty);
  stats("query (store ring)", store.queryTimes());
} finally {
  rmSync(dir, { recursive: true, force: true });
}
