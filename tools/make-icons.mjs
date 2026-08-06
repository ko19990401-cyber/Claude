/**
 * PWA用アイコンを生成する（依存パッケージなし）。
 *   node tools/make-icons.mjs
 *
 * 角丸の背景にマイクを描いた PNG を、必要なサイズ分だけ書き出す。
 * 形状は距離関数で表現し、3×3のスーパーサンプリングで縁を滑らかにする。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/icons');
const BG = [0xb4, 0x52, 0x2c]; // --accent
const FG = [0xff, 0xff, 0xff];
const SAMPLES = 3;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** 角丸長方形の符号付き距離（中心 cx,cy／半幅 hw／半高 hh／角丸 r） */
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

/** 下半分だけのリング（マイクを受けるアーチ） */
function sdArch(x, y, cx, cy, radius, thickness) {
  if (y < cy) return 1e9;
  return Math.abs(Math.hypot(x - cx, y - cy) - radius) - thickness / 2;
}

function renderPixel(px, py, size) {
  const s = size;
  const bgD = sdRoundRect(px, py, s / 2, s / 2, s / 2, s / 2, s * 0.22);

  const micD = sdRoundRect(px, py, s * 0.5, s * 0.40, s * 0.105, s * 0.165, s * 0.105);
  const archD = sdArch(px, py, s * 0.5, s * 0.47, s * 0.20, s * 0.05);
  const stemD = sdRoundRect(px, py, s * 0.5, s * 0.735, s * 0.026, s * 0.055, s * 0.026);
  const baseD = sdRoundRect(px, py, s * 0.5, s * 0.80, s * 0.115, s * 0.028, s * 0.028);
  const fgD = Math.min(micD, archD, stemD, baseD);

  if (bgD > 0) return [0, 0, 0, 0];
  return fgD <= 0 ? [...FG, 255] : [...BG, 255];
}

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / SAMPLES;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const [pr, pg, pb, pa] = renderPixel(x + (sx + 0.5) * step, y + (sy + 0.5) * step, size);
          const alpha = pa / 255;
          r += pr * alpha;
          g += pg * alpha;
          b += pb * alpha;
          a += alpha;
        }
      }
      const n = SAMPLES * SAMPLES;
      const offset = (y * size + x) * 4;
      const coverage = a / n;
      pixels[offset] = coverage ? Math.round(r / a) : 0;
      pixels[offset + 1] = coverage ? Math.round(g / a) : 0;
      pixels[offset + 2] = coverage ? Math.round(b / a) : 0;
      pixels[offset + 3] = Math.round(clamp01(coverage) * 255);
    }
  }
  return pixels;
}

// --- 最小限のPNGエンコーダ -------------------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [size, name] of [[192, 'icon-192.png'], [512, 'icon-512.png'], [180, 'apple-touch-icon.png']]) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, encodePng(renderIcon(size), size));
  console.log(`${name}  ${size}×${size}  ${fs.statSync(file).size} bytes`);
}
