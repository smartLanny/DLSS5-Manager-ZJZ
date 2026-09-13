'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { verifyDistributionPolicy, BLOCKED } = require('../scripts/verify-distribution-policy');
const { sourceCopies } = require('../scripts/verify-manager-release');

test('distribution policy checks the resolved stage and compares digest strings', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-dynamic-policy-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const stage = path.join(root, 'stage'); fs.mkdirSync(stage);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { 'build:base': 'dynamic' }, build: { productName: 'Fixture', extraResources: [] } }));
  const bytes = Buffer.from('inert fixture component'); fs.writeFileSync(path.join(stage, 'runtime.dll'), bytes);
  const buildConfig = { productName: 'Fixture', extraResources: [{ from: stage, to: 'runtime' }] };
  await assert.rejects(verifyDistributionPolicy(root), /require --build-config/);
  await assert.rejects(verifyDistributionPolicy(root, { buildConfig: { extraResources: [] } }), /must include resolved resources/);
  assert.throws(() => sourceCopies(root, buildConfig.extraResources), /Unsafe/);
  const good = await verifyDistributionPolicy(root, { buildConfig });
  assert.equal(good.ok, true); assert.equal(good.checkedFiles, 1);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex'); BLOCKED.add(digest);
  t.after(() => BLOCKED.delete(digest));
  const bad = await verifyDistributionPolicy(root, { buildConfig });
  assert.equal(bad.ok, false); assert.equal(bad.blocked[0].reason, 'Blocked upstream asset digest.');
  const extraFile = await verifyDistributionPolicy(root, { buildConfig: { ...buildConfig, extraFiles: [{ from: path.join(stage, 'runtime.dll'), to: 'root-runtime.dll' }] } });
  assert.ok(extraFile.blocked.some(row => row.file === 'root-runtime.dll'));
  assert.throws(() => sourceCopies(root, [{ from: stage, to: '../escaped' }], '', { allowAbsoluteSources: true }), /Unsafe/);
});
