/**
 * body.js — body-file preprocessing shared by single-story `--body-file`
 * and batch `--from` spec mode.
 *
 * `prepareBody` validates that a body has no frontmatter (bl manages
 * frontmatter) and strips HTML comments outside fenced code blocks.
 * Variable substitution is deferred to the caller, which knows
 * storyId/title/etc.
 */

/**
 * Strip top-level HTML comments from a markdown body.
 *
 * Fence-aware line-based state machine — comments inside ``` or ~~~ blocks
 * are preserved. Collapses runs of consecutive blank lines to one. Returns
 * the cleaned body with a single trailing newline.
 */
export function stripHtmlComments(input) {
  const lines = input.split('\n');
  const buffer = [];
  let state = 'OUTSIDE';
  let fence = null;

  const pushLine = (line) => {
    const trimmed = line.replace(/\s+$/, '');
    const lastIsBlank = buffer.length > 0 && buffer[buffer.length - 1] === '';
    if (trimmed === '' && lastIsBlank) return;
    buffer.push(trimmed);
  };

  for (let raw of lines) {
    if (state === 'IN_FENCE') {
      buffer.push(raw);
      const m = raw.match(/^\s*(```|~~~)/);
      if (m && m[1] === fence) {
        state = 'OUTSIDE';
        fence = null;
      }
      continue;
    }

    if (state === 'IN_COMMENT') {
      const idx = raw.indexOf('-->');
      if (idx === -1) continue;
      raw = raw.slice(idx + 3);
      state = 'OUTSIDE';
      // fall through to OUTSIDE processing of remainder
    }

    if (state === 'OUTSIDE') {
      const fenceMatch = raw.match(/^\s*(```|~~~)/);
      if (fenceMatch) {
        state = 'IN_FENCE';
        fence = fenceMatch[1];
        buffer.push(raw);
        continue;
      }
      // Strip inline single-line comments first (greedy across the line).
      let line = raw.replace(/<!--[\s\S]*?-->/g, '');
      const openIdx = line.indexOf('<!--');
      if (openIdx !== -1) {
        state = 'IN_COMMENT';
        line = line.slice(0, openIdx);
      }
      pushLine(line);
    }
  }

  return buffer.join('\n').replace(/^\n+|\n+$/g, '') + '\n';
}

/**
 * Detect a frontmatter block at the start of a body file. The first
 * non-empty line must be exactly `---`; we then look for a matching
 * closing `---`. Returns true if both are found.
 */
export function hasFrontmatter(text) {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length || lines[i] !== '---') return false;
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j] === '---') return true;
  }
  return false;
}

/**
 * Validate body text and strip comments. Used by both --body-file and
 * spec-mode body_file loading.
 *
 * Throws on frontmatter; returns the cleaned body. Variable substitution
 * is deferred until later when storyId/title/etc are known.
 */
export function prepareBody(text) {
  if (hasFrontmatter(text)) {
    const err = new Error(
      'body file contains frontmatter; remove it — bl manages frontmatter (component, story_id, title, etc.)',
    );
    err.code = 'BODY_HAS_FRONTMATTER';
    throw err;
  }
  return stripHtmlComments(text);
}
