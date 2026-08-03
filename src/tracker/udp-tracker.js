import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { TorrentResolveError } from '../errors.js';
import { decodeCompactPeers4, decodeCompactPeers6 } from './compact-peers.js';

// BEP 15 specifies retransmitting at 15 * 2^n seconds across up to 8 attempts (15s, 30s, 60s,
// ..., almost 4 minutes total), tuned for 2008-era networks. That is far too slow for a library
// that answers a single interactive resolve() call: TrackerClient already re-announces every
// 15s, and resolveMagnet owns the overall timeout budget one level above that — so a single UDP
// tracker that's slow or silent should fail fast and let those outer mechanisms pick it up, not
// spend up to 45s (the previous schedule's worst case) blocking one announce attempt on its own.
// One attempt, ~5s, then give up. Overridable via opts.retransmitScheduleMs for tests. Do not
// "fix" this back toward the BEP's timings — the slowness they're tuned for is exactly what this
// library can't afford to wait through.
const DEFAULT_RETRANSMIT_SCHEDULE_MS = [5_000];

const PROTOCOL_ID = 0x41727101980n;
const ACTION_CONNECT = 0;
const ACTION_ANNOUNCE = 1;
const ACTION_ERROR = 3;
const EVENT_STARTED = 2;

/** BEP 15's sentinel for "total torrent size unknown" — this library never downloads pieces, so
 * every announce sends this rather than a real remaining-bytes count. */
export const LEFT_UNKNOWN = 0xffffffffffffffffn;

/** Thrown when the tracker itself sends action=3 (error) for a request we made. */
class TrackerErrorResponse extends Error {}

/**
 * @typedef {Object} UdpAnnounceOpts
 * @property {Buffer} infoHash - 20 raw bytes
 * @property {Buffer} peerId - 20 raw bytes
 * @property {number} port
 * @property {number[]} [retransmitScheduleMs]
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {Object} UdpCtx
 * @property {import('node:dgram').Socket} socket
 * @property {string} address
 * @property {number} port
 * @property {number[]} scheduleMs
 * @property {AbortSignal} [signal]
 * @property {number} peerEntrySize
 */

/**
 * Announces to a single UDP tracker (BEP 15): connect, then announce, retransmitting on a fixed
 * backoff schedule if the tracker stays silent. Always opens its own socket for the call and
 * closes it before returning — no session state, no caching, nothing survives past one call.
 * @param {string} announceUrl
 * @param {UdpAnnounceOpts} opts
 * @returns {Promise<{ peers: Array<{host: string, port: number}>, interval: number|null }>}
 */
export async function announceUdp(announceUrl, opts) {
  const { hostname, port: trackerPort } = parseUdpAnnounceUrl(announceUrl);
  const scheduleMs = opts.retransmitScheduleMs ?? DEFAULT_RETRANSMIT_SCHEDULE_MS;

  const { address, family } = await resolveTrackerHost(stripBrackets(hostname));
  const peerEntrySize = family === 6 ? 18 : 6;
  const socket = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');

  const ctx = { socket, address, port: trackerPort, scheduleMs, signal: opts.signal, peerEntrySize };

  try {
    const connectionId = await getConnectionId(ctx);
    return await sendAnnounce(ctx, connectionId, opts);
  } catch (err) {
    if (err instanceof TrackerErrorResponse) {
      throw new TorrentResolveError(`UDP tracker ${announceUrl} returned an error: ${err.message}`, { cause: err });
    }
    throw err;
  } finally {
    closeSocketSafely(socket);
  }
}

/**
 * Resolves a tracker hostname preferring an IPv4 address, falling back to IPv6 only when no
 * IPv4 address exists. BEP 15's UDP announce response has no field saying whether its compact
 * peer list is 6-byte (IPv4) or 18-byte (IPv6) entries — that has to be inferred from which
 * family we reached the tracker on, and IPv4 is what the overwhelming majority of real UDP
 * trackers actually mean by that. Preferring it (rather than whatever dns.lookup's default
 * ordering happens to return) keeps a dual-stack tracker on the well-understood path; an
 * IPv6-only tracker (no A record at all) still works via the fallback.
 * @param {string} hostname
 * @returns {Promise<{address: string, family: number}>}
 */
async function resolveTrackerHost(hostname) {
  try {
    return await dns.lookup(hostname, { family: 4 });
  } catch {
    return await dns.lookup(hostname, { family: 6 });
  }
}

/**
 * @param {string} announceUrl
 * @returns {{ hostname: string, port: number }}
 */
function parseUdpAnnounceUrl(announceUrl) {
  let parsed;
  try {
    parsed = new URL(announceUrl);
  } catch (cause) {
    throw new TorrentResolveError(`Invalid UDP tracker URL: ${JSON.stringify(announceUrl)}`, { cause });
  }
  if (parsed.protocol !== 'udp:') {
    throw new TorrentResolveError(`Expected a udp: tracker URL, got ${JSON.stringify(announceUrl)}`);
  }
  // `udp:` isn't a WHATWG "special" scheme, so URL never fills in a default port — parsed.port
  // is '' when the URL didn't specify one. 80 matches what this URL would've meant to the
  // client this replaces, rather than silently dropping an otherwise-valid tracker.
  const port = parsed.port === '' ? 80 : Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 0xffff) {
    throw new TorrentResolveError(`Invalid port in UDP tracker URL: ${JSON.stringify(announceUrl)}`);
  }
  return { hostname: parsed.hostname, port };
}

/** @param {string} hostname */
function stripBrackets(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * @param {UdpCtx} ctx
 * @returns {Promise<bigint>}
 */
async function getConnectionId(ctx) {
  const transactionId = randomBytes(4);
  return sendWithRetransmit({
    ...ctx,
    buildPacket: () => buildConnectPacket(transactionId),
    parseResponse: (msg) => parseConnectResponse(msg, transactionId),
  });
}

/**
 * @param {UdpCtx} ctx
 * @param {bigint} connectionId
 * @param {UdpAnnounceOpts} opts
 */
async function sendAnnounce(ctx, connectionId, opts) {
  const transactionId = randomBytes(4);
  const key = randomBytes(4).readUInt32BE(0);
  return sendWithRetransmit({
    ...ctx,
    buildPacket: () =>
      buildAnnouncePacket({
        connectionId,
        transactionId,
        infoHash: opts.infoHash,
        peerId: opts.peerId,
        key,
        port: opts.port,
      }),
    parseResponse: (msg) => parseAnnounceResponse(msg, transactionId, ctx.peerEntrySize),
  });
}

/**
 * Sends `buildPacket()` and waits for a matching response, resending on the retransmit schedule
 * if the tracker stays silent. `parseResponse` returns `undefined` for a datagram that isn't a
 * match for this exchange (wrong transaction id, or too short to even read one) — those are
 * silently ignored rather than settling anything, since accepting an unmatched response is
 * exactly the forgery this validation exists to prevent. A thrown error from `parseResponse`
 * (a matching transaction id but a malformed/hostile payload) rejects immediately.
 * @param {Object} args
 * @param {import('node:dgram').Socket} args.socket
 * @param {string} args.address
 * @param {number} args.port
 * @param {number[]} args.scheduleMs
 * @param {AbortSignal} [args.signal]
 * @param {() => Buffer} args.buildPacket
 * @param {(msg: Buffer) => any} args.parseResponse
 * @returns {Promise<any>}
 */
function sendWithRetransmit({ socket, address, port, scheduleMs, signal, buildPacket, parseResponse }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let attempt = 0;
    /** @type {NodeJS.Timeout|null} */
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      socket.removeListener('message', onMessage);
      socket.removeListener('error', onSocketError);
      signal?.removeEventListener('abort', onAbort);
    };

    /** @param {any} err */
    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    /** @param {any} value */
    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    /** @param {Buffer} msg */
    const onMessage = (msg) => {
      if (settled) return;
      let result;
      try {
        result = parseResponse(msg);
      } catch (err) {
        settleReject(err);
        return;
      }
      if (result === undefined) return; // not a match for this exchange — keep waiting
      settleResolve(result);
    };

    /** @param {Error} err */
    const onSocketError = (err) => settleReject(err);
    const onAbort = () => settleReject(new TorrentResolveError('aborted'));

    const sendAttempt = () => {
      let packet;
      try {
        packet = buildPacket();
      } catch (err) {
        settleReject(err);
        return;
      }
      socket.send(packet, port, address, (err) => {
        if (err) settleReject(err);
      });
      const waitMs = scheduleMs[attempt];
      timer = setTimeout(() => {
        attempt += 1;
        if (attempt < scheduleMs.length) {
          sendAttempt();
        } else {
          settleReject(new TorrentResolveError(`UDP tracker request to ${address}:${port} timed out`));
        }
      }, waitMs);
      timer.unref?.();
    };

    socket.on('message', onMessage);
    socket.on('error', onSocketError);
    if (signal) {
      if (signal.aborted) return settleReject(new TorrentResolveError('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
    sendAttempt();
  });
}

/** @param {Buffer} transactionId */
function buildConnectPacket(transactionId) {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64BE(PROTOCOL_ID, 0);
  buf.writeUInt32BE(ACTION_CONNECT, 8);
  transactionId.copy(buf, 12);
  return buf;
}

/**
 * @param {Buffer} msg
 * @param {Buffer} transactionId
 * @returns {bigint|undefined}
 */
function parseConnectResponse(msg, transactionId) {
  if (msg.length < 8) return undefined;
  if (!transactionId.equals(msg.subarray(4, 8))) return undefined;

  const action = msg.readUInt32BE(0);
  if (action === ACTION_ERROR) {
    throw new TrackerErrorResponse(msg.length > 8 ? msg.subarray(8).toString('utf8') : 'tracker error');
  }
  if (action !== ACTION_CONNECT) {
    throw new Error(`unexpected action ${action} in connect response`);
  }
  if (msg.length < 16) {
    throw new Error(`connect response too short: ${msg.length} bytes, need at least 16`);
  }
  return msg.readBigUInt64BE(8);
}

/**
 * @param {Object} args
 * @param {bigint} args.connectionId
 * @param {Buffer} args.transactionId
 * @param {Buffer} args.infoHash
 * @param {Buffer} args.peerId
 * @param {number} args.key
 * @param {number} args.port
 */
function buildAnnouncePacket({ connectionId, transactionId, infoHash, peerId, key, port }) {
  if (infoHash.length !== 20) throw new Error(`infoHash must be 20 raw bytes, got ${infoHash.length}`);
  if (peerId.length !== 20) throw new Error(`peerId must be 20 raw bytes, got ${peerId.length}`);

  const buf = Buffer.alloc(98);
  let offset = 0;
  buf.writeBigUInt64BE(connectionId, offset);
  offset += 8;
  buf.writeUInt32BE(ACTION_ANNOUNCE, offset);
  offset += 4;
  transactionId.copy(buf, offset);
  offset += 4;
  infoHash.copy(buf, offset);
  offset += 20;
  peerId.copy(buf, offset);
  offset += 20;
  buf.writeBigUInt64BE(0n, offset); // downloaded — never tracked, this library only fetches metadata
  offset += 8;
  buf.writeBigUInt64BE(LEFT_UNKNOWN, offset);
  offset += 8;
  buf.writeBigUInt64BE(0n, offset); // uploaded
  offset += 8;
  buf.writeUInt32BE(EVENT_STARTED, offset); // the only announce this library ever makes per attempt
  offset += 4;
  buf.writeUInt32BE(0, offset); // ip — 0 lets the tracker use the request's source address
  offset += 4;
  buf.writeUInt32BE(key, offset);
  offset += 4;
  buf.writeInt32BE(50, offset); // num_want
  offset += 4;
  buf.writeUInt16BE(port, offset);
  offset += 2;
  return buf;
}

/**
 * @param {Buffer} msg
 * @param {Buffer} transactionId
 * @param {number} peerEntrySize
 * @returns {{peers: Array<{host: string, port: number}>, interval: number|null}|undefined}
 */
function parseAnnounceResponse(msg, transactionId, peerEntrySize) {
  if (msg.length < 8) return undefined;
  if (!transactionId.equals(msg.subarray(4, 8))) return undefined;

  const action = msg.readUInt32BE(0);
  if (action === ACTION_ERROR) {
    throw new TrackerErrorResponse(msg.length > 8 ? msg.subarray(8).toString('utf8') : 'tracker error');
  }
  if (action !== ACTION_ANNOUNCE) {
    throw new Error(`unexpected action ${action} in announce response`);
  }
  if (msg.length < 20) {
    throw new Error(`announce response too short: ${msg.length} bytes, need at least 20`);
  }

  const peerListBytes = msg.length - 20;
  if (peerListBytes % peerEntrySize !== 0) {
    throw new Error(`announce response peer list length ${peerListBytes} is not a multiple of ${peerEntrySize}`);
  }

  const interval = msg.readUInt32BE(8);
  const peerBuf = msg.subarray(20);
  const peers = peerEntrySize === 18 ? decodeCompactPeers6(peerBuf) : decodeCompactPeers4(peerBuf);
  return { peers, interval: interval || null };
}

/**
 * Removes all listeners, attaches a no-op error handler so a post-close error can't throw, and
 * closes the socket, swallowing an already-closed/never-bound close() error.
 * @param {import('node:dgram').Socket} socket
 */
function closeSocketSafely(socket) {
  socket.removeAllListeners('message');
  socket.removeAllListeners('error');
  socket.on('error', () => {}); // a post-close error must never throw
  try {
    socket.close();
  } catch {
    // already closed or never bound — nothing left to clean up
  }
}
