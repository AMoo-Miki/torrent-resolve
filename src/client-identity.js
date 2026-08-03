import { randomBytes } from 'node:crypto';

/**
 * Shared client identity presented to trackers/peers (HTTP User-Agent header, and the
 * BEP 20 peer-id prefix used in the wire handshake). Mimics a common, currently-maintained
 * client rather than a bespoke/unrecognized one, since some trackers and peers are picky
 * about unfamiliar clients. This is a compatibility choice, not a protocol requirement —
 * it will go stale as new qBittorrent versions ship and should be bumped periodically.
 * Both are overridable per-call via opts.
 */
export const USER_AGENT = 'qBittorrent/5.2.3'; // current stable as of 2026-08

/** BEP 20 style prefix, paired with USER_AGENT above. */
export const PEER_ID_PREFIX = '-qB5230-';

/**
 * Generates a fresh 20-byte BEP 20 peer id: PEER_ID_PREFIX followed by random bytes.
 * @param {string} [prefix]
 * @returns {Buffer}
 */
export function generatePeerId(prefix = PEER_ID_PREFIX) {
  const prefixBuf = Buffer.from(prefix, 'ascii');
  const randomPart = randomBytes(20 - prefixBuf.length);
  return Buffer.concat([prefixBuf, randomPart]);
}
