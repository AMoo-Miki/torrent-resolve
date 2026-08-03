import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// This is a regression test for a real bug: announceUdp's socket used to be unref()'d while the
// caller was still awaiting its response. unref() doesn't stop I/O from being processed, but it
// tells the event loop "don't wait around for this if it's the only thing left" — so in a
// process where nothing else holds a ref, Node can exit the process outright while the announce
// promise is still pending, silently abandoning it (no resolve, no reject, exit code 0).
//
// No in-process test can catch this: this test suite's own runner always has other handles alive
// (the test harness itself), so the bug is invisible from inside it regardless of whether the
// socket is unref'd. It only shows up in a process where the announceUdp call is genuinely the
// only thing going on — hence a real child process here.
// Must stay a file:// URL (not a filesystem path) — the child script's own `import` statement
// needs a valid ESM specifier, and a bare Windows path like "I:\..." isn't one.
const udpTrackerUrl = new URL('../src/tracker/udp-tracker.js', import.meta.url).href;

test('an announceUdp() call with nothing else keeping the event loop alive still settles before the process exits', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'torrent-resolve-eventloop-'));
  const resultFile = path.join(dir, 'result.txt');

  try {
    const script = `
      import { announceUdp } from ${JSON.stringify(udpTrackerUrl)}
      import fs from 'node:fs'
      let settled = false
      process.on('exit', () => {
        // fs.writeFileSync in a process 'exit' handler is the one I/O guaranteed to actually
        // complete before the process dies — console.log to a piped stdout can be async on
        // Windows and get lost, which would make this test flaky rather than correct.
        fs.writeFileSync(${JSON.stringify(resultFile)}, 'SETTLED=' + settled)
      })
      // Port 1 on loopback: nothing listens there, so this can only settle via the retransmit
      // schedule's own timeout — which is exactly what proves the process stayed alive to see it.
      announceUdp('udp://127.0.0.1:1/announce', {
        infoHash: Buffer.alloc(20),
        peerId: Buffer.alloc(20),
        port: 6881,
        retransmitScheduleMs: [200],
      }).catch(() => {}).finally(() => { settled = true })
    `;

    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const [exitCode] = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => resolve([code]));
    });

    let result = '';
    try {
      result = await readFile(resultFile, 'utf8');
    } catch {
      // file never got written at all — definitely the bug (or an even earlier crash)
    }

    assert.equal(
      result,
      'SETTLED=true',
      `child exited (code ${exitCode}) before the announce settled (stderr: ${stderr})`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
