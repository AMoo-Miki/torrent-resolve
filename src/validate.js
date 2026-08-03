import { TorrentResolveError } from './errors.js';

const INFO_HASH_HEX_RE = /^[0-9a-f]{40}$/i;

/**
 * Validates a BEP 3 v1 infohash (40 hex chars). v2/hybrid (base32, `urn:btmh:`) is out of
 * scope and rejected explicitly rather than silently mishandled.
 * @param {string} hash
 * @returns {string} lowercased hash
 */
export function assertValidInfoHash(hash) {
  if (typeof hash !== 'string' || !INFO_HASH_HEX_RE.test(hash)) {
    throw new TorrentResolveError(
      `Invalid infoHash: expected a 40-character hex string (BEP 3 v1 only), got ${JSON.stringify(hash)}`,
    );
  }
  return hash.toLowerCase();
}

/**
 * Validates that a URL is https:// specifically (no http:, file:, etc).
 * @param {string} url
 * @returns {URL}
 */
export function assertHttpsUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw new TorrentResolveError(`Invalid URL: ${JSON.stringify(url)}`, { cause });
  }
  if (parsed.protocol !== 'https:') {
    throw new TorrentResolveError(
      `Only https:// URLs are supported, got protocol ${JSON.stringify(parsed.protocol)} for ${JSON.stringify(url)}`,
    );
  }
  return parsed;
}

const ALLOWED_TRACKER_PROTOCOLS = new Set(['http:', 'https:', 'udp:', 'ws:', 'wss:']);

/**
 * Validates a tracker announce URL uses a known BitTorrent tracker scheme.
 * @param {string} url
 * @returns {boolean}
 */
export function isValidTrackerUrl(url) {
  try {
    const parsed = new URL(url);
    return ALLOWED_TRACKER_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Validates a required timeoutSeconds option: finite, positive number.
 * @param {unknown} value
 * @returns {number}
 */
export function assertValidTimeoutSeconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TorrentResolveError(
      `Invalid timeoutSeconds: expected a positive finite number, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}
