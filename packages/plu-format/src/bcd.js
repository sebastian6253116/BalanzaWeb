/**
 * BCD helpers.
 *
 * The scale stores decimal numbers as packed BCD: one decimal digit per nibble,
 * most significant pair first. This was verified against live traffic, see
 * docs/protocol.md section 4.
 */

/**
 * Encode a non-negative integer as `byteLength` bytes of packed BCD (big-endian).
 * encodeBcd(832, 2) -> <08 32>
 * encodeBcd(11001, 3) -> <01 10 01>
 */
export function encodeBcd(value, byteLength) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`encodeBcd expects a non-negative integer, got ${value}`);
  }
  const maxDigits = byteLength * 2;
  const digits = String(value).padStart(maxDigits, '0');
  if (digits.length > maxDigits) {
    throw new RangeError(`value ${value} does not fit in ${byteLength} BCD byte(s)`);
  }
  const out = Buffer.alloc(byteLength);
  for (let i = 0; i < byteLength; i++) {
    const hi = digits.charCodeAt(i * 2) - 48;
    const lo = digits.charCodeAt(i * 2 + 1) - 48;
    if (hi > 9 || lo > 9) {
      throw new RangeError(`value ${value} is not decimal`);
    }
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** Decode packed BCD bytes back to an integer. */
export function decodeBcd(buf) {
  let digits = '';
  for (const byte of buf) {
    digits += String((byte >> 4) & 0x0f);
    digits += String(byte & 0x0f);
  }
  return Number(digits);
}

/** Encode a 0..99 value into a single BCD byte (e.g. 21 -> 0x21). */
export function encodeBcdByte(value) {
  if (!Number.isInteger(value) || value < 0 || value > 99) {
    throw new RangeError(`encodeBcdByte expects 0..99, got ${value}`);
  }
  return ((Math.floor(value / 10) << 4) | (value % 10)) & 0xff;
}

/** Decode a single BCD byte (0x21 -> 21). */
export function decodeBcdByte(byte) {
  const hi = (byte >> 4) & 0x0f;
  const lo = byte & 0x0f;
  if (hi > 9 || lo > 9) throw new RangeError(`byte 0x${byte.toString(16)} is not BCD`);
  return hi * 10 + lo;
}
