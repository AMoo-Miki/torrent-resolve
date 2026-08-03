// Regenerates test/integ/fixtures.generated.js from live, well-seeded sources.
//
// Debian's own CD/DVD image torrents are about as close to "guaranteed seeded" as public
// BitTorrent content gets — Debian mirrors and its own infrastructure seed the current release
// indefinitely. That's the whole reason to source integ-test fixtures from here rather than
// hand-picking one-off torrents that quietly stop being seeded months later.
//
// Run manually (not part of any automated pipeline) whenever the integ suite gets slow because
// its current fixtures have gone stale:
//   npm run refresh-integ-fixtures
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import parseTorrent from 'parse-torrent';

const execFileAsync = promisify(execFile);

const DEBIAN_ROOT = 'https://cdimage.debian.org/debian-cd/current/';
const MAX_DEPTH = 3;
const TORRENTS_NEEDED = 5; // 1 stays a plain .torrent URL fixture, 4 become magnet fixtures
const MAGNET_TRACKER_COUNT = 12;
const TRACKERS_LIST_URL = 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all_udp.txt';

/** @param {string} url */
async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

/**
 * Parses an Apache autoindex directory listing into subdirectory and file URLs. Each row has an
 * icon-column link and a name-column link pointing at the same target, so this dedupes.
 * @param {string} html
 * @param {string} baseUrl
 * @returns {{dirs: string[], files: string[]}}
 */
function parseDirectoryListing(html, baseUrl) {
  const hrefs = [...html.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
  const dirs = new Set();
  const files = new Set();
  for (const href of hrefs) {
    if (href.startsWith('?') || href.startsWith('/') || href === '../') continue; // sort links, parent dir
    const url = new URL(href, baseUrl).href;
    if (href.endsWith('/')) dirs.add(url);
    else files.add(url);
  }
  return { dirs: [...dirs], files: [...files] };
}

/**
 * Depth-first crawl for .torrent files, stopping as soon as `limit` are found.
 * @param {string} rootUrl
 * @param {number} maxDepth
 * @param {number} limit
 * @returns {Promise<string[]>}
 */
async function findTorrentFiles(rootUrl, maxDepth, limit) {
  /** @type {string[]} */
  const found = [];

  /**
   * @param {string} url
   * @param {number} depth
   */
  async function crawl(url, depth) {
    if (found.length >= limit || depth > maxDepth) return;
    const html = await fetchText(url);
    const { dirs, files } = parseDirectoryListing(html, url);

    for (const file of files) {
      if (found.length >= limit) return;
      if (file.endsWith('.torrent')) found.push(file);
    }
    for (const dir of dirs) {
      if (found.length >= limit) return;
      await crawl(dir, depth + 1);
    }
  }

  await crawl(rootUrl, 1);
  return found.slice(0, limit);
}

/** @param {number} count */
async function fetchUdpTrackers(count) {
  const text = await fetchText(TRACKERS_LIST_URL);
  const trackers = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('udp://'));
  if (trackers.length === 0) throw new Error(`no udp:// trackers found in ${TRACKERS_LIST_URL}`);
  return trackers.slice(0, count);
}

/**
 * @param {string} torrentUrl
 * @param {string[]} trackers
 */
async function torrentUrlToMagnetFixture(torrentUrl, trackers) {
  const res = await fetch(torrentUrl);
  if (!res.ok) throw new Error(`GET ${torrentUrl} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const parsed = await parseTorrent(buf);

  const params = [
    `xt=urn:btih:${parsed.infoHash}`,
    `dn=${encodeURIComponent(parsed.name)}`,
    ...trackers.map((t) => `tr=${encodeURIComponent(t)}`),
  ];
  return {
    uri: `magnet:?${params.join('&')}`,
    infoHash: parsed.infoHash,
    name: parsed.name,
    sourceTorrentUrl: torrentUrl,
  };
}

async function main() {
  console.log(`Crawling ${DEBIAN_ROOT} for ${TORRENTS_NEEDED} .torrent files (max depth ${MAX_DEPTH})...`);
  const torrentUrls = await findTorrentFiles(DEBIAN_ROOT, MAX_DEPTH, TORRENTS_NEEDED);
  if (torrentUrls.length < TORRENTS_NEEDED) {
    throw new Error(`only found ${torrentUrls.length}/${TORRENTS_NEEDED} .torrent files under ${DEBIAN_ROOT}`);
  }
  console.log(`Found ${torrentUrls.length} torrent files:`);
  for (const url of torrentUrls) console.log(`  ${url}`);

  console.log(`\nFetching UDP tracker list from ${TRACKERS_LIST_URL}...`);
  const trackers = await fetchUdpTrackers(MAGNET_TRACKER_COUNT);
  console.log(`Using ${trackers.length} trackers`);

  const [torrentUrlFixture, ...magnetSourceUrls] = torrentUrls;
  console.log(`\nExtracting infoHash for ${magnetSourceUrls.length} magnet fixtures...`);
  const magnets = [];
  for (const url of magnetSourceUrls) {
    const fixture = await torrentUrlToMagnetFixture(url, trackers);
    console.log(`  ${fixture.name} -> ${fixture.infoHash}`);
    magnets.push(fixture);
  }

  const generatedAt = new Date().toISOString();
  const contents =
    `// Generated by scripts/refresh-integ-fixtures.js — do not hand-edit.
// Re-run `.trim() +
    ' `npm run refresh-integ-fixtures` ' +
    `when the integ suite gets slow (its current fixtures' seeders have gone stale).
// Generated: ${generatedAt}
// Source: ${DEBIAN_ROOT}

export const generatedAt = ${JSON.stringify(generatedAt)}

/** A real, currently-hosted .torrent URL — for resolveTorrentFile integ tests. */
export const torrentUrl = ${JSON.stringify(torrentUrlFixture)}

/**
 * Real magnet URIs built from live Debian CD/DVD torrents' own infoHash, with trackers from
 * ${JSON.stringify(TRACKERS_LIST_URL)}. Debian images are about as close to permanently
 * well-seeded as public BitTorrent content gets, which is the whole point of sourcing fixtures
 * from here instead of hand-picked one-off torrents that quietly stop being seeded.
 * @type {Array<{uri: string, infoHash: string, name: string, sourceTorrentUrl: string}>}
 */
export const magnets = ${JSON.stringify(magnets, null, 2)}
`;

  const outPath = fileURLToPath(new URL('../test/integ/fixtures.generated.js', import.meta.url));
  await writeFile(outPath, contents, 'utf8');
  console.log(`\nWrote ${outPath}`);

  // The template above is written by hand (not via biome), and the JSON.stringify'd magnets
  // array comes out double-quoted with no semicolons — neither matches this repo's actual
  // style. Running biome on the output here means the generated file is always compliant with
  // whatever biome.json currently says, rather than baking in a copy of today's style rules
  // that silently drifts the next time someone changes them (as just happened with semicolons).
  //
  // Invoked as `node <biome's own bin script>`, never through a shell or `npx`/`.cmd`/`.ps1`
  // wrapper: this repo's own path has a space in it ("Open Source"), and shell:true child
  // processes on Windows re-split unquoted arguments on whitespace, silently truncating the
  // path. execFile with an argv array and no shell passes each argument to the OS directly, so
  // this is correct regardless of what characters are in the path.
  const biomeBin = fileURLToPath(import.meta.resolve('@biomejs/biome/bin/biome'));
  await execFileAsync(process.execPath, [biomeBin, 'check', '--write', outPath]);
  console.log('Formatted with biome.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
