import { EventEmitter } from 'node:events';
import { TrackerClient } from './tracker/index.js';
import { USER_AGENT as DEFAULT_USER_AGENT } from './client-identity.js';

const DHT_RELOOKUP_INTERVAL_MS = 15_000;

/**
 * Sources peers for a single infoHash from both the shared warm DHT singleton and (if any
 * trackers were supplied) a per-call tracker client, deduped by "host:port", emitted as
 * `'peer'` events. Also emits `'warning'` for non-fatal tracker issues (bad/unreachable
 * tracker) — callers should log these but never treat them as fatal to the overall attempt.
 */
export class PeerDiscovery extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {any} opts.dht - the already-resolved shared warm DHT singleton (untyped: 'bittorrent-dht' ships no types)
   * @param {string} opts.infoHash - lowercase 40-char hex
   * @param {string[]} opts.trackers
   * @param {Buffer} opts.peerId
   * @param {number} opts.port - informational only; this library never listens for incoming connections
   * @param {string} [opts.userAgent]
   */
  constructor({ dht, infoHash, trackers, peerId, port, userAgent = DEFAULT_USER_AGENT }) {
    super();
    this._dht = dht;
    this.infoHash = infoHash;
    this.trackers = trackers;
    this.peerId = peerId;
    this.port = port;
    this.userAgent = userAgent;

    this._seen = new Set();
    /** @type {((peer: {host: string, port: number}, infoHashBuf: Buffer) => void)|null} */
    this._dhtPeerListener = null;
    /** @type {NodeJS.Timeout|null} */
    this._dhtInterval = null;
    this._tracker = null;
    this._destroyed = false;
  }

  start() {
    this._dhtPeerListener = (peer, infoHashBuf) => {
      if (infoHashBuf.toString('hex') !== this.infoHash) return;
      this._emitPeer(peer);
    };
    this._dht.on('peer', this._dhtPeerListener);
    this._lookupDht();
    this._dhtInterval = setInterval(() => this._lookupDht(), DHT_RELOOKUP_INTERVAL_MS);
    this._dhtInterval.unref?.();

    if (this.trackers.length > 0) {
      this._tracker = new TrackerClient({
        infoHash: this.infoHash,
        peerId: this.peerId,
        announce: this.trackers,
        port: this.port,
        userAgent: this.userAgent,
      });
      this._tracker.on('warning', (/** @type {Error} */ err) => this.emit('warning', err));
      this._tracker.on('peer', (/** @type {{host: string, port: number}} */ peer) => this._emitPeer(peer));
      this._tracker.start();
    }
  }

  _lookupDht() {
    if (this._destroyed || !this._dht) return;
    this._dht.lookup(this.infoHash);
  }

  /** @param {{host: string, port: number}} peer */
  _emitPeer(peer) {
    // Bracket IPv6 hosts so the key stays unambiguous — plain colon-joining a host that already
    // contains colons would make it impossible to tell where the address ends and the port
    // starts.
    const key = peer.host.includes(':') ? `[${peer.host}]:${peer.port}` : `${peer.host}:${peer.port}`;
    if (this._seen.has(key)) return;
    this._seen.add(key);
    this.emit('peer', { host: peer.host, port: peer.port });
  }

  /** Tears down per-call resources (tracker client, DHT listener/interval). Never touches the shared DHT itself. */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._dht && this._dhtPeerListener) this._dht.removeListener('peer', this._dhtPeerListener);
    if (this._dhtInterval) clearInterval(this._dhtInterval);
    if (this._tracker) this._tracker.destroy();
    this.removeAllListeners();
  }
}
