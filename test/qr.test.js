// The QR encoder is the one piece here with no runtime feedback loop: a wrong
// symbol looks plausible and simply fails to scan. These lock down the three
// layers that were each independently wrong at some point during development.

import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, rsEncode, buildCodewords } from '../src/qr.js';

test('Reed-Solomon matches the published QR worked example', () => {
  // v1-M, "HELLO WORLD" in alphanumeric mode.
  const data = Uint8Array.from([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]);
  assert.deepEqual(
    Array.from(rsEncode(data, 10)),
    [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]
  );
});

test('byte-mode codewords carry mode, length and payload', () => {
  // 0100 (byte) + 00000101 (len 5) + "hello" + terminator, then EC/11 padding.
  const cw = Array.from(buildCodewords(new TextEncoder().encode('hello'), 1, 'M'));
  assert.deepEqual(cw.slice(0, 7), [0x40, 0x56, 0x86, 0x56, 0xc6, 0xc6, 0xf0]);
  assert.deepEqual(cw.slice(7, 11), [0xec, 0x11, 0xec, 0x11]);
});

test('format information matches the specification table', () => {
  // Every published 15-bit format string for EC level M, masks 0-7.
  const expected = [
    '101010000010010', '101000100100101', '101111001111100', '101101101001011',
    '100010111111001', '100000011001110', '100111110010111', '100101010100000'
  ];
  for (let mask = 0; mask < 8; mask++) {
    const { size, modules } = encode('A', { ec: 'M', forceMask: mask });
    // Copy 1 runs along row 8 then up column 8, most-significant bit first.
    const positions = [
      [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
      [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
    ];
    const copy1 = positions.map(([r, c]) => modules[r][c]).join('');
    assert.equal(copy1, expected[mask], `copy 1, mask ${mask}`);

    // Copy 2 must carry the identical bits: 7 up the column, then 8 across.
    const p2 = [];
    for (let i = 0; i < 7; i++) p2.push([size - 1 - i, 8]);
    for (let i = 0; i < 8; i++) p2.push([8, size - 8 + i]);
    assert.equal(p2.map(([r, c]) => modules[r][c]).join(''), expected[mask], `copy 2, mask ${mask}`);
  }
});

test('the module reserved for the dark module is always dark', () => {
  const { size, modules } = encode('https://192.168.1.1:3443');
  assert.equal(modules[size - 8][8], 1);
});

test('version scales with payload and stays in range', () => {
  assert.equal(encode('A').version, 1);
  assert.equal(encode('x'.repeat(30), { ec: 'L' }).version, 2);
  assert.ok(encode('z'.repeat(180), { ec: 'M' }).version >= 9);
  assert.throws(() => encode('x'.repeat(400)), /too long/);
});

test('finder patterns land in all three corners', () => {
  const { size, modules } = encode('https://192.168.1.156:3443');
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    assert.equal(modules[top][left], 1, 'finder corner');
    assert.equal(modules[top + 1][left + 1], 0, 'finder ring gap');
    assert.equal(modules[top + 3][left + 3], 1, 'finder core');
  }
});
