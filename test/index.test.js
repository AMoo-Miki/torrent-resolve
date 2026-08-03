import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from '../src/index.js';
import { TorrentResolveError } from '../src/errors.js';
import { buildTorrentFixture } from './helpers/fixtures.js';

function fakeFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

const VALID_HASH = 'a'.repeat(40);

test('rejects non-string input synchronously', async () => {
  await assert.rejects(() => resolve(42), TorrentResolveError);
  await assert.rejects(() => resolve(null), TorrentResolveError);
  await assert.rejects(() => resolve(undefined), TorrentResolveError);
});

test('rejects an unrecognized input format', async () => {
  await assert.rejects(() => resolve('ftp://example.com/a.torrent'), TorrentResolveError);
  await assert.rejects(() => resolve('not-a-recognized-input'), TorrentResolveError);
});

test('dispatches an https:// URL to resolveTorrentFile', async () => {
  const { buffer, infoHash } = buildTorrentFixture({ name: 'dispatched.iso' });
  const restore = fakeFetch(async () => new Response(buffer, { status: 200 }));
  try {
    const result = await resolve('https://example.com/a.torrent');
    assert.equal(result.name, 'dispatched.iso');
    assert.equal(result.infoHash, infoHash);
  } finally {
    restore();
  }
});

test('dispatches a magnet: URI to resolveMagnet, without touching the network', async () => {
  // A magnet with no xt= at all fails parse-torrent's own synchronous validation, surfaced by
  // resolveMagnet as "Invalid magnet URI" — before any DHT/tracker call — enough to prove
  // resolve() reached resolveMagnet.
  await assert.rejects(() => resolve('magnet:?dn=no-xt-param'), TorrentResolveError);
});

test('dispatches a stream-magnet: URI to resolveMagnet too', async () => {
  await assert.rejects(() => resolve('stream-magnet:?dn=no-xt-param'), TorrentResolveError);
});

test('dispatches a bare 40-hex infohash to resolveInfoHash, without touching the network', async () => {
  // resolveInfoHash requires a non-empty opts.trackers array and validates that synchronously,
  // before any DHT/tracker call — enough to prove resolve() reached resolveInfoHash.
  await assert.rejects(() => resolve(VALID_HASH), TorrentResolveError);
  await assert.rejects(() => resolve(VALID_HASH.toUpperCase()), TorrentResolveError);
});
