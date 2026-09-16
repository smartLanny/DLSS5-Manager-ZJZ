'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('public package exposes diagnostics but no standalone no-sandbox launcher', () => {
  const build = require('../package.json').build;
  assert.ok(build.extraFiles.some(row => row.from === 'scripts/startup-diagnostics.cmd' && row.to === '启动诊断.cmd'));
  assert.ok(build.extraFiles.some(row => row.from === 'scripts/startup-diagnostics.ps1' && row.to === 'startup-diagnostics.ps1'));
  assert.equal(build.extraFiles.some(row => /startup-compatible|兼容启动/.test(`${row.from}/${row.to}`)), false);
  assert.equal(build.win.requestedExecutionLevel, 'asInvoker');
});

test('main process accepts no-sandbox only with a one-time retry marker and never appends it by default', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
  assert.match(main, /noSandbox\s*&&\s*!sandboxRetryOnce/);
  assert.match(main, /'--no-sandbox','--sandbox-retry-once'/);
  assert.doesNotMatch(main, /appendSwitch\s*\(\s*['"]no-sandbox['"]/);
});
