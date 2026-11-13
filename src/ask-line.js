/**
 * ask-line.js — ask one question on stderr and read one line of answer from
 * stdin. `bl rank --commit` asks its y/n on a conflict with it, and `bl
 * force` its typed confirmation (F-119 D2.5).
 */

import { createInterface } from 'readline';

/**
 * Write `question` to stderr and read one line from stdin: the line, or `''`
 * at the end of input.
 * @param {string} question
 * @returns {Promise<string>}
 */
export async function askLine(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  process.stderr.write(question);
  const answer = await new Promise((res) => {
    rl.once('line', res);
    rl.once('close', () => res(''));
  });
  rl.close();
  return answer;
}
