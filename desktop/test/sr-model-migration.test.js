'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createSrModelService, savePolicies, loadPolicies } = require('../src/product/sr-model-service');

async function fixture(t, { bound = true, profileMatches = true, external = false, badReadback = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-legacy-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gameDir = path.join(root, 'game'), exe = path.join(gameDir, 'a.exe');
  fs.mkdirSync(gameDir); fs.writeFileSync(exe, 'fixture');
  const baseline = { profileFound: true, enable: { explicit: false, value: 0 }, preset: { explicit: true, value: 11 } };
  const hash = crypto.createHash('sha256').update(path.resolve(exe).toLowerCase()).digest('hex').slice(0, 8);
  const current = { ok: true, profile: profileMatches ? `Xiaofeng DLSS5 - a [${hash}]` : 'Unrelated shared profile',
    enable: { explicit: true, value: 1 }, preset: { explicit: true, value: external ? 12 : 13 } };
  let restored = 0;
  const service = createSrModelService({ userData: root, appDir: root, gameDirectory: () => gameDir,
    gameExecutable: () => exe, detectHardware: () => ({ family: 'RTX40', series: ['RTX40'] }),
    nvapi: { readSrState: async () => structuredClone(current), restoreSrState: async () => {
      restored++; if (!badReadback) Object.assign(current, structuredClone(baseline)); return { ok: true };
    } } });
  await savePolicies(service.policyFile, { [path.resolve(gameDir).toLowerCase()]: { selection: 'm', baseline,
    baselineExecutable: bound ? exe : null, lastAppliedPreset: 'm' } });
  return { service, root, gameDir, exe, restored: () => restored };
}
test('legacy migration restores and verifies original values without changing the saved selection', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.prepareMigration('a')).restored, true);
  assert.equal(f.restored(), 1);
  assert.equal((await f.service.read('a')).selection, 'm');
  assert.equal((await f.service.read('a')).baselineCaptured, false);
  assert.equal((await f.service.prepareMigration('a')).restored, false);
});
test('unbound legacy receipts require a proven exact-EXE dedicated profile', async t => {
  const denied = await fixture(t, { bound: false, profileMatches: false });
  await assert.rejects(denied.service.prepareMigration('a'), { code: 'SETTINGS_LEGACY_MIGRATION' });
  assert.equal(denied.restored(), 0);
  const allowed = await fixture(t, { bound: false });
  assert.equal((await allowed.service.prepareMigration('a')).restored, true);
});
test('external modifications and failed readback retain the original legacy receipt', async t => {
  for (const options of [{ external: true }, { badReadback: true }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.service.prepareMigration('a'));
    assert.equal((await f.service.read('a')).baselineCaptured, true);
    if (options.external) assert.equal(f.restored(), 0);
  }
});
test('an EXE change cannot retarget an existing legacy restore record', async t => {
  const f = await fixture(t), rows = loadPolicies(f.service.policyFile);
  rows[path.resolve(f.gameDir).toLowerCase()].baselineExecutable = path.join(f.gameDir, 'other.exe');
  await savePolicies(f.service.policyFile, rows);
  await assert.rejects(f.service.prepareMigration('a'), { code: 'SETTINGS_EXE_CHANGED' });
  assert.equal(f.restored(), 0);
});
test('corrupt legacy receipts fail closed instead of treating the game as unowned', async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.service.policyFile, '{broken');
  await assert.rejects(f.service.migrationInfo('a'), { code: 'SETTINGS_LEGACY_MIGRATION' });
  await assert.rejects(f.service.prepareMigration('a'), { code: 'SETTINGS_LEGACY_MIGRATION' });
  await assert.rejects(f.service.applyBeforeLaunch('a'), { code: 'SETTINGS_LEGACY_MIGRATION' });
  await assert.rejects(f.service.write('a', 'k'), { code: 'SETTINGS_LEGACY_MIGRATION' });
  assert.equal(fs.readFileSync(f.service.policyFile, 'utf8'), '{broken');
  assert.equal(f.restored(), 0);
});
