/**
 * on-question.js — preloaded into a `bl` process with
 * `NODE_OPTIONS=--import=<this file>`, as `stdin-tty.js` is (stdin reads as a
 * terminal). When bl writes its y/n question to stderr, this writes
 * `BL_TEST_ON_QUESTION_TEXT` to the file `BL_TEST_ON_QUESTION_FILE` first: a
 * change that another session makes while the operator answers.
 */

import { writeFileSync } from 'node:fs';
import './stdin-tty.js';

const write = process.stderr.write.bind(process.stderr);
let asked = false;
process.stderr.write = (chunk, ...rest) => {
  if (!asked && String(chunk).includes('[y/n]')) {
    asked = true;
    writeFileSync(process.env.BL_TEST_ON_QUESTION_FILE, process.env.BL_TEST_ON_QUESTION_TEXT);
  }
  return write(chunk, ...rest);
};
