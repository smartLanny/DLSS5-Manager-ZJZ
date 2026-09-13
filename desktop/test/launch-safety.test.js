'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { atomicJson } = require('../src/product/launch-safety');
test('JSON writes do not overwrite a pre-existing temporary hardlink', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-atomic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = path.join(root, 'outside.txt'), file = path.join(root, 'data/state.json');
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(outside, 'PRESERVE');
  fs.linkSync(outside, `${file}.tmp`);
  await atomicJson(file, { safe: true });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'PRESERVE');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { safe: true });
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['state.json', 'state.json.tmp']);
});
