import parseTorrent from 'parse-torrent';
import { assertHttpsUrl } from './validate.js';
import { TorrentResolveError } from './errors.js';
import { USER_AGENT } from './client-identity.js';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024; // 4 MB — real-world .torrent files are near-always <1MB
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * @typedef {Object} TorrentFile
 * @property {string} path
 * @property {string} name
 * @property {number} length
 * @property {number} offset
 */

/**
 * @typedef {Object} TorrentFileInfo
 * @property {string} name
 * @property {string} infoHash - lowercase 40-char hex
 * @property {Date|null} created
 * @property {number} length - total size in bytes
 * @property {TorrentFile[]} files
 * @property {boolean} private - BEP 27 flag
 * @property {string[]} trackers - the .torrent's own announce list, as embedded (no
 *   enrichment/denylist applies on this path — that's a resolveMagnet/resolveInfoHash concept)
 */

/**
 * Downloads a .torrent file over HTTPS and parses it.
 * @param {string} httpsUrl
 * @param {Object} [opts]
 * @param {string} [opts.userAgent]
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.fetchTimeoutMs]
 * @returns {Promise<TorrentFileInfo>}
 */
export async function resolveTorrentFile(httpsUrl, opts = {}) {
  const url = assertHttpsUrl(httpsUrl);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const userAgent = opts.userAgent ?? USER_AGENT;

  const buffer = await downloadWithSizeCap(url, {
    userAgent,
    maxBytes,
    timeoutMs: opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  });

  let parsed;
  try {
    parsed = await parseTorrent(buffer);
  } catch (cause) {
    throw new TorrentResolveError(`Failed to parse .torrent file from ${url}`, { cause });
  }

  return {
    name: parsed.name,
    infoHash: parsed.infoHash,
    created: parsed.created ?? null,
    length: parsed.length,
    files: parsed.files,
    private: parsed.private ?? false,
    trackers: parsed.announce ?? [],
  };
}

/**
 * @param {URL} url
 * @param {{ userAgent: string, maxBytes: number, timeoutMs: number }} opts
 * @returns {Promise<Buffer>}
 */
async function downloadWithSizeCap(url, { userAgent, maxBytes, timeoutMs }) {
  let response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': userAgent },
      redirect: 'follow',
    });
  } catch (cause) {
    throw new TorrentResolveError(`Failed to fetch ${url}`, { cause });
  }

  if (!response.ok) {
    throw new TorrentResolveError(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new TorrentResolveError(`Failed to fetch ${url}: empty response body`);
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    // Abort before reading anything if the server is honest about an oversized body.
    await response.body.cancel().catch(() => {});
    throw new TorrentResolveError(
      `Refusing to download ${url}: declared content-length ${contentLength} exceeds ${maxBytes} byte cap`,
    );
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel(`exceeded ${maxBytes} byte cap`).catch(() => {});
        throw new TorrentResolveError(`Refusing to download ${url}: exceeded ${maxBytes} byte cap`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}
