import { resolveTorrentFile } from './torrent-file.js';
import { resolveMagnet, resolveInfoHash } from './resolve-magnet.js';
import { shutdownSharedDht } from './shared-dht.js';
import { TorrentResolveError, TorrentTimeoutError } from './errors.js';

export {
  resolveTorrentFile,
  resolveMagnet,
  resolveInfoHash,
  shutdownSharedDht,
  TorrentResolveError,
  TorrentTimeoutError,
};

const INFO_HASH_HEX_RE = /^[0-9a-f]{40}$/i;

/**
 * Resolves torrent metadata from any supported input: an HTTPS .torrent URL, a magnet URI, or
 * a raw 40-hex-char v1 infohash.
 *
 * @param {string} input
 * @param {import('./resolve-magnet.js').TrackerOptions & { trackers?: string[], maxBytes?: number, fetchTimeoutMs?: number }} [opts] -
 *   required to include a non-empty `trackers` array when `input` is a raw infohash — enforced
 *   at runtime by resolveInfoHash (the branch actually taken isn't statically known here).
 * @returns {Promise<import('./torrent-file.js').TorrentFileInfo | import('./resolve-magnet.js').MagnetTorrentInfo>}
 */
export async function resolve(input, opts = {}) {
  if (typeof input !== 'string') {
    throw new TorrentResolveError(`Invalid input: expected a string, got ${typeof input}`);
  }

  if (/^https:\/\//i.test(input)) {
    return resolveTorrentFile(input, opts);
  }
  if (/^(stream-)?magnet:/i.test(input)) {
    return resolveMagnet(input, opts);
  }
  if (INFO_HASH_HEX_RE.test(input)) {
    return resolveInfoHash(
      input,
      /** @type {import('./resolve-magnet.js').TrackerOptions & { trackers: string[] }} */ (opts),
    );
  }

  throw new TorrentResolveError(
    `Unrecognized input: expected an https:// URL, a magnet: URI, or a 40-character hex infohash, got ${JSON.stringify(input)}`,
  );
}
