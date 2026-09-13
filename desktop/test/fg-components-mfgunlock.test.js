'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFgComponents } = require('../src/product/fg-components');
const { createFgComponents: createLegacy } = require('../src/product/fg-legacy-components');
const { ID, ADDON, SHA256, PROVIDERS, sha256, providerById } = require('../src/product/fg-mfgunlock-resources');
const journal = require('../src/core/file-journal');
const { createLaunchSettingsService } = require('../src/product/launch-settings-service');
const { enhancementEvidence } = require('./helpers/enhancement-evidence');
const resourceRoot = process.env.DLSS5_TEST_RESOURCE_ROOT
  ? path.resolve(process.env.DLSS5_TEST_RESOURCE_ROOT) : path.resolve(__dirname, '../resources');

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mfgunlock-components-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, 'game'), dir = path.join(game, 'Bin'), exe = path.join(dir, 'Game.exe');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(exe, 'game');
  const resources = path.join(root, 'resources'); fs.cpSync(path.join(resourceRoot, 'fg-mfgunlock'), path.join(resources, 'fg-mfgunlock'), { recursive: true });
  const oldResources = path.join(resources, 'fg-components'); fs.mkdirSync(oldResources, { recursive: true });
  const oldFiles = { core: ['RTX40MFGCore.dll', 'old-core'], asi: ['RTX40MFG.asi', 'old-asi'], overlay: ['RTX40MFG-UI.addon64', 'old-overlay'],
    ual: ['ual-x64.dll', 'old-ual'], ualConfig: ['global.ini', '[GlobalSets]\nLoadPlugins=1\nLoadFromScriptsOnly=1\nLoadExtraPlugins=RTX40MFG.asi\nDontLoadFromDllMain=0\nForceEntryPointHook=0\n'] };
  const files = {};
  for (const [role, [file, bytes]] of Object.entries(oldFiles)) { fs.writeFileSync(path.join(oldResources, file), bytes); files[role] = { file, sha256: sha256(Buffer.from(bytes)) }; }
  fs.writeFileSync(path.join(oldResources, 'manifest.json'), JSON.stringify({ version: 1, id: 'legacy-fixture', protocol: 11, files, ualProxyNames: ['version.dll'], sources: [] }));
  const state = { series: ['RTX40'], running: false, bitness: 64, runtimeVersion: '310.8.0.0' };
  const observed = { api: 'dx12', streamlineFg: true, reshadeAddon: true };
  fs.writeFileSync(path.join(dir, 'nvngx_dlssg.dll'), 'runtime');
  const options = { resourcesPath: resources, appDir: root, gameDirectory: () => game, gameExecutable: () => exe,
    scan: async () => ({ ...observed }), detectHardware: async () => ({ series: state.series }),
    getFeatureEvidence: async () => ({ support: { status: observed.streamlineFg ? 'supported' : 'unknown', source: 'native-integration',
      capabilities: { mfgUnlock: { available: observed.streamlineFg && observed.api === 'dx12', multipliers: [2, 3, 4] } } } }),
    pe: { getBitness: () => state.bitness, getImports: () => ['version.dll'], getFileVersion: () => state.runtimeVersion },
    assertGameClosed: async () => { if (state.running) throw Object.assign(new Error('running'), { code: 'GAME_RUNNING' }); },
    antiCheatPresent: () => false, inspectRuntime: () => ({ ready: true, status: 'available' }), getReShadeSource: async () => null,
    ...overrides };
  const service = createFgComponents(options), legacy = createLegacy(options);
  const addon = path.join(dir, ADDON), receipt = service.receiptFile('g');
  const seedAddon = () => fs.copyFileSync(path.join(resources, 'fg-mfgunlock', ADDON), addon);
  return { root, game, dir, exe, resources, oldResources, options, service, legacy, state, observed, addon, receipt, seedAddon };
}
const bytes = file => fs.existsSync(file) ? fs.readFileSync(file) : null;
const providerFile = (f, id = ID) => path.join(f.resources, 'fg-mfgunlock', providerById(id).directory, ADDON);
function oldSnapshot(f) {
  const names = ['RTX40MFGCore.dll', 'RTX40MFG.asi', 'RTX40MFG-UI.addon64', 'RTX40MFG-Universal.json', 'version.dll', 'version.ini'];
  return new Map([...names.map(name => path.join(f.dir, name)), f.receipt].map(file => [file, bytes(file)]));
}
function assertSnapshot(snapshot) { for (const [file, expected] of snapshot) assert.deepEqual(bytes(file), expected, file); }

async function interruptedNewAddon(t) {
  let atCopy = null, f;
  f = fixture(t, { copyFile: async (...args) => {
    atCopy = JSON.parse(fs.readFileSync(journal.pendingPath(f.game), 'utf8'));
    await fsp.copyFile(...args);
    throw Object.assign(new Error('stopped after first Add-on copy before receipt'), { preservePending: true });
  } });
  await assert.rejects(f.service.prepare('g'), { code: 'errBackendRecovery' });
  const settings = createLaunchSettingsService({ userData: path.join(f.root, 'user'), appDir: f.root, resourcesPath: f.resources,
    gameDirectory: () => f.game, gameExecutable: () => f.exe, driver: {}, assertGameClosed: f.options.assertGameClosed });
  return { ...f, atCopy, settings, pending: journal.pendingPath(f.game) };
}

test('earliest FG copy already has durable owner and hashes; generic refuses and dedicated recovery clears a clean WAL', async t => {
  const f = await interruptedNewAddon(t);
  assert.equal(f.atCopy.owner.product, 'xiaofeng-fg-components'); assert.equal(f.atCopy.owner.exe, f.exe);
  assert.equal(f.atCopy.owner.operation, 'prepare');
  const check = f.atCopy.owner.checks.find(row => row.rel.endsWith(ADDON));
  assert.deepEqual(check, { rel: path.relative(f.game, f.addon), before: null, after: [SHA256] });
  assert.equal(f.atCopy.files.some(row => row.rel.endsWith('xiaofeng-fg-components.json')), false);
  assert.equal(fs.existsSync(f.receipt), false); assert.equal(sha256(bytes(f.addon)), SHA256);
  const pendingBytes = bytes(f.pending);
  await assert.rejects(f.settings.recover('g'), { code: 'SETTINGS_FG_FILE_RECOVERY_REQUIRED' });
  assert.deepEqual(bytes(f.pending), pendingBytes); assert.equal(sha256(bytes(f.addon)), SHA256);
  const restarted = createFgComponents(f.options), status = await restarted.inspect('g');
  assert.equal(status.fileRecoveryPending, true); assert.equal(status.ready, false); assert.equal(status.canPrepare, false);
  assert.equal((await restarted.inspectMigration('g')).fileRecoveryPending, true);
  f.state.running = true; await assert.rejects(restarted.recoverPending('g'), { code: 'GAME_RUNNING' }); assert.deepEqual(bytes(f.pending), pendingBytes);
  f.state.running = false; assert.equal((await restarted.recoverPending('g')).recovered, true);
  assert.equal(fs.existsSync(f.addon), false); assert.equal(fs.existsSync(f.receipt), false); assert.equal(fs.existsSync(f.pending), false);
  assert.equal((await restarted.inspectPending('g')).fileRecoveryPending, false);
});

test('same earliest FG fixture preserves an external replacement and WAL through both recovery entrances', async t => {
  const f = await interruptedNewAddon(t), replacement = Buffer.from('external replacement after MFG interrupted install');
  fs.writeFileSync(f.addon, replacement); const pendingBytes = bytes(f.pending);
  assert.equal(sha256(replacement), '400e34ddd9d035df9d7d7b3181dc21209abde667163fa63d687acbe68bdb6b9b');
  await assert.rejects(f.settings.recover('g'), { code: 'SETTINGS_FG_FILE_RECOVERY_REQUIRED' });
  await assert.rejects(createFgComponents(f.options).recoverPending('g'), { code: 'SETTINGS_FG_EXTERNAL_CHANGE' });
  assert.deepEqual(bytes(f.addon), replacement); assert.deepEqual(bytes(f.pending), pendingBytes);
  assert.equal(fs.existsSync(f.receipt), false);
});

test('FG recovery rejects another owner or EXE, foreign targets, and changed snapshot hashes without touching peers', async t => {
  for (const tamper of ['owner', 'exe', 'target', 'hash', 'directory', 'alias', 'manifest']) {
    const f = await interruptedNewAddon(t), state = JSON.parse(bytes(f.pending));
    if (tamper === 'owner') state.owner.product = 'other-product';
    if (tamper === 'exe') state.owner.exe = path.join(f.dir, 'Other.exe');
    if (tamper === 'target') { state.files[1].rel = 'Bin/foreign.addon64'; state.owner.checks[0].rel = 'Bin/foreign.addon64'; }
    if (tamper === 'hash') state.owner.checks[0].before = 'f'.repeat(64);
    if (tamper === 'directory') state.dirs.push('Bin/unrelated-directory');
    if (tamper === 'alias') { state.files[1].rel = 'Bin/../Bin/' + ADDON; state.owner.checks[0].rel = state.files[1].rel; }
    if (tamper === 'manifest') fs.writeFileSync(path.join(f.game, '_DLSS5_Backup/manifest.json'), 'later native installation');
    fs.writeFileSync(f.pending, JSON.stringify(state)); const before = bytes(f.pending), addon = bytes(f.addon);
    await assert.rejects(f.service.recoverPending('g'));
    assert.deepEqual(bytes(f.pending), before); assert.deepEqual(bytes(f.addon), addon);
  }
});

test('dedicated FG recovery is serialized across component service instances', async t => {
  const f = await interruptedNewAddon(t); let release, reached;
  const hold = new Promise(resolve => release = resolve), entered = new Promise(resolve => reached = resolve);
  const delayed = createFgComponents({ ...f.options, journal: { ...journal, recover: async game => { reached(); await hold; return journal.recover(game); } } });
  const first = delayed.recoverPending('g'); await entered;
  try { await assert.rejects(createFgComponents(f.options).recoverPending('g'), { code: 'SETTINGS_FG_FILE_BUSY' }); }
  finally { release(); }
  assert.equal((await first).recovered, true); assert.equal(fs.existsSync(f.pending), false);
});

test('old unmarked FG WAL admits only the exact pinned Add-on and preserves the same external-change boundary', async t => {
  for (const external of [false, true]) {
    const f = await interruptedNewAddon(t), state = JSON.parse(bytes(f.pending)); delete state.owner;
    fs.writeFileSync(f.pending, JSON.stringify(state));
    if (external) fs.writeFileSync(f.addon, 'external old-WAL replacement');
    await assert.rejects(f.settings.recover('g'), { code: 'SETTINGS_FG_FILE_RECOVERY_REQUIRED' });
    if (external) {
      const before = bytes(f.pending); await assert.rejects(f.service.recoverPending('g'), { code: 'SETTINGS_FG_EXTERNAL_CHANGE' });
      assert.equal(fs.readFileSync(f.addon, 'utf8'), 'external old-WAL replacement'); assert.deepEqual(bytes(f.pending), before);
    } else {
      await f.service.recoverPending('g'); assert.equal(fs.existsSync(f.addon), false); assert.equal(fs.existsSync(f.pending), false);
    }
  }
});

test('legacy migration interruption restores only its recorded targets through dedicated file recovery', async t => {
  let stop = false, f;
  const guardedJournal = { ...journal, capture: async (game, file) => {
    await journal.capture(game, file);
    if (stop && path.basename(file) === 'version.ini' && !fs.existsSync(path.join(f.dir, 'RTX40MFG-Universal.json')))
      throw Object.assign(new Error('interrupted after first legacy deletion'), { preservePending: true });
  } };
  f = fixture(t, { journal: guardedJournal }); await f.legacy.prepare('g'); const original = oldSnapshot(f); stop = true;
  await assert.rejects(f.service.migrateLegacy('g'), { code: 'errBackendRecovery' });
  const wal = JSON.parse(bytes(journal.pendingPath(f.game)));
  assert.equal(wal.owner.product, 'xiaofeng-fg-components'); assert.equal(wal.owner.operation, 'legacy-restore');
  assert.equal(fs.existsSync(path.join(f.dir, 'RTX40MFG-Universal.json')), false);
  stop = false; await createFgComponents(f.options).recoverPending('g'); assertSnapshot(original);
  assert.equal(fs.existsSync(journal.pendingPath(f.game)), false);
  assert.equal((await f.service.inspectMigration('g')).migrationPending, false);
});

test('interrupted managed MFG uninstall is recoverable with the original Add-on and receipt snapshots', async t => {
  let stop = false, f;
  const guardedJournal = { ...journal, capture: async (game, file) => {
    await journal.capture(game, file);
    if (stop && path.basename(file) === 'xiaofeng-fg-components.json' && !fs.existsSync(f.addon))
      throw Object.assign(new Error('interrupted uninstall after Add-on removal'), { preservePending: true });
  } };
  f = fixture(t, { journal: guardedJournal }); await f.service.prepare('g'); const originalReceipt = bytes(f.receipt); stop = true;
  await assert.rejects(f.service.restore('g'), { code: 'errBackendRecovery' });
  const wal = JSON.parse(bytes(journal.pendingPath(f.game))); assert.equal(wal.owner.operation, 'restore');
  stop = false; await createFgComponents(f.options).recoverPending('g');
  assert.equal(sha256(bytes(f.addon)), SHA256); assert.deepEqual(bytes(f.receipt), originalReceipt);
  assert.equal(fs.existsSync(journal.pendingPath(f.game)), false);
});

test('new dispatcher installs exactly one add-on, leaves loaders and both config sources unchanged', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'dinput8.dll'), 'REFramework'); fs.writeFileSync(path.join(f.dir, 'version.dll'), 'external-UAL');
  fs.writeFileSync(path.join(f.dir, 'version.ini'), '[GlobalSets]\nLoadExtraPlugins=Keep.asi\n');
  fs.writeFileSync(path.join(f.dir, 'ReShade.ini'), '[GENERAL]\nPresetPath=mine.ini\n');
  const before = new Map(['dinput8.dll', 'version.dll', 'version.ini', 'ReShade.ini'].map(name => [path.join(f.dir, name), bytes(path.join(f.dir, name))]));
  const status = await f.service.inspect('g'); assert.equal(status.backend, 'mfgunlock'); assert.equal(status.canPrepare, true);
  const prepared = await f.service.prepare('g'); assert.deepEqual(prepared.created, [ADDON]); assert.equal(prepared.changed, true);
  assert.equal(sha256(bytes(f.addon)), SHA256); assertSnapshot(before);
  assert.equal(fs.existsSync(path.join(f.dir, 'RTX40MFG-Universal.json')), false);
  assert.equal(JSON.parse(bytes(f.receipt)).version, 3);
  assert.equal((await f.service.inspect('g')).ready, true);
  await f.service.restore('g'); assert.equal(fs.existsSync(f.addon), false); assertSnapshot(before);
});

test('GPU, architecture, renderer, existing FG, full ReShade and runtime gates fail without installing', async t => {
  for (const kind of ['gpu', 'bitness', 'api', 'streamline', 'reshade', 'runtime', 'missing-runtime', 'addon-directory']) {
    const f = fixture(t);
    if (kind === 'gpu') f.state.series = ['RTX30'];
    if (kind === 'bitness') f.state.bitness = 32;
    if (kind === 'api') f.observed.api = 'vulkan';
    if (kind === 'streamline') f.observed.streamlineFg = false;
    if (kind === 'reshade') f.observed.reshadeAddon = false;
    if (kind === 'runtime') f.state.runtimeVersion = '3.5.10.0';
    if (kind === 'missing-runtime') fs.unlinkSync(path.join(f.dir, 'nvngx_dlssg.dll'));
    if (kind === 'addon-directory') f.observed.reshadeAddonDirectory = path.join(f.dir, 'CustomAddons');
    const status = await f.service.inspect('g'); assert.equal(status.ready, false, kind); assert.equal(status.canPrepare, false, kind);
    await assert.rejects(f.service.prepare('g')); assert.equal(fs.existsSync(f.addon), false, kind); assert.equal(fs.existsSync(f.receipt), false, kind);
  }
});

test('RTX50 native route needs no new resource or runtime and never installs the legacy stack', async t => {
  const f = fixture(t); f.state.series = ['RTX50'];
  fs.unlinkSync(path.join(f.resources, 'fg-mfgunlock', 'manifest.json')); fs.unlinkSync(path.join(f.dir, 'nvngx_dlssg.dll'));
  assert.equal((await f.service.inspect('g')).ready, true); await assert.rejects(f.service.prepare('g'), { code: 'SETTINGS_FG_UNSUPPORTED' });
  assert.deepEqual(await f.service.restore('g'), { restored: false, unchanged: true });
});

test('missing or changed new resources cannot select or reinstall the available legacy suite', async t => {
  const f = fixture(t); fs.writeFileSync(providerFile(f), 'changed');
  const status = await f.service.inspect('g'); assert.equal(status.canPrepare, false);
  await assert.rejects(f.service.prepare('g'), { code: 'SETTINGS_FG_BLOCKED' });
  assert.equal(fs.existsSync(path.join(f.dir, 'RTX40MFGCore.dll')), false); assert.equal(fs.existsSync(f.addon), false);
});

test('unknown MFG variants and unmanaged legacy controls are retained as conflicts', async t => {
  for (const name of ['renodx-mfgunlock-other.addon64', 'unknown-mfg.addon64', 'RTX40MFG-Universal.json', 'plugins/cyber_engine_tweaks/mods/RTX40MFG/init.lua']) {
    const f = fixture(t), file = path.join(f.dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'external');
    const status = await f.service.inspect('g'); assert.ok(status.conflicts.length, name); assert.equal(status.canPrepare, false);
    await assert.rejects(f.service.prepare('g')); assert.equal(fs.readFileSync(file, 'utf8'), 'external');
  }
});

test('active ReShade AddonPath and direct-load entries are checked even when scan reports addon support', async t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.dir, 'elsewhere'));
  fs.writeFileSync(path.join(f.dir, 'ReShade.ini'), '[ADDON]\nAddonPath=.\\elsewhere\n');
  assert.equal((await f.service.inspect('g')).canPrepare, false);
  await assert.rejects(f.service.prepare('g'), { code: 'SETTINGS_FG_BLOCKED' }); assert.equal(fs.existsSync(f.addon), false);
  const outside = path.join(f.root, 'another-mfg.addon64'); fs.writeFileSync(outside, 'external MFG');
  fs.writeFileSync(path.join(f.dir, 'ReShade.ini'), `[ADDON]\nAddonPath=.\\\nLoadFromDllMain=${outside}\n`);
  const status = await f.service.inspect('g'); assert.ok(status.conflicts.some(message => message.includes('直接加载')));
});

test('anti-cheat preparation uses explicit retry and never installs before it', async t => {
  const f = fixture(t, { antiCheatPresent: () => true });
  await assert.rejects(f.service.prepare('g'), { code: 'ERR_ANTI_CHEAT_CONFIRM' }); assert.equal(fs.existsSync(f.addon), false);
  assert.equal((await f.service.prepare('g', { allowAntiCheat: true })).prepared, true);
});

test('running game blocks legacy migration and both migration completion paths', async t => {
  const f = fixture(t); await f.legacy.prepare('g'); const snapshot = oldSnapshot(f); f.state.running = true;
  await assert.rejects(f.service.migrateLegacy('g'), { code: 'GAME_RUNNING' }); assertSnapshot(snapshot);
  f.state.running = false; const migration = await f.service.migrateLegacy('g'); f.state.running = true;
  await assert.rejects(f.service.rollbackMigration('g', migration.migrationToken), { code: 'GAME_RUNNING' });
  await assert.rejects(f.service.commitMigration('g', migration.migrationToken), { code: 'GAME_RUNNING' });
  f.state.running = false; await f.service.rollbackMigration('g', migration.migrationToken); assertSnapshot(snapshot);
});

test('adopting a verified external add-on and undo preserve the pre-existing binary', async t => {
  const f = fixture(t); f.seedAddon(); const original = bytes(f.addon);
  const result = await f.service.prepare('g'); assert.deepEqual(result.created, []); assert.deepEqual(result.adopted, [ADDON]);
  assert.equal(JSON.parse(bytes(f.receipt)).files[0].mode, 'adopted');
  await f.service.rollbackPrepare('g', result.undoToken); assert.deepEqual(bytes(f.addon), original); assert.equal(fs.existsSync(f.receipt), false);
  await f.service.prepare('g'); await f.service.restore('g'); assert.deepEqual(bytes(f.addon), original);
});

test('already managed readiness produces no new undo; repair rollback restores only this round', async t => {
  const f = fixture(t); await f.service.prepare('g'); const originalReceipt = bytes(f.receipt);
  const noOp = await f.service.prepare('g'); assert.equal(noOp.changed, false); assert.equal(noOp.undoToken, null);
  await f.service.rollbackPrepare('g', noOp.undoToken); assert.equal(fs.existsSync(f.addon), true);
  fs.unlinkSync(f.addon); const repair = await f.service.prepare('g');
  assert.equal(JSON.parse(bytes(f.receipt)).files[0].mode, 'created');
  await f.service.rollbackPrepare('g', repair.undoToken); assert.equal(fs.existsSync(f.addon), false); assert.deepEqual(bytes(f.receipt), originalReceipt);
});

test('running game blocks preparation, restore and undo before any file changes', async t => {
  const f = fixture(t); f.state.running = true;
  await assert.rejects(f.service.prepare('g'), { code: 'GAME_RUNNING' }); assert.equal(fs.existsSync(f.addon), false);
  f.state.running = false; const result = await f.service.prepare('g'); const before = bytes(f.receipt); f.state.running = true;
  await assert.rejects(f.service.restore('g'), { code: 'GAME_RUNNING' }); await assert.rejects(f.service.rollbackPrepare('g', result.undoToken), { code: 'GAME_RUNNING' });
  assert.equal(fs.existsSync(f.addon), true); assert.deepEqual(bytes(f.receipt), before);
});

test('receipt write failure rolls back the new binary and leaves no pending journal', async t => {
  const f = fixture(t, { writeReceipt: async () => { throw new Error('disk error'); } });
  await assert.rejects(f.service.prepare('g'), /disk error/);
  assert.equal(fs.existsSync(f.addon), false); assert.equal(fs.existsSync(f.receipt), false); assert.equal(fs.existsSync(journal.pendingPath(f.game)), false);
});

test('an external file winning COPYFILE_EXCL is preserved by transactional rollback', async t => {
  const f = fixture(t, { copyFile: async (source, dest, flags) => { fs.writeFileSync(dest, 'externally appeared'); await fsp.copyFile(source, dest, flags); } });
  await assert.rejects(f.service.prepare('g'), { code: 'SETTINGS_FG_EXTERNAL_CHANGE' });
  assert.equal(fs.readFileSync(f.addon, 'utf8'), 'externally appeared'); assert.equal(fs.existsSync(f.receipt), false); assert.equal(fs.existsSync(journal.pendingPath(f.game)), false);
});

test('owned binary edits and forged receipt targets never cause destructive restore', async t => {
  const f = fixture(t); const result = await f.service.prepare('g'); fs.writeFileSync(f.addon, 'user changed');
  await assert.rejects(f.service.restore('g'), { code: 'SETTINGS_FG_EXTERNAL_CHANGE' });
  await assert.rejects(f.service.rollbackPrepare('g', result.undoToken), { code: 'SETTINGS_FG_EXTERNAL_CHANGE' });
  const r = JSON.parse(bytes(f.receipt)); r.files[0].rel = path.relative(f.game, f.exe); fs.writeFileSync(f.receipt, JSON.stringify(r));
  await assert.rejects(f.service.restore('g'), { code: 'SETTINGS_FG_RECEIPT' }); assert.equal(fs.readFileSync(f.exe, 'utf8'), 'game'); assert.equal(fs.readFileSync(f.addon, 'utf8'), 'user changed');
});

test('legacy receipt is recoverable but never considered ready or silently repaired by new dispatcher', async t => {
  const f = fixture(t); await f.legacy.prepare('g'); const snapshot = oldSnapshot(f);
  const status = await f.service.inspect('g'); assert.equal(status.legacyNeedsMigration, true); assert.equal(status.migrationReady, true); assert.equal(status.ready, false);
  await assert.rejects(f.service.prepare('g'), { code: 'SETTINGS_FG_MIGRATION_REQUIRED' }); assertSnapshot(snapshot);
  for (const name of ['RTX40MFGCore.dll', 'RTX40MFG.asi', 'RTX40MFG-UI.addon64', 'ual-x64.dll']) fs.unlinkSync(path.join(f.oldResources, name));
  await f.service.restore('g'); assert.equal(fs.existsSync(f.receipt), false); assert.equal(fs.existsSync(path.join(f.dir, 'RTX40MFG.asi')), false);
});

test('legacy settings must return to their receipt baseline before migration', async t => {
  const f = fixture(t); await f.legacy.prepare('g'); const control = path.join(f.dir, 'RTX40MFG-Universal.json'), original = bytes(control);
  const value = JSON.parse(original); value.mode = 'fixed'; value.multiplier = 4; fs.writeFileSync(control, JSON.stringify(value));
  assert.equal((await f.service.inspect('g')).migrationReady, false);
  await assert.rejects(f.service.migrateLegacy('g'), { code: 'SETTINGS_FG_MIGRATION_BLOCKED' });
  fs.writeFileSync(control, original); assert.equal((await f.service.inspect('g')).migrationReady, true);
});

test('migration is explicit, removes owned legacy control, and commits only its own snapshots', async t => {
  const f = fixture(t); await f.legacy.prepare('g'); const oldBackup = path.join(f.game, '_DLSS5_Backup', 'original-user-backup.bin'); fs.writeFileSync(oldBackup, 'keep');
  const migration = await f.service.migrateLegacy('g'); assert.ok(migration.migrationToken);
  assert.equal(fs.existsSync(path.join(f.dir, 'RTX40MFG-Universal.json')), false);
  await assert.rejects(f.service.prepare('g'), { code: 'SETTINGS_FG_MIGRATION_PENDING' });
  await assert.rejects(f.service.restore('g'), { code: 'SETTINGS_FG_MIGRATION_PENDING' });
  const prepared = await f.service.prepare('g', { migrationToken: migration.migrationToken });
  assert.equal((await f.service.inspect('g')).ready, true);
  await f.service.commitMigration('g', migration.migrationToken); f.service.commitPrepare('g', prepared.undoToken);
  assert.equal((await f.service.inspect('g')).migrationPending, false); assert.equal(fs.readFileSync(oldBackup, 'utf8'), 'keep'); assert.equal(fs.existsSync(f.addon), true);
});

test('failure after legacy removal preserves durable snapshots and rolls back exact legacy bytes', async t => {
  const f = fixture(t); await f.legacy.prepare('g'); const snapshot = oldSnapshot(f);
  const failing = createFgComponents({ ...f.options, writeReceipt: async () => { throw new Error('new receipt failed'); } });
  const migration = await failing.migrateLegacy('g');
  await assert.rejects(failing.prepare('g', { migrationToken: migration.migrationToken }), /new receipt failed/);
  assert.equal((await failing.inspect('g')).migrationState, 'removed');
  await createFgComponents(f.options).rollbackMigration('g', migration.migrationToken); assertSnapshot(snapshot); assert.equal(fs.existsSync(f.addon), false);
});

test('migration rollback survives restart after new preparation and restores old receipt and components', async t => {
  const f = fixture(t); await f.legacy.prepare('g'); const snapshot = oldSnapshot(f);
  const migration = await f.service.migrateLegacy('g'); await f.service.prepare('g', { migrationToken: migration.migrationToken });
  const restarted = createFgComponents(f.options); assert.equal((await restarted.inspect('g')).migrationState, 'prepared');
  await restarted.rollbackMigration('g', migration.migrationToken); assertSnapshot(snapshot); assert.equal(fs.existsSync(f.addon), false);
});

test('coordinator compensation may undo new preparation then undo migration', async t => {
  const f = fixture(t); await f.legacy.prepare('g'); const snapshot = oldSnapshot(f);
  const migration = await f.service.migrateLegacy('g'); const prepared = await f.service.prepare('g', { migrationToken: migration.migrationToken });
  await f.service.rollbackPrepare('g', prepared.undoToken); assert.equal((await f.service.inspect('g')).migrationState, 'removed');
  await f.service.rollbackMigration('g', migration.migrationToken); assertSnapshot(snapshot);
});

test('shared manager-created UAL and external clients survive migration and its compensation', async t => {
  const f = fixture(t); await f.legacy.prepare('g'); const snapshot = oldSnapshot(f);
  fs.mkdirSync(path.join(f.dir, 'scripts')); fs.writeFileSync(path.join(f.dir, 'scripts', 'Other.asi'), 'another client');
  const migration = await f.service.migrateLegacy('g');
  assert.ok(migration.retained.some(rel => rel.endsWith('version.dll'))); assert.ok(migration.retained.some(rel => rel.endsWith('version.ini')));
  assert.equal(fs.readFileSync(path.join(f.dir, 'version.dll'), 'utf8'), 'old-ual');
  await f.service.rollbackMigration('g', migration.migrationToken); assertSnapshot(snapshot);
});

test('migration refuses external changes before rollback and retains the recovery record', async t => {
  const f = fixture(t); await f.legacy.prepare('g'); const migration = await f.service.migrateLegacy('g');
  const external = path.join(f.dir, 'RTX40MFGCore.dll'); fs.writeFileSync(external, 'external after migration');
  await assert.rejects(f.service.rollbackMigration('g', migration.migrationToken), { code: 'SETTINGS_FG_EXTERNAL_CHANGE' });
  assert.equal(fs.readFileSync(external, 'utf8'), 'external after migration'); assert.equal((await f.service.inspect('g')).migrationPending, true);
});

test('tampered migration snapshots fail closed without deleting new or original files', async t => {
  const f = fixture(t); await f.legacy.prepare('g'); const migration = await f.service.migrateLegacy('g');
  const recordFile = path.join(f.game, '_DLSS5_Backup', 'xiaofeng-fg-migration.json'), record = JSON.parse(bytes(recordFile));
  fs.writeFileSync(path.join(f.game, record.files[0].snapshot), 'tampered');
  await assert.rejects(f.service.rollbackMigration('g', migration.migrationToken), { code: 'SETTINGS_FG_MIGRATION_RECORD' }); assert.equal(fs.existsSync(recordFile), true);
});

test('new components and launch settings own separate receipts and restore an existing ReShade INI', async t => {
  const { createLaunchSettingsService } = require('../src/product/launch-settings-service');
  const f = fixture(t), ini = path.join(f.dir, 'ReShade.ini');
  const original = '[GENERAL]\nPresetPath=user.ini\n'; fs.writeFileSync(ini, original);
  const settings = createLaunchSettingsService({ userData: path.join(f.root, 'user'), appDir: f.root,
    getFeatureEvidence: async () => enhancementEvidence(),
    gameDirectory: () => f.game, gameExecutable: () => f.exe, detectHardware: async () => ({ series: ['RTX40'] }),
    environment: async () => ({ verified: true, running: [] }), peBitness: () => 64,
    assertComponents: async () => { if (!(await f.service.inspect('g')).ready) throw Object.assign(new Error('components required'), { code: 'SETTINGS_FG_COMPONENTS_REQUIRED' }); } });
  const request = { backend: 'mfgunlock', mode: 'fixed', multiplier: 3 };
  await assert.rejects(settings.preview('g', 'fg', request), { code: 'SETTINGS_FG_COMPONENTS_REQUIRED' });
  const prepared = await f.service.prepare('g'); const receiptBefore = bytes(f.receipt);
  const plan = await settings.preview('g', 'fg', request); await settings.apply(plan.id, { confirm: true });
  assert.match(fs.readFileSync(ini, 'utf8'), /ForceMultiplier=3/); assert.deepEqual(bytes(f.receipt), receiptBefore);
  await settings.restore('g', 'fg'); await f.service.rollbackPrepare('g', prepared.undoToken);
  assert.equal(fs.existsSync(f.addon), false); assert.match(fs.readFileSync(ini, 'utf8'), /PresetPath=user.ini/); assert.doesNotMatch(fs.readFileSync(ini, 'utf8'), /RenoDX.MFGUnlock/);
});

test('workflow restores old fixed settings before asking component migration readiness', async t => {
  const { createLaunchSettingsService } = require('../src/product/launch-settings-service');
  const { createFgWorkflow } = require('../src/product/fg-workflow');
  const f = fixture(t); fs.writeFileSync(path.join(f.dir, 'ReShade.ini'), '[GENERAL]\nPresetPath=user.ini\n');
  const settings = createLaunchSettingsService({ userData: path.join(f.root, 'user'), appDir: f.root, allowLegacyControl: true,
    getFeatureEvidence: async () => enhancementEvidence(),
    gameDirectory: () => f.game, gameExecutable: () => f.exe, detectHardware: async () => ({ series: ['RTX40'] }),
    environment: async () => ({ verified: true, running: [] }), peBitness: () => 64,
    assertComponents: async (id, backend) => { const status = await (backend === 'rtx40' ? f.legacy : f.service).inspect(id); if (!status.ready) throw new Error(status.blockers.join('\n')); } });
  await f.legacy.prepare('g'); const oldRequest = { backend: 'rtx40', mode: 'fixed', multiplier: 4 };
  const oldPlan = await settings.preview('g', 'fg', oldRequest); await settings.apply(oldPlan.id, { confirm: true }); await settings.save('g', 'fg', oldRequest);
  assert.equal((await f.service.inspect('g')).migrationReady, false);
  const workflow = createFgWorkflow({ settings, components: f.service, assertClosed: async () => {} });
  const result = await workflow.apply('g', { backend: 'mfgunlock', mode: 'fixed', multiplier: 3 }, { migrateLegacy: true });
  assert.equal(result.migrated, true); assert.equal((await f.service.inspect('g')).migrationPending, false);
  assert.equal(fs.existsSync(path.join(f.dir, 'RTX40MFG-Universal.json')), false);
  assert.match(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), /ForceMultiplier=3/);
});

test('confirmed external layout installs and restores only the pinned addon inside its own journal root', async t => {
  const f = fixture(t), active = path.join(f.root, 'external', 'active'), closedRoots = [];
  fs.mkdirSync(active, { recursive: true });
  const ini = path.join(active, 'ReShade.ini'), nr = path.join(active, 'renodx-dlss.addon64');
  fs.writeFileSync(ini, '[GENERAL]\nPresetPath=user.ini\n'); fs.writeFileSync(nr, 'existing NR');
  const layout = { verified: true, mode: 'external', exe: f.exe, addonDirectory: active, activeConfigPath: ini };
  const service = createFgComponents({ ...f.options, getLayout: () => layout, assertGameClosed: async root => closedRoots.push(root) });
  const result = await service.prepare('g');
  assert.equal(result.runtimeVerified, false); assert.equal(fs.existsSync(f.addon), false);
  assert.equal(sha256(bytes(path.join(active, ADDON))), SHA256);
  assert.equal(path.dirname(path.dirname(service.receiptFile('g'))), active);
  assert.equal(closedRoots.every(root => root === f.game), true);
  await service.restore('g');
  assert.equal(fs.existsSync(path.join(active, ADDON)), false);
  assert.equal(fs.readFileSync(nr, 'utf8'), 'existing NR'); assert.equal(fs.readFileSync(ini, 'utf8'), '[GENERAL]\nPresetPath=user.ini\n');
  assert.equal(fs.existsSync(journal.pendingPath(active)), false); assert.equal(fs.existsSync(journal.pendingPath(f.game)), false);
});

test('external MFG interrupted copy is recoverable by its own owner without touching game peer files', async t => {
  const f = fixture(t), active = path.join(f.root, 'active'); fs.mkdirSync(active);
  const layout = { verified: true, mode: 'external', exe: f.exe, addonDirectory: active, activeConfigPath: path.join(active, 'ReShade.ini') };
  const options = { ...f.options, getLayout: () => layout, copyFile: async (...args) => { await fsp.copyFile(...args); throw Object.assign(Error('interrupted external copy'), { preservePending: true }); } };
  const service = createFgComponents(options);
  await assert.rejects(service.prepare('g'), { code: 'errBackendRecovery' });
  assert.equal((await service.inspectPending('g')).fileRecoveryPending, true);
  const peer = path.join(f.dir, 'renodx-dlss.addon64'); fs.writeFileSync(peer, 'peer NR');
  await createFgComponents({ ...f.options, getLayout: () => layout }).recoverPending('g');
  assert.equal(fs.existsSync(path.join(active, ADDON)), false); assert.equal(fs.readFileSync(peer, 'utf8'), 'peer NR');
});

test('layout identity mismatch and outstanding local MFG receipts cannot silently relocate the addon', async t => {
  const f = fixture(t), active = path.join(f.root, 'active'); fs.mkdirSync(active);
  const layout = { verified: true, mode: 'external', exe: f.exe, addonDirectory: active, activeConfigPath: path.join(active, 'ReShade.ini') };
  const service = createFgComponents({ ...f.options, getLayout: () => layout });
  layout.exe = path.join(f.dir, 'Other.exe');
  await assert.rejects(service.prepare('g'), { code: 'SETTINGS_FG_LAYOUT_UNVERIFIED' });
  layout.exe = f.exe; await f.service.prepare('g');
  assert.ok((await service.inspect('g')).blockers.some(text => text.includes('旧本地')));
  await assert.rejects(service.prepare('g'), { code: 'SETTINGS_FG_BLOCKED' });
  assert.equal(fs.existsSync(path.join(active, ADDON)), false);
});

test('NR and HDR addons are distinct from MFG, while a renamed identical MFG binary is still a conflict', async t => {
  const f = fixture(t), dir = path.join(f.dir, 'addons', 'mfg-tools'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'renodx-dlss.addon64'), 'NR addon');
  fs.writeFileSync(path.join(dir, 'renodx-hdr.addon64'), 'HDR addon');
  assert.deepEqual((await f.service.inspect('g')).conflicts, []);
  fs.copyFileSync(path.join(f.resources, 'fg-mfgunlock', ADDON), path.join(dir, 'renamed-addon.addon64'));
  assert.ok((await f.service.inspect('g')).conflicts.some(text => text.includes('renamed-addon')));
});
test('owned module manifest comes from the verified MFG receipt and never blesses an unowned disk hash', async t => {
  const f = fixture(t), active = path.join(f.root, 'active'); fs.mkdirSync(active);
  const layout = { verified: true, mode: 'external', exe: f.exe, addonDirectory: active, activeConfigPath: path.join(active, 'ReShade.ini') };
  const service = createFgComponents({ ...f.options, getLayout: () => layout }), addon = path.join(active, ADDON);
  fs.copyFileSync(providerFile(f), addon);
  assert.deepEqual(await service.ownedModuleManifest('g'), []);
  await service.prepare('g'); const receiptBefore = bytes(service.receiptFile('g'));
  assert.deepEqual(await service.ownedModuleManifest('g'), [{ path: addon, name: ADDON, role: 'mfgunlock', sha256: SHA256, architecture: 64, owner: 'fg-mfgunlock' }]);
  assert.deepEqual(bytes(service.receiptFile('g')), receiptBefore);
  fs.writeFileSync(addon, 'changed MFG'); await assert.rejects(service.ownedModuleManifest('g'), { code: 'SETTINGS_FG_EXTERNAL_CHANGE' });
  const receipt = JSON.parse(receiptBefore); receipt.files[0].after = sha256(bytes(addon)); fs.writeFileSync(service.receiptFile('g'), JSON.stringify(receipt));
  await assert.rejects(service.ownedModuleManifest('g'), { code: 'SETTINGS_FG_RECEIPT' }); assert.equal(fs.readFileSync(addon, 'utf8'), 'changed MFG');
});

function specialService(f, source, options = {}) {
  const runtimeDir = source === 'feeder' ? f.dir : path.join(f.root, source + '-profile'), addonDirectory = path.join(runtimeDir, 'addons');
  fs.mkdirSync(addonDirectory, { recursive: true });
  const layout = { source, mode: 'local', verified: true, exe: f.exe, runtimeDir, addonDirectory, activeConfigPath: path.join(runtimeDir, 'ReShade.ini') };
  return { layout, service: createFgComponents({ ...f.options, getLayout: () => layout, ...options }) };
}
for (const source of ['vulkan', 'feeder']) test(`${source} without an FG record is not applicable and does not block restoration`, async t => {
  const f = fixture(t), { service, layout } = specialService(f, source), peer = path.join(layout.addonDirectory, 'peer.addon64'); fs.writeFileSync(peer, 'fixed owner peer');
  const status = await service.inspect('g'); assert.equal(status.notApplicable, true); assert.equal(status.needsCleanup, false); assert.equal(status.canPrepare, false);
  assert.deepEqual(await service.ownedModuleManifest('g'), []); assert.equal((await service.restore('g')).unchanged, true);
  assert.equal((await service.inspectMigration('g')).migrationPending, false); assert.equal((await service.inspectPending('g')).fileRecoveryPending, false);
  assert.equal(fs.readFileSync(peer, 'utf8'), 'fixed owner peer');
});
test('fixed Vulkan still restores a previous local owner and refuses a changed owned MFG file', async t => {
  for (const changed of [false, true]) {
    const f = fixture(t); await f.service.prepare('g'); const { service, layout } = specialService(f, 'vulkan');
    const peer = path.join(layout.addonDirectory, 'peer.addon64'); fs.writeFileSync(peer, 'Vulkan peer');
    assert.equal((await service.inspect('g')).needsCleanup, true);
    if (changed) {
      fs.writeFileSync(f.addon, 'external change'); await assert.rejects(service.restore('g'), { code: 'SETTINGS_FG_EXTERNAL_CHANGE' });
      assert.equal(fs.readFileSync(f.addon, 'utf8'), 'external change'); assert.equal(fs.existsSync(f.receipt), true);
    } else { assert.equal((await service.restore('g')).restored, true); assert.equal(fs.existsSync(f.addon), false); }
    assert.equal(fs.readFileSync(peer, 'utf8'), 'Vulkan peer');
  }
});
test('fixed Vulkan preserves legacy local recovery and never ignores dedicated FG records', async t => {
  const old = fixture(t); await old.legacy.prepare('g'); const legacySpecial = specialService(old, 'vulkan');
  assert.equal((await legacySpecial.service.inspect('g')).legacyNeedsMigration, true);
  assert.equal((await legacySpecial.service.restore('g')).restored, true); assert.equal(fs.existsSync(old.receipt), false);
  const f = fixture(t), { service, layout } = specialService(f, 'vulkan');
  const priorLayout = { ...layout, source: 'external', mode: 'external', activeConfigPath: path.join(layout.addonDirectory, 'ReShade.ini') };
  const prior = createFgComponents({ ...f.options, getLayout: () => priorLayout }); await prior.prepare('g');
  const addon = path.join(layout.addonDirectory, ADDON); fs.writeFileSync(addon, 'dedicated external change');
  assert.equal((await service.inspect('g')).needsCleanup, true); await assert.rejects(service.restore('g'), { code: 'SETTINGS_FG_EXTERNAL_CHANGE' });
  assert.equal(fs.existsSync(prior.receiptFile('g')), true); assert.equal(fs.readFileSync(addon, 'utf8'), 'dedicated external change');
});
test('special routes retain interrupted FG owner recovery even when no receipt was written yet', async t => {
  const f = await interruptedNewAddon(t), { service } = specialService(f, 'vulkan');
  assert.equal((await service.inspectPending('g')).fileRecoveryPending, true);
  await assert.rejects(service.restore('g'), { code: 'SETTINGS_FG_FILE_RECOVERY_REQUIRED' });
  await service.recoverPending('g'); assert.equal(fs.existsSync(f.pending), false); assert.equal(fs.existsSync(f.addon), false);
});

test('provider catalog and preview expose fixed target hashes without writing, and no selection preserves an installed fallback', async t => {
  const f = fixture(t);
  const fallback = providerById('mfgunlock-0.6.1');
  fs.copyFileSync(path.join(f.resources, 'fg-mfgunlock', fallback.directory, ADDON), f.addon);
  assert.equal(f.service.catalog().filter(row => row.ready).length, PROVIDERS.length);
  const p = await f.service.previewProvider('g', 'mfgunlock-0.7-zh-CN');
  assert.equal(p.canApply, true); assert.equal(p.action, 'replace'); assert.equal(p.beforeSha256, fallback.sha256);
  assert.equal(p.afterSha256, providerById('mfgunlock-0.7-zh-CN').sha256); assert.equal(p.file, f.addon); assert.equal(fs.existsSync(f.receipt), false);
  const prepared = await f.service.prepare('g'); assert.equal(prepared.id, fallback.id); assert.equal(prepared.replaced.length, 0);
  assert.equal(sha256(bytes(f.addon)), fallback.sha256); assert.equal((await f.service.inspect('g')).canUpgrade, true);
  await f.service.restore('g'); assert.equal(sha256(bytes(f.addon)), fallback.sha256);
});

test('created MFG keeps removal ownership across upgrade and downgrade with one active canonical provider', async t => {
  const f = fixture(t);
  await f.service.prepare('g', { providerId: 'mfgunlock-0.6.1' });
  await f.service.prepare('g', { providerId: 'mfgunlock-0.7-zh-CN' });
  const down = await f.service.prepare('g', { providerId: 'mfgunlock-0.7' });
  assert.equal(JSON.parse(bytes(f.receipt)).files[0].mode, 'created');
  assert.equal(sha256(bytes(f.addon)), providerById('mfgunlock-0.7').sha256);
  assert.equal(fs.readdirSync(f.dir).filter(name => name.endsWith('.addon64')).length, 1);
  await f.service.rollbackPrepare('g', down.undoToken); assert.equal(sha256(bytes(f.addon)), providerById('mfgunlock-0.7-zh-CN').sha256);
  await f.service.restore('g'); assert.equal(fs.existsSync(f.addon), false);
});

test('upgrading an adopted provider preserves the first original across later switches and restart', async t => {
  const f = fixture(t), { providerById } = require('../src/product/fg-mfgunlock-resources');
  const fallback = providerById('mfgunlock-0.6.1');
  fs.copyFileSync(path.join(f.resources, 'fg-mfgunlock', fallback.directory, ADDON), f.addon);
  await f.service.prepare('g');
  await f.service.prepare('g', { providerId: 'mfgunlock-0.7-zh-CN' });
  const first = JSON.parse(bytes(f.receipt)).files[0]; assert.equal(first.mode, 'replaced'); assert.equal(first.original.sha256, fallback.sha256);
  await f.service.prepare('g', { providerId: 'mfgunlock-0.7' });
  assert.deepEqual(JSON.parse(bytes(f.receipt)).files[0].original, first.original);
  const restarted = createFgComponents(f.options); await restarted.restore('g');
  assert.equal(sha256(bytes(f.addon)), fallback.sha256); assert.equal(fs.existsSync(f.receipt), false);
});

test('original snapshot corruption and externally switched known provider block destructive restore', async t => {
  for (const corruption of ['original', 'active']) {
    const f = fixture(t), { providerById } = require('../src/product/fg-mfgunlock-resources');
    const old = providerById('mfgunlock-0.6.1');
    fs.copyFileSync(path.join(f.resources, 'fg-mfgunlock', old.directory, ADDON), f.addon);
    await f.service.prepare('g', { providerId: 'mfgunlock-0.7-zh-CN' });
    const receipt = JSON.parse(bytes(f.receipt));
    if (corruption === 'original') fs.writeFileSync(path.join(f.game, receipt.files[0].original.snapshot), 'changed original');
    else fs.copyFileSync(path.join(f.resources, 'fg-mfgunlock', 'versions/0.7', ADDON), f.addon);
    const before = bytes(f.addon), record = bytes(f.receipt);
    await assert.rejects(f.service.restore('g'), { code: 'SETTINGS_FG_EXTERNAL_CHANGE' });
    assert.deepEqual(bytes(f.addon), before); assert.deepEqual(bytes(f.receipt), record);
    assert.equal((await f.service.previewProvider('g', 'mfgunlock-0.6.1')).canApply, false);
  }
});

test('v2 0.6.1 receipts remain recoverable without catalog assets and keep original ownership', async t => {
  for (const mode of ['created', 'adopted']) {
    const f = fixture(t), { providerById } = require('../src/product/fg-mfgunlock-resources');
    const old = providerById('mfgunlock-0.6.1');
    fs.copyFileSync(path.join(f.resources, 'fg-mfgunlock', old.directory, ADDON), f.addon);
    fs.mkdirSync(path.dirname(f.receipt), { recursive: true });
    fs.writeFileSync(f.receipt, JSON.stringify({ version: 2, backend: 'mfgunlock', id: old.id, releaseVersion: old.version, exe: f.exe,
      files: [{ role: 'addon', rel: path.relative(f.game, f.addon), mode, after: old.sha256 }] }));
    fs.unlinkSync(path.join(f.resources, 'fg-mfgunlock/manifest.json'));
    await f.service.restore('g'); assert.equal(fs.existsSync(f.addon), mode === 'adopted');
    assert.equal(fs.existsSync(f.receipt), false);
  }
});

test('interrupted version replacement restores original bytes through durable file recovery', async t => {
  let stop = false;
  const f = fixture(t, { copyFile: async (...args) => { await fsp.copyFile(...args); if (stop) throw Object.assign(new Error('interrupted replacement'), { preservePending: true }); } });
  await f.service.prepare('g', { providerId: 'mfgunlock-0.6.1' }); const original = bytes(f.addon), receipt = bytes(f.receipt);
  stop = true; await assert.rejects(f.service.prepare('g', { providerId: 'mfgunlock-0.7-zh-CN' }), { code: 'errBackendRecovery' });
  assert.equal(sha256(bytes(f.addon)), providerById('mfgunlock-0.7-zh-CN').sha256);
  stop = false; await createFgComponents(f.options).recoverPending('g');
  assert.deepEqual(bytes(f.addon), original); assert.deepEqual(bytes(f.receipt), receipt);
});

test('disk FG flags never authorize production preparation without executable linked trusted evidence', async t => {
  const f = fixture(t, { getFeatureEvidence: undefined });
  const status = await f.service.inspect('g'); assert.equal(status.ready, false); assert.equal(status.canPrepare, false);
  await assert.rejects(f.service.prepare('g'), { code: 'SETTINGS_FG_BLOCKED' }); assert.equal(fs.existsSync(f.addon), false);
});
