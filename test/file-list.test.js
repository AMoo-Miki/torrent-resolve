import assert from 'node:assert/strict';
import { sep } from 'node:path';
import { test } from 'node:test';
import { normalizeFiles } from '../src/file-list.js';

/** Builds a path the way parse-torrent does, with the host separator. */
const hostPath = (...parts) => parts.join(sep);

test('converts host separators to forward slashes', () => {
  const files = [
    { path: hostPath('Sintel', 'Sintel.mp4'), name: 'Sintel.mp4', length: 129241752, offset: 7884 },
    { path: hostPath('Sintel', 'subs', 'Sintel.en.srt'), name: 'Sintel.en.srt', length: 1514, offset: 0 },
  ];
  assert.deepEqual(
    normalizeFiles(files).map((f) => f.path),
    ['Sintel/Sintel.mp4', 'Sintel/subs/Sintel.en.srt'],
  );
});

test('output never contains a backslash, whatever the host separator is', () => {
  const files = [{ path: hostPath('a', 'b', 'c.txt'), name: 'c.txt', length: 1, offset: 0 }];
  for (const file of normalizeFiles(files)) {
    assert.ok(!file.path.includes('\\'), `path still contains a backslash: ${file.path}`);
  }
});

test('leaves the other fields untouched', () => {
  const files = [{ path: hostPath('dir', 'f.bin'), name: 'f.bin', length: 42, offset: 7 }];
  assert.deepEqual(normalizeFiles(files), [{ path: 'dir/f.bin', name: 'f.bin', length: 42, offset: 7 }]);
});

test('a single-file torrent has no separator to convert', () => {
  const files = [{ path: 'solo.iso', name: 'solo.iso', length: 10, offset: 0 }];
  assert.equal(normalizeFiles(files)[0].path, 'solo.iso');
});

test('tolerates a missing or non-array file list', () => {
  assert.deepEqual(normalizeFiles(undefined), []);
  assert.deepEqual(normalizeFiles(null), []);
  assert.deepEqual(normalizeFiles([]), []);
});
