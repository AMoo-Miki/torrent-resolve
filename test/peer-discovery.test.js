import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PeerDiscovery } from '../src/peer-discovery.js';
import { USER_AGENT } from '../src/client-identity.js';

function makeFakeDht() {
  return { on: () => {}, removeListener: () => {}, lookup: () => {} };
}

/** A fake DHT that's a real EventEmitter, so tests can drive its 'peer' event directly — the
 * shared DHT singleton emits 'peer' for every infoHash any caller is looking up, not just this
 * one, which is exactly the filtering PeerDiscovery's own listener must do. */
function makeEmittingFakeDht() {
  const emitter = new EventEmitter();
  emitter.lookup = () => {};
  return emitter;
}

test('defaults userAgent to client-identity.js USER_AGENT when not provided', () => {
  const discovery = new PeerDiscovery({
    dht: makeFakeDht(),
    infoHash: 'a'.repeat(40),
    trackers: [],
    peerId: Buffer.alloc(20),
    port: 6881,
  });
  assert.equal(discovery.userAgent, USER_AGENT);
});

test('respects an explicit userAgent override', () => {
  const discovery = new PeerDiscovery({
    dht: makeFakeDht(),
    infoHash: 'a'.repeat(40),
    trackers: [],
    peerId: Buffer.alloc(20),
    port: 6881,
    userAgent: 'CustomClient/1.0',
  });
  assert.equal(discovery.userAgent, 'CustomClient/1.0');
});

test("a DHT 'peer' event for a different infoHash is filtered out, not emitted", () => {
  const dht = makeEmittingFakeDht();
  const ourInfoHash = 'a'.repeat(40);
  const otherInfoHash = 'b'.repeat(40);
  const discovery = new PeerDiscovery({
    dht,
    infoHash: ourInfoHash,
    trackers: [],
    peerId: Buffer.alloc(20),
    port: 6881,
  });
  const emittedPeers = [];
  discovery.on('peer', (peer) => emittedPeers.push(peer));

  try {
    discovery.start();
    dht.emit('peer', { host: '1.2.3.4', port: 1 }, Buffer.from(otherInfoHash, 'hex'));
    assert.deepEqual(emittedPeers, []);
  } finally {
    discovery.destroy();
  }
});

test("a DHT 'peer' event for our own infoHash is emitted", () => {
  const dht = makeEmittingFakeDht();
  const ourInfoHash = 'a'.repeat(40);
  const discovery = new PeerDiscovery({
    dht,
    infoHash: ourInfoHash,
    trackers: [],
    peerId: Buffer.alloc(20),
    port: 6881,
  });
  const emittedPeers = [];
  discovery.on('peer', (peer) => emittedPeers.push(peer));

  try {
    discovery.start();
    dht.emit('peer', { host: '1.2.3.4', port: 5678 }, Buffer.from(ourInfoHash, 'hex'));
    assert.deepEqual(emittedPeers, [{ host: '1.2.3.4', port: 5678 }]);
  } finally {
    discovery.destroy();
  }
});
