import parseTorrent from 'parse-torrent';
import { assertValidInfoHash, assertValidTimeoutSeconds } from './validate.js';
import { TorrentResolveError, TorrentTimeoutError } from './errors.js';
import { buildTrackerList } from './trackers.js';
import { generatePeerId } from './client-identity.js';
import { getSharedDht } from './shared-dht.js';
import { PeerDiscovery } from './peer-discovery.js';
import { fetchMetadataFromPeer } from './metadata-exchange.js';

const DEFAULT_TIMEOUT_SECONDS = 600; // 10 minutes
const PEER_TIMEOUT_MS = 8_000;

/**
 * Real collaborators used in production. Tests pass a fake `deps` object into
 * resolveByInfoHash to exercise the retry/timeout/teardown orchestration below without
 * touching the network, DHT, or any real sockets.
 */
const defaultDeps = { getSharedDht, PeerDiscovery, fetchMetadataFromPeer };

/**
 * @typedef {Object} MagnetTorrentInfo
 * @property {string} name - verified via BEP 9's sha1 check, NOT the magnet's untrusted `dn`
 * @property {string} infoHash - lowercase 40-char hex
 * @property {number} length - total size in bytes
 * @property {import('./torrent-file.js').TorrentFile[]} files
 * @property {boolean} private - BEP 27 flag. Only knowable after metadata arrives (it's inside
 *   the info dict, delivered alongside name/length/etc via BEP 9) — by definition too late to
 *   have skipped DHT/trackers for a private torrent, since discovering peers via DHT/trackers is
 *   how the metadata got fetched in the first place. Informational only; does not change how
 *   this call itself was resolved.
 * @property {string[]} trackers - the enriched tracker list actually used for discovery: the
 *   magnet's own announce list plus opts.trackers, minus opts.denylist and invalid-scheme
 *   entries (see trackers.js). Reflects what was attempted, not which trackers actually
 *   responded — no liveness filtering is done.
 */

/**
 * @typedef {Object} TrackerOptions
 * @property {string[]} [trackers] - extra tracker announce URLs, merged with the magnet's own
 * @property {string[]} [denylist] - tracker URLs to exclude from the merged list
 * @property {number} [timeoutSeconds=600] - total budget to keep retrying before giving up
 * @property {string} [dhtCacheFile] - optional on-disk DHT routing-table cache path (opt-in; see shared-dht.js)
 * @property {Array<{host: string, port: number}>} [dhtBootstrapNodes] - extra DHT seed nodes
 * @property {string} [userAgent] - overrides client-identity.js's default for tracker HTTP announces
 */

/**
 * Resolves a magnet URI to verified torrent metadata via DHT + BitTorrent trackers (BEP 9).
 * @param {string} magnetUri
 * @param {TrackerOptions} [opts]
 * @returns {Promise<MagnetTorrentInfo>}
 */
export async function resolveMagnet(magnetUri, opts = {}) {
  let parsed;
  try {
    parsed = await parseTorrent(magnetUri);
  } catch (cause) {
    throw new TorrentResolveError(`Invalid magnet URI: ${JSON.stringify(magnetUri)}`, { cause });
  }
  // Defense-in-depth, not currently reachable: parse-torrent's own magnet-string branch already
  // throws "Invalid torrent identifier" (caught above) whenever its parsed infoHash would be
  // falsy, for every falsy case verified (no xt=, empty btih, short btih) — so today this
  // function's own catch above always fires first. Kept in case a future parse-torrent version
  // stops guaranteeing that and starts returning an object with a falsy infoHash instead.
  /* c8 ignore start */
  if (!parsed.infoHash) {
    throw new TorrentResolveError(
      `Magnet URI has no v1 BitTorrent infohash (only v1/40-hex infohashes are supported): ${JSON.stringify(magnetUri)}`,
    );
  }
  /* c8 ignore stop */

  return resolveByInfoHash({
    infoHash: assertValidInfoHash(parsed.infoHash),
    // Defense-in-depth, not currently reachable: magnet-uri always sets .announce to an array
    // (empty when the magnet has no tr=), never null/undefined, so this fallback's right side
    // never fires today. Kept in case a future magnet-uri version stops guaranteeing that.
    magnetAnnounce: parsed.announce /* c8 ignore next */ ?? [],
    untrustedName: parsed.dn ?? null,
    opts,
  });
}

/**
 * Resolves a raw infohash to verified torrent metadata via DHT + BitTorrent trackers (BEP 9).
 * Unlike resolveMagnet, `opts.trackers` is mandatory here — a bare hash has no trackers of its
 * own, so without any supplied, resolution would depend on DHT alone, which this library
 * intentionally does not allow silently.
 * @param {string} hash
 * @param {TrackerOptions & { trackers: string[] }} opts
 * @returns {Promise<MagnetTorrentInfo>}
 */
export async function resolveInfoHash(hash, opts) {
  const infoHash = assertValidInfoHash(hash);
  if (!Array.isArray(opts?.trackers) || opts.trackers.length === 0) {
    throw new TorrentResolveError('resolveInfoHash requires a non-empty opts.trackers array');
  }

  return resolveByInfoHash({
    infoHash,
    magnetAnnounce: [],
    untrustedName: null,
    opts,
  });
}

/**
 * @param {Object} args
 * @param {string} args.infoHash
 * @param {string[]} args.magnetAnnounce
 * @param {string|null} args.untrustedName
 * @param {TrackerOptions} args.opts
 * @param {typeof defaultDeps} [deps]
 * @returns {Promise<MagnetTorrentInfo>}
 */
export async function resolveByInfoHash({ infoHash, magnetAnnounce, untrustedName, opts }, deps = defaultDeps) {
  const timeoutSeconds = assertValidTimeoutSeconds(opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS);
  const trackerList = buildTrackerList({
    magnetAnnounce,
    extraTrackers: opts.trackers ?? [],
    denylist: opts.denylist ?? [],
  });

  const peerId = generatePeerId();
  const dht = await deps.getSharedDht({
    dhtCacheFile: opts.dhtCacheFile,
    dhtBootstrapNodes: opts.dhtBootstrapNodes,
  });
  const port = dht.address().port;

  const discovery = new deps.PeerDiscovery({
    dht,
    infoHash,
    trackers: trackerList,
    peerId,
    port,
    userAgent: opts.userAgent,
  });
  const controller = new AbortController();
  const startedAt = Date.now();

  /** @type {(buf: Buffer) => void} */
  let winResolve;
  /** @type {Promise<Buffer>} */
  const winner = new Promise((resolve) => {
    winResolve = resolve;
  });

  discovery.on('peer', (peer) => {
    if (controller.signal.aborted) return;
    deps
      .fetchMetadataFromPeer(peer, infoHash, peerId, {
        signal: controller.signal,
        timeoutMs: PEER_TIMEOUT_MS,
      })
      .then((buf) => winResolve(buf))
      .catch(() => {
        // Individual peer/connection failures are never fatal to the overall attempt — only
        // exhausting the timeout budget below is. This is what "really try for t seconds even
        // if there were failures" means in practice.
      });
  });
  // Tracker warnings (bad/unreachable tracker) are informational only — never abort the attempt.
  discovery.on('warning', () => {});

  discovery.start();

  let timeoutId;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new TorrentTimeoutError(`Timed out after ${timeoutSeconds}s resolving infoHash ${infoHash}`, {
          infoHash,
          name: untrustedName,
          elapsedMs: Date.now() - startedAt,
        }),
      );
    }, timeoutSeconds * 1000);
  });

  let resultBuf;
  try {
    resultBuf = await Promise.race([winner, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
    controller.abort();
    discovery.destroy();
  }

  const parsedResult = await parseTorrent(resultBuf);
  return {
    name: parsedResult.name,
    infoHash: parsedResult.infoHash,
    length: parsedResult.length,
    files: parsedResult.files,
    private: parsedResult.private ?? false,
    trackers: trackerList,
  };
}
