'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLibraryService } = require('../src/product/library-service');
const { createLaunchContext, steamLaunchIdentity } = require('../src/product/launch-evidence');
const { annotateApi } = require('../src/product/api-evidence');

// Readable PE headers/import tables, without executable code. All scans use the
// production scanner and PE reader; no fixture process or payload is executed.
function binary(file, { imports = [], markers = [], bits = 64, size = 8192 } = {}) {
  const b = Buffer.alloc(8192), optional = 0x98, optionalSize = bits === 64 ? 240 : 224;
  b.writeUInt16LE(0x5a4d); b.writeUInt32LE(0x80, 0x3c); b.writeUInt32LE(0x4550, 0x80);
  b.writeUInt16LE(bits === 64 ? 0x8664 : 0x14c, 0x84); b.writeUInt16LE(1, 0x86); b.writeUInt16LE(optionalSize, 0x94);
  b.writeUInt16LE(bits === 64 ? 0x20b : 0x10b, optional);
  const section = optional + optionalSize, directory = optional + (bits === 64 ? 112 : 96) + 8;
  b.write('.idata', section); b.writeUInt32LE(0x1000, section + 8); b.writeUInt32LE(0x1000, section + 12);
  b.writeUInt32LE(0x1000, section + 16); b.writeUInt32LE(0x400, section + 20);
  if (imports.length) { b.writeUInt32LE(0x1000, directory); b.writeUInt32LE((imports.length + 1) * 20, directory + 4); }
  imports.forEach((name, index) => { b.writeUInt32LE(0x1200 + index * 128, 0x400 + index * 20 + 12); b.write(name, 0x600 + index * 128); });
  b.write(markers.join(' '), 0x1800);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, b);
  if (size > b.length) { const fd = fs.openSync(file, 'r+'); try { fs.ftruncateSync(fd, size); } finally { fs.closeSync(fd); } }
  return file;
}

function fixture(t, options = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-api-production-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'Game'), steamRoot = path.join(temp, 'Steam');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(steamRoot, { recursive: true });
  const exe = binary(path.join(root, options.name || 'Game.exe'), options);
  binary(path.join(path.dirname(exe), 'nvngx_dlss.dll'));
  const game = { launcher: options.launcher || 'Steam', id: options.id || '42', dir: root, steamRoot, name: 'Game' };
  let active = '123';
  const documentsDir = path.join(temp, 'Documents');
  const library = createLibraryService({ documentsDir, library: { discover: () => ({ games: [game] }), dedupe: rows => rows },
    launchEvidence: { readActiveAccount: () => active }, runtimeEvidence: options.runtimeEvidence });
  function profile(account, args, appid = game.id) {
    const file = path.join(steamRoot, 'userdata', account, 'config', 'localconfig.vdf');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `"UserLocalConfigStore" { "Software" { "Valve" { "Steam" { "apps" { "${appid}" { "LaunchOptions" "${args}" } } } } } }`);
  }
  const row = async (state = {}) => (await library.scanAll(state)).find(item => item.chosen?.path === exe);
  return { temp, root, steamRoot, exe, game, documentsDir, library, profile, row, active: value => { active = value; } };
}

test('production library gives pure DX11 and DX12 an automatic default, independent of bridge verification', async t => {
  for (const api of ['dx11', 'dx12']) {
    const f = fixture(t, { imports: [api === 'dx11' ? 'd3d11.dll' : 'd3d12.dll'] });
    const game = await f.row();
    assert.equal(game.chosen.apiResolution.api, api); assert.equal(game.supported, true);
    assert.equal(game.apiOverride, 'auto'); assert.equal(game.chosen.apiAssessment.observedApi, null);
    assert.equal(game.chosen.apiAssessment.confidence, 'high');
    assert.equal(game.chosen.apiAssessment.bridgeStatus.required, api === 'dx11');
    assert.equal(game.chosen.apiAssessment.bridgeStatus.verified, false);
    assert.equal(game.steamAppId, '42'); assert.equal(game.verifiedSteamAppId, '42'); assert.equal(game.steamRoot, f.steamRoot); assert.equal(game.launchMode, 'steam');
  }
});

test('SDK and overlay modules do not create renderer conflicts or provide a scanner fallback', async t => {
  const f = fixture(t, { imports: ['d3d12.dll', 'amd_ags_x64.dll', 'gameoverlayrenderer64.dll'] });
  binary(path.join(f.root, 'amd_ags_x64.dll'), { imports: ['d3d11.dll', 'd3d12.dll'] });
  binary(path.join(f.root, 'gameoverlayrenderer64.dll'), { imports: ['d3d11.dll'] });
  let game = await f.row();
  assert.equal(game.chosen.detectedApi, 'dx12'); assert.deepEqual(game.chosen.apiAssessment.capabilities, ['dx12']);
  assert.deepEqual(game.chosen.apiAssessment.conflicts, []);
  assert.ok(game.chosen.apiAssessment.evidence.some(row => row.source === 'graphics-sdk'));
  binary(f.exe, { imports: ['amd_ags_x64.dll'] });
  game = await f.row();
  assert.equal(game.chosen.detectedApi, 'unknown', 'vendor first-match SDK output is not reintroduced as chosen-static');
});

test('a linked renderer module outranks bootstrap imports only with matching architecture', async t => {
  const f = fixture(t, { imports: ['d3d11.dll', 'render_engine.dll'] });
  const engine = binary(path.join(f.root, 'render_engine.dll'), { imports: ['d3d12.dll'] });
  let game = await f.row();
  assert.equal(game.chosen.detectedApi, 'dx12'); assert.equal(game.chosen.apiAssessment.resolutionReason, 'linked-engine');
  assert.deepEqual(new Set(game.chosen.apiAssessment.capabilities), new Set(['dx11', 'dx12']));
  binary(engine, { imports: ['d3d12.dll'], bits: 32 });
  game = await f.row();
  assert.equal(game.chosen.detectedApi, 'dx11');
  assert.ok(game.chosen.apiAssessment.coverage.skipped.some(row => row.reason === 'architecture-mismatch'));
});

test('production BG3 selection preserves the exact renderer EXE and Steam identity', async t => {
  const f = fixture(t, { id: '1086940', name: 'bin/bg3_dx11.exe', imports: ['d3d11.dll'] });
  const vk = binary(path.join(f.root, 'bin', 'bg3.exe'), { imports: ['d3d11.dll'], markers: ['vkCreateInstance'] });
  for (const [exe, api] of [[f.exe, 'dx11'], [vk, 'vulkan']]) {
    const state = { manualGames: [f.root], manualExecutables: [{ root: f.root, file: exe }] };
    const game = (await f.library.scanAll(state)).find(row => row.chosen?.path === exe);
    assert.equal(game.chosen.detectedApi, api); assert.equal(game.chosen.apiResolution.source, 'game-entry');
    assert.equal(game.launchExecutable, exe); assert.equal(game.steamAppId, '1086940');
    assert.deepEqual(game.chosen.apiAssessment.conflicts, []);
  }
});

test('production RDR2 uses current Known Documents settings, preserving selectable capabilities when missing', async t => {
  const f = fixture(t, { id: '1174180', name: 'RDR2.exe', imports: ['d3d12.dll', 'vulkan-1.dll', 'd3d9.dll'] });
  const file = path.join(f.documentsDir, 'Rockstar Games', 'Red Dead Redemption 2', 'Settings', 'system.xml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const [setting, api] of [['Vulkan', 'vulkan'], ['DX12', 'dx12']]) {
    fs.writeFileSync(file, `<rage__fwuiSystemSettingsCollection><advancedGraphics><API>kSettingAPI_${setting}</API></advancedGraphics></rage__fwuiSystemSettingsCollection>`);
    const game = await f.row();
    assert.equal(game.chosen.apiAssessment.configuredApi, api); assert.equal(game.chosen.detectedApi, api);
    assert.equal(game.chosen.apiSettings.file, file);
  }
  fs.unlinkSync(file);
  const game = await f.row(); assert.equal(game.chosen.detectedApi, 'unknown');
  assert.deepEqual(game.chosen.supportedApis, ['vulkan', 'dx12']);
});

test('Steam uses only the active account, while exact-EXE launch overrides do not mutate API overrides', async t => {
  const f = fixture(t, { imports: ['d3d11.dll', 'd3d12.dll'] });
  f.profile('123', '-dx11'); f.profile('456', '-dx12'); f.active('456');
  let game = await f.row();
  assert.equal(game.chosen.detectedApi, 'dx12'); assert.equal(game.chosen.apiAssessment.configuredApi, 'dx12');
  const state = { gameOverrides: { [f.root.toLowerCase()]: { launchMode: 'exe', launchExecutable: f.exe, api: 'dx11', apiExecutable: f.exe } } };
  const before = structuredClone(state); game = await f.row(state);
  assert.equal(game.launchMode, 'exe'); assert.equal(game.launchModeOverride, 'exe');
  assert.equal(game.chosen.detectedApi, 'mixed'); assert.equal(game.chosen.apiAssessment.configuredApi, null);
  assert.equal(game.chosen.apiResolution.api, 'dx11'); assert.deepEqual(game.chosen.apiAssessment.conflicts, []);
  assert.deepEqual(state, before);
  state.gameOverrides[f.root.toLowerCase()].launchExecutable = path.join(f.root, 'Other.exe');
  game = await f.row(state); assert.equal(game.launchMode, 'steam'); assert.equal(game.launchModeOverride, 'auto');
  assert.equal(game.apiOverride, 'dx11', 'launch and API bindings are independent');
});

test('unknown Steam account and direct EXE parameters are clues, not conflicts', async t => {
  const f = fixture(t, { imports: ['d3d12.dll'] });
  f.profile('123', '-dx11'); f.profile('456', '-dx12'); f.active(null);
  let game = await f.row();
  assert.equal(game.chosen.detectedApi, 'dx12'); assert.equal(game.steamAccountVerified, false);
  assert.deepEqual(game.chosen.apiAssessment.conflicts, []); assert.equal(game.chosen.apiAssessment.configuredApi, null);
  f.active('123');
  game = await f.row({ gameOverrides: { [f.root.toLowerCase()]: { launchMode: 'exe', launchExecutable: f.exe } } });
  assert.equal(game.chosen.detectedApi, 'dx12'); assert.equal(game.chosen.apiAssessment.configuredApi, null);
  f.profile('123', 'other-wrapper.exe %command% -dx11');
  game = await f.row(); assert.equal(game.chosen.detectedApi, 'dx12', 'unproven wrapper arguments are not current game configuration');
  f.profile('123', '-label=dx11 -mode--renderer=dx11');
  game = await f.row(); assert.equal(game.chosen.detectedApi, 'dx12', 'substrings in another option cannot select the renderer');
});

test('Steam identity requires the selected absolute path in one discovered installation', t => {
  const f = fixture(t, { imports: ['d3d12.dll'] });
  assert.equal(steamLaunchIdentity(f.exe, [f.game]).steamIdentityVerified, true);
  assert.deepEqual(steamLaunchIdentity(path.join(f.temp, 'Another', 'Game.exe'), [f.game]), {});
  assert.deepEqual(steamLaunchIdentity(f.exe, [{ ...f.game, launcher: '手动添加' }]), {});
  assert.deepEqual(steamLaunchIdentity(f.exe, [f.game, { ...f.game, id: '99' }]), {});
  const read = createLaunchContext({ readActiveAccount: () => '999' });
  f.profile('123', '-dx11');
  assert.deepEqual(read({ ...f.game, launchMode: 'steam' }).launchArguments, [], 'an unreadable active profile never falls back to another account');
});

test('large EXEs and engines keep header imports while coverage discloses byte and module budgets', async t => {
  const large = 33 * 1024 * 1024;
  const f = fixture(t, { imports: ['d3d11.dll', 'render_engine.dll'], size: large });
  binary(path.join(f.root, 'render_engine.dll'), { imports: ['d3d12.dll'], size: large });
  for (let i = 0; i < 9; i++) binary(path.join(f.root, `engine${i}.dll`), { imports: ['d3d11.dll'] });
  const game = await f.row(), assessment = game.chosen.apiAssessment;
  assert.equal(assessment.effectiveApi, 'dx12'); assert.equal(assessment.coverage.exeImports, 'read');
  assert.equal(assessment.coverage.exeMarkers, 'budget-skipped'); assert.equal(assessment.coverage.complete, false);
  assert.equal(assessment.coverage.engineModules.discovered, 10); assert.equal(assessment.coverage.engineModules.inspected, 8);
  assert.equal(assessment.coverage.skipped.filter(row => row.reason === 'engine-module-budget').length, 2);
  assert.equal(assessment.coverage.skipped.filter(row => row.reason === 'marker-byte-budget').length, 2);
});

test('DXVK input/presentation are distinct, while ReShade and wrong-bitness proxies do not become Vulkan', async t => {
  const f = fixture(t, { imports: ['d3d11.dll'] }), proxy = path.join(f.root, 'd3d11.dll');
  binary(proxy, { markers: ['DXVK', 'vkGetInstanceProcAddr'] });
  let game = await f.row(), assessment = game.chosen.apiAssessment;
  assert.equal(assessment.inputApi, 'dx11'); assert.equal(assessment.presentationApi, 'vulkan');
  assert.equal(game.chosen.apiResolution.api, 'vulkan'); assert.equal(assessment.bridgeStatus.kind, 'dxvk');
  assert.equal(assessment.observedApi, null); assert.equal(assessment.bridgeStatus.verified, false);
  for (const options of [{ markers: ['DXVK', 'vkGetInstanceProcAddr'], bits: 32 }, { markers: ['DXVK', 'vkGetInstanceProcAddr', 'ReShade'] }]) {
    binary(proxy, options); game = await f.row(); assert.equal(game.chosen.detectedApi, 'dx11');
  }
});

test('current runtime evidence requires EXE, PID, process start, session, swapchain, and freshness', t => {
  const f = fixture(t, { imports: ['d3d11.dll'], markers: ['D3D11CreateDevice'] });
  const now = Date.now(), session = { id: 'session', pid: 1234, exe: f.exe, startedAt: now - 1000, alive: true };
  const log = { exe: f.exe, api: 'dx12', bound: true, sessionId: session.id, pid: session.pid,
    processStartedAt: session.startedAt, kind: 'swapchain', observedAt: now };
  const scan = { chosen: { path: f.exe, api: 'dxgi', apiLabel: 'DirectX 11', bitness: 64 } };
  const assess = (changes = {}, sessionChanges = {}) => annotateApi(scan, f.root, { now, runtimeSession: { ...session, ...sessionChanges }, logEvidence: { ...log, ...changes } }).chosen.apiAssessment;
  assert.equal(assess().observedApi, 'dx12'); assert.equal(assess().confidence, 'confirmed');
  for (const changes of [{ exe: path.join(f.root, 'Other.exe') }, { pid: 4321 }, { processStartedAt: now - 500 },
    { sessionId: 'old' }, { kind: 'device-created' }, { observedAt: now - 120000 }, { observedAt: now + 60000 }]) {
    assert.equal(assess(changes).observedApi, null); assert.equal(assess(changes).effectiveApi, 'dx11');
  }
  assert.equal(assess({}, { alive: false }).observedApi, null);
  const staticOnly = annotateApi(scan, f.root).chosen.apiAssessment;
  assert.equal(staticOnly.evidence.filter(row => row.kind === 'capability' && row.api === 'dx11').length, 1);
  assert.deepEqual(staticOnly.conflicts, []);
});
