/**
 * Decodes a BEP 23 compact IPv4 peer list: 6 bytes per peer (4-byte address, 2-byte port, both
 * big-endian). Throws if the buffer isn't a whole number of 6-byte entries rather than reading
 * past a truncated trailing entry.
 * @param {Uint8Array} buf
 * @returns {Array<{host: string, port: number}>}
 */
export function decodeCompactPeers4(buf) {
  if (buf.length % 6 !== 0) {
    throw new Error(`compact IPv4 peer list length ${buf.length} is not a multiple of 6`);
  }
  const peers = [];
  for (let i = 0; i < buf.length; i += 6) {
    const host = `${buf[i]}.${buf[i + 1]}.${buf[i + 2]}.${buf[i + 3]}`;
    const port = (buf[i + 4] << 8) | buf[i + 5];
    peers.push({ host, port });
  }
  return peers;
}

/**
 * Decodes a BEP 7 compact IPv6 peer list: 18 bytes per peer (16-byte address, 2-byte port, both
 * big-endian). The host is rendered as 8 unbracketed colon-separated hex groups (a valid, if
 * uncompressed, textual IPv6 form) — bracket it (`[addr]:port`) at whichever call site renders a
 * combined host:port string, since a bare colon-joined host is ambiguous with a trailing port.
 * @param {Uint8Array} buf
 * @returns {Array<{host: string, port: number}>}
 */
export function decodeCompactPeers6(buf) {
  if (buf.length % 18 !== 0) {
    throw new Error(`compact IPv6 peer list length ${buf.length} is not a multiple of 18`);
  }
  const peers = [];
  for (let i = 0; i < buf.length; i += 18) {
    const groups = [];
    for (let g = 0; g < 16; g += 2) {
      groups.push(((buf[i + g] << 8) | buf[i + g + 1]).toString(16));
    }
    const port = (buf[i + 16] << 8) | buf[i + 17];
    peers.push({ host: groups.join(':'), port });
  }
  return peers;
}
