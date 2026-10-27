/**
 * 124-byte PLU record used by the scale data stream.
 *
 * Layout verified byte-for-byte against live traffic for all 832 records of the
 * production file (see docs/protocol.md section 4). Field *semantics* come from
 * the vendor grid: `Unidad`, `Departamento`, `Fecha de vali`, `Tipo de empaque`.
 *
 *  offset  size  field
 *  0       72    name, ASCII, space padded
 *  72      1     reserved (0x00)
 *  73      2     LF code, packed BCD big-endian (01 00 = 1, 08 32 = 832)
 *  75      2     reserved (0x00 0x00)
 *  77      3     barcode, packed BCD big-endian, 6 digits (011001 = 11001)
 *  80      1     barcode type (binary; 7 in every verified record)
 *  81      2     reserved
 *  83      2     unit price in cents, packed BCD big-endian (14 50 = 14.50)
 *  85      1     weight/price unit code (binary; 4 = kg, 9/10 = sold by unit)
 *  86      1     department, packed BCD (0x21 = 21)
 *  87      3     reserved
 *  90      2     validity days, uint16 little-endian (6D 01 = 365)
 *  92      1     package flag: 0x00 for .Txp column 10 = 0, 0x80 for column 10 = 2
 *  93      31    unresolved — always zero in every captured record
 */
import { decodeBcd, decodeBcdByte, encodeBcd, encodeBcdByte } from './bcd.js';

export const RECORD_SIZE = 124;
export const NAME_FIELD_SIZE = 72;
const VALIDITY_OFFSET = 90;
const PACKAGE_FLAG_OFFSET = 92;

/** .Txp column 10 value -> record package flag, as observed on the wire. */
export const PACKAGE_FLAG_BY_TYPE = new Map([
  [0, 0x00],
  [2, 0x80],
]);

export function buildRecord(row) {
  if (!row || typeof row !== 'object') throw new TypeError('buildRecord expects a row object');
  const buf = Buffer.alloc(RECORD_SIZE);

  writeAsciiPadded(buf, row.name, 0, NAME_FIELD_SIZE);
  encodeBcd(row.lfCode, 2).copy(buf, 73);
  encodeBcd(row.barcode, 3).copy(buf, 77);
  buf[80] = row.barcodeType;
  encodeBcd(row.priceCents, 2).copy(buf, 83);
  buf[85] = row.unitCode;
  buf[86] = encodeBcdByte(row.department);
  buf.writeUInt16LE(row.validityDays, VALIDITY_OFFSET);
  if (!PACKAGE_FLAG_BY_TYPE.has(row.packageType)) {
    throw new RangeError(`unverified package type ${row.packageType}`);
  }
  buf[PACKAGE_FLAG_OFFSET] = PACKAGE_FLAG_BY_TYPE.get(row.packageType);

  return buf;
}

export function parseRecord(buf) {
  if (buf.length !== RECORD_SIZE) throw new RangeError(`record must be ${RECORD_SIZE} bytes`);
  return {
    name: buf.subarray(0, NAME_FIELD_SIZE).toString('latin1').replace(/ +$/, ''),
    lfCode: decodeBcd(buf.subarray(73, 75)),
    barcode: decodeBcd(buf.subarray(77, 80)),
    barcodeType: buf[80],
    priceCents: decodeBcd(buf.subarray(83, 85)),
    unitCode: buf[85],
    department: decodeBcdByte(buf[86]),
    validityDays: buf.readUInt16LE(VALIDITY_OFFSET),
    packageFlag: buf[PACKAGE_FLAG_OFFSET],
  };
}

function writeAsciiPadded(buf, text, offset, size) {
  const value = String(text ?? '');
  buf.fill(0x20, offset, offset + size);
  for (let i = 0; i < value.length && i < size; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      throw new RangeError(`name contains a non-printable/non-ASCII character at index ${i}: ${JSON.stringify(value)}`);
    }
    buf[offset + i] = code;
  }
}
