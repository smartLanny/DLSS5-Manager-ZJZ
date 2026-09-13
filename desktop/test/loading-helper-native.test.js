'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { createExternalRuntime } = require('../src/product/external-runtime');
const { newManifest, manifestPath } = require('../src/product/manifest');
const { INSTALLED_NAMES } = require('../src/product/constants');
const { createLoadingHelper } = require('../src/product/loading-helper');
const { createLaunchSessions } = require('../src/product/launch-session');
const { createGameProcesses } = require('../src/product/game-processes');
const { createRuntimeVerification } = require('../src/product/runtime-verification');
const { createFgComponents } = require('../src/product/fg-components');
const { ADDON: MFG_ADDON } = require('../src/product/fg-mfgunlock-resources');
const binaries = path.resolve(__dirname, '../build/load-helper');
const available = process.platform === 'win32' && ['fixture-target.exe', 'fixture-module.dll', 'dlss5-load-helper.exe'].every(name => fs.existsSync(path.join(binaries, name)));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-helper-')), gameDir = path.join(dir, '中文 游戏'); fs.mkdirSync(gameDir);
  const target = path.join(gameDir, 'fixture-target.exe'), loader = path.join(dir, 'fixture-module.dll'), config = path.join(dir, 'ReShade.ini');
  fs.copyFileSync(path.join(binaries, 'fixture-target.exe'), target); fs.copyFileSync(path.join(binaries, 'fixture-module.dll'), loader); fs.writeFileSync(config, '[ADDON]\nAddonPath=.\n');
  const children = [], cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    for (const child of children) if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true });
  });
  const game = (exe = target, args = []) => { const child = spawn(exe, args, { windowsHide: true, stdio: 'ignore' }); children.push(child); return child; };
  function run(overrides = {}, extraArgs = []) {
    const args = { '--session': crypto.randomUUID(), '--target': target, '--target-sha': sha(target), '--loader': loader, '--loader-sha': sha(loader),
      '--config': config, '--config-sha': sha(config), '--timeout': '3000', ...overrides };
    const events = [], waits = [], child = spawn(path.join(binaries, 'dlss5-load-helper.exe'), [...Object.entries(args).flat(), ...extraArgs], { windowsHide: true });
    children.push(child); let text = ''; const decoder = new StringDecoder('utf8');
    child.stdout.on('data', buffer => { text += decoder.write(buffer); const lines = text.split(/\r?\n/); text = lines.pop(); for (const line of lines) {
      const event = JSON.parse(line); const waiting = waits.shift(); if (waiting) waiting(event); else events.push(event);
    } });
    const next = () => events.length ? Promise.resolve(events.shift()) : new Promise(resolve => waits.push(resolve));
    const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
    return { child, args, next, exited, events };
  }
  return { target, loader, config, dir, game, run, cleanup: callback => cleanups.push(callback) };
}
test('native helper Ready is bound to identity and loads only its fixture module without ending game', { skip: !available }, async t => {
  const f = fixture(t), original = fs.readFileSync(f.config), helper = f.run({ '--timeout': '300000' });
  const ready = await helper.next(); assert.equal(ready.event, 'ready'); assert.equal(ready.targetExe, f.target); assert.equal(ready.configHash, sha(f.config)); assert.equal(ready.elevatedTarget, false);
  const game = f.game(), attached = await helper.next(); assert.equal(attached.event, 'attached'); assert.equal(attached.gamePid, game.pid); assert.equal(attached.elevatedTarget, false);
  assert.equal(await helper.exited, 0); assert.equal(game.exitCode, null); assert.deepEqual(fs.readFileSync(f.config), original);
});
test('native helper refuses hash mismatch before Ready and leaves the file bytes unchanged', { skip: !available }, async t => {
  const f = fixture(t), before = fs.readFileSync(f.loader), helper = f.run({ '--loader-sha': '0'.repeat(64) });
  assert.equal((await helper.next()).event, 'failed'); assert.equal(await helper.exited, 3); assert.deepEqual(fs.readFileSync(f.loader), before);
});
test('native helper refuses an already running target and never terminates it', { skip: !available }, async t => {
  const f = fixture(t), game = f.game(); await new Promise(resolve => game.once('spawn', resolve));
  const helper = f.run(), event = await helper.next(); assert.equal(event.event, 'failed'); assert.equal(event.error, 183);
  assert.equal(await helper.exited, 4); assert.equal(game.exitCode, null);
});

test('native helper rejects another ready manager for the exact target before either game is launched', { skip: !available }, async t => {
  const f = fixture(t), first = f.run(); assert.equal((await first.next()).event, 'ready');
  const second = f.run(), refused = await second.next(); assert.equal(refused.event, 'failed'); assert.equal(refused.error, 170);
  assert.equal(await second.exited, 4);
  const game = f.game(), result = await first.next(); assert.equal(result.event, 'attached'); assert.equal(result.gamePid, game.pid);
  assert.equal(await first.exited, 0); assert.equal(game.exitCode, null);
});

for (const kind of ['same-sha', 'reshade-exports', 'ordinary-dxgi']) test(`native helper checks ${kind} module identity without terminating its target`, { skip: !available }, async t => {
  const f = fixture(t), source = path.join(binaries, kind === 'reshade-exports' ? 'fixture-reshade.dll' : 'fixture-neutral.dll');
  assert.equal(fs.existsSync(source), true);
  const existing = path.join(path.dirname(f.target), kind === 'ordinary-dxgi' ? 'dxgi.dll' : path.basename(source)); fs.copyFileSync(source, existing);
  if (kind !== 'ordinary-dxgi') fs.copyFileSync(path.join(binaries, kind === 'same-sha' ? 'fixture-preloaded-neutral.exe' : 'fixture-preloaded-reshade.exe'), f.target);
  if (kind === 'same-sha') fs.copyFileSync(source, f.loader);
  const helper = f.run(); assert.equal((await helper.next()).event, 'ready');
  // Static imports make the conflicting module an image-load dependency,
  // instead of racing an unrelated later LoadLibrary in the target's main.
  const game = f.game(f.target, kind === 'ordinary-dxgi' ? ['4500', existing] : ['4500']), result = await helper.next();
  assert.equal(result.gamePid, game.pid);
  assert.equal(result.event, kind === 'ordinary-dxgi' ? 'attached' : 'failed');
  if (kind !== 'ordinary-dxgi') assert.equal(result.error, 183);
  assert.equal(await helper.exited, kind === 'ordinary-dxgi' ? 0 : 6); assert.equal(game.exitCode, null);
  assert.equal(sha(existing), sha(source));
});
test('native helper ignores another EXE with the same filename and preserves its process', { skip: !available }, async t => {
  const f = fixture(t), otherDir = path.join(f.dir, 'other'); fs.mkdirSync(otherDir); const other = path.join(otherDir, path.basename(f.target)); fs.copyFileSync(f.target, other);
  const helper = f.run({ '--timeout': '1000' }); assert.equal((await helper.next()).event, 'ready');
  const game = f.game(other), failure = await helper.next(); assert.equal(failure.event, 'failed'); assert.equal(failure.error, 258);
  assert.equal(await helper.exited, 7); assert.equal(game.exitCode, null);
});
test('native helper rejects malformed session and out-of-range timeout values before Ready', { skip: !available }, async t => {
  const f = fixture(t);
  for (const args of [{ '--timeout': '1000suffix' }, { '--timeout': '999' }, { '--timeout': '300001' }, { '--session': '-'.repeat(36) }]) {
    const helper = f.run(args), event = await helper.next(); assert.equal(event.event, 'failed'); assert.equal(event.error, 87); assert.equal(await helper.exited, 2);
  }
});

test('ordinary native helper refuses an explicit elevated target before Ready and binds the rejected mode', { skip: !available }, async t => {
  const f = fixture(t), before = [f.target, f.loader, f.config].map(sha), helper = f.run({ '--elevated-target': '1' });
  const failure = await helper.next();
  assert.equal(failure.event, 'failed'); assert.equal(failure.elevatedTarget, true); assert.equal(failure.error, 87); assert.equal(failure.gamePid, 0);
  assert.equal(await helper.exited, 2); assert.deepEqual([f.target, f.loader, f.config].map(sha), before);
});

test('native helper rejects malformed or ambiguous elevated options before any Ready event', { skip: !available }, async t => {
  const f = fixture(t);
  for (const value of ['0', 'true', '', '2', '1suffix']) {
    const helper = f.run({ '--elevated-target': value }); assert.equal(await helper.exited, 2); assert.deepEqual(helper.events, []);
  }
  for (const args of [['--elevated-target'], ['--elevated-target', '1', '--elevated-target', '1'], ['--unknown-mode', '1']]) {
    const helper = f.run({}, args); assert.equal(await helper.exited, 2); assert.deepEqual(helper.events, []);
  }
});
test('native helper detects configuration mutation after Ready and preserves the new target', { skip: !available }, async t => {
  const f = fixture(t), helper = f.run(); assert.equal((await helper.next()).event, 'ready');
  fs.appendFileSync(f.config, '; changed after Ready\n'); const game = f.game(), event = await helper.next();
  assert.equal(event.event, 'failed'); assert.equal(event.error, 1006); assert.equal(await helper.exited, 3); assert.equal(game.exitCode, null);
});

for (const [api, mutateAfterReady] of [['dx11', false], ['dx12', false], ['dx12', true]]) test(`${api} external profile -> JS Ready -> native fixture ${mutateAfterReady ? 'failure' : 'load'} -> restore preserves game and history`, { skip: !available, timeout: 45000 }, async t => {
  const f = fixture(t), gameRoot = path.dirname(f.target), userData = path.join(f.dir, 'manager-data');
  const originalIni = '[ADDON]\nAddonPath=.\n[GENERAL]\nPresetPath=.\\MyPreset.ini\n';
  fs.writeFileSync(path.join(gameRoot, 'ReShade.ini'), originalIni);
  // A harmless fixture DLL, with a discovery marker solely for exercising the
  // deployment path. It does not implement ReShade, Core, or NR rendering.
  const proxy = path.join(gameRoot, 'dxgi.dll'); fs.copyFileSync(f.loader, proxy); fs.appendFileSync(proxy, '\nSearching for add-ons\n');
  const manifest = newManifest(gameRoot, f.target, api); manifest.payloadVersion = 'native-fixture'; manifest.deploymentApi = api;
  for (const kind of ['addon', 'bridge', 'runtime', 'config', ...(api === 'dx11' ? ['carrier'] : [])]) {
    const file = path.join(gameRoot, INSTALLED_NAMES[kind]);
    if (kind === 'config') fs.writeFileSync(file, '[NRBeforeSR]\nEnabled=1\n'); else fs.copyFileSync(f.loader, file);
    manifest.files.push({ rel: path.basename(file), kind, installedSha256: sha(file), original: { existed: false } });
  }
  fs.mkdirSync(path.dirname(manifestPath(gameRoot)), { recursive: true }); fs.writeFileSync(manifestPath(gameRoot), JSON.stringify(manifest));
  const game = { id: 'native-fixture', dir: gameRoot, exe: f.target, chosen: { path: f.target, bitness: 64, apiResolution: { api } } };
  const deployment = createExternalRuntime({ userData, guards: { assertGameClosed: async () => {} },
    publish: (source, destination) => fs.promises.rename(source, destination) });
  const preview = await deployment.preview(game, { mode: 'external', loadingMode: 'helper' }); await deployment.apply(preview.planId);
  const layout = deployment.getLayout(game); assert.equal(layout.verified, true); assert.equal(layout.loadingMode, 'helper');
  const mfg = createFgComponents({ appDir: path.resolve(__dirname, '..'), gameDirectory: () => gameRoot, gameExecutable: () => f.target,
    getLayout: () => deployment.getLayout(game), assertGameClosed: async () => {}, antiCheatPresent: () => false,
    detectHardware: async () => ({ series: ['RTX40'] }), scan: async () => ({ api, chosen: { path: f.target, bitness: 64, apiResolution: { api } }, streamlineFg: true, reshadeAddon: true }),
    getFeatureEvidence: async () => ({ support: { status: 'supported', source: 'native-integration',
      capabilities: { mfgUnlock: { available: api === 'dx12', multipliers: [2, 3, 4] } } } }),
    inspectFgRuntime: async () => ({ status: 'available', ready: true, fixture: true }) });
  const withMfgOwner = api === 'dx12' && !mutateAfterReady;
  if (withMfgOwner) { await mfg.prepare(game.id); assert.equal(layout.moduleManifest.some(row => row.name === MFG_ADDON), false); }
  const helper = createLoadingHelper({ appDir: path.resolve(__dirname, '..'), getLayout: () => deployment.getLayout(game), inspectDeployment: () => deployment.inspect(game),
    additionalModules: () => mfg.ownedModuleManifest(game.id) });
  let helperSession, helperClosed, child;
  const adapter = { ...helper, prepare: async request => { helperSession = await helper.prepare(request); return helperSession; },
    start: async (...args) => { const ready = await helper.start(...args); helperClosed = new Promise(resolve => helperSession.child.once('close', resolve)); return ready; } };
  const processes = createGameProcesses(), verification = createRuntimeVerification({ layout: () => deployment.getLayout(game), processes });
  const statuses = [], launches = createLaunchSessions({ userData, processes, helper: adapter, pollMs: 30, timeoutMs: 8000,
    game: async () => ({ exe: f.target, launchMode: 'exe', helper: { gameId: game.id } }),
    beforeLaunch: (id, session) => verification.prepare(id, session), emit: session => statuses.push(session.status),
    broker: { launch: async () => {
      assert.equal(helperSession.state, 'ready');
      if (mutateAfterReady) fs.appendFileSync(layout.activeConfigPath, '\n; fixture changed after Ready\n');
      child = f.game(f.target, ['8000']);
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); return { pid: child.pid };
    } } });
  f.cleanup(() => launches.dispose());
  const session = await launches.start(game.id); await helperClosed;
  assert.equal(helperSession.state, mutateAfterReady ? 'failed' : 'attached'); assert.equal(session.process.pid, child.pid);
  if (withMfgOwner) assert.equal(helperSession.modules.find(row => row.role === 'mfgunlock').status, 'enabled');
  if (!mutateAfterReady) assert.equal(session.helper.configHash, sha(layout.activeConfigPath));
  else { assert.equal(session.status, 'enhancement-failed'); assert.equal(session.gamePreserved, true); }
  assert.ok(statuses.indexOf('waiting-helper') < statuses.indexOf('request-sending')); assert.equal(child.exitCode, null);
  const observed = await processes.observe(session.process); assert.equal(observed.modules.some(file => file.toLowerCase() === layout.loaderPath.toLowerCase()), !mutateAfterReady);
  const result = await verification.assess(game.id, session); assert.equal(result.helper.status, mutateAfterReady ? 'failed' : 'passed'); assert.equal(result.core.status, 'unverified'); assert.equal(result.nr.status, 'unverified');
  await launches.dispose(); assert.equal(child.exitCode, null); assert.equal(fs.existsSync(layout.loaderPath), true);
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('close', resolve); });
  if (withMfgOwner) { await mfg.restore(game.id); assert.equal(fs.existsSync(path.join(layout.addonDirectory, MFG_ADDON)), false); }
  await deployment.restore(game); assert.equal(deployment.getLayout(game).mode, 'local');
  const restoredIni = fs.readFileSync(path.join(gameRoot, 'ReShade.ini'), 'utf8');
  if (mutateAfterReady) { assert.ok(restoredIni.startsWith(originalIni)); assert.match(restoredIni, /fixture changed after Ready/); }
  else assert.equal(restoredIni, originalIni);
  assert.equal(fs.existsSync(path.join(gameRoot, 'dxgi.dll')), true); assert.equal((await deployment.inspect(game)).baseline.version, 'native-fixture');
});
