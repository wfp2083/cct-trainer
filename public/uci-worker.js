// UCI Web Worker that loads Stockfish (single-threaded, no SharedArrayBuffer needed).
// The stockfish.js from the `stockfish` npm package auto-detects worker context
// and wires up onmessage/postMessage automatically when importScripts is used.
importScripts("./stockfish.js");
