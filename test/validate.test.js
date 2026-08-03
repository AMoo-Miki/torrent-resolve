import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertValidInfoHash, assertHttpsUrl, isValidTrackerUrl, assertValidTimeoutSeconds } from '../src/validate.js';
import { TorrentResolveError } from '../src/errors.js';

test('assertValidInfoHash accepts a 40-char hex string and lowercases it', () => {
  const hash = 'D2474E86C95B19B8BCFDB92BC12C9D44667CFA36'.slice(0, 40);
  assert.equal(assertValidInfoHash(hash), hash.toLowerCase());
});

test('assertValidInfoHash rejects non-40-hex input (v2/hybrid, garbage, wrong length)', () => {
  for (const bad of ['', 'zz'.repeat(20), 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(64), null, 123]) {
    assert.throws(() => assertValidInfoHash(bad), TorrentResolveError);
  }
});

test('assertHttpsUrl accepts https:// and rejects other schemes', () => {
  assert.doesNotThrow(() => assertHttpsUrl('https://example.com/a.torrent'));
  for (const bad of ['http://example.com/a.torrent', 'file:///etc/passwd', 'ftp://example.com', 'not a url']) {
    assert.throws(() => assertHttpsUrl(bad), TorrentResolveError);
  }
});

test('isValidTrackerUrl accepts known BitTorrent tracker schemes only', () => {
  assert.equal(isValidTrackerUrl('http://tracker.example/announce'), true);
  assert.equal(isValidTrackerUrl('https://tracker.example/announce'), true);
  assert.equal(isValidTrackerUrl('udp://tracker.example:80'), true);
  assert.equal(isValidTrackerUrl('ws://tracker.example'), true);
  assert.equal(isValidTrackerUrl('wss://tracker.example'), true);
  assert.equal(isValidTrackerUrl('ftp://tracker.example'), false);
  assert.equal(isValidTrackerUrl('javascript:alert(1)'), false);
  assert.equal(isValidTrackerUrl('not a url'), false);
});

test('assertValidTimeoutSeconds accepts positive finite numbers', () => {
  assert.equal(assertValidTimeoutSeconds(600), 600);
  assert.equal(assertValidTimeoutSeconds(0.5), 0.5);
});

test('assertValidTimeoutSeconds rejects zero, negative, non-finite, non-number', () => {
  for (const bad of [0, -1, NaN, Infinity, '600', null, undefined]) {
    assert.throws(() => assertValidTimeoutSeconds(bad), TorrentResolveError);
  }
});
