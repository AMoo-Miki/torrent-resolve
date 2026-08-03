// Byte codes for the RFC 3986 "unreserved" set: A-Z a-z 0-9 - _ . ~
const UNRESERVED = new Uint8Array(256);
for (let i = 0x41; i <= 0x5a; i++) UNRESERVED[i] = 1; // A-Z
for (let i = 0x61; i <= 0x7a; i++) UNRESERVED[i] = 1; // a-z
for (let i = 0x30; i <= 0x39; i++) UNRESERVED[i] = 1; // 0-9
UNRESERVED[0x2d] = 1; // -
UNRESERVED[0x5f] = 1; // _
UNRESERVED[0x2e] = 1; // .
UNRESERVED[0x7e] = 1; // ~

const HEX_DIGITS = '0123456789ABCDEF';

/**
 * Percent-encodes raw bytes for a URL query string component, byte by byte, per RFC 3986's
 * unreserved set. Unlike `encodeURIComponent` (which operates on UTF-16 text and mangles any
 * byte above 0x7F) this treats the input as opaque binary, which is required for BitTorrent's
 * 20-byte `info_hash`/`peer_id` fields — those are raw bytes, not UTF-8 text, and routinely
 * contain bytes with the high bit set.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function percentEncodeBytes(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (UNRESERVED[byte]) {
      out += String.fromCharCode(byte);
    } else {
      out += `%${HEX_DIGITS[byte >> 4]}${HEX_DIGITS[byte & 0x0f]}`;
    }
  }
  return out;
}
