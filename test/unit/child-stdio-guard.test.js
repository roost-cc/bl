// Child stdio through files (F-70 D1). Inside Codex's sandbox a child's
// `input:` never ends (the sandbox refuses the `shutdown(2)` Node ends it with)
// and a Node child on a socket gets dummy streams (its stdout vanishes, its
// stdin ends at once). So no `child_process` call in src/ or test/ passes
// `input`, and no Node child (process.execPath, 'node', BL_BIN, BL_PATH) is
// started with a 'pipe' stream outside src/child-stdio.js: text for a stdin and
// a captured output go through `spawnSyncFiles`, a live stream through a file.
// And no synchronous call leaves stdin 'pipe' (its default): Node ends that
// stdin with the same refused shutdown, and the call reports EPERM, which
// makes execFileSync and execSync throw, from a child that succeeded.
//
// The check parses each file with acorn: an `input` key across lines or as a
// `{ input }` shorthand needs a JavaScript parser, and acorn is the standard
// one (F-70 D1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";
import { fileURLToPath } from "url";
import { parse } from "acorn";
import { ancestor, simple } from "acorn-walk";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const EXEMPT = new Set(["src/child-stdio.js"]);
const SYNC_CALLS = new Set(["spawnSync", "execFileSync", "execSync"]);
const CALLS = new Set([...SYNC_CALLS, "spawn", "execFile", "exec"]);
const NODE_IDS = new Set(["BL_BIN", "BL_PATH"]);

/** The name a call's callee ends in: `spawnSync` for `spawnSync(…)` and `cp.spawnSync(…)`. */
function calleeName(callee) {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed) return callee.property.name;
  return null;
}

/**
 * Whether a command argument names a Node child. `aliases` holds the names a
 * file declares from one (`const node = process.execPath`, `{ bin = BL_BIN }`).
 */
function isNodeCommand(node, aliases = new Set()) {
  if (!node) return false;
  if (node.type === "Literal") return node.value === "node";
  if (node.type === "Identifier") return NODE_IDS.has(node.name) || aliases.has(node.name);
  if (node.type === "MemberExpression" && !node.computed) {
    const { object, property } = node;
    if (object.type === "Identifier" && object.name === "process" && property.name === "execPath") return true;
    return NODE_IDS.has(property.name);
  }
  return false;
}

/**
 * A call's options argument, or undefined: the third argument, or a second
 * that is not an argument list (`spawnSync(cmd, { shell: true })`,
 * `execSync(cmd, opts)`). A lone identifier second argument is read as the
 * argument list, except for `exec` and `execSync`, which take none, and one
 * bound to an object literal.
 */
function optionsArgument(name, args, bindings) {
  const isOptions = (a) => a != null && !/Function/.test(a.type) && a.type !== "ArrayExpression";
  if (isOptions(args[2])) return args[2];
  const second = args[1];
  if (!isOptions(second)) return undefined;
  if (second.type !== "Identifier" || name === "exec" || name === "execSync") return second;
  return resolve(second, bindings).some((v) => v.type === "ObjectExpression") ? second : undefined;
}

/**
 * The values a source assigns to each name: `const x = …`, `x = …`. A name
 * bound more than once (in two scopes, or reassigned) keeps every value.
 */
function bindingsOf(ast) {
  const bindings = new Map();
  const add = (name, value) => bindings.set(name, [...(bindings.get(name) ?? []), value]);
  simple(ast, {
    VariableDeclarator(d) {
      if (d.id.type === "Identifier" && d.init) add(d.id.name, d.init);
    },
    AssignmentExpression(a) {
      if (a.operator === "=" && a.left.type === "Identifier") add(a.left.name, a.right);
    },
  });
  return bindings;
}

/**
 * The values an expression may stand for: itself, or every value bound to an
 * identifier (`const opts = {…}; spawnSync(cmd, [], opts)`), alias of an alias
 * included.
 */
function resolve(node, bindings, seen = new Set()) {
  if (node?.type !== "Identifier" || !bindings.has(node.name)) return node ? [node] : [];
  if (seen.has(node.name)) return [];
  seen.add(node.name);
  return bindings.get(node.name).flatMap((v) => resolve(v, bindings, seen));
}

/**
 * The object literals that make up an options argument: the literal itself and
 * any literal spread into it, through `a ? {…} : {…}`, `a && {…}` and the
 * values an identifier is bound to.
 */
function optionObjects(node, bindings) {
  return resolve(node, bindings).flatMap((n) => {
    switch (n.type) {
      case "ObjectExpression":
        return [
          n,
          ...n.properties.filter((p) => p.type === "SpreadElement").flatMap((p) => optionObjects(p.argument, bindings)),
        ];
      case "ConditionalExpression":
        return [...optionObjects(n.consequent, bindings), ...optionObjects(n.alternate, bindings)];
      case "LogicalExpression":
        return [...optionObjects(n.left, bindings), ...optionObjects(n.right, bindings)];
      default:
        return [];
    }
  });
}

/**
 * A property's key: `input` for `input:`, `'input':`, `['input']:` and
 * `` [`input`]: ``. A computed key the guard cannot read is `?`, which the
 * input rule counts as `input`.
 */
function keyName(prop) {
  if (prop.type !== "Property") return null;
  if (!prop.computed && prop.key.type === "Identifier") return prop.key.name;
  if (prop.key.type === "Literal") return String(prop.key.value);
  if (prop.key.type === "TemplateLiteral" && prop.key.expressions.length === 0) return prop.key.quasis[0].value.cooked;
  return prop.computed ? "?" : null;
}

/**
 * Whether a `stdio` value leaves any stream a socket: one of the first three,
 * or a descriptor after them (`'ipc'` included). An entry the guard cannot read counts as one,
 * except an identifier (taken for a descriptor), `process.stdin`/`stdout`/
 * `stderr` and an `openSync(…)` call. After stderr an absent entry is
 * `'ignore'`, as Node reads it.
 */
function stdioPipes(value, bindings) {
  return resolve(value, bindings).some((v) => {
    if (v.type === "Literal") return v.value === "pipe" || v.value === "overlapped";
    if (v.type !== "ArrayExpression") return true;
    if (v.elements.length < 3) return true;
    const entryPipes = (e, i) => {
      const absent =
        !e || (e.type === "Literal" && e.value === null) || (e.type === "Identifier" && e.name === "undefined");
      if (absent) return i < 3;
      // `'ipc'` is a socket too.
      if (e.type === "Literal") return e.value === "pipe" || e.value === "overlapped" || e.value === "ipc";
      // A bound name is what it is bound to; an unbound one a descriptor.
      if (e.type === "Identifier") return bindings.has(e.name) && resolve(e, bindings).some((x) => entryPipes(x, i));
      if (e.type === "MemberExpression" && !e.computed && e.object.type === "Identifier") {
        return !(e.object.name === "process" && /^std(in|out|err)$/.test(e.property.name));
      }
      if (e.type === "CallExpression") return calleeName(e.callee) !== "openSync";
      return true;
    };
    return v.elements.some(entryPipes);
  });
}

/** The names a source binds to a Node command, by declaration or default value. */
function nodeAliases(ast) {
  const aliases = new Set();
  // Repeat until stable so an alias of an alias counts too.
  for (let size = -1; size !== aliases.size;) {
    size = aliases.size;
    simple(ast, {
      VariableDeclarator(d) {
        if (d.id.type === "Identifier" && isNodeCommand(d.init, aliases)) aliases.add(d.id.name);
      },
      AssignmentPattern(p) {
        if (p.left.type === "Identifier" && isNodeCommand(p.right, aliases)) aliases.add(p.left.name);
      },
    });
  }
  return aliases;
}

/** The synchronous `child_process` function a value names (`spawnSync`, `cp.execSync`), or null. */
function syncTarget(node) {
  const name = node && (node.type === "Identifier" || node.type === "MemberExpression") ? calleeName(node) : null;
  return SYNC_CALLS.has(name) ? name : null;
}

/** The names a source declares as a synchronous `child_process` function (`const sh = cp.execSync`). */
function declaredSyncAliases(ast) {
  const aliases = new Map();
  simple(ast, {
    VariableDeclarator(d) {
      if (d.id.type === "Identifier" && syncTarget(d.init)) aliases.set(d.id.name, syncTarget(d.init));
    },
  });
  return aliases;
}

/**
 * What a parameter list binds `name` to: the sync function its default names
 * (`run = spawnSync`, `{ run = execFileSync }`), `null` for another binding,
 * or undefined when the list does not bind it.
 */
function paramBinding(params, name) {
  for (const param of params) {
    const found = patternBinding(param, name);
    if (found !== undefined) return found;
  }
  return undefined;
}

function patternBinding(p, name) {
  if (!p) return undefined;
  switch (p.type) {
    case "Identifier":
      return p.name === name ? null : undefined;
    case "AssignmentPattern":
      if (p.left.type === "Identifier") return p.left.name === name ? syncTarget(p.right) : undefined;
      return patternBinding(p.left, name);
    case "ObjectPattern":
      return paramBinding(
        p.properties.map((q) => (q.type === "RestElement" ? q.argument : q.value)),
        name,
      );
    case "ArrayPattern":
      return paramBinding(p.elements, name);
    case "RestElement":
      return patternBinding(p.argument, name);
    default:
      return undefined;
  }
}

/**
 * The sync function an identifier callee stands for at a call: the nearest
 * enclosing function parameter that binds it decides; else a declaration.
 */
function syncAliasAt(name, ancestors, declared) {
  for (let i = ancestors.length - 2; i >= 0; i--) {
    const a = ancestors[i];
    if (!/Function/.test(a.type)) continue;
    const found = paramBinding(a.params, name);
    if (found !== undefined) return found;
  }
  return declared.get(name) ?? null;
}

/** Whether a `stdio` value leaves stdin a socket: absent, `'pipe'`, or a first entry of `'pipe'`. */
function stdinPipes(value, bindings) {
  if (!value) return true;
  return resolve(value, bindings).some((v) => {
    if (v.type === "Literal") return v.value === "pipe" || v.value === "overlapped";
    if (v.type !== "ArrayExpression") return false;
    const first = v.elements[0];
    if (!first) return true;
    return resolve(first, bindings).some((e) => {
      if (e.type === "Literal") return e.value === null || e.value === "pipe" || e.value === "overlapped";
      return e.type === "Identifier" && e.name === "undefined";
    });
  });
}

/**
 * The guard's findings in one source: `[{ line, what }]`.
 * @param {string} source
 */
export function childStdioViolations(source) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true, allowHashBang: true });
  const aliases = nodeAliases(ast);
  const declared = declaredSyncAliases(ast);
  const bindings = bindingsOf(ast);
  const out = [];
  ancestor(ast, {
    CallExpression(call, _state, ancestors) {
      const called = calleeName(call.callee);
      const alias = call.callee.type === "Identifier" ? syncAliasAt(called, ancestors, declared) : null;
      const name = alias ?? called;
      if (!CALLS.has(name)) return;
      const options = optionsArgument(name, call.arguments, bindings);
      const objects = optionObjects(options, bindings);
      const props = objects.flatMap((o) => o.properties);
      const input = props.some((p) => keyName(p) === "input" || keyName(p) === "?");
      if (input) {
        out.push({ line: call.loc.start.line, what: `${name}() passes input: (use spawnSyncFiles)` });
      }
      // A synchronous call ends a 'pipe' stdin with shutdown(2) even without
      // input; the sandbox refuses it, and the call reports EPERM (execFileSync
      // and execSync throw it) from a child that succeeded.
      const stdioValue = props.find((p) => keyName(p) === "stdio")?.value;
      const seeable = options == null || objects.length > 0;
      if (SYNC_CALLS.has(name) && !input && seeable && stdinPipes(stdioValue, bindings)) {
        out.push({ line: call.loc.start.line, what: `${name}() leaves stdin 'pipe' (give it 'ignore')` });
      }
      if (!isNodeCommand(call.arguments[0], aliases)) return;
      // An options value the guard cannot see into counts as piping.
      const opaque = options != null && objects.length === 0;
      const stdio = props.filter((p) => keyName(p) === "stdio").map((p) => p.value);
      if (opaque || stdio.length === 0 || stdio.some((s) => stdioPipes(s, bindings))) {
        out.push({
          line: call.loc.start.line,
          what: `${name}() starts a Node child with a 'pipe' stream (use spawnSyncFiles or a file)`,
        });
      }
    },
  });
  return out;
}

function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : jsFiles(p);
    return e.name.endsWith(".js") ? [p] : [];
  });
}

test("no input:, no piped Node child and no piped synchronous stdin in src/ or test/ outside src/child-stdio.js", () => {
  const found = [];
  for (const file of [...jsFiles(join(ROOT, "src")), ...jsFiles(join(ROOT, "test"))]) {
    const rel = relative(ROOT, file);
    if (EXEMPT.has(rel)) continue;
    for (const v of childStdioViolations(readFileSync(file, "utf8"))) found.push(`${rel}:${v.line}: ${v.what}`);
  }
  assert.deepEqual(found, []);
});

const CASES = [
  { name: "input: on spawnSync", src: `spawnSync('cat', [], { input: 'x' })`, hits: 1 },
  { name: "input: on a member call", src: `cp.execFileSync('git', ['x'], { input: 'x' })`, hits: 1 },
  { name: "the { input } shorthand", src: `const input = 'x'; spawnSync('cat', [], { input })`, hits: 1 },
  {
    name: "a multi-line options object",
    src: `spawnSync('cat', [], {\n  cwd: '/',\n  encoding: 'utf8',\n  input: text,\n})`,
    hits: 1,
  },
  { name: "input: spread in under a condition", src: `spawnSync('cat', [], { ...(x ? { input: x } : {}) })`, hits: 1 },
  { name: "input: in the (command, options) form", src: `execSync('cat', { input: 'x' })`, hits: 1 },
  { name: "process.execPath piped by default", src: `spawn(process.execPath, ['-e', '1'])`, hits: 1 },
  {
    name: "a synchronous Node child piped by default is two findings",
    src: `spawnSync(process.execPath, ['-e', '1'])`,
    hits: 2,
  },
  { name: "'node' with stdio 'pipe'", src: `spawn('node', ['x'], { stdio: 'pipe' })`, hits: 1 },
  { name: "BL_BIN with one piped stream", src: `spawn(BL_BIN, [], { stdio: ['ignore', 'pipe', 'inherit'] })`, hits: 1 },
  { name: "BL_PATH with a short stdio array", src: `spawnSync(BL_PATH, [], { stdio: ['ignore'] })`, hits: 1 },
  {
    name: "a Node child with a computed stdio entry",
    src: `spawn(process.execPath, [], { stdio: [fd, quiet ? 'ignore' : 'pipe', fd] })`,
    hits: 1,
  },
  { name: "a Node child with a member stdio entry", src: `spawn('node', [], { stdio: [fd, o.mode, fd] })`, hits: 1 },
  { name: "an alias of process.execPath", src: `const node = process.execPath;\nspawn(node, ['x'])`, hits: 1 },
  {
    name: "a parameter defaulting to BL_BIN",
    src: `function f({ bin = BL_BIN }) { return spawn(bin, [], { stdio: ['ignore', 'pipe', 'pipe'] }) }`,
    hits: 1,
  },
  {
    name: "a Node child on process streams and openSync",
    src: `spawn('node', [], { stdio: [openSync(p, 'r'), process.stdout, process.stderr] })`,
    hits: 0,
  },
  { name: "a Node child with opaque options", src: `spawnSync(process.execPath, ['x'], opts)`, hits: 1 },
  { name: "a Node child with input: is two findings", src: `spawnSync('node', ['x'], { input: 'y' })`, hits: 2 },
  { name: "a Node child on descriptors", src: `spawnSync(process.execPath, ['x'], { stdio: [fd, fd, fd] })`, hits: 0 },
  { name: "a Node child inheriting", src: `spawnSync(BL_BIN, [], { stdio: 'inherit' })`, hits: 0 },
  { name: "a Node child ignoring", src: `spawn('node', [], { stdio: ['ignore', 'ignore', 'inherit'] })`, hits: 0 },
  {
    name: "a non-Node child capturing output, stdin ignored",
    src: `spawnSync('git', ['status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })`,
    hits: 0,
  },
  { name: "spawnSyncFiles with input", src: `spawnSyncFiles(BL_BIN, [], { input: 'x' })`, hits: 0 },
  { name: "an input key outside a child_process call", src: `run({ input: 'x' })`, hits: 0 },
  // Rule (c): a synchronous call ends a 'pipe' stdin with shutdown(2).
  { name: "spawnSync with stdin piped by default", src: `spawnSync('git', ['status'], { encoding: 'utf8' })`, hits: 1 },
  { name: "execSync with no options", src: `execSync('git status')`, hits: 1 },
  { name: "execFileSync with stdio 'pipe'", src: `execFileSync('git', ['x'], { stdio: 'pipe' })`, hits: 1 },
  {
    name: "a stdio array opening with 'pipe'",
    src: `spawnSync('git', [], { stdio: ['pipe', 'pipe', 'inherit'] })`,
    hits: 1,
  },
  {
    name: "a runner defaulting to spawnSync",
    src: `function f(run = spawnSync) { return run('git', ['x']) }`,
    hits: 1,
  },
  {
    name: "a runner destructured with a spawnSync default",
    src: `function f({ run = cp.spawnSync } = {}) { return run('git', ['x'], { cwd: '/' }) }`,
    hits: 1,
  },
  {
    name: "a runner defaulting to spawnSyncFiles, in a file where another defaults to spawnSync",
    src: `function f(run = spawnSync) { return run('git', [], { stdio: 'inherit' }) }\nfunction g(run = spawnSyncFiles) { return run('git', ['x']) }`,
    hits: 0,
  },
  { name: "an async spawn of a non-Node child", src: `spawn('git', ['x'])`, hits: 0 },
  { name: "spawnSync with opaque options", src: `spawnSync('git', ['x'], opts)`, hits: 0 },
];

for (const c of CASES) {
  test(`guard: ${c.name} → ${c.hits} finding(s)`, () => {
    assert.equal(childStdioViolations(c.src).length, c.hits, JSON.stringify(childStdioViolations(c.src)));
  });
}

// Options reached through a name, and descriptors after stderr (F-70 review r1).
const INDIRECT = [
  { name: "input: in a named options object", src: `const opts = { input: 'x' }; spawnSync('cat', [], opts)`, hits: 1 },
  {
    name: "input: through an alias of an alias",
    src: `const a = { input: 'x' }; const b = a; execFileSync('cat', [], b)`,
    hits: 1,
  },
  { name: "input: in a spread named object", src: `const o = { input: 'x' }; spawnSync('cat', [], { ...o })`, hits: 1 },
  { name: "input: in a reassigned options name", src: `let o; o = { input: 'x' }; spawnSync('cat', [], o)`, hits: 1 },
  { name: "input: in a named (command, options) form", src: `const o = { input: 'x' }; spawnSync('cat', o)`, hits: 1 },
  { name: "a computed 'input' key", src: `spawnSync('cat', [], { ['input']: 'x' })`, hits: 1 },
  { name: "a computed template input key", src: "spawnSync(`cat`, [], { [`input`]: `x` })", hits: 1 },
  { name: "an unreadable computed key", src: `spawnSync('cat', [], { [k]: 'x' })`, hits: 1 },
  {
    name: "stdin left pipe in a named options object",
    src: `const o = { encoding: 'utf8' }; spawnSync('git', [], o)`,
    hits: 1,
  },
  {
    name: "stdin ignored in a named options object",
    src: `const o = { stdio: ['ignore', 'pipe', 'pipe'] }; spawnSync('git', [], o)`,
    hits: 0,
  },
  {
    name: "a named stdio array opening with pipe",
    src: `const s = ['pipe', 'pipe', 'pipe']; spawnSync('git', [], { stdio: s })`,
    hits: 1,
  },
  {
    name: "a Node child with a piped descriptor after stderr",
    src: `spawnSync(process.execPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] })`,
    hits: 1,
  },
  {
    name: "a Node child with an 'overlapped' descriptor after stderr",
    src: `spawn('node', [], { stdio: ['ignore', 'ignore', 'ignore', 'ignore', 'overlapped'] })`,
    hits: 1,
  },
  {
    name: "a Node child with an absent descriptor after stderr",
    src: `spawn('node', [], { stdio: ['ignore', 'ignore', 'ignore', undefined, null, , 'inherit'] })`,
    hits: 0,
  },
  {
    name: "a Node child with an 'ipc' descriptor after stderr",
    src: `spawn('node', [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })`,
    hits: 1,
  },
  {
    name: "a Node child with a named piped entry",
    src: `const m = 'pipe'; spawn('node', [], { stdio: ['ignore', m, 'ignore'] })`,
    hits: 1,
  },
  {
    name: "a Node child with named stdio piping after stderr",
    src: `const stdio = ['ignore', 'ignore', 'ignore', 'pipe']; spawn(BL_BIN, [], { stdio })`,
    hits: 1,
  },
  {
    name: "a Node child with named options piping after stderr",
    src: `const o = { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] }; spawn(BL_BIN, [], o)`,
    hits: 1,
  },
  {
    name: "a Node child on named descriptors",
    src: `const fd = openSync(p, 'r'); spawn(process.execPath, [], { stdio: [fd, fd, fd, fd] })`,
    hits: 0,
  },
];

test("child_stdio_guard_indirect_options_and_extra_descriptors", () => {
  for (const c of INDIRECT) {
    const found = childStdioViolations(c.src);
    assert.equal(found.length, c.hits, `${c.name}: ${JSON.stringify(found)}`);
  }
});

test("guard: a finding names its line", () => {
  assert.deepEqual(
    childStdioViolations(`const a = 1;\n\nspawnSync('cat', [], {\n  input: a,\n});`).map((v) => v.line),
    [3],
  );
});
