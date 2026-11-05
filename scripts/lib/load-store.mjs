// Loads src/store/sqlite.ts in Node for scripts (bench, smoke seeding): esbuild
// bundles it to one ESM file in a temp folder, then the script imports it. The
// store imports between its files without extensions, which Node's own type
// stripping cannot resolve.
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function loadStore() {
  const dir = mkdtempSync(join(tmpdir(), "tinydrop-store-mod-"));
  const outfile = join(dir, "store.mjs");
  try {
    await build({
      entryPoints: [resolve(import.meta.dirname, "../../src/store/sqlite.ts")],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "warning",
    });
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
