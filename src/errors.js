/** Base error for all failures raised by this library. Always has a `cause` when wrapping another error. */
export class TorrentResolveError extends Error {
  /**
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = 'TorrentResolveError';
  }
}

/**
 * Raised when a magnet/infohash resolution exhausts its timeout budget.
 * `infoHash` and `name` are best-effort values parsed directly from the original
 * magnet/hash input and are NOT verified against any peer — `name` in particular comes
 * from the magnet's `dn` param, which is caller-supplied and untrustworthy by design.
 */
export class TorrentTimeoutError extends TorrentResolveError {
  /**
   * @param {string} message
   * @param {Object} details
   * @param {string} [details.infoHash]
   * @param {string|null} [details.name] - unverified, from the magnet's `dn` param if present
   * @param {number} details.elapsedMs
   * @param {ErrorOptions} [options]
   */
  constructor(message, { infoHash, name = null, elapsedMs }, options) {
    super(message, options);
    this.name = 'TorrentTimeoutError';
    this.infoHash = infoHash;
    /** Unverified — see class doc. */
    this.untrustedName = name;
    this.elapsedMs = elapsedMs;
  }
}
