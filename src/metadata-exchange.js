import net from 'node:net';
import Protocol from 'bittorrent-protocol';
import utMetadata from 'ut_metadata';

const DEFAULT_PEER_TIMEOUT_MS = 8_000;

/**
 * Connects to a single peer, performs the wire handshake, and requests the torrent metadata
 * via BEP 9 (ut_metadata). Resolves with the sha1-verified, bencode-wrapped torrent buffer
 * ut_metadata emits on success. Always tears down the socket/wire before settling, whether it
 * succeeds, fails, or is aborted — this function never leaves a dangling connection behind.
 *
 * @param {{host: string, port: number}} peerAddr
 * @param {string} infoHash - lowercase 40-char hex
 * @param {Buffer} peerId - 20 bytes
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal] - external cancellation (e.g. another peer already won)
 * @returns {Promise<Buffer>}
 */
export function fetchMetadataFromPeer(peerAddr, infoHash, peerId, opts = {}) {
  const { timeoutMs = DEFAULT_PEER_TIMEOUT_MS, signal } = opts;

  /** @type {Promise<Buffer>} */
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {import('node:net').Socket|null} */
    let socket = null;
    /** @type {any} */ // untyped: 'bittorrent-protocol' ships no types
    let wire = null;

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      if (wire) {
        wire.removeAllListeners();
        wire.destroy();
      }
      if (socket) {
        socket.removeAllListeners();
        socket.destroy();
      }
    };

    /** @param {Error} err */
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    /** @param {Buffer} buf */
    const succeed = (buf) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(buf);
    };

    const onAbort = () => fail(new Error('aborted: superseded by another peer or overall timeout'));
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    socket = net.connect({ host: peerAddr.host, port: peerAddr.port });
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => fail(new Error(`connection to ${peerAddr.host}:${peerAddr.port} timed out`)));
    socket.once('error', fail);

    socket.once('connect', () => {
      wire = new Protocol();
      wire.setTimeout(timeoutMs, true);
      socket.pipe(wire).pipe(socket);

      wire.once('error', fail);

      wire.use(utMetadata());
      wire.ut_metadata.on('metadata', succeed);
      wire.ut_metadata.on('warning', () => {
        // Peer doesn't support ut_metadata / has no metadata yet / gave bad data — not fatal
        // to the overall resolution, another peer may still succeed. The per-connection
        // timeout above will eventually fail this one out if nothing else happens.
      });

      wire.handshake(infoHash, peerId, { dht: true });
      wire.ut_metadata.fetch();
    });
  });
}
