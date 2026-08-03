import bencode from 'bencode';
import { createHash } from 'node:crypto';

function buildInfo({ name, length, isPrivate }) {
  const info = {
    name,
    length,
    'piece length': 16384,
    pieces: Buffer.alloc(20, 1), // one fake 20-byte piece hash
  };
  if (isPrivate) info.private = 1;
  return info;
}

/**
 * Builds a minimal, valid single-file .torrent buffer (bencoded) for test fixtures.
 * @param {Object} [opts]
 * @param {string} [opts.name]
 * @param {number} [opts.length]
 * @param {Date} [opts.created]
 * @param {boolean} [opts.private]
 * @param {string[]} [opts.announce]
 * @returns {{ buffer: Buffer, infoHash: string }}
 */
export function buildTorrentFixture({
  name = 'test-file.txt',
  length = 1024,
  created,
  private: isPrivate = false,
  announce = ['https://tracker.example/announce'],
} = {}) {
  const info = buildInfo({ name, length, isPrivate });
  const infoHash = createHash('sha1').update(bencode.encode(info)).digest('hex');

  const torrent = { info, 'announce-list': announce.map((url) => [url]) };
  if (created) torrent['creation date'] = Math.floor(created.getTime() / 1000);

  return { buffer: Buffer.from(bencode.encode(torrent)), infoHash };
}

/**
 * Builds just the bencoded {info: {...}} buffer that ut_metadata's 'metadata' event emits
 * (i.e. no announce/creation-date wrapper — matches what the magnet/hash path actually gets).
 */
export function buildMetadataOnlyFixture({ name = 'test-file.txt', length = 1024, private: isPrivate = false } = {}) {
  const info = buildInfo({ name, length, isPrivate });
  const infoHash = createHash('sha1').update(bencode.encode(info)).digest('hex');
  return { buffer: Buffer.from(bencode.encode({ info })), infoHash };
}
