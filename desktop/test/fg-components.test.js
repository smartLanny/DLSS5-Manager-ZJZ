'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createFgComponents, mergeUalConfig, validControl } = require('../src/product/fg-legacy-components');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-fg-components-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, 'game'), dir = path.join(game, 'Binaries', 'Win64'), exe = path.join(dir, 'Game.exe'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(exe, 'synthetic');
  const resources = path.join(root, 'resources', 'fg-components'); fs.mkdirSync(resources, { recursive: true });
  const sourceFiles = { core: ['RTX40MFGCore.dll', 'core'], asi: ['RTX40MFG.asi', 'asi'], overlay: ['RTX40MFG-UI.addon64', 'overlay'], ual: ['ual-x64.dll', 'ual'],
    ualConfig: ['global.ini', '[GlobalSets]\nLoadPlugins=1\nLoadFromScriptsOnly=1\nLoadExtraPlugins=RTX40MFG.asi\nDontLoadFromDllMain=0\nForceEntryPointHook=0\n'] };
  const files = {};
  for (const [role, [name, content]] of Object.entries(sourceFiles)) { fs.writeFileSync(path.join(resources, name), content); files[role] = { file: name, sha256: sha256(Buffer.from(content)) }; }
  fs.writeFileSync(path.join(resources, 'manifest.json'), JSON.stringify({ version: 1, id: 'test-v1', protocol: 11, files,
    ualProxyNames: ['dinput8.dll', 'version.dll', 'winmm.dll'], sources: [] }));
  let series = options.series || 'RTX40';
  const facts = { api: options.api || 'dx12', streamlineFg: options.streamlineFg !== false, reshadeAddon: options.reshadeAddon !== false };
  const reshade = path.join(root, 'ReShade64.dll'); fs.writeFileSync(reshade, 'reshade');
  const service = createFgComponents({ resourcesPath: path.join(root, 'resources'), appDir: root, gameDirectory: () => game, gameExecutable: () => exe,
    detectHardware: () => ({ family: series === 'RTX50' ? 'RTX50' : 'RTX40', series: [series] }), scan: async () => ({ ...facts }),
    pe: { getBitness: () => 64, getImports: () => options.imports || ['version.dll'] }, assertGameClosed: async () => {}, antiCheatPresent: () => options.antiCheat === true,
    inspectRuntime: options.inspectRuntime || (() => ({ status: 'available', ready: true, missing: [], message: 'fixture base files only' })),
    getReShadeSource: options.getReShadeSource || (async () => ({ file: reshade, sha256: sha256(Buffer.from('reshade')) })) });
  return { root, game, dir, exe, resources, files, facts, service, setSeries: value => { series = value; } };
}

test('UAL config merges required values while preserving an existing root-plugin scan choice', () => {
  const before = '[GlobalSets]\r\nLoadPlugins=0\r\nLoadFromScriptsOnly=0\r\nLoadExtraPlugins=Other.asi | "Mods\\Keep.asi"\r\n[FileLoader]\r\nOverloadFromFolder=keep\r\n';
  const after = mergeUalConfig(before);
  assert.match(after, /LoadPlugins=1/); assert.match(after, /LoadExtraPlugins=Other\.asi \| "Mods\\Keep\.asi" \| RTX40MFG\.asi/);
  assert.match(after, /LoadFromScriptsOnly=0/);
  assert.match(after, /ForceEntryPointHook=0/); assert.match(after, /\[FileLoader\]\r\nOverloadFromFolder=keep/);
  assert.equal(mergeUalConfig(after), after);
});

test('native FG and no-op component restore do not depend on NR payload availability', async t => {
  let runtimeChecks = 0;
  const f = fixture(t, { series: 'RTX50', inspectRuntime: () => { runtimeChecks++; throw new Error('must not inspect RTX50 runtime'); },
    getReShadeSource: async () => { throw new Error('missing NR payload'); } });
  assert.equal((await f.service.inspect('g')).ready, true);
  assert.equal(runtimeChecks, 0);
  assert.deepEqual(await f.service.restore('g'), { restored: false, unchanged: true });
});

test('RTX40 preparation adopts a verified early proxy and restore removes only owned components', async t => {
  const f = fixture(t), proxy = path.join(f.dir, 'version.dll'), ini = path.join(f.dir, 'version.ini');
  fs.copyFileSync(path.join(f.resources, f.files.ual.file), proxy);
  const originalIni = '[GlobalSets]\nLoadPlugins=0\nLoadExtraPlugins=Other.asi\n[FileLoader]\nOverloadFromFolder=keep\n'; fs.writeFileSync(ini, originalIni);
  const before = await f.service.inspect('g'); assert.equal(before.route, 'compatibility'); assert.equal(before.canPrepare, true); assert.equal(before.proxy, 'version.dll');
  const result = await f.service.prepare('g'); assert.equal(result.prepared, true); assert.equal(result.proxy, 'version.dll');
  for (const name of ['RTX40MFGCore.dll', 'RTX40MFG.asi', 'RTX40MFG-UI.addon64', 'RTX40MFG-Universal.json']) assert.equal(fs.existsSync(path.join(f.dir, name)), true);
  assert.equal(validControl(fs.readFileSync(path.join(f.dir, 'RTX40MFG-Universal.json'), 'utf8')), true);
  assert.match(fs.readFileSync(ini, 'utf8'), /Other\.asi \| RTX40MFG\.asi/);
  fs.unlinkSync(path.join(f.dir, 'RTX40MFGCore.dll'));
  assert.equal((await f.service.prepare('g')).prepared, true);
  const receipt = JSON.parse(fs.readFileSync(f.service.receiptFile('g'), 'utf8'));
  assert.equal(receipt.files.find(row => row.role === 'core').mode, 'created');
  assert.equal(receipt.files.find(row => row.role === 'ualConfig').mode, 'modified');
  await f.service.restore('g'); assert.equal(fs.existsSync(proxy), true); assert.equal(fs.readFileSync(ini, 'utf8'), originalIni);
  for (const name of ['RTX40MFGCore.dll', 'RTX40MFG.asi', 'RTX40MFG-UI.addon64', 'RTX40MFG-Universal.json']) assert.equal(fs.existsSync(path.join(f.dir, name)), false);
});

test('unsupported route, missing Streamline and unknown proxy never prepare files', async t => {
  const native = fixture(t, { series: 'RTX50' }); assert.equal((await native.service.inspect('g')).route, 'native'); assert.equal((await native.service.inspect('g')).ready, true);
  const blocked = fixture(t, { streamlineFg: false }); fs.writeFileSync(path.join(blocked.dir, 'version.dll'), 'foreign');
  const status = await blocked.service.inspect('g'); assert.equal(status.canPrepare, false); assert.match(status.blockers.join(' '), /Streamline/); assert.match(status.blockers.join(' '), /不会覆盖/);
  await assert.rejects(blocked.service.prepare('g'), { code: 'SETTINGS_FG_BLOCKED' }); assert.equal(fs.existsSync(path.join(blocked.dir, 'RTX40MFGCore.dll')), false);
});

test('RTX40 runtime gate blocks a complete component set without writing and clears on a fresh recheck', async t => {
  let available = false;
  const f = fixture(t, { inspectRuntime: () => available
    ? { status: 'available', ready: true, missing: [], message: 'base files present; game not verified' }
    : { status: 'missing', ready: false, missing: ['vcruntime140_1.dll'], message: '缺少有效的 Windows x64 VC++ 运行库文件：vcruntime140_1.dll。' } });
  for (const role of ['core', 'asi', 'overlay']) fs.copyFileSync(path.join(f.resources, f.files[role].file), path.join(f.dir, f.files[role].file));
  fs.copyFileSync(path.join(f.resources, f.files.ual.file), path.join(f.dir, 'version.dll'));
  fs.writeFileSync(path.join(f.dir, 'version.ini'), '[GlobalSets]\nLoadPlugins=1\nLoadFromScriptsOnly=1\nLoadExtraPlugins=RTX40MFG.asi\nDontLoadFromDllMain=0\nForceEntryPointHook=0\n');
  fs.writeFileSync(path.join(f.dir, 'RTX40MFG-Universal.json'), require('../src/product/fg-legacy-components').DEFAULT_CONTROL);
  const before = await f.service.inspect('g');
  assert.equal(before.runtime.status, 'missing'); assert.equal(before.ready, false); assert.equal(before.canPrepare, false);
  await assert.rejects(f.service.prepare('g'), { code: 'SETTINGS_FG_BLOCKED' });
  assert.equal(fs.existsSync(f.service.receiptFile('g')), false);
  available = true;
  const after = await f.service.inspect('g'); assert.equal(after.runtime.status, 'available'); assert.equal(after.ready, true);
});

test('RTX50 reports managed RTX40 cleanup and restore retains ReShade later owned by NR installer', async t => {
  const f = fixture(t, { reshadeAddon: false }); await f.service.prepare('g'); const dxgi = path.join(f.dir, 'dxgi.dll'); assert.equal(fs.existsSync(dxgi), true);
  const backup = path.join(f.game, '_DLSS5_Backup'); fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, 'xiaofeng-manager.json'), JSON.stringify({ version: 1, product: 'xiaofeng-dlss5-manager', installId: crypto.randomUUID(),
    game: { dir: f.game, exe: path.relative(f.game, f.exe), api: 'dx12' }, files: [{ rel: path.relative(f.game, dxgi), kind: 'reshade', original: { existed: false } }], conflicts: [] }));
  f.setSeries('RTX50'); const status = await f.service.inspect('g'); assert.equal(status.route, 'native'); assert.equal(status.needsCleanup, true); assert.equal(status.managed, true);
  const restored = await f.service.restore('g'); assert.deepEqual(restored.retained, [path.relative(f.game, dxgi)]); assert.equal(fs.existsSync(dxgi), true); assert.equal(fs.existsSync(path.join(f.dir, 'RTX40MFG.asi')), false);
});

test('RTX50 treats legacy plugin frontend as a retained conflict', async t => {
  const f = fixture(t, { series: 'RTX50' }), legacy = path.join(f.dir, 'plugins', 'RTX40MFG.asi');
  fs.mkdirSync(path.dirname(legacy), { recursive: true }); fs.writeFileSync(legacy, 'legacy-user-file');
  const status = await f.service.inspect('g'); assert.equal(status.route, 'native'); assert.equal(status.ready, false); assert.equal(status.managed, false);
  assert.match(status.blockers.join(' '), /非本工具收据管理/); assert.equal(fs.readFileSync(legacy, 'utf8'), 'legacy-user-file');
});

test('external edits to an owned component stop restore before changing any peer', async t => {
  const f = fixture(t); await f.service.prepare('g'); const core = path.join(f.dir, 'RTX40MFGCore.dll'), asi = path.join(f.dir, 'RTX40MFG.asi'); fs.writeFileSync(core, 'user changed');
  await assert.rejects(f.service.restore('g'), { code: 'SETTINGS_FG_EXTERNAL_CHANGE' }); assert.equal(fs.existsSync(asi), true); assert.equal(fs.readFileSync(core, 'utf8'), 'user changed');
});

test('restore tolerates a missing created component and cleans remaining owned files', async t => {
  const f = fixture(t); await f.service.prepare('g'); const core = path.join(f.dir, 'RTX40MFGCore.dll'); fs.unlinkSync(core);
  const result = await f.service.restore('g'); assert.equal(result.restored, true); assert.equal(fs.existsSync(core), false);
  for (const name of ['RTX40MFG.asi', 'RTX40MFG-UI.addon64', 'RTX40MFG-Universal.json']) assert.equal(fs.existsSync(path.join(f.dir, name)), false);
  assert.equal(fs.existsSync(f.service.receiptFile('g')), false);
});

test('component preparation uses the existing anti-cheat confirmation retry contract', async t => {
  const f = fixture(t, { antiCheat: true });
  await assert.rejects(f.service.prepare('g'), { code: 'ERR_ANTI_CHEAT_CONFIRM' }); assert.equal(fs.existsSync(path.join(f.dir, 'RTX40MFGCore.dll')), false);
  assert.equal((await f.service.prepare('g', { allowAntiCheat: true })).prepared, true);
});

test('an occupied proxy is skipped when another imported early proxy is free', async t => {
  const f = fixture(t, { imports: ['dinput8.dll', 'version.dll'] }); fs.writeFileSync(path.join(f.dir, 'version.dll'), 'another proxy');
  const status = await f.service.inspect('g'); assert.equal(status.canPrepare, true); assert.equal(status.proxy, 'dinput8.dll'); assert.doesNotMatch(status.blockers.join(' '), /覆盖/);
});

test('an existing verified UAL proxy wins over an earlier free import', async t => {
  const f = fixture(t, { imports: ['dinput8.dll', 'version.dll'] }); fs.copyFileSync(path.join(f.resources, f.files.ual.file), path.join(f.dir, 'version.dll'));
  const status = await f.service.inspect('g'); assert.equal(status.proxy, 'version.dll'); assert.equal(status.canPrepare, true);
});

test('legacy CET frontend blocks a second control path', async t => {
  const f = fixture(t), legacy = path.join(f.dir, 'plugins', 'cyber_engine_tweaks', 'mods', 'RTX40MFG', 'init.lua');
  fs.mkdirSync(path.dirname(legacy), { recursive: true }); fs.writeFileSync(legacy, 'legacy');
  const status = await f.service.inspect('g'); assert.equal(status.canPrepare, false); assert.match(status.blockers.join(' '), /两套前端/);
});

test('hard-linked UAL config is rejected without changing the external file', async t => {
  const f = fixture(t), external = path.join(f.root, 'external.ini'), linked = path.join(f.dir, 'version.ini');
  const original = '[GlobalSets]\nLoadPlugins=0\n'; fs.writeFileSync(external, original); fs.linkSync(external, linked);
  await assert.rejects(f.service.prepare('g'), { code: 'SETTINGS_LINK_BLOCKED' });
  assert.equal(fs.readFileSync(external, 'utf8'), original); assert.equal(fs.existsSync(path.join(f.dir, 'RTX40MFGCore.dll')), false);
});

test('a forged modified DLL receipt is rejected before restore', async t => {
  const f = fixture(t); await f.service.prepare('g'); const receiptFile = f.service.receiptFile('g'), receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  const core = receipt.files.find(row => row.role === 'core'); core.mode = 'modified'; core.beforeText = 'foreign'; core.before = sha256(Buffer.from('foreign'));
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  await assert.rejects(f.service.restore('g'), { code: 'SETTINGS_FG_RECEIPT' });
  assert.equal(fs.existsSync(path.join(f.dir, 'RTX40MFGCore.dll')), true);
});
