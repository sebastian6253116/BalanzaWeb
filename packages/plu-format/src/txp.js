/**
 * .Txp master file parsing.
 *
 * Format (verified against BaseDatosBalanza/PLU BALANZA FARMAVID.Txp):
 *   - one record per line, CRLF terminated
 *   - 26 TAB separated columns, no header row
 *   - plain ASCII (the vendor file contains zero bytes > 0x7F)
 *
 * Column semantics confirmed against the vendor grid ("PLU manager"):
 *   0 Teclado (keyboard slot)     5 Precio unit. (cents)     10 Tipo de empaque code
 *   1 Nombre                      6 Unidad code               11..25 unverified
 *   2 LF Code                     7 Departamento
 *   3 Codigo                      8 Peso PT (pack weight)
 *   4 Tipo de codigo de barras    9 Fecha de validez (days)
 *
 * Every column is preserved verbatim in `raw` so a file round-trips unchanged.
 */
import { readFileSync } from 'node:fs';

export const COLUMN = {
  PLU_NUMBER: 0,
  NAME: 1,
  LF_CODE: 2,
  BARCODE: 3,
  BARCODE_TYPE: 4,
  PRICE_CENTS: 5,
  UNIT_CODE: 6,
  DEPARTMENT: 7,
  PACK_WEIGHT: 8,
  VALIDITY_DAYS: 9,
  PACKAGE_TYPE: 10,
};

export const EXPECTED_COLUMNS = 26;

/** Parse .Txp text into rows. Throws on structural problems. */
export function parseTxpText(text) {
  if (typeof text !== 'string') throw new TypeError('parseTxpText expects a string');
  const lines = text.split(/\r\n|\n/).filter((line) => line.length > 0);
  const rows = [];
  lines.forEach((line, index) => {
    const raw = line.split('\t');
    if (raw.length !== EXPECTED_COLUMNS) {
      throw new Error(`line ${index + 1}: expected ${EXPECTED_COLUMNS} columns, got ${raw.length}`);
    }
    rows.push({
      line: index + 1,
      raw,
      pluNumber: Number(raw[COLUMN.PLU_NUMBER]),
      name: raw[COLUMN.NAME],
      lfCode: Number(raw[COLUMN.LF_CODE]),
      barcode: Number(raw[COLUMN.BARCODE]),
      barcodeType: Number(raw[COLUMN.BARCODE_TYPE]),
      priceCents: Number(raw[COLUMN.PRICE_CENTS]),
      unitCode: Number(raw[COLUMN.UNIT_CODE]),
      department: Number(raw[COLUMN.DEPARTMENT]),
      packWeight: raw[COLUMN.PACK_WEIGHT],
      validityDays: Number(raw[COLUMN.VALIDITY_DAYS]),
      packageType: Number(raw[COLUMN.PACKAGE_TYPE]),
    });
  });
  return rows;
}

export function parseTxpFile(path) {
  return parseTxpText(readFileSync(path, 'utf8'));
}

/** Serialize rows back to .Txp text (CRLF, no trailing blank line). */
export function serializeTxp(rows) {
  return rows.map((row) => row.raw.join('\t')).join('\r\n') + '\r\n';
}
