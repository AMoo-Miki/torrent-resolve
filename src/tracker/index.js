import { EventEmitter } from 'node:events';
import { announceUdp } from './udp-tracker.js';
import { announceHttp } from './http-tracker.js';

// Trackers ask for a re-announce cadence via the `interval` field in their announce response
// (BEP 3 / BEP 15, in seconds) — typically 1800s. A single global timer, shared across every
// tracker regardless of what each one actually asked for, structurally cannot honor that: it can
// only ever apply one flat cadence to all of them. Ignoring the returned interval in favor of a
// short flat one (this used to be 15s) means announcing dozens of times over a session to a
// tracker that asked for once, which risks being rate-limited or banned — indistinguishable, from
// the outside, from "the library stopped finding peers". So each tracker gets its own
// self-scheduling loop, timed from its own most recent response.
const MIN_REANNOUNCE_INTERVAL_MS = 60_000; // floor — never hammer a tracker that asked for less
const MAX_REANNOUNCE_INTERVAL_MS = 30 * 60_000; // ceiling
// Used when a tracker's response carried no interval at all, including when the announce itself
// failed (nothing to read one from either way). Matches upstream bittorrent-tracker's
// DEFAULT_ANNOUNCE_INTERVAL.
const DEFAULT_REANNOUNCE_INTERVAL_MS = 30 * 60_000;

/**
 * @typedef {Object} AnnounceOpts
 * @property {Buffer} infoHash - 20 raw bytes
 * @property {Buffer} peerId - 20 raw bytes
 * @property {number} port
 * @property {string} [userAgent]
 * @property {AbortSignal} signal
 * @property {(warning: Error) => void} onWarning
 */

/**
 * Fans out to every supplied tracker URL, each on its own independent self-scheduling
 * announce loop timed from that tracker's own returned `interval` (clamped to
 * [MIN_REANNOUNCE_INTERVAL_MS, MAX_REANNOUNCE_INTERVAL_MS], defaulting to
 * DEFAULT_REANNOUNCE_INTERVAL_MS when absent) — never a single shared cadence, so a slow or dead
 * tracker only ever delays itself, and a tracker that asked for a long interval isn't hammered
 * at some shorter one anyway. Peers are deduped across trackers.
 *
 * Emits:
 *  - `'peer'` — `{host: string, port: number}`, emitted as each tracker's response arrives,
 *    deduped across trackers and across re-announces
 *  - `'warning'` — `Error`, for one tracker's failure; never fatal to the others
 */
export class TrackerClient extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string} opts.infoHash - lowercase 40-char hex
   * @param {Buffer} opts.peerId - 20 raw bytes
   * @param {string[]} opts.announce - tracker announce URLs
   * @param {number} opts.port
   * @param {string} [opts.userAgent]
   * @param {number} [opts.reannounceIntervalMs] - test-only: when set, every tracker
   *   re-announces on this fixed interval instead, ignoring both its own returned interval and
   *   the floor/ceiling clamp. Production code never sets this; it exists so tests don't have to
   *   wait real minutes for a real cadence.
   * @param {{min?: number, max?: number, fallback?: number}} [opts.reannounceClampMs] -
   *   test-only: overrides the floor/ceiling/no-interval-fallback bounds (each in ms) used when
   *   reannounceIntervalMs is not set, so a real (not overridden) tracker interval can still be
   *   observed on a fast, distinguishable cadence in a test. Production code never sets this;
   *   the real bounds are MIN/MAX/DEFAULT_REANNOUNCE_INTERVAL_MS below.
   */
  constructor({ infoHash, peerId, announce, port, userAgent, reannounceIntervalMs, reannounceClampMs }) {
    super();
    this._infoHashBuf = Buffer.from(infoHash, 'hex');
    this._peerId = peerId;
    this._announceUrls = announce;
    this._port = port;
    this._userAgent = userAgent;
    this._reannounceIntervalMsOverride = reannounceIntervalMs;
    this._reannounceClampMs = reannounceClampMs;

    this._destroyed = false;
    this._controller = new AbortController();
    /** @type {Map<string, NodeJS.Timeout>} one independent reannounce timer per tracker URL */
    this._timers = new Map();
    /** @type {Set<string>} */
    this._seenPeers = new Set();
  }

  start() {
    if (this._destroyed) return;
    for (const url of this._announceUrls) {
      this._scheduleAnnounce(url, 0);
    }
  }

  /**
   * @param {string} url
   * @param {number} delayMs
   */
  _scheduleAnnounce(url, delayMs) {
    if (this._destroyed) return;
    const timer = setTimeout(() => {
      this._announceOne(url).then(
        (nextDelayMs) => this._scheduleAnnounce(url, nextDelayMs),
        (err) => {
          if (!this._destroyed) this.emit('warning', err instanceof Error ? err : new Error(String(err)));
          this._scheduleAnnounce(url, this._reannounceIntervalMsOverride ?? DEFAULT_REANNOUNCE_INTERVAL_MS);
        },
      );
    }, delayMs);
    timer.unref?.();
    this._timers.set(url, timer);
  }

  /**
   * Announces once to a single tracker and emits its peers as soon as this call resolves —
   * never held back for any other tracker's loop.
   * @param {string} url
   * @returns {Promise<number>} the delay, in ms, before this same tracker should be
   *   re-announced to
   */
  async _announceOne(url) {
    let protocol;
    try {
      protocol = new URL(url).protocol;
    } catch (cause) {
      throw new Error(`invalid tracker URL ${JSON.stringify(url)}`, { cause });
    }

    const opts = {
      infoHash: this._infoHashBuf,
      peerId: this._peerId,
      port: this._port,
      userAgent: this._userAgent,
      signal: this._controller.signal,
      onWarning: (/** @type {Error} */ warning) => {
        if (!this._destroyed) this.emit('warning', warning);
      },
    };

    let result;
    if (protocol === 'udp:') {
      result = await announceUdp(url, opts);
    } else if (protocol === 'http:' || protocol === 'https:') {
      result = await announceHttp(url, opts);
    } else {
      throw new Error(`unsupported tracker protocol for ${JSON.stringify(url)}`);
    }

    if (!this._destroyed) {
      for (const peer of result.peers) {
        this._emitPeer(peer);
      }
    }

    if (this._reannounceIntervalMsOverride != null) return this._reannounceIntervalMsOverride;
    return clampReannounceIntervalMs(result.interval, this._reannounceClampMs);
  }

  /** @param {{host: string, port: number}} peer */
  _emitPeer(peer) {
    // A tracker response is untrusted input; a decoded entry can claim any host/port at all.
    // Port 0 isn't a connectable port under any circumstance, so it's never worth a wasted
    // connection attempt downstream.
    if (!peer.host || !Number.isInteger(peer.port) || peer.port <= 0 || peer.port > 0xffff) return;

    const key = peer.host.includes(':') ? `[${peer.host}]:${peer.port}` : `${peer.host}:${peer.port}`;
    if (this._seenPeers.has(key)) return;
    this._seenPeers.add(key);
    this.emit('peer', peer);
  }

  /** Aborts any in-flight announces, stops every per-tracker reannounce timer, and drops all
   *  listeners. */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const timer of this._timers.values()) clearTimeout(timer);
    this._timers.clear();
    this._controller.abort();
    this.removeAllListeners();
  }
}

/**
 * @param {number|null|undefined} intervalSeconds - a tracker's returned `interval`, or
 *   null/undefined if it didn't send one
 * @param {{min?: number, max?: number, fallback?: number}} [bounds] - test-only override of the
 *   real MIN/MAX/DEFAULT_REANNOUNCE_INTERVAL_MS bounds below
 * @returns {number} the reannounce delay, in ms
 */
export function clampReannounceIntervalMs(intervalSeconds, bounds = {}) {
  const min = bounds.min ?? MIN_REANNOUNCE_INTERVAL_MS;
  const max = bounds.max ?? MAX_REANNOUNCE_INTERVAL_MS;
  const fallback = bounds.fallback ?? DEFAULT_REANNOUNCE_INTERVAL_MS;
  // Neither call site can produce NaN/Infinity today (UDP always reads a real u32; HTTP guards
  // with typeof === 'number' && > 0), but this is exported module surface, not a value only
  // ever seen coming from those two call sites — and Math.max/Math.min with NaN produce NaN,
  // which setTimeout coerces to a 1ms delay. That's exactly the hammering this whole change
  // exists to prevent, so it's worth guarding here rather than trusting every future caller.
  if (!Number.isFinite(intervalSeconds)) return fallback;
  const ms = /** @type {number} */ (intervalSeconds) * 1000;
  return Math.min(Math.max(ms, min), max);
}
