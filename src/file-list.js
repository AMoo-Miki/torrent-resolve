import { sep } from 'node:path';

/**
 * @typedef {Object} TorrentFile
 * @property {string} path - always forward-slash separated, matching the torrent itself
 * @property {string} name
 * @property {number} length
 * @property {number} offset
 */

/**
 * Normalizes the file list `parse-torrent` produces.
 *
 * It builds each `path` with `path.join`, which uses the host's separator, so the same torrent
 * yields `Sintel/Sintel.mp4` on Linux and `Sintel\Sintel.mp4` on Windows. BEP 3 stores the path
 * as a list of components that are conventionally joined with `/`, and callers compare, split and
 * display these strings, so output that changes shape with the machine it ran on is wrong
 * regardless of which separator is locally idiomatic. Forward slashes are what the torrent means.
 *
 * @param {Array<{path: string, name: string, length: number, offset: number}>} files
 * @returns {TorrentFile[]}
 */
export function normalizeFiles(files) {
  if (!Array.isArray(files)) return [];
  if (sep === '/') return files;
  return files.map((file) => ({ ...file, path: file.path.split(sep).join('/') }));
}
