// Tiny greyscale PNG writer, used to hand a QR code to the menu bar app.
//
// Node ships zlib, and PNG's container is a handful of length-prefixed chunks,
// so this is far less code than taking on an image dependency.

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

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

/** Encode an 8-bit greyscale bitmap (row-major, 0-255) as a PNG buffer. */
export function greyscalePng(pixels, width, height) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter type: none
    pixels.copy
      ? pixels.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width)
      : Buffer.from(pixels.subarray(y * width, (y + 1) * width)).copy(raw, y * (width + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 0;  // colour type: greyscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Render a QR module matrix to a PNG, scaled up with a quiet zone. */
export function qrToPng({ size, modules }, { scale = 8, quiet = 4 } = {}) {
  const dim = (size + quiet * 2) * scale;
  const pixels = Buffer.alloc(dim * dim, 255);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!modules[r][c]) continue;
      const y0 = (r + quiet) * scale;
      const x0 = (c + quiet) * scale;
      for (let y = y0; y < y0 + scale; y++) pixels.fill(0, y * dim + x0, y * dim + x0 + scale);
    }
  }
  return greyscalePng(pixels, dim, dim);
}
