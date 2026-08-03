import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeCompactPeers4, decodeCompactPeers6 } from '../src/tracker/compact-peers.js';

test('decodes a compact IPv4 peer list', () => {
  const buf = Buffer.from([
    192,
    168,
    1,
    1,
    0x1a,
    0xe1, // 192.168.1.1:6881
    10,
    0,
    0,
    5,
    0x00,
    0x50, // 10.0.0.5:80
  ]);
  assert.deepEqual(decodeCompactPeers4(buf), [
    { host: '192.168.1.1', port: 6881 },
    { host: '10.0.0.5', port: 80 },
  ]);
});

test('decodes an empty compact IPv4 peer list as an empty array', () => {
  assert.deepEqual(decodeCompactPeers4(Buffer.alloc(0)), []);
});

test('rejects an IPv4 peer list whose length is not a multiple of 6', () => {
  assert.throws(() => decodeCompactPeers4(Buffer.alloc(7)), /not a multiple of 6/);
});

test('decodes a compact IPv6 peer list', () => {
  const groups = ['2001', '0db8', '0000', '0000', '0000', '0000', '0000', '0001'];
  const buf = Buffer.concat([Buffer.from(groups.join(''), 'hex'), Buffer.from([0x1a, 0xe1])]);
  assert.deepEqual(decodeCompactPeers6(buf), [{ host: '2001:db8:0:0:0:0:0:1', port: 6881 }]);
});

test('decodes multiple IPv6 peer entries', () => {
  const entry = Buffer.concat([Buffer.alloc(16, 0), Buffer.from([0x00, 0x50])]);
  const buf = Buffer.concat([entry, entry]);
  assert.deepEqual(decodeCompactPeers6(buf), [
    { host: '0:0:0:0:0:0:0:0', port: 80 },
    { host: '0:0:0:0:0:0:0:0', port: 80 },
  ]);
});

test('rejects an IPv6 peer list whose length is not a multiple of 18', () => {
  assert.throws(() => decodeCompactPeers6(Buffer.alloc(19)), /not a multiple of 18/);
});
