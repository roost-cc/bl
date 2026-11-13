import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// bl installs with npm ci, which builds fs-ext's native module (allowScripts).
// A `pnpm exec` in bl reinstalls node_modules in pnpm's layout and skips that
// build, so every test that loads fs-ext fails. Naming npm in packageManager
// makes pnpm refuse with ERR_PNPM_OTHER_PM_EXPECTED instead.
test('package.json names npm as the package manager, so pnpm refuses to reinstall node_modules', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.packageManager ?? '', /^npm@\d+\.\d+\.\d+$/);
});
