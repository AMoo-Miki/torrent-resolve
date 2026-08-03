import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announceHttp } from '../src/tracker/http-tracker.js';
import { percentEncodeBytes } from '../src/tracker/url-encode.js';
import { startHttpTrackerStub, sendBencoded } from './helpers/http-tracker-stub.js';

const INFO_HASH_HIGH_BYTES = (() => {
  const buf = Buffer.from('08ada5a7a6183aae1e09d831df6748d566095a10', 'hex');
  buf[0] = 0xff;
  buf[5] = 0x80;
  buf[19] = 0xc3;
  return buf;
})();
const PEER_ID = Buffer.from('-qB5230-000000000001', 'ascii').subarray(0, 20);

function baseOpts(extra = {}) {
  return { infoHash: INFO_HASH_HIGH_BYTES, peerId: PEER_ID, port: 6881, ...extra };
}

test('compact peers decode correctly', async () => {
  const stub = await startHttpTrackerStub((_req, res) => {
    sendBencoded(res, {
      interval: 1800,
      peers: Buffer.from([192, 168, 1, 1, 0x1a, 0xe1, 10, 0, 0, 5, 0x00, 0x50]),
    });
  });
  try {
    const result = await announceHttp(stub.url, baseOpts());
    assert.deepEqual(result, {
      peers: [
        { host: '192.168.1.1', port: 6881 },
        { host: '10.0.0.5', port: 80 },
      ],
      interval: 1800,
    });
  } finally {
    await stub.close();
  }
});

test('non-compact peers (list of dicts) decode correctly', async () => {
  const stub = await startHttpTrackerStub((_req, res) => {
    sendBencoded(res, {
      interval: 900,
      peers: [
        { ip: Buffer.from('1.2.3.4'), 'peer id': Buffer.alloc(20), port: 6881 },
        { ip: Buffer.from('5.6.7.8'), 'peer id': Buffer.alloc(20), port: 51413 },
      ],
    });
  });
  try {
    const result = await announceHttp(stub.url, baseOpts());
    assert.deepEqual(result.peers, [
      { host: '1.2.3.4', port: 6881 },
      { host: '5.6.7.8', port: 51413 },
    ]);
  } finally {
    await stub.close();
  }
});

test('peers6 decode correctly in compact form', async () => {
  const addr = Buffer.concat([Buffer.alloc(15, 0), Buffer.from([0x01])]); // ::1
  const stub = await startHttpTrackerStub((_req, res) => {
    sendBencoded(res, {
      interval: 1800,
      peers6: Buffer.concat([addr, Buffer.from([0x00, 0x50])]),
    });
  });
  try {
    const result = await announceHttp(stub.url, baseOpts());
    assert.deepEqual(result.peers, [{ host: '0:0:0:0:0:0:0:1', port: 80 }]);
  } finally {
    await stub.close();
  }
});

test('peers6 decode correctly in list-of-dicts form', async () => {
  const stub = await startHttpTrackerStub((_req, res) => {
    sendBencoded(res, {
      interval: 1800,
      peers6: [{ ip: Buffer.from('::1'), 'peer id': Buffer.alloc(20), port: 6881 }],
    });
  });
  try {
    const result = await announceHttp(stub.url, baseOpts());
    assert.deepEqual(result.peers, [{ host: '::1', port: 6881 }]);
  } finally {
    await stub.close();
  }
});

test('failure reason becomes an error for that tracker', async () => {
  const stub = await startHttpTrackerStub((_req, res) => {
    sendBencoded(res, { 'failure reason': Buffer.from('torrent not registered') });
  });
  try {
    await assert.rejects(announceHttp(stub.url, baseOpts()), /torrent not registered/);
  } finally {
    await stub.close();
  }
});

test('warning message is surfaced but the peers are still returned', async () => {
  const stub = await startHttpTrackerStub((_req, res) => {
    sendBencoded(res, {
      interval: 1800,
      'warning message': Buffer.from('please upgrade your client'),
      peers: Buffer.from([1, 1, 1, 1, 0x00, 0x50]),
    });
  });
  try {
    const warnings = [];
    const result = await announceHttp(stub.url, baseOpts({ onWarning: (w) => warnings.push(w) }));
    assert.deepEqual(result.peers, [{ host: '1.1.1.1', port: 80 }]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /please upgrade your client/);
  } finally {
    await stub.close();
  }
});

test('a non-200 response is rejected cleanly', async () => {
  const stub = await startHttpTrackerStub((_req, res) => {
    res.writeHead(500);
    res.end('internal error');
  });
  try {
    await assert.rejects(announceHttp(stub.url, baseOpts()), /HTTP 500/);
  } finally {
    await stub.close();
  }
});

test('an unparseable body is rejected cleanly', async () => {
  const stub = await startHttpTrackerStub((_req, res) => {
    res.writeHead(200);
    res.end('this is not bencode');
  });
  try {
    await assert.rejects(announceHttp(stub.url, baseOpts()), /decode/);
  } finally {
    await stub.close();
  }
});

test('the outgoing query string percent-encodes a high-byte info_hash correctly', async () => {
  /** @type {(url: string) => void} */
  let resolveUrl;
  const urlSeen = new Promise((resolve) => {
    resolveUrl = resolve;
  });
  const stub = await startHttpTrackerStub((req, res) => {
    resolveUrl(req.url);
    sendBencoded(res, { interval: 1800, peers: Buffer.alloc(0) });
  });
  try {
    await announceHttp(stub.url, baseOpts());
    const url = await urlSeen;
    // The high bytes forced onto INFO_HASH_HIGH_BYTES (0xff, 0x80, 0xc3) must survive as %XX —
    // encodeURIComponent would corrupt them, since they aren't valid UTF-8 on their own.
    const expected = percentEncodeBytes(INFO_HASH_HIGH_BYTES);
    assert.ok(url.includes(`info_hash=${expected}`), `expected ${url} to contain info_hash=${expected}`);
    assert.ok(expected.includes('%FF'));
    assert.ok(expected.includes('%80'));
    assert.ok(expected.includes('%C3'));
  } finally {
    await stub.close();
  }
});
