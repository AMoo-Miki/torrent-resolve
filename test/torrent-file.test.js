import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTorrentFile } from '../src/torrent-file.js';
import { TorrentResolveError } from '../src/errors.js';
import { buildTorrentFixture } from './helpers/fixtures.js';

function fakeFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

function bodyResponse(buffer, { status = 200, headers = {} } = {}) {
  return new Response(buffer, { status, headers });
}

test('rejects non-https URLs before ever calling fetch', async () => {
  const restore = fakeFetch(() => {
    throw new Error('fetch should not have been called');
  });
  try {
    await assert.rejects(() => resolveTorrentFile('http://example.com/a.torrent'), TorrentResolveError);
  } finally {
    restore();
  }
});

test('downloads and parses a valid .torrent file, returning name/infoHash/created/length/files/trackers/private', async () => {
  const created = new Date('2020-01-01T00:00:00Z');
  const { buffer, infoHash } = buildTorrentFixture({
    name: 'my-movie.mkv',
    length: 2048,
    created,
    announce: ['https://tracker-a.example/announce', 'https://tracker-b.example/announce'],
  });
  const restore = fakeFetch(async (url, init) => {
    assert.equal(String(url), 'https://example.com/a.torrent');
    assert.equal(init.headers['User-Agent'], 'qBittorrent/5.2.3');
    return bodyResponse(buffer);
  });
  try {
    const result = await resolveTorrentFile('https://example.com/a.torrent');
    assert.equal(result.name, 'my-movie.mkv');
    assert.equal(result.infoHash, infoHash);
    assert.equal(result.created.getTime(), created.getTime());
    assert.equal(result.length, 2048);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].name, 'my-movie.mkv');
    assert.equal(result.files[0].length, 2048);
    assert.deepEqual(result.trackers, ['https://tracker-a.example/announce', 'https://tracker-b.example/announce']);
    assert.equal(result.private, false);
  } finally {
    restore();
  }
});

test('surfaces the BEP 27 private flag when set', async () => {
  const { buffer } = buildTorrentFixture({ name: 'private-torrent.txt', private: true });
  const restore = fakeFetch(async () => bodyResponse(buffer));
  try {
    const result = await resolveTorrentFile('https://example.com/a.torrent');
    assert.equal(result.private, true);
  } finally {
    restore();
  }
});

test('returns created: null when the .torrent has no creation date field', async () => {
  const { buffer } = buildTorrentFixture({ name: 'no-date.txt' });
  const restore = fakeFetch(async () => bodyResponse(buffer));
  try {
    const result = await resolveTorrentFile('https://example.com/a.torrent');
    assert.equal(result.created, null);
  } finally {
    restore();
  }
});

test('rejects non-2xx responses', async () => {
  const restore = fakeFetch(async () => bodyResponse(Buffer.from('nope'), { status: 404 }));
  try {
    await assert.rejects(() => resolveTorrentFile('https://example.com/missing.torrent'), TorrentResolveError);
  } finally {
    restore();
  }
});

test('rejects when declared content-length exceeds the byte cap', async () => {
  const restore = fakeFetch(async () =>
    bodyResponse(Buffer.alloc(10), { headers: { 'content-length': String(100 * 1024 * 1024) } }),
  );
  try {
    await assert.rejects(() => resolveTorrentFile('https://example.com/huge.torrent'), TorrentResolveError);
  } finally {
    restore();
  }
});

test('rejects when the actual streamed body exceeds the byte cap (no honest content-length)', async () => {
  const restore = fakeFetch(async () => {
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    return new Response(stream, { status: 200 });
  });
  try {
    await assert.rejects(
      () => resolveTorrentFile('https://example.com/evil.torrent', { maxBytes: 2 * 1024 * 1024 }),
      TorrentResolveError,
    );
  } finally {
    restore();
  }
});
