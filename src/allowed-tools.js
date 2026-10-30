/**
 * allowed-tools.js — generate `<backlogRoot>/allowed-tools.json` lazily.
 *
 * Every `bl` invocation that needs the agent allowlist (workon, refine,
 * review, cleanup, agent-run) calls `ensureAllowedTools(backlogRoot, config)`
 * before launching. The file lives at the backlog root and is shared by every
 * repo, so its input must not depend on which repo a unit is in:
 * `allowlistInput(config)` builds a repo-independent union of the
 * top-level `{plugins, forge}` slice of `backlog.json` plus the
 * `overrides.plugins` of every `repos` entry (keyed `<repo>/<name>`), and both the hash
 * and the generated content come from that union. The on-disk file carries a
 * `_generated` header with:
 *   - `config_hash`        sha256 of the canonicalised union (sorted keys,
 *                          no whitespace) — covers any change that affects
 *                          which command tokens belong on the allowlist.
 *   - `generator_version`  bumped in this file when the generator's
 *                          *output schema or content rules* change. A bump
 *                          forces regeneration even when the config is
 *                          unchanged so users pick up new defaults.
 * There is no timestamp: two regenerations from the same input produce the
 * same bytes, and git history records when the file changed.
 *
 * Regeneration triggers (`regenReason`): file missing, JSON parse failure,
 * hash mismatch, version bump. A regen whose bytes equal the current file is
 * skipped; one that writes prints its trigger to stderr. Writes go through
 * `atomicWriteFile` (`atomic-write.js`): the bytes are staged at a
 * per-process `<backlogRoot>/.bl/tmp/allowed-tools.json.<pid>.<random>.tmp`
 * and renamed over the file, so a crash between write and rename leaves the
 * prior file intact and its staging file only in the ignored `.bl/`, not in
 * `git status`. The per-process name matters here: concurrent `bl`
 * processes regenerate the same file outside the backlog lock, and a fixed
 * staging path let one process's rename consume the other's, which then
 * failed with ENOENT.
 *
 * Forge commands are bl's own (F-42 D4): `bl run`, `bl review`, `bl merge`
 * and `bl updates` make every forge call, so the configured forge plugin
 * contributes nothing to any mode and no mode has a `gh pr:*` baseline.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { atomicWriteFile } from './atomic-write.js';
import { commandLeader, info } from './config.js';

// Bump when the generator's output schema or baseline content rules change.
// A bump triggers regeneration on every backlog repo on next bl invocation.
//
// v2 (2026-05-09): added `gh:*` to BASE_DEFAULT (the prior literal Gemini
// allowlist included `gh` for `gh repo`/`gh issue`/`gh release`; the v1
// generator only emitted `gh pr` / `gh api` and silently downgraded those
// agent permissions). Persists user-added patterns in a top-level `extra`
// field so `bl allow` survives regen.
// v3 (2026-05-09): S-441 retired `gh api:*` from MODE_DEFAULTS.review
// (no configured forge op uses `gh api`, and a generic GitHub-API escape
// hatch is the permission-scope footgun the named-op surface is meant to
// prevent). Bare-string `forge: <name>` now resolves against the shared
// `plugins` registry and contributes per-op two-word leaders to the
// matching modes via FORGE_OP_MODES.
// v4 (2026-05-12): S-430 dropped `review` from FORGE_OP_MODES["pr.find-by-branch"]
// — the review path discovers PRs via `pr.find-by-title-search` now, so the
// pre-S-430 `pr.find-by-branch` permission is no longer needed in review's
// allowlist.
// v5 (2026-05-15): S-452 added workflow/checks forge ops
// (`pr.checks-status`, `run.list`) to review mode for CI-gating flows.
// v6 (2026-05-16): S-453 added pr.view-web to FORGE_OP_MODES["review"]
// so a backlog shipping pr.view-web (without pr.close/pr.diff) still
// gets `gh pr:*` in the review allowlist.
// v7 (2026-06-23): added the agents' real default toolset to BASE_DEFAULT
// (rg/fdfind/fd, npx, python3, sed, file/test/wc/sort, tail/printf/sleep)
// after a permission-log audit showed these dominating the prompt volume —
// `grep`/`find` were allowlisted but the agents reach for `rg`/`fdfind`.
// Also: interpolate `{{roostDir}}`-style static vars before extracting a
// plugin's command leader, so an absolute-path plugin (prettier) yields a
// real `Bash(/abs/path:*)` rule instead of the mangled `roostDir}}:*` token
// that `commandLeader`'s leading-brace strip produced — that token never
// matched, so prettier/ppp kept prompting. (Superseded by v10: the
// absolute path belongs in the launched rule, not in the committed file.)
// v8 (2026-06-28): added `npm:*` (only `node`/`npx` were present, so
// `npm run`/`npm test` prompted) plus read-only `env`/`jq`/`yq` helpers to
// BASE_DEFAULT after a permission-log audit. `xargs` deliberately omitted —
// it runs an arbitrary downstream command, so `xargs:*` would auto-approve
// whatever it invokes.
// v9 (2026-07-08): added the per-mode `deny` map (MODE_DENY). Review mode
// hard-denies `gh pr merge` and `git push` — the review prompt already
// forbids merging/pushing, but `gh pr:*` (needed for view/diff/checks/close)
// auto-approves `gh pr merge` as a side effect of two-word prefix
// granularity, and the reviewer reads content authored by the agent under
// review, so a prompt-injected one-shot merge was the last un-gated path
// around the review cycle. Deny rules are belt-and-braces, not a sandbox:
// they match command prefixes only.
// v10 (2026-10-14): plugin leaders that start with `{{roostDir}}` /
// `{{backlogRoot}}` are written templated
// (`{{roostDir}}/tools/node_modules/.bin/prettier:*`) and resolved at
// session build by `resolveAllowedTokens` (`getAllowedTools`), so the
// committed file is identical on every machine. The v7 absolute-path
// output put machine-specific paths in the shared file, and every
// regeneration brought them back after they were removed by hand.
// `commandLeader` now keeps a leading `{{var}}` token intact, so the
// template no longer needs interpolating to survive the brace strip.
// v11 (2026-10-14): S-859 made `commandLeader` skip the whitespace-separated
// grouping tokens of `{ cmd; }` / `( cmd )` (the bare `{` stripped to
// nothing, so such a plugin got no leader and no `cmd:*` rule) and trim
// trailing `;`, `)`, `}` from the leader (`{cmd;}` produced `cmd;}:*`,
// `(cmd)` produced `cmd):*`). A trailing `{{var}}` template stays whole.
// v12 (2026-10-18): S-892 (F-42 D4) removed FORGE_OP_MODES and the
// `gh pr:*` workon/review baselines, and the forge plugin no longer
// contributes leaders: bl makes every forge call through the change ops, so
// no agent permission mode is granted a forge command. The review denials
// (`gh pr merge`, `git push`) stay.
// v13 (2026-10-26): S-1069 (F-48 D5) removed `gh:*` from BASE_DEFAULT. A
// side change is a `bl side` story now, not a hand-made PR, so no prompt
// needs the forge CLI: every forge call is bl's own (`runForgeOp`), and
// `gh auth git-credential` is run by git, not the agent's shell. The review
// denials stay as a rail.
// v14 (2026-10-26): S-1087 (F-66 A7) denies `bl block remove:*` in every
// mode (workon, refine, review, triage). `bl:*` in BASE_DEFAULT grants
// every `bl block` subcommand; lifting a hold is the operator's, so the
// one that removes an edge gets the rail. `bl block add` and `list` stay
// allowed.
// v15 (2026-10-27): S-1082 (F-65 D3) denies `bl task done:*` in every mode
// too: closing a task lifts the holds its edges make, so it is the
// operator's, like `bl block remove`. `bl task` and `bl task list` stay
// allowed through `bl:*`.
export const GENERATOR_VERSION = 15;

// ---------------------------------------------------------------------------
// Hashing — canonical JSON of the relevant config slice
// ---------------------------------------------------------------------------

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export function configHash(config) {
  const slice = {
    plugins: config?.raw?.plugins ?? config?.plugins ?? {},
    forge: config?.raw?.forge ?? null,
  };
  return createHash('sha256').update(stableStringify(slice)).digest('hex');
}

/**
 * Build the repo-independent generator input from a `loadConfig()` result.
 *
 * `configForRepo()` merges a repo's `overrides` on top of the top-level
 * file, so `config.raw.plugins` differs by repo — hashing it would make every
 * repo switch a hash mismatch and a rewrite. The allowlist is one file for
 * the whole backlog, so its input is the top-level `{plugins, forge}` plus the
 * `overrides.plugins` of every `repos` entry, each such plugin keyed
 * `<repo>/<name>`. The prefixed keys cannot collide with top-level
 * names, and the bare-string `forge` lookup (`plugins[forge]`) keeps pointing
 * at the top-level definition. A repo that overrides a plugin's command
 * contributes its leader alongside the top-level one.
 *
 * Falls back to `config.raw.plugins` (then `config.plugins`) and
 * `config.raw.forge` when `topLevel` is absent, so test fakes and legacy
 * callers keep working; `config.repos` missing or empty yields the
 * top-level slice alone. A malformed `plugins` map or plugin definition,
 * from either source, throws: the hash must never claim to cover
 * configuration whose command leaders the generator silently skipped.
 *
 * Returns a config-shaped object (`roostDir`/`backlogRoot` carried over)
 * that `configHash` and `generateAllowedTools` accept in place of the real
 * config.
 */
export function allowlistInput(config) {
  const top = config?.topLevel;
  const topPlugins = pluginMap(
    top ? top.plugins : (config?.raw?.plugins ?? config?.plugins),
    join(config?.backlogRoot ?? '', 'backlog.json'),
  );
  const plugins = { ...topPlugins };
  const forge = top ? (top.forge ?? null) : (config?.raw?.forge ?? null);
  const where = join(config?.backlogRoot ?? '', 'backlog.json');
  for (const [name, repo] of Object.entries(config?.repos ?? {})) {
    const overrides = pluginMap(repo?.overrides?.plugins, `${where} repos["${name}"].overrides`);
    for (const [plugin, def] of Object.entries(overrides)) {
      plugins[`${name}/${plugin}`] = def;
    }
  }
  return {
    roostDir: config?.roostDir,
    backlogRoot: config?.backlogRoot,
    raw: { plugins, forge },
    plugins,
  };
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate one source's `plugins` value at the input boundary. Absent
 * (`undefined`/`null`) contributes nothing; anything else must be a plain
 * object whose every definition is a plain object. A string, number or array
 * map, or a non-object definition, would be hashed yet yield no command
 * leaders, so it is rejected with the file it came from.
 */
function pluginMap(value, where) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) {
    throw new Error(`${where}: "plugins" must be an object of plugin definitions`);
  }
  for (const [name, def] of Object.entries(value)) {
    if (!isPlainObject(def)) {
      throw new Error(`${where}: plugin "${name}" must be an object`);
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

function pluginCommands(pluginDef) {
  if (!pluginDef || typeof pluginDef !== 'object') return [];
  return Object.values(pluginDef).filter((v) => typeof v === 'string');
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

// Baseline tools that every backlog ships with regardless of config. This is
// the on-disk shape from `templates/allowed-tools.json` minus `ppp` / `pnpm`,
// which used to leak in via the hard-coded session.js / sync.js call sites.
const BASE_DEFAULT = [
  'agent:spawn',
  'plan:exit',
  'fs:read',
  'fs:edit',
  'fs:write',
  'fs:glob',
  'fs:grep',
  'git:*',
  'find:*',
  'grep:*',
  // The agents reach for ripgrep / fd-find by default (the prompts steer them
  // there over `grep`/`find`); without these every `rg`/`fdfind` invocation
  // prompted. `fd` covers the non-Debian binary name.
  'rg:*',
  'fdfind:*',
  'fd:*',
  'mkdir:*',
  'ls:*',
  'cat:*',
  'cd:*',
  'awk:*',
  'head:*',
  'tail:*',
  'echo:*',
  'printf:*',
  'curl:*',
  'bl:*',
  'node:*',
  'npx:*',
  // `node`/`npx` were allowlisted but `npm` was not, so `npm run`/`npm test` —
  // among the most common agent invocations — prompted every time.
  'npm:*',
  // Read-only data/inspection helpers the agents reach for constantly
  // (env dumps, JSON/YAML queries). `xargs` is deliberately excluded: it
  // executes an arbitrary downstream command, so a blanket `xargs:*` would
  // auto-approve whatever it runs and bypass per-command checks.
  'env:*',
  'jq:*',
  'yq:*',
  // Inline scripting + read-only file inspection the agents lean on for
  // backlog edits and verification (`python3 - <<'PY'`, `file x.png`,
  // `test -f`, `wc -l`, `sort`, `sed -n`, `sleep`). All non-destructive.
  'python3:*',
  'sed:*',
  'file:*',
  'test:*',
  'wc:*',
  'sort:*',
  'sleep:*',
];

// Mode-specific defaults. No mode gets a forge command (F-42 D4): the PR is
// opened, described, found and closed by bl itself through the change ops.
const MODE_DEFAULTS = {
  workon: [],
  refine: ['bl new:*'],
  review: [],
  triage: ['bl new:*'],
};

// Per-mode hard denials. These override the allowlist: a command matching a
// deny prefix is refused even though a broader allow token (e.g. `bl:*`)
// would have auto-approved it. Every mode denies `bl block remove` (F-66
// A7) and `bl task done` (F-65 D3): an agent may file a hold or a task but
// never lift one. Review mode denies more
// — the reviewer's job is reading content authored by the agent under
// review, so its irreversible commands get a hard rail rather than
// prompt-level trust. `gh pr merge` (merging is bl merge's job; no allow token grants it
// since F-48 D5, and the denial keeps it so if a user rule does) and `git push` (nothing in the review flow pushes —
// the pre-review main-sync push happens in bl's own code, outside the
// session). Prefix-matched, like the allow tokens.
const OPERATOR_ONLY = ['bl block remove:*', 'bl task done:*'];

const MODE_DENY = {
  workon: [...OPERATOR_ONLY],
  refine: [...OPERATOR_ONLY],
  review: ['gh pr merge:*', 'git push:*', ...OPERATOR_ONLY],
  triage: [...OPERATOR_ONLY],
};

// Two-word command groupings the agents need to recognise as one capability
// so the suggestion-from-log path doesn't propose absurdly broad rules. The
// generic groupings are baked in; forge-specific ones come from config so
// S-441 can add `gitlab mr` / `azure pr` / etc. without a code edit.
const TWO_WORD_GENERIC = ['docker compose', 'docker logs', 'docker exec', 'git push', 'git remote'];

/**
 * Pure function: compute the allowed-tools object from a config. No I/O.
 * Used directly by `ensureAllowedTools` (which passes `allowlistInput(config)`
 * so the on-disk file is repo-independent), by tests, and by the agents
 * (gemini.js / claude.js) to derive their respective rule shapes.
 *
 * `opts.extra` carries forward user-added patterns that `bl allow` has
 * persisted in the on-disk file's `extra` field. They flow into `base` so
 * agents see them, and round-trip back into `extra` so the next regen
 * preserves them — a regen that drops them would defeat `bl allow`'s
 * entire purpose.
 */
export function generateAllowedTools(config, opts = {}) {
  const plugins = config?.raw?.plugins ?? config?.plugins ?? {};
  const forge = config?.raw?.forge ?? null;
  const extra = Array.isArray(opts.extra) ? opts.extra : [];

  const baseTokens = new Set(BASE_DEFAULT);
  for (const e of extra) baseTokens.add(e);

  // Every plugin's command leader becomes a `<name>:*` Bash capability,
  // except the forge plugin's: its ops are bl's to run (F-42 D4).
  // A leader that starts with `{{roostDir}}` / `{{backlogRoot}}` (prettier
  // at `{{roostDir}}/tools/.../prettier`) stays templated: the file is
  // committed and shared, so it must not carry this machine's absolute
  // path. `resolveAllowedTokens` makes the rule absolute at session build.
  for (const [name, def] of Object.entries(plugins)) {
    if (typeof forge === 'string' && name === forge) continue;
    for (const cmd of pluginCommands(def)) {
      const leader = commandLeader(cmd);
      if (leader) baseTokens.add(`${leader}:*`);
    }
  }

  const modes = {};
  for (const [mode, defaults] of Object.entries(MODE_DEFAULTS)) {
    modes[mode] = new Set(defaults);
  }

  return {
    _generated: {
      config_hash: configHash(config),
      generator_version: GENERATOR_VERSION,
    },
    base: [...baseTokens].sort(),
    workon: [...modes.workon].sort(),
    refine: [...modes.refine].sort(),
    review: [...modes.review].sort(),
    triage: [...modes.triage].sort(),
    deny: Object.fromEntries(Object.entries(MODE_DENY).map(([m, list]) => [m, [...list].sort()])),
    twoWord: TWO_WORD_GENERIC.slice().sort(),
    extra: [...extra].sort(),
  };
}

const PLACEHOLDER = /\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/;

/**
 * Resolve the templated leaders of a generated allowlist for this machine.
 * Substitutes `{{roostDir}}` and `{{backlogRoot}}` wherever a non-empty
 * string is supplied for them, then drops any token that still carries a
 * `{{...}}` placeholder: an agent permission rule holds no variables, and
 * an unresolved template would be a dead rule (or, mangled, a misleading
 * one). Tokens without placeholders pass through unchanged, so the result
 * is byte-identical to the input for every ordinary token. Returns a new
 * array; the input is never mutated.
 *
 * Only three callers turn a committed `{{roostDir}}/...:*` rule into the
 * absolute `/abs/path:*` form: `getAllowedTools` (session build, for every
 * provider), `bl allow`'s `existingPatternSet` (to recognise a suggested
 * absolute pattern as already granted) and `recoverUserExtras` (to treat
 * the absolute form a pre-v10 generator wrote under the configured roots
 * as config-derived).
 *
 * @param {string[]} tokens
 * @param {{ roostDir?: string, backlogRoot?: string }} [vars]
 * @returns {string[]}
 */
export function resolveAllowedTokens(tokens, { roostDir, backlogRoot } = {}) {
  const vars = { roostDir, backlogRoot };
  const out = [];
  for (const token of tokens ?? []) {
    if (typeof token !== 'string') continue;
    let resolved = token;
    for (const [k, v] of Object.entries(vars)) {
      if (typeof v === 'string' && v !== '') {
        // A function replacement: a `$` in the path is literal, not a
        // `$&` / `$'` replacement pattern that would re-insert the token.
        resolved = resolved.replaceAll(`{{${k}}}`, () => v);
      }
    }
    if (PLACEHOLDER.test(resolved)) continue;
    out.push(resolved);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lazy on-disk regeneration
// ---------------------------------------------------------------------------

/**
 * Compute the user-additions slice of an on-disk file. Anything in `base` or
 * `extra` that the generator would not emit from `BASE_DEFAULT` plus the
 * input's plugin leaders is treated as a user addition and preserved across
 * regens: the patterns a user appended (whether they landed in `extra` or,
 * for legacy files, directly in `base`) are merged back into the freshly
 * generated allowlist. An `extra` entry the input now generates is dropped
 * from `extra` — it is config-derived, not a user addition. So is the
 * absolute form of a templated leader (`/home/x/acme/tools/.../prettier:*`
 * for `{{roostDir}}/tools/.../prettier:*`) resolved with the input's
 * configured `roostDir` / `backlogRoot`, which pre-v10 generators wrote
 * into `base` on this checkout; rescuing it into `extra` would put the
 * machine-specific path straight back into the shared file. Only exact
 * generated tokens and those resolved forms count as generated: a declared
 * token is never dropped because its shape resembles a generated one
 * (`/opt/company/tools/bin/prettier:*` under a `{{roostDir}}/tools/bin/
 * prettier:*` leader is a user grant and is preserved). The absolute form
 * another machine or an earlier root wrote is therefore preserved as a
 * user addition too; it is removed by hand, not by regeneration.
 *
 * `input` must be the repo-independent `allowlistInput(config)`, not a
 * `configForRepo` config: generating from one repo's plugins would
 * classify another repo's leader as a user addition.
 */
function recoverUserExtras(existing, input) {
  if (!existing || typeof existing !== 'object') return [];
  const declared = Array.isArray(existing.extra) ? existing.extra : [];
  const baseList = Array.isArray(existing.base) ? existing.base : [];

  // Reconstruct the set of tokens the generator *would* emit purely from
  // BASE_DEFAULT + input so we can distinguish which entries were
  // user-added (and therefore must be persisted as `extra`). The form of
  // each templated leader resolved with the configured roots counts as
  // generated as well; nothing else is matched by shape.
  const generated = generateAllowedTools(input);
  const generatedBase = new Set(BASE_DEFAULT);
  for (const tok of generated.base) generatedBase.add(tok);
  const resolved = resolveAllowedTokens(generated.base, {
    roostDir: input?.roostDir,
    backlogRoot: input?.backlogRoot,
  });
  for (const tok of resolved) generatedBase.add(tok);

  const recovered = new Set();
  for (const tok of [...declared, ...baseList]) {
    if (!generatedBase.has(tok)) recovered.add(tok);
  }
  return [...recovered];
}

const short = (hash) => String(hash ?? 'none').slice(0, 8);

/**
 * Decide whether the on-disk file must be regenerated, and why.
 *
 * `existing` is the parsed on-disk document, `null` when the file does not
 * exist, or the `Error` thrown while parsing it; a document that is not a
 * JSON object (an array, a string) is as unparseable as a syntax error.
 * Returns `null` when the file is current, otherwise the trigger that
 * `ensureAllowedTools` logs: `missing`, `unparseable`,
 * `config hash <old8>→<new8>` or `generator version <old>→<new>`. Only the
 * hash and the version decide; an old-style file that still carries a
 * `generated_at` field is current when those match, and the field goes the
 * next time a real change regenerates.
 */
export function regenReason(existing, { hash, version }) {
  if (existing === null || existing === undefined) return 'missing';
  if (existing instanceof Error || typeof existing !== 'object' || Array.isArray(existing)) {
    return 'unparseable';
  }
  const oldHash = existing._generated?.config_hash;
  const oldVersion = existing._generated?.generator_version;
  if (oldHash !== hash) return `config hash ${short(oldHash)}→${short(hash)}`;
  if (oldVersion !== version) {
    return `generator version ${oldVersion ?? 'none'}→${version}`;
  }
  return null;
}

/**
 * Read the on-disk allowed-tools.json, regenerate atomically if stale, and
 * return the (possibly fresh) parsed object. Safe to call from every bl
 * subcommand that needs the allowlist.
 *
 * The hash and the content come from `allowlistInput(config)`, so every
 * project computes the same file. A regen whose serialized bytes equal the
 * current file is not written (mtime and git status stay put); one that
 * writes prints its trigger through `info` (stderr), which is how an
 * unexpected rewrite gets traced.
 */
export function ensureAllowedTools(backlogRoot, config) {
  const path = join(backlogRoot, 'allowed-tools.json');
  const input = allowlistInput(config);
  let current = null;
  let existing = null;

  if (existsSync(path)) {
    current = readFileSync(path, 'utf8');
    try {
      existing = JSON.parse(current);
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        throw new Error('allowed-tools.json is not a JSON object');
      }
    } catch (err) {
      existing = err;
    }
  }

  const reason = regenReason(existing, {
    hash: configHash(input),
    version: GENERATOR_VERSION,
  });
  if (reason === null) return existing;

  const parsed = existing instanceof Error ? null : existing;
  const extra = recoverUserExtras(parsed, input);
  const fresh = generateAllowedTools(input, { extra });
  const text = JSON.stringify(fresh, null, 2) + '\n';
  if (text === current) return fresh;

  atomicWriteFile(backlogRoot, path, text);
  info(`allowed-tools.json regenerated: ${reason}`);
  return fresh;
}
