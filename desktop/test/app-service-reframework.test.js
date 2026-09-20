'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppService } = require('../src/product/app-service');
const { newManifest, manifestPath } = require('../src/product/manifest');
const { createCompactBundle } = require('../src/product/payload');

function fixture(t, name = 'OnimushaWotS.exe') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-app-ref-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = path.join(root, 'resources/payload/nr-before-sr');
  for (const family of ['RTX40', 'RTX50']) {
    const fixed = path.join(payload, 'fixed', family); fs.mkdirSync(fixed, { recursive: true });
    for (const name of ['ReShade64.dll', 'nrchain_nvngx.dll', 'nvngx_dlssnr.dll']) fs.writeFileSync(path.join(fixed, name), 'fixture payload');
  }
  const versionDir = path.join(payload, 'versions/0.4.7beta'); fs.mkdirSync(versionDir, { recursive: true });
  for (const name of ['nr-before-sr.zh-CN.addon64', 'nr_before_sr.ini']) fs.writeFileSync(path.join(versionDir, name), 'fixture version');
  fs.writeFileSync(path.join(payload, 'bundle.json'), JSON.stringify(createCompactBundle(payload, [{ id: '0.4.7beta' }], '0.4.7beta')));
  const gameDir = path.join(root, 'game'), storage = path.join(gameDir, '_storage_');
  fs.mkdirSync(storage, { recursive: true });
  const exe = path.join(gameDir, name); fs.writeFileSync(exe, 'fixture exe');
  const config = '[NRBeforeSR]\nStyle=1\nIntensity=1.7\nWorkMode=2\n';
  fs.writeFileSync(path.join(gameDir, 'nr_before_sr.ini'), config);
  fs.writeFileSync(path.join(storage, 'nr_before_sr.ini'), config.replace('Style=1', 'Style=2'));
  fs.writeFileSync(path.join(gameDir, 'ReShade.ini'), '[INPUT]\nKeyOverlay=36,0,0,0\n');
  const manifest = newManifest(gameDir, exe, 'dx12'); manifest.payloadVersion = '0.4.7beta';
  const coreName = 'nr-before-sr.zh-CN.addon64', coreBytes = Buffer.from('synthetic installed 0.4.7 Core');
  fs.writeFileSync(path.join(gameDir, coreName), coreBytes);
  manifest.files.push({ rel: coreName, kind: 'addon', installedSha256: require('node:crypto').createHash('sha256').update(coreBytes).digest('hex'), original: { existed: false } });
  fs.mkdirSync(path.dirname(manifestPath(gameDir)), { recursive: true });
  fs.writeFileSync(manifestPath(gameDir), JSON.stringify(manifest));
  const chosen = { path: exe, name, bitness: 64, api: 'dx12', apiResolution: { api: 'dx12' } };
  const game = { id: 'ref-game', name: 'Fixture RE game', dir: gameDir, installed: true, supported: true,
    scan: { gameDir, chosen, exeCandidates: [chosen], dlssFiles: [], reshade: { installed: true } } };
  let refState = { matched: true, canPrepare: true, ready: true, loader: { exists: true },
    config: { effective: path.join(storage, 'nr_before_sr.ini'), existingStoragePreferred: true }, blockers: [] };
  const calls = [], order = []; let preparationFailure = null;
  const reframework = Object.fromEntries(['inspect', 'prepare', 'restore', 'recover'].map(action => [action, async input => {
    order.push(action); if (action === 'prepare' && preparationFailure) throw preparationFailure;
    calls.push([action, input]); return action === 'inspect' ? refState : { [action]: true };
  }]));
  const installer = {
    install: async () => { order.push('native-install'); return { installed: true }; },
    repair: async () => { order.push('native-repair'); return { repaired: true }; },
    uninstall: async () => { order.push('native-uninstall'); return { removed: true }; },
    diagnose: async () => ({ complete: true, components: [] })
  };
  const service = createAppService({ userData: path.join(root, 'user'), resourcesPath: path.join(root, 'resources'), appDir: root,
    overrides: { library: { scanAll: async () => [game], dispose() {} }, reframework, installer,
      detectGpu: () => ({ family: 'RTX50', series: ['RTX50'] }), vulkan: { summary: () => ({ installed: false, available: false }) } } });
  return { root, gameDir, storage, exe, service, calls, order, setState(value) { refState = value; }, failPreparation(error) { preparationFailure = error; }, setEngine(value) { game.engine = value; } };
}

test('REFramework actions bind only the exact supported root executable', async t => {
  const f = fixture(t); const boot = await f.service.boot();
  assert.equal(boot.games[0].reframework.matched, true);
  await f.service.readReframework('ref-game'); await f.service.prepareReframework('ref-game');
  await f.service.restoreReframework('ref-game'); await f.service.recoverReframework('ref-game');
  assert.deepEqual(f.calls.map(row => row[0]), ['inspect', 'prepare', 'restore', 'recover']);
  for (const [, input] of f.calls) assert.deepEqual(input, { gameDir: f.gameDir, exe: f.exe, engine: 're-engine' });
  const other = fixture(t, 'Other.exe'); assert.equal((await other.service.boot()).games[0].reframework, undefined);
  assert.equal((await other.service.readReframework('ref-game')).matched, false);
  await assert.rejects(other.service.prepareReframework('ref-game'), { code: 'REF_UNSUPPORTED_TARGET' });
  assert.deepEqual(other.calls, []);
  const re9 = fixture(t, 're9.exe'); const re9Boot = await re9.service.boot();
  assert.equal(re9Boot.games[0].reframework.profile, 're9-reframework-01417');
  await re9.service.prepareReframework('ref-game');
  assert.deepEqual(re9.calls[0][1], { gameDir: re9.gameDir, exe: re9.exe, engine: 're-engine' });
  const noEvidence = fixture(t, 're9.exe'); noEvidence.setEngine(null);
  assert.equal((await noEvidence.service.boot()).games[0].reframework, undefined, 'a familiar EXE without independent engine evidence cannot authorize new compatibility preparation');
});

test('REFramework NR edits and 0.4.7 defaults target the effective storage INI and preserve root settings', async t => {
  const f = fixture(t); await f.service.boot();
  const rootBefore = fs.readFileSync(path.join(f.gameDir, 'nr_before_sr.ini'));
  assert.equal((await f.service.readNrSettings('ref-game')).Style, 2);
  await f.service.writeNrSettings('ref-game', { Style: 1 });
  assert.match(fs.readFileSync(path.join(f.storage, 'nr_before_sr.ini'), 'utf8'), /Style=1/);
  await f.service.applyDefault('ref-game');
  assert.equal((await f.service.readNrSettings('ref-game')).Intensity, 1.2);
  assert.equal((await f.service.readNrSettings('ref-game')).coreIdentity.identityStatus, 'verified');
  assert.deepEqual(fs.readFileSync(path.join(f.gameDir, 'nr_before_sr.ini')), rootBefore);
  await f.service.writeGameHotkey('ref-game', 'reshade', { key: 187, ctrl: true, shift: false, alt: false });
  assert.equal((await f.service.readGameHotkeys('ref-game')).reshade.key, 187);
  assert.equal(fs.existsSync(path.join(f.storage, 'ReShade.ini')), false);
  fs.writeFileSync(path.join(f.storage, 'nr-before-sr.log'), 'REF_EFFECTIVE_RUNTIME_LOG\n');
  assert.match((await f.service.collectFeedback('ref-game')).text, /REF_EFFECTIVE_RUNTIME_LOG/);
  f.setState({ loader: { exists: true }, canPrepare: false, blockers: [{ code: 'REF_TEST_CONFLICT', message: '兼容文件冲突' }] });
  await assert.rejects(f.service.writeNrSettings('ref-game', { Style: 2 }), { code: 'REF_TEST_CONFLICT' });
});

test('an interrupted REFramework operation exposes the dedicated recovery route', async t => {
  const f = fixture(t); await f.service.boot();
  fs.writeFileSync(path.join(f.gameDir, '_DLSS5_Backup', 'pending-switch.json'), JSON.stringify({ files: [
    { rel: '_DLSS5_Backup/reframework-preparation.json' }
  ] }));
  assert.equal((await f.service.readReframework('ref-game')).needsRecovery, true);
  await f.service.recoverReframework('ref-game');
  assert.deepEqual(f.calls.map(row => row[0]), ['recover']);
});

test('an active REFramework Core mirror cannot borrow the root Core identity after its bytes diverge', async t => {
  const f = fixture(t); await f.service.boot();
  const core = 'nr-before-sr.zh-CN.addon64', mirror = path.join(f.storage, core);
  fs.copyFileSync(path.join(f.gameDir, core), mirror);
  const same = await f.service.readNrSettings('ref-game');
  assert.equal(same.coreIdentity.identityStatus, 'verified'); assert.equal(same.coreIdentity.corePath, mirror);
  fs.writeFileSync(mirror, 'different synthetic cached Core');
  const changed = await f.service.readNrSettings('ref-game');
  assert.equal(changed.coreIdentity.identityStatus, 'changed'); assert.equal(changed.contract.known, false);
  const before = fs.readFileSync(path.join(f.storage, 'nr_before_sr.ini'));
  await assert.rejects(f.service.applyDefault('ref-game'), { code: 'ERR_BAD_REQUEST' });
  assert.deepEqual(fs.readFileSync(path.join(f.storage, 'nr_before_sr.ini')), before);
});

test('one-click install prepares detected REFramework automatically and existing upgrades prepare ownership first', async t => {
  const fresh = fixture(t); fs.unlinkSync(manifestPath(fresh.gameDir)); await fresh.service.boot();
  const result = await fresh.service.install('ref-game', { version: '0.4.7beta' });
  assert.equal(result.installed, true); assert.equal(result.reframework.ready, true);
  assert.deepEqual(fresh.order, ['native-install', 'prepare']);
  const existing = fixture(t); await existing.service.boot();
  const repaired = await existing.service.repair('ref-game', { version: '0.4.7beta' });
  assert.equal(repaired.repaired, true); assert.equal(repaired.reframework.automatic, true);
  assert.deepEqual(existing.order, ['prepare', 'native-repair', 'prepare']);
  existing.order.length = 0; await existing.service.uninstall('ref-game');
  assert.deepEqual(existing.order, ['native-uninstall'], 'uninstall must not reinstall a compatibility loader');
});

test('automatic compatibility failure preserves the completed native result and exposes the exact error', async t => {
  const f = fixture(t); fs.unlinkSync(manifestPath(f.gameDir)); await f.service.boot();
  f.failPreparation(Object.assign(new Error('兼容文件被占用'), { code: 'REF_TARGET_BUSY' }));
  const result = await f.service.install('ref-game', { version: '0.4.7beta' });
  assert.equal(result.installed, true); assert.equal(result.reframework.ready, false);
  assert.equal(result.reframework.error.code, 'REF_TARGET_BUSY');
  assert.deepEqual(f.order, ['native-install', 'prepare']);
});
