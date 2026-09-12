'use strict';
const { steamEntryContext } = require('../src/product/api-evidence');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { annotateApi } = require('../src/product/api-evidence');

function fakePe(files) {
  return {
    virtual: true,
    getImports(file) { return files[file] && files[file].imports || []; },
    findMarkers(file) { return new Set(files[file] && files[file].markers || []); }
  };
}
function scan(api = 'dxgi') {
  return { chosen: { path: 'C:/games/demo/game.exe', api, apiLabel: 'old label', dx12: false } };
}
function runtimeFor(exe, api, now = Date.now() + 100) {
  return { now, runtimeSession: { id: 'current-session', pid: 321, exe, startedAt: now - 1000, alive: true },
    logEvidence: { exe, api, bound: true, sessionId: 'current-session', pid: 321, processStartedAt: now - 1000, observedAt: now, kind: 'swapchain' } };
}

test('static DX12 evidence resolves DX12 and preserves existing fields', () => {
  const out = annotateApi(scan(), 'C:/games/demo', { pe: fakePe({ 'C:/games/demo/game.exe': { imports: ['d3d12.dll'] } }) });
  assert.equal(out.chosen.apiResolution.api, 'dx12');
  assert.equal(out.chosen.apiLabel, 'old label');
  assert.match(out.chosen.apiResolution.evidence[0], /d3d12/);
});

test('a linked Unity OpenGL import is a backend capability, not the active renderer', () => {
  const exe = 'C:/games/demo/game.exe', unity = 'C:/games/demo/UnityPlayer.dll';
  const context = { pe: fakePe({ [exe]: { imports: ['UnityPlayer.dll'] }, [unity]: { imports: ['opengl32.dll'] } }),
    engineModules: [{ path: unity, linked: true }] };
  const result = annotateApi(scan('opengl'), 'C:/games/demo', context).chosen;
  assert.equal(result.apiResolution.api, 'unknown');
  assert.equal(result.apiAssessment.resolutionReason, 'multi-backend-engine-unconfirmed');
  assert.ok(result.apiAssessment.capabilities.includes('opengl'));
  assert.equal(result.apiAssessment.observedApi, null);
  assert.equal(annotateApi(scan('opengl'), 'C:/games/demo', { ...context, apiOverride: 'dx11' }).chosen.apiResolution.api, 'dx11');
  assert.equal(annotateApi(scan('opengl'), 'C:/games/demo', { ...context, ...runtimeFor(exe, 'dx12') }).chosen.apiResolution.api, 'dx12');
});

test('single DX11 defaults automatically while its bridge remains unverified', () => {
  const out = annotateApi(scan(), 'C:/games/demo', { pe: fakePe({ 'C:/games/demo/game.exe': { imports: ['d3d11.dll'] } }) });
  assert.equal(out.chosen.apiResolution.api, 'dx11');
  assert.equal(out.chosen.apiAssessment.bridgeStatus.status, 'required');
  assert.equal(out.chosen.apiAssessment.observedApi, null);
});

test('DX11 EXE plus DX12 engine module is mixed', () => {
  const out = annotateApi(scan(), 'C:/games/demo', {
    pe: fakePe({ 'C:/games/demo/game.exe': { imports: ['d3d11.dll'] }, 'C:/games/demo/engine.dll': { markers: ['D3D12CreateDevice'] } }),
    engineModules: [{ path: 'C:/games/demo/engine.dll' }]
  });
  assert.equal(out.chosen.apiResolution.api, 'mixed');
});

test('Steam Requiem resolves its documented DX12 entry without treating static DX11 or REFramework as the renderer', () => {
  const root = 'C:/games/requiem', exe = root + '/re9.exe', loader = root + '/dinput8.dll';
  const pe = fakePe({ [exe]: { imports: ['d3d11.dll', 'dinput8.dll'] }, [loader]: { imports: ['d3d11.dll', 'd3d12.dll'] } });
  const input = { chosen: { path: exe, api: 'dxgi', apiLabel: 'DirectX 11', bitness: 64 } };
  const options = { pe, steamAppId: '3764200', engineModules: [loader] };
  const result = annotateApi(input, root, options);
  assert.equal(result.chosen.detectedApi, 'dx12'); assert.equal(result.chosen.detectedApiResolution.source, 'game-entry');
  assert.equal(annotateApi(input, root, { ...options, steamAppId: 'other' }).chosen.detectedApi, 'dx11');
  assert.equal(annotateApi({ chosen: { ...input.chosen, path: root + '/bin/re9.exe' } }, root, options).chosen.detectedApi, 'dx11');
  const explicit = annotateApi(input, root, { ...options, apiOverride: 'dx11' });
  assert.equal(explicit.chosen.detectedApi, 'dx12'); assert.equal(explicit.chosen.apiResolution.api, 'dx11');
  const conflict = annotateApi(input, root, { ...options, ...runtimeFor(exe, 'dx11') });
  assert.equal(conflict.chosen.detectedApi, 'mixed', 'a bound runtime conflict still requires review');
  assert.equal(annotateApi(input, root, { ...options, launchArguments: '-dx11' }).chosen.detectedApi, 'dx12');
  assert.equal(annotateApi(input, root, { ...options, launchMode: 'steam', launchArgumentsApplied: true,
    launchArgumentsSource: 'steam-active-account', launchArguments: '-dx11' }).chosen.detectedApi, 'mixed');
});

test('large EXEs still use bounded import metadata without scanning all marker bytes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-large-exe-')), exe = path.join(root, 'game.exe');
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.writeFileSync(exe, 'fixture');
  const statSync = fs.statSync;
  t.mock.method(fs, 'statSync', (file, ...args) => {
    const stat = statSync(file, ...args); if (String(file) === exe) stat.size = 587657120; return stat;
  });
  let imports = 0, markers = 0;
  const pe = { getImports: file => { assert.equal(file, exe); imports++; return ['d3d12.dll']; },
    findMarkers: () => { markers++; return []; } };
  const result = annotateApi({ chosen: { path: exe, api: 'dxgi', apiLabel: '' } }, root, { pe, engineModules: [] });
  assert.equal(result.chosen.detectedApi, 'dx12'); assert.equal(imports, 1); assert.equal(markers, 0);
});

test('documented BG3 entry points require Steam identity and exact path, while manual API stays independent', () => {
  const root='C:/games/bg3', vk=root+'/bin/bg3.exe', dx=root+'/bin/bg3_dx11.exe';
  const pe=fakePe({[vk]:{},[dx]:{imports:['d3d11.dll']}});
  const scanFor=exe=>({chosen:{path:exe,api:'dxgi',apiLabel:''}});
  for(const [exe,api] of [[vk,'vulkan'],[dx,'dx11']]) {
    const result=annotateApi(scanFor(exe),root,{pe,steamAppId:'1086940'});
    assert.equal(result.chosen.detectedApi,api);assert.equal(result.chosen.detectedApiResolution.source,'game-entry');
  }
  assert.equal(annotateApi(scanFor(dx),root,{pe,steamAppId:'999'}).chosen.detectedApi,'dx11');
  assert.notEqual(annotateApi(scanFor(dx),root,{pe,steamAppId:'999'}).chosen.apiResolution.source,'game-entry');
  assert.equal(annotateApi(scanFor(vk),root,{pe,steamAppId:'1086940',logEvidence:{bound:false,apis:['dx12'],evidence:'旧 carrier 创建过 DX12 设备'}}).chosen.detectedApi,'vulkan');
  assert.equal(annotateApi(scanFor(root+'/other/bg3.exe'),root,{pe,steamAppId:'1086940'}).chosen.detectedApi,'unknown');
  const override=annotateApi(scanFor(vk),root,{pe,steamAppId:'1086940',apiOverride:'dx11'});
  assert.equal(override.chosen.detectedApi,'vulkan');assert.equal(override.chosen.apiResolution.api,'dx11');
});

test('a DX12 game importing dual-API AMD AGS stays DX12; real engine conflicts remain mixed', () => {
  const exe='C:/games/demo/game.exe', sdk='C:/games/demo/amd_ags_x64.dll', engine='C:/games/demo/render_engine.dll';
  const pe=fakePe({[exe]:{imports:['d3d12.dll','amd_ags_x64.dll']},[sdk]:{markers:['D3D11CreateDevice','D3D12CreateDevice']},[engine]:{imports:['d3d11.dll']}});
  const result=annotateApi(scan(),'C:/games/demo',{pe,engineModules:[sdk]});
  assert.equal(result.chosen.apiResolution.api,'dx12');
  assert.match(result.chosen.apiResolution.evidence.join(' '),/通用显卡 SDK/);
  assert.equal(annotateApi(scan(),'C:/games/demo',{pe,engineModules:[sdk,engine]}).chosen.apiResolution.api,'mixed');
});

test('explicit override wins without changing original API fields', () => {
  const out = annotateApi(scan(), 'C:/games/demo', { apiOverride: 'dx11', pe: fakePe({}) });
  assert.equal(out.chosen.apiResolution.api, 'dx11');
  assert.equal(out.chosen.api, 'dxgi');
  assert.equal(out.chosen.apiLabel, 'old label');
});

test('carrier/proxy module names are excluded from engine evidence', () => {
  const out = annotateApi(scan(), 'C:/games/demo', {
    pe: fakePe({ 'C:/games/demo/nrchain_nvngx.dll': { imports: ['d3d12.dll'] }, 'C:/games/demo/real-engine.dll': {} }),
    engineModules: [{ path: 'C:/games/demo/nrchain_nvngx.dll' }]
  });
  assert.equal(out.chosen.apiResolution.api, 'unknown');
});

test('unbound runtime log and launch argument remain clues', () => {
  const out = annotateApi(scan(), 'C:/games/demo', {
    pe: fakePe({ 'C:/games/demo/game.exe': {} }),
    launchArguments: '--renderer dx11',
    logEvidence: { exe: 'C:/other/game.exe', api: 'dx12', bound: false }
  });
  assert.equal(out.chosen.apiResolution.api, 'unknown');
  assert.ok(out.chosen.apiResolution.evidence.some(value => /线索|绑定/.test(value)));
});

test('only rigorously bound runtime log can resolve DX12', () => {
  const out = annotateApi(scan(), 'C:/games/demo', {
    pe: fakePe({ 'C:/games/demo/game.exe': {} }),
    ...runtimeFor('C:/games/demo/game.exe', 'dx12')
  });
  assert.equal(out.chosen.apiResolution.api, 'dx12');
  assert.equal(out.chosen.apiResolution.source, 'runtime-log');
});

test('known incompatible API remains explicit and separate from install support', () => {
  const out = annotateApi(scan('vulkan'), 'C:/games/demo', { pe: fakePe({}) });
  assert.equal(out.chosen.apiResolution.api, 'vulkan');
  assert.equal(out.chosen.detectedApi, 'vulkan');
});

test('raw API names preserve multiple capabilities and a unique DX11 default', () => {
  for (const fields of [{ api: 'dx11', dx12: true }, { api: 'dx12', dx11: true }, { apiLabel: 'DX11 / DX12' }]) {
    const input = scan(); Object.assign(input.chosen, fields);
    const out = annotateApi(input, 'C:/games/demo', { pe: fakePe({}) });
    assert.equal(out.chosen.apiResolution.api, 'mixed');
  }
  const out = annotateApi(scan('dx11'), 'C:/games/demo', { pe: fakePe({}) });
  assert.equal(out.chosen.apiResolution.api, 'dx11');
});

test('manual route keeps the independently detected API evidence', () => {
  const out = annotateApi(scan(), 'C:/games/demo', { apiOverride: 'opengl', pe: fakePe({ 'C:/games/demo/game.exe': { imports: ['d3d12.dll'] } }) });
  assert.equal(out.chosen.apiResolution.api, 'opengl'); assert.equal(out.chosen.detectedApiResolution.api, 'dx12');
  assert.equal(out.chosen.detectedApi, 'dx12'); assert.equal(out.chosen.apiResolution.source, 'override');
});

test('default PE reader handles a real bounded temporary fixture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-evidence-'));
  const exe = path.join(dir, 'game.exe');
  fs.writeFileSync(exe, Buffer.alloc(128, 0));
  const out = annotateApi({ chosen: { path: exe, api: 'dxgi', apiLabel: '' } }, dir);
  assert.equal(out.chosen.apiResolution.api, 'unknown');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unused launch arguments do not conflict with the actual direct EXE route', () => {
  const out = annotateApi(scan(), 'C:/games/demo', {
    pe: fakePe({ 'C:/games/demo/game.exe': { imports: ['d3d12.dll'] } }),
    launchArguments: '--renderer d3d11'
  });
  assert.equal(out.chosen.apiResolution.api, 'dx12');
  assert.deepEqual(out.chosen.apiAssessment.conflicts, []);
});

test('combined labels alone never become pure DX11 and unknown stays selectable', () => {
  const mixed = scan(); mixed.chosen.apiLabel = 'DirectX 11/12';
  assert.equal(annotateApi(mixed, 'C:/games/demo', { pe: fakePe({}) }).chosen.apiResolution.api, 'mixed');
  assert.equal(annotateApi(scan('unknown'), 'C:/games/demo', { pe: fakePe({}) }).chosen.apiResolution.api, 'unknown');
});

test('default engine discovery checks a renderer even when EXE already hints DX11', t => {
  const fs = require('fs'), path = require('path'), os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-engine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exe = path.join(root, 'game.exe'), engine = path.join(root, 'render_engine.dll');
  fs.writeFileSync(exe, 'fixture'); fs.writeFileSync(engine, 'fixture');
  const input = { chosen: { path: exe, api: 'dxgi', apiLabel: 'DirectX 11', via: 'imports' } };
  const output = annotateApi(input, root, { pe: fakePe({ [exe]: { imports: ['d3d11.dll'] }, [engine]: { imports: ['d3d12.dll'] } }) });
  assert.equal(output.chosen.apiResolution.api, 'mixed');
  assert.ok(output.chosen.apiResolution.evidence.some(line => line.includes('render_engine.dll')));
});

test('actual ReShade header is EXE-bound but device creation is only historical evidence', t => {
  const fs = require('fs'), path = require('path'), os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exe = path.join(root, 'game.exe'); fs.writeFileSync(exe, 'fixture');
  const log = path.join(root, 'ReShade.log');
  fs.writeFileSync(log, `Initializing crosire's ReShade version '6.8.0.0' loaded from 'dxgi.dll' into '${exe}' ...\nRedirecting D3D12CreateDevice(...)\n`);
  const input = { chosen: { path: exe, api: 'dxgi', apiLabel: 'DirectX 11', via: 'imports' } };
  const output = annotateApi(input, root, { pe: fakePe({}) });
  assert.equal(output.chosen.apiResolution.api, 'dx11');
  assert.equal(output.chosen.apiAssessment.observedApi, null);
  assert.ok(output.chosen.apiResolution.evidence.some(line => /历史.*dx12/.test(line)));
  fs.writeFileSync(log, `Initializing crosire's ReShade version '6.8.0.0' into '${path.join(root, 'other.exe')}' ...\nRedirecting D3D12CreateDevice(...)\n`);
  assert.equal(annotateApi(input, root, { pe: fakePe({}) }).chosen.apiResolution.api, 'dx11');
});

test('unbound historical multi-device logs cannot downgrade a DX12 game to mixed', () => {
  const exe = 'C:/games/demo/game.exe';
  const result = annotateApi(scan(), 'C:/games/demo', {
    pe: fakePe({ [exe]: { imports: ['d3d12.dll'] } }),
    logEvidence: { exe, bound: false, apis: ['dx11', 'dx12'], evidence: '历史日志创建过 DX11/DX12 设备' }
  });
  assert.equal(result.chosen.detectedApi, 'dx12');
  assert.ok(result.chosen.detectedApiResolution.evidence.includes('历史日志创建过 DX11/DX12 设备'));
  const conflicting = annotateApi(scan(), 'C:/games/demo', {
    pe: fakePe({ [exe]: { imports: ['d3d12.dll'] } }), logEvidence: { exe, bound: true, api: 'dx11', apis: ['dx11'] }
  });
  assert.equal(conflicting.chosen.detectedApi, 'dx12', 'bound alone cannot prove a live process session');
  const observed = annotateApi(scan(), 'C:/games/demo', { pe: fakePe({ [exe]: { imports: ['d3d12.dll'] } }), ...runtimeFor(exe, 'dx11') });
  assert.equal(observed.chosen.detectedApi, 'dx11', 'a current swapchain supersedes a static capability');
  assert.equal(observed.chosen.apiAssessment.confidence, 'confirmed');
});

test('manual renderer identity requires the exact discovered Steam entry path', () => {
  const root = path.resolve('C:/games/Baldurs Gate 3');
  const exe = path.join(root, 'bin/bg3_dx11.exe');
  const game = { launcher: 'Steam', id: '1086940', dir: root };
  assert.deepEqual(steamEntryContext(exe, [game]), { steamAppId: '1086940', entryRoot: root });
  for (const [file, games] of [
    [exe, [{ ...game, id: '9999' }]],
    [exe, [{ ...game, launcher: '手动添加' }]],
    [path.join(root, 'other/bg3_dx11.exe'), [game]],
    [path.resolve('C:/games/unrelated/bin/bg3_dx11.exe'), [game]],
    [path.join(root, 'Launcher/LariLauncher.exe'), [game]]
  ]) assert.deepEqual(steamEntryContext(file, games), {});
  const out = annotateApi({ chosen: { path: exe, api: 'dxgi', apiLabel: 'DirectX 11' } }, path.dirname(exe), {
    ...steamEntryContext(exe, [game]), pe: fakePe({})
  });
  assert.equal(out.chosen.apiResolution.api, 'dx11');
});

test('RDR2 discovers the exact Steam entry and saved API overrides dual static capabilities while manual choice stays first', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rdr2-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exe = path.join(root, 'RDR2.exe'), documentsDir = path.join(root, 'KnownDocuments'); fs.writeFileSync(exe, 'fixture');
  const file = path.join(documentsDir, 'Rockstar Games', 'Red Dead Redemption 2', 'Settings', 'system.xml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const xml = api => `<rage__fwuiSystemSettingsCollection><advancedGraphics><API>kSettingAPI_${api}</API></advancedGraphics></rage__fwuiSystemSettingsCollection>`;
  fs.writeFileSync(file, xml('Vulkan'));
  const identity = steamEntryContext(exe, [{ launcher: 'Steam', id: '1174180', dir: root }]);
  assert.deepEqual(identity, { steamAppId: '1174180', entryRoot: root });
  const input = { chosen: { path: exe, api: 'dxgi', apiLabel: 'DirectX 12 / Vulkan', bitness: 64 } };
  const context = { ...identity, documentsDir, pe: fakePe({ [exe]: { imports: ['d3d12.dll', 'vulkan-1.dll', 'd3d9.dll'] } }), engineModules: [] };
  const detected = annotateApi(input, root, context).chosen;
  assert.equal(detected.apiResolution.api, 'vulkan'); assert.equal(detected.detectedApiResolution.source, 'game-settings');
  assert.deepEqual(detected.supportedApis, ['vulkan', 'dx12']); assert.equal(detected.apiSettings.file, file);
  assert.equal(detected.apiSettings.steamAppId, '1174180'); assert.equal(detected.apiSettings.entryRoot, root); assert.equal(detected.apiSettings.canSync, true);
  const manual = annotateApi(input, root, { ...context, apiOverride: 'dx12' }).chosen;
  assert.equal(manual.apiResolution.api, 'dx12'); assert.equal(manual.detectedApi, 'vulkan');
  fs.writeFileSync(file, xml('DX12'));
  assert.equal(annotateApi(input, root, context).chosen.apiResolution.api, 'dx12');
  const conflicting = annotateApi(input, root, { ...context, ...runtimeFor(exe, 'vulkan') }).chosen;
  assert.equal(conflicting.detectedApi, 'mixed');
  fs.unlinkSync(file);
  const unknown = annotateApi(input, root, context).chosen;
  assert.equal(unknown.apiResolution.api, 'unknown'); assert.deepEqual(unknown.supportedApis, ['vulkan', 'dx12']); assert.equal(unknown.apiSettings.canSync, false);
  const unbound = annotateApi(input, root, { ...context, entryRoot: undefined }).chosen;
  assert.equal(unbound.detectedApi, 'mixed'); assert.equal(unbound.apiSettings, undefined);
});
