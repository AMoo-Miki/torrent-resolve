import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentEncodeBytes } from '../src/tracker/url-encode.js';

/** Percent-decodes a string produced by percentEncodeBytes back into raw bytes, independent of
 * decodeURIComponent (which throws on byte sequences that aren't valid UTF-8). */
function percentDecodeToBytes(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '%') {
      bytes.push(Number.parseInt(str.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(str.charCodeAt(i));
    }
  }
  return Buffer.from(bytes);
}

test('leaves the unreserved set (A-Z a-z 0-9 - _ . ~) unescaped', () => {
  const bytes = Buffer.from('AZaz09-_.~', 'ascii');
  assert.equal(percentEncodeBytes(bytes), 'AZaz09-_.~');
});

test('percent-encodes reserved ASCII bytes with uppercase hex', () => {
  const bytes = Buffer.from([0x20, 0x2f, 0x3a, 0x40, 0x00]);
  assert.equal(percentEncodeBytes(bytes), '%20%2F%3A%40%00');
});

test('percent-encodes bytes above 0x7F, which encodeURIComponent would mangle', () => {
  const bytes = Buffer.from([0xff, 0x80, 0xab, 0x9e]);
  assert.equal(percentEncodeBytes(bytes), '%FF%80%AB%9E');
});

test('round-trips a realistic 20-byte info_hash containing high bytes', () => {
  const infoHash = Buffer.from('08ada5a7a6183aae1e09d831df6748d5660fca5', 'hex');
  // Force some bytes above 0x7F so the high-byte path is actually exercised.
  infoHash[0] = 0xff;
  infoHash[5] = 0x80;
  infoHash[19] = 0xc3;

  const encoded = percentEncodeBytes(infoHash);
  assert.deepEqual(percentDecodeToBytes(encoded), infoHash);
});

test('produces a pure ASCII, safe-for-query-string result', () => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const encoded = percentEncodeBytes(bytes);
  assert.ok(/^[\x21-\x7e]*$/.test(encoded));
});
