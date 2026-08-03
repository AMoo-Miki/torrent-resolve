import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolveByInfoHash, resolveInfoHash } from '../src/resolve-magnet.js';
import { TorrentTimeoutError, TorrentResolveError } from '../src/errors.js';
import { buildMetadataOnlyFixture } from './helpers/fixtures.js';

const VALID_HASH = 'a'.repeat(40);

/** A fake PeerDiscovery: emits 'peer' events on demand via ._trigger(), destroy() is observable. */
class FakePeerDiscovery extends EventEmitter {
  constructor(args) {
    super();
    this.args = args;
    this.destroyed = false;
    this.started = false;
  }
  start() {
    this.started = true;
  }
  destroy() {
    this.destroyed = true;
  }
}

function makeFakeDht() {
  return { address: () => ({ port: 12345 }) };
}

test('opts.userAgent is passed through to PeerDiscovery, not silently ignored', async () => {
  let capturedArgs;
  const deps = {
    getSharedDht: async () => makeFakeDht(),
    PeerDiscovery: class extends FakePeerDiscovery {
      constructor(args) {
        super(args);
        capturedArgs = args;
      }
    },
    fetchMetadataFromPeer: () => new Promise(() => {}),
  };

  await assert.rejects(() =>
    resolveByInfoHash(
      {
        infoHash: VALID_HASH,
        magnetAnnounce: [],
        untrustedName: null,
        opts: { timeoutSeconds: 0.05, userAgent: 'CustomClient/1.0' },
      },
      deps,
    ),
  );

  assert.equal(capturedArgs.userAgent, 'CustomClient/1.0');
});

test('resolves as soon as any peer succeeds, and tears down discovery + aborts other peers', async () => {
  const { buffer } = buildMetadataOnlyFixture({ name: 'winner.iso', length: 4096 });
  let discoveryInstance;
  const abortedSignals = [];

  const deps = {
    getSharedDht: async () => makeFakeDht(),
    PeerDiscovery: class extends FakePeerDiscovery {
      constructor(args) {
        super(args);
        discoveryInstance = this;
      }
    },
    fetchMetadataFromPeer: async (peer, _infoHash, _peerId, { signal }) => {
      abortedSignals.push(signal);
      if (peer.host === 'winner') return buffer;
      // loser peer: never resolves/rejects on its own — must be cancelled via abort
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
  };

  const resultPromise = resolveByInfoHash(
    {
      infoHash: VALID_HASH,
      magnetAnnounce: ['https://from-magnet.example/announce'],
      untrustedName: null,
      opts: {
        timeoutSeconds: 5,
        trackers: ['https://from-opts.example/announce', 'https://denylisted.example/announce'],
        denylist: ['https://denylisted.example/announce'],
      },
    },
    deps,
  );

  // Give resolveByInfoHash a tick to call discovery.start() and attach the 'peer' listener.
  await new Promise((r) => setImmediate(r));
  discoveryInstance.emit('peer', { host: 'loser', port: 1 });
  discoveryInstance.emit('peer', { host: 'winner', port: 2 });

  const result = await resultPromise;
  assert.equal(result.name, 'winner.iso');
  assert.equal(result.length, 4096);
  assert.equal(result.files.length, 1);
  assert.equal(result.private, false);
  // trackers reflects the enriched + denylist-filtered list, not just the magnet's own
  assert.deepEqual(result.trackers, ['https://from-magnet.example/announce', 'https://from-opts.example/announce']);
  assert.equal(discoveryInstance.destroyed, true);
  assert.equal(abortedSignals[0].aborted, true); // the loser's signal was aborted after winner settled
});

test('surfaces the BEP 27 private flag on the magnet/hash path too', async () => {
  const { buffer } = buildMetadataOnlyFixture({ name: 'secret.iso', private: true });
  let discoveryInstance;
  const deps = {
    getSharedDht: async () => makeFakeDht(),
    PeerDiscovery: class extends FakePeerDiscovery {
      constructor(args) {
        super(args);
        discoveryInstance = this;
      }
    },
    fetchMetadataFromPeer: async () => buffer,
  };

  const resultPromise = resolveByInfoHash(
    { infoHash: VALID_HASH, magnetAnnounce: [], untrustedName: null, opts: { timeoutSeconds: 5 } },
    deps,
  );
  await new Promise((r) => setImmediate(r));
  discoveryInstance.emit('peer', { host: 'peer', port: 1 });

  const result = await resultPromise;
  assert.equal(result.private, true);
});

test('throws TorrentTimeoutError with best-effort infoHash/name when the budget is exhausted', async () => {
  const deps = {
    getSharedDht: async () => makeFakeDht(),
    PeerDiscovery: FakePeerDiscovery,
    fetchMetadataFromPeer: () => new Promise(() => {}), // never resolves
  };

  await assert.rejects(
    () =>
      resolveByInfoHash(
        {
          infoHash: VALID_HASH,
          magnetAnnounce: [],
          untrustedName: 'untrusted-dn-value',
          opts: { timeoutSeconds: 0.05 },
        },
        deps,
      ),
    (err) => {
      assert.ok(err instanceof TorrentTimeoutError);
      assert.equal(err.infoHash, VALID_HASH);
      assert.equal(err.untrustedName, 'untrusted-dn-value');
      assert.ok(err.elapsedMs >= 0);
      return true;
    },
  );
});

test('a failing peer attempt does not abort the overall attempt — another peer can still win', async () => {
  const { buffer } = buildMetadataOnlyFixture({ name: 'second-peer-wins.iso' });
  let discoveryInstance;

  const deps = {
    getSharedDht: async () => makeFakeDht(),
    PeerDiscovery: class extends FakePeerDiscovery {
      constructor(args) {
        super(args);
        discoveryInstance = this;
      }
    },
    fetchMetadataFromPeer: async (peer) => {
      if (peer.host === 'bad') throw new Error('connection refused');
      return buffer;
    },
  };

  const resultPromise = resolveByInfoHash(
    { infoHash: VALID_HASH, magnetAnnounce: [], untrustedName: null, opts: { timeoutSeconds: 5 } },
    deps,
  );
  await new Promise((r) => setImmediate(r));
  discoveryInstance.emit('peer', { host: 'bad', port: 1 });
  await new Promise((r) => setImmediate(r));
  discoveryInstance.emit('peer', { host: 'good', port: 2 });

  const result = await resultPromise;
  assert.equal(result.name, 'second-peer-wins.iso');
});

test('resolveInfoHash requires a non-empty trackers array', async () => {
  await assert.rejects(() => resolveInfoHash(VALID_HASH, {}), TorrentResolveError);
  await assert.rejects(() => resolveInfoHash(VALID_HASH, { trackers: [] }), TorrentResolveError);
});

test('rejects invalid explicit timeoutSeconds synchronously, before touching any dependency', async () => {
  const deps = {
    getSharedDht: async () => {
      throw new Error('should never be called — validation must happen first');
    },
    PeerDiscovery: FakePeerDiscovery,
    fetchMetadataFromPeer: async () => {
      throw new Error('should never be called');
    },
  };
  await assert.rejects(
    () =>
      resolveByInfoHash(
        { infoHash: VALID_HASH, magnetAnnounce: [], untrustedName: null, opts: { timeoutSeconds: -1 } },
        deps,
      ),
    TorrentResolveError,
  );
});

test('omitting timeoutSeconds does not throw synchronously — a default is applied and resolution proceeds', async () => {
  const { buffer } = buildMetadataOnlyFixture({ name: 'default-timeout.iso' });
  let discoveryInstance;
  const deps = {
    getSharedDht: async () => makeFakeDht(),
    PeerDiscovery: class extends FakePeerDiscovery {
      constructor(args) {
        super(args);
        discoveryInstance = this;
      }
    },
    fetchMetadataFromPeer: async () => buffer,
  };

  const resultPromise = resolveByInfoHash(
    { infoHash: VALID_HASH, magnetAnnounce: [], untrustedName: null, opts: {} },
    deps,
  );
  await new Promise((r) => setImmediate(r));
  discoveryInstance.emit('peer', { host: 'peer', port: 1 });

  const result = await resultPromise;
  assert.equal(result.name, 'default-timeout.iso');
});
