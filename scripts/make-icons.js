// Draws the P Mart mark (the same shapes as public/favicon.svg) into PNG and ICO files.
// No third-party image tools or artwork: every pixel comes from the geometry below.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLUE = [0x25, 0x63, 0xeb];
const WHITE = [255, 255, 255];
const GREEN = [0x10, 0xb9, 0x81];
const inDot = (x, y) => (x - 20.5) ** 2 + (y - 22.5) ** 2 <= 2.5 ** 2;

// Shapes on a 32 x 32 grid.
function inRoundedSquare(x, y, r = 6) {
  if (x < 0 || y < 0 || x > 32 || y > 32) return false;
  const cx = Math.min(Math.max(x, r), 32 - r);
  const cy = Math.min(Math.max(y, r), 32 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function inP(x, y) {
  const stem = x >= 10 && x <= 14 && y >= 7 && y <= 25;
  const bowl = (x >= 10 && x <= 17.5 && y >= 7 && y <= 18) || (x >= 17.5 && (x - 17.5) ** 2 + (y - 12.5) ** 2 <= 5.5 ** 2);
  const hole = (x >= 14 && x <= 17.3 && y >= 10.5 && y <= 14.5) || (x >= 17.3 && (x - 17.3) ** 2 + (y - 12.5) ** 2 <= 4);
  return stem || (bowl && !hole);
}

function render(size, { fullBleed = false } = {}) {
  const ss = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let bg = 0; const sum = [0, 0, 0];
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const x = ((i + (sx + 0.5) / ss) / size) * 32;
        const y = ((j + (sy + 0.5) / ss) / size) * 32;
        if (!(fullBleed || inRoundedSquare(x, y))) continue;
        bg++;
        const c = inDot(x, y) ? GREEN : inP(x, y) ? WHITE : BLUE;
        sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2];
      }
      const o = (j * size + i) * 4;
      px[o] = bg ? Math.round(sum[0] / bg) : 0;
      px[o + 1] = bg ? Math.round(sum[1] / bg) : 0;
      px[o + 2] = bg ? Math.round(sum[2] / bg) : 0;
      px[o + 3] = Math.round((bg / (ss * ss)) * 255);
    }
  }
  return px;
}

function png(size, opts) {
  const px = render(size, opts);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]);
}

function ico(images) {
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = []; const datas = [];
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size; e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    offset += data.length; entries.push(e); datas.push(data);
  }
  return Buffer.concat([header, ...entries, ...datas]);
}

const out = (f, buf) => { fs.writeFileSync(path.join(root, 'public', f), buf); console.log(`wrote public/${f} (${buf.length} bytes)`); };
out('favicon.ico', ico([{ size: 16, data: png(16) }, { size: 32, data: png(32) }, { size: 48, data: png(48) }]));
out('apple-touch-icon.png', png(180, { fullBleed: true }));
out('icon-192.png', png(192));
out('icon-512.png', png(512));
