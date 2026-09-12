'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReframeworkCompatibility, OFFICIAL_REFRAMEWORK_01417 } = require('../src/product/reframework-compatibility');

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-ref-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gameDir = path.join(root, 'OnimushaWotS'), exe = path.join(gameDir, 'OnimushaWotS.exe'), componentRoot = path.join(root, 'component');
  fs.mkdirSync(gameDir); fs.mkdirSync(componentRoot); fs.writeFileSync(exe, 'x64-game');
  fs.writeFileSync(path.join(componentRoot, 'component.json'), JSON.stringify(OFFICIAL_REFRAMEWORK_01417));
  const source = path.join(componentRoot, 'dinput8.dll');
  const handle = fs.openSync(source, 'w'); fs.writeSync(handle, Buffer.from('official-fixture')); fs.ftruncateSync(handle, OFFICIAL_REFRAMEWORK_01417.dll_bytes); fs.closeSync(handle);
  const fileDigest = file => {
    if (path.basename(file).toLowerCase() === 'dinput8.dll') {
      const handle = fs.openSync(file, 'r'), marker = Buffer.alloc(16); fs.readSync(handle, marker, 0, marker.length, 0); fs.closeSync(handle);
      if (marker.toString('utf8') === 'official-fixture') return OFFICIAL_REFRAMEWORK_01417.dll_sha256;
    }
    return hash(file);
  };
  const service = createReframeworkCompatibility({ pe: { getBitness: () => 64 }, fileDigest });
  const input = { gameDir, exe, engine: 'RE Engine', componentRoot };
  return { root, gameDir, exe, componentRoot, source, service, input };
}

test('exact Onimusha/RE Engine identity yields a read-only official 01417 plan and owned config seed', t => {
  const f = fixture(t), config = path.join(f.gameDir, 'nr_before_sr.ini');
  fs.writeFileSync(config, '[NRBeforeSR]\nIntensity=1.2\n');
  const result = f.service.inspect({ ...f.input, managedFiles: [{ rel: 'nr_before_sr.ini', sha256: hash(config), role: 'nr-config' }] });
  assert.equal(result.matched, true); assert.equal(result.canPrepare, true); assert.equal(result.ready, false);
  assert.equal(result.component.verified, true); assert.equal(result.component.source_commit, 'b6baf6b406efc65e077b99cb4d9ad25b0a0a9095');
  assert.equal(result.adapter.evidence.rhiExplicitEntry, false);
  assert.deepEqual(result.plan.operations.map(row => row.kind), ['copy', 'ensure-directory', 'seed-config']);
  assert.equal(result.plan.readonly, true); assert.equal(result.plan.requiresTransaction, true); assert.equal(result.plan.writesRegistry, false);
  assert.deepEqual(result.plan.deletes, []); assert.equal(result.runtime.seed.sha256, hash(config));
  assert.equal(fs.existsSync(path.join(f.gameDir, '_storage_')), false, 'inspection never creates the proposed storage directory');
  assert.equal(fs.existsSync(path.join(f.gameDir, 'dinput8.dll')), false, 'inspection never deploys the loader');
});

test('basename, root placement, engine and x64 identity all match exactly before component access', t => {
  const f = fixture(t); fs.rmSync(f.componentRoot, { recursive: true, force: true });
  for (const input of [
    { ...f.input, exe: path.join(f.gameDir, 'Other.exe') },
    { ...f.input, engine: 'Unreal Engine' },
    { ...f.input, exe: path.join(f.gameDir, 'bin', 'OnimushaWotS.exe') }
  ]) {
    fs.mkdirSync(path.dirname(input.exe), { recursive: true }); if (!fs.existsSync(input.exe)) fs.writeFileSync(input.exe, 'x64-game');
    const result = f.service.inspect(input); assert.equal(result.matched, false); assert.equal(result.plan, null);
  }
  const x86 = createReframeworkCompatibility({ pe: { getBitness: () => 32 } });
  assert.equal(x86.inspect(f.input).matched, false);
});

test('Requiem has its own official profile and accepts its large executable through bounded PE metadata', t => {
  const f = fixture(t), exe = path.join(f.gameDir, 're9.exe'); fs.writeFileSync(exe, 'x64 game');
  const statSync = fs.statSync;
  t.mock.method(fs, 'statSync', (file, ...args) => {
    const stat = statSync(file, ...args); if (path.resolve(file) === path.resolve(exe)) stat.size = 587657120; return stat;
  });
  const result = f.service.inspect({ ...f.input, exe });
  assert.equal(result.matched, true); assert.equal(result.canPrepare, true);
  assert.equal(result.adapter.id, 're9-reframework-01417'); assert.equal(result.adapter.evidence.rhiExplicitEntry, true);
  assert.deepEqual(result.plan.deletes, []); assert.equal(fs.existsSync(path.join(f.gameDir, 'dinput8.dll')), false);
});

test('official required DD2 and Wilds exact names and aliases use storage, while SF6 remains loader-only', t => {
  const f = fixture(t);
  for (const [name, storage] of [['DD2.exe', '_storage_'], ['MonsterHunterWilds.exe', '_storage_'], ['MHWILDS.exe', '_storage_'], ['StreetFighter6.exe', null], ['SF6.exe', null]]) {
    const exe = path.join(f.gameDir, name); fs.writeFileSync(exe, 'x64-game');
    const view = f.service.inspect({ ...f.input, exe });
    assert.equal(view.matched, true); assert.equal(view.canPrepare, true);
    assert.equal(view.adapter.storage, storage); assert.equal(view.adapter.evidence.rhiExplicitEntry, true);
    assert.equal(view.component.game_runtime_verified, false);
    assert.equal(view.runtime.storageDir, storage ? path.join(f.gameDir, storage) : null);
    assert.deepEqual(view.plan.operations.map(row => row.kind), ['copy']);
  }
  const renamed = path.join(f.gameDir, 'StreetFighter6_trial.exe'); fs.writeFileSync(renamed, 'x64-game');
  assert.equal(f.service.inspect({ ...f.input, exe: renamed }).matched, false);
});

test('SF6 compatibility never reads or prefers an unrelated storage directory and does not require INI ownership', t => {
  const f = fixture(t), exe = path.join(f.gameDir, 'StreetFighter6.exe'); fs.writeFileSync(exe, 'x64-game');
  const rootConfig = path.join(f.gameDir, 'nr_before_sr.ini'); fs.writeFileSync(rootConfig, '\ufeff[NRBeforeSR]\nIntensity=1.7\n');
  fs.mkdirSync(path.join(f.gameDir, '_storage_')); fs.writeFileSync(path.join(f.gameDir, '_storage_', 'nr_before_sr.ini'), 'unknown config');
  const lstat = fs.lstatSync; let storageReads = 0;
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (String(file).toLowerCase().includes('_storage_')) { storageReads++; throw new Error('unrelated storage is inaccessible'); }
    return lstat(file, ...args);
  });
  const view = f.service.inspect({ ...f.input, exe });
  assert.equal(storageReads, 0); assert.equal(view.canPrepare, true); assert.equal(view.runtime.effectiveConfig, rootConfig);
  assert.equal(view.runtime.storageConfig, null); assert.equal(view.runtime.seed, null);
  assert.equal(view.runtime.existingStorageConfigPreferred, false); assert.deepEqual(view.existing.storage.entries, []);
  assert.deepEqual(view.plan.operations.map(row => row.kind), ['copy']);
});

test('component metadata, fixed DLL bytes/hash and architecture fail closed', t => {
  const f = fixture(t), manifest = path.join(f.componentRoot, 'component.json');
  const changed = { ...OFFICIAL_REFRAMEWORK_01417, source_commit: '0'.repeat(40) }; fs.writeFileSync(manifest, JSON.stringify(changed));
  assert.throws(() => f.service.inspect(f.input), { code: 'REF_COMPONENT_INVALID' });
  fs.writeFileSync(manifest, JSON.stringify(OFFICIAL_REFRAMEWORK_01417)); fs.writeFileSync(f.source, 'wrong');
  assert.throws(() => f.service.inspect(f.input), { code: 'REF_COMPONENT_HASH' });
  const f2 = fixture(t), x86Component = createReframeworkCompatibility({ pe: { getBitness: file => file === f2.exe ? 64 : 32 }, fileDigest: f2.service.component && (() => OFFICIAL_REFRAMEWORK_01417.dll_sha256) });
  assert.throws(() => x86Component.inspect(f2.input), { code: 'REF_COMPONENT_ARCH' });
});

test('foreign dinput8 and orphan REF entries are conflicts and are never proposed for deletion', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.gameDir, 'dinput8.dll'), 'someone-else'); fs.mkdirSync(path.join(f.gameDir, 'reframework'));
  const result = f.service.inspect(f.input);
  assert.equal(result.existing.loader.state, 'conflict'); assert.equal(result.canPrepare, false);
  assert.ok(result.blockers.some(row => row.code === 'REF_DINPUT8_CONFLICT'));
  assert.deepEqual(result.plan.deletes, []); assert.ok(result.plan.preserve.includes('reframework'));
  assert.equal(fs.readFileSync(path.join(f.gameDir, 'dinput8.dll'), 'utf8'), 'someone-else');
});

test('matching external REFramework is reused without adopting deletion ownership', t => {
  const f = fixture(t), target = path.join(f.gameDir, 'dinput8.dll'); fs.copyFileSync(f.source, target); fs.mkdirSync(path.join(f.gameDir, 'reframework'));
  const result = f.service.inspect(f.input);
  assert.equal(result.existing.loader.state, 'matching-external'); assert.equal(result.ready, true); assert.equal(result.canPrepare, true);
  const loader = result.plan.operations.find(row => row.role === 'reframework-loader');
  assert.equal(loader.kind, 'preserve'); assert.equal(loader.ownership, 'external'); assert.deepEqual(result.plan.deletes, []);
});

test('existing storage config wins, while unknown cache and owned drift block automatic update or cleanup', t => {
  const f = fixture(t), target = path.join(f.gameDir, 'dinput8.dll'); fs.copyFileSync(f.source, target);
  const storage = path.join(f.gameDir, '_storage_'); fs.mkdirSync(storage);
  const rootConfig = path.join(f.gameDir, 'nr_before_sr.ini'), storedConfig = path.join(storage, 'nr_before_sr.ini');
  fs.writeFileSync(rootConfig, '[NRBeforeSR]\nStyle=1\n'); fs.writeFileSync(storedConfig, '[NRBeforeSR]\nStyle=2\n');
  fs.writeFileSync(path.join(storage, 'unknown.dll'), 'external-cache'); fs.writeFileSync(path.join(storage, 'owned.dll'), 'changed-owned');
  const result = f.service.inspect({ ...f.input, managedFiles: [
    { rel: '_storage_/owned.dll', sha256: '0'.repeat(64), role: 'runtime' },
    { rel: 'nr_before_sr.ini', sha256: hash(rootConfig), role: 'nr-config' }
  ] });
  assert.equal(result.runtime.effectiveConfig, storedConfig); assert.equal(result.runtime.seed, null);
  assert.equal(result.runtime.existingStorageConfigPreferred, true); assert.equal(result.canPrepare, false); assert.equal(result.ready, false);
  assert.ok(result.blockers.some(row => row.code === 'REF_STORAGE_REVIEW_REQUIRED'));
  assert.ok(result.blockers.some(row => row.code === 'REF_STORAGE_OWNED_DRIFT'));
  assert.ok(result.blockers.some(row => row.code === 'REF_MANAGED_FILE_CHANGED'));
  assert.deepEqual(result.plan.deletes, []);
  assert.equal(fs.readFileSync(storedConfig, 'utf8'), '[NRBeforeSR]\nStyle=2\n');
});

test('unowned root config is reported but never copied into storage', t => {
  const f = fixture(t), config = path.join(f.gameDir, 'nr_before_sr.ini'); fs.writeFileSync(config, '[NRBeforeSR]\nStyle=1\n');
  const result = f.service.inspect(f.input);
  assert.equal(result.runtime.seed, null); assert.equal(result.canPrepare, false);
  assert.ok(result.blockers.some(row => row.code === 'REF_CONFIG_OWNERSHIP_REQUIRED'));
  assert.equal(result.plan.operations.some(row => row.kind === 'seed-config'), false);
});

test('root and mirror addon64 identities are checked independently', t => {
  const f = fixture(t); fs.copyFileSync(f.source, path.join(f.gameDir, 'dinput8.dll'));
  const storage = path.join(f.gameDir, '_storage_'); fs.mkdirSync(storage);
  const rels = ['nr-before-sr.zh-CN.addon64', '_storage_/nr-before-sr.zh-CN.addon64'];
  for (const rel of rels) fs.writeFileSync(path.join(f.gameDir, rel), 'owned-core');
  const managedFiles = rels.map(rel => ({ rel, sha256: hash(path.join(f.gameDir, rel)), role: 'core' }));
  assert.equal(f.service.inspect({ ...f.input, managedFiles }).ready, true);
  fs.writeFileSync(path.join(f.gameDir, rels[0]), 'changed-root-core');
  const result = f.service.inspect({ ...f.input, managedFiles });
  assert.equal(result.canPrepare, false); assert.equal(result.managedLocations.length, 2);
  assert.deepEqual(result.managedLocations.map(row => row.valid), [false, true]);
  assert.ok(result.blockers.some(row => row.code === 'REF_MANAGED_FILE_CHANGED'));
  assert.deepEqual(result.plan.deletes, []);
});
