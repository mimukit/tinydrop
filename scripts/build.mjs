// Builds the Raycast-format extension Tinycast loads: dist/package.json,
// dist/assets/, and one CommonJS bundle per command (src/commands/<name>.tsx).
// react, @raycast/api and the Node builtins stay external. With --install, it
// also copies dist/ into Tinycast's extensions folder,
// ~/Library/Application Support/<TINYCAST_BUNDLE_ID>/extensions/tinydrop,
// or into TINYCAST_EXT_DIR when that is set. Copied from tinytick.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
const manifest = JSON.parse(readFileSync(join(root, "src/manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const MAX_BYTES = 300 * 1024;

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "assets"), { recursive: true });

const external = [
  "react",
  "react/jsx-runtime",
  "@raycast/api",
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

await build({
  entryPoints: Object.fromEntries(manifest.commands.map((c) => [c.name, join(root, "src/commands", `${c.name}.tsx`)])),
  outdir: dist,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  jsx: "automatic",
  minify: !process.argv.includes("--dev"),
  external,
  logLevel: "warning",
});

cpSync(join(root, "assets"), join(dist, "assets"), {
  recursive: true,
  filter: (src) => !src.endsWith(".DS_Store"),
});

// Tinycast caches icon bitmaps by file path for the life of the process, so a
// new icon under the same name keeps showing the old one. Name each icon file
// after its content to give a changed icon a new path.
const hashedIcons = new Map();
function hashedIcon(name) {
  if (!name) return name;
  if (!hashedIcons.has(name)) {
    const bytes = readFileSync(join(root, "assets", name));
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
    const ext = extname(name);
    const hashed = `${name.slice(0, -ext.length)}-${hash}${ext}`;
    renameSync(join(dist, "assets", name), join(dist, "assets", hashed));
    hashedIcons.set(name, hashed);
  }
  return hashedIcons.get(name);
}

const distManifest = {
  ...manifest,
  version: pkg.version,
  icon: hashedIcon(manifest.icon),
  commands: manifest.commands.map((c) => (c.icon ? { ...c, icon: hashedIcon(c.icon) } : c)),
};
writeFileSync(join(dist, "package.json"), JSON.stringify(distManifest, null, 2) + "\n");

let failed = false;
for (const c of manifest.commands) {
  const size = statSync(join(dist, `${c.name}.js`)).size;
  const over = size > MAX_BYTES;
  failed ||= over;
  console.log(`${over ? "OVER" : "ok  "} ${c.name}.js ${(size / 1024).toFixed(1)} KB`);
}
if (failed) {
  console.error(`A command bundle is over ${MAX_BYTES / 1024} KB.`);
  process.exit(1);
}

if (process.argv.includes("--install")) {
  const bundleId = process.env.TINYCAST_BUNDLE_ID ?? "com.tinycast.app";
  const target =
    process.env.TINYCAST_EXT_DIR ?? join(homedir(), "Library/Application Support", bundleId, "extensions", manifest.name);
  if (!existsSync(join(target, ".."))) {
    console.error(`No Tinycast extensions folder at ${join(target, "..")}. Install once with "Add from folder", or set TINYCAST_EXT_DIR.`);
    process.exit(1);
  }
  rmSync(target, { recursive: true, force: true });
  cpSync(dist, target, { recursive: true });
  console.log(`Installed to ${target}`);
}
