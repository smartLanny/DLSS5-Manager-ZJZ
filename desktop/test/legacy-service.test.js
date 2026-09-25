'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLegacyService, localLayout, configure, RECEIPT, PENDING } = require('../src/product/legacy-service');
const catalog = require('../src/product/legacy-runtime-catalog');
const { DEFAULTS } = require('../src/product/legacy-runtime');
const { fingerprint } = require('../src/product/feeder-runtime');
const { getIni } = require('../src/product/launch-ini');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const exists = file => fs.existsSync(file);

function fixture(t, controls = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-owner-beta3-')), gameRoot = path.join(root, 'Game'), dir = path.join(gameRoot, 'Bin');
  fs.mkdirSync(dir, { recursive: true }); const exe = path.join(dir, 'Game.exe');
  const exeBytes = Buffer.alloc(0x500), wide = controls.bitness !== 32;
  exeBytes.write('MZ'); exeBytes.writeUInt32LE(0x80, 0x3c); exeBytes.write('PE\0\0', 0x80);
  exeBytes.writeUInt16LE(wide ? 0x8664 : 0x14c, 0x84); exeBytes.writeUInt16LE(1, 0x86);
  exeBytes.writeUInt16LE(wide ? 0xf0 : 0xe0, 0x94); exeBytes.writeUInt16LE(wide ? 0x20b : 0x10b, 0x98);
  exeBytes.write('fixture game EXE; data only, never executed', 0x300); fs.writeFileSync(exe, exeBytes);
  const game = { id: 'fixture-game', dir: gameRoot, scan: { chosen: { path: exe, bitness: controls.bitness || 64, apiResolution: { api: controls.api || 'dx11' } } } };
  const pool = path.join(root, 'pool'); fs.mkdirSync(pool); const accepted = new Set(), state = { version: 'fixture-v1', running: false, offline: false, ...controls };
  const runtime = {
    root: pool,
    load(input) {
      if (state.offline) throw Object.assign(new Error('pool unavailable'), { code: 'POOL_OFFLINE' });
      const selection = catalog.resolve(input); if (selection.deliveryBlocked) throw Object.assign(new Error('blocked wrapper'), { code: 'LEGACY_COMPONENT_DELIVERY_BLOCKED' });
      const files = [], host = selection.hostRequired, prefix = host ? 'host64/addons/' : '';
      const add = (base, target, role, mutable = false, text = role + state.version) => {
        const source = `${state.version}/${role}-${selection.architecture}-${files.length}.bin`, file = path.join(pool, source), content = Buffer.from(text);
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
        files.push({ base, target, role, mutable, source, sha256: hash(content), bytes: content.length, architecture: mutable ? null : 'x64' });
      };
      if (selection.gameApi === 'dx9') {
        add('game', 'd3d9.dll', 'api-wrapper'); add('runtime', selection.architecture === 'x86' ? 'ReShade32.dll' : 'ReShade64.dll', 'game-loader');
      } else if (selection.loadingBackend === 'local') add('game', selection.proxyEntry + '.dll', 'game-loader');
      add('addon', selection.architecture === 'x86' ? 'dlss5-feed.addon32' : 'dlss5-feed.addon64', 'provider');
      if (host) { add('addon', 'host64/dlss5-feed-host64.exe', 'host'); add('addon', 'host64/dxgi.dll', 'host-loader'); }
      add('addon', prefix + 'core.addon64', 'core'); add('addon', prefix + 'nrchain_nvngx.dll', 'chain'); add('addon', prefix + 'nvngx_dlssnr.dll', 'nr-runtime');
      add('addon', prefix + 'nr_before_sr.ini', 'core-config', true, '[NRBeforeSR]\nIntensity=1.2\n');
      add('runtime', 'ReShadePreset.ini', 'preset', true, 'Techniques=vort_MotionEffects@vort_Motion.fx,DLSS5_Feed@DLSS5_Feed.fx\n');
      add('runtime', 'reshade-shaders/Shaders/DLSS5_Feed.fx', 'shader');
      add('runtime', 'reshade-shaders/Textures/fixture.png', 'texture');
      const recipe = { ...selection, schema: 2, selection: { api: input.api, architecture: input.architecture, hardwareFamily: input.hardwareFamily,
        loadingBackend: input.loadingBackend || 'local', proxyEntry: input.proxyEntry || 'auto' }, coreVersion: state.version, coreVariant: 'external-v1', files, defaults: DEFAULTS };
      const id = fingerprint(recipe); accepted.add(id); return { root: pool, recipe, fingerprint: id };
    },
    validate(recipe) { assert.equal(fingerprint(recipe), this.load(recipe.selection).fingerprint); return recipe; },
    validateStored(recipe) { if (!accepted.has(fingerprint(recipe))) throw Object.assign(new Error('untrusted stored recipe'), { code: 'LEGACY_RECEIPT_INVALID' }); return recipe; },
    async verify(value) {
      const pkg = value?.recipe ? value : this.load(value); this.validateStored(pkg.recipe);
      for (const item of pkg.recipe.files) {
        const source = path.join(pkg.root, item.source);
        if (!fs.existsSync(source) || hash(fs.readFileSync(source)) !== item.sha256)
          throw Object.assign(new Error('pinned source unavailable'), { code: 'LEGACY_PACKAGE_HASH' });
      }
      return pkg;
    }
  };
  const original = '\uFEFF; my settings\r\n[ADDON]\r\nAddonPath=.\\personal-addons\r\n[GENERAL]\r\nPresetPath=.\\my-preset.ini\r\n' +
    'EffectSearchPaths=.\\my-shaders\\**\r\nPreprocessorDefinitions=USER_QUALITY=3,V_MV_MODE=9\r\n[STYLE]\r\nHdrOverlayBrightness=180\r\n';
  fs.writeFileSync(path.join(dir, 'ReShade.ini'), original); fs.writeFileSync(path.join(dir, 'my-preset.ini'), 'Techniques=UserEffect');
  const options = { appDir: root, hardware: { family: 'RTX50' }, runtime, pe: { getBitness: () => controls.bitness || 64 },
    guards: { assertGameClosed: async () => { if (state.running) throw Object.assign(new Error('game running'), { code: 'GAME_RUNNING' }); }, antiCheatPresent: () => false },
    broker: { inspect: async () => ({ launchable: true, elevated: false }), launch: async () => ({ pid: 4018 }) },
    getLayout: () => state.layout, ...controls.options };
  const service = createLegacyService(options), layout = localLayout(game);
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, gameRoot, dir, exe, game, pool, original, runtime, state, options, service, layout,
    receipt: path.join(gameRoot, RECEIPT), pending: path.join(gameRoot, PENDING) };
}

test('waiting source verification pins the legacy recipe and never touches a running game', async t => {
  const f = fixture(t); f.state.running = true;
  const verified = await f.service.verifySource(f.game); assert.equal(verified.ready, true); assert.equal(verified.coreVersion, f.state.version);
  assert.equal(exists(f.receipt), false); assert.equal(exists(f.pending), false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.original);
  f.state.offline = true; await assert.rejects(f.service.verifySource(f.game), { code: 'POOL_OFFLINE' });
  assert.equal(exists(f.layout.addonDirectory), false);
});

test('legacy transactions consume the verified shared-runtime path without changing receipt identity', async t => {
  const f = fixture(t), shared = path.join(f.root, 'shared-dlc', 'runtime.dll');
  f.runtime.verify = async value => {
    const pkg = value?.recipe ? value : f.runtime.load(value), spec = pkg.recipe.files.find(row => row.role === 'nr-runtime');
    f.runtime.validateStored(pkg.recipe);
    const original = path.join(pkg.root, spec.source); fs.mkdirSync(path.dirname(shared), { recursive: true });
    if (exists(original)) { fs.copyFileSync(original, shared); fs.unlinkSync(original); }
    for (const item of pkg.recipe.files) assert.equal(hash(fs.readFileSync(item === spec ? shared : path.join(pkg.root, item.source))), item.sha256);
    return { ...pkg, sources: { [spec.source]: shared } };
  };
  const preview = await f.service.previewInstall(f.game);
  assert.equal(exists(f.receipt), false, 'preview cannot deploy the shared file');
  await f.service.install(f.game, { expectedPlanId: preview.planId });
  const saved = f.service.receipt(f.game), spec = saved.recipe.files.find(row => row.role === 'nr-runtime');
  const target = saved.files.find(row => row.role === 'nr-runtime').path;
  assert.equal(hash(fs.readFileSync(target)), spec.sha256); assert.equal(exists(path.join(f.pool, spec.source)), false);
  assert.equal(JSON.stringify(saved.recipe).includes(shared), false, 'portable ownership does not persist component-library paths');
  await f.service.restore(f.game); assert.equal(exists(target), false); assert.equal(exists(shared), true);
  assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.original);
});

test('local legacy owner previews without writes, installs full matching recipe, repairs pins and restores borrowed config', async t => {
  const f = fixture(t), config = path.join(f.layout.addonDirectory, 'nr_before_sr.ini'); fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, '[NRBeforeSR]\nIntensity=1.91\nPersonal=1\n'); const originalConfig = fs.readFileSync(config);
  const preview = await f.service.previewInstall(f.game); assert.equal(exists(f.receipt), false); assert.equal(exists(f.pending), false);
  assert.equal(preview.changes.find(row => row.path === config).action, 'keep');
  await f.service.install(f.game, { expectedPlanId: preview.planId }); assert.equal((await f.service.inspect(f.game)).ready, true);
  assert.equal(getIni(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), 'INPUT', 'KeyOverlay'), '36,0,0,0');
  const provider = path.join(f.layout.addonDirectory, 'dlss5-feed.addon64'); fs.unlinkSync(provider);
  const repair = await f.service.previewInstall(f.game); await f.service.install(f.game, { expectedPlanId: repair.planId });
  assert.equal(exists(provider), true); assert.deepEqual(fs.readFileSync(config), originalConfig);
  const removed = await f.service.restore(f.game); assert.equal(removed.restored, true); assert.deepEqual(fs.readFileSync(config), originalConfig);
  assert.equal(exists(provider), false); assert.equal(exists(path.join(f.dir, 'dxgi.dll')), false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.original); assert.equal(exists(f.receipt), false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'my-preset.ini'), 'utf8'), 'Techniques=UserEffect');
});

test('shared INI restore removes only feeder deltas and preserves subsequent settings from other owners', async t => {
  const f = fixture(t), preview = await f.service.previewInstall(f.game); await f.service.install(f.game, { expectedPlanId: preview.planId });
  const file = path.join(f.dir, 'ReShade.ini'), text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace('USER_QUALITY=3', 'USER_QUALITY=5,OTHER_OWNER=1') + '[OTHER_OWNER]\r\nKeep=42\r\n');
  const result = await f.service.restore(f.game); assert.equal(result.restored, true); const restored = fs.readFileSync(file, 'utf8');
  assert.match(restored, /OTHER_OWNER=1/); assert.match(restored, /Keep=42/); assert.match(restored, /USER_QUALITY=5/);
  assert.equal(getIni(restored, 'GENERAL', 'PresetPath'), '.\\my-preset.ini');
  assert.equal(getIni(restored, 'GENERAL', 'PreprocessorDefinitions').includes('DLSS5_MV_PROVIDER='), false);
  assert.equal(getIni(restored, 'GENERAL', 'PreprocessorDefinitions').includes('V_MV_MODE=9'), true);
});

test('recipe update repairs from unchanged old sources without upgrading, rejects missing old sources, and restores offline', async t => {
  const f = fixture(t); await f.service.install(f.game); const saved = fs.readFileSync(f.receipt), provider = path.join(f.layout.addonDirectory, 'dlss5-feed.addon64');
  const oldBytes = fs.readFileSync(provider); f.state.version = 'fixture-v2';
  fs.unlinkSync(provider);
  const repair = await f.service.previewInstall(f.game);
  await f.service.install(f.game, { expectedPlanId: repair.planId });
  assert.deepEqual(fs.readFileSync(provider), oldBytes);
  await assert.rejects(f.service.previewInstall(f.game, { api: 'dx12' }), { code: 'LEGACY_RESTORE_FIRST' });
  assert.deepEqual(f.service.receipt(f.game).recipe, JSON.parse(saved).recipe);
  assert.equal(f.service.receipt(f.game).recipeFingerprint, JSON.parse(saved).recipeFingerprint);
  assert.deepEqual(fs.readFileSync(provider), oldBytes);
  const source = f.service.receipt(f.game).recipe.files.find(row => row.role === 'provider').source;
  fs.unlinkSync(path.join(f.pool, source));
  await assert.rejects(f.service.previewInstall(f.game), { code: 'LEGACY_PACKAGE_HASH' });
  f.state.offline = true; assert.equal((await f.service.restore(f.game)).restored, true); assert.equal(exists(provider), false);
});

test('stale preview and unknown destination stop before a journal and retain exact existing bytes', async t => {
  const f = fixture(t), preview = await f.service.previewInstall(f.game), provider = path.join(f.layout.addonDirectory, 'dlss5-feed.addon64');
  fs.mkdirSync(path.dirname(provider), { recursive: true }); fs.writeFileSync(provider, 'later external module');
  await assert.rejects(f.service.install(f.game, { expectedPlanId: preview.planId }), { code: 'LEGACY_PLAN_CHANGED' });
  assert.equal(exists(f.pending), false); assert.equal(exists(f.receipt), false); assert.equal(fs.readFileSync(provider, 'utf8'), 'later external module');
  await assert.rejects(f.service.previewInstall(f.game), { code: 'LEGACY_FILE_CHANGED' });
});

test('earliest interrupted copy has a complete owner WAL and restart rolls it back without touching peer receipts', async t => {
  const f = fixture(t, { options: { afterWrite: ({ index }) => { if (index === 0) throw Object.assign(new Error('fixture interruption'), { preservePending: true }); } } });
  const peer = path.join(f.gameRoot, '_DLSS5_Backup', 'another-owner.json'); fs.mkdirSync(path.dirname(peer), { recursive: true }); fs.writeFileSync(peer, 'other owner');
  const preview = await f.service.previewInstall(f.game); await assert.rejects(f.service.install(f.game, { expectedPlanId: preview.planId }), /fixture interruption/);
  const wal = JSON.parse(fs.readFileSync(f.pending)); assert.equal(wal.product, 'xiaofeng-feeder-0151'); assert.equal(wal.files.at(-1).role, 'receipt');
  const restarted = createLegacyService({ ...f.options, afterWrite: undefined }); assert.equal((await restarted.recover(f.game)).recovered, true);
  assert.equal(exists(f.pending), false); assert.equal(exists(f.receipt), false); assert.equal(exists(path.join(f.dir, 'dxgi.dll')), false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.original); assert.equal(fs.readFileSync(peer, 'utf8'), 'other owner');
});

test('recovery rejects altered snapshots, other targets and newer external files while keeping recovery state', async t => {
  for (const variant of ['snapshot', 'target', 'replacement']) {
    const f = fixture(t, { options: { afterWrite: () => { throw Object.assign(new Error('fixture interruption'), { preservePending: true }); } } });
    await assert.rejects(f.service.install(f.game), /fixture interruption/); const wal = JSON.parse(fs.readFileSync(f.pending));
    if (variant === 'snapshot') fs.writeFileSync(path.join(f.gameRoot, '_DLSS5_Backup/feeder-v2-history', wal.operation, 'after/0.bin'), 'altered stage');
    if (variant === 'target') { wal.files[0].file = path.join(f.dir, 'unrelated.dll'); fs.writeFileSync(f.pending, JSON.stringify(wal)); }
    if (variant === 'replacement') fs.writeFileSync(wal.files[0].file, 'new user replacement');
    const before = fs.readFileSync(f.pending); await assert.rejects(createLegacyService({ ...f.options, afterWrite: undefined }).recover(f.game));
    assert.deepEqual(fs.readFileSync(f.pending), before);
    if (variant === 'replacement') assert.equal(fs.readFileSync(wal.files[0].file, 'utf8'), 'new user replacement');
  }
});

test('recovery retains a replacement that wins the atomic claim and another newly published target', async t => {
  const f = fixture(t, { options: { afterWrite: () => { throw Object.assign(new Error('fixture interruption'), { preservePending: true }); } } });
  await assert.rejects(f.service.install(f.game), /fixture interruption/);
  const journal = fs.readFileSync(f.pending), wal = JSON.parse(journal), victim = wal.files[0].file;
  const first = 'external replacement before claim', second = 'external replacement after claim';
  const rename = fsp.rename; let retainedAt, raced = false;
  fsp.rename = async (source, target) => {
    if (!raced && source === victim && path.basename(target) === 'after.bin') {
      raced = true; retainedAt = target; fs.writeFileSync(victim, first);
      await rename(source, target); fs.writeFileSync(victim, second); return;
    }
    return rename(source, target);
  };
  try {
    await assert.rejects(createLegacyService({ ...f.options, afterWrite: undefined }).recover(f.game), { code: 'LEGACY_FILE_CHANGED' });
  } finally { fsp.rename = rename; }
  assert.equal(raced, true); assert.equal(fs.readFileSync(retainedAt, 'utf8'), first);
  assert.equal(fs.readFileSync(victim, 'utf8'), second); assert.deepEqual(fs.readFileSync(f.pending), journal);
  await assert.rejects(createLegacyService({ ...f.options, afterWrite: undefined }).recover(f.game), { code: 'LEGACY_FILE_CHANGED' });
  assert.equal(fs.readFileSync(retainedAt, 'utf8'), first); assert.equal(fs.readFileSync(victim, 'utf8'), second);
  assert.deepEqual(fs.readFileSync(f.pending), journal);
});

test('recovery resumes after an atomic claim for both a created file and a replaced original', async t => {
  for (const variant of ['created', 'replaced']) {
    const f = fixture(t, { options: { afterWrite: ({ row, index }) => {
      if (variant === 'created' ? index === 0 : row.role === 'shared-config')
        throw Object.assign(new Error('fixture interruption'), { preservePending: true });
    } } });
    await assert.rejects(f.service.install(f.game), /fixture interruption/);
    const wal = JSON.parse(fs.readFileSync(f.pending)), row = variant === 'created' ? wal.files[0] : wal.files.find(value => value.role === 'shared-config');
    const rename = fsp.rename; let retainedAt, interrupted = false;
    fsp.rename = async (source, target) => {
      await rename(source, target);
      if (!interrupted && source === row.file && path.basename(target) === 'after.bin') {
        interrupted = true; retainedAt = target; throw new Error('recovery interrupted after claim');
      }
    };
    try {
      await assert.rejects(createLegacyService({ ...f.options, afterWrite: undefined }).recover(f.game), /recovery interrupted after claim/);
    } finally { fsp.rename = rename; }
    assert.equal(interrupted, true); assert.equal(exists(row.file), false); assert.equal(hash(fs.readFileSync(retainedAt)), row.after);
    assert.equal(exists(f.pending), true);
    assert.equal((await createLegacyService({ ...f.options, afterWrite: undefined }).recover(f.game)).recovered, true);
    assert.equal(row.before === null ? !exists(row.file) : hash(fs.readFileSync(row.file)) === row.before, true);
    assert.equal(exists(path.dirname(retainedAt)), false); assert.equal(exists(f.pending), false);
    assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.original);
  }
});

test('recovery exclusive restore preserves a target published after claiming the old candidate', async t => {
  const f = fixture(t, { options: { afterWrite: ({ row }) => {
    if (row.role === 'shared-config') throw Object.assign(new Error('fixture interruption'), { preservePending: true });
  } } });
  await assert.rejects(f.service.install(f.game), /fixture interruption/);
  const journal = fs.readFileSync(f.pending), wal = JSON.parse(journal), index = wal.files.findIndex(row => row.role === 'shared-config'), row = wal.files[index];
  let raced = false;
  const service = createLegacyService({ ...f.options, afterWrite: undefined, copyFile: async (source, target, flags) => {
    if (!raced && target === row.file) { raced = true; fs.writeFileSync(target, 'new config during exclusive restore'); }
    return fsp.copyFile(source, target, flags);
  } });
  await assert.rejects(service.recover(f.game), { code: 'EEXIST' }); assert.equal(raced, true);
  assert.equal(fs.readFileSync(row.file, 'utf8'), 'new config during exclusive restore');
  const retainedAt = path.join(path.dirname(row.file), `.dlss5-feeder-${wal.operation}-${index}.recovery`, 'after.bin');
  assert.equal(hash(fs.readFileSync(retainedAt)), row.after);
  assert.equal(hash(fs.readFileSync(path.join(f.gameRoot, '_DLSS5_Backup/feeder-v2-history', wal.operation, 'before', `${index}.bin`))), row.before);
  assert.deepEqual(fs.readFileSync(f.pending), journal);
  await assert.rejects(service.recover(f.game), { code: 'LEGACY_FILE_CHANGED' });
  assert.equal(fs.readFileSync(row.file, 'utf8'), 'new config during exclusive restore');
});

test('HoYo projected profile compiles one bounded plan and shares INI and receipt ownership through restore', async t => {
  const f = fixture(t), runtimeDir = path.join(f.root, 'user-data', 'hoyo', 'active');
  const profileConfig = '[ADDON]\r\nAddonPath=.\r\n[STYLE]\r\nHdrOverlayBrightness=215\r\n';
  const layout = { source: 'hoyoshade-profile', verified: true, gameDir: f.gameRoot, exePath: f.exe, runtimeDir,
    addonDirectory: runtimeDir, nrConfigDir: runtimeDir, activeConfigPath: path.join(runtimeDir, 'ReShade.ini'), generation: 'hoyo-fixture-generation', loadingBackend: 'hoyoshade',
    projectedConfig: { text: profileConfig, sha256: hash(profileConfig) }, projectedFiles: [{ path: path.join(runtimeDir, 'ReShade.ini'), sha256: hash(profileConfig) }] };
  const preview = await f.service.previewInstall(f.game, { api: 'dx11', loadingBackend: 'hoyoshade', layout });
  assert.equal(preview.changes.some(row => row.role === 'game-loader'), false); assert.equal(exists(f.receipt), false);
  fs.mkdirSync(runtimeDir, { recursive: true }); fs.writeFileSync(layout.activeConfigPath, profileConfig); fs.writeFileSync(path.join(runtimeDir, 'ReShade64.dll'), 'hoyo-owned loader');
  fs.writeFileSync(path.join(f.dir, 'ReShade.ini'), '[INSTALL]\nBasePath=' + runtimeDir + '\n');
  const peer = path.join(f.gameRoot, '_DLSS5_Backup/xiaofeng-external.json'); fs.mkdirSync(path.dirname(peer), { recursive: true }); fs.writeFileSync(peer, 'hoyo profile owner');
  f.state.layout = { ...layout, projectedConfig: undefined, projectedFiles: undefined };
  await f.service.install(f.game, { expectedPlanId: preview.planId, layout: f.state.layout, loadingBackend: 'hoyoshade' });
  assert.equal((await f.service.inspect(f.game)).ready, true); assert.equal(fs.readFileSync(peer, 'utf8'), 'hoyo profile owner');
  await f.service.restore(f.game); assert.equal(fs.readFileSync(layout.activeConfigPath, 'utf8'), profileConfig);
  assert.equal(fs.readFileSync(path.join(runtimeDir, 'ReShade64.dll'), 'utf8'), 'hoyo-owned loader'); assert.equal(fs.readFileSync(peer, 'utf8'), 'hoyo profile owner');
});

test('x86 and DX10 recipes expose only target-process modules; host configuration and game launch remain separate', async t => {
  const f = fixture(t, { bitness: 32, api: 'dx10' }); await f.service.install(f.game);
  const row = f.service.receipt(f.game); assert.equal(row.recipe.hostRequired, true);
  const modules = await f.service.ownedModuleManifest(f.game); assert.deepEqual(modules.map(value => value.role).sort(), ['provider', 'reshade']);
  assert.equal(f.service.profile(f.game).nrConfigDir, path.join(f.layout.addonDirectory, 'host64/addons'));
  assert.equal(fs.readFileSync(path.join(f.layout.addonDirectory, 'host64/ReShade.ini'), 'utf8'), '[ADDON]\r\nAddonPath=.\\addons\r\n\r\n[INPUT]\r\nKeyOverlay=36,0,0,0\r\n');
  const result = await f.service.launch(f.game); assert.equal(result.pid, 4018); assert.equal(f.service.receipt(f.game).lastLaunch.pid, 4018);
});

test('running game and unsupported DX9 HoYo combination fail without installing or changing any component', async t => {
  const f = fixture(t); f.state.running = true; await assert.rejects(f.service.previewInstall(f.game), { code: 'GAME_RUNNING' });
  f.state.running = false; await assert.rejects(f.service.previewInstall(f.game, { api: 'dx9', loadingBackend: 'hoyoshade' }), { code: 'LEGACY_RECIPE_UNSUPPORTED' });
  assert.equal(exists(f.receipt), false); assert.equal(exists(f.pending), false); assert.equal(exists(f.layout.runtimeDir), false);
});

function sourcePlugins(f) {
  const directory = path.join(f.root, 'existing-user-addons'); fs.mkdirSync(directory);
  const unknown = path.join(directory, 'unknown.addon64'), early = path.join(directory, 'Early.dll');
  fs.writeFileSync(unknown, 'ordinary unknown addon fixture'); fs.writeFileSync(early, 'RenoDX HDR declared early fixture');
  fs.writeFileSync(path.join(directory, 'Early.ini'), 'UserBrightness=176\n');
  const original = '[ADDON]\r\nAddonPath=' + directory + '\r\nLoadFromDllMain=' + early + '\r\n[STYLE]\r\nHdrOverlayBrightness=211\r\n';
  fs.writeFileSync(path.join(f.dir, 'ReShade.ini'), original); return { directory, unknown, early, original };
}

test('legacy absolute LoadFromDllMain and external searched unknown addons are isolated in the owner WAL and restored to original paths', async t => {
  const f = fixture(t), source = sourcePlugins(f), preview = await f.service.previewInstall(f.game);
  assert.deepEqual(preview.compatibility.isolate.map(row => row.path).sort(), [source.unknown, source.early].sort());
  assert.equal(preview.changes.filter(row => row.role === 'source-addon').length, 2);
  await f.service.install(f.game, { expectedPlanId: preview.planId }); assert.equal(exists(source.unknown), false); assert.equal(exists(source.early), false);
  assert.equal(getIni(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), 'ADDON', 'LoadFromDllMain'), null);
  assert.equal((await f.service.inspect(f.game)).ready, true);
  await f.service.restore(f.game); assert.equal(fs.readFileSync(source.unknown, 'utf8'), 'ordinary unknown addon fixture');
  assert.equal(fs.readFileSync(source.early, 'utf8'), 'RenoDX HDR declared early fixture'); assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), source.original);
});

test('explicit unknown keep copies the early DLL, addon and sidecar, binds repair to those identities and restores only owned copies', async t => {
  const f = fixture(t), source = sourcePlugins(f), initial = await f.service.previewInstall(f.game);
  const addonKeep = initial.compatibility.isolate.map(row => ({ path: row.path, sha256: row.sha256, configFingerprint: initial.compatibility.configFingerprint }));
  const preview = await f.service.previewInstall(f.game, { addonKeep }); assert.equal(preview.compatibility.isolate.length, 0);
  await f.service.install(f.game, { expectedPlanId: preview.planId });
  const earlyCopy = path.join(f.layout.addonDirectory, 'Early.dll'), addonCopy = path.join(f.layout.addonDirectory, 'unknown.addon64');
  assert.equal(exists(source.early), true); assert.equal(exists(source.unknown), true); assert.equal(exists(earlyCopy), true); assert.equal(exists(addonCopy), true);
  assert.equal(fs.readFileSync(path.join(f.layout.addonDirectory, 'Early.ini'), 'utf8'), 'UserBrightness=176\n');
  assert.equal(getIni(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), 'ADDON', 'LoadFromDllMain'), 'Early.dll');
  assert.equal((await f.service.inspect(f.game)).ready, true);
  const repair = await f.service.previewInstall(f.game); assert.equal(repair.compatibility.isolate.length, 0); await f.service.install(f.game, { expectedPlanId: repair.planId });
  fs.appendFileSync(path.join(f.layout.addonDirectory, 'Early.ini'), 'Personal=1\n'); await f.service.restore(f.game);
  assert.equal(exists(earlyCopy), false); assert.equal(exists(addonCopy), false); assert.equal(exists(source.early), true); assert.equal(exists(source.unknown), true);
  assert.equal(fs.readFileSync(path.join(source.directory, 'Early.ini'), 'utf8'), 'UserBrightness=176\n');
});

test('interruption during external addon isolation recovers the original absolute early load and preserves peer files', async t => {
  const f = fixture(t, { options: { afterWrite: ({ row }) => { if (row.role === 'source-addon') throw Object.assign(new Error('source isolation interrupted'), { preservePending: true }); } } });
  const source = sourcePlugins(f), preview = await f.service.previewInstall(f.game);
  await assert.rejects(f.service.install(f.game, { expectedPlanId: preview.planId }), /source isolation interrupted/);
  assert.equal(exists(f.pending), true); assert.equal(exists(f.receipt), false);
  await createLegacyService({ ...f.options, afterWrite: undefined }).recover(f.game);
  assert.equal(exists(source.early), true); assert.equal(exists(source.unknown), true); assert.equal(exists(f.pending), false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), source.original);
});

test('real HoYo profile owner and legacy owner keep the same selected Core through rebind previews and restore independently', async t => {
  const f = fixture(t), exe = path.join(f.dir, 'YuanShen.exe'); fs.renameSync(f.exe, exe); f.game.scan.chosen.path = exe;
  const launcher = path.join(f.root, 'HYP.exe'); fs.writeFileSync(launcher, 'fixture launcher');
  const { createExternalRuntime } = require('../src/product/external-runtime');
  const { createHoYoProfileService, HOYO_RECIPE } = require('../src/product/hoyoshade-profile');
  const appDir = path.resolve(__dirname, '..'), userData = path.join(f.root, 'hoyo-data');
  const external = createExternalRuntime({ userData, pe: f.options.pe, guards: f.options.guards }); let legacy;
  const known = async game => legacy ? legacy.ownedModuleManifest(game) : [];
  const hoyo = createHoYoProfileService({ appDir, userData, externalRuntime: external, pe: f.options.pe, getKnownComponents: known });
  legacy = createLegacyService({ ...f.options, getLayout: game => hoyo.profile(game), getKnownComponents: known });
  const reshade = process.env.DLSS5_TEST_HOYO_LOADER || path.join(appDir, 'payload/nr-before-sr/fixed/RTX50/ReShade64.dll');
  assert.equal(hash(fs.readFileSync(reshade)), HOYO_RECIPE.loaderSha256);
  const request = { hoyo: { family: 'genshin', channel: 'cn', launcher: { kind: 'hoyoplay', path: launcher } }, inputRoute: 'feeder', api: 'dx11',
    payload: { reshade: { file: reshade, actual: HOYO_RECIPE.loaderSha256 } } };
  const userAddon = path.join(f.dir, 'personal-addons', 'user.addon64'); fs.mkdirSync(path.dirname(userAddon)); fs.writeFileSync(userAddon, 'user kept addon');
  const probe = await hoyo.preview(f.game, request); request.addonKeep = probe.compatibility.isolate.map(row => ({ path: row.path, sha256: row.sha256,
    configFingerprint: probe.compatibility.configFingerprint }));
  const profile = await hoyo.preview(f.game, request), input = await legacy.previewInstall(f.game, { api: 'dx11', loadingBackend: 'hoyoshade', layout: profile.layout });
  await hoyo.apply(profile.planId); await legacy.install(f.game, { expectedPlanId: input.planId });
  assert.equal((await legacy.inspect(f.game)).ready, true); assert.equal((await hoyo.inspect(f.game)).ready, true);
  const core = (await legacy.ownedModuleManifest(f.game)).find(row => row.role === 'core'), before = fs.readFileSync(core.path);
  const second = await hoyo.preview(f.game, { ...request, addonKeep: [] }), repair = await legacy.previewInstall(f.game, { api: 'dx11', loadingBackend: 'hoyoshade', layout: second.layout });
  assert.equal(second.changes.some(row => row.path === core.path && row.action !== 'keep'), false);
  assert.equal(repair.compatibility.retire.some(row => row.path === core.path), false); assert.equal(repair.compatibility.isolate.length, 0);
  await hoyo.apply(second.planId); await legacy.install(f.game, { expectedPlanId: repair.planId }); assert.deepEqual(fs.readFileSync(core.path), before);
  assert.equal((await legacy.inspect(f.game)).ready, true); assert.equal((await hoyo.inspect(f.game)).ready, true);
  await legacy.restore(f.game); assert.equal((await hoyo.inspect(f.game)).ready, true);
  await hoyo.restore(f.game); assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.original);
  assert.equal(fs.readFileSync(userAddon, 'utf8'), 'user kept addon');
});

test('a known old Core at the selected filename is replaced in one WAL and its original bytes remain restorable', async t => {
  const f = fixture(t), core = path.join(f.layout.addonDirectory, 'core.addon64'), original = 'old known Core NRBeforeSR';
  fs.mkdirSync(path.dirname(core), { recursive: true }); fs.writeFileSync(core, original);
  const ini = '[ADDON]\nAddonPath=' + f.layout.addonDirectory + '\nLoadFromDllMain=core.addon64\n'; fs.writeFileSync(path.join(f.dir, 'ReShade.ini'), ini);
  const service = createLegacyService({ ...f.options, getKnownComponents: async () => [{ path: core, sha256: hash(original), role: 'core' }] });
  const preview = await service.previewInstall(f.game); assert.equal(preview.compatibility.retire[0].path, core);
  assert.equal(preview.changes.filter(row => row.path === core).length, 1); assert.equal(preview.changes.find(row => row.path === core).action, 'replace');
  await service.install(f.game, { expectedPlanId: preview.planId }); assert.equal(fs.readFileSync(core, 'utf8'), 'corefixture-v1');
  assert.equal((await service.inspect(f.game)).ready, true); await service.restore(f.game);
  assert.equal(fs.readFileSync(core, 'utf8'), original); assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), ini);
});

test('DX9 local recipe publishes only its system wrapper and game provider, gives VORT to the host and restores the original INI', async t => {
  const f = fixture(t, { api: 'dx9' }), preview = await f.service.previewInstall(f.game);
  assert.equal(preview.changes.find(row => row.role === 'api-wrapper').path, path.join(f.dir, 'd3d9.dll'));
  assert.equal(preview.changes.find(row => row.role === 'game-loader').path, path.join(f.layout.runtimeDir, 'ReShade64.dll'));
  await f.service.install(f.game, { expectedPlanId: preview.planId });
  assert.equal(getIni(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), 'GENERAL', 'NoReloadOnInit'), '1');
  assert.equal(getIni(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), 'INPUT', 'KeyOverlay'), '36,0,0,0');
  assert.equal(getIni(fs.readFileSync(path.join(f.layout.addonDirectory, 'host64/ReShade.ini'), 'utf8'), 'INPUT', 'KeyOverlay'), '36,0,0,0');
  assert.equal(f.service.receipt(f.game).config.panelDefault, 36);
  assert.equal(fs.readFileSync(path.join(f.layout.addonDirectory, 'host64/NRGuides.ini'), 'utf8'), DEFAULTS.hostGuides);
  assert.deepEqual((await f.service.ownedModuleManifest(f.game)).map(row => row.role).sort(), ['api-wrapper', 'provider', 'reshade']);
  assert.equal((await f.service.inspect(f.game)).ready, true); await f.service.restore(f.game);
  assert.equal(exists(path.join(f.dir, 'd3d9.dll')), false); assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.original);
});

test('legacy prepare preserves an explicit panel key and subsequent edits survive owner restore', async t => {
  const f = fixture(t), file = path.join(f.dir, 'ReShade.ini'), original = f.original + '[INPUT]\r\nKeyOverlay=120,1,0,1\r\n';
  fs.writeFileSync(file, original);
  const preview = await f.service.previewInstall(f.game); await f.service.install(f.game, { expectedPlanId: preview.planId });
  assert.equal(getIni(fs.readFileSync(file, 'utf8'), 'INPUT', 'KeyOverlay'), '120,1,0,1');
  const saved = JSON.parse(fs.readFileSync(f.receipt));
  assert.equal(saved.config.deltas.some(row => row.section === 'INPUT' && row.name === 'KeyOverlay'), false);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('KeyOverlay=120,1,0,1', 'KeyOverlay=121,0,1,0'));
  await f.service.restore(f.game);
  assert.equal(getIni(fs.readFileSync(file, 'utf8'), 'INPUT', 'KeyOverlay'), '121,0,1,0');
});

test('pre-equals legacy receipts keep their original configuration and host bytes through inspect, repair and restore', async t => {
  const f = fixture(t, { api: 'dx10' }), preview = await f.service.previewInstall(f.game);
  await f.service.install(f.game, { expectedPlanId: preview.planId });
  // Reconstruct the exact earlier, data-only receipt contract in this isolated
  // fixture. Its recipe and payload identities remain unchanged.
  const row = JSON.parse(fs.readFileSync(f.receipt));
  const old = configure(row.config.beforeText, row.layout, row.recipe, row.config.seedText, { legacyDefaults: true });
  row.config = { ...row.config, ...old }; delete row.config.panelDefault;
  fs.writeFileSync(row.config.path, old.text);
  const host = row.files.find(file => file.role === 'host-config'), originalHost = '[ADDON]\r\nAddonPath=.\\addons\r\n';
  fs.writeFileSync(host.path, originalHost); host.sha256 = host.installedHash = hash(originalHost);
  fs.writeFileSync(f.receipt, JSON.stringify(row));
  assert.equal((await f.service.inspect(f.game)).ready, true);
  const repair = await f.service.previewInstall(f.game); await f.service.install(f.game, { expectedPlanId: repair.planId });
  assert.equal(fs.readFileSync(row.config.path, 'utf8'), old.text);
  assert.equal(fs.readFileSync(host.path, 'utf8'), originalHost);
  await f.service.restore(f.game);
  assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.original);
});

function historicalEqualsReceipt(f) {
  const row = JSON.parse(fs.readFileSync(f.receipt));
  const config = configure(row.config.beforeText, row.layout, row.recipe, row.config.seedText, { panelDefault: 187 });
  row.config = { ...row.config, ...config }; fs.writeFileSync(row.config.path, config.text);
  const host = row.files.find(file => file.role === 'host-config');
  if (host) {
    const originalHost = '[ADDON]\r\nAddonPath=.\\addons\r\n\r\n[INPUT]\r\nKeyOverlay=187,0,0,0\r\n';
    fs.writeFileSync(host.path, originalHost); host.sha256 = host.installedHash = hash(originalHost);
  }
  fs.writeFileSync(f.receipt, JSON.stringify(row)); return row;
}

test('historical equals receipts preserve their main and host defaults through inspect, repair and exact restore', async t => {
  for (const api of ['dx9', 'dx10']) {
    const f = fixture(t, { api }); await f.service.install(f.game);
    const row = historicalEqualsReceipt(f), host = row.files.find(file => file.role === 'host-config');
    assert.equal((await f.service.inspect(f.game)).ready, true);
    fs.unlinkSync(host.path);
    const repair = await f.service.previewInstall(f.game); await f.service.install(f.game, { expectedPlanId: repair.planId });
    assert.equal(f.service.receipt(f.game).config.panelDefault, 187);
    assert.match(fs.readFileSync(host.path, 'utf8'), /KeyOverlay=187,0,0,0/);
    assert.equal(fs.readFileSync(row.config.path, 'utf8'), row.config.text);
    await f.service.restore(f.game);
    assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.original);
  }
});

test('interrupted repair of a historical equals receipt recovers using its original host specification', async t => {
  let interrupt = false;
  const f = fixture(t, { api: 'dx10', options: { afterWrite: ({ row }) => {
    if (interrupt && row.role === 'host-config') throw Object.assign(new Error('old host repair interrupted'), { preservePending: true });
  } } });
  await f.service.install(f.game); const row = historicalEqualsReceipt(f), host = row.files.find(file => file.role === 'host-config');
  const receipt = fs.readFileSync(f.receipt); fs.unlinkSync(host.path); interrupt = true;
  await assert.rejects(f.service.install(f.game), /old host repair interrupted/);
  assert.equal(JSON.parse(fs.readFileSync(f.pending)).receipt.config.panelDefault, 187);
  const restarted = createLegacyService({ ...f.options, afterWrite: undefined });
  assert.equal((await restarted.recover(f.game)).recovered, true);
  assert.deepEqual(fs.readFileSync(f.receipt), receipt); assert.equal(exists(host.path), false);
  await restarted.install(f.game); assert.equal((await restarted.inspect(f.game)).ready, true);
  assert.match(fs.readFileSync(host.path, 'utf8'), /KeyOverlay=187,0,0,0/);
  await restarted.restore(f.game); assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.original);
});

test('Home default preparation preserves explicit equals and disabled panel keys through exact legacy restore', async t => {
  for (const binding of ['187,0,0,0', '0,0,0,0']) {
    const f = fixture(t), file = path.join(f.dir, 'ReShade.ini'), original = f.original + '[INPUT]\r\nKeyOverlay=' + binding + '\r\n';
    fs.writeFileSync(file, original); await f.service.install(f.game);
    assert.equal(f.service.receipt(f.game).config.panelDefault, 36);
    assert.equal(getIni(fs.readFileSync(file, 'utf8'), 'INPUT', 'KeyOverlay'), binding);
    await f.service.restore(f.game); assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
});

test('runtime-saved host INIs retain receipt identities, stay repairable and archive exact saved bytes on restore', async t => {
  for (const legacyDefaults of [false, true]) {
    const f = fixture(t, { api: 'dx9' }); await f.service.install(f.game);
    const receipt = JSON.parse(fs.readFileSync(f.receipt));
    if (legacyDefaults) {
      const old = configure(receipt.config.beforeText, receipt.layout, receipt.recipe, receipt.config.seedText, { legacyDefaults: true });
      receipt.config = { ...receipt.config, ...old }; delete receipt.config.panelDefault; fs.writeFileSync(receipt.config.path, old.text);
      const host = receipt.files.find(row => row.role === 'host-config'), original = '[ADDON]\r\nAddonPath=.\\addons\r\n';
      fs.writeFileSync(host.path, original); host.sha256 = host.installedHash = hash(original); fs.writeFileSync(f.receipt, JSON.stringify(receipt));
    }
    const configs = receipt.files.filter(row => ['host-config', 'host-guides'].includes(row.role)), saved = new Map();
    for (const file of configs) {
      assert.equal(file.mutable, false);
      let text = fs.readFileSync(file.path, 'utf8').replace(/\r?\n/g, '\r\n');
      if (file.role === 'host-config') text += '[DLSS5Host]\r\nWindowWidth=900\r\nWindowHeight=0\r\n[OVERLAY]\r\n' +
        'Docking=[Docking][Data],DockSpace ID=0xB0DF600F Pos=8,,8 Size=884,,1334\r\nWindow=[Window][###home],Pos=8,,8,Collapsed=0\r\n';
      else text = text.replace('ShowFPS=0', 'ShowFPS=1').replace('KeyOverlay=0,0,0,0', 'KeyOverlay=121,0,0,0');
      fs.writeFileSync(file.path, text); saved.set(file.path, Buffer.from(text));
    }
    assert.equal((await f.service.inspect(f.game)).ready, true);
    const preview = await f.service.previewInstall(f.game);
    for (const file of configs) assert.equal(preview.changes.find(row => row.path === file.path).action, 'keep');
    await f.service.install(f.game, { expectedPlanId: preview.planId });
    for (const file of configs) {
      assert.deepEqual(fs.readFileSync(file.path), saved.get(file.path));
      assert.deepEqual(f.service.receipt(f.game).files.find(row => row.path === file.path), file);
    }
    const removal = await f.service.previewRestore(f.game), restored = await f.service.restore(f.game, { expectedPlanId: removal.planId });
    const operation = JSON.parse(fs.readFileSync(path.join(restored.archiveDirectory, 'operation.json')));
    for (const file of configs) {
      const index = operation.files.findIndex(row => row.file === file.path);
      assert.deepEqual(fs.readFileSync(path.join(restored.archiveDirectory, 'before', `${index}.bin`)), saved.get(file.path));
      assert.equal(exists(file.path), false);
    }
    assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.original);
  }
});

test('host INI normal-save allowance rejects changed loading paths, early modules, duplicate keys and receipt role spoofing', async t => {
  const f = fixture(t, { api: 'dx9' }); await f.service.install(f.game); const receipt = fs.readFileSync(f.receipt), row = JSON.parse(receipt);
  const host = row.files.find(file => file.role === 'host-config'), guides = row.files.find(file => file.role === 'host-guides');
  const variants = [
    [host, text => text.replace('AddonPath=.\\addons', 'AddonPath=C:\\external-addons')],
    [host, text => text.replace('AddonPath=.\\addons', 'AddonPath=.\\addons\r\nLoadFromDllMain=foreign.dll')],
    [host, text => text.replace('AddonPath=.\\addons', 'AddonPath=.\\addons\r\nDisabledAddons=core')],
    [host, text => text.replace('AddonPath=.\\addons', 'AddonPath=.\\addons\r\nAddonPath=C:\\external-addons')],
    [guides, text => text.replace('PresetPath=.\\..\\..\\ReShadePreset.ini', 'PresetPath=C:\\external.ini')],
    [guides, text => text.replace('V_MV_MODE=1', 'V_MV_MODE=9')],
    [host, text => text + ';' + 'x'.repeat(256 * 1024)]
  ];
  for (const [file, change] of variants) {
    const original = fs.readFileSync(file.path); fs.writeFileSync(file.path, change(original.toString()));
    const changed = fs.readFileSync(file.path);
    assert.equal((await f.service.inspect(f.game)).ready, false);
    await assert.rejects(f.service.previewInstall(f.game), error => /^LEGACY_(HOST_CONFIG_CHANGED|CONFIG_AMBIGUOUS|CONFIG_SIZE)$/.test(error.code));
    await assert.rejects(f.service.previewRestore(f.game), error => /^LEGACY_(HOST_CONFIG_CHANGED|CONFIG_AMBIGUOUS|CONFIG_SIZE)$/.test(error.code));
    assert.equal(exists(f.pending), false); assert.deepEqual(fs.readFileSync(file.path), changed); fs.writeFileSync(file.path, original);
  }
  row.files.find(file => file.role === 'core').role = 'host-config'; fs.writeFileSync(f.receipt, JSON.stringify(row));
  await assert.rejects(f.service.inspect(f.game), { code: 'LEGACY_RECEIPT' }); fs.writeFileSync(f.receipt, receipt);
  const changed = JSON.parse(receipt); changed.files.find(file => file.role === 'host-config').mutable = true; fs.writeFileSync(f.receipt, JSON.stringify(changed));
  await assert.rejects(f.service.previewRestore(f.game), { code: 'LEGACY_RECEIPT' }); fs.writeFileSync(f.receipt, receipt);
  assert.equal((await f.service.restore(f.game)).restored, true);
});

test('interrupted restore of runtime-saved host configuration rolls back the exact saved bytes', async t => {
  const f = fixture(t, { api: 'dx9' }); await f.service.install(f.game);
  const file = f.service.receipt(f.game).files.find(row => row.role === 'host-guides').path;
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n').replace('ShowFPS=0', 'ShowFPS=1'));
  const saved = fs.readFileSync(file);
  const interrupted = createLegacyService({ ...f.options, afterWrite: ({ row }) => {
    if (row.file === file) throw Object.assign(new Error('restore interrupted at saved host INI'), { preservePending: true });
  } });
  await assert.rejects(interrupted.restore(f.game), /restore interrupted at saved host INI/);
  assert.equal(exists(file), false); assert.equal(exists(f.pending), true);
  assert.equal((await f.service.recover(f.game)).recovered, true); assert.deepEqual(fs.readFileSync(file), saved);
  assert.equal((await f.service.inspect(f.game)).ready, true); assert.equal((await f.service.restore(f.game)).restored, true);
});

test('ReShade relative serialization of owned paths stays ready and restores the original paths while rejecting another target', async t => {
  const f = fixture(t); await f.service.install(f.game); const file = path.join(f.dir, 'ReShade.ini');
  const initial = fs.readFileSync(file, 'utf8'), normalized = initial.split(f.layout.runtimeDir).join('.\\_DLSS5_Feeder15');
  assert.notEqual(normalized, initial); fs.writeFileSync(file, normalized);
  assert.equal((await f.service.inspect(f.game)).ready, true);
  const repair = await f.service.previewInstall(f.game); await f.service.install(f.game, { expectedPlanId: repair.planId });
  assert.equal(fs.readFileSync(file, 'utf8'), normalized);
  fs.writeFileSync(file, normalized.replace('PresetPath=.\\_DLSS5_Feeder15', 'PresetPath=.\\another-runtime'));
  assert.equal((await f.service.inspect(f.game)).ready, false);
  await assert.rejects(f.service.previewInstall(f.game), { code: 'LEGACY_CONFIG_CHANGED' }); fs.writeFileSync(file, normalized);
  await f.service.restore(f.game); const restored = fs.readFileSync(file, 'utf8');
  assert.equal(getIni(restored, 'GENERAL', 'PresetPath'), '.\\my-preset.ini');
  assert.equal(getIni(restored, 'GENERAL', 'EffectSearchPaths'), '.\\my-shaders\\**');
  assert.equal(restored.includes('_DLSS5_Feeder15'), false);
});
