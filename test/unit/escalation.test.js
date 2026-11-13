import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escalationText } from '../../src/escalation.js';
import { scriptedEscalation } from '../../src/scripted.js';

test("scriptedEscalation's text through escalationText is the text it wrote before (S-897)", () => {
  const { details } = scriptedEscalation(
    'S-1',
    { kind: 'failed', plugin: 'p', command: 'run x', exit: 3, tail: 'a\nb' },
    'bl run S-1',
  );
  assert.equal(
    details,
    '**The rule at stake:** a scripted story is finished by its command alone, so a failed command stops the run and no agent is sent to repair it.\n\n**How it works:**\n\n1. bl runs the command the story names in `plugins-implement`, in the story\'s worktree.\n2. With exit 0 it commits what changed; with anything else it stops here.\n\n**The problem:** `run x` exited 3. Nothing was committed, and the worktree stays as the command left it.\n\n**Why the agents can\'t fix it:** the story was written so that no agent spends tokens on it, and whether the command or its input is wrong is yours to judge.\n\n**The decision:**\n\n- A. Fix the cause (recommended): correct the command, the plugin or the repo, remove anything the failed run left in the worktree, set this section to "None.", then `bl run S-1`.\n- B. Make it an agent\'s story: remove `plugins-implement` from S-1, set this section to "None.", then `bl run S-1`. That spends tokens, and the agent starts with this output.\n\nFix the cause (A), or hand the story to an agent (B)?\n\n**Details:**\n\n- Plugin: p\n- Exit code: 3\n- Output tail:\n\n```text\na\nb\n```',
  );
});

test('escalationText renders the six headings of _escalation.md in order (S-897)', () => {
  const text = escalationText({
    rule: 'the rule.',
    how: ['first', 'second'],
    problem: 'the problem.',
    why: 'the reason.',
    decisions: [
      { options: [{ letter: 'A', text: 'one' }], question: 'A?' },
      { lead: 'For the rest:', options: [{ letter: 'B', text: 'two' }], question: 'B?' },
    ],
    details: ['- a detail'],
  });
  assert.equal(
    text,
    [
      '**The rule at stake:** the rule.',
      '**How it works:**\n\n1. first\n2. second',
      '**The problem:** the problem.',
      "**Why the agents can't fix it:** the reason.",
      '**The decision:**\n\n- A. one\n\nA?\n\nFor the rest:\n\n- B. two\n\nB?',
      '**Details:**\n\n- a detail',
    ].join('\n\n'),
  );
  assert.match(
    escalationText({ rule: 'r', how: [], problem: 'p', why: 'w', decisions: [], details: [] }),
    /\*\*Details:\*\*\n\nNone\.$/,
  );
});
