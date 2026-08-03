// Ambient module shims for dependencies that ship no type declarations of their own and have
// no @types package. Declared as untyped (implicit `any` exports) deliberately — these are
// internal implementation details, not part of this library's public API, so it's not worth
// maintaining hand-written shapes for someone else's package here.
declare module 'bittorrent-protocol';
declare module 'ut_metadata';
declare module 'bencode';
declare module 'bittorrent-dht';
declare module 'parse-torrent';
