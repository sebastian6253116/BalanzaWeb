/**
 * Minimal OOXML reader used by tests to inspect generated workbooks.
 *
 * It understands only the single-sheet package that buildXlsx writes, so it is
 * kept out of the package's public surface. Zero third-party dependencies.
 */
import { inflateRawSync } from 'node:zlib';

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

/** Read every entry of a ZIP archive into a Map of name -> Buffer. */
export function readZipEntries(buffer) {
  let endOfCentralDirectory = -1;
  for (let index = buffer.length - 22; index >= 0; index--) {
    if (buffer.readUInt32LE(index) !== 0x06054b50) continue;
    if (buffer.readUInt16LE(index + 20) === buffer.length - index - 22) {
      endOfCentralDirectory = index;
      break;
    }
  }
  if (endOfCentralDirectory === -1) throw new Error('end of central directory not found');

  const count = buffer.readUInt16LE(endOfCentralDirectory + 10);
  let offset = buffer.readUInt32LE(endOfCentralDirectory + 16);
  const entries = new Map();

  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('bad central directory signature');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    if (buffer.readUInt32LE(localOffset) !== LOCAL_HEADER_SIGNATURE) {
      throw new Error(`bad local header for ${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);

    entries.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function decodeXml(value) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function columnIndex(reference) {
  const letters = /^[A-Z]+/.exec(reference)?.[0];
  if (!letters) return null;
  let index = 0;
  for (const character of letters) index = index * 26 + (character.charCodeAt(0) - 64);
  return index - 1;
}

/**
 * Parse the first worksheet into rows of cell values, preserving column
 * positions from each cell reference.
 *
 * @param {Buffer} buffer
 * @returns {string[][]}
 */
export function readSheetRows(buffer) {
  const sheet = readZipEntries(buffer).get('xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('sheet1.xml not found');

  const xml = sheet.toString('utf8');
  const rows = [];
  const rowPattern = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;

  while ((rowMatch = rowPattern.exec(xml)) !== null) {
    const cells = [];
    const cellPattern = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cellMatch;

    while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) {
      const attributes = cellMatch[1];
      const inner = cellMatch[2];
      const reference = /\br="([A-Z]+\d+)"/.exec(attributes)?.[1];
      const index = reference ? columnIndex(reference) : cells.length;
      const text = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1];
      const number = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      cells[index] = text === undefined ? decodeXml(number ?? '') : decodeXml(text);
    }

    rows.push(cells);
  }

  return rows;
}
