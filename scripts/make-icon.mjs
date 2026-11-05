// Writes assets/icon.png: a 512x512 PNG with a blue rounded square and a white
// drop. Plain Node (zlib), no image library. Run: node scripts/make-icon.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const SIZE = 512;
const out = join(resolve(import.meta.dirname, ".."), "assets/icon.png");

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Coverage of pixel (x, y) by the rounded square, 0 or 1. */
function inSquare(x, y) {
  const m = 32, r = 96;
  const lo = m + r, hi = SIZE - m - r;
  const cx = Math.min(Math.max(x, lo), hi), cy = Math.min(Math.max(y, lo), hi);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= m && x < SIZE - m && y >= m && y < SIZE - m;
}

/** A drop: a circle with a triangle on top. */
function inDrop(x, y) {
  const cx = 256, cy = 300, r = 110;
  if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) return true;
  const top = 100;
  if (y < top || y > cy) return false;
  const half = ((y - top) / (cy - top)) * r * 0.98;
  return Math.abs(x - cx) <= half;
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  const row = y * (SIZE * 4 + 1);
  raw[row] = 0;
  for (let x = 0; x < SIZE; x++) {
    const i = row + 1 + x * 4;
    if (!inSquare(x, y)) continue;
    const [r, g, b] = inDrop(x, y) ? [255, 255, 255] : [30, 110, 230];
    raw[i] = r;
    raw[i + 1] = g;
    raw[i + 2] = b;
    raw[i + 3] = 255;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
mkdirSync(join(out, ".."), { recursive: true });
writeFileSync(out, png);
console.log(`Wrote ${out} (${png.length} bytes)`);
