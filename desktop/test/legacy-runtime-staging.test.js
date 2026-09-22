'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { buildLegacyRuntime } = require('../scripts/stage-manager-distribution.cjs');

test('release staging rejects an omitted or forged fixed legacy pool before it can produce a broken HoYo package', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-stage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = { stageRoot: path.join(root, 'stage'), manifestFile: path.join(root, 'staging.json'), manifest: {} };
  await assert.rejects(buildLegacyRuntime(input), /legacyRuntime.root/);
  input.manifest.legacyRuntime = { root: path.join(root, 'pool') }; fs.mkdirSync(input.manifest.legacyRuntime.root);
  await assert.rejects(buildLegacyRuntime(input), { code: 'LEGACY_PACKAGE_MISSING' });
  fs.writeFileSync(path.join(input.manifest.legacyRuntime.root, 'manifest.json'), JSON.stringify({ schema: 1, assets: [] }));
  await assert.rejects(buildLegacyRuntime(input), { code: 'LEGACY_PACKAGE_UNTRUSTED' });
  assert.equal(fs.existsSync(input.stageRoot), false);
});
