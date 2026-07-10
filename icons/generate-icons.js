'use strict';

/**
 * Gera os ícones PNG (16/48/128) sem dependência externa: desenha um quadradinho
 * arredondado com "barras de legenda" e codifica o PNG na mão (zlib nativo do
 * Node + CRC32 próprio). Rode com: `node icons/generate-icons.js`.
 *
 * É ferramenta de build local, não faz parte do runtime da extensão.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (function () {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // compression / filter / interlace = 0

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filtro "none" por scanline
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = Math.round(size * 0.22);
  // Roxo Teams -> índigo, do topo-esquerda ao rodapé.
  const top = [138, 142, 240];
  const bottom = [92, 96, 200];

  function setPixel(x, y, r, g, b, a) {
    const i = (y * size + x) * 4;
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = a;
  }

  function insideRounded(x, y) {
    const min = 0;
    const max = size - 1;
    const cxs = [radius, max - radius];
    const cys = [radius, max - radius];
    const nearLeft = x < cxs[0];
    const nearRight = x > cxs[1];
    const nearTop = y < cys[0];
    const nearBottom = y > cys[1];
    if ((nearLeft || nearRight) && (nearTop || nearBottom)) {
      const cx = nearLeft ? cxs[0] : cxs[1];
      const cy = nearTop ? cys[0] : cys[1];
      return Math.hypot(x - cx, y - cy) <= radius;
    }
    return x >= min && x <= max && y >= min && y <= max;
  }

  for (let y = 0; y < size; y++) {
    const t = y / (size - 1);
    const r = Math.round(top[0] + (bottom[0] - top[0]) * t);
    const g = Math.round(top[1] + (bottom[1] - top[1]) * t);
    const b = Math.round(top[2] + (bottom[2] - top[2]) * t);
    for (let x = 0; x < size; x++) {
      if (insideRounded(x, y)) setPixel(x, y, r, g, b, 255);
      else setPixel(x, y, 0, 0, 0, 0);
    }
  }

  // Barras brancas horizontais, tipo legendas.
  const bars = [
    { yFactor: 0.36, wFactor: 0.56, alpha: 245 },
    { yFactor: 0.52, wFactor: 0.68, alpha: 245 },
    { yFactor: 0.68, wFactor: 0.42, alpha: 170 },
  ];
  const barHeight = Math.max(1, Math.round(size * 0.09));
  const marginX = Math.round(size * 0.2);
  for (const bar of bars) {
    const y0 = Math.round(size * bar.yFactor);
    const width = Math.round((size - marginX * 2) * bar.wFactor);
    for (let yy = y0; yy < y0 + barHeight && yy < size; yy++) {
      for (let xx = marginX; xx < marginX + width && xx < size; xx++) {
        setPixel(xx, yy, 255, 255, 255, bar.alpha);
      }
    }
  }

  return rgba;
}

for (const size of [16, 48, 128]) {
  const png = encodePng(size, size, draw(size));
  const outPath = path.join(__dirname, 'icon' + size + '.png');
  fs.writeFileSync(outPath, png);
  console.log('gerado', path.basename(outPath), png.length, 'bytes');
}
