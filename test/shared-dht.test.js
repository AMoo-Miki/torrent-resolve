import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getSharedDht, shutdownSharedDht } from '../src/shared-dht.js';

// getSharedDht/shutdownSharedDht share module-level singleton state, so every test must leave
// it clean for the next one — hence the unconditional afterEach below, on top of each test's
// own shutdown call (belt and suspenders: a test that throws before its own cleanup must not
// poison the rest of the suite).
afterEach(async () => {
  await shutdownSharedDht();
});

/** Binds a raw loopback UDP socket and resolves the first datagram it receives. Used to observe
 * that addNode() actually sent a ping, without depending on the real internet. */
function listenForOnePacket() {
  const socket = dgram.createSocket('udp4');
  const received = new Promise((resolve) => {
    socket.once('message', (msg, rinfo) => resolve({ msg, rinfo }));
  });
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      const { port } = socket.address();
      resolve({ port, received, close: () => new Promise((r) => socket.close(r)) });
    });
  });
}

test('creates a DHT instance and reuses the same singleton on subsequent calls', async () => {
  const dhtA = await getSharedDht();
  const dhtB = await getSharedDht();
  assert.equal(dhtA, dhtB);
  assert.equal(typeof dhtA.address().port, 'number');
});

test('shutdownSharedDht is a no-op when nothing was ever created', async () => {
  await shutdownSharedDht(); // must not throw, even with no prior getSharedDht() call
});

test('concurrent shutdownSharedDht calls both resolve, and a fresh getSharedDht afterwards creates a new instance', async () => {
  const dht1 = await getSharedDht();
  await Promise.all([shutdownSharedDht(), shutdownSharedDht()]);

  const dht2 = await getSharedDht();
  assert.notEqual(dht1, dht2, 'a new singleton must be created after shutdown, not the destroyed one reused');
});

test('a missing dhtCacheFile is handled gracefully — no throw, empty routing table seed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'torrent-resolve-dht-'));
  try {
    const dhtCacheFile = path.join(dir, 'does-not-exist.json');
    const dht = await getSharedDht({ dhtCacheFile });
    assert.equal(typeof dht.address().port, 'number');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a dhtCacheFile with valid JSON but no nodes array is handled gracefully — no throw', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'torrent-resolve-dht-'));
  try {
    const dhtCacheFile = path.join(dir, 'no-nodes.json');
    await writeFile(dhtCacheFile, JSON.stringify({ notNodes: 'nope' }), 'utf8');
    const dht = await getSharedDht({ dhtCacheFile });
    assert.equal(typeof dht.address().port, 'number');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt dhtCacheFile is handled gracefully — no throw', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'torrent-resolve-dht-'));
  try {
    const dhtCacheFile = path.join(dir, 'corrupt.json');
    await writeFile(dhtCacheFile, 'not valid json{{{', 'utf8');
    const dht = await getSharedDht({ dhtCacheFile });
    assert.equal(typeof dht.address().port, 'number');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dhtBootstrapNodes are actually pinged — a loopback listener observes an incoming packet', async () => {
  const listener = await listenForOnePacket();
  try {
    await getSharedDht({ dhtBootstrapNodes: [{ host: '127.0.0.1', port: listener.port }] });
    const { msg } = await listener.received;
    assert.ok(msg.length > 0);
  } finally {
    await listener.close();
  }
});

test('dhtCacheFile nodes are actually pinged — a loopback listener observes an incoming packet', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'torrent-resolve-dht-'));
  const listener = await listenForOnePacket();
  try {
    const dhtCacheFile = path.join(dir, 'cache.json');
    await writeFile(dhtCacheFile, JSON.stringify({ nodes: [{ host: '127.0.0.1', port: listener.port }] }), 'utf8');
    await getSharedDht({ dhtCacheFile });
    const { msg } = await listener.received;
    assert.ok(msg.length > 0);
  } finally {
    await listener.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('shutdownSharedDht persists the routing table to dhtCacheFile atomically', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'torrent-resolve-dht-'));
  try {
    const dhtCacheFile = path.join(dir, 'cache.json');
    await getSharedDht({ dhtCacheFile });
    await shutdownSharedDht();

    const raw = await readFile(dhtCacheFile, 'utf8');
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed.nodes));

    // No leftover temp file from the atomic write — only the final renamed file should remain.
    const entries = await readdir(dir);
    assert.deepEqual(entries, ['cache.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a persist failure at the write step (unwritable dhtCacheFile path) does not prevent shutdown from completing', async () => {
  // A parent directory that does not exist makes the temp-file write itself fail — shutdown must
  // still finish (persist is documented as best-effort) rather than leaving the DHT socket open.
  const dhtCacheFile = path.join(tmpdir(), 'torrent-resolve-dht-nonexistent-dir', 'cache.json');
  await getSharedDht({ dhtCacheFile });
  await shutdownSharedDht(); // must not throw
});

test('a persist failure at the rename step cleans up its temp file and still lets shutdown complete', async () => {
  // dhtCacheFile pointing at an existing directory lets the temp-file write succeed (a sibling
  // file in the same directory) but makes the rename-into-place fail — the one path that
  // exercises persistDhtCache's own unlink-then-rethrow cleanup, distinct from a write failure.
  const dir = await mkdtemp(path.join(tmpdir(), 'torrent-resolve-dht-'));
  try {
    const dhtCacheFile = path.join(dir, 'is-a-directory');
    await mkdir(dhtCacheFile);

    await getSharedDht({ dhtCacheFile });
    await shutdownSharedDht(); // must not throw, despite the rename failure

    const entries = await readdir(dir);
    // Only the pre-existing directory remains — the temp file written before the failed rename
    // must have been cleaned up, not left behind.
    assert.deepEqual(entries, ['is-a-directory']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a second getSharedDht call is ignored once the singleton exists, even with different opts', async () => {
  const dht1 = await getSharedDht({});
  // A dhtCacheFile that would throw if it were actually read (it's a directory, not a file) —
  // proves this second call never reaches createDht() at all, since the singleton already exists.
  const dht2 = await getSharedDht({ dhtCacheFile: tmpdir() });
  assert.equal(dht1, dht2);
});
