'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createReframeworkPreparation, RECEIPT } = require('../src/product/reframework-preparation');
const { OFFICIAL_REFRAMEWORK_01417: OFFICIAL } = require('../src/product/reframework-compatibility');
const { newManifest, manifestPath } = require('../src/product/manifest');
const journal = require('../src/core/file-journal');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function fixture(t, executable = 'OnimushaWotS.exe') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-transaction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gameDir = path.join(root, 'Onimusha'), exe = path.join(gameDir, executable), componentRoot = path.join(root, 'component');
  fs.mkdirSync(gameDir); fs.mkdirSync(componentRoot); fs.writeFileSync(exe, 'fixture-x64');
  fs.writeFileSync(path.join(componentRoot, 'component.json'), JSON.stringify(OFFICIAL));
  const source = path.join(componentRoot, 'dinput8.dll'), marker = Buffer.from('official-fixture');
  const fd = fs.openSync(source, 'wx'); fs.writeSync(fd, marker); fs.ftruncateSync(fd, OFFICIAL.dll_bytes); fs.closeSync(fd);
  const fileDigest = file => {
    if (path.basename(file).toLowerCase() === 'dinput8.dll') {
      const handle = fs.openSync(file, 'r'), data = Buffer.alloc(marker.length); fs.readSync(handle, data, 0, data.length, 0); fs.closeSync(handle);
      if (data.equals(marker)) return OFFICIAL.dll_sha256;
    }
    return hash(fs.readFileSync(file));
  };
  const loader = path.join(gameDir, 'dinput8.dll'), stored = path.join(gameDir, '_storage_', 'nr_before_sr.ini'), rootConfig = path.join(gameDir, 'nr_before_sr.ini');
  const receipt = path.join(gameDir, RECEIPT), input = { gameDir, exe, engine: 'RE Engine' };
  let copies = 0, checks = 0, copyFailure = 0, persistFailure = false, runningAt = 0, collideAt = 0, markerFailure = false, snapshotFailure = false;
  const create = () => createReframeworkPreparation({ componentRoot, overrides: { pe: { getBitness: () => 64 }, fileDigest, journal,
    guards: { async assertGameClosed() { checks++; if (runningAt && checks >= runningAt) throw Object.assign(new Error('game running'), { code: 'ERR_GAME_RUNNING' }); } },
    async copyFile(from, to, flags) { copies++; if (copies === collideAt) fs.writeFileSync(to, 'external appeared file');
      await fsp.copyFile(from, to, flags); if (copies === copyFailure) throw Object.assign(new Error('copy interrupted'), { code: 'EIO' }); },
    async writeRecoveryMarker(file, state) { if (markerFailure) throw Object.assign(new Error('marker denied'), { code: 'EACCES' });
      const { atomicJson } = require('../src/product/launch-safety'); return atomicJson(file, state); },
    async recoveryCopyFile(from, to, flags) { if (snapshotFailure) { fs.writeFileSync(to, 'partial snapshot'); throw Object.assign(new Error('snapshot denied'), { code: 'EIO' }); }
      return fsp.copyFile(from, to, flags); },
    async writeReceipt(file, record) { if (persistFailure) { persistFailure = false; throw Object.assign(new Error('receipt denied'), { code: 'EACCES' }); }
      const { atomicJson } = require('../src/product/launch-safety'); await atomicJson(file, record); }
  } });
  const service = create();
  function manifest(files = []) {
    const value = newManifest(gameDir, exe, 'dxgi'); value.files = files;
    fs.mkdirSync(path.dirname(manifestPath(gameDir)), { recursive: true }); fs.writeFileSync(manifestPath(gameDir), JSON.stringify(value)); return value;
  }
  function row(relative, bytes, kind = 'config') { return { rel: relative, kind, original: { existed: false, backupRel: null, sha256: null }, installedSha256: hash(bytes) }; }
  function ownedConfig(bytes = Buffer.from('[NRBeforeSR]\r\nIntensity=1\r\n')) { fs.writeFileSync(rootConfig, bytes); return manifest([row('nr_before_sr.ini', bytes)]); }
  return { root, gameDir, exe, componentRoot, source, loader, stored, rootConfig, receipt, input, service, create, fileDigest, row, manifest, ownedConfig,
    get copies() { return copies; }, failCopy(n) { copyFailure = n; }, failPersist() { persistFailure = true; }, runAt(n) { runningAt = n; },
    collide(n, marker = false, snapshot = false) { collideAt = n; markerFailure = marker; snapshotFailure = snapshot; } };
}

test('official loader and CURRENT edited owned INI seed atomically, preserving UTF16 BOM bytes and unknown mods', async t => {
  const f = fixture(t); f.ownedConfig();
  const current = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[NRBeforeSR]\r\nIntensity=1.65\r\n;玩家配置\r\n', 'utf16le')]);
  fs.writeFileSync(f.rootConfig, current); fs.mkdirSync(path.join(f.gameDir, '_storage_')); fs.writeFileSync(path.join(f.gameDir, '_storage_', 'unknown.dll'), 'user cache');
  fs.mkdirSync(path.join(f.gameDir, 'reframework')); fs.writeFileSync(path.join(f.gameDir, 'reframework', 'user-mod.txt'), 'mod');
  const result = await f.service.prepare(f.input);
  assert.equal(result.prepared, true); assert.equal(result.loaderOwnership, 'owned'); assert.equal(result.seededConfig, true);
  assert.equal(result.gameRuntimeVerified, false); assert.equal(f.fileDigest(f.loader), OFFICIAL.dll_sha256);
  assert.deepEqual(fs.readFileSync(f.stored), current); assert.deepEqual(fs.readFileSync(f.rootConfig), current);
  assert.equal(read(f.receipt).configSeed.sha256, hash(current)); assert.equal(read(f.receipt).configSeed.policy, 'preserve-current');
  assert.equal(fs.readFileSync(path.join(f.gameDir, '_storage_', 'unknown.dll'), 'utf8'), 'user cache');
  assert.equal(fs.existsSync(journal.pendingPath(f.gameDir)), false);
  fs.writeFileSync(f.stored, '[NRBeforeSR]\nIntensity=0.8\n'); const before = fs.readFileSync(f.stored);
  assert.equal((await f.service.prepare(f.input)).seededConfig, false);
  assert.deepEqual(fs.readFileSync(f.stored), before); assert.equal(f.copies, 2);
});

test('external exact official loader and existing storage config remain byte-identical through prepare and restore', async t => {
  for (const executable of ['OnimushaWotS.exe', 're9.exe']) {
  const f = fixture(t, executable); fs.copyFileSync(f.source, f.loader); fs.mkdirSync(path.dirname(f.stored));
  const current = Buffer.from('\ufeff[NRBeforeSR]\r\nIntensity=0.7\r\n'); fs.writeFileSync(f.stored, current);
  fs.writeFileSync(f.rootConfig, '[NRBeforeSR]\nIntensity=1.8\n'); // no root receipt needed when storage already wins
  const prepared = await f.service.prepare(f.input); assert.equal(prepared.loaderOwnership, 'external'); assert.equal(f.copies, 0);
  const restored = await f.service.restore(f.input); assert.equal(restored.removedLoader, false); assert.equal(restored.externalLoaderPreserved, true);
  assert.equal(f.fileDigest(f.loader), OFFICIAL.dll_sha256); assert.deepEqual(fs.readFileSync(f.stored), current);
  assert.equal(read(f.receipt).loader.ownership, 'external');
  assert.equal(read(f.receipt).loader.originalExisted, true);
  assert.equal(read(f.receipt).adapter, executable === 're9.exe' ? 're9-reframework-01417' : 'onimusha-wots-reframework-01417');
  }
});

test('SF6 installs and restores only its loader, preserves unowned root config and never creates storage', async t => {
  const f = fixture(t, 'StreetFighter6.exe');
  const current = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[NRBeforeSR]\r\nIntensity=1.7\r\n', 'utf16le')]);
  fs.writeFileSync(f.rootConfig, current);
  const view = await f.service.inspect(f.input);
  assert.equal(view.config.effective, f.rootConfig); assert.equal(view.config.seed, null); assert.equal(view.canPrepare, true);
  const result = await f.service.prepare(f.input);
  assert.equal(result.loaderOwnership, 'owned'); assert.equal(result.seededConfig, false); assert.equal(result.effectiveConfig, f.rootConfig);
  assert.equal(f.copies, 1); assert.equal(fs.existsSync(path.dirname(f.stored)), false); assert.deepEqual(fs.readFileSync(f.rootConfig), current);
  assert.equal(read(f.receipt).configSeed, null); assert.deepEqual(read(f.receipt).mirrors, []);
  f.failPersist(); await assert.rejects(f.service.restore(f.input), { code: 'EACCES' });
  assert.equal(f.fileDigest(f.loader), OFFICIAL.dll_sha256); assert.equal(read(f.receipt).loader.ownership, 'owned');
  const restored = await f.service.restore(f.input);
  assert.equal(restored.removedLoader, true); assert.equal(fs.existsSync(f.loader), false);
  assert.deepEqual(fs.readFileSync(f.rootConfig), current); assert.equal(fs.existsSync(path.dirname(f.stored)), false);
});

test('SF6 reuses an external loader and ignores unknown storage configs and mirrors through prepare and restore', async t => {
  const f = fixture(t, 'SF6.exe'); fs.copyFileSync(f.source, f.loader);
  fs.writeFileSync(f.rootConfig, '[NRBeforeSR]\nIntensity=1.25\n');
  fs.mkdirSync(path.dirname(f.stored)); fs.writeFileSync(f.stored, 'unrelated INI');
  const mirror = path.join(path.dirname(f.stored), 'core.addon64'); fs.writeFileSync(mirror, 'unrelated Core');
  const lstat = fsp.lstat; let storageReads = 0;
  t.mock.method(fsp, 'lstat', async (file, ...args) => {
    if (String(file).toLowerCase().includes('_storage_')) { storageReads++; throw new Error('storage inaccessible'); }
    return lstat(file, ...args);
  });
  const prepared = await f.service.prepare(f.input);
  assert.equal(prepared.loaderOwnership, 'external'); assert.equal(prepared.effectiveConfig, f.rootConfig); assert.equal(f.copies, 0);
  assert.equal((await f.service.restore(f.input)).externalLoaderPreserved, true);
  assert.equal(storageReads, 0); assert.equal(fs.readFileSync(f.stored, 'utf8'), 'unrelated INI');
  assert.equal(fs.readFileSync(mirror, 'utf8'), 'unrelated Core'); assert.equal(fs.readFileSync(f.rootConfig, 'utf8'), '[NRBeforeSR]\nIntensity=1.25\n');
  assert.equal(f.fileDigest(f.loader), OFFICIAL.dll_sha256);
});

test('SF6 rejects cache ownership or mirror requests before changing its receipt or files', async t => {
  const f = fixture(t, 'StreetFighter6.exe'); await f.service.prepare(f.input);
  const before = fs.readFileSync(f.receipt), request = { rootRel: 'Core.addon64', mirrorRel: '_storage_/core.addon64', sha256: hash(Buffer.from('old')) };
  await assert.rejects(f.service.confirmMirrors(f.input, { confirm: true, mirrors: [request] }), { code: 'REF_MIRROR_UNSUPPORTED' });
  await assert.rejects(f.service.planMirrors(f.input, { operation: 'replace', files: [request] }), { code: 'REF_MIRROR_UNSUPPORTED' });
  assert.deepEqual(fs.readFileSync(f.receipt), before); assert.equal(fs.existsSync(journal.pendingPath(f.gameDir)), false);
  const corrupt = read(f.receipt); corrupt.configSeed = { rel: '_storage_/nr_before_sr.ini' }; fs.writeFileSync(f.receipt, JSON.stringify(corrupt));
  await assert.rejects(f.service.prepare(f.input), { code: 'REF_RECEIPT_INVALID' });
  await assert.rejects(f.service.restore(f.input), { code: 'REF_RECEIPT_INVALID' });
  assert.equal(f.fileDigest(f.loader), OFFICIAL.dll_sha256); assert.equal(fs.existsSync(path.dirname(f.stored)), false);
});

test('SF6 recovers its loader transaction but refuses a pending transaction that claims storage files', async t => {
  const f = fixture(t, 'StreetFighter6.exe'); await f.service.prepare(f.input);
  const script = `const fs=require('fs');const j=require(process.argv[1]);const root=process.argv[2],receipt=process.argv[3];j.transaction(root,async()=>{await j.capture(root,receipt);await j.capture(root,root+'/dinput8.dll');fs.unlinkSync(root+'/dinput8.dll');process.exit(19)});`;
  const interrupted = spawnSync(process.execPath, ['-e', script, require.resolve('../src/core/file-journal'), f.gameDir, f.receipt], { windowsHide: true, timeout: 10000 });
  assert.equal(interrupted.status, 19); assert.equal(fs.existsSync(f.loader), false);
  assert.equal((await f.service.recover(f.input)).recovered, true); assert.equal(f.fileDigest(f.loader), OFFICIAL.dll_sha256);
  fs.mkdirSync(path.dirname(f.stored)); fs.writeFileSync(f.stored, 'unrelated storage configuration');
  const unrelated = `const j=require(process.argv[1]);const root=process.argv[2];j.transaction(root,async()=>{await j.capture(root,process.argv[3]);await j.capture(root,process.argv[4]);process.exit(19)});`;
  const other = spawnSync(process.execPath, ['-e', unrelated, require.resolve('../src/core/file-journal'), f.gameDir, f.receipt, f.stored], { windowsHide: true, timeout: 10000 });
  assert.equal(other.status, 19);
  await assert.rejects(f.service.recover(f.input), { code: 'REF_RECOVERY_OTHER_TRANSACTION' });
  assert.equal(fs.readFileSync(f.stored, 'utf8'), 'unrelated storage configuration');
  assert.equal(fs.existsSync(journal.pendingPath(f.gameDir)), true);
  await journal.recover(f.gameDir);
});

test('DD2 and Wilds share the official storage lifecycle and preserve current edited configuration when reused', async t => {
  for (const executable of ['DD2.exe', 'MonsterHunterWilds.exe', 'MHWILDS.exe']) {
    const f = fixture(t, executable); f.ownedConfig();
    const root = Buffer.from('\ufeff[NRBeforeSR]\r\nIntensity=1.6\r\n'); fs.writeFileSync(f.rootConfig, root);
    const first = await f.service.prepare(f.input);
    assert.equal(first.seededConfig, true); assert.equal(first.effectiveConfig, f.stored); assert.equal(f.copies, 2);
    assert.deepEqual(fs.readFileSync(f.stored), root);
    const edited = Buffer.from('[NRBeforeSR]\nIntensity=0.4\n'); fs.writeFileSync(f.stored, edited);
    const reused = await f.service.prepare(f.input);
    assert.equal(reused.loaderOwnership, 'owned'); assert.equal(reused.seededConfig, false); assert.equal(f.copies, 2);
    assert.equal((await f.service.restore(f.input)).removedLoader, true);
    assert.deepEqual(fs.readFileSync(f.rootConfig), root); assert.deepEqual(fs.readFileSync(f.stored), edited);
  }
});

test('unknown loader, unowned INI, wrong game or changed official source never start a transaction', async t => {
  for (const kind of ['loader', 'config', 'game', 'component']) {
    const f = fixture(t); let input = f.input, code;
    if (kind === 'loader') { fs.writeFileSync(f.loader, 'external-loader'); code = 'REF_DINPUT8_CONFLICT'; }
    if (kind === 'config') { fs.writeFileSync(f.rootConfig, '[NRBeforeSR]\nIntensity=1\n'); code = 'REF_CONFIG_OWNERSHIP_REQUIRED'; }
    if (kind === 'game') { input = { ...input, engine: 'Unreal Engine' }; code = 'REF_UNSUPPORTED_TARGET'; }
    if (kind === 'component') { fs.writeFileSync(f.source, 'untrusted'); code = 'REF_COMPONENT_HASH'; }
    await assert.rejects(f.service.prepare(input), { code }); assert.equal(fs.existsSync(journal.pendingPath(f.gameDir)), false);
    assert.equal(fs.existsSync(f.receipt), false); assert.equal(f.copies, 0);
  }
});

test('copy and receipt failures roll back loader and new seed while keeping existing user files', async t => {
  for (const kind of ['copy', 'receipt']) {
    const f = fixture(t), original = Buffer.from('[NRBeforeSR]\r\nIntensity=1.4\r\n'); f.ownedConfig(original);
    fs.mkdirSync(path.join(f.gameDir, '_storage_')); const external = path.join(f.gameDir, '_storage_', 'mod.dat'); fs.writeFileSync(external, 'keep');
    if (kind === 'copy') f.failCopy(2); else f.failPersist();
    await assert.rejects(f.service.prepare(f.input), { code: kind === 'copy' ? 'EIO' : 'EACCES' });
    assert.equal(fs.existsSync(f.loader), false); assert.equal(fs.existsSync(f.stored), false); assert.equal(fs.existsSync(f.receipt), false);
    assert.deepEqual(fs.readFileSync(f.rootConfig), original); assert.equal(fs.readFileSync(external, 'utf8'), 'keep');
    assert.equal(fs.existsSync(journal.pendingPath(f.gameDir)), false);
  }
});

test('game-close recheck stops the first copy after preflight', async t => {
  const f = fixture(t); f.runAt(2); await assert.rejects(f.service.prepare(f.input), { code: 'ERR_GAME_RUNNING' });
  assert.equal(f.copies, 0); assert.equal(fs.existsSync(f.loader), false); assert.equal(fs.existsSync(f.receipt), false);
});

test('COPYFILE_EXCL EEXIST rebases only that same journal row and preserves the external file while rolling back our loader', async t => {
  for (const step of [1, 2]) {
    const f = fixture(t); f.ownedConfig(); f.collide(step);
    await assert.rejects(f.service.prepare(f.input), { code: 'REF_TARGET_APPEARED' });
    const appeared = step === 1 ? f.loader : f.stored;
    assert.equal(fs.readFileSync(appeared, 'utf8'), 'external appeared file');
    if (step === 2) assert.equal(fs.existsSync(f.loader), false);
    assert.equal(fs.existsSync(f.receipt), false); assert.equal(fs.existsSync(journal.pendingPath(f.gameDir)), false);
  }
});

test('failed EEXIST protection marker or partial snapshot preserves external target and pending; later recovery also refuses unsafe rollback', async t => {
  for (const kind of ['marker', 'snapshot']) {
    const f = fixture(t); f.collide(1, kind === 'marker', kind === 'snapshot');
    await assert.rejects(f.service.prepare(f.input), error => error.code === 'errBackendRecovery' && error.pendingPreserved === true);
    assert.equal(fs.readFileSync(f.loader, 'utf8'), 'external appeared file'); assert.equal(fs.existsSync(journal.pendingPath(f.gameDir)), true);
    await assert.rejects(f.service.recover(f.input), { code: kind === 'marker' ? 'REF_RECOVERY_TARGET_UNCONFIRMED' : 'REF_RECOVERY_PROTECTION_FAILED' });
    assert.equal(fs.readFileSync(f.loader, 'utf8'), 'external appeared file'); assert.equal(fs.existsSync(journal.pendingPath(f.gameDir)), true);
    const row = read(journal.pendingPath(f.gameDir)).files.find(item => item.rel.toLowerCase() === 'dinput8.dll');
    assert.equal(row.existed, kind === 'snapshot');
  }
});

test('owned loader restore preserves both changed configs, and failed restore keeps ownership recoverable', async t => {
  const f = fixture(t); f.ownedConfig(); await f.service.prepare(f.input);
  fs.writeFileSync(f.rootConfig, '[NRBeforeSR]\nIntensity=1.9\n'); fs.writeFileSync(f.stored, '[NRBeforeSR]\nIntensity=0.6\n');
  const root = fs.readFileSync(f.rootConfig), stored = fs.readFileSync(f.stored); f.failPersist();
  await assert.rejects(f.service.restore(f.input), { code: 'EACCES' }); assert.equal(f.fileDigest(f.loader), OFFICIAL.dll_sha256);
  assert.equal(read(f.receipt).loader.ownership, 'owned');
  const removed = await f.service.restore(f.input); assert.equal(removed.removedLoader, true); assert.equal(read(f.receipt).loader.ownership, 'released');
  assert.deepEqual(fs.readFileSync(f.rootConfig), root); assert.deepEqual(fs.readFileSync(f.stored), stored);
  await f.service.prepare(f.input); fs.writeFileSync(f.loader, 'external replacement'); const receipt = fs.readFileSync(f.receipt);
  await assert.rejects(f.service.restore(f.input), { code: 'REF_LOADER_CHANGED' }); assert.equal(fs.readFileSync(f.loader, 'utf8'), 'external replacement');
  assert.deepEqual(fs.readFileSync(f.receipt), receipt);
});

test('hardlinked target or invalid main receipt cannot authorize config seeding', async t => {
  const f = fixture(t); f.ownedConfig(); const outside = path.join(f.root, 'external.ini'); fs.linkSync(f.rootConfig, outside);
  await assert.rejects(f.service.prepare(f.input), { code: 'SETTINGS_LINK_BLOCKED' }); assert.equal(f.copies, 0); fs.unlinkSync(outside);
  const manifest = read(manifestPath(f.gameDir)); manifest.game.exe = 'Other.exe'; fs.writeFileSync(manifestPath(f.gameDir), JSON.stringify(manifest));
  await assert.rejects(f.service.prepare(f.input), { code: 'ERR_INSTALL_EXE_CHANGED' }); assert.equal(fs.existsSync(f.stored), false);
});

test('shared journal recovery restores an interrupted loader restore and refuses another installer transaction', async t => {
  const f = fixture(t); await f.service.prepare(f.input);
  const script = `const fs=require('fs');const j=require(process.argv[1]);const root=process.argv[2],receipt=process.argv[3];j.transaction(root,async()=>{await j.capture(root,receipt);await j.capture(root,root+'/dinput8.dll');fs.unlinkSync(root+'/dinput8.dll');process.exit(19)});`;
  const child = spawnSync(process.execPath, ['-e', script, require.resolve('../src/core/file-journal'), f.gameDir, f.receipt], { windowsHide: true, timeout: 10000 });
  assert.equal(child.status, 19); assert.equal(fs.existsSync(f.loader), false); assert.equal(fs.existsSync(journal.pendingPath(f.gameDir)), true);
  assert.equal((await f.service.recover(f.input)).recovered, true); assert.equal(f.fileDigest(f.loader), OFFICIAL.dll_sha256);
  const other = spawnSync(process.execPath, ['-e', `const j=require(process.argv[1]);j.transaction(process.argv[2],async()=>process.exit(19));`, require.resolve('../src/core/file-journal'), f.gameDir], { windowsHide: true, timeout: 10000 });
  assert.equal(other.status, 19); await assert.rejects(f.service.recover(f.input), { code: 'REF_RECOVERY_OTHER_TRANSACTION' });
  assert.equal(fs.existsSync(journal.pendingPath(f.gameDir)), true); await journal.recover(f.gameDir);
});

test('Core mirror is never adopted by name/hash alone; explicit ownership yields a read-only same-transaction upgrade/restore plan', async t => {
  const f = fixture(t), rootRel = 'Core.addon64', mirrorRel = '_storage_/core.addon64', before = Buffer.from('owned Core baseline');
  fs.writeFileSync(path.join(f.gameDir, rootRel), before); fs.mkdirSync(path.join(f.gameDir, '_storage_')); fs.writeFileSync(path.join(f.gameDir, mirrorRel), before);
  const manifest = f.manifest([f.row(rootRel, before, 'addon')]); await f.service.prepare(f.input);
  const nextBytes = Buffer.from('owned Core upgrade'), request = { operation: 'replace', files: [{ rootRel, sha256: hash(nextBytes) }] };
  await assert.rejects(f.service.planMirrors(f.input, request), { code: 'REF_MIRROR_UNOWNED' });
  await assert.rejects(f.service.confirmMirrors(f.input, { mirrors: [{ rootRel, mirrorRel, sha256: hash(before) }] }), { code: 'REF_MIRROR_CONFIRM_REQUIRED' });
  await f.service.confirmMirrors(f.input, { confirm: true, mirrors: [{ rootRel, mirrorRel, sha256: hash(before) }] });
  const plan = await f.service.planMirrors(f.input, request); assert.equal(plan.readonly, true); assert.equal(plan.requiresSameTransactionAsRoot, true);
  assert.equal(plan.coreFilesWritten, false); assert.ok(plan.operations[0].archive.targetRel.endsWith('.addon64.bin'));
  assert.deepEqual(fs.readFileSync(path.join(f.gameDir, mirrorRel)), before); assert.deepEqual(fs.readFileSync(path.join(f.gameDir, rootRel)), before);
  // Simulate the existing installer's future single journal, not a module Core writer.
  await journal.transaction(f.gameDir, async () => {
    const backup = path.join(f.gameDir, plan.operations[0].archive.targetRel); await journal.capture(f.gameDir, backup);
    fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.writeFileSync(backup, before);
    for (const relative of [rootRel, mirrorRel]) { const file = path.join(f.gameDir, relative); await journal.capture(f.gameDir, file); fs.writeFileSync(file, nextBytes); }
    await journal.capture(f.gameDir, manifestPath(f.gameDir)); manifest.files[0].installedSha256 = hash(nextBytes); fs.writeFileSync(manifestPath(f.gameDir), JSON.stringify(manifest));
    await journal.capture(f.gameDir, f.receipt); fs.writeFileSync(f.receipt, JSON.stringify(plan.receiptNext));
  });
  const restore = await f.service.planMirrors(f.input, { operation: 'restore', files: [{ rootRel, sha256: hash(before) }] });
  assert.equal(restore.operations[0].sourceRel, plan.operations[0].archive.targetRel); assert.deepEqual(fs.readFileSync(path.join(f.gameDir, mirrorRel)), nextBytes);
  await f.service.restore(f.input); assert.equal(read(f.receipt).mirrors.length, 1); assert.deepEqual(fs.readFileSync(path.join(f.gameDir, mirrorRel)), nextBytes);
});

test('mirror drift, a new root install ID and changed backup cannot reset confirmation or produce a replacement plan', async t => {
  const f = fixture(t), rootRel = 'Core.addon64', mirrorRel = '_storage_/core.addon64', bytes = Buffer.from('Core-v1');
  fs.writeFileSync(path.join(f.gameDir, rootRel), bytes); fs.mkdirSync(path.join(f.gameDir, '_storage_')); fs.writeFileSync(path.join(f.gameDir, mirrorRel), bytes);
  f.manifest([f.row(rootRel, bytes, 'addon')]); await f.service.prepare(f.input);
  const claim = { confirm: true, mirrors: [{ rootRel, mirrorRel, sha256: hash(bytes) }] }; await f.service.confirmMirrors(f.input, claim);
  const request = { operation: 'replace', files: [{ rootRel, sha256: hash('Core-v2') }] };
  fs.writeFileSync(path.join(f.gameDir, mirrorRel), 'user mod'); await assert.rejects(f.service.planMirrors(f.input, request), { code: 'REF_MIRROR_CHANGED' });
  await assert.rejects(f.service.confirmMirrors(f.input, claim), { code: 'REF_MIRROR_CHANGED' }); fs.writeFileSync(path.join(f.gameDir, mirrorRel), bytes);
  const originalManifest = fs.readFileSync(manifestPath(f.gameDir)); f.manifest([f.row(rootRel, bytes, 'addon')]);
  await assert.rejects(f.service.planMirrors(f.input, request), { code: 'REF_MIRROR_UNOWNED' }); fs.writeFileSync(manifestPath(f.gameDir), originalManifest);
  const backup = path.join(f.gameDir, read(f.receipt).mirrors[0].baselineRel); fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.writeFileSync(backup, 'wrong');
  await assert.rejects(f.service.planMirrors(f.input, request), { code: 'REF_MIRROR_BACKUP_CHANGED' });
});
