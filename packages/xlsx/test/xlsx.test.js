import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { buildXlsx } from '../src/index.js';

const REQUIRED_ENTRIES = [
  '[Content_Types].xml',
  '_rels/.rels',
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
  'xl/styles.xml',
  'xl/worksheets/sheet1.xml',
];

const ROOTS = {
  '[Content_Types].xml': /<Types[\s>]/,
  '_rels/.rels': /<Relationships[\s>]/,
  'xl/workbook.xml': /<workbook[\s>]/,
  'xl/_rels/workbook.xml.rels': /<Relationships[\s>]/,
  'xl/styles.xml': /<styleSheet[\s>]/,
  'xl/worksheets/sheet1.xml': /<worksheet[\s>]/,
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index++) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal independent ZIP reader used to validate the writer. */
function readZip(buffer) {
  let eocd = -1;
  for (let index = buffer.length - 22; index >= 0; index--) {
    if (buffer.readUInt32LE(index) !== 0x06054b50) continue;
    if (buffer.readUInt16LE(index + 20) === buffer.length - index - 22) {
      eocd = index;
      break;
    }
  }
  assert.notEqual(eocd, -1, 'end of central directory not found');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'bad central directory signature');
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `bad local header for ${name}`);
    assert.equal(buffer.readUInt32LE(localOffset + 14), expectedCrc, `local CRC mismatch for ${name}`);
    assert.equal(buffer.readUInt32LE(localOffset + 18), compressedSize, `local compressed size mismatch for ${name}`);
    assert.equal(buffer.readUInt32LE(localOffset + 22), size, `local size mismatch for ${name}`);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);

    assert.equal(data.length, size, `uncompressed size mismatch for ${name}`);
    assert.equal(crc32(data), expectedCrc, `CRC mismatch for ${name}`);
    entries.set(name, { method, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function assertWellFormed(xml) {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
  const tags = /<\/?([A-Za-z_][\w:.-]*)(?:\s[^<>]*?)?(\/?)>/g;
  const stack = [];
  let match;
  while ((match = tags.exec(body)) !== null) {
    if (match[0].startsWith('</')) {
      assert.equal(stack.pop(), match[1], `unexpected closing tag ${match[1]}`);
    } else if (match[2] !== '/') {
      stack.push(match[1]);
    }
  }
  assert.deepEqual(stack, [], 'unclosed tags remain');
  const text = body.replace(tags, '');
  assert.equal(/[<>]/.test(text), false, 'stray angle bracket outside a tag');
}

const columns = [
  { header: 'Teclado', key: 'teclado', width: 10, type: 'integer' },
  { header: 'Nombre', key: 'nombre', width: 40 },
  { header: 'LF', key: 'lf', type: 'integer' },
  { header: 'Código', key: 'codigo', type: 'integer' },
  { header: 'Tipo de código', key: 'tipoCodigo', type: 'integer' },
  { header: 'Precio', key: 'precio', type: 'money' },
  { header: 'Unidad', key: 'unidad', type: 'integer' },
  { header: 'Departamento', key: 'departamento', type: 'integer' },
  { header: 'Peso PT', key: 'peso', type: 'text' },
  { header: 'Validez', key: 'validez', type: 'integer' },
  { header: 'Empaque', key: 'empaque', type: 'integer' },
];

const rows = [
  {
    teclado: 1,
    nombre: 'ACELGA COMÚN',
    lf: 1,
    codigo: 11001,
    tipoCodigo: 7,
    precio: 14.5,
    unidad: 4,
    departamento: 21,
    peso: '0.000',
    validez: 365,
    empaque: 0,
  },
  {
    teclado: 2,
    nombre: 'PALTA & LIMÓN <FRESCO>',
    lf: 2,
    codigo: 11002,
    tipoCodigo: 7,
    precio: 9.99,
    unidad: 4,
    departamento: 21,
    peso: '0.000',
    validez: 30,
    empaque: 2,
  },
];

function build(overrides = {}) {
  return buildXlsx({ sheetName: 'Artículos', columns, rows, ...overrides });
}

test('the archive contains the six OOXML parts with valid CRC and sizes', () => {
  const entries = readZip(build());

  for (const name of REQUIRED_ENTRIES) assert.ok(entries.has(name), `missing ${name}`);
  assert.equal(entries.size, REQUIRED_ENTRIES.length);
  assert.ok(entries.get('xl/worksheets/sheet1.xml').data.length > 0);
});

test('every XML part is well formed and has the expected root', () => {
  const entries = readZip(build());

  for (const name of REQUIRED_ENTRIES) {
    const xml = entries.get(name).data.toString('utf8');
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'), `${name} declaration`);
    assert.match(xml, ROOTS[name], `${name} root element`);
    assertWellFormed(xml);
  }
});

test('the header row, accents, widths and frozen pane survive the round trip', () => {
  const xml = readZip(build()).get('xl/worksheets/sheet1.xml').data.toString('utf8');

  for (const column of columns) assert.ok(xml.includes(`>${column.header}<`), `header ${column.header}`);
  assert.ok(xml.includes('ACELGA COMÚN'), 'accented name must stay intact');
  assert.ok(xml.includes('<col min="2" max="2" width="40" customWidth="1"/>'));
  assert.ok(xml.includes('state="frozen"'));
  assert.ok(xml.includes('ySplit="1"'));
});

test('money cells are numeric with the currency style and XML is escaped', () => {
  const xml = readZip(build()).get('xl/worksheets/sheet1.xml').data.toString('utf8');

  assert.ok(xml.includes('<c r="F2" s="2" t="n"><v>14.5</v></c>'), 'money cell F2');
  assert.ok(xml.includes('<v>9.99</v>'), 'money keeps two decimals');
  assert.ok(xml.includes('PALTA &amp; LIMÓN &lt;FRESCO&gt;'), 'ampersand and angle brackets escaped');
  assert.equal(xml.includes('PALTA & LIMÓN'), false);
});

test('the output is deterministic and the sheet name rules are enforced', () => {
  assert.deepEqual(build(), build());

  for (const sheetName of ['Bad/Name', 'Bad[Name]', 'Bad:Name', 'x'.repeat(32), '', 'History']) {
    assert.throws(() => build({ sheetName }), /sheet name/i, `must reject ${JSON.stringify(sheetName)}`);
  }
});
