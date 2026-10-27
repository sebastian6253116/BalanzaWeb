import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';

import { buildRecord, verifyChecksum } from '../../plu-format/src/index.js';
import { pushPlu, probeScale, ScaleError } from '../src/index.js';

function fakeRow(overrides = {}) {
  return {
    name: 'LOMO DE AGUJA',
    lfCode: 1,
    barcode: 11001,
    barcodeType: 7,
    priceCents: 1450,
    unitCode: 4,
    department: 21,
    validityDays: 365,
    packageType: 0,
    ...overrides,
  };
}

async function startFakeScale({ dropFrameIndex = -1, silent = false } = {}) {
  const socket = dgram.createSocket('udp4');
  const received = [];
  socket.on('message', (msg, rinfo) => {
    received.push(Buffer.from(msg));
    if (silent) return;
    if (dropFrameIndex >= 0 && received.length - 1 === dropFrameIndex) return;
    const isHello = msg.length > 1 && msg[0] === 0x0e && msg[1] === 0x01;
    const reply = isHello ? Buffer.concat([Buffer.from([0x0e, 0x01, 0x00]), Buffer.from('RONGTA_PV2.0\0', 'latin1')]) : Buffer.alloc(0);
    socket.send(reply, rinfo.port, rinfo.address);
  });
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return {
    port: socket.address().port,
    received,
    close: () => new Promise((resolve) => socket.close(resolve)),
  };
}

test('pushes a full transfer and acknowledges every frame', async () => {
  const scale = await startFakeScale();
  try {
    const records = [buildRecord(fakeRow()), buildRecord(fakeRow({ lfCode: 2, barcode: 11002, name: 'LOMITO' }))];
    const result = await pushPlu({
      host: '127.0.0.1',
      port: scale.port,
      records,
      indexTable: [1, 2],
      timeoutMs: 300,
      retries: 2,
    });

    assert.equal(result.ok, true);
    assert.equal(result.retriesUsed, 0);
    // hello, start, 1 data frame, 3 index frames, 4 commit frames, goodbye = 11
    assert.equal(scale.received.length, 11);
    for (const frame of scale.received) {
      assert.ok(verifyChecksum(frame), 'every frame must carry a valid checksum');
    }
    assert.equal(scale.received[0][0], 0x0e);
    assert.equal(scale.received[1][0], 0xd2);
    assert.equal(scale.received[1][1], 0x01);
    assert.equal(scale.received[2][1], 0x02);
  } finally {
    await scale.close();
  }
});

test('retransmits a frame whose acknowledgement is lost', async () => {
  const scale = await startFakeScale({ dropFrameIndex: 2 });
  try {
    const records = [buildRecord(fakeRow())];
    const result = await pushPlu({
      host: '127.0.0.1',
      port: scale.port,
      records,
      includeIndexTable: false,
      timeoutMs: 200,
      retries: 3,
    });
    assert.equal(result.ok, true);
    assert.equal(result.retriesUsed, 1);
  } finally {
    await scale.close();
  }
});

test('fails loudly when the scale never acknowledges', async () => {
  const scale = await startFakeScale({ silent: true });
  try {
    await assert.rejects(
      pushPlu({ host: '127.0.0.1', port: scale.port, records: [buildRecord(fakeRow())], timeoutMs: 100, retries: 1 }),
      (err) => err instanceof ScaleError && /no acknowledgement/.test(err.message),
    );
  } finally {
    await scale.close();
  }
});

test('probe reads the model string from the hello reply', async () => {
  const scale = await startFakeScale();
  try {
    const result = await probeScale({ host: '127.0.0.1', port: scale.port, timeoutMs: 300 });
    assert.match(result.model, /RONGTA_PV2\.0/);
  } finally {
    await scale.close();
  }
});
