'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createInstaller } = require('../src/product/installer');
const { createReframeworkPreparation, RECEIPT } = require('../src/product/reframework-preparation');
const { OFFICIAL_REFRAMEWORK_01417: OFFICIAL } = require('../src/product/reframework-compatibility');
const { manifestPath } = require('../src/product/manifest');
const { PAYLOAD_FILES, INSTALLED_NAMES } = require('../src/product/constants');
const journal = require('../src/core/file-journal');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

async function fixture(t, name = 'OnimushaWotS') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-ref-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gameDir = path.join(root, 'game'), payloadDir = path.join(root, 'payload'); fs.mkdirSync(gameDir); fs.mkdirSync(payloadDir);
  const exe = path.join(gameDir, name + '.exe'); fs.writeFileSync(exe, 'fixture x64');
  const payload = {};
  for (const [kind, leaf] of Object.entries(PAYLOAD_FILES)) {
    const bytes = Buffer.from(kind === 'reshade' ? 'PE64 ReShade Searching for add-ons' : kind === 'config' ? '[NRBeforeSR]\r\nIntensity=1\r\n' : `initial-${kind}`);
    const file = path.join(payloadDir, leaf); fs.writeFileSync(file, bytes); payload[kind] = { file, name: leaf, actual: hash(bytes) };
  }
  payload.version = '0.4.6-hotfix.1'; payload.versionInfo = { id: payload.version };
  const scan = { chosen: { path: exe, rel: path.basename(exe), bitness: 64, api: 'dxgi', apiLabel: 'DirectX 12' }, primaryDlss: { name: 'nvngx_dlss.dll' } };
  const addon = path.join(gameDir, INSTALLED_NAMES.addon), mirror = path.join(gameDir, '_storage_', INSTALLED_NAMES.addon);
  const rootConfig = path.join(gameDir, INSTALLED_NAMES.config), storedConfig = path.join(gameDir, '_storage_', INSTALLED_NAMES.config), refReceipt = path.join(gameDir, RECEIPT);
  const pe = { getBitness: () => 64 }, guards = { antiCheatPresent: () => false, assertGameClosed: async () => {} };
  let transactions = 0, failMirror = false;
  const scopedJournal = { ...journal, transaction: async (dir, work) => { transactions++; return journal.transaction(dir, work); } };
  const refDigest = file => path.basename(file).toLowerCase() === 'dinput8.dll' && fs.readFileSync(file, { encoding: null, flag: 'r' }).subarray(0, 16).toString() === 'official-fixture'
    ? OFFICIAL.dll_sha256 : hash(fs.readFileSync(file));
  const installer = createInstaller({ journal: scopedJournal, pe, guards, reframeworkFileDigest: refDigest,
    scan: { async scanGame() { return scan; }, inspectReShade(dir) { const file = path.join(dir, 'dxgi.dll'); return fs.existsSync(file) ?
      { installed: true, addonSupport: fs.readFileSync(file).includes(Buffer.from('Searching for add-ons')), file: 'dxgi.dll' } : { installed: false, addonSupport: false, file: null }; } },
    async copyFile(from, to) { await fsp.copyFile(from, to); if (failMirror && path.resolve(to).toLowerCase() === mirror.toLowerCase()) {
      failMirror = false; throw Object.assign(new Error('mirror interrupted'), { code: 'EIO' }); } }
  });
  await installer.install({ gameDir, payload, scan });
  const input = { gameDir, exe, engine: 'RE Engine' };
  async function prepareRef() {
    const componentRoot = path.join(root, 'component'); fs.mkdirSync(componentRoot);
    fs.writeFileSync(path.join(componentRoot, 'component.json'), JSON.stringify(OFFICIAL));
    const source = path.join(componentRoot, 'dinput8.dll'), fd = fs.openSync(source, 'wx'); fs.writeSync(fd, Buffer.from('official-fixture')); fs.ftruncateSync(fd, OFFICIAL.dll_bytes); fs.closeSync(fd);
    fs.copyFileSync(source, path.join(gameDir, 'dinput8.dll')); fs.mkdirSync(path.dirname(mirror), { recursive: true }); fs.copyFileSync(addon, mirror);
    fs.writeFileSync(storedConfig, '\ufeff[NRBeforeSR]\r\nIntensity=0.75\r\n'); fs.writeFileSync(rootConfig, '[NRBeforeSR]\r\nIntensity=1.65\r\n');
    fs.writeFileSync(path.join(gameDir, '_storage_', 'user-mod.dll'), 'external cache');
    const service = createReframeworkPreparation({ componentRoot, overrides: { pe, guards, fileDigest: refDigest, journal: scopedJournal } });
    await service.prepare(input); return service;
  }
  function upgrade(bytes = Buffer.from('0.4.7beta Core'), trusted = []) {
    const file = path.join(payloadDir, '0.4.7beta.addon64'); fs.writeFileSync(file, bytes);
    return { ...payload, addon: { file, name: path.basename(file), actual: hash(bytes) }, version: '0.4.7beta',
      versionInfo: { id: '0.4.7beta', trustedUpgradeFrom: trusted } };
  }
  return { root, gameDir, exe, payload, scan, addon, mirror, rootConfig, storedConfig, refReceipt, installer, input, prepareRef, upgrade,
    resetTransactions() { transactions = 0; }, get transactions() { return transactions; }, failMirror() { failMirror = true; } };
}

test('0.4.7 install confirms a matching newly prepared RE mirror and updates both copies in one journal, preserving both INIs', async t => {
  const f = await fixture(t); await f.prepareRef();
  const rootConfig = fs.readFileSync(f.rootConfig), storedConfig = fs.readFileSync(f.storedConfig), old = fs.readFileSync(f.addon), payload = f.upgrade();
  f.resetTransactions(); const result = await f.installer.install({ gameDir: f.gameDir, payload, scan: f.scan });
  assert.equal(result.complete, true); assert.equal(f.transactions, 1);
  assert.deepEqual(fs.readFileSync(f.addon), fs.readFileSync(payload.addon.file)); assert.deepEqual(fs.readFileSync(f.mirror), fs.readFileSync(f.addon));
  assert.deepEqual(fs.readFileSync(f.rootConfig), rootConfig); assert.deepEqual(fs.readFileSync(f.storedConfig), storedConfig);
  const receipt = read(f.refReceipt); assert.equal(receipt.mirrors.length, 1); assert.equal(receipt.mirrors[0].sha256, payload.addon.actual);
  assert.ok(receipt.mirrors[0].baselineRel.endsWith('.addon64.bin')); assert.deepEqual(fs.readFileSync(path.join(f.gameDir, receipt.mirrors[0].baselineRel)), old);
  assert.equal(fs.readFileSync(path.join(f.gameDir, '_storage_', 'user-mod.dll'), 'utf8'), 'external cache');
});

test('SF6 Core upgrade and removal never adopt or modify an unrelated storage Core or configuration', async t => {
  const f = await fixture(t, 'StreetFighter6'); await f.prepareRef();
  fs.writeFileSync(f.mirror, 'independent user Core'); fs.writeFileSync(f.storedConfig, 'independent user INI');
  const rootIni = fs.readFileSync(f.rootConfig), receipt = fs.readFileSync(f.refReceipt);
  const payload = f.upgrade();
  await f.installer.install({ gameDir: f.gameDir, payload, scan: f.scan });
  assert.deepEqual(fs.readFileSync(f.addon), fs.readFileSync(payload.addon.file));
  assert.equal(fs.readFileSync(f.mirror, 'utf8'), 'independent user Core'); assert.deepEqual(fs.readFileSync(f.refReceipt), receipt);
  await f.installer.uninstall({ gameDir: f.gameDir, scan: f.scan });
  assert.equal(fs.existsSync(f.addon), false); assert.equal(fs.readFileSync(f.mirror, 'utf8'), 'independent user Core');
  assert.equal(fs.readFileSync(f.storedConfig, 'utf8'), 'independent user INI'); assert.deepEqual(fs.readFileSync(f.rootConfig), rootIni);
  assert.deepEqual(fs.readFileSync(f.refReceipt), receipt); assert.equal(read(f.refReceipt).configSeed, null); assert.deepEqual(read(f.refReceipt).mirrors, []);
});

test('DD2 and Wilds use the same journal for Core mirror upgrade and uninstall', async t => {
  for (const name of ['DD2', 'MonsterHunterWilds']) {
    const f = await fixture(t, name); await f.prepareRef(); const payload = f.upgrade(); f.resetTransactions();
    await f.installer.install({ gameDir: f.gameDir, payload, scan: f.scan });
    assert.equal(f.transactions, 1); assert.deepEqual(fs.readFileSync(f.mirror), fs.readFileSync(payload.addon.file));
    assert.equal(read(f.refReceipt).mirrors.length, 1);
    f.resetTransactions(); await f.installer.uninstall({ gameDir: f.gameDir, scan: f.scan });
    assert.equal(f.transactions, 1); assert.equal(fs.existsSync(f.addon), false); assert.equal(fs.existsSync(f.mirror), false);
    assert.deepEqual(read(f.refReceipt).mirrors, []);
  }
});

test('known owner-installed Core hash may replace a stale receipt only for explicit 0.4.7 metadata and gets a version backup', async t => {
  const f = await fixture(t, 'DS1'), owner = Buffer.from('owner verified dev16'); fs.writeFileSync(f.addon, owner);
  const next = f.upgrade(Buffer.from('0.4.7 release'), [hash(owner)]);
  await assert.rejects(f.installer.install({ gameDir: f.gameDir, scan: f.scan, payload: { ...next, version: '0.4.6-hotfix.1' } }), { code: 'ERR_FILE_CHANGED' });
  await assert.rejects(f.installer.install({ gameDir: f.gameDir, scan: f.scan, payload: { ...next, versionInfo: { trustedUpgradeFrom: [] } } }), { code: 'ERR_FILE_CHANGED' });
  const result = await f.installer.install({ gameDir: f.gameDir, scan: f.scan, payload: next }); assert.equal(result.complete, true);
  const manifest = read(manifestPath(f.gameDir)), accepted = manifest.trustedCoreUpgrades[0];
  assert.equal(accepted.fromSha256, hash(owner)); assert.equal(accepted.version, '0.4.7beta'); assert.ok(accepted.backupRel.endsWith('.bin'));
  assert.deepEqual(fs.readFileSync(path.join(f.gameDir, accepted.backupRel)), owner);
  assert.equal(manifest.files.find(row => row.kind === 'addon').installedSha256, next.addon.actual);
});

test('trusted current root and matching first-seen mirror are both backed up before upgrade; other DLL drift remains blocked', async t => {
  const f = await fixture(t); await f.prepareRef(); const owner = Buffer.from('owner confirmed Core');
  fs.writeFileSync(f.addon, owner); fs.writeFileSync(f.mirror, owner);
  const payload = f.upgrade(Buffer.from('new Core'), [hash(owner)]), bridge = path.join(f.gameDir, INSTALLED_NAMES.bridge);
  fs.writeFileSync(bridge, owner);
  await assert.rejects(f.installer.install({ gameDir: f.gameDir, payload, scan: f.scan }), { code: 'ERR_FILE_CHANGED' });
  assert.deepEqual(fs.readFileSync(f.addon), owner); assert.equal(read(f.refReceipt).mirrors.length, 0);
  fs.copyFileSync(f.payload.bridge.file, bridge);
  await f.installer.install({ gameDir: f.gameDir, payload, scan: f.scan });
  assert.deepEqual(fs.readFileSync(f.mirror), fs.readFileSync(payload.addon.file));
  const mirror = read(f.refReceipt).mirrors[0]; assert.equal(mirror.baselineSha256, hash(owner));
});

test('unknown or independently drifted mirror blocks before root mutation and cannot be reset through reinstall', async t => {
  const f = await fixture(t); const ref = await f.prepareRef(), before = fs.readFileSync(f.addon), payload = f.upgrade();
  fs.writeFileSync(f.mirror, 'unowned mod');
  await assert.rejects(f.installer.install({ gameDir: f.gameDir, payload, scan: f.scan }), { code: 'REF_MIRROR_UNOWNED' });
  assert.deepEqual(fs.readFileSync(f.addon), before); assert.equal(fs.readFileSync(f.mirror, 'utf8'), 'unowned mod');
  fs.writeFileSync(f.mirror, before);
  await ref.confirmMirrors(f.input, { confirm: true, mirrors: [{ rootRel: INSTALLED_NAMES.addon, mirrorRel: `_storage_/${INSTALLED_NAMES.addon}`, sha256: hash(before) }] });
  fs.writeFileSync(f.mirror, 'externally changed');
  await assert.rejects(f.installer.install({ gameDir: f.gameDir, payload, scan: f.scan }), { code: 'REF_MIRROR_CHANGED' });
  await assert.rejects(f.installer.uninstall({ gameDir: f.gameDir, scan: f.scan }), { code: 'REF_MIRROR_CHANGED' });
  assert.deepEqual(fs.readFileSync(f.addon), before); assert.ok(fs.existsSync(manifestPath(f.gameDir)));
});

test('mirror copy failure rolls back trusted root upgrade, both receipts, mirror and new backups as one journal', async t => {
  const f = await fixture(t); await f.prepareRef(); const old = Buffer.from('owner verified changed Core');
  fs.writeFileSync(f.addon, old); fs.writeFileSync(f.mirror, old);
  const main = fs.readFileSync(manifestPath(f.gameDir)), ref = fs.readFileSync(f.refReceipt), rootIni = fs.readFileSync(f.rootConfig), storedIni = fs.readFileSync(f.storedConfig);
  f.failMirror(); f.resetTransactions();
  await assert.rejects(f.installer.install({ gameDir: f.gameDir, payload: f.upgrade(Buffer.from('new'), [hash(old)]), scan: f.scan }), { code: 'EIO' });
  assert.equal(f.transactions, 1); assert.deepEqual(fs.readFileSync(f.addon), old); assert.deepEqual(fs.readFileSync(f.mirror), old);
  assert.deepEqual(fs.readFileSync(manifestPath(f.gameDir)), main); assert.deepEqual(fs.readFileSync(f.refReceipt), ref);
  assert.deepEqual(fs.readFileSync(f.rootConfig), rootIni); assert.deepEqual(fs.readFileSync(f.storedConfig), storedIni);
  assert.equal(fs.existsSync(journal.pendingPath(f.gameDir)), false);
});

test('uninstall removes owned root/mirror together while retaining REF, unknown cache and current root/storage settings', async t => {
  const f = await fixture(t); await f.prepareRef(); await f.installer.install({ gameDir: f.gameDir, payload: f.upgrade(), scan: f.scan });
  const rootIni = fs.readFileSync(f.rootConfig), storedIni = fs.readFileSync(f.storedConfig); f.resetTransactions();
  const result = await f.installer.uninstall({ gameDir: f.gameDir, scan: f.scan, removeSettings: true });
  assert.equal(result.removed, true); assert.equal(result.settingsKept, true); assert.equal(f.transactions, 1); assert.equal(result.reframeworkMirrors.length, 1);
  assert.equal(fs.existsSync(f.addon), false); assert.equal(fs.existsSync(f.mirror), false); assert.equal(read(f.refReceipt).mirrors.length, 0);
  assert.deepEqual(fs.readFileSync(f.rootConfig), rootIni); assert.deepEqual(fs.readFileSync(f.storedConfig), storedIni);
  assert.ok(fs.existsSync(path.join(f.gameDir, 'dinput8.dll'))); assert.equal(fs.readFileSync(path.join(f.gameDir, '_storage_', 'user-mod.dll'), 'utf8'), 'external cache');
});

test('uninstall restores an original Core to both paths, and a mirror restore failure rolls the whole removal back', async t => {
  const f = await fixture(t); await f.prepareRef(); const original = Buffer.from('pre-manager original Core'), manifest = read(manifestPath(f.gameDir));
  const originalRel = '_DLSS5_Backup/original-core.bin'; fs.writeFileSync(path.join(f.gameDir, originalRel), original);
  const row = manifest.files.find(item => item.kind === 'addon'); row.original = { existed: true, backupRel: originalRel, sha256: hash(original) };
  fs.writeFileSync(manifestPath(f.gameDir), JSON.stringify(manifest)); await f.installer.install({ gameDir: f.gameDir, payload: f.upgrade(), scan: f.scan });
  const active = fs.readFileSync(f.addon), currentManifest = fs.readFileSync(manifestPath(f.gameDir)), receipt = fs.readFileSync(f.refReceipt); f.failMirror();
  await assert.rejects(f.installer.uninstall({ gameDir: f.gameDir, scan: f.scan }), { code: 'EIO' });
  assert.deepEqual(fs.readFileSync(f.addon), active); assert.deepEqual(fs.readFileSync(f.mirror), active);
  assert.deepEqual(fs.readFileSync(manifestPath(f.gameDir)), currentManifest); assert.deepEqual(fs.readFileSync(f.refReceipt), receipt);
  const removed = await f.installer.uninstall({ gameDir: f.gameDir, scan: f.scan }); assert.equal(removed.removed, true);
  assert.deepEqual(fs.readFileSync(f.addon), original); assert.deepEqual(fs.readFileSync(f.mirror), original);
});

test('upgradeAddon uses the same mirror transaction and only explicit trusted 0.4.7 version metadata', async t => {
  const f = await fixture(t); await f.prepareRef(); const owner = Buffer.from('known dev15'); fs.writeFileSync(f.addon, owner); fs.writeFileSync(f.mirror, owner);
  const payload = f.upgrade(Buffer.from('new imported paired Core'), [hash(owner)]);
  const addon = { id: '0.4.7beta', file: payload.addon.file, addonSha256: payload.addon.actual, versionInfo: payload.versionInfo };
  f.resetTransactions(); const result = await f.installer.upgradeAddon({ gameDir: f.gameDir, addon, version: '0.4.7beta', scan: f.scan });
  assert.equal(result.complete, true); assert.equal(f.transactions, 1); assert.deepEqual(fs.readFileSync(f.mirror), fs.readFileSync(payload.addon.file));
});
