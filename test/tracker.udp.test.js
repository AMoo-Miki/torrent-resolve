import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announceUdp, LEFT_UNKNOWN } from '../src/tracker/udp-tracker.js';
import {
  startUdpTrackerStub,
  buildConnectResponse,
  buildAnnounceResponse,
  buildErrorResponse,
} from './helpers/udp-tracker-stub.js';

const INFO_HASH = Buffer.from('08ada5a7a6183aae1e09d831df6748d566095a10', 'hex');
const PEER_ID = Buffer.from('-qB5230-000000000001', 'ascii').subarray(0, 20);
const FAST_SCHEDULE = [50, 100];

function baseOpts(extra = {}) {
  return { infoHash: INFO_HASH, peerId: PEER_ID, port: 6881, retransmitScheduleMs: FAST_SCHEDULE, ...extra };
}

test('a normal announce returns the peers the stub sent', async () => {
  const stub = await startUdpTrackerStub({
    onConnect: (req, respond) => respond(buildConnectResponse(req.transactionId, 42n)),
    onAnnounce: (req, respond) => {
      const peers = Buffer.from([1, 2, 3, 4, 0x1a, 0xe1]);
      respond(buildAnnounceResponse(req.transactionId, { interval: 900, peers }));
    },
  });
  try {
    const result = await announceUdp(stub.url, baseOpts());
    assert.deepEqual(result, { peers: [{ host: '1.2.3.4', port: 6881 }], interval: 900 });
  } finally {
    await stub.close();
  }
});

test('a response carrying the wrong transaction id is rejected, not treated as peers', async () => {
  const stub = await startUdpTrackerStub({
    onConnect: (req, respond) => respond(buildConnectResponse(req.transactionId, 42n)),
    onAnnounce: (req, respond) => {
      // Spoofed response first, with an attacker-controlled peer and a transaction id that
      // cannot match (real transaction ids are per-request-random).
      const forgedTxnId = Buffer.alloc(4, 0xee);
      const forgedPeers = Buffer.from([6, 6, 6, 6, 0x1a, 0x0a]);
      respond(buildAnnounceResponse(forgedTxnId, { peers: forgedPeers }));

      // The real response, right behind it.
      const realPeers = Buffer.from([9, 9, 9, 9, 0x00, 0x50]);
      respond(buildAnnounceResponse(req.transactionId, { peers: realPeers }));
    },
  });
  try {
    const result = await announceUdp(stub.url, baseOpts());
    assert.deepEqual(result.peers, [{ host: '9.9.9.9', port: 80 }]);
  } finally {
    await stub.close();
  }
});

test('a truncated connect response (15 bytes) is rejected without throwing', async () => {
  const stub = await startUdpTrackerStub({
    onConnect: (req, respond) => respond(buildConnectResponse(req.transactionId, 42n, 15)),
  });
  try {
    await assert.rejects(announceUdp(stub.url, baseOpts()), /too short/);
  } finally {
    await stub.close();
  }
});

test('a truncated announce response (19 bytes) is rejected without throwing', async () => {
  const stub = await startUdpTrackerStub({
    onConnect: (req, respond) => respond(buildConnectResponse(req.transactionId, 42n)),
    onAnnounce: (req, respond) => respond(buildAnnounceResponse(req.transactionId, { length: 19 })),
  });
  try {
    await assert.rejects(announceUdp(stub.url, baseOpts()), /too short/);
  } finally {
    await stub.close();
  }
});

test('an announce body whose remainder is not a multiple of 6 is rejected', async () => {
  const stub = await startUdpTrackerStub({
    onConnect: (req, respond) => respond(buildConnectResponse(req.transactionId, 42n)),
    onAnnounce: (req, respond) => respond(buildAnnounceResponse(req.transactionId, { peers: Buffer.alloc(7) })),
  });
  try {
    await assert.rejects(announceUdp(stub.url, baseOpts()), /multiple of 6/);
  } finally {
    await stub.close();
  }
});

test('retransmit fires when the stub stays silent for the first attempt, and succeeds on the second', async () => {
  let connectAttempts = 0;
  const stub = await startUdpTrackerStub({
    onConnect: (req, respond) => {
      connectAttempts += 1;
      if (connectAttempts === 1) return; // stay silent — simulate a dropped first datagram
      respond(buildConnectResponse(req.transactionId, 7n));
    },
    onAnnounce: (req, respond) => {
      respond(buildAnnounceResponse(req.transactionId, { peers: Buffer.from([5, 5, 5, 5, 0x00, 0x50]) }));
    },
  });
  try {
    const result = await announceUdp(stub.url, baseOpts());
    assert.deepEqual(result.peers, [{ host: '5.5.5.5', port: 80 }]);
    assert.equal(connectAttempts, 2);
  } finally {
    await stub.close();
  }
});

test('every call opens and closes its own socket — no connection id survives across calls', async () => {
  // There is no session state: each announceUdp() call does a full connect + announce and
  // tears its socket down before returning, regardless of how recently the same tracker was
  // last contacted.
  let connectAttempts = 0;
  const stub = await startUdpTrackerStub({
    onConnect: (req, respond) => {
      connectAttempts += 1;
      respond(buildConnectResponse(req.transactionId, BigInt(connectAttempts)));
    },
    onAnnounce: (req, respond) => respond(buildAnnounceResponse(req.transactionId, {})),
  });
  try {
    await announceUdp(stub.url, baseOpts());
    await announceUdp(stub.url, baseOpts());
    await announceUdp(stub.url, baseOpts());
    assert.equal(connectAttempts, 3, 'each call must do its own fresh handshake');
  } finally {
    await stub.close();
  }
});

test('the default retransmit schedule gives up after one ~5s attempt, not the old multi-attempt ~45s worst case', async () => {
  const stub = await startUdpTrackerStub({}); // never responds to anything
  const startedAt = Date.now();
  try {
    await assert.rejects(announceUdp(stub.url, { infoHash: INFO_HASH, peerId: PEER_ID, port: 6881 }), /timed out/);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs >= 4_500 && elapsedMs < 8_000, `expected ~5s, took ${elapsedMs}ms`);
  } finally {
    await stub.close();
  }
});

test('an action-3 error response surfaces the tracker message', async () => {
  const stub = await startUdpTrackerStub({
    onConnect: (req, respond) => respond(buildConnectResponse(req.transactionId, 42n)),
    onAnnounce: (req, respond) => respond(buildErrorResponse(req.transactionId, 'no such torrent')),
  });
  try {
    await assert.rejects(announceUdp(stub.url, baseOpts()), /no such torrent/);
  } finally {
    await stub.close();
  }
});

test('left is sent as 0xFFFFFFFFFFFFFFFF when unknown', async () => {
  /** @type {(value: bigint) => void} */
  let resolveLeft;
  const leftSeen = new Promise((resolve) => {
    resolveLeft = resolve;
  });
  const stub = await startUdpTrackerStub({
    onConnect: (req, respond) => respond(buildConnectResponse(req.transactionId, 42n)),
    onAnnounce: (req, respond) => {
      resolveLeft(req.left);
      respond(buildAnnounceResponse(req.transactionId, {}));
    },
  });
  try {
    await announceUdp(stub.url, baseOpts());
    assert.equal(await leftSeen, LEFT_UNKNOWN);
    assert.equal(LEFT_UNKNOWN, 0xffffffffffffffffn);
  } finally {
    await stub.close();
  }
});

test('an IPv6-only tracker (no A record — here, a literal [::1] URL) decodes its compact peer list as 18-byte IPv6 entries', async () => {
  const stub = await startUdpTrackerStub({
    type: 'udp6',
    bindAddress: '::1',
    onConnect: (req, respond) => respond(buildConnectResponse(req.transactionId, 42n)),
    onAnnounce: (req, respond) => {
      // 16-byte address (::2) + 2-byte port — if this were misread as two 6-byte IPv4 entries
      // instead, it would silently decode as garbage rather than fail loudly, which is exactly
      // the corruption this test guards against.
      const peers = Buffer.concat([Buffer.alloc(15, 0), Buffer.from([0x02]), Buffer.from([0x1a, 0xe1])]);
      respond(buildAnnounceResponse(req.transactionId, { peers }));
    },
  });
  try {
    const result = await announceUdp(stub.url, baseOpts());
    assert.deepEqual(result.peers, [{ host: '0:0:0:0:0:0:0:2', port: 6881 }]);
  } finally {
    await stub.close();
  }
});

test('a UDP tracker URL with no explicit port defaults to 80', async () => {
  let stub;
  try {
    stub = await startUdpTrackerStub({
      port: 80,
      onConnect: (req, respond) => respond(buildConnectResponse(req.transactionId, 42n)),
      onAnnounce: (req, respond) =>
        respond(buildAnnounceResponse(req.transactionId, { peers: Buffer.from([1, 2, 3, 4, 0x1a, 0xe1]) })),
    });
  } catch (err) {
    // Binding port 80 needs elevated privileges on some platforms/CI runners — skip there
    // rather than fail on an environment limitation unrelated to what this test checks.
    if (err.code === 'EACCES') return;
    throw err;
  }
  try {
    const result = await announceUdp('udp://127.0.0.1/announce', baseOpts());
    assert.deepEqual(result.peers, [{ host: '1.2.3.4', port: 6881 }]);
  } finally {
    await stub.close();
  }
});
