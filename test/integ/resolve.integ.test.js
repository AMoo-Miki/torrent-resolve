import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import parseTorrent from 'parse-torrent';
import { resolveMagnet, resolveInfoHash, resolveTorrentFile, shutdownSharedDht } from '../../src/index.js';
import { torrentUrl, magnets } from './fixtures.generated.js';

// Always live — hits the real internet (real DHT + real trackers). No opt-in gate: this whole
// directory is what `npm run test:integ` is for, and `npm test` runs it alongside the mocked
// unit suite as part of the combined coverage run.
//
// Fixtures come from ./fixtures.generated.js, produced by scripts/refresh-integ-fixtures.js
// against Debian's own CD/DVD image torrents — about as close to permanently well-seeded as
// public BitTorrent content gets. Re-run that script (see its header comment) if this suite
// starts running slowly because its current fixtures' seeders have gone stale.

after(async () => {
  await shutdownSharedDht();
});

test('resolveMagnet resolves a real, well-known magnet end-to-end', { timeout: 90_000 }, async () => {
  const fixture = magnets[0];
  const result = await resolveMagnet(fixture.uri, { timeoutSeconds: 60 });
  assert.equal(result.infoHash, fixture.infoHash);
  assert.equal(result.name, fixture.name);
  assert.equal('created' in result, false);
  assert.ok(result.length > 0);
  assert.ok(Array.isArray(result.files) && result.files.length > 0);
  assert.equal(result.private, false);
  assert.ok(Array.isArray(result.trackers) && result.trackers.length > 0);
});

test('resolveMagnet resolves a bare xt=-only magnet (no dn, no tr param), given trackers via opts', {
  timeout: 90_000,
}, async () => {
  // The magnet URI itself carries no dn= or tr= param — exercises parsed.announce/.dn falling
  // back to []/null inside resolveMagnet. Trackers still come in via opts.trackers (not DHT
  // alone) to keep this fast and reliable, same as every other tracker-assisted test here.
  const fixture = magnets[2];
  const { announce: trackers } = await parseTorrent(fixture.uri);
  const bareUri = `magnet:?xt=urn:btih:${fixture.infoHash}`;
  const result = await resolveMagnet(bareUri, { trackers, timeoutSeconds: 60 });
  assert.equal(result.infoHash, fixture.infoHash);
  assert.equal(result.name, fixture.name);
  assert.deepEqual(result.trackers, trackers);
});

test('resolveInfoHash resolves a bare infohash end-to-end, given explicit trackers', { timeout: 90_000 }, async () => {
  // Unlike resolveMagnet, a bare infohash carries no trackers of its own — reuse a fixture
  // magnet's own tracker list (real, live UDP trackers) rather than hand-maintaining a second one.
  const fixture = magnets[1];
  const { announce: trackers } = await parseTorrent(fixture.uri);
  const result = await resolveInfoHash(fixture.infoHash, { trackers, timeoutSeconds: 60 });
  assert.equal(result.infoHash, fixture.infoHash);
  assert.equal(result.name, fixture.name);
  assert.ok(result.length > 0);
  assert.ok(Array.isArray(result.files) && result.files.length > 0);
});

test('resolveTorrentFile downloads and parses a real .torrent over HTTPS', { timeout: 30_000 }, async () => {
  const result = await resolveTorrentFile(torrentUrl);
  assert.equal(typeof result.infoHash, 'string');
  assert.equal(result.infoHash.length, 40);
  assert.equal(typeof result.name, 'string');
  assert.ok(result.name.length > 0);
  assert.ok(result.length > 0);
  assert.ok(Array.isArray(result.files) && result.files.length > 0);
  assert.equal(result.private, false);
  assert.ok(Array.isArray(result.trackers));
});

test('10 concurrent resolves (5x same magnet + 2x another + 1 torrent + 2 more distinct magnets) do not interfere with each other or the shared DHT', {
  timeout: 120_000,
}, async () => {
  const [a, b, c, d] = magnets; // 4 distinct real magnets
  const opts = { timeoutSeconds: 90 };

  const jobs = [
    ...Array.from({ length: 5 }, () => resolveMagnet(a.uri, opts)),
    ...Array.from({ length: 2 }, () => resolveMagnet(b.uri, opts)),
    resolveTorrentFile(torrentUrl),
    resolveMagnet(c.uri, opts),
    resolveMagnet(d.uri, opts),
  ];

  const results = await Promise.all(jobs);

  // All 5 calls for magnet A must resolve to A's own infoHash *and* name — proving concurrent
  // resolves for the *same* infoHash don't cross-contaminate or race on shared DHT/tracker
  // state. Checking both fields (rather than just infoHash) means a coincidental partial match
  // can't pass.
  for (const result of results.slice(0, 5)) {
    assert.equal(result.infoHash, a.infoHash);
    assert.equal(result.name, a.name);
  }
  // Both calls for magnet B must resolve to B's own infoHash and name.
  for (const result of results.slice(5, 7)) {
    assert.equal(result.infoHash, b.infoHash);
    assert.equal(result.name, b.name);
  }
  // The torrent-file resolve is a wholly separate code path (no DHT, no trackers) — must still
  // succeed correctly while 9 DHT/tracker-based resolves run alongside it. There's no
  // pre-extracted fixture to compare against here (torrentUrl is deliberately kept as a bare
  // URL — see refresh-integ-fixtures.js — since resolveTorrentFile extracts everything itself),
  // so this is a shape check rather than an identity check.
  assert.equal(typeof results[7].infoHash, 'string');
  assert.equal(results[7].infoHash.length, 40);
  // The last two must each resolve to their own distinct infoHash *and* name — proving the
  // shared DHT correctly demultiplexes concurrent lookups for different infohashes, not just
  // repeats of the same one.
  assert.equal(results[8].infoHash, c.infoHash);
  assert.equal(results[8].name, c.name);
  assert.equal(results[9].infoHash, d.infoHash);
  assert.equal(results[9].name, d.name);
});
