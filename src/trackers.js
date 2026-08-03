import { isValidTrackerUrl } from './validate.js';

/**
 * Merges a magnet's own announce list with caller-supplied extra trackers, then removes
 * anything matching the denylist. Pure function — no I/O, easy to unit test in isolation.
 *
 * Denylist matching is an exact, case-insensitive comparison of the trimmed URL string (not
 * a hostname or substring match) — deterministic and unambiguous, so it can't be bypassed by
 * a trivial case change, and can't accidentally over-match unrelated trackers on the same host.
 *
 * @param {Object} opts
 * @param {string[]} [opts.magnetAnnounce] - trackers parsed from the magnet's own `tr` params
 * @param {string[]} [opts.extraTrackers] - caller-supplied extra trackers
 * @param {string[]} [opts.denylist] - trackers to exclude
 * @returns {string[]} deduped, denylist-filtered, syntactically-valid tracker URLs, in first-seen order
 */
export function buildTrackerList({ magnetAnnounce = [], extraTrackers = [], denylist = [] } = {}) {
  const denylistSet = new Set(denylist.map(normalize));

  const seen = new Set();
  const result = [];
  for (const url of [...magnetAnnounce, ...extraTrackers]) {
    const key = normalize(url);
    if (seen.has(key)) continue;
    seen.add(key);

    if (denylistSet.has(key)) continue;
    if (!isValidTrackerUrl(url)) continue;

    result.push(url);
  }
  return result;
}

/** @param {string} url */
function normalize(url) {
  return typeof url === 'string' ? url.trim().toLowerCase() : '';
}
