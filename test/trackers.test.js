import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrackerList } from '../src/trackers.js';

test('merges magnet announce list with extra trackers', () => {
  const result = buildTrackerList({
    magnetAnnounce: ['https://tracker-a.example/announce'],
    extraTrackers: ['https://tracker-b.example/announce'],
  });
  assert.deepEqual(result, ['https://tracker-a.example/announce', 'https://tracker-b.example/announce']);
});

test('dedupes case-insensitively across both lists, keeping first-seen order', () => {
  const result = buildTrackerList({
    magnetAnnounce: ['https://tracker-a.example/announce'],
    extraTrackers: ['HTTPS://TRACKER-A.EXAMPLE/announce', 'https://tracker-b.example/announce'],
  });
  assert.deepEqual(result, ['https://tracker-a.example/announce', 'https://tracker-b.example/announce']);
});

test('denylist removes exact matches case-insensitively', () => {
  const result = buildTrackerList({
    magnetAnnounce: ['https://tracker-a.example/announce', 'https://tracker-b.example/announce'],
    denylist: ['HTTPS://tracker-a.example/announce'],
  });
  assert.deepEqual(result, ['https://tracker-b.example/announce']);
});

test('denylist does not do substring/hostname matching', () => {
  const result = buildTrackerList({
    magnetAnnounce: ['https://tracker-a.example/announce', 'https://tracker-a.example/scrape'],
    denylist: ['https://tracker-a.example/announce'],
  });
  assert.deepEqual(result, ['https://tracker-a.example/scrape']);
});

test('drops entries with unsupported/invalid URL schemes', () => {
  const result = buildTrackerList({
    magnetAnnounce: ['https://tracker-a.example/announce', 'ftp://not-a-tracker.example', 'not a url'],
  });
  assert.deepEqual(result, ['https://tracker-a.example/announce']);
});

test('accepts udp/http/https/ws/wss tracker schemes', () => {
  const trackers = [
    'udp://tracker.example:80',
    'http://tracker.example/announce',
    'https://tracker.example/announce',
    'ws://tracker.example',
    'wss://tracker.example',
  ];
  const result = buildTrackerList({ extraTrackers: trackers });
  assert.deepEqual(result, trackers);
});

test('returns an empty list when nothing is supplied', () => {
  assert.deepEqual(buildTrackerList(), []);
  assert.deepEqual(buildTrackerList({}), []);
});
