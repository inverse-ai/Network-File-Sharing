// Minimal QR encoder (byte mode, versions 1-10, EC levels L and M).
//
// Exists so `nfs url` can put a scannable code in the terminal without adding a
// dependency to a project that advertises having none. Ten versions is far more
// than the job needs -- a LAN URL is ~30 bytes, which fits in version 2 -- but
// the tables are cheap and the extra headroom costs nothing.

// --- GF(256), primitive polynomial 0x11d -----------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];                      // multiply by x
      next[j + 1] ^= gfMul(poly[j], EXP[i]);   // multiply by the root
    }
    poly = next;
  }
  return poly;
}

export function rsEncode(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const rem = new Uint8Array(ecLen);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    for (let i = 0; i < ecLen; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

// --- Version tables: [ecCodewordsPerBlock, [[blockCount, dataCodewords], ...]]
const BLOCKS = {
  L: {
    1: [7, [[1, 19]]],   2: [10, [[1, 34]]],  3: [15, [[1, 55]]],
    4: [20, [[1, 80]]],  5: [26, [[1, 108]]], 6: [18, [[2, 68]]],
    7: [20, [[2, 78]]],  8: [24, [[2, 97]]],  9: [30, [[2, 116]]],
    10: [18, [[2, 68], [2, 69]]]
  },
  M: {
    1: [10, [[1, 16]]],  2: [16, [[1, 28]]],  3: [26, [[1, 44]]],
    4: [18, [[2, 32]]],  5: [24, [[2, 43]]],  6: [16, [[4, 27]]],
    7: [18, [[4, 31]]],  8: [22, [[2, 38], [2, 39]]],
    9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]]
  }
};

const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
};

// Unused-module count that trails the codewords, per version.
const REMAINDER_BITS = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0 };

const EC_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

const dataCapacity = (version, ec) =>
  BLOCKS[ec][version][1].reduce((sum, [count, len]) => sum + count * len, 0);

function chooseVersion(byteLength, ec) {
  for (let version = 1; version <= 10; version++) {
    const countBits = version < 10 ? 8 : 16;
    const needed = Math.ceil((4 + countBits + byteLength * 8) / 8);
    if (needed <= dataCapacity(version, ec)) return version;
  }
  throw new Error(`Payload too long for QR versions 1-10 (${byteLength} bytes)`);
}

// --- Bit stream -------------------------------------------------------------
export function buildCodewords(bytes, version, ec) {
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4);                              // byte mode
  push(bytes.length, version < 10 ? 8 : 16);    // character count
  for (const byte of bytes) push(byte, 8);

  const capacityBits = dataCapacity(version, ec) * 8;
  push(0, Math.min(4, capacityBits - bits.length));   // terminator
  while (bits.length % 8) bits.push(0);
  const pad = [0xec, 0x11];
  for (let i = 0; bits.length < capacityBits; i++) push(pad[i % 2], 8);

  const data = new Uint8Array(bits.length / 8);
  for (let i = 0; i < data.length; i++) {
    for (let b = 0; b < 8; b++) data[i] = (data[i] << 1) | bits[i * 8 + b];
  }
  return data;
}

/** Split into blocks, RS-encode each, then interleave as the spec requires. */
export function interleave(data, version, ec) {
  const [ecLen, groups] = BLOCKS[ec][version];
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (const [count, len] of groups) {
    for (let i = 0; i < count; i++) {
      const block = data.subarray(offset, offset + len);
      offset += len;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, ecLen));
    }
  }

  const out = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return Uint8Array.from(out);
}

// --- Matrix -----------------------------------------------------------------
function blankMatrix(size) {
  return {
    size,
    modules: Array.from({ length: size }, () => new Int8Array(size).fill(0)),
    reserved: Array.from({ length: size }, () => new Uint8Array(size))
  };
}

function placeFunctionPatterns(m, version) {
  const { size, modules, reserved } = m;
  const set = (r, c, v) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    modules[r][c] = v;
    reserved[r][c] = 1;
  };

  const finder = (top, left) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(top + r, left + c, inner && (ring || core) ? 1 : 0);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0;
    set(6, i, bit);
    set(i, 6, bit);
  }

  const centers = ALIGN[version];
  for (const r of centers) {
    for (const c of centers) {
      const nearFinder =
        (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
      if (nearFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const edge = Math.max(Math.abs(dr), Math.abs(dc));
          set(r + dr, c + dc, edge === 1 ? 0 : 1);
        }
      }
    }
  }

  set(size - 8, 8, 1); // the always-dark module

  // Format areas are written after masking; reserve them now.
  for (let i = 0; i < 9; i++) {
    if (!m.reserved[8][i]) { modules[8][i] = 0; reserved[8][i] = 1; }
    if (!m.reserved[i][8]) { modules[i][8] = 0; reserved[i][8] = 1; }
  }
  for (let i = 0; i < 8; i++) {
    modules[8][size - 1 - i] = 0; reserved[8][size - 1 - i] = 1;
    modules[size - 1 - i][8] = 0; reserved[size - 1 - i][8] = 1;
  }

  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
    const bitsVal = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = (bitsVal >> i) & 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      modules[r][c] = bit; reserved[r][c] = 1;
      modules[c][r] = bit; reserved[c][r] = 1;
    }
  }
}

function placeData(m, codewords, version) {
  const { size, modules, reserved } = m;
  const bits = [];
  for (const byte of codewords) {
    for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  }
  for (let i = 0; i < REMAINDER_BITS[version]; i++) bits.push(0);

  let index = 0;
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column is skipped entirely
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue;
        modules[row][col] = index < bits.length ? bits[index] : 0;
        index++;
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

function penalty(modules, size) {
  let score = 0;

  // Rule 1: runs of five or more same-coloured modules.
  const runScore = (get) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  };
  runScore((r, c) => modules[r][c]);
  runScore((c, r) => modules[r][c]);

  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) {
        score += 3;
      }
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns with four light modules beside them.
  const target1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const target2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (get, a, b) => {
    let hit1 = true;
    let hit2 = true;
    for (let k = 0; k < 11; k++) {
      const v = get(a, b + k);
      if (v !== target1[k]) hit1 = false;
      if (v !== target2[k]) hit2 = false;
      if (!hit1 && !hit2) return 0;
    }
    return (hit1 ? 1 : 0) + (hit2 ? 1 : 0);
  };
  for (let a = 0; a < size; a++) {
    for (let b = 0; b + 11 <= size; b++) {
      score += 40 * matches((x, y) => modules[x][y], a, b);
      score += 40 * matches((x, y) => modules[y][x], a, b);
    }
  }

  // Rule 4: deviation from an even split of dark and light.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += modules[r][c];
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

function writeFormat(m, ec, mask) {
  const { size, modules } = m;
  const value = (EC_BITS[ec] << 3) | mask;
  let rem = value;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  const bits = (((value << 10) | rem) ^ 0x5412) >>> 0;

  // The 15 bits are laid down most-significant first, in these two runs. The
  // second copy is 7 modules climbing the left column and then 8 crossing the
  // top row -- the 8th module of that column is the permanently dark one, not
  // a format bit, and treating it as one silently drops a bit and shifts the
  // rest, which produces a symbol that scanners reject outright.
  const copy1 = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
  ];
  const copy2 = [];
  for (let i = 0; i < 7; i++) copy2.push([size - 1 - i, 8]);
  for (let i = 0; i < 8; i++) copy2.push([8, size - 8 + i]);

  for (let k = 0; k < 15; k++) {
    const bit = (bits >> (14 - k)) & 1;
    modules[copy1[k][0]][copy1[k][1]] = bit;
    modules[copy2[k][0]][copy2[k][1]] = bit;
  }
  modules[size - 8][8] = 1;
}

/** Encode `text` and return the finished module matrix. */
export function encode(text, { ec = 'M', forceMask = null } = {}) {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length, ec);
  const size = 17 + version * 4;

  const codewords = interleave(buildCodewords(bytes, version, ec), version, ec);

  let best = null;
  const candidates = forceMask === null ? [0, 1, 2, 3, 4, 5, 6, 7] : [forceMask];
  for (const mask of candidates) {
    const m = blankMatrix(size);
    placeFunctionPatterns(m, version);
    placeData(m, codewords, version);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!m.reserved[r][c] && MASKS[mask](r, c)) m.modules[r][c] ^= 1;
      }
    }
    writeFormat(m, ec, mask);
    const score = penalty(m.modules, size);
    if (!best || score < best.score) best = { score, modules: m.modules, mask };
  }

  return { size, version, mask: best.mask, modules: best.modules };
}

/**
 * Render to ANSI half-blocks.
 *
 * Colours are set explicitly rather than left to the terminal: on a dark theme
 * the default foreground/background would invert the code, and while many
 * scanners cope with an inverted QR, plenty of phone cameras do not.
 */
export function toTerminal(text, { ec = 'M', quiet = 3 } = {}) {
  const { size, modules } = encode(text, { ec });
  const dim = size + quiet * 2;
  const at = (r, c) => {
    const rr = r - quiet;
    const cc = c - quiet;
    return rr >= 0 && cc >= 0 && rr < size && cc < size ? modules[rr][cc] : 0;
  };

  const WHITE_BG = '\x1b[48;2;255;255;255m';
  const BLACK_FG = '\x1b[38;2;0;0;0m';
  const RESET = '\x1b[0m';

  const lines = [];
  for (let r = 0; r < dim; r += 2) {
    let line = WHITE_BG + BLACK_FG;
    for (let c = 0; c < dim; c++) {
      const top = at(r, c);
      const bottom = r + 1 < dim ? at(r + 1, c) : 0;
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line + RESET);
  }
  return lines.join('\n');
}
