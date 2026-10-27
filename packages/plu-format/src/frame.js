/**
 * Udp frame builders for the RLS1000 PLU download protocol.
 *
 * Every frame is fixed size and ends with a 16-bit little-endian additive
 * checksum over all preceding bytes. Verified against live traffic
 * (docs/protocol.md sections 2 and 3).
 */
import { encodeBcd, encodeBcdByte } from './bcd.js';

export const SESSION_FRAME_SIZE = 261;
export const DATA_FRAME_SIZE = 265;
export const DATA_BODY_SIZE = 256;
export const RECORDS_PER_FRAME = 2;
export const INDEX_ENTRIES_PER_FRAME = 85;
export const INDEX_FRAME_COUNT = 3;

export const MODEL_STRING = 'RONGTA_PV2.0';

/** 16-bit additive checksum over every byte except the trailing checksum. */
export function checksum16(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length - 2; i++) sum = (sum + buf[i]) & 0xffff;
  return sum;
}

/** Write the checksum into the last two bytes and return the buffer. */
export function seal(buf) {
  buf.writeUInt16LE(checksum16(buf), buf.length - 2);
  return buf;
}

export function verifyChecksum(buf) {
  return checksum16(buf) === buf.readUInt16LE(buf.length - 2);
}

/** `0E 01` hello, carrying the client clock as packed BCD digits. */
export function buildHello(date = new Date()) {
  const buf = Buffer.alloc(SESSION_FRAME_SIZE);
  buf[0] = 0x0e;
  buf[1] = 0x01;
  buf[3] = 0x34;
  buf[4] = 0x12;
  buf[7] = encodeBcdByte(date.getDate());
  buf[8] = encodeBcdByte(date.getMonth() + 1);
  buf[9] = encodeBcdByte(date.getFullYear() % 100);
  buf[10] = encodeBcdByte(date.getHours());
  buf[11] = encodeBcdByte(date.getMinutes());
  buf[12] = encodeBcdByte(date.getSeconds());
  buf.write(MODEL_STRING, 15, 'ascii');
  return seal(buf);
}

/** `0E 02` goodbye. */
export function buildGoodbye() {
  const buf = Buffer.alloc(SESSION_FRAME_SIZE);
  buf[0] = 0x0e;
  buf[1] = 0x02;
  buf[3] = 0x34;
  buf[4] = 0x12;
  return seal(buf);
}

/** `D2 01` start of transfer. */
export function buildStart() {
  const buf = Buffer.alloc(DATA_FRAME_SIZE);
  buf[0] = 0xd2;
  buf[1] = 0x01;
  buf[3] = 0x01;
  return seal(buf);
}

/** `D2 02` data frame: 256-byte body holding two 124-byte records plus padding. */
export function buildDataFrame(sequence, body) {
  if (!Buffer.isBuffer(body) || body.length !== DATA_BODY_SIZE) {
    throw new RangeError(`data body must be ${DATA_BODY_SIZE} bytes`);
  }
  const buf = Buffer.alloc(DATA_FRAME_SIZE);
  buf[0] = 0xd2;
  buf[1] = 0x02;
  buf[3] = sequence & 0xff;
  body.copy(buf, 7);
  return seal(buf);
}

/**
 * `D2 04` PLU-number ("teclado") table. Three frames of 85 entries each;
 * every entry is a 3-byte packed-BCD value, big-endian.
 */
export function buildIndexTableFrame(frameIndex, numbers) {
  if (frameIndex < 0 || frameIndex >= INDEX_FRAME_COUNT) {
    throw new RangeError(`frameIndex must be 0..${INDEX_FRAME_COUNT - 1}`);
  }
  const buf = Buffer.alloc(DATA_FRAME_SIZE);
  buf[0] = 0xd2;
  buf[1] = 0x04;
  buf[3] = 0xf8 + frameIndex;
  buf[4] = 0x03;
  const slice = numbers.slice(
    frameIndex * INDEX_ENTRIES_PER_FRAME,
    (frameIndex + 1) * INDEX_ENTRIES_PER_FRAME,
  );
  slice.forEach((value, i) => {
    encodeBcd(value, 3).copy(buf, 7 + i * 3);
  });
  return seal(buf);
}

/**
 * Closing frames. Replayed from the verified successful capture:
 * `D2 07` twice, `D2 05`, `D2 0C`.
 */
export function buildCommitFrames() {
  const first = Buffer.alloc(DATA_FRAME_SIZE);
  first[0] = 0xd2;
  first[1] = 0x07;
  first[3] = 0xf6;
  first[4] = 0x03;
  first[7] = 0xff;
  seal(first);

  const second = Buffer.from(first);
  second[3] = 0xf7;
  seal(second);

  const end = Buffer.alloc(DATA_FRAME_SIZE);
  end[0] = 0xd2;
  end[1] = 0x05;
  end[7] = 0xff;
  seal(end);

  const trailer = Buffer.alloc(DATA_FRAME_SIZE);
  trailer[0] = 0xd2;
  trailer[1] = 0x0c;
  trailer[3] = 0x09;
  // Fixed tail whose meaning is unknown: 0x64 at every odd body offset from 157.
  for (let i = 157; i < DATA_BODY_SIZE; i += 2) trailer[7 + i] = 0x64;
  seal(trailer);

  return [first, second, end, trailer];
}

/** Split 124-byte records into 256-byte bodies (two records each, zero padded). */
export function chunkRecords(records) {
  if (!Array.isArray(records)) throw new TypeError('chunkRecords expects an array of records');
  const bodies = [];
  for (let i = 0; i < records.length; i += RECORDS_PER_FRAME) {
    const body = Buffer.alloc(DATA_BODY_SIZE);
    records[i].copy(body, 0);
    if (records[i + 1]) records[i + 1].copy(body, 124);
    bodies.push(body);
  }
  return bodies;
}

/** Build every data frame for a list of 124-byte records. */
export function buildDataFrames(records) {
  return chunkRecords(records).map((body, sequence) => buildDataFrame(sequence, body));
}
