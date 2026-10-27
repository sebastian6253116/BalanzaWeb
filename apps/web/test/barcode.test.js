import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRetailCode,
  code128Bars,
  ean13Bars,
  CODE128_PATTERNS,
  G_PATTERNS,
  L_PATTERNS,
  PARITY,
  R_PATTERNS,
} from '../src/lib/barcode.js';

function expand(bars, modules) {
  const bits = new Array(modules).fill('0');
  for (const bar of bars) {
    for (let offset = 0; offset < bar.width; offset += 1) {
      bits[bar.x + offset] = '1';
    }
  }
  return bits.join('');
}

test('computes the known EAN-13 check digits', () => {
  const vectors = [
    ['590123412345', '5901234123457'],
    ['400638133393', '4006381333931'],
    ['978020137962', '9780201379624'],
  ];

  for (const [base, full] of vectors) {
    const result = buildRetailCode(base);
    assert.equal(result.numeric, true);
    assert.equal(result.base, base);
    assert.equal(result.checkDigit, Number(full[12]));
    assert.equal(result.code, full);
  }
});

test('pads numeric references on the right and truncates beyond 12 digits', () => {
  assert.equal(buildRetailCode('12345').base, '123450000000');
  assert.equal(buildRetailCode('123456789012').base, '123456789012');
  assert.equal(buildRetailCode('1234567890123').base, '123456789012');
  assert.equal(buildRetailCode('1234567890123456').base, '123456789012');
});

test('treats the Excel decimal artifact 12345.0 as 12345', () => {
  assert.deepEqual(buildRetailCode('12345.0'), buildRetailCode('12345'));
  assert.deepEqual(buildRetailCode(' 12345.00 '), buildRetailCode('12345'));
});

test('flags non-numeric references and omits the check digit', () => {
  const result = buildRetailCode('abc-123');
  assert.equal(result.reference, 'ABC123');
  assert.equal(result.numeric, false);
  assert.equal(result.base, null);
  assert.equal(result.checkDigit, null);
  assert.equal(result.code, null);
});

test('exports the EAN-13 parity and digit tables', () => {
  assert.equal(PARITY.length, 10);
  assert.equal(PARITY[0], 'LLLLLL');
  assert.equal(PARITY[1], 'LLGLGG');
  assert.equal(L_PATTERNS.length, 10);
  assert.equal(L_PATTERNS[0], '0001101');
  assert.equal(G_PATTERNS.length, 10);
  assert.equal(G_PATTERNS[0], '0100111');
  assert.equal(R_PATTERNS.length, 10);
  assert.equal(R_PATTERNS[0], '1110010');
});

test('builds the 95-module EAN-13 geometry with the three guards', () => {
  const { bars, modules } = ean13Bars('5901234123457');
  assert.equal(modules, 95);

  const bits = expand(bars, modules);
  assert.equal(bits.length, 95);
  assert.ok(bits.startsWith('101'));
  assert.equal(bits.slice(45, 50), '01010');
  assert.ok(bits.endsWith('101'));

  for (const offset of [0, 2, 46, 48, 92, 94]) {
    assert.ok(
      bars.some((bar) => bar.x === offset),
      `expected a bar starting at module ${offset}`,
    );
  }
});

test('rejects invalid EAN-13 input', () => {
  assert.throws(() => ean13Bars('59012341234'), RangeError);
  assert.throws(() => ean13Bars('590123412345a'), RangeError);
  assert.throws(() => ean13Bars(5901234123457), TypeError);
});

test('encodes CODE128 subset B with the documented checksum', () => {
  const text = 'ABC';
  const { bars, modules } = code128Bars(text);

  const values = [...text].map((character) => character.charCodeAt(0) - 32);
  const checksum = (104 + values.reduce((sum, value, index) => sum + value * (index + 1), 0)) % 103;

  assert.equal(checksum, 1);
  assert.equal(modules, 11 * (text.length + 3) + 2);
  assert.equal(CODE128_PATTERNS[106], '1100011101011');

  const bits = expand(bars, modules);
  assert.ok(bits.startsWith(CODE128_PATTERNS[104]));
  assert.equal(bits.slice(44, 55), CODE128_PATTERNS[checksum]);
  assert.ok(bits.endsWith(CODE128_PATTERNS[106]));
});

test('rejects unsupported CODE128 characters', () => {
  assert.throws(() => code128Bars('A\u00f1'), RangeError);
  assert.throws(() => code128Bars('A\tB'), RangeError);
  assert.throws(() => code128Bars(42), TypeError);
});
