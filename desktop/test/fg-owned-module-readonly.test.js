'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFgComponents } = require('../src/product/fg-components');
const { ADDON } = require('../src/product/fg-mfgunlock-resources');
const journal = require('../src/core/file-journal');
const { createCompactBundle } = require('../src/product/payload');
const { RECEIPT: EXTERNAL_RECEIPT } = require('../src/product/external-runtime');
const { fixture: operationFixture, peBytes, put, PROJECT, COMPONENT_RESOURCES } = require('./helpers/operation-integration-fixture');
const LEGACY_PAYLOAD_ROOT = process.env.DLSS5_TEST_LEGACY_PAYLOAD_ROOT
  ? path.resolve(process.env.DLSS5_TEST_LEGACY_PAYLOAD_ROOT) : path.join(PROJECT, 'payload/nr-before-sr');

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-owned-readonly-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const game = path.join(root, 'game'), dir = path.join(game, 'bin'), exe = path.join(dir, 'Game.exe');
  const outside = path.join(root, 'other-HoYoShade', 'reshade-shaders', 'Addons');
  put(exe, peBytes('inert selected game')); put(path.join(dir, 'nvngx_dlssg.dll'), 'inert runtime');
  put(path.join(dir, 'ReShade.ini'), '[ADDON]\r\nAddonPath=.\r\n'); fs.mkdirSync(outside, { recursive: true });
  const layout = { source: 'game-directory', mode: 'local', verified: true, exe, runtimeDir: dir,
    addonDirectory: dir, activeConfigPath: path.join(dir, 'ReShade.ini'), needsRecovery: false, blockers: [] };
  const options = { resourcesPath: COMPONENT_RESOURCES, appDir: PROJECT,
    gameDirectory: () => game, gameExecutable: () => exe, getLayout: () => layout,
    detectHardware: async () => ({ series: ['RTX40'] }), scan: async () => ({ api: 'dx12', streamlineFg: true, reshadeAddon: true }),
    getFeatureEvidence: async () => ({ support: { status: 'supported', source: 'native-integration', capabilities: { mfgUnlock: { available: true, multipliers: [2, 3, 4] } } } }),
    pe: { getBitness: () => 64, getFileVersion: () => '310.8.0.0', getImports: () => [] },
    assertGameClosed: async () => {}, antiCheatPresent: () => false, ...overrides };
  const service = createFgComponents(options);
  const custom = () => {
    const text = `; personal HoYoShade\r\n[ADDON]\r\nAddonPath=${outside}\r\n[INPUT]\r\nKeyOverlay=120,1,0,0\r\n`;
    put(layout.activeConfigPath, text);
    Object.assign(layout, { verified: false, addonDirectory: outside, blockers: ['ERR_ADDON_SEARCH_PATH'] });
    return text;
  };
  return { root, game, dir, exe, outside, layout, options, service, custom };
}

test('unowned custom outside AddonPath returns an empty read-only manifest while MFG writes remain blocked', async t => {
  const f = fixture(t), original = f.custom(), unowned = path.join(f.outside, ADDON);
  fs.copyFileSync(path.join(COMPONENT_RESOURCES, 'fg-mfgunlock', ADDON), unowned);
  const before = fs.readFileSync(unowned);
  assert.deepEqual(await f.service.ownedModuleManifest('game'), []);
  await assert.rejects(f.service.prepare('game'), { code: 'SETTINGS_FG_LAYOUT_UNVERIFIED' });
  await assert.rejects(f.service.previewProvider('game'), { code: 'SETTINGS_FG_LAYOUT_UNVERIFIED' });
  await assert.rejects(f.service.restore('game'), { code: 'SETTINGS_FG_LAYOUT_UNVERIFIED' });
  assert.equal(fs.readFileSync(f.layout.activeConfigPath, 'utf8'), original); assert.deepEqual(fs.readFileSync(unowned), before);
  assert.equal(fs.existsSync(path.join(f.game, '_DLSS5_Backup')), false); assert.equal(fs.existsSync(path.join(f.outside, '_DLSS5_Backup')), false);
});

test('read-only absence checks retain metadata in every bounded source or declared layout directory', async t => {
  for (const scope of ['game', 'exe', 'runtime', 'addon', 'config']) for (const name of ['xiaofeng-fg-components.json', 'xiaofeng-fg-migration.json', 'pending-switch.json']) {
    const f = fixture(t); f.custom();
    f.layout.runtimeDir = path.join(f.root, 'declared-runtime');
    f.layout.activeConfigPath = path.join(f.root, 'declared-config', 'ReShade.ini');
    const roots = { game: f.game, exe: f.dir, runtime: f.layout.runtimeDir, addon: f.outside, config: path.dirname(f.layout.activeConfigPath) };
    const file = path.join(roots[scope], '_DLSS5_Backup', name), original = '{"owner":"must remain inspectable"}\n'; put(file, original);
    await assert.rejects(f.service.ownedModuleManifest('game'), { code: 'SETTINGS_FG_LAYOUT_UNVERIFIED' }, scope + '/' + name);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
});

test('read-only absence proof does not traverse unrelated directories or use paths from metadata', async t => {
  const f = fixture(t); f.custom();
  const file = path.join(f.outside, 'unrelated-child', '_DLSS5_Backup', 'xiaofeng-fg-components.json'); put(file, 'unrelated owner');
  assert.deepEqual(await f.service.ownedModuleManifest('game'), []);
  assert.equal(fs.readFileSync(file, 'utf8'), 'unrelated owner');
});

test('unreadable metadata, another EXE and changing layout scope cannot be converted into an empty manifest', async t => {
  const f = fixture(t); f.custom();
  const metadata = path.join(f.outside, '_DLSS5_Backup', 'xiaofeng-fg-components.json'), originalLstat = fsp.lstat;
  const mocked = t.mock.method(fsp, 'lstat', async (...args) => {
    if (path.resolve(args[0]).toLowerCase() === metadata.toLowerCase()) throw Object.assign(new Error('fixture permission denied'), { code: 'EACCES' });
    return originalLstat(...args);
  });
  await assert.rejects(f.service.ownedModuleManifest('game'), { code: 'EACCES' }); mocked.mock.restore();
  f.layout.exe = path.join(f.dir, 'Other.exe');
  await assert.rejects(f.service.ownedModuleManifest('game'), { code: 'SETTINGS_FG_LAYOUT_UNVERIFIED' }); f.layout.exe = f.exe;
  let reads = 0;
  const changing = createFgComponents({ ...f.options, getLayout: () => ++reads === 1 ? { ...f.layout } : { ...f.layout, addonDirectory: path.join(f.root, 'changed-layout') } });
  await assert.rejects(changing.ownedModuleManifest('game'), { code: 'SETTINGS_FG_LAYOUT_UNVERIFIED' });
});

test('a real owned MFG receipt still detects byte drift and cannot disappear behind an unverified custom layout', async t => {
  const f = fixture(t); await f.service.prepare('game');
  const receiptFile = f.service.receiptFile('game'), receipt = fs.readFileSync(receiptFile), addon = path.join(f.dir, ADDON);
  assert.equal((await f.service.ownedModuleManifest('game')).length, 1);
  fs.writeFileSync(addon, 'changed owned MFG');
  await assert.rejects(f.service.ownedModuleManifest('game'), { code: 'SETTINGS_FG_EXTERNAL_CHANGE' });
  f.custom(); await assert.rejects(f.service.ownedModuleManifest('game'), { code: 'SETTINGS_FG_LAYOUT_UNVERIFIED' });
  assert.deepEqual(fs.readFileSync(receiptFile), receipt); assert.equal(fs.readFileSync(addon, 'utf8'), 'changed owned MFG');
});

test('an actual interrupted FG copy without a receipt remains blocking after AddonPath changes', async t => {
  const f = fixture(t, { copyFile: async (...args) => { await fsp.copyFile(...args); throw Object.assign(new Error('interrupted FG copy'), { preservePending: true }); } });
  await assert.rejects(f.service.prepare('game'), { code: 'errBackendRecovery' });
  const pendingFile = journal.pendingPath(f.game), pending = fs.readFileSync(pendingFile), addon = path.join(f.dir, ADDON), bytes = fs.readFileSync(addon);
  assert.equal(fs.existsSync(f.service.receiptFile('game')), false);
  assert.equal(JSON.parse(pending).owner.product, 'xiaofeng-fg-components');
  f.custom(); await assert.rejects(f.service.ownedModuleManifest('game'), { code: 'SETTINGS_FG_LAYOUT_UNVERIFIED' });
  assert.deepEqual(fs.readFileSync(pendingFile), pending); assert.deepEqual(fs.readFileSync(addon), bytes);
});

test('the real HoYo preview hook accepts an unowned custom AddonPath after direct HoYo restore and preserves personal bytes', async t => {
  let components, queries = 0;
  const f = await operationFixture(t, { api: 'dx12', family: 'RTX50', exeName: 'ZenlessZoneZero.exe',
    serviceOverrides: { getKnownComponents: async id => { queries++; return components ? components.ownedModuleManifest(id) : []; } },
    specialSetup: async ({ root, resourcesPath }) => {
      const payload = path.join(resourcesPath, 'payload/nr-before-sr');
      const loader = fs.readFileSync(path.join(LEGACY_PAYLOAD_ROOT, 'fixed/RTX50/ReShade64.dll'));
      for (const family of ['RTX40', 'RTX50']) put(path.join(payload, 'fixed', family, 'ReShade64.dll'), loader);
      put(path.join(payload, 'bundle.json'), JSON.stringify(createCompactBundle(payload,
        ['fixture-core-1', 'fixture-core-2'].map(id => ({ id, label: id, compatibility: 'dx11' })), 'fixture-core-1')));
      put(path.join(resourcesPath, 'hoyoshade/component.json'), fs.readFileSync(path.join(PROJECT, 'resources/hoyoshade/component.json')));
      const launcher = path.join(root, 'HYP.exe'); put(launcher, peBytes('inert HoYoPlay; never launched'));
      return { launcher };
    } });
  components = f.components;
  const request = { api: 'dx12', route: 'native', loadingBackend: 'hoyoshade',
    hoyo: { family: 'zzz', channel: 'cn', launcher: { kind: 'hoyoplay', path: f.special.launcher } } };
  const install = await f.plans.preview(f.id, request); await f.plans.apply(install.planId, { confirm: true, fingerprint: install.fingerprint });
  const restore = await f.plans.preview(f.id, { uninstall: 'restore' }); await f.plans.apply(restore.planId, { confirm: true, fingerprint: restore.fingerprint });
  const receipt = path.join(f.gameRoot, EXTERNAL_RECEIPT), receiptBefore = fs.readFileSync(receipt);
  assert.equal(JSON.parse(receiptBefore).mode, 'local'); assert.equal(fs.existsSync(path.join(f.gameRoot, '_DLSS5_Backup/xiaofeng-manager.json')), false);
  const outside = path.join(f.root, 'separate-HoYoShade', 'reshade-shaders', 'Addons'), ini = path.join(f.exeDir, 'ReShade.ini');
  const personal = `; personal external setup\r\n[ADDON]\r\nAddonPath=${outside}\r\n[INPUT]\r\nKeyOverlay=120,1,0,0\r\n[STYLE]\r\nHdrOverlayBrightness=203\r\n`;
  put(path.join(outside, 'personal-note.txt'), 'preserve this unrelated setup'); put(ini, personal);
  const layout = f.service.getLayout(f.id); assert.equal(layout.verified, false); assert.equal(layout.addonDirectory, outside);
  const beforeQueries = queries, preview = await f.plans.preview(f.id, request);
  assert.ok(queries > beforeQueries, 'the actual AppService known-components hook enumerates MFG ownership');
  assert.deepEqual(preview.blockers, []); assert.equal(preview.resolved.loadingBackend, 'hoyoshade');
  assert.equal(fs.readFileSync(ini, 'utf8'), personal); assert.deepEqual(fs.readFileSync(receipt), receiptBefore);
  assert.equal(fs.readFileSync(path.join(outside, 'personal-note.txt'), 'utf8'), 'preserve this unrelated setup');
});
