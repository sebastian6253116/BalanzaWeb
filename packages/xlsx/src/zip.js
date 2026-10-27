/**
 * Minimal deterministic ZIP writer for OOXML packages.
 *
 * Only what an .xlsx container needs: local file headers, a central directory
 * and the end-of-central-directory record. Entries are deflated with
 * `node:zlib`; the timestamp is fixed at 1980-01-01 so the same input always
 * produces byte-identical output.
 */
import { deflateRawSync } from 'node:zlib';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const VERSION_NEEDED = 20;
const FLAG_UTF8 = 0x0800;
const METHOD_DEFLATE = 8;
const DOS_TIME = 0;
const DOS_DATE = 0x21;

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

/** CRC-32 of a buffer, as required by the ZIP format. */
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index++) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertEntry(entry) {
  if (!entry || typeof entry.name !== 'string' || entry.name.length === 0) {
    throw new TypeError('each zip entry needs a non-empty name');
  }
  if (entry.name.includes('\\')) {
    throw new Error(`zip entry names must use forward slashes: ${entry.name}`);
  }
  if (!Buffer.isBuffer(entry.data) && !(entry.data instanceof Uint8Array)) {
    throw new TypeError(`zip entry ${entry.name} needs a Buffer or Uint8Array data field`);
  }
}

/**
 * Build a ZIP archive from `[{ name, data }]`.
 * Returns a Buffer suitable for writing straight to an HTTP response.
 */
export function createZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError('createZip expects a non-empty array of entries');
  }
  if (entries.length > 0xffff) {
    throw new RangeError('zip archives with more than 65535 entries are not supported');
  }

  const seen = new Set();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    assertEntry(entry);
    if (seen.has(entry.name)) throw new Error(`duplicate zip entry: ${entry.name}`);
    seen.add(entry.name);

    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const compressed = deflateRawSync(data);
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(METHOD_DEFLATE, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(VERSION_NEEDED, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(METHOD_DEFLATE, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}
