import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { TrackerClient, clampReannounceIntervalMs } from '../src/tracker/index.js';
import { startUdpTrackerStub, buildConnectResponse, buildAnnounceResponse } from './helpers/udp-tracker-stub.js';
import { startHttpTrackerStub, sendBencoded } from './helpers/http-tracker-stub.js';

const INFO_HASH = '08ada5a7a6183aae1e09d831df6748d566095a10';
const PEER_ID = Buffer.from('-qB5230-000000000001', 'ascii').subarray(0, 20);

/** Opens then immediately closes an HTTP server to get a port nothing is listening on. */
async function getDeadHttpUrl() {
  const stub = await startHttpTrackerStub((_req, res) => res.end());
  await stub.close();
  return stub.url;
}

test('one failing tracker does not prevent peers from a working one', async () => {
  const working = await startUdpTrackerStub({
    onConnect: (req, respond) => respond(buildConnectResponse(req.transactionId, 1n)),
    onAnnounce: (req, respond) =>
      respond(buildAnnounceResponse(req.transactionId, { peers: Buffer.from([1, 2, 3, 4, 0x1a, 0xe1]) })),
  });
  const deadUrl = await getDeadHttpUrl();

  const client = new TrackerClient({
    infoHash: INFO_HASH,
    peerId: PEER_ID,
    announce: [working.url, deadUrl],
    port: 6881,
  });
  const warnings = [];
  client.on('warning', (w) => warnings.push(w));
  try {
    client.start();
    const [peer] = await once(client, 'peer');
    assert.deepEqual(peer, { host: '1.2.3.4', port: 6881 });
    // Give the dead tracker's rejection a chance to surface too.
    await new Promise((r) => setImmediate(r));
    assert.ok(warnings.length >= 1);
  } finally {
    client.destroy();
    await working.close();
  }
});

test('peers are deduped across trackers', async () => {
  const samePeer = Buffer.from([7, 7, 7, 7, 0x1a, 0xe1]);
  const trackerA = await startUdpTrackerStub({
    onConnect: (req, respond) => respond(buildConnectResponse(req.transactionId, 1n)),
    onAnnounce: (req, respond) => respond(buildAnnounceResponse(req.transactionId, { peers: samePeer })),
  });
  const trackerB = await startHttpTrackerStub((_req, res) => {
    sendBencoded(res, { interval: 1800, peers: samePeer });
  });

  const client = new TrackerClient({
    infoHash: INFO_HASH,
    peerId: PEER_ID,
    announce: [trackerA.url, trackerB.url],
    port: 6881,
  });
  const peers = [];
  client.on('peer', (p) => peers.push(p));
  try {
    client.start();
    await once(client, 'peer');
    // Both trackers announce the same peer; give the second announce a chance to (wrongly)
    // re-emit it before asserting dedup held across the whole round.
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(peers, [{ host: '7.7.7.7', port: 6881 }]);
  } finally {
    client.destroy();
    await trackerA.close();
    await trackerB.close();
  }
});

test('an uppercase tracker URL scheme still dispatches correctly', async () => {
  const stub = await startUdpTrackerStub({
    onConnect: (req, respond) => respond(buildConnectResponse(req.transactionId, 1n)),
    onAnnounce: (req, respond) =>
      respond(buildAnnounceResponse(req.transactionId, { peers: Buffer.from([1, 2, 3, 4, 0x1a, 0xe1]) })),
  });
  const uppercaseUrl = stub.url.replace(/^udp:/, 'UDP:');
  assert.notEqual(uppercaseUrl, stub.url);

  const client = new TrackerClient({ infoHash: INFO_HASH, peerId: PEER_ID, announce: [uppercaseUrl], port: 6881 });
  const warnings = [];
  client.on('warning', (w) => warnings.push(w));
  try {
    client.start();
    const [peer] = await once(client, 'peer');
    assert.deepEqual(peer, { host: '1.2.3.4', port: 6881 });
    assert.deepEqual(warnings, [], 'an uppercase scheme must not be treated as unsupported');
  } finally {
    client.destroy();
    await stub.close();
  }
});

test('a decoded peer with port 0 is filtered out rather than emitted', async () => {
  const stub = await startUdpTrackerStub({
    onConnect: (req, respond) => respond(buildConnectResponse(req.transactionId, 1n)),
    onAnnounce: (req, respond) => {
      const peers = Buffer.concat([
        Buffer.from([1, 2, 3, 4, 0x00, 0x00]), // bogus: port 0
        Buffer.from([5, 6, 7, 8, 0x1a, 0xe1]), // a real peer, right behind it
      ]);
      respond(buildAnnounceResponse(req.transactionId, { peers }));
    },
  });
  const client = new TrackerClient({ infoHash: INFO_HASH, peerId: PEER_ID, announce: [stub.url], port: 6881 });
  const peers = [];
  client.on('peer', (p) => peers.push(p));
  try {
    client.start();
    await once(client, 'peer');
    assert.deepEqual(peers, [{ host: '5.6.7.8', port: 6881 }]);
  } finally {
    client.destroy();
    await stub.close();
  }
});

test('a dead tracker does not slow a healthy one', async () => {
  // This is the regression test for the whole per-tracker-scheduling change: with a single
  // shared round timer, the next round can't start until every tracker in the round has
  // settled, so one dead tracker (which burns the full ~5s retransmit timeout every attempt)
  // throttles a perfectly healthy tracker down to that same pace.
  let liveAnnounceCount = 0;
  const live = await startUdpTrackerStub({
    onConnect: (req, respond) => respond(buildConnectResponse(req.transactionId, 1n)),
    onAnnounce: (req, respond) => {
      liveAnnounceCount += 1;
      respond(buildAnnounceResponse(req.transactionId, {}));
    },
  });
  // A UDP stub that never replies to anything — connect requests just vanish, forcing every
  // attempt through the full retransmit timeout.
  const dead = await startUdpTrackerStub({});

  const client = new TrackerClient({
    infoHash: INFO_HASH,
    peerId: PEER_ID,
    announce: [live.url, dead.url],
    port: 6881,
    reannounceIntervalMs: 200, // matches the packet's own measurement scenario
  });
  try {
    client.start();
    await new Promise((r) => setTimeout(r, 2_000));
    // With independent per-tracker loops: ~2000ms / 200ms ≈ 10 announces, minus scheduling
    // overhead. With the old shared-round design, the live tracker would be capped at ~1
    // (the round can't complete a second time within 2s while the dead tracker's ~5s
    // retransmit timeout is still running).
    assert.ok(
      liveAnnounceCount >= 7,
      `expected the live tracker to announce close to every 200ms (>=7 times in 2s), got ${liveAnnounceCount} — a dead tracker must not throttle a healthy one`,
    );
  } finally {
    client.destroy();
    await live.close();
    await dead.close();
  }
});

test('a tracker returning interval=1 is not re-announced sooner than the 60s floor', () => {
  assert.equal(clampReannounceIntervalMs(1), 60_000);
});

test('a tracker returning interval=99999 is capped at the 30 minute ceiling', () => {
  assert.equal(clampReannounceIntervalMs(99_999), 30 * 60_000);
});

test('a tracker returning no interval falls back to the default', () => {
  assert.equal(clampReannounceIntervalMs(null), 30 * 60_000);
  assert.equal(clampReannounceIntervalMs(undefined), 30 * 60_000);
});

test('a non-finite interval falls back to the default rather than producing NaN', () => {
  // Math.max/Math.min with NaN produce NaN, and setTimeout(fn, NaN) coerces to a 1ms delay —
  // silently turning into exactly the hammering this whole change exists to prevent. Neither
  // real call site can produce these today, but the function is exported module surface.
  assert.equal(clampReannounceIntervalMs(NaN), 30 * 60_000);
  assert.equal(clampReannounceIntervalMs(Infinity), 30 * 60_000);
  assert.equal(clampReannounceIntervalMs(-Infinity), 30 * 60_000);
});

test('two trackers returning different intervals are each announced on their own cadence', async () => {
  // `interval` is whole seconds on the wire (BEP 3 / BEP 15), so the smallest real,
  // non-clamped value worth testing is 1 second = 1000ms — there is no way to get a
  // sub-second real interval to observe here. reannounceClampMs is widened (not narrowed) just
  // enough that both trackers' real interval values pass through unclamped, so what's actually
  // under test is "does each tracker's own response drive its own schedule", not the clamp math
  // (already covered by the floor/ceiling/default tests above).
  let countA = 0;
  let countB = 0;
  const trackerA = await startUdpTrackerStub({
    onConnect: (req, respond) => respond(buildConnectResponse(req.transactionId, 1n)),
    onAnnounce: (req, respond) => {
      countA += 1;
      respond(buildAnnounceResponse(req.transactionId, { interval: 1 })); // 1000ms cadence
    },
  });
  const trackerB = await startUdpTrackerStub({
    onConnect: (req, respond) => respond(buildConnectResponse(req.transactionId, 2n)),
    onAnnounce: (req, respond) => {
      countB += 1;
      respond(buildAnnounceResponse(req.transactionId, { interval: 3 })); // 3000ms cadence
    },
  });

  const client = new TrackerClient({
    infoHash: INFO_HASH,
    peerId: PEER_ID,
    announce: [trackerA.url, trackerB.url],
    port: 6881,
    reannounceClampMs: { min: 100, max: 10_000, fallback: 500 },
  });
  try {
    client.start();
    await new Promise((r) => setTimeout(r, 3_200));
    // ~3200ms / 1000ms ≈ 3 for A, ~3200ms / 3000ms ≈ 1 for B.
    assert.ok(countA >= 3, `expected tracker A (1000ms cadence) to announce a few times, got ${countA}`);
    assert.ok(
      countB >= 1 && countB <= 2,
      `expected tracker B (3000ms cadence) to announce only once or twice, got ${countB}`,
    );
    assert.ok(countA > countB, `expected A (1000ms) to clearly outpace B (3000ms), got A=${countA} B=${countB}`);
  } finally {
    client.destroy();
    await trackerA.close();
    await trackerB.close();
  }
});

test('a slow tracker never has two announces in flight at once', async () => {
  let inFlight = 0;
  let maxConcurrent = 0;
  const stub = await startUdpTrackerStub({
    onConnect: (req, respond) => respond(buildConnectResponse(req.transactionId, 1n)),
    onAnnounce: (req, respond) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      // Slower than the 50ms reannounce interval below, so a naive fixed-delay timer (started
      // as soon as the request went out, rather than after this one settles) would have already
      // fired the next announce before this one's response even arrives.
      setTimeout(() => {
        respond(buildAnnounceResponse(req.transactionId, {}));
        inFlight -= 1;
      }, 150);
    },
  });

  const client = new TrackerClient({
    infoHash: INFO_HASH,
    peerId: PEER_ID,
    announce: [stub.url],
    port: 6881,
    reannounceIntervalMs: 50,
  });
  try {
    client.start();
    await new Promise((r) => setTimeout(r, 500)); // several would-be reannounce ticks
    assert.equal(maxConcurrent, 1, "this tracker's next announce must wait for the previous one to settle");
  } finally {
    client.destroy();
    await stub.close();
  }
});

test('destroy() leaves no open handle or pending timer', async () => {
  const stub = await startUdpTrackerStub({
    onConnect: (req, respond) => respond(buildConnectResponse(req.transactionId, 1n)),
    onAnnounce: (req, respond) =>
      respond(buildAnnounceResponse(req.transactionId, { peers: Buffer.from([1, 1, 1, 1, 0x00, 0x50]) })),
  });

  const before = countResourcesByType();

  const client = new TrackerClient({ infoHash: INFO_HASH, peerId: PEER_ID, announce: [stub.url], port: 6881 });
  client.start();
  await once(client, 'peer');
  client.destroy();
  await stub.close();
  await new Promise((r) => setTimeout(r, 50)); // let async socket/timer teardown actually unwind

  // Every timer this class creates is deliberately unref'd (so a lone TrackerClient never blocks
  // process exit on its own) — but process.getActiveResourcesInfo() does not report unref'd
  // timers at all, verified separately: adding a ref'd Timeout moves its count, adding an
  // unref'd one on top does not. That makes the resource-count check below structurally unable
  // to see a leaked reannounce timer regardless of whether destroy() actually cleared it, so it
  // only ever really covers the socket half of "no open handle or pending timer". This directly
  // checks the timer half instead.
  assert.equal(client._timers.size, 0, 'destroy() must clear every per-tracker reannounce timer');

  const after = countResourcesByType();
  for (const [type, count] of after) {
    assert.ok(
      count <= (before.get(type) ?? 0),
      `resource type ${type} leaked: before=${before.get(type) ?? 0} after=${count}`,
    );
  }
});

function countResourcesByType() {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const type of process.getActiveResourcesInfo()) {
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return counts;
}
