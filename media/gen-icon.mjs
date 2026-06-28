// Generates media/forge-icon.png (128x128) — a dark rounded square with an
// orange flame. Pure Node (zlib + manual PNG encoding); no image dependencies.
import * as zlib from "node:zlib";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const S = 128;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function roundedRect(x, y, w, h, r) {
  const dx = Math.max(0, (w / 2 - r) - Math.abs(x - w / 2));
  const dy = Math.max(0, (h / 2 - r) - Math.abs(y - h / 2));
  // inside if within the rounded boundary
  const cx = clamp(x, r, w - r);
  const cy = clamp(y, r, h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (dx >= 0 && dy >= 0 && x > r && x < w - r) || (Math.abs(x - w / 2) <= w / 2 - r) || (Math.abs(y - h / 2) <= h / 2 - r);
}

function flame(x, y) {
  const cx = 64;
  const by = 88; // bulb center
  const R = 30;
  const ty = 24; // tip
  if (y >= by) {
    return (x - cx) ** 2 + (y - by) ** 2 <= R * R;
  }
  if (y >= ty) {
    const t = (y - ty) / (by - ty); // 0 at tip, 1 at bulb
    const half = R * Math.pow(t, 1.35);
    // subtle asymmetric lean for a flame feel
    const lean = (1 - t) * 5 * Math.sin((y - ty) / 14);
    return Math.abs(x - cx - lean) <= half;
  }
  return false;
}

const raw = Buffer.alloc(S * (1 + S * 4));
for (let y = 0; y < S; y++) {
  const rowStart = y * (1 + S * 4);
  raw[rowStart] = 0; // filter: none
  for (let x = 0; x < S; x++) {
    const o = rowStart + 1 + x * 4;
    let r = 0, g = 0, b = 0, a = 0;
    if (roundedRect(x + 0.5, y + 0.5, S, S, 26)) {
      r = 0x20; g = 0x20; b = 0x20; a = 255; // dark surface
    }
    if (flame(x + 0.5, y + 0.5)) {
      const t = clamp((88 - y) / (88 - 24), 0, 1); // 0 bottom, 1 tip
      r = Math.round(lerp(0xd9, 0xf3, t));
      g = Math.round(lerp(0x6a, 0xc6, t));
      b = Math.round(lerp(0x2a, 0x86, t));
      a = 255;
      // bright inner core
      const coreHalf = 30 * Math.pow(clamp((88 - 24 - (88 - y)) / (88 - 24), 0, 1), 1.35) * 0.45;
      if (y < 88 && Math.abs(x - 64) <= coreHalf) {
        r = 0xff; g = 0xe6; b = 0xc2;
      }
    }
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
  }
}

// ---- minimal PNG encoder ----
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const idat = zlib.deflateSync(raw, { level: 9 });
const png = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
fs.writeFileSync(path.join(__dirname, "forge-icon.png"), png);
console.log(`✓ media/forge-icon.png (${S}x${S}, ${png.length} bytes)`);
