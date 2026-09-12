'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createGamePreparation } = require('../src/product/game-preparation');
const { inspectNativeEnhancementCapabilities } = require('../src/product/game-enhancement-capabilities');
const clone = value => JSON.parse(JSON.stringify(value));
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// Minimal, non-executed PE32+ fixture. Capability inspection reads the real
// DOS/COFF/optional headers; a filename or scanner bitness flag is insufficient.
function peBytes(machine = 0x8664) {
  const bytes = Buffer.alloc(512); bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x4550, 0x80); bytes.writeUInt16LE(machine, 0x84); bytes.writeUInt16LE(0xf0, 0x94);
  bytes.writeUInt16LE(machine === 0x8664 ? 0x20b : 0x10b, 0x98); return bytes;
}
function fixture(t, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'game-preparation-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, 'game'), dir = path.join(game, 'Bin'), exe = path.join(dir, 'Game.exe'), userData = path.join(root, 'user');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(userData); fs.writeFileSync(exe, peBytes());
  const paths = { nr: path.join(dir, 'nr-owned.addon64'), feeder: path.join(dir, 'feeder-owned.json'), vulkan: path.join(dir, 'vulkan-owned.json'),
    sr: path.join(dir, 'sr-request.json'), fg: path.join(dir, 'fg-request.json'), fgComponents: path.join(dir, 'mfg-owned.addon64'), settings: path.join(userData, 'settings.json') };
  const scan = { dlssFiles: [], streamlineFiles: [], chosen: { path: exe, bitness: 64 } }, calls = [], controls = { failAt: null, restoreFailure: null, running: false, ...config };
  const addEvidence = (name, section, sub = '', body = peBytes()) => {
    const file = path.join(dir, sub, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body);
    const row = { path: file, name, bitness: 64 }; scan[section].push(row); return file;
  };
  if (config.sr !== false) addEvidence('nvngx_dlss.dll', 'dlssFiles');
  if (config.fg !== false) { addEvidence('nvngx_dlssg.dll', 'dlssFiles'); addEvidence('sl.dlss_g.dll', 'streamlineFiles'); addEvidence('sl.interposer.dll', 'streamlineFiles'); }
  let componentStatus = { route: config.gpu === 'RTX50' ? 'native' : 'compatibility', ready: false, canPrepare: true, needsCleanup: false, blockers: [], ...config.componentStatus };
  const readSettings = () => fs.existsSync(paths.settings) ? JSON.parse(fs.readFileSync(paths.settings, 'utf8')) : { applied: {}, requests: {} };
  const writeSettings = value => fs.writeFileSync(paths.settings, JSON.stringify(value));
  function mark(name) { calls.push(name); if (controls.failAt === name || controls.restoreFailure === name) throw Object.assign(new Error(`injected ${name}`), { code: `FAIL_${name}` }); }
  function installDomain(domain, value) {
    const state = readSettings(); state.applied[domain] = { backend: value.backend, request: value }; fs.writeFileSync(paths[domain], JSON.stringify(value)); writeSettings(state);
  }
  const plans = new Map();
  const settings = {
    assertReady: async () => { if (controls.settingsPending) throw Object.assign(new Error('settings pending'), { code: 'SETTINGS_PENDING' }); },
    inspect: async () => ({ ...clone(readSettings()), legacy: config.legacy || null, hardware: { family: config.gpu || 'RTX40', series: [config.gpu || 'RTX40'], source: 'fixture' } }),
    preview: async (id, domain, request) => { mark(`preview-${domain}`); const plan = { id: `${domain}-${plans.size}`, domain, request }; plans.set(plan.id, plan); return plan; },
    apply: async planId => { const plan = plans.get(planId); mark(`apply-${plan.domain}`); installDomain(plan.domain, plan.request); mark(`applied-${plan.domain}`); return { applied: true }; },
    save: async (id, domain, request) => { mark(`save-${domain}`); const state = readSettings(); state.requests[domain] = { request }; writeSettings(state); },
    restore: async (id, domain) => { mark(`restore-${domain}`); const state = readSettings(); delete state.applied[domain]; delete state.requests[domain]; writeSettings(state); fs.rmSync(paths[domain], { force: true }); return { restored: true }; }
  };
  const service = {
    gameExecutable: () => exe, gameDirectory: () => game, gameScan: () => scan,
    listGames: async () => [{ id: 'g', chosen: { path: exe }, installed: fs.existsSync(paths.nr), feeder: { installed: fs.existsSync(paths.feeder) }, vulkan: { installed: fs.existsSync(paths.vulkan) } }],
    applyGameRoute: async () => { mark('install-nr'); fs.writeFileSync(paths.nr, 'new NR'); mark('installed-nr'); return { installed: true }; },
    installFeeder: async () => { mark('install-feeder'); fs.writeFileSync(paths.feeder, 'new Feeder NR'); mark('installed-feeder'); return { installed: true }; },
    uninstall: async () => { mark('uninstall-nr'); fs.rmSync(paths.nr, { force: true }); fs.rmSync(paths.vulkan, { force: true }); return { restored: true }; },
    restoreFeeder: async () => { mark('restore-feeder'); fs.rmSync(paths.feeder, { force: true }); return { restored: true }; },
    refreshAfterMutation: async result => ({ ...result, refreshed: true })
  };
  const components = {
    inspect: async () => ({ ...componentStatus, ready: componentStatus.ready || fs.existsSync(paths.fgComponents), managed: fs.existsSync(paths.fgComponents), receipt: fs.existsSync(paths.fgComponents) }),
    restore: async () => { mark('restore-fg-components'); fs.rmSync(paths.fgComponents, { force: true }); return { restored: true }; }
  };
  const fgWorkflow = {
    apply: async (id, request) => { mark('prepare-fg'); if (!fs.existsSync(paths.fgComponents)) fs.writeFileSync(paths.fgComponents, 'new MFG'); installDomain('fg', request);
      const state = readSettings(); state.requests.fg = { request }; writeSettings(state); mark('prepared-fg'); return { prepared: true }; }
  };
  const dependencies = { userData, service, settings, components, fgWorkflow, assertClosed: async () => { if (controls.running) throw Object.assign(new Error('running'), { code: 'GAME_RUNNING' }); } };
  const preparation = createGamePreparation(dependencies);
  const seed = (domain, text = `existing ${domain}`) => fs.writeFileSync(paths[domain], text);
  const seedSetting = (domain, request, { applied = true, saved = true } = {}) => {
    const state = readSettings(); if (applied) state.applied[domain] = { backend: request.backend, request };
    if (saved) state.requests[domain] = { request }; writeSettings(state); fs.writeFileSync(paths[domain], JSON.stringify(request));
  };
  return { root, game, dir, exe, userData, paths, scan, calls, controls, dependencies, preparation, service, settings, seed, seedSetting, readSettings, addEvidence,
    setComponentStatus: value => { componentStatus = { ...componentStatus, ...value }; } };
}
function stages(result) { return Object.fromEntries(result.stages.map(row => [row.domain, row])); }
function snapshot(f) { return new Map(Object.values(f.paths).map(file => [file, fs.existsSync(file) ? fs.readFileSync(file) : null])); }
function assertSnapshot(before) { for (const [file, data] of before) assert.deepEqual(fs.existsSync(file) ? fs.readFileSync(file) : null, data, file); }

test('SR failure compensates its partial write before removing only this attempt NR', async t => {
  const f = fixture(t, { failAt: 'applied-sr' });
  assert.deepEqual(inspectNativeEnhancementCapabilities(f.scan), { nativeDlssAvailable: true, nativeFgAvailable: true, staticOnly: true });
  await assert.rejects(f.preparation.prepare('g'), error => error.code === 'FAIL_applied-sr' && error.details.preparationRolledBack === true && error.details.gameStarted === false);
  assert.equal(fs.existsSync(f.paths.nr), false); assert.equal(fs.existsSync(f.paths.sr), false); assert.equal(fs.existsSync(f.paths.fgComponents), false);
  assert.ok(f.calls.indexOf('restore-sr') < f.calls.indexOf('uninstall-nr')); assert.equal(f.calls.includes('prepare-fg'), false);
  assert.equal((await f.preparation.inspect('g')).pending, false);
});

test('an existing NR install survives a new SR failure', async t => {
  const f = fixture(t, { failAt: 'applied-sr' }); f.seed('nr', 'original NR and user choices');
  await assert.rejects(f.preparation.prepare('g'), { code: 'FAIL_applied-sr' });
  assert.equal(fs.readFileSync(f.paths.nr, 'utf8'), 'original NR and user choices'); assert.equal(f.calls.includes('install-nr'), false); assert.equal(f.calls.includes('uninstall-nr'), false);
});

test('existing NR, saved SR, FG and MFG components are retained byte-for-byte', async t => {
  const f = fixture(t); f.seed('nr'); f.seed('fgComponents');
  f.seedSetting('sr', { backend: 'native', quality: 'performance', preset: 'M' }, { applied: false });
  f.seedSetting('fg', { backend: 'mfgunlock', mode: 'fixed', multiplier: 4 }); const before = snapshot(f);
  const result = await f.preparation.prepare('g'); assert.deepEqual(f.calls, []); assertSnapshot(before);
  assert.deepEqual(result.stages.map(row => row.status), ['retained', 'retained', 'retained']); assert.equal(result.runtimeVerified, false);
});

test('later FG failure keeps the existing NR, SR request and component while undoing only new FG settings', async t => {
  const f = fixture(t, { failAt: 'prepared-fg' }); f.seed('nr'); f.seed('fgComponents');
  f.seedSetting('sr', { backend: 'native', quality: 'balanced', preset: 'auto' });
  const nr = fs.readFileSync(f.paths.nr), sr = fs.readFileSync(f.paths.sr), comp = fs.readFileSync(f.paths.fgComponents);
  await assert.rejects(f.preparation.prepare('g'), { code: 'FAIL_prepared-fg' });
  assert.deepEqual(fs.readFileSync(f.paths.nr), nr); assert.deepEqual(fs.readFileSync(f.paths.sr), sr); assert.deepEqual(fs.readFileSync(f.paths.fgComponents), comp);
  assert.equal(f.calls.includes('restore-sr'), false); assert.equal(f.calls.includes('restore-fg-components'), false); assert.equal(f.calls.includes('uninstall-nr'), false);
  assert.equal(own(f.readSettings().applied, 'fg'), false);
});

test('native FG eligibility is independent of native DLSS SR', async t => {
  const f = fixture(t, { sr: false });
  assert.deepEqual(inspectNativeEnhancementCapabilities(f.scan), { nativeDlssAvailable: false, nativeFgAvailable: true, staticOnly: true });
  const result = await f.preparation.prepare('g'); const rows = stages(result);
  assert.equal(rows.sr.status, 'unavailable'); assert.equal(rows.fg.status, 'prepared'); assert.equal(f.calls.includes('preview-sr'), false); assert.equal(f.calls.includes('prepare-fg'), true);
});

test('FG resource mismatch skips FG with its reason and keeps successful NR and SR', async t => {
  const reason = 'MFG Unlock 资源校验失败：renodx-mfgunlock.addon64';
  const f = fixture(t, { componentStatus: { ready: false, canPrepare: false, blockers: [reason] } });
  const result = await f.preparation.prepare('g'), rows = stages(result);
  assert.equal(rows.nr.status, 'prepared'); assert.equal(rows.sr.status, 'prepared'); assert.equal(rows.fg.status, 'unavailable'); assert.equal(rows.fg.message, reason);
  assert.equal(fs.existsSync(f.paths.nr), true); assert.equal(fs.existsSync(f.paths.sr), true); assert.equal(fs.existsSync(f.paths.fgComponents), false); assert.equal(f.calls.includes('prepare-fg'), false);
  assert.equal((await f.preparation.inspect('g')).pending, false);
});

test('Feeder contributes NR only and its private NVIDIA DLLs never create native SR or FG eligibility', async t => {
  const f = fixture(t, { sr: false, fg: false });
  f.addEvidence('nvngx_dlss.dll', 'dlssFiles', '_DLSS5_Feeder'); f.addEvidence('nvngx_dlssg.dll', 'dlssFiles', '_DLSS5_Feeder');
  f.addEvidence('sl.dlss_g.dll', 'streamlineFiles', '_DLSS5_Feeder'); f.addEvidence('sl.common.dll', 'streamlineFiles', '_DLSS5_Feeder');
  assert.deepEqual(inspectNativeEnhancementCapabilities(f.scan), { nativeDlssAvailable: false, nativeFgAvailable: false, staticOnly: true });
  const result = await f.preparation.prepare('g', { route: 'feeder' });
  assert.deepEqual(f.calls, ['install-feeder', 'installed-feeder']); assert.equal(stages(result).nr.status, 'prepared'); assert.equal(stages(result).sr.status, 'unavailable'); assert.equal(stages(result).fg.status, 'unavailable');
  assert.equal(fs.existsSync(f.paths.nr), false); assert.equal(fs.existsSync(f.paths.feeder), true);
});

test('existing Feeder and Vulkan installations count as an existing NR baseline', async t => {
  for (const route of ['feeder', 'vulkan']) {
    const f = fixture(t, { sr: route !== 'feeder', fg: false }); f.seed(route, `original ${route}`);
    const result = await f.preparation.prepare('g', route === 'feeder' ? { route: 'feeder' } : {});
    assert.equal(stages(result).nr.status, 'retained', route); assert.equal(fs.readFileSync(f.paths[route], 'utf8'), `original ${route}`);
    assert.equal(f.calls.includes('install-nr'), false, route); assert.equal(f.calls.includes('install-feeder'), false, route);
  }
});

test('Feeder request is rejected when actual native DLSS exists before creating a ledger', async t => {
  const f = fixture(t); await assert.rejects(f.preparation.prepare('g', { route: 'feeder' }), { code: 'PREPARATION_ROUTE' });
  assert.deepEqual(f.calls, []); assert.equal((await f.preparation.inspect('g')).pending, false);
});

test('x86 or non-PE DLLs do not qualify simply because scanner metadata says 64-bit', async t => {
  const f = fixture(t, { sr: false, fg: false });
  f.addEvidence('nvngx_dlss.dll', 'dlssFiles', '', Buffer.from('not a PE'));
  f.addEvidence('nvngx_dlssg.dll', 'dlssFiles', '', peBytes(0x14c)); f.addEvidence('sl.dlss_g.dll', 'streamlineFiles'); f.addEvidence('sl.interposer.dll', 'streamlineFiles');
  const result = await f.preparation.prepare('g'); assert.equal(stages(result).sr.status, 'unavailable'); assert.equal(stages(result).fg.status, 'unavailable');
  assert.equal(f.calls.includes('preview-sr'), false); assert.equal(f.calls.includes('prepare-fg'), false);
});

test('failed recovery keeps the ledger, blocks another install and blocks the launch readiness guard', async t => {
  const f = fixture(t, { failAt: 'applied-sr', restoreFailure: 'restore-sr' });
  await assert.rejects(f.preparation.prepare('g'), error => error.code === 'PREPARATION_RECOVERY_REQUIRED' && error.details.recoveryCode === 'FAIL_restore-sr');
  assert.equal(fs.existsSync(f.paths.nr), true); assert.equal(f.calls.includes('uninstall-nr'), false);
  const restarted = createGamePreparation(f.dependencies), before = f.calls.length;
  assert.equal((await restarted.inspect('g')).pending, true); await assert.rejects(restarted.assertReady('g'), { code: 'PREPARATION_PENDING' });
  await assert.rejects(restarted.prepare('g'), { code: 'PREPARATION_PENDING' }); assert.equal(f.calls.length, before);
  await assert.rejects(restarted.recover('g'), { code: 'FAIL_restore-sr' }); assert.equal((await restarted.inspect('g')).pending, true);
  f.controls.restoreFailure = null; f.controls.failAt = null;
  const recovered = await restarted.recover('g'); assert.equal(recovered.restored, true); assert.equal(recovered.refreshed, true);
  assert.equal(fs.existsSync(f.paths.nr), false); assert.equal(fs.existsSync(f.paths.sr), false); await restarted.assertReady('g');
  assert.deepEqual(await restarted.recover('g'), { restored: false, unchanged: true });
});

test('process interruption after an effect leaves recoverable intent for a new service instance', async t => {
  for (const crashAt of ['nr', 'sr']) {
    const f = fixture(t, { fg: false });
    const script = `
      const fs = require('node:fs');
      const { createGamePreparation } = require(${JSON.stringify(require.resolve('../src/product/game-preparation'))});
      const p = ${JSON.stringify(f.paths)}, scan = ${JSON.stringify(f.scan)};
      const service = { gameExecutable: () => ${JSON.stringify(f.exe)}, gameDirectory: () => ${JSON.stringify(f.game)}, gameScan: () => scan,
        listGames: async () => [{ id: 'g', chosen: scan.chosen, installed: false }],
        applyGameRoute: async () => { fs.writeFileSync(p.nr, 'NR written before crash'); if (${JSON.stringify(crashAt)} === 'nr') process.exit(86); },
        refreshAfterMutation: async r => r };
      const settings = { assertReady: async () => {}, inspect: async () => ({ applied: {}, requests: {}, hardware: { series: ['RTX40'] } }),
        preview: async () => ({id:'sr-plan'}), apply: async () => { const request = {backend:'native',quality:'quality',preset:'auto'};
          fs.writeFileSync(p.sr, JSON.stringify(request)); fs.writeFileSync(p.settings, JSON.stringify({applied:{sr:{backend:'native',request}},requests:{}})); process.exit(86); } };
      const components = { inspect: async () => ({ route: 'compatibility', managed: false, ready: false, canPrepare: false }) };
      createGamePreparation({ userData: ${JSON.stringify(f.userData)}, service, settings, components, fgWorkflow:{}, assertClosed: async () => {} }).prepare('g')
        .then(() => process.exit(87)).catch(error => { process.stderr.write(error.stack); process.exit(88); });
    `;
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(child.status, 86, child.stderr || child.error?.message);
    const restarted = createGamePreparation(f.dependencies), state = await restarted.inspect('g');
    assert.equal(state.pending, true, crashAt); assert.equal(fs.existsSync(f.paths.nr), true);
    await assert.rejects(restarted.assertReady('g'), { code: 'PREPARATION_PENDING' });
    const recovered = await restarted.recover('g'); assert.equal(recovered.restored, true); assert.equal(fs.existsSync(f.paths.nr), false); assert.equal(fs.existsSync(f.paths.sr), false);
    if (crashAt === 'sr') assert.ok(f.calls.indexOf('restore-sr') < f.calls.indexOf('uninstall-nr'));
    assert.equal((await restarted.inspect('g')).pending, false);
  }
});

test('running game cannot begin or recover preparation and its ledger remains available', async t => {
  const f = fixture(t); f.controls.running = true;
  await assert.rejects(f.preparation.prepare('g'), { code: 'GAME_RUNNING' }); assert.equal((await f.preparation.inspect('g')).pending, false);
  f.controls.running = false; f.controls.failAt = 'applied-sr'; f.controls.restoreFailure = 'restore-sr';
  await assert.rejects(f.preparation.prepare('g'), { code: 'PREPARATION_RECOVERY_REQUIRED' });
  f.controls.running = true; const before = f.calls.length;
  await assert.rejects(createGamePreparation(f.dependencies).recover('g'), { code: 'GAME_RUNNING' }); assert.equal(f.calls.length, before); assert.equal((await f.preparation.inspect('g')).pending, true);
});

test('one-click retains an older SR selection and its captured baseline', async t => {
  for (const legacy of [{configured:true}, {baselineCaptured:true}, {error:{code:'OLD_RECORD'}}]) {
    const f = fixture(t, {legacy,fg:false}); f.seed('sr', 'older SR policy');
    const result = await f.preparation.prepare('g');
    assert.equal(stages(result).sr.status, 'retained');
    assert.equal(fs.readFileSync(f.paths.sr,'utf8'), 'older SR policy');
    assert.equal(f.calls.includes('preview-sr'),false);
  }
});

test('explicit recovery completes the underlying journal before scoped compensation', async t => {
  const f = fixture(t, {failAt:'applied-sr',restoreFailure:'restore-sr'});
  await assert.rejects(f.preparation.prepare('g'), {code:'PREPARATION_RECOVERY_REQUIRED'});
  f.controls.failAt = null; f.controls.restoreFailure = null; f.controls.settingsPending = true;
  const order = [];
  f.settings.pending = async () => [{kind:'file-journal'}];
  f.settings.recover = async () => {order.push('journal-recovered'); f.controls.settingsPending = false;};
  f.service.refresh = async () => {order.push('refreshed');};
  await f.preparation.recover('g');
  assert.deepEqual(order,['journal-recovered','refreshed']);
  assert.equal((await f.preparation.inspect('g')).pending,false);
  assert.equal(fs.existsSync(f.paths.nr),false);
});

test('one-click recovery resolves REFramework through its owner before completing compensation', async t => {
  const f=fixture(t,{failAt:'applied-sr',restoreFailure:'restore-sr'});
  await assert.rejects(f.preparation.prepare('g'),{code:'PREPARATION_RECOVERY_REQUIRED'});
  f.controls.failAt=null; f.controls.restoreFailure=null;f.controls.settingsPending=true;
  const order=[];let refPending=true;
  f.settings.pending=async()=>[{kind:'file-journal'}];
  f.settings.recover=async()=>{order.push('settings-recover');if(refPending)throw Object.assign(new Error('use owner'),{code:'REF_RECOVERY_REQUIRED'});f.controls.settingsPending=false;};
  f.service.recoverReframework=async()=>{order.push('ref-owner');refPending=false;};f.service.refresh=async()=>{};
  await f.preparation.recover('g');
  assert.deepEqual(order,['settings-recover','ref-owner','settings-recover']);
  assert.equal((await f.preparation.inspect('g')).pending,false);assert.equal(fs.existsSync(f.paths.nr),false);
});

test('one-click recovery dispatches FG file ownership before compensating native or Feeder NR', async t => {
  for (const route of ['native', 'feeder']) {
    const f = fixture(t, { sr: route !== 'feeder', failAt: 'prepared-fg', restoreFailure: 'restore-fg' });
    await assert.rejects(f.preparation.prepare('g', { route }), { code: 'PREPARATION_RECOVERY_REQUIRED' });
    f.controls.failAt = null; f.controls.restoreFailure = null; f.controls.settingsPending = true;
    const order = []; let filePending = true;
    f.settings.pending = async () => [{ kind: 'file-journal' }];
    f.settings.recover = async () => { order.push('settings-recover'); if (filePending) throw Object.assign(new Error('use FG owner'), { code: 'SETTINGS_FG_FILE_RECOVERY_REQUIRED' }); f.controls.settingsPending = false; };
    f.dependencies.components.recoverPending = async () => { order.push('fg-owner'); filePending = false; };
    f.service.refresh = async () => {};
    await f.preparation.recover('g');
    assert.deepEqual(order, ['settings-recover', 'fg-owner', 'settings-recover'], route);
    assert.equal((await f.preparation.inspect('g')).pending, false);
    assert.equal(fs.existsSync(f.paths.nr), false); assert.equal(fs.existsSync(f.paths.feeder), false);
  }
});

test('one-click recovery retains its ledger and NR when the FG owner finds an external replacement', async t => {
  const f = fixture(t, { failAt: 'prepared-fg', restoreFailure: 'restore-fg' });
  await assert.rejects(f.preparation.prepare('g'), { code: 'PREPARATION_RECOVERY_REQUIRED' });
  f.controls.failAt = null; f.controls.restoreFailure = null; f.controls.settingsPending = true;
  f.settings.pending = async () => [{ kind: 'file-journal' }];
  f.settings.recover = async () => { throw Object.assign(new Error('use owner'), { code: 'SETTINGS_FG_FILE_RECOVERY_REQUIRED' }); };
  f.dependencies.components.recoverPending = async () => { throw Object.assign(new Error('external replacement'), { code: 'SETTINGS_FG_FILE_CHANGED' }); };
  const before = f.calls.length;
  await assert.rejects(f.preparation.recover('g'), { code: 'SETTINGS_FG_FILE_CHANGED' });
  assert.equal(f.calls.length, before); assert.equal((await f.preparation.inspect('g')).pending, true);
  assert.equal(fs.existsSync(f.paths.nr), true); assert.equal(fs.existsSync(f.paths.fgComponents), true);
});
