import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildCommitFrames,
  buildDataFrames,
  buildGoodbye,
  buildHello,
  buildIndexTableFrame,
  buildRecord,
  buildRecords,
  buildStart,
  formatReport,
  indexTableNumbers,
  parseTxpFile,
  parseTxpText,
  parseRecord,
  resolveUnitCode,
  toTxpText,
  unitByCode,
  validateRows,
  verifyChecksum,
  RECORD_SIZE,
  VERIFIED_UNIT_CODES,
  WEIGHT_UNITS,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const fixture = (name) => join(here, 'fixtures', name);

const templates = JSON.parse(readFileSync(fixture('control-frames.json'), 'utf8'));
const hex = (buf) => buf.toString('hex');

// Golden tests are pinned to the exact file that produced the captures: the live
// catalogue changes over time, but this fixture must never move.
const TXP_832 = fixture('plu-832-original.txp');
const TXP_10 = join(repo, 'BaseDatosBalanza', 'TEST-10.Txp');

// BaseDatosBalanza is business data and is never published, so these tests
// skip when the fixture is absent instead of failing on a clean checkout.
const businessFixture = existsSync(TXP_10)
  ? {}
  : { skip: 'BaseDatosBalanza/TEST-10.Txp is not part of the repository' };

test('records for the real 832-PLU file match the captured bytes exactly', () => {
  const rows = parseTxpFile(TXP_832);
  assert.equal(rows.length, 832);

  const records = buildRecords(rows);
  const built = Buffer.concat(records);
  const expected = readFileSync(fixture('expected-records-832.bin'));

  assert.equal(built.length, 832 * RECORD_SIZE);
  assert.equal(expected.length, built.length);

  // Report the first differing record instead of dumping 100 KB.
  for (let i = 0; i < records.length; i++) {
    const want = expected.subarray(i * RECORD_SIZE, (i + 1) * RECORD_SIZE);
    if (!records[i].equals(want)) {
      const parsedWant = parseRecord(want);
      const parsedGot = parseRecord(records[i]);
      assert.fail(
        `record ${i} (line ${i + 1}) differs\n  expected ${JSON.stringify(parsedWant)}\n  built    ${JSON.stringify(parsedGot)}`,
      );
    }
  }
  assert.ok(built.equals(expected));
});

test('every captured client frame passes the additive checksum', () => {
  let checked = 0;
  for (const frames of Object.values(templates)) {
    for (const frame of frames) {
      assert.ok(verifyChecksum(Buffer.from(frame.hex, 'hex')), `frame ${frame.hex.slice(0, 8)} failed checksum`);
      checked++;
    }
  }
  assert.ok(checked >= 14);
});

test('hello frame reproduces the captured bytes for its timestamp', () => {
  const captured = Buffer.from(templates['0e01'][0].hex, 'hex');
  const digit = (byte) => ((byte >> 4) & 0x0f) * 10 + (byte & 0x0f);
  const date = new Date(
    2000 + digit(captured[9]),
    digit(captured[8]) - 1,
    digit(captured[7]),
    digit(captured[10]),
    digit(captured[11]),
    digit(captured[12]),
  );
  assert.equal(hex(buildHello(date)), hex(captured));
});

test('start, commit and goodbye frames reproduce the captured bytes', () => {
  assert.equal(hex(buildStart()), templates.d201[0].hex);
  const [first, second, end, trailer] = buildCommitFrames();
  assert.equal(hex(first), templates.d207[0].hex);
  assert.equal(hex(second), templates.d207[1].hex);
  assert.equal(hex(end), templates.d205[0].hex);
  assert.equal(hex(trailer), templates.d20c[0].hex);
  assert.equal(hex(buildGoodbye()), templates['0e02'][0].hex);
});

test('index table frame reproduces the captured PLU-number table', businessFixture, () => {
  const rows = parseTxpFile(TXP_10);
  const numbers = indexTableNumbers(rows);
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(hex(buildIndexTableFrame(0, numbers)), templates.d204[0].hex);
});

test('data frames for the 10-PLU file reproduce the captured bytes', businessFixture, () => {
  const rows = parseTxpFile(TXP_10);
  const frames = buildDataFrames(buildRecords(rows));
  assert.equal(frames.length, 5);
  frames.forEach((frame, i) => {
    assert.equal(hex(frame), templates.d202[i].hex, `data frame ${i} differs`);
  });
});

test('validator flags the defects that made the scale discard the full file', () => {
  const rows = parseTxpFile(TXP_832);
  const report = validateRows(rows);

  assert.equal(report.ok, false);
  const messages = report.errors.map((e) => e.message).join('\n');
  assert.match(messages, /duplicate barcode 12245/);
  assert.match(messages, /duplicate barcode 12200/);
  assert.match(messages, /duplicate barcode 12654/);
  assert.match(messages, /duplicate barcode 12754/);
  assert.ok(report.warnings.some((w) => w.field === 'priceCents'), 'zero prices should warn');
  assert.equal(report.errors.filter((e) => e.field === 'barcode' && e.message.startsWith('duplicate')).length, 4);
});

test('validator accepts the clean 10-PLU file', businessFixture, () => {
  const report = validateRows(parseTxpFile(TXP_10));
  assert.equal(report.ok, true, formatReport(report));
  assert.equal(report.errors.length, 0);
});

test('weight unit vocabulary covers the 13 vendor options and resolves ids', () => {
  assert.equal(WEIGHT_UNITS.length, 13);
  assert.equal(unitByCode(4).id, 'kg');
  assert.equal(resolveUnitCode('kg'), 4);
  assert.equal(resolveUnitCode('4'), 4);
  assert.equal(resolveUnitCode('PCS(kg)'), null, 'labels are not ids');
  assert.equal(resolveUnitCode('pcs_kg'), 10);
  assert.equal(resolveUnitCode(13), null);
  assert.deepEqual([...VERIFIED_UNIT_CODES], [4, 9, 10]);
});

test('the unit code survives the record round-trip for every option', () => {
  for (const unit of WEIGHT_UNITS) {
    const record = buildRecord({
      name: `UNIT ${unit.label}`,
      lfCode: 1,
      barcode: 11001,
      barcodeType: 7,
      priceCents: 100,
      unitCode: unit.code,
      department: 21,
      validityDays: 30,
      packageType: 0,
    });
    assert.equal(record[85], unit.code, `byte 85 must carry the unit code for ${unit.id}`);
    assert.equal(parseRecord(record).unitCode, unit.code);
  }
});

test('validator rejects an unknown unit code and warns on unverified ones', businessFixture, () => {
  const base = parseTxpFile(TXP_10);
  const bad = structuredClone(base);
  bad[0].unitCode = 13;
  const badReport = validateRows(bad);
  assert.equal(badReport.ok, false);
  assert.ok(badReport.errors.some((e) => e.field === 'unitCode' && /unknown weight unit/.test(e.message)));

  const unverified = structuredClone(base);
  unverified[0].unitCode = 0; // 50g
  const warnReport = validateRows(unverified);
  assert.equal(warnReport.ok, true);
  assert.ok(warnReport.warnings.some((w) => w.field === 'unitCode' && /not yet verified on hardware/.test(w.message)));
});

test('the production file only uses verified unit codes', () => {
  const rows = parseTxpFile(TXP_832);
  const codes = new Set(rows.map((r) => r.unitCode));
  for (const code of codes) assert.ok(VERIFIED_UNIT_CODES.has(code), `unit code ${code} is not verified`);
  assert.deepEqual([...codes].sort((a, b) => a - b), [4, 9, 10]);
});

const catalogueArticle = {
  barcode: 11001,
  name: 'LOMO DE AGUJA',
  lfCode: 1,
  pluNumber: 1,
  priceCents: 1450,
  unitCode: 4,
  department: 21,
  validityDays: 365,
  packageType: 0,
  barcodeType: 7,
};

test('catalogue articles round-trip through a 26-column .Txp and keep the known fields', () => {
  const rows = parseTxpFile(TXP_832);
  const articles = rows.map((row) => ({
    barcode: row.barcode,
    name: row.name.trim(),
    lfCode: row.lfCode,
    pluNumber: row.pluNumber,
    priceCents: row.priceCents,
    unitCode: row.unitCode,
    department: row.department,
    validityDays: row.validityDays,
    packageType: row.packageType,
    barcodeType: row.barcodeType,
  }));

  const text = toTxpText(articles);
  const exported = parseTxpText(text);
  assert.equal(exported.length, 832);

  const knownColumns = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10];
  exported.forEach((row, index) => {
    assert.equal(row.raw.length, 26, `row ${index + 1} must have 26 columns`);
    for (const column of knownColumns) {
      const actual = column === 1 ? row.raw[column].trim() : Number(row.raw[column]);
      const expected = column === 1 ? rows[index].raw[column].trim() : Number(rows[index].raw[column]);
      assert.equal(actual, expected, `row ${index + 1} column ${column} changed`);
    }
  });

  assert.equal(toTxpText([]), '', 'an empty catalogue exports an empty body');
});

test('toTxpText rejects a non-ASCII name and names the row', () => {
  assert.throws(
    () => toTxpText([catalogueArticle, { ...catalogueArticle, name: 'CAFÉ CON LECHE' }]),
    /row 2.*name contains a character outside printable ASCII/,
  );
});

test('toTxpText rejects a NaN price and names the row', () => {
  assert.throws(
    () => toTxpText([{ ...catalogueArticle, priceCents: NaN }]),
    /row 1.*priceCents is not a number/,
  );
});
