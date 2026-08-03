import bencode from 'bencode';
import { TorrentResolveError } from '../errors.js';
import { percentEncodeBytes } from './url-encode.js';
import { decodeCompactPeers4, decodeCompactPeers6 } from './compact-peers.js';

const REQUEST_TIMEOUT_MS = 15_000;

// A tracker response is a small bencoded dict; nothing legitimate approaches this. Caps the
// amount of untrusted data buffered into memory from a server we don't control.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// BEP 15's sentinel for "total torrent size unknown", sent as decimal text over HTTP for the
// same reason as the UDP path — this library never downloads pieces, so `left` never has a real
// value to report.
const LEFT_UNKNOWN_DECIMAL = '18446744073709551615';

/**
 * @typedef {Object} HttpAnnounceOpts
 * @property {Buffer} infoHash - 20 raw bytes
 * @property {Buffer} peerId - 20 raw bytes
 * @property {number} port
 * @property {string} [userAgent]
 * @property {AbortSignal} [signal]
 * @property {(warning: Error) => void} [onWarning] - called (without failing the announce) if
 *   the tracker sends a non-fatal `warning message` alongside a still-usable peer list
 */

/**
 * Announces to a single HTTP/HTTPS tracker (BEP 3). A `failure reason` in the response is a
 * hard error for this tracker (rejects); a `warning message` is reported via `opts.onWarning`
 * but the returned peers are still valid.
 * @param {string} announceUrl
 * @param {HttpAnnounceOpts} opts
 * @returns {Promise<{ peers: Array<{host: string, port: number}>, interval: number|null }>}
 */
export async function announceHttp(announceUrl, opts) {
  const requestUrl = buildRequestUrl(announceUrl, opts);

  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

  let response;
  try {
    response = await fetch(requestUrl, {
      signal,
      // An empty User-Agent header is worse than none at all — some trackers treat a blank
      // value as a bot signal, whereas an absent header just falls back to fetch's own default.
      headers: opts.userAgent ? { 'user-agent': opts.userAgent } : undefined,
    });
  } catch (cause) {
    throw new TorrentResolveError(`Failed to reach HTTP tracker ${announceUrl}`, { cause });
  }

  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw new TorrentResolveError(`HTTP tracker ${announceUrl} responded with HTTP ${response.status}`);
  }

  const body = await readBodyWithCap(response, announceUrl);

  let data;
  try {
    data = bencode.decode(body);
  } catch (cause) {
    throw new TorrentResolveError(`Failed to decode response from HTTP tracker ${announceUrl}`, { cause });
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new TorrentResolveError(`HTTP tracker ${announceUrl} did not respond with a bencoded dictionary`);
  }

  const failure = data['failure reason'];
  if (failure) {
    throw new TorrentResolveError(`HTTP tracker ${announceUrl} reported a failure: ${bufToText(failure)}`);
  }

  const warning = data['warning message'];
  if (warning) {
    opts.onWarning?.(new TorrentResolveError(`HTTP tracker ${announceUrl} reported a warning: ${bufToText(warning)}`));
  }

  const rawInterval = data.interval ?? data['min interval'];
  const interval = typeof rawInterval === 'number' && rawInterval > 0 ? rawInterval : null;

  const peers = [...decodePeers4(data.peers), ...decodePeers6(data.peers6)];

  return { peers, interval };
}

/**
 * @param {string} announceUrl
 * @param {HttpAnnounceOpts} opts
 * @returns {string}
 */
function buildRequestUrl(announceUrl, opts) {
  if (opts.infoHash.length !== 20) throw new Error(`infoHash must be 20 raw bytes, got ${opts.infoHash.length}`);
  if (opts.peerId.length !== 20) throw new Error(`peerId must be 20 raw bytes, got ${opts.peerId.length}`);

  const params = [
    `info_hash=${percentEncodeBytes(opts.infoHash)}`,
    `peer_id=${percentEncodeBytes(opts.peerId)}`,
    `port=${opts.port}`,
    'uploaded=0',
    'downloaded=0',
    `left=${LEFT_UNKNOWN_DECIMAL}`,
    'compact=1',
    'numwant=50',
    'event=started', // the only announce this library ever makes per attempt
  ].join('&');

  return announceUrl + (announceUrl.includes('?') ? '&' : '?') + params;
}

/**
 * @param {Response} response
 * @param {string} announceUrl
 * @returns {Promise<Uint8Array>}
 */
async function readBodyWithCap(response, announceUrl) {
  if (!response.body) {
    throw new TorrentResolveError(`HTTP tracker ${announceUrl} sent an empty response body`);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel(`exceeded ${MAX_RESPONSE_BYTES} byte cap`).catch(() => {});
        throw new TorrentResolveError(
          `Refusing to read response from HTTP tracker ${announceUrl}: exceeded ${MAX_RESPONSE_BYTES} byte cap`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** @param {Uint8Array} buf */
function bufToText(buf) {
  return Buffer.from(buf).toString('utf8');
}

/** @param {unknown} peers */
function decodePeers4(peers) {
  if (ArrayBuffer.isView(peers)) {
    return decodeCompactPeers4(/** @type {Uint8Array} */ (peers));
  }
  if (Array.isArray(peers)) {
    return peers.map((peer) => ({ host: bufToText(peer.ip), port: Number(peer.port) }));
  }
  return [];
}

/** @param {unknown} peers6 */
function decodePeers6(peers6) {
  if (ArrayBuffer.isView(peers6)) {
    return decodeCompactPeers6(/** @type {Uint8Array} */ (peers6));
  }
  if (Array.isArray(peers6)) {
    return peers6.map((peer) => ({ host: bufToText(peer.ip), port: Number(peer.port) }));
  }
  return [];
}
