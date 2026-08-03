import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import Protocol from 'bittorrent-protocol';
import utMetadata from 'ut_metadata';
import { fetchMetadataFromPeer } from '../src/metadata-exchange.js';

const INFO_HASH = 'a'.repeat(40);
const PEER_ID = Buffer.alloc(20, 1);

/** Starts a loopback TCP "peer" that declares ut_metadata support (so bittorrent-protocol does
 * dispatch the extended handshake to the client's ut_metadata extension — it only calls
 * onExtendedHandshake for extensions the peer itself declared) but never calls setMetadata(), so
 * its extended handshake omits `metadata_size`. That's what makes the real ut_metadata module on
 * the client end emit 'warning' ("Peer does not have metadata") instead of 'metadata'. */
function startPeerWithoutMetadataSupport() {
  const server = net.createServer((socket) => {
    const wire = new Protocol();
    socket.pipe(wire).pipe(socket);
    wire.use(utMetadata());
    wire.handshake(INFO_HASH, PEER_ID, { dht: true });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

test("a peer that declares ut_metadata support but has no metadata triggers the internal 'warning' path, not an immediate rejection", async () => {
  const peer = await startPeerWithoutMetadataSupport();
  try {
    // The warning is swallowed internally (informational only, per metadata-exchange.js) — the
    // only way to observe it from outside is that the promise stays pending until the peer's own
    // connection timeout, rather than rejecting the instant the bad extended handshake arrives.
    await assert.rejects(
      fetchMetadataFromPeer({ host: '127.0.0.1', port: peer.port }, INFO_HASH, PEER_ID, { timeoutMs: 300 }),
      /timed out/,
    );
  } finally {
    await peer.close();
  }
});
