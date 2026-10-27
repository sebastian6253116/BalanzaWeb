export { encodeBcd, decodeBcd, encodeBcdByte, decodeBcdByte } from './bcd.js';
export { parseTxpText, parseTxpFile, serializeTxp, COLUMN, EXPECTED_COLUMNS } from './txp.js';
export { buildRecord, parseRecord, RECORD_SIZE, NAME_FIELD_SIZE } from './record.js';
import { buildRecord } from './record.js';
export {
  buildHello,
  buildGoodbye,
  buildStart,
  buildDataFrame,
  buildDataFrames,
  buildIndexTableFrame,
  buildCommitFrames,
  chunkRecords,
  checksum16,
  seal,
  verifyChecksum,
  DATA_FRAME_SIZE,
  DATA_BODY_SIZE,
  SESSION_FRAME_SIZE,
  RECORDS_PER_FRAME,
  INDEX_ENTRIES_PER_FRAME,
  INDEX_FRAME_COUNT,
  MODEL_STRING,
} from './frame.js';
export { validateRows, formatReport, SEVERITY } from './validate.js';
export { WEIGHT_UNITS, VERIFIED_UNIT_CODES, unitByCode, unitById, isKnownUnitCode, resolveUnitCode } from './units.js';

/** Build the complete list of 124-byte records for a parsed .Txp file. */
export function buildRecords(rows) {
  return rows.map((row) => buildRecord(row));
}

/** PLU numbers assigned to keyboard slots, used by the D2 04 table. */
export function indexTableNumbers(rows) {
  return rows.map((row) => row.pluNumber).filter((n) => Number.isInteger(n) && n > 0 && n <= 999999);
}
