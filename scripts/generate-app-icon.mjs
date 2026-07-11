import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SIZE = 1024;
const SS = 3;
const W = SIZE * SS;
const H = SIZE * SS;
const pixels = new Uint8ClampedArray(W * H * 4);

function rgba(hex, alpha = 1) {
  const value = hex.replace("#", "");
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
    a: Math.round(alpha * 255),
  };
}

function blendPixel(x, y, color) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  const srcA = color.a / 255;
  const dstA = pixels[i + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA === 0) return;
  pixels[i] = Math.round((color.r * srcA + pixels[i] * dstA * (1 - srcA)) / outA);
  pixels[i + 1] = Math.round((color.g * srcA + pixels[i + 1] * dstA * (1 - srcA)) / outA);
  pixels[i + 2] = Math.round((color.b * srcA + pixels[i + 2] * dstA * (1 - srcA)) / outA);
  pixels[i + 3] = Math.round(outA * 255);
}

function inRoundedRect(px, py, x, y, w, h, r) {
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function fillRoundedRect(x, y, w, h, r, color) {
  x *= SS; y *= SS; w *= SS; h *= SS; r *= SS;
  const c = rgba(color.hex, color.alpha ?? 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.ceil(x + w);
  const y1 = Math.ceil(y + h);
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      if (inRoundedRect(px + 0.5, py + 0.5, x, y, w, h, r)) blendPixel(px, py, c);
    }
  }
}

function fillRect(x, y, w, h, color) {
  x *= SS; y *= SS; w *= SS; h *= SS;
  const c = rgba(color.hex, color.alpha ?? 1);
  for (let py = Math.floor(y); py < Math.ceil(y + h); py++) {
    for (let px = Math.floor(x); px < Math.ceil(x + w); px++) blendPixel(px, py, c);
  }
}

function strokeRoundedRect(x, y, w, h, r, thickness, color) {
  fillRoundedRect(x, y, w, h, r, color);
  fillRoundedRect(x + thickness, y + thickness, w - thickness * 2, h - thickness * 2, Math.max(0, r - thickness), {
    hex: "#ffffff",
    alpha: 1,
  });
}

function drawMark() {
  const tile = "#ffffff";
  strokeRoundedRect(272, 286, 340, 276, 72, 38, { hex: "#17202a" });
  fillRoundedRect(272 + 38, 286 + 38, 340 - 76, 276 - 76, 46, { hex: tile });

  strokeRoundedRect(402, 392, 350, 284, 72, 42, { hex: "#3b63e6" });
  fillRoundedRect(402 + 42, 392 + 42, 350 - 84, 284 - 84, 44, { hex: tile });

  const line = { hex: "#17202a", alpha: 0.9 };
  const blue = { hex: "#3b63e6", alpha: 1 };
  fillRect(478, 486, 74, 18, blue);
  fillRect(478, 486, 18, 74, blue);
  fillRect(602, 486, 74, 18, line);
  fillRect(658, 486, 18, 74, line);
  fillRect(478, 590, 18, 74, line);
  fillRect(478, 646, 74, 18, line);
  fillRect(602, 646, 74, 18, blue);
  fillRect(658, 590, 18, 74, blue);
}

function downsample() {
  const out = new Uint8ClampedArray(SIZE * SIZE * 4);
  const area = SS * SS;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let yy = 0; yy < SS; yy++) {
        for (let xx = 0; xx < SS; xx++) {
          const i = (((y * SS + yy) * W) + (x * SS + xx)) * 4;
          r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2]; a += pixels[i + 3];
        }
      }
      const o = (y * SIZE + x) * 4;
      out[o] = Math.round(r / area);
      out[o + 1] = Math.round(g / area);
      out[o + 2] = Math.round(b / area);
      out[o + 3] = Math.round(a / area);
    }
  }
  return out;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, data) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    Buffer.from(data.buffer, y * width * 4, width * 4).copy(raw, row + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function resizeNearest(data, size) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.floor((x / size) * SIZE);
      const sy = Math.floor((y / size) * SIZE);
      const src = (sy * SIZE + sx) * 4;
      const dst = (y * size + x) * 4;
      out[dst] = data[src];
      out[dst + 1] = data[src + 1];
      out[dst + 2] = data[src + 2];
      out[dst + 3] = data[src + 3];
    }
  }
  return out;
}

fillRoundedRect(132, 134, 760, 760, 174, { hex: "#17202a", alpha: 0.08 });
fillRoundedRect(126, 122, 760, 760, 174, { hex: "#ffffff", alpha: 1 });
fillRoundedRect(126, 122, 760, 760, 174, { hex: "#dbe3ee", alpha: 0.18 });
fillRoundedRect(146, 142, 720, 720, 154, { hex: "#ffffff", alpha: 1 });
drawMark();

const icon = downsample();
const favicon = resizeNearest(icon, 128);

mkdirSync("public", { recursive: true });
mkdirSync(dirname("app-icon.png"), { recursive: true });
writeFileSync("app-icon.png", encodePng(SIZE, SIZE, icon));
writeFileSync("public/favicon.png", encodePng(128, 128, favicon));
console.log("Generated app-icon.png and public/favicon.png");
