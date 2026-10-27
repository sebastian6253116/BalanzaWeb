/**
 * Native UDP client for the RLS1000 PLU download protocol.
 *
 * No vendor software, no driver, no native addon: a plain dgram socket.
 * The scale acknowledges every request with an empty UDP datagram, and the only
 * failure signal available is the absence of that acknowledgement, so a send is
 * only considered successful when the ACK arrives.
 *
 * Protocol reference: docs/protocol.md
 */
import dgram from 'node:dgram';
import {
  buildCommitFrames,
  buildDataFrames,
  buildGoodbye,
  buildHello,
  buildIndexTableFrame,
  buildStart,
  INDEX_FRAME_COUNT,
} from '../../plu-format/src/index.js';

export const DEFAULT_PORT = 5001;
const MODEL_STRING = 'RONGTA_PV2.0';

export class ScaleError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ScaleError';
    this.details = details;
  }
}

function openSocket() {
  const socket = dgram.createSocket('udp4');
  const queue = [];
  let waiter = null;

  socket.on('message', (msg) => {
    if (waiter) {
      const current = waiter;
      waiter = null;
      current.resolve(msg);
    } else {
      queue.push(msg);
    }
  });

  socket.on('error', (err) => {
    if (waiter) {
      const current = waiter;
      waiter = null;
      current.reject(err);
    }
  });

  return {
    socket,
    drain() {
      queue.length = 0;
    },
    nextReply(timeoutMs) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiter = null;
          reject(new ScaleError('timed out waiting for the scale acknowledgement'));
        }, timeoutMs);
        waiter = {
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        };
      });
    },
  };
}

/**
 * Send one frame and wait for its acknowledgement, retransmitting on timeout.
 * A stale reply left over from a previous timeout is discarded first.
 */
async function sendFrame(io, frame, { host, port, timeoutMs, retries, label, expectReply = false }) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    io.drain();
    const startedAt = Date.now();
    await new Promise((resolve, reject) => {
      io.socket.send(frame, port, host, (err) => (err ? reject(err) : resolve()));
    });
    try {
      const reply = await io.nextReply(timeoutMs);
      if (expectReply && reply.length === 0) {
        throw new ScaleError(`${label}: expected a non-empty reply`);
      }
      return { label, attempt, ms: Date.now() - startedAt, replyLength: reply.length, reply };
    } catch (err) {
      if (attempt === retries) {
        throw new ScaleError(`${label}: no acknowledgement after ${retries} attempt(s)`, { cause: err });
      }
    }
  }
  throw new ScaleError(`${label}: unreachable`);
}

/** Send a hello frame and return the model string reported by the scale. */
export async function probeScale({ host, port = DEFAULT_PORT, timeoutMs = 1000, retries = 2 } = {}) {
  const io = openSocket();
  try {
    const result = await sendFrame(io, buildHello(), { host, port, timeoutMs, retries, label: 'hello', expectReply: true });
    const reply = result.reply;
    const text = reply.subarray(3).toString('latin1').split('\0')[0];
    return { model: text || MODEL_STRING, replyLength: reply.length, ms: result.ms };
  } finally {
    io.socket.close();
  }
}

/**
 * Push a full PLU catalog to one scale.
 *
 * @param {object} options
 * @param {string} options.host        scale IP
 * @param {number} [options.port]      UDP port, default 5001
 * @param {Buffer[]} options.records   124-byte records, in file order
 * @param {number[]} [options.indexTable]  keyboard-slot numbers for the D2 04 table
 * @param {number} [options.timeoutMs] per-frame ACK timeout
 * @param {number} [options.retries]   attempts per frame
 * @param {(progress: object) => void} [options.onProgress]
 */
export async function pushPlu({
  host,
  port = DEFAULT_PORT,
  records,
  indexTable = null,
  timeoutMs = 800,
  retries = 3,
  onProgress = () => {},
  includeIndexTable = true,
} = {}) {
  if (!host) throw new TypeError('host is required');
  if (!Array.isArray(records) || records.length === 0) throw new TypeError('records must be a non-empty array');

  const io = openSocket();
  const startedAt = Date.now();
  const steps = [];
  const ctx = { host, port, timeoutMs, retries };
  const record = (result) => {
    steps.push({ label: result.label, attempt: result.attempt, ms: result.ms });
    onProgress(result);
    return result;
  };

  try {
    record(await sendFrame(io, buildHello(), { ...ctx, label: 'hello', expectReply: true }));
    record(await sendFrame(io, buildStart(), { ...ctx, label: 'start' }));

    const dataFrames = buildDataFrames(records);
    for (let i = 0; i < dataFrames.length; i++) {
      record(await sendFrame(io, dataFrames[i], { ...ctx, label: `data ${i + 1}/${dataFrames.length}` }));
    }

    if (includeIndexTable && Array.isArray(indexTable) && indexTable.length > 0) {
      for (let i = 0; i < INDEX_FRAME_COUNT; i++) {
        record(await sendFrame(io, buildIndexTableFrame(i, indexTable), { ...ctx, label: `index ${i + 1}/${INDEX_FRAME_COUNT}` }));
      }
    }

    const commitFrames = buildCommitFrames();
    for (let i = 0; i < commitFrames.length; i++) {
      record(await sendFrame(io, commitFrames[i], { ...ctx, label: `commit ${i + 1}/${commitFrames.length}` }));
    }

    try {
      await sendFrame(io, buildGoodbye(), { ...ctx, timeoutMs: Math.min(timeoutMs, 400), retries: 1, label: 'goodbye' });
    } catch {
      // The transfer is already committed; a missing goodbye ACK is not a failure.
    }

    return {
      ok: true,
      host,
      port,
      records: records.length,
      dataFrames: dataFrames.length,
      framesSent: steps.length,
      retriesUsed: steps.filter((s) => s.attempt > 1).length,
      durationMs: Date.now() - startedAt,
      steps,
    };
  } finally {
    io.socket.close();
  }
}
