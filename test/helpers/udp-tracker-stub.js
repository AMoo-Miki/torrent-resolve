import dgram from 'node:dgram';

const ACTION_CONNECT = 0;
const ACTION_ANNOUNCE = 1;

/**
 * Starts an in-process UDP tracker stub — no real network involved. Defaults to udp4/127.0.0.1;
 * pass `{ type: 'udp6', bindAddress: '::1' }` for an IPv6 stub.
 *
 * Enforces real endpoint binding the way an actual tracker does: a connection id is only valid
 * from the (address, port) that requested it (observed by parsing whatever `onConnect`'s
 * `respond()` call actually sent back — not something the test declares up front, so it can't be
 * gotten wrong the way a hand-maintained "trust any port" stub can). An announce that presents a
 * connection id issued to a different endpoint, or one this stub never issued at all, is silently
 * dropped — `onAnnounce` is never called for it — matching real tracker behavior on a stale/
 * cross-socket connection id.
 *
 * `onConnect(request, respond)` / `onAnnounce(request, respond)` fire per matching, well-formed,
 * endpoint-valid request; not calling `respond` for a given request simulates a tracker that
 * stays silent (for exercising retransmit).
 * @param {Object} [opts]
 * @param {(req: {transactionId: Buffer}, respond: (buf: Buffer) => void) => void} [opts.onConnect]
 * @param {(req: {transactionId: Buffer, connectionId: bigint, infoHash: Buffer, peerId: Buffer,
 *   downloaded: bigint, left: bigint, uploaded: bigint, event: number, key: number,
 *   numWant: number, port: number}, respond: (buf: Buffer) => void) => void} [opts.onAnnounce]
 * @param {'udp4'|'udp6'} [opts.type]
 * @param {string} [opts.bindAddress]
 * @param {number} [opts.port] - defaults to 0 (OS-assigned ephemeral port)
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>}
 */
export function startUdpTrackerStub({
  onConnect,
  onAnnounce,
  type = 'udp4',
  bindAddress = '127.0.0.1',
  port: bindPort = 0,
} = {}) {
  const socket = dgram.createSocket(type);
  // A handler can respond asynchronously (e.g. setTimeout, to simulate a slow tracker) — if the
  // test has already torn this stub down by the time that fires, sending on a closed socket
  // throws ERR_SOCKET_DGRAM_NOT_RUNNING as an uncaught exception outside the test. Tracking this
  // lets every respond() below become a safe no-op once the stub is closed, rather than making
  // every test that uses a delayed response respsonsible for not outliving stub.close().
  let closed = false;

  /** @type {Map<bigint, {address: string, port: number}>} */
  const issuedConnectionIds = new Map();

  socket.on('message', (msg, rinfo) => {
    // Request layout (both connect and announce): an 8-byte leading field (protocol_id or
    // connection_id), then action (u32 @ offset 8), then transaction_id (u32 @ offset 12) — NOT
    // the response layout (action @ 0, transaction_id @ 4).
    if (msg.length < 16) return;
    const action = msg.readUInt32BE(8);
    const transactionId = Buffer.from(msg.subarray(12, 16));

    if (action === ACTION_CONNECT && msg.length === 16) {
      const respond = (/** @type {Buffer} */ buf) => {
        if (closed) return;
        if (buf.length >= 16 && buf.readUInt32BE(0) === ACTION_CONNECT) {
          issuedConnectionIds.set(buf.readBigUInt64BE(8), { address: rinfo.address, port: rinfo.port });
        }
        socket.send(buf, rinfo.port, rinfo.address);
      };
      onConnect?.({ transactionId }, respond);
    } else if (action === ACTION_ANNOUNCE && msg.length >= 98) {
      const request = parseAnnounceRequest(msg);
      const issuedTo = issuedConnectionIds.get(request.connectionId);
      if (!issuedTo || issuedTo.address !== rinfo.address || issuedTo.port !== rinfo.port) return; // silently drop, like a real tracker would
      const respond = (/** @type {Buffer} */ buf) => {
        if (closed) return;
        socket.send(buf, rinfo.port, rinfo.address);
      };
      onAnnounce?.({ transactionId, ...request }, respond);
    }
  });

  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(bindPort, bindAddress, () => {
      const { port, address } = socket.address();
      const host = type === 'udp6' ? `[${address}]` : address;
      resolve({
        url: `udp://${host}:${port}/announce`,
        port,
        close: () =>
          new Promise((r) => {
            closed = true;
            socket.close(r);
          }),
      });
    });
  });
}

/** @param {Buffer} msg */
function parseAnnounceRequest(msg) {
  return {
    connectionId: msg.readBigUInt64BE(0),
    infoHash: Buffer.from(msg.subarray(16, 36)),
    peerId: Buffer.from(msg.subarray(36, 56)),
    downloaded: msg.readBigUInt64BE(56),
    left: msg.readBigUInt64BE(64),
    uploaded: msg.readBigUInt64BE(72),
    event: msg.readUInt32BE(80),
    key: msg.readUInt32BE(88),
    numWant: msg.readInt32BE(92),
    port: msg.readUInt16BE(96),
  };
}

/**
 * @param {Buffer} transactionId
 * @param {bigint} connectionId
 * @param {number} [length] - total response length, for building deliberately truncated responses
 */
export function buildConnectResponse(transactionId, connectionId, length = 16) {
  const buf = Buffer.alloc(length);
  buf.writeUInt32BE(ACTION_CONNECT, 0);
  transactionId.copy(buf, 4);
  if (length >= 16) buf.writeBigUInt64BE(connectionId, 8);
  return buf;
}

/**
 * @param {Buffer} transactionId
 * @param {Object} [opts]
 * @param {number} [opts.interval]
 * @param {number} [opts.leechers]
 * @param {number} [opts.seeders]
 * @param {Buffer} [opts.peers]
 * @param {number} [opts.length] - total response length, for building deliberately truncated/malformed responses
 */
export function buildAnnounceResponse(transactionId, opts = {}) {
  const { interval = 1800, leechers = 0, seeders = 1, peers = Buffer.alloc(0) } = opts;
  const length = opts.length ?? 20 + peers.length;
  const buf = Buffer.alloc(length);
  buf.writeUInt32BE(ACTION_ANNOUNCE, 0);
  transactionId.copy(buf, 4);
  if (length >= 12) buf.writeUInt32BE(interval, 8);
  if (length >= 16) buf.writeUInt32BE(leechers, 12);
  if (length >= 20) buf.writeUInt32BE(seeders, 16);
  peers.copy(buf, 20, 0, Math.max(0, length - 20));
  return buf;
}

/**
 * @param {Buffer} transactionId
 * @param {string} message
 */
export function buildErrorResponse(transactionId, message) {
  const msgBuf = Buffer.from(message, 'utf8');
  const buf = Buffer.alloc(8 + msgBuf.length);
  buf.writeUInt32BE(3, 0); // action: error
  transactionId.copy(buf, 4);
  msgBuf.copy(buf, 8);
  return buf;
}
