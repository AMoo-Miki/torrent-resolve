# torrent-resolve

Resolves torrent metadata from a magnet URI, a raw v1 infohash, or an HTTPS `.torrent` URL. You
get back the name, infohash, total size, file list, private flag, and the trackers it used.
Creation date comes back too, but only for `.torrent` files. See below for why.

It never writes to disk, downloads no pieces, and runs no swarm. Peer discovery is
`bittorrent-dht` plus a small tracker client in `src/tracker/`. Metadata itself arrives over
BEP 9, via `bittorrent-protocol` and `ut_metadata`.

## Install

```
npm install torrent-resolve
```

Node 22 or newer. It uses global `fetch`, `AbortSignal.timeout` and `AbortController`.

## Usage

```js
import { resolve, resolveTorrentFile, resolveMagnet, resolveInfoHash, shutdownSharedDht } from 'torrent-resolve'

// An HTTPS .torrent URL. The only input that can give you `created`.
const a = await resolveTorrentFile('https://example.com/some.torrent')
// { name, infoHash, created: Date | null, length, files, private, trackers }

// A magnet URI. No `created` key at all.
const b = await resolveMagnet('magnet:?xt=urn:btih:...', { timeoutSeconds: 120 })
// { name, infoHash, length, files, private, trackers }

// A bare infohash. Trackers are required, since a hash carries none of its own.
const c = await resolveInfoHash('08ada5a7a6183aae1e09d831df6748d566095a10', {
  trackers: ['udp://tracker.opentrackr.org:1337/announce'],
  timeoutSeconds: 120,
})

// Takes any of the three and routes it.
const d = await resolve(input, opts)

// Optional. Closes the shared DHT socket so a one-shot script can exit.
await shutdownSharedDht()
```

### What you get back

Real output, from Sintel — the Blender Foundation's open movie.

```js
await resolveTorrentFile('https://webtorrent.io/torrents/sintel.torrent')
```
```js
{
  name: 'Sintel',
  infoHash: '08ada5a7a6183aae1e09d831df6748d566095a10',
  created: 2017-03-30T23:30:37.000Z,          // Date, or null if the file omits it
  length: 129302391,
  files: [
    { path: 'Sintel/Sintel.de.srt', name: 'Sintel.de.srt', length: 1652, offset: 0 },
    { path: 'Sintel/Sintel.mp4', name: 'Sintel.mp4', length: 129241752, offset: 7884 },
    // ...9 more
  ],
  private: false,
  trackers: [
    'udp://tracker.leechers-paradise.org:6969',
    'udp://tracker.coppersurfer.tk:6969',
    // ...6 more, as embedded in the file
  ]
}
```

The same torrent as a magnet:

```js
await resolveMagnet('magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=...')
```
```js
{
  name: 'Sintel',                              // from the verified info dict, not the dn param
  infoHash: '08ada5a7a6183aae1e09d831df6748d566095a10',
  length: 129302391,
  files: [ /* identical to above */ ],
  private: false,
  trackers: [                                  // the merged, denylist-filtered list actually used
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://open.stealth.si:80/announce'
  ]
}
```

Note there is no `created` key at all, not a `null` one. Everything else matches the `.torrent`
byte for byte, which is the point: the magnet's `dn` said `Sintel` and so does the result, but the
result is the one that was checked.

`files[].path` is always forward-slash separated, on every platform, matching the torrent itself
rather than the host you happen to run on.

### Options for `resolveMagnet`, `resolveInfoHash` and `resolve`

| option | default | |
|---|---|---|
| `trackers` | `[]`, but required and non-empty for `resolveInfoHash` | extra announce URLs, merged with the magnet's own |
| `denylist` | `[]` | announce URLs to drop from the merged list. Exact match, case-insensitive |
| `timeoutSeconds` | `600` | total budget for the whole attempt |
| `dhtCacheFile` | off | path to persist the DHT routing table across restarts |
| `dhtBootstrapNodes` | `[]` | extra `{host, port}` nodes to seed the routing table |
| `userAgent` | `qBittorrent/5.2.3` | sent to trackers and HTTPS servers |

## Why magnets have no `created`

BEP 9 only transfers the torrent's `info` dictionary. `creation date` sits outside it, in the
`.torrent` envelope, so peers never send it. Magnet URIs have no standard field for it either.

There is no honest source for it on that path, so `resolveMagnet` and `resolveInfoHash` results
have no `created` key at all. Returning `null` would imply we looked and the torrent didn't have
one. Only `resolveTorrentFile` can populate it, because a real `.torrent` file has the envelope.

## The other fields

These all live inside the `info` dictionary, so both paths return them.

`length` is the total size in bytes.

`files` is `{ path, name, length, offset }[]`, one entry per file. A single-file torrent still
gets a one-element array.

`private` is the BEP 27 flag. It's informational. You only learn it after the metadata has
arrived, which means DHT and trackers have already done their work by then, so nothing in this
library changes behavior based on it.

`trackers` is the list actually used for discovery: the magnet's own announce URLs plus
`opts.trackers`, minus `opts.denylist` and anything with an unsupported scheme. It records what
was attempted, not what responded. There is no liveness filtering. On `resolveTorrentFile` it's
just the announce list embedded in the file.

## Trust model

A magnet's `dn` parameter is whatever the person who wrote the link typed, so it never becomes
the returned `name`. The `name` always comes from the `info` dictionary fetched from a peer,
which `ut_metadata` verifies by SHA-1 against the infohash before handing it over.

`dn` is used in exactly one place: `TorrentTimeoutError.untrustedName`, a best-effort fallback
attached when resolution times out having found nothing. The property name says what it is.

Only v1 (40-hex) infohashes work. v2 and hybrid magnets (`urn:btmh:`) are rejected with an error
rather than half-handled.

## What it does on the network

**A UDP socket stays open for the life of the process.** The first `resolveMagnet` or
`resolveInfoHash` call creates a shared DHT instance and keeps it. Later calls reuse its warm
routing table instead of bootstrapping again. Call `shutdownSharedDht()` to close it.

**Outbound TCP connections go to whatever peers DHT and trackers return**, to run the BEP 9
exchange. Every socket and wire is destroyed as soon as one peer wins, the budget runs out, or an
error occurs.

**Each UDP tracker announce opens its own socket and closes it before returning.** No session
state, no connection-id caching. One attempt gives up after about 5 seconds instead of BEP 15's
much slower schedule, because the retry budget lives a level above.

**Each tracker is re-announced on its own clock**, timed from the `interval` that tracker
returned, clamped to between 60 seconds and 30 minutes, defaulting to 30 minutes if it didn't
send one. A tracker asking for 1800 seconds gets announced about once per session rather than
dozens of times. A slow or dead tracker delays only its own next announce.

**`resolveTorrentFile` is HTTPS only** and rejects `http:`, `file:` and everything else. It
streams the body with a 4 MB cap (`opts.maxBytes` to change it) and aborts rather than buffering
whatever a server decides to send. Real `.torrent` files are almost always under 1 MB.

## The shared DHT

One `DHT` instance serves every call in the process. `bittorrent-dht` supports concurrent lookups
on a single instance, so this is what makes repeated and parallel resolutions fast: there's no
bootstrap cost after the first one.

Nothing is written to disk unless you pass `opts.dhtCacheFile`. With it set, the routing table is
restored on startup (via `addNode()`) and saved back automatically when the shared DHT shuts down
(via `toJSON()`), written atomically (temp file + rename) so a crash mid-write can't corrupt an
existing cache.

To warm-start from another client's cache, such as aria2's `~/.aria2/dht.dat`, extract the
`{host, port}` pairs yourself and pass them as `opts.dhtBootstrapNodes`. This library won't parse
that file. It's an undocumented binary format belonging to another tool, and reading it would
break silently whenever aria2 changed it.

## Client identity

HTTPS downloads and tracker announces send `qBittorrent/5.2.3`, and the peer wire handshake uses
the matching `-qB5230-` prefix. Both live in `src/client-identity.js`. Some trackers and peers are
picky about clients they don't recognize.

This is a compatibility choice rather than anything the protocol requires, and it goes stale as
qBittorrent ships new versions. Override it with `opts.userAgent`.

## TypeScript

The source is JavaScript with JSDoc annotations. `.d.ts` files are generated from those
annotations by `tsc --checkJs --strict`, so TypeScript is a devDependency only and JS consumers
get no build step. `npm run build` regenerates `dist/`, and `prepare` runs it on install and
publish.

Type-checking the JSDoc under `strict` also keeps the annotations honest. It caught a real bug
during development, where `opts.userAgent` was documented but never actually threaded through to
the magnet path.

## Testing

```
npm test                     # unit + integ + combined coverage report (text/lcov/html)
npm run test:unit            # mocked, no network
npm run test:integ           # always live: real DHT, real trackers, real network
npm run refresh-integ-fixtures   # regenerate test/integ/fixtures.generated.js from fresh sources
```

Unit tests (`test/*.test.js`) mock every network boundary (DHT, trackers, peer wire protocol,
HTTPS) and never touch the real internet. Integ tests (`test/integ/*.test.js`) do the opposite —
nothing is mocked, and they always run against the real network; there's no toggle to make them
mocked, since a mocked "integ" test wouldn't be testing anything integ tests exist to catch
(protocol drift against real peers/trackers/DHT).

Integ fixtures are hardcoded magnet URIs and a `.torrent` URL in
`test/integ/fixtures.generated.js`, generated by `scripts/refresh-integ-fixtures.js` from Debian's
own CD/DVD image torrents — about as close to permanently well-seeded as public BitTorrent
content gets. Re-run that script when the integ suite starts running slowly because its current
fixtures' seeders have gone stale; see the script's header comment for what it does.

`npm test` collects V8 coverage from both suites into a shared temp directory
(`c8 --temp-directory ... --no-clean` on the second run) and produces one merged report from
`c8 report` — no custom merge step needed, since c8 reads every raw coverage file present in that
directory regardless of which process wrote it.
