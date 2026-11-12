/**
 * stdin-tty.js — preloaded into a `bl` process with
 * `NODE_OPTIONS=--import=<this file>`: stdin reads as a terminal (`isTTY`
 * true), so `bl rank --commit` asks its y/n on a conflict and reads the
 * answer from the file `runBl` gives as stdin (`input`).
 */

Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
