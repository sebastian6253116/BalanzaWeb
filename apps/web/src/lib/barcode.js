export const PARITY = [
  'LLLLLL',
  'LLGLGG',
  'LLGGLG',
  'LLGGGL',
  'LGLLGG',
  'LGGLLG',
  'LGGGLL',
  'LGLGLG',
  'LGLGGL',
  'LGGLGL',
];

export const L_PATTERNS = [
  '0001101',
  '0011001',
  '0010011',
  '0111101',
  '0100011',
  '0110001',
  '0101111',
  '0111011',
  '0110111',
  '0001011',
];

export const G_PATTERNS = [
  '0100111',
  '0110011',
  '0011011',
  '0100001',
  '0011101',
  '0111001',
  '0000101',
  '0010001',
  '0001001',
  '0010111',
];

export const R_PATTERNS = [
  '1110010',
  '1100110',
  '1101100',
  '1000010',
  '1011100',
  '1001110',
  '1010000',
  '1000100',
  '1001000',
  '1110100',
];

export const CODE128_PATTERNS = [
  '11011001100',
  '11001101100',
  '11001100110',
  '10010011000',
  '10010001100',
  '10001001100',
  '10011001000',
  '10011000100',
  '10001100100',
  '11001001000',
  '11001000100',
  '11000100100',
  '10110011100',
  '10011011100',
  '10011001110',
  '10111001100',
  '10011101100',
  '10011100110',
  '11001110010',
  '11001011100',
  '11001001110',
  '11011100100',
  '11001110100',
  '11101101110',
  '11101001100',
  '11100101100',
  '11100100110',
  '11101100100',
  '11100110100',
  '11100110010',
  '11011011000',
  '11011000110',
  '11000110110',
  '10100011000',
  '10001011000',
  '10001000110',
  '10110001000',
  '10001101000',
  '10001100010',
  '11010001000',
  '11000101000',
  '11000100010',
  '10110111000',
  '10110001110',
  '10001101110',
  '10111011000',
  '10111000110',
  '10001110110',
  '11101110110',
  '11010001110',
  '11000101110',
  '11011101000',
  '11011100010',
  '11011101110',
  '11101011000',
  '11101000110',
  '11100010110',
  '11101101000',
  '11101100010',
  '11100011010',
  '11101111010',
  '11001000010',
  '11110001010',
  '10100110000',
  '10100001100',
  '10010110000',
  '10010000110',
  '10000101100',
  '10000100110',
  '10110010000',
  '10110000100',
  '10011010000',
  '10011000010',
  '10000110100',
  '10000110010',
  '11000010010',
  '11001010000',
  '11110111010',
  '11000010100',
  '10001111010',
  '10100111100',
  '10010111100',
  '10010011110',
  '10111100100',
  '10011110100',
  '10011110010',
  '11110100100',
  '11110010100',
  '11110010010',
  '11011011110',
  '11011110110',
  '11110110110',
  '10101111000',
  '10100011110',
  '10001011110',
  '10111101000',
  '10111100010',
  '11110101000',
  '11110100010',
  '10111011110',
  '10111101110',
  '11101011110',
  '11110101110',
  '11010000100',
  '11010010000',
  '11010011100',
  '1100011101011',
];

const EAN13_MODULES = 95;
const CODE128_START_B = 104;
const CODE128_STOP = 106;

function modulesToBars(bits) {
  const bars = [];
  let index = 0;
  while (index < bits.length) {
    if (bits[index] === '1') {
      let width = 1;
      while (bits[index + width] === '1') width += 1;
      bars.push({ x: index, width });
      index += width;
    } else {
      index += 1;
    }
  }
  return { bars, modules: bits.length };
}

function normalizeReference(reference) {
  let value = String(reference).trim().toUpperCase();
  value = value.replace(/^(\d+)\.0+$/, '$1');
  value = value.replace(/\./g, '');
  return value.replace(/[^A-Z0-9]/g, '');
}

export function buildRetailCode(reference) {
  const cleaned = normalizeReference(reference);
  const numeric = cleaned.length > 0 && /^[0-9]+$/.test(cleaned);

  if (!numeric) {
    return { reference: cleaned, numeric: false, base: null, checkDigit: null, code: null };
  }

  const base = cleaned.padEnd(12, '0').slice(0, 12);
  let sum = 0;
  for (let index = 0; index < base.length; index += 1) {
    const weight = index % 2 === 0 ? 1 : 3;
    sum += Number(base[index]) * weight;
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  const code = `${base}${checkDigit}`;

  return { reference: cleaned, numeric: true, base, checkDigit, code };
}

export function ean13Bars(code) {
  if (typeof code !== 'string') {
    throw new TypeError('EAN-13 code must be a string.');
  }
  if (!/^[0-9]{13}$/.test(code)) {
    throw new RangeError('EAN-13 code must contain exactly 13 digits.');
  }

  const parity = PARITY[Number(code[0])];
  let bits = '101';

  for (let index = 0; index < 6; index += 1) {
    const digit = Number(code[index + 1]);
    bits += parity[index] === 'G' ? G_PATTERNS[digit] : L_PATTERNS[digit];
  }

  bits += '01010';

  for (let index = 0; index < 6; index += 1) {
    bits += R_PATTERNS[Number(code[index + 7])];
  }

  bits += '101';

  if (bits.length !== EAN13_MODULES) {
    throw new RangeError('EAN-13 encoding produced an invalid module count.');
  }

  return modulesToBars(bits);
}

export function code128Bars(text) {
  if (typeof text !== 'string') {
    throw new TypeError('CODE128 text must be a string.');
  }

  let checksum = CODE128_START_B;
  let bits = CODE128_PATTERNS[CODE128_START_B];

  for (let index = 0; index < text.length; index += 1) {
    const charCode = text.charCodeAt(index);
    if (charCode < 32 || charCode > 126) {
      throw new RangeError(`CODE128 subset B does not support character code ${charCode}.`);
    }
    const value = charCode - 32;
    bits += CODE128_PATTERNS[value];
    checksum += value * (index + 1);
  }

  bits += CODE128_PATTERNS[checksum % 103];
  bits += CODE128_PATTERNS[CODE128_STOP];

  return modulesToBars(bits);
}
