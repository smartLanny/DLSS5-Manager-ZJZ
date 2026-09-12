'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createExternalRuntime, RECEIPT, PENDING } = require('../src/product/external-runtime');
const { newManifest, manifestPath } = require('../src/product/manifest');
const { INSTALLED_NAMES } = require('../src/product/constants');
const { addonValues } = require('../src/product/reshade-layout');
const { createInstaller } = require('../src/product/installer');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t, api = 'dx12', overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-deploy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gameRoot = path.join(root, 'game'), dir = path.join(gameRoot, 'bin'), exe = path.join(dir, 'Game.exe');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(exe, 'actual game executable');
  fs.writeFileSync(path.join(dir, 'nvngx_dlss.dll'), 'game native DLSS');
  fs.writeFileSync(path.join(dir, 'dxgi.dll'), 'ReShade loader Searching for add-ons');
  const game = { id: 'game', dir: gameRoot, installed: true, scan: { chosen: { path: exe, bitness: 64,
    apiResolution: { api } }, primaryDlss: { name: 'nvngx_dlss.dll', path: path.join(dir, 'nvngx_dlss.dll') } } };
  const manifest = newManifest(gameRoot, exe, api);
  manifest.payloadVersion = '1.0'; manifest.deploymentApi = api;
  const originals = {};
  for (const kind of ['addon', 'bridge', 'runtime', 'config', ...(api === 'dx11' ? ['carrier'] : [])]) {
    const name = INSTALLED_NAMES[kind], bytes = kind === 'config' ? '[NRBeforeSR]\r\nIntensity=1.4\r\n' : 'v1:' + kind;
    originals[name] = bytes; fs.writeFileSync(path.join(dir, name), bytes);
    manifest.files.push({ rel: path.relative(gameRoot, path.join(dir, name)), kind, installedSha256: sha(bytes), original: { existed: false } });
  }
  const originalIni = '; personal configuration\r\n[GENERAL]\r\nEffectSearchPaths=.\\reshade-shaders\\Shaders,.\\custom,,effects\r\n' +
    'TextureSearchPaths=.\\reshade-shaders\\Textures\r\nPresetPath=.\\MyPreset.ini\r\n[SCREENSHOT]\r\nSavePath=.\\shots\r\n' +
    '[ADDON]\r\nAddonPath=.\r\nDisabledAddons=Unrelated Add-on@disabled.addon64\r\n[UserFilter]\r\nStrength=0.42\r\n';
  fs.writeFileSync(path.join(dir, 'ReShade.ini'), originalIni);
  fs.writeFileSync(path.join(dir, 'Overlay.addon64'), 'ordinary user overlay');
  fs.writeFileSync(path.join(dir, 'Overlay.ini'), '[Overlay]\nUserChoice=4\n');
  fs.writeFileSync(path.join(dir, 'OverlayHelper.dll'), 'user addon dependency');
  fs.writeFileSync(path.join(dir, 'unknown.dll.bak'), 'unproven backup must stay');
  fs.mkdirSync(path.dirname(manifestPath(gameRoot)), { recursive: true });
  fs.writeFileSync(manifestPath(gameRoot), JSON.stringify(manifest, null, 2) + '\n');
  const controls = { running: false };
  const options = { userData: path.join(root, 'data'), pe: { getImports: file => file.endsWith('Overlay.addon64') ? ['OverlayHelper.dll'] : [] },
    guards: { antiCheatPresent: () => false, assertGameClosed: async () => { if (controls.running) throw Object.assign(new Error('running'), { code: 'ERR_GAME_RUNNING' }); } }, ...overrides };
  const service = createExternalRuntime(options);
  return { root, gameRoot, dir, exe, game, manifest, options, service, originals, originalIni, controls,
    pending: path.join(gameRoot, PENDING), receipt: path.join(gameRoot, RECEIPT) };
}
async function toExternal(f) {
  const plan = await f.service.preview(f.game, { mode: 'external' });
  return f.service.apply(plan.planId);
}

function historicalEqualsProfile(f) {
  const saved = JSON.parse(fs.readFileSync(f.receipt)), config = f.service.getLayout(f.game).activeConfigPath;
  assert.equal(saved.panelDefaultAdded, true); assert.equal(saved.panelDefaultKey, 36);
  delete saved.panelDefaultKey;
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('KeyOverlay=36,0,0,0', 'KeyOverlay=187,0,0,0'));
  fs.writeFileSync(f.receipt, JSON.stringify(saved)); return config;
}
function nextPayload(f, version = '2.0') {
  const folder = path.join(f.root, 'payload-' + version); fs.mkdirSync(folder, { recursive: true });
  const payload = { version, versionInfo: { compatibility: 'dx11' } };
  for (const kind of ['addon', 'bridge', 'runtime', ...(f.manifest.deploymentApi === 'dx11' ? ['carrier'] : [])]) {
    const bytes = version + ':' + kind, file = path.join(folder, INSTALLED_NAMES[kind]); fs.writeFileSync(file, bytes);
    payload[kind] = { file, actual: sha(bytes) };
  }
  return payload;
}
function expectOriginals(f) {
  for (const [name, bytes] of Object.entries(f.originals)) assert.equal(fs.readFileSync(path.join(f.dir, name), 'utf8'), bytes, name);
  assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.originalIni);
  assert.equal(fs.readFileSync(path.join(f.dir, 'unknown.dll.bak'), 'utf8'), 'unproven backup must stay');
}

for (const api of ['dx11', 'dx12']) test(api + ' ordinary to external to upgrade to ordinary preserves personal files and load paths', async t => {
  const f = fixture(t, api), before = fs.readFileSync(manifestPath(f.gameRoot));
  const preview = await f.service.preview(f.game, { mode: 'external' });
  expectOriginals(f); assert.equal(fs.existsSync(f.receipt), false);
  assert.ok(preview.changes.some(row => row.name === 'Overlay.addon64'));
  const installed = await f.service.apply(preview.planId), layout = installed.layout;
  assert.equal(layout.mode, 'external'); assert.equal(layout.verified, true);
  assert.equal(layout.activeConfigPath, path.join(layout.addonDirectory, 'ReShade.ini'));
  assert.equal(fs.existsSync(path.join(f.dir, INSTALLED_NAMES.addon)), false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'Overlay.addon64'), 'utf8'), 'ordinary user overlay');
  assert.equal(fs.readFileSync(path.join(layout.runtimeDir, 'OverlayHelper.dll'), 'utf8'), 'user addon dependency');
  const active = fs.readFileSync(layout.activeConfigPath, 'utf8'), values = addonValues(active, 'GENERAL');
  assert.deepEqual(values.get('EffectSearchPaths'), [path.join(f.dir, 'reshade-shaders', 'Shaders'), path.join(f.dir, 'custom,effects')]);
  assert.equal(values.get('PresetPath')[0], path.join(f.dir, 'MyPreset.ini'));
  assert.match(active, /Strength=0.42/); assert.match(active, /Unrelated Add-on@disabled.addon64/);
  assert.match(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), /Strength=0.42/);
  assert.equal(fs.existsSync(path.join(layout.runtimeDir, INSTALLED_NAMES.carrier)), api === 'dx11');
  const upgraded = await f.service.preview(f.game, { mode: 'external', payload: nextPayload(f) });
  await f.service.apply(upgraded.planId);
  assert.equal((await f.service.inspect(f.game)).version, '2.0');
  await f.service.restore(f.game);
  assert.equal(f.service.getLayout(f.game).mode, 'local');
  assert.equal(fs.readFileSync(path.join(f.dir, INSTALLED_NAMES.addon), 'utf8'), '2.0:addon');
  assert.equal(fs.readFileSync(path.join(f.dir, INSTALLED_NAMES.config), 'utf8'), f.originals[INSTALLED_NAMES.config]);
  assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.originalIni);
  assert.equal(JSON.parse(fs.readFileSync(manifestPath(f.gameRoot))).payloadVersion, '2.0');
  assert.equal((await f.service.inspect(f.game)).baseline.version, '1.0');
  assert.notDeepEqual(fs.readFileSync(manifestPath(f.gameRoot)), before);
  assert.equal(fs.readFileSync(path.join(f.dir, 'unknown.dll.bak'), 'utf8'), 'unproven backup must stay');
  assert.equal(fs.existsSync(f.pending), false);
});

test('historical external equals defaults restore exact original bytes with or without an intervening update', async t => {
  for (const upgrade of [false, true]) {
    const f = fixture(t); await toExternal(f); const config = historicalEqualsProfile(f);
    assert.equal((await f.service.inspect(f.game)).ready, true);
    if (upgrade) {
      const plan = await f.service.preview(f.game, { mode: 'external', payload: nextPayload(f) }); await f.service.apply(plan.planId);
      assert.equal(JSON.parse(fs.readFileSync(f.receipt)).panelDefaultKey, 187);
    }
    assert.match(fs.readFileSync(config, 'utf8'), /KeyOverlay=187,0,0,0/);
    await f.service.restore(f.game);
    assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.originalIni);
  }
});

test('an interrupted move from a historical equals profile restores its old record and remains recoverable', async t => {
  let interrupt = false;
  const f = fixture(t, 'dx12', { afterWrite: ({ row, target }) => {
    if (interrupt && row.role === 'reshade-config' && row.file === path.join(target.dir, 'ReShade.ini'))
      throw Object.assign(new Error('old equals migration interrupted'), { preservePending: true });
  } });
  await toExternal(f); const config = historicalEqualsProfile(f), oldConfig = fs.readFileSync(config), oldReceipt = fs.readFileSync(f.receipt);
  interrupt = true; await assert.rejects(f.service.restore(f.game), /old equals migration interrupted/);
  const restarted = createExternalRuntime({ ...f.options, afterWrite: undefined });
  assert.equal((await restarted.recover(f.game)).recovered, true);
  assert.deepEqual(fs.readFileSync(config), oldConfig); assert.deepEqual(fs.readFileSync(f.receipt), oldReceipt);
  assert.equal((await restarted.inspect(f.game)).ready, true);
  await restarted.restore(f.game); assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.originalIni);
});

test('new Home profiles preserve explicit custom and disabled keys exactly through a round trip', async t => {
  for (const binding of ['187,0,0,0', '120,1,0,1', '0,0,0,0']) {
    const f = fixture(t), file = path.join(f.dir, 'ReShade.ini'), original = f.originalIni + '[INPUT]\r\nKeyOverlay=' + binding + '\r\n';
    fs.writeFileSync(file, original); const { layout } = await toExternal(f);
    const saved = JSON.parse(fs.readFileSync(f.receipt)); assert.equal(saved.panelDefaultAdded, false); assert.equal(saved.panelDefaultKey, 36);
    assert.match(fs.readFileSync(layout.activeConfigPath, 'utf8'), new RegExp('KeyOverlay=' + binding));
    await f.service.restore(f.game); assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
});

test('external mutable settings follow the active profile back without discarding unrelated values', async t => {
  const f = fixture(t); await toExternal(f); const layout = f.service.getLayout(f.game);
  fs.appendFileSync(layout.activeConfigPath, '[AnotherFilter]\r\nCustom=9\r\n');
  fs.writeFileSync(path.join(layout.nrConfigDir, INSTALLED_NAMES.config), '[NRBeforeSR]\nIntensity=1.8\n');
  await f.service.restore(f.game);
  assert.match(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), /Custom=9/);
  assert.match(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), /EffectSearchPaths=\.\\reshade-shaders\\Shaders/);
  assert.match(fs.readFileSync(path.join(f.dir, INSTALLED_NAMES.config), 'utf8'), /Intensity=1.8/);
});

test('helper deployment owns a complete ReShade profile and removes only the verified game proxy reversibly', async t => {
  for (const api of ['dx11', 'dx12']) {
    const f = fixture(t, api), originalProxy = fs.readFileSync(path.join(f.dir, 'dxgi.dll'));
    const preview = await f.service.preview(f.game, { mode: 'external', loadingMode: 'helper' });
    assert.ok(preview.changes.some(row => row.role === 'game-proxy' && row.afterSha256 === null));
    const result = await f.service.apply(preview.planId), layout = result.layout;
    assert.equal(layout.loadingMode, 'helper');
    assert.equal(fs.existsSync(path.join(f.dir, 'dxgi.dll')), false);
    assert.deepEqual(fs.readFileSync(layout.loaderPath), originalProxy);
    assert.equal(layout.moduleManifest.find(row => row.role === 'reshade').sha256, sha(originalProxy));
    assert.equal(layout.moduleManifest.some(row => row.role === 'carrier'), api === 'dx11');
    assert.equal(addonValues(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), 'INSTALL').get('BasePath')[0], layout.runtimeDir);
    await f.service.restore(f.game);
    assert.deepEqual(fs.readFileSync(path.join(f.dir, 'dxgi.dll')), originalProxy);
    expectOriginals(f);
  }
});

test('helper launch layout never blesses a changed module or a newly appeared game proxy', async t => {
  const f = fixture(t), plan = await f.service.preview(f.game, { mode: 'external', loadingMode: 'helper' });
  await f.service.apply(plan.planId);
  const layout = f.service.getLayout(f.game), expected = layout.moduleManifest.find(row => row.role === 'core');
  fs.writeFileSync(expected.path, 'unknown replacement core');
  assert.equal(f.service.getLayout(f.game).moduleManifest.find(row => row.role === 'core').sha256, expected.sha256);
  assert.equal((await f.service.inspect(f.game)).ready, false);
  fs.writeFileSync(path.join(f.dir, 'dxgi.dll'), 'new unrelated proxy');
  assert.throws(() => f.service.getLayout(f.game), { code: 'DEPLOYMENT_HELPER_PROXY_CONFLICT' });
});

test('a process exit after removing a local component remains recoverable after restart', async t => {
  let interrupted = false;
  const f = fixture(t, 'dx12', { afterWrite: async ({ row }) => {
    if (!interrupted && row.after === null && row.file.endsWith(INSTALLED_NAMES.addon)) {
      interrupted = true; throw Object.assign(new Error('exit after removing old Core'), { preservePending: true });
    }
  } });
  await assert.rejects(toExternal(f)); assert.equal(fs.existsSync(f.pending), true);
  const restarted = createExternalRuntime({ ...f.options, afterWrite: undefined });
  assert.equal((await restarted.inspect(f.game)).needsRecovery, true);
  await assert.rejects(restarted.assertReady(f.game), { code: 'DEPLOYMENT_RECOVERY_REQUIRED' });
  await restarted.recover(f.game); expectOriginals(f);
  assert.equal(fs.existsSync(f.pending), false);
});

test('a partial copy never becomes a live addon and can be recovered after restart', async t => {
  let failed = false;
  const f = fixture(t, 'dx12', { copyFile: async (source, destination, flags) => {
    if (!failed) {
      failed = true; await fsp.writeFile(destination, (await fsp.readFile(source)).subarray(0, 2), { flag: 'wx' });
      throw Object.assign(new Error('copy interrupted'), { preservePending: true });
    }
    return fsp.copyFile(source, destination, flags);
  } });
  await assert.rejects(toExternal(f));
  const layout = f.service.location(f.game);
  assert.equal(fs.existsSync(path.join(layout.runtimeDir, INSTALLED_NAMES.addon)), false);
  await createExternalRuntime({ ...f.options, copyFile: fsp.copyFile }).recover(f.game);
  expectOriginals(f);
});

test('an ordinary file-lock error rolls the whole migration back', async t => {
  let failed = false;
  const f = fixture(t, 'dx11', { afterWrite: async ({ row }) => {
    if (!failed && row.after === null) { failed = true; throw Object.assign(new Error('locked'), { code: 'EACCES' }); }
  } });
  await assert.rejects(toExternal(f), { code: 'EACCES' });
  expectOriginals(f); assert.equal(fs.existsSync(f.pending), false);
});

test('apply preserves a newer local Core written during the final game-closed check before deletion', async t => {
  let f, armed = false, replaced = false;
  const replacement = 'external Core written while the close check was awaited';
  f = fixture(t, 'dx12', {
    afterWrite: ({ row, target }) => { if (row.file === path.join(target.runtimeDir, 'ReShade.ini')) armed = true; },
    guards: { antiCheatPresent: () => false, assertGameClosed: async () => {
      if (!armed || replaced) return;
      armed = false; replaced = true;
      const core = path.join(f.dir, INSTALLED_NAMES.addon);
      assert.equal(fs.readFileSync(core, 'utf8'), f.originals[INSTALLED_NAMES.addon]);
      fs.writeFileSync(core, replacement);
    } }
  });
  await assert.rejects(toExternal(f), error => error.code === 'DEPLOYMENT_FILE_CHANGED' && error.details.needsRecovery === true);
  assert.equal(replaced, true); assert.equal(fs.readFileSync(path.join(f.dir, INSTALLED_NAMES.addon), 'utf8'), replacement);
  const pending = fs.readFileSync(f.pending), wal = JSON.parse(pending), row = wal.files.find(item => item.file === path.join(f.dir, INSTALLED_NAMES.addon));
  assert.equal(row.before, sha(f.originals[INSTALLED_NAMES.addon])); assert.equal(row.after, null);
  const snapshot = path.join(path.dirname(f.service.location(f.game).runtimeDir), 'history', wal.operation, row.snapshot);
  assert.equal(fs.readFileSync(snapshot, 'utf8'), f.originals[INSTALLED_NAMES.addon]);
  await assert.rejects(createExternalRuntime({ ...f.options, afterWrite: undefined }).recover(f.game), { code: 'DEPLOYMENT_FILE_CHANGED' });
  assert.deepEqual(fs.readFileSync(f.pending), pending); assert.equal(fs.readFileSync(path.join(f.dir, INSTALLED_NAMES.addon), 'utf8'), replacement);
});

test('rollback preserves a newer external Core written during its final game-closed check before deletion', async t => {
  const f = fixture(t, 'dx12', { afterWrite: ({ row, target }) => {
    if (row.file === path.join(target.runtimeDir, 'ReShade.ini')) throw Object.assign(new Error('exit after publishing profile files'), { preservePending: true });
  } });
  await assert.rejects(toExternal(f));
  const core = path.join(f.service.location(f.game).runtimeDir, INSTALLED_NAMES.addon), pending = fs.readFileSync(f.pending), wal = JSON.parse(pending);
  const created = wal.files.filter(row => row.before === null && row.after !== null && fs.existsSync(row.file)).map(row => row.file);
  assert.ok(created.length > 1 && created.includes(core));
  let checks = 0, replaced = false;
  const replacement = 'external Core written while the rollback close check was awaited';
  const restarted = createExternalRuntime({ ...f.options, afterWrite: undefined,
    guards: { antiCheatPresent: () => false, assertGameClosed: async () => {
      checks++;
      if (!replaced && checks > 1 && fs.existsSync(core) && created.every(file => file === core || !fs.existsSync(file))) {
        replaced = true; assert.equal(fs.readFileSync(core, 'utf8'), f.originals[INSTALLED_NAMES.addon]); fs.writeFileSync(core, replacement);
      }
    } }
  });
  await assert.rejects(restarted.recover(f.game), { code: 'DEPLOYMENT_FILE_CHANGED' });
  assert.equal(replaced, true); assert.equal(fs.readFileSync(core, 'utf8'), replacement); assert.deepEqual(fs.readFileSync(f.pending), pending);
  await assert.rejects(createExternalRuntime({ ...f.options, afterWrite: undefined }).recover(f.game), { code: 'DEPLOYMENT_FILE_CHANGED' });
  assert.equal(fs.readFileSync(core, 'utf8'), replacement); assert.deepEqual(fs.readFileSync(f.pending), pending);
  expectOriginals(f);
});

test('recovery refuses to overwrite an external edit and preserves both WAL and snapshots', async t => {
  let failed = false;
  const f = fixture(t, 'dx12', { afterWrite: async ({ row }) => {
    if (!failed && row.after === null) { failed = true; throw Object.assign(new Error('exit'), { preservePending: true }); }
  } });
  await assert.rejects(toExternal(f));
  fs.writeFileSync(path.join(f.dir, INSTALLED_NAMES.addon), 'new external Core');
  const pending = fs.readFileSync(f.pending);
  await assert.rejects(createExternalRuntime({ ...f.options, afterWrite: undefined }).recover(f.game), { code: 'DEPLOYMENT_FILE_CHANGED' });
  assert.equal(fs.readFileSync(path.join(f.dir, INSTALLED_NAMES.addon), 'utf8'), 'new external Core');
  assert.deepEqual(fs.readFileSync(f.pending), pending);
});

test('a second interruption while recovering an external migration can be retried safely', async t => {
  let interrupted = false;
  const f = fixture(t, 'dx12', { afterWrite: async ({ row }) => {
    if (!interrupted && row.after === null) { interrupted = true; throw Object.assign(new Error('first exit'), { preservePending: true }); }
  } });
  await assert.rejects(toExternal(f));
  let copied = false;
  const retry = createExternalRuntime({ ...f.options, afterWrite: undefined, copyFile: async (source, destination, flags) => {
    if (!copied) {
      copied = true; await fsp.writeFile(destination, 'partial');
      throw Object.assign(new Error('exit in rollback copy'), { preservePending: true });
    }
    return fsp.copyFile(source, destination, flags);
  } });
  await assert.rejects(retry.recover(f.game));
  assert.equal(fs.existsSync(f.pending), true);
  await createExternalRuntime({ ...f.options, afterWrite: undefined }).recover(f.game);
  expectOriginals(f); assert.equal(fs.existsSync(f.pending), false);
});

test('a changed inactive user addon is not overwritten when returning to ordinary deployment', async t => {
  const f = fixture(t); await toExternal(f);
  fs.writeFileSync(path.join(f.dir, 'Overlay.addon64'), 'new user version');
  await assert.rejects(f.service.restore(f.game), { code: 'DEPLOYMENT_FILE_CHANGED' });
  assert.equal(fs.readFileSync(path.join(f.dir, 'Overlay.addon64'), 'utf8'), 'new user version');
  assert.equal(f.service.getLayout(f.game).mode, 'external');
});

test('a bound external deployment can restore its ordinary files after the EXE is missing', async t => {
  const f = fixture(t); await toExternal(f);
  fs.unlinkSync(f.exe); f.game.scan.chosen = null;
  const result = await f.service.restore(f.game);
  assert.equal(result.restored, true); expectOriginals(f);
  assert.equal(fs.existsSync(f.exe), false);
});

test('clean and restore uninstall have separate reviewed file effects and keep unknown bak files', async t => {
  for (const mode of ['restore', 'clean']) {
    const f = fixture(t), row = f.manifest.files.find(value => value.kind === 'addon');
    const backup = path.join(f.gameRoot, '_DLSS5_Backup', 'original-addon.bin');
    fs.writeFileSync(backup, 'original old Core');
    row.original = { existed: true, backupRel: path.relative(f.gameRoot, backup), sha256: sha('original old Core') };
    fs.writeFileSync(manifestPath(f.gameRoot), JSON.stringify(f.manifest));
    const installer = createInstaller({ guards: f.options.guards, pe: { getBitness: () => 64 } });
    const preview = await installer.previewUninstall({ gameDir: f.gameRoot, mode });
    const change = preview.changes.find(value => value.name === INSTALLED_NAMES.addon);
    assert.equal(change.afterSha256, mode === 'restore' ? sha('original old Core') : null);
    const result = await installer.uninstall({ gameDir: f.gameRoot, mode, scan: f.game.scan });
    assert.equal(result.removed, true);
    if (mode === 'restore') assert.equal(fs.readFileSync(path.join(f.dir, INSTALLED_NAMES.addon), 'utf8'), 'original old Core');
    else assert.equal(fs.existsSync(path.join(f.dir, INSTALLED_NAMES.addon)), false);
    assert.equal(fs.readFileSync(backup, 'utf8'), 'original old Core');
    assert.equal(fs.readFileSync(path.join(f.dir, 'unknown.dll.bak'), 'utf8'), 'unproven backup must stay');
  }
});
