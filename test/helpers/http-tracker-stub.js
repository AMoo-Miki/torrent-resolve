import http from 'node:http';
import bencode from 'bencode';

/**
 * Starts an in-process HTTP tracker stub bound to 127.0.0.1:0 — no real network involved.
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} handler
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>}
 */
export function startHttpTrackerStub(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/announce`,
        port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {Object} obj
 * @param {number} [status]
 */
export function sendBencoded(res, obj, status = 200) {
  const body = Buffer.from(bencode.encode(obj));
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(body);
}
