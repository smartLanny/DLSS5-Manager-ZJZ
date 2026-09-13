'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepare, validatePlan, sha256, checkInputs } = require('../scripts/prepare-vulkan-runtime');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.txt'); fs.writeFileSync(source, 'fixed resource');
  const plan = { version: 1, id: 'vk-fixture', coreVersion: '0.4.6-hotfix.1', sourceRevision: 'e7df0fc', architecture: 64,
    files: [{ source, target: 'licenses/source.txt', sha256: sha256(fs.readFileSync(source)), mutable: false,
      license: 'fixture license', provenance: { source: 'test-only' } }], acceptance: { status: 'pending' } };
  const file = path.join(root, 'plan.json'), destination = path.join(root, 'package');
  const save = () => fs.writeFileSync(file, JSON.stringify(plan)); save();
  return { root, source, plan, file, destination, save };
}

test('pending package retains provenance and cannot replace existing output', async t => {
  const f = fixture(t); const built = await prepare(f.file, f.destination);
  assert.equal(built.acceptance, 'pending'); assert.equal(built.recipe.acceptance.realGameVerified, false);
  assert.equal(built.recipe.files[0].license, 'fixture license');
  assert.deepEqual(built.recipe.files[0].provenance, { source: 'test-only' });
  assert.equal(fs.readFileSync(path.join(f.destination, 'licenses/source.txt'), 'utf8'), 'fixed resource');
  await assert.rejects(prepare(f.file, f.destination), { code: 'VULKAN_RUNTIME_DEST_NOT_EMPTY' });
});

test('source drift and unproven processed claims fail before publishing a package', async t => {
  const f = fixture(t); fs.writeFileSync(f.source, 'changed resource');
  await assert.rejects(prepare(f.file, f.destination), { code: 'VULKAN_RUNTIME_SOURCE_HASH' });
  assert.equal(fs.existsSync(f.destination), false);
  fs.writeFileSync(f.source, 'fixed resource'); f.plan.acceptance.status = 'processed'; f.save();
  await assert.rejects(prepare(f.file, f.destination), { code: 'VULKAN_RUNTIME_ACCEPTANCE_FAILED' });
  assert.equal(fs.existsSync(f.destination), false);
});

test('publication rolls back its isolated stage after a copy failure', async t => {
  const f = fixture(t);
  await assert.rejects(prepare(f.file, f.destination, { copyFile: async () => { throw new Error('copy denied'); } }), /copy denied/);
  assert.equal(fs.existsSync(f.destination), false);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['plan.json', 'source.txt']);
});

test('paths, mutable binaries and undeclared configuration drift cannot be accepted', t => {
  const f = fixture(t);
  for (const patch of [{ target: '../escape.txt' }, { target: 'Core.addon64', mutable: true }, { target: 'CON.txt' }])
    assert.throws(() => validatePlan({ ...f.plan, files: [{ ...f.plan.files[0], ...patch }] }), { code: 'VULKAN_RUNTIME_PLAN_INVALID' });
  const file = { target: 'addons/dlss5-feed.cfg', sha256: 'b'.repeat(64), mutable: true };
  const rows = [{ file: 'profile/addons/dlss5-feed.cfg', sha256: 'a'.repeat(64) }];
  assert.throws(() => checkInputs([file], rows), { code: 'VULKAN_RUNTIME_ACCEPTANCE_FAILED' });
  const difference = { target: file.target, runSha256: rows[0].sha256, packageSha256: file.sha256, reason: 'Production tracing is disabled.' };
  assert.deepEqual(checkInputs([file], rows, [difference]), [difference]);
  assert.throws(() => checkInputs([{ ...file, mutable: false }], rows, [difference]), { code: 'VULKAN_RUNTIME_ACCEPTANCE_FAILED' });
});
