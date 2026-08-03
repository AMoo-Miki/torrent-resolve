import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import DHT from 'bittorrent-dht';

/**
 * Module-level warm DHT singleton. Lazily created on first use and kept alive across calls
 * within the same process — bittorrent-dht explicitly supports concurrent lookups on one
 * instance, so reusing it instead of creating a fresh DHT per call avoids re-bootstrapping
 * the routing table (from router.bittorrent.com etc) every time, which is the main cost in
 * DHT peer discovery. Not destroyed automatically; call shutdownSharedDht() to close it.
 * @type {any} - untyped: 'bittorrent-dht' ships no types
 */
let sharedDht = null;
/** @type {Promise<any>|null} */
let sharedDhtReadyPromise = null;
/** @type {string|null} the dhtCacheFile the singleton was created with, if any — remembered so
 *  shutdownSharedDht() can persist the routing table back to the same path it was seeded from. */
let sharedDhtCacheFile = null;

/**
 * Returns the shared warm DHT instance, creating and bootstrapping it on first call.
 *
 * No disk I/O happens unless `dhtCacheFile` is passed on the *first* call that creates the
 * singleton (subsequent calls reuse the already-running instance and ignore new cache options).
 *
 * @param {Object} [opts]
 * @param {string} [opts.dhtCacheFile] - optional path to persist/restore routing table nodes
 *   across process restarts, via bittorrent-dht's documented toJSON()/addNode() mechanism.
 *   Off by default — this is the one deliberate exception to "no filesystem writes." Read on
 *   this call, written back out by shutdownSharedDht() if this call is the one that created the
 *   singleton.
 * @param {Array<{host: string, port: number}>} [opts.dhtBootstrapNodes] - extra nodes to seed
 *   the routing table with (e.g. extracted from another client's warm cache). Generic — the
 *   library has no knowledge of where these came from.
 * @returns {Promise<any>}
 */
export function getSharedDht(opts = {}) {
  if (!sharedDhtReadyPromise) {
    sharedDhtReadyPromise = createDht(opts);
  }
  return sharedDhtReadyPromise;
}

/**
 * @param {{ dhtCacheFile?: string, dhtBootstrapNodes?: Array<{host: string, port: number}> }} [opts]
 */
async function createDht({ dhtCacheFile, dhtBootstrapNodes } = {}) {
  const dht = new DHT();

  try {
    // listen() must complete before any addNode() call. bittorrent-dht's underlying k-rpc
    // socket auto-binds on its first outbound send — which addNode triggers immediately (it
    // pings the node to verify it's alive before adding it to the routing table) — so calling
    // addNode first leaves the socket already bound by the time this listen() tries to bind it
    // explicitly, and that throws ERR_SOCKET_ALREADY_BOUND. This isn't a hypothetical: it fires
    // on every real dhtCacheFile/dhtBootstrapNodes entry, which is exactly why it went
    // unnoticed — the loops below are silent no-ops on an empty list.
    /** @type {Promise<void>} */
    const listening = new Promise((resolve, reject) => {
      dht.once('error', reject);
      dht.listen(0, () => {
        dht.removeListener('error', reject);
        resolve();
      });
    });
    await listening;

    if (dhtCacheFile) {
      const cachedNodes = await readCacheFile(dhtCacheFile);
      for (const node of cachedNodes) dht.addNode(node);
    }
    if (dhtBootstrapNodes) {
      for (const node of dhtBootstrapNodes) dht.addNode(node);
    }
  } catch (err) /* c8 ignore start */ {
    // Whatever this function opens, it closes — including on its own failure path. Without
    // this, a DHT instance that fails partway through setup is never assigned to sharedDht and
    // its socket leaks for the life of the process. The cleanup itself is best-effort: a
    // secondary failure here must never replace/mask the real error being propagated.
    //
    // Defense-in-depth, not currently reachable: the only thing in the try block above that can
    // throw is dht.listen(0, ...), and per k-rpc-socket's own source it only emits 'error' for
    // EACCES/EADDRINUSE on the underlying bind — both structurally impossible when binding to
    // port 0 (OS-assigned), which is what this call always does. Kept in case a future
    // bittorrent-dht version starts emitting 'error' for other reasons (e.g. a bad bootstrap
    // host), or a later change here passes an explicit port.
    await new Promise((resolve) => dht.destroy(resolve)).catch(() => {});
    throw err;
  } /* c8 ignore stop */

  sharedDht = dht;
  sharedDhtCacheFile = dhtCacheFile ?? null;
  return dht;
}

/**
 * @param {string} path
 * @returns {Promise<Array<{host: string, port: number}>>}
 */
async function readCacheFile(path) {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.nodes) ? parsed.nodes : [];
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return [];
    // A corrupt/unreadable cache file should never break resolution — just skip it.
    return [];
  }
}

/**
 * Writes `dht`'s current routing table to `dhtCacheFile` atomically: the content is written to
 * a sibling temp file first, then moved into place with a single rename. A rename within the
 * same directory is atomic at the filesystem level, so a reader never observes a half-written
 * file, and two writers racing on the same path can never interleave into a corrupt hybrid —
 * the final content is always exactly one complete write or the other, never a mix. The temp
 * filename includes the pid and a random suffix so concurrent writers don't collide on it
 * either, even before the rename.
 * @param {any} dht
 * @param {string} dhtCacheFile
 */
async function persistDhtCache(dht, dhtCacheFile) {
  const { nodes } = dht.toJSON();
  const tmpPath = `${dhtCacheFile}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await writeFile(tmpPath, JSON.stringify({ nodes }), 'utf8');
  try {
    await rename(tmpPath, dhtCacheFile);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Destroys the shared DHT singleton, closing its UDP socket. Optional — a caller that never
 * calls this simply keeps the warm cache (and the open socket) for the life of the process.
 *
 * If the singleton was created with `opts.dhtCacheFile`, this writes the current routing table
 * back to that same path first (best-effort — a failure to persist never prevents shutdown from
 * completing, same as a corrupt cache file never prevents startup). Calling this concurrently or
 * more than once is safe: the module-level state is captured and cleared synchronously before
 * any `await`, so only the first caller actually persists/destroys — the rest see the singleton
 * already gone and return immediately.
 * @returns {Promise<void>}
 */
export async function shutdownSharedDht() {
  if (!sharedDht) {
    sharedDhtReadyPromise = null;
    return;
  }
  const dht = sharedDht;
  const dhtCacheFile = sharedDhtCacheFile;
  sharedDht = null;
  sharedDhtCacheFile = null;
  sharedDhtReadyPromise = null;

  if (dhtCacheFile) {
    await persistDhtCache(dht, dhtCacheFile).catch(() => {});
  }
  await new Promise((resolve) => dht.destroy(resolve));
}
