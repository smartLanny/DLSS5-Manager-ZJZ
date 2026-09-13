'use strict';

const fs = require('fs');
const path = require('path');
const { createRdr2ApiSettings } = require('./rdr2-api-settings');

const MAX_ENGINE_MODULES = 8;
const MAX_MARKER_BYTES = 32 * 1024 * 1024;
const MAX_RUNTIME_AGE_MS = 60 * 1000;
const PROXY_OR_CARRIER = /^(?:d3d8|d3d9|d3d10(?:_1)?|d3d11|d3d12|dxgi|opengl32|dinput8|winmm|nvngx(?:_[^.]*)?|nrchain(?:_[^.]*)?|sl\.[^.]*)\.(?:dll|addon64|addon32|addon)$/i;
const GENERIC_GRAPHICS_SDK = /^(?:amd_ags(?:_x64|_x86)?|nvapi(?:64)?)\.dll$/i;
const OVERLAY_MODULE = /(?:gameoverlayrenderer|discordhook|rtsshooks|igo(?:32|64)|nvspcap|overwolf|capturehook|renderdoc|reshade|graphics-hook|eosovh)/i;
const ENGINE_NAME = /(?:unityplayer|gameassembly|engine|render|rhi|neox|d3d_rmd|disrupt|fc_m64)/i;
const API_LABELS = { dx9: 'DirectX 9', dx10: 'DirectX 10', dx11: 'DirectX 11', dx12: 'DirectX 12', vulkan: 'Vulkan', opengl: 'OpenGL' };
const CONFIDENCE = { none: 0, low: 1, medium: 2, high: 3, confirmed: 4 };
const MARKERS = ['D3D12CreateDevice', 'D3D12SDKPath', 'D3D12SDKVersion', 'D3D11CreateDevice', 'D3D10CreateDevice', 'Direct3DCreate9', 'vkCreateInstance', 'wglCreateContext', 'CreateDXGIFactory'];

// Rules bind the discovered Steam app and its exact entry, never basename alone.
// https://forums.larian.com/ubbthreads.php?Number=818949&ubb=showthreaded
// https://help.steampowered.com/en/wizard/HelpWithGameTechnicalIssue/?appid=3764200
const STEAM_ENTRY_APIS = { '1086940': { 'bin/bg3.exe': 'vulkan', 'bin/bg3_dx11.exe': 'dx11' }, '3764200': { 're9.exe': 'dx12' } };
const STEAM_STATIC_EXCEPTIONS = { '3764200': { 're9.exe': ['dx11'] } };
const STEAM_CONFIG_ENTRIES = { '1174180': ['rdr2.exe'] };
const ENGINE_ENTRIES = {
  'hl.exe': ['hw.dll'],
  'hl2.exe': ['bin/shaderapidx9.dll', 'bin/engine.dll', 'bin/x64/shaderapidx9.dll', 'bin/x64/engine.dll'],
  'left4dead2.exe': ['bin/shaderapidx9.dll', 'bin/engine.dll'],
  'killingfloor.exe': ['D3D9Drv.dll', 'D3DDrv.dll', 'OpenGLDrv.dll'],
  'farcry5.exe': ['FC_m64.dll'], 'watch_dogs.exe': ['Disrupt_b64.dll']
};

const text = value => String(value == null ? '' : value);
function samePath(left, right) { return Boolean(left && right) && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase(); }
function normalizeApi(value) {
  const key = text(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  return ({ dx9: 'dx9', directx9: 'dx9', d3d9: 'dx9', dx10: 'dx10', directx10: 'dx10', d3d10: 'dx10', d3d101: 'dx10',
    dx11: 'dx11', directx11: 'dx11', d3d11: 'dx11', dx12: 'dx12', directx12: 'dx12', d3d12: 'dx12',
    vulkan: 'vulkan', vulkan1: 'vulkan', opengl: 'opengl', ogl: 'opengl', opengl32: 'opengl' })[key] || null;
}

function steamEntryContext(exe, games) {
  if (!exe) return {};
  const matches = [];
  for (const game of games || []) {
    if (game.launcher !== 'Steam' || !game.dir) continue;
    const entries = [...Object.keys(STEAM_ENTRY_APIS[String(game.id)] || {}), ...(STEAM_CONFIG_ENTRIES[String(game.id)] || [])];
    if (entries.some(rel => samePath(path.resolve(game.dir, rel), exe))) matches.push({ steamAppId: String(game.id), entryRoot: game.dir });
  }
  const identities = new Set(matches.map(row => `${row.steamAppId}:${path.resolve(row.entryRoot).toLowerCase()}`));
  return identities.size === 1 ? matches[0] : {};
}

function readRdr2GraphicsApi(exe, context) {
  const result = createRdr2ApiSettings({ documentsDir: context.documentsDir }).read({ ...context, exe });
  return result.api ? { api: result.api, file: result.file, evidence: `RDR2 当前保存的 system.xml 图形设置选择 ${API_LABELS[result.api]}` } : null;
}

function coverageRecord() {
  return { complete: true, exeImports: 'not-read', exeMarkers: 'not-read', engineModules: { discovered: 0, inspected: 0, limit: MAX_ENGINE_MODULES }, skipped: [] };
}
function skip(coverage, file, reason) {
  coverage.complete = false;
  if (!coverage.skipped.some(row => samePath(row.path, file) && row.reason === reason)) coverage.skipped.push({ path: file, reason });
}

// A scanner label, import and marker can describe the same binary capability.
// Keep one file/API record, retaining its sources without counting them twice.
function signal(signals, api, source, file, message, options = {}) {
  const kind = options.kind || 'capability', normalized = normalizeApi(api);
  const existing = signals.find(row => row.api === normalized && row.kind === kind && samePath(row.path, file));
  if (existing) {
    if (!existing.sources.includes(source)) existing.sources.push(source);
    if (!existing.messages.includes(message)) existing.messages.push(message);
    if (CONFIDENCE[options.confidence || 'high'] > CONFIDENCE[existing.confidence]) {
      existing.confidence = options.confidence || 'high'; existing.source = source; existing.message = message;
    }
    existing.linked = existing.linked || options.linked === true;
    return existing;
  }
  const row = { api: normalized, source, sources: [source], path: file || null, kind, confidence: options.confidence || 'high',
    message, messages: [message], eligible: options.eligible !== false, linked: options.linked === true };
  signals.push(row); return row;
}

function bitness(file, pe, fallback) {
  try { if (typeof pe.getBitness === 'function') return pe.getBitness(file); } catch {}
  return pe.virtual ? (fallback || 64) : null;
}

function inspectFile(file, pe, source, signals, coverage, options = {}) {
  if (!file) return { imports: [], inspected: false };
  const isExe = source === 'exe-imports';
  let stat;
  if (!pe.virtual) {
    try { stat = fs.statSync(file); } catch { skip(coverage, file, 'unreadable'); if (isExe) coverage.exeImports = 'unreadable'; return { imports: [], inspected: false }; }
    if (!stat.isFile()) { skip(coverage, file, 'not-file'); return { imports: [], inspected: false }; }
  }
  if (!isExe) {
    const moduleBits = bitness(file, pe, options.bitness);
    if (!options.bitness || !moduleBits || moduleBits !== options.bitness) {
      skip(coverage, file, moduleBits && options.bitness ? 'architecture-mismatch' : 'architecture-unverified');
      return { imports: [], inspected: false };
    }
  }
  let imports = [];
  try { imports = typeof pe.getImports === 'function' ? pe.getImports(file) : []; if (isExe) coverage.exeImports = 'read'; }
  catch { skip(coverage, file, 'imports-unreadable'); if (isExe) coverage.exeImports = 'unreadable'; }
  const names = new Set((Array.isArray(imports) ? imports : []).map(value => path.basename(text(value)).toLowerCase()));
  for (const [name, api] of Object.entries({ 'd3d9.dll': 'dx9', 'd3d10.dll': 'dx10', 'd3d10_1.dll': 'dx10', 'd3d11.dll': 'dx11', 'd3d12.dll': 'dx12', 'vulkan-1.dll': 'vulkan', 'opengl32.dll': 'opengl' })) {
    if (names.has(name)) signal(signals, api, source, file, `${path.basename(file)} imports ${name}`, { linked: options.linked });
  }
  if (stat && stat.size > MAX_MARKER_BYTES) {
    skip(coverage, file, 'marker-byte-budget'); if (isExe) coverage.exeMarkers = 'budget-skipped';
  } else {
    try {
      const found = typeof pe.findMarkers === 'function' ? pe.findMarkers(file, MARKERS) : [];
      const markers = found instanceof Set ? found : new Set(found || []);
      if (isExe) coverage.exeMarkers = 'read';
      for (const [marker, api] of Object.entries({ D3D12CreateDevice: 'dx12', D3D12SDKPath: 'dx12', D3D12SDKVersion: 'dx12', D3D11CreateDevice: 'dx11', D3D10CreateDevice: 'dx10', Direct3DCreate9: 'dx9', vkCreateInstance: 'vulkan', wglCreateContext: 'opengl' })) {
        if (markers.has(marker)) signal(signals, api, `${source}-markers`, file, `${path.basename(file)} contains ${marker}`, { confidence: 'medium', linked: options.linked });
      }
      if (markers.has('CreateDXGIFactory') && !markers.has('D3D11CreateDevice') && !markers.has('D3D12CreateDevice')) {
        signal(signals, null, `${source}-markers`, file, `${path.basename(file)} contains CreateDXGIFactory，尚不能区分 DX11/DX12`, { kind: 'clue', confidence: 'low' });
      }
    } catch { skip(coverage, file, 'markers-unreadable'); if (isExe) coverage.exeMarkers = 'unreadable'; }
  }
  return { imports: [...names], inspected: true };
}

function excludedModule(file) {
  const name = path.basename(file);
  return PROXY_OR_CARRIER.test(name) ? 'proxy-or-carrier' : GENERIC_GRAPHICS_SDK.test(name) ? 'graphics-sdk' : OVERLAY_MODULE.test(name) ? 'overlay' : null;
}
function findFile(dir, name) {
  try { const found = fs.readdirSync(dir).find(entry => entry.toLowerCase() === name.toLowerCase()); return found ? path.join(dir, found) : null; } catch { return null; }
}
function discoverEngineModules(exe, root, imports) {
  const dirs = new Set([path.dirname(exe)]);
  for (const rel of ['Binaries/Win64', 'Engine/Binaries/Win64', 'Client/Binaries/Win64', 'Game/Binaries/Win64']) dirs.add(path.resolve(root || path.dirname(exe), rel));
  const imported = new Set(imports), result = [];
  for (const dir of dirs) {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.dll$/i.test(entry.name)) continue;
      if (!imported.has(entry.name.toLowerCase()) && !ENGINE_NAME.test(entry.name)) continue;
      result.push({ path: path.join(dir, entry.name), linked: imported.has(entry.name.toLowerCase()) && samePath(dir, path.dirname(exe)) });
    }
  }
  for (const rel of ENGINE_ENTRIES[path.basename(exe).toLowerCase()] || []) {
    let file = path.dirname(exe);
    for (const part of rel.split('/')) { file = findFile(file, part); if (!file) break; }
    if (file) result.push({ path: file, linked: true });
  }
  return result;
}

function legacyCapabilities(chosen) {
  const apis = new Set(), api = normalizeApi(chosen.api); if (api) apis.add(api);
  const label = text(chosen.apiLabel);
  for (const number of [9, 10, 11, 12]) if (new RegExp(`(?:DirectX|DX|D3D)\\s*${number}\\b`, 'i').test(label)) apis.add(`dx${number}`);
  if (/(?:DirectX|DX|D3D)\s*11\s*[/&,或-]\s*(?:(?:DirectX|DX|D3D)\s*)?12\b/i.test(label)) apis.add('dx12');
  if (chosen.dx12 === true) apis.add('dx12'); if (chosen.dx11 === true) apis.add('dx11');
  if (/vulkan/i.test(label)) apis.add('vulkan'); if (/opengl/i.test(label)) apis.add('opengl');
  return [...apis];
}

function addLegacyEvidence(chosen, signals, pe, exeBits) {
  const via = text(chosen.via), module = /^(?:module|engine-module):([^（(]+)/i.exec(via);
  const file = module ? path.resolve(path.dirname(chosen.path), module[1].replace(/[\\/]/g, path.sep)) : chosen.path;
  const excluded = module && excludedModule(file);
  if (excluded) {
    signal(signals, null, excluded, file, `${path.basename(file)} 的通用或注入能力不用于判定游戏 API`, { kind: 'clue', confidence: 'low' }); return;
  }
  if (module && (!exeBits || bitness(file, pe, exeBits) !== exeBits)) return;
  if (signals.some(row => row.kind === 'capability' && samePath(row.path, file))) return;
  const confidence = /^(?:filename|fallback|MicrosoftGame.config|emulator-profile|game-profile)$/.test(via) ? 'low' : /^imports$/.test(via) ? 'high' : 'medium';
  for (const api of legacyCapabilities(chosen)) signal(signals, api, 'chosen-static', file, `扫描结果标记 ${API_LABELS[api]}${via ? `（${via}）` : ''}`, { confidence, linked: Boolean(module) });
}

function argumentApis(value) {
  const result = new Set();
  for (const args of Array.isArray(value) ? value : [text(value)]) {
    const tokens = (text(args).match(/"[^"]*"|'[^']*'|\S+/g) || []).map(token => token.replace(/^(["'])(.*)\1$/, '$2').toLowerCase());
    for (const [index, token] of tokens.entries()) {
      const flag = /^--?(?:force-)?((?:d3d|dx)1[12]|vulkan|opengl|glcore)$/.exec(token);
      const renderer = /^--?renderer(?:=(.*))?$/.exec(token);
      const value = flag?.[1] || (renderer ? renderer[1] || tokens[index + 1] : null);
      const api = value === 'glcore' ? 'opengl' : normalizeApi(value);
      if (api) result.add(api);
    }
  }
  return [...result];
}

function timestamp(value) { return typeof value === 'number' ? value : Date.parse(value); }
// Only fresh swapchain evidence bound to the live process and its start/session
// identity is observed API. Device creation and an EXE name are not sufficient.
function currentRuntimeEvidence(log, exe, context, settingsFile) {
  const session = context.runtimeSession, now = Number.isFinite(context.now) ? context.now : Date.now();
  if (!log || log.bound !== true || !session || session.alive !== true || !normalizeApi(log.api)) return false;
  if (!samePath(log.exe, exe) || !samePath(session.exe, exe) || typeof session.id !== 'string' || !session.id || log.sessionId !== session.id) return false;
  if (!Number.isInteger(session.pid) || session.pid <= 0 || log.pid !== session.pid || (log.kind !== 'swapchain' && log.swapchain !== true)) return false;
  const start = timestamp(session.startedAt), observed = timestamp(log.observedAt);
  if (!Number.isFinite(start) || !Number.isFinite(observed) || observed < start || observed > now + 1000 || now - observed > MAX_RUNTIME_AGE_MS) return false;
  if (timestamp(log.processStartedAt) !== start) return false;
  let changed = timestamp(context.configurationChangedAt);
  if (settingsFile) try { changed = Math.max(Number.isFinite(changed) ? changed : 0, fs.statSync(settingsFile).mtimeMs); } catch {}
  return !Number.isFinite(changed) || observed >= changed;
}

function presentationWrapper(exe, api, exeBits, pe, coverage) {
  const names = ({ dx9: ['d3d9.dll'], dx10: ['d3d10.dll', 'd3d10_1.dll', 'dxgi.dll'], dx11: ['d3d11.dll', 'dxgi.dll'], dx12: ['d3d12.dll', 'dxgi.dll'] })[api] || [];
  for (const name of names) {
    const file = findFile(path.dirname(exe), name);
    if (!file || !exeBits || bitness(file, pe, exeBits) !== exeBits) continue;
    try {
      if (typeof pe.versionMentions === 'function' && pe.versionMentions(file, 'ReShade')) continue;
      if (fs.statSync(file).size > MAX_MARKER_BYTES) { skip(coverage, file, 'proxy-marker-byte-budget'); continue; }
      const markers = new Set(typeof pe.findMarkers === 'function' ? pe.findMarkers(file, ['DXVK', 'vkd3d', 'vkGetInstanceProcAddr', 'ReShade']) : []);
      if (markers.has('ReShade')) continue;
      for (const kind of ['DXVK', 'vkd3d']) {
        if ((typeof pe.versionMentions === 'function' && pe.versionMentions(file, kind)) || (markers.has(kind) && markers.has('vkGetInstanceProcAddr'))) {
          return { path: file, kind: kind.toLowerCase(), inputApi: api, api: 'vulkan' };
        }
      }
    } catch { skip(coverage, file, 'proxy-unreadable'); }
  }
  return null;
}

function annotateApi(scan, root, context = {}) {
  if (!scan || !scan.chosen) return scan;
  const chosen = scan.chosen, exe = text(chosen.path), pe = context.pe || require('../core/pe');
  const signals = [], conflicts = [], coverage = coverageRecord();
  const override = normalizeApi(context.apiOverride), exeBits = bitness(exe, pe, chosen.bitness) || chosen.bitness;
  const entryRel = path.relative(context.entryRoot || root, exe).replace(/\\/g, '/').toLowerCase();
  const entryApi = STEAM_ENTRY_APIS[text(context.steamAppId)]?.[entryRel];
  const exceptions = STEAM_STATIC_EXCEPTIONS[text(context.steamAppId)]?.[entryRel] || [];
  const rdr2State = createRdr2ApiSettings({ documentsDir: context.documentsDir }).read({ ...context, exe });
  if (rdr2State.api) signal(signals, rdr2State.api, 'game-settings', rdr2State.file, `RDR2 当前保存的 system.xml 图形设置选择 ${API_LABELS[rdr2State.api]}`, { kind: 'configured' });
  else if (rdr2State.matched) signal(signals, null, 'game-settings', rdr2State.file, '尚未读取 RDR2 当前文档目录的唯一图形设置，未自动选择路线', { kind: 'clue', confidence: 'none' });
  if (entryApi) signal(signals, entryApi, 'game-entry', exe, text(context.steamAppId) === '3764200'
    ? '已匹配 Steam 3764200 / re9.exe；官方游戏配套为 DirectX 12'
    : '已匹配 Larian 官方入口：bg3.exe 使用 Vulkan；bg3_dx11.exe 使用 DX11', { kind: 'configured' });

  const executable = inspectFile(exe, pe, 'exe-imports', signals, coverage), imported = new Set(executable.imports);
  const modules = Array.isArray(context.engineModules) ? context.engineModules : Array.isArray(scan.engineModules) ? scan.engineModules : discoverEngineModules(exe, root, executable.imports);
  const unique = new Map();
  for (const item of modules) {
    const file = typeof item === 'string' ? item : item && (item.path || item.file);
    if (!file || !/\.dll$/i.test(file)) continue;
    const key = path.resolve(file).toLowerCase();
    const linked = Boolean(item && item.linked) || (samePath(path.dirname(file), path.dirname(exe)) && imported.has(path.basename(file).toLowerCase()));
    const previous = unique.get(key); unique.set(key, { path: file, linked: linked || Boolean(previous?.linked) });
  }
  const eligibleModules = [];
  for (const item of unique.values()) {
    const excluded = excludedModule(item.path);
    if (excluded) signal(signals, null, excluded, item.path, `${path.basename(item.path)} ${excluded === 'graphics-sdk' ? '为通用显卡 SDK，其多 API 能力不代表游戏的运行 API' : '为代理、载体或叠加层，不作为游戏引擎 API 证据'}`, { kind: 'clue', confidence: 'low' });
    else eligibleModules.push(item);
  }
  eligibleModules.sort((a, b) => Number(b.linked) - Number(a.linked) || a.path.localeCompare(b.path));
  coverage.engineModules.discovered = eligibleModules.length;
  for (const [index, item] of eligibleModules.entries()) {
    if (index >= MAX_ENGINE_MODULES) { skip(coverage, item.path, 'engine-module-budget'); continue; }
    const result = inspectFile(item.path, pe, 'engine-module', signals, coverage, { bitness: exeBits, linked: item.linked });
    if (result.inspected) coverage.engineModules.inspected++;
  }
  addLegacyEvidence(chosen, signals, pe, exeBits);
  const multiBackendEngine = eligibleModules.some(row => /^(?:unityplayer|gameassembly)\.dll$/i.test(path.basename(row.path)));
  if (multiBackendEngine) for (const row of signals) if (row.kind === 'capability') {
    row.eligible = false;
    row.message += '；Unity 静态后端能力不能证明本游戏实际使用的 API';
  }
  for (const row of signals) if (row.kind === 'capability' && exceptions.includes(row.api)) {
    row.eligible = false; row.message += '；官方入口已确认，这是静态兼容能力';
  }

  const args = argumentApis(context.launchArguments);
  const argsApplied = context.launchMode === 'steam' && context.launchArgumentsApplied === true && context.launchArgumentsSource === 'steam-active-account';
  for (const api of args) signal(signals, api, 'launch-arguments', exe,
    argsApplied ? `当前 Steam 账户实际启动参数选择 ${API_LABELS[api]}` : `启动器参数提示 ${API_LABELS[api]}；当前启动方式未采用或账户尚未绑定，仅作线索`,
    { kind: argsApplied ? 'configured' : 'clue', confidence: argsApplied ? 'high' : 'low' });

  const log = context.logEvidence || (context.skipLogEvidence ? null : readReshadeClues(exe));
  const currentLog = currentRuntimeEvidence(log, exe, context, rdr2State.file);
  if (currentLog) signal(signals, log.api, 'runtime-log', exe, '当前 EXE、进程启动时间和会话绑定的最新交换链 API', { kind: 'observed', confidence: 'confirmed' });
  else if (log) signal(signals, null, 'runtime-log', exe, log.evidence || '日志未能绑定当前 EXE、活动进程会话和最新交换链，仅作线索', { kind: 'clue', confidence: 'low' });

  const capabilities = [...new Set(signals.filter(row => row.api && row.kind !== 'clue').map(row => row.api))];
  for (const api of rdr2State.supportedApis || []) if (!capabilities.includes(api)) capabilities.push(api);
  const configured = signals.filter(row => row.kind === 'configured' && row.api), configuredApis = [...new Set(configured.map(row => row.api))];
  const configuredApi = configuredApis.length === 1 ? configuredApis[0] : null, observedApi = currentLog ? normalizeApi(log.api) : null;
  const staticRows = signals.filter(row => row.kind === 'capability' && row.api && row.eligible && CONFIDENCE[row.confidence] >= CONFIDENCE.medium);
  const engineRows = staticRows.filter(row => row.linked && ENGINE_NAME.test(path.basename(row.path)));
  const engineApis = [...new Set(engineRows.map(row => row.api))], staticApis = [...new Set(staticRows.map(row => row.api))];
  let decisive = null, inputApi = null, reason = 'insufficient-evidence';
  if (configuredApis.length > 1) { conflicts.push({ kind: 'configured-api', apis: configuredApis, sources: configured.map(row => row.source) }); reason = 'configured-conflict'; }
  else if (configuredApi) { inputApi = configuredApi; decisive = configured[0]; reason = 'configured'; }
  else if (rdr2State.matched) reason = 'game-settings-unavailable';
  else if (multiBackendEngine) reason = 'multi-backend-engine-unconfirmed';
  else if (engineApis.length === 1) { inputApi = engineApis[0]; decisive = engineRows[0]; reason = 'linked-engine'; }
  else if (staticApis.length === 1) { inputApi = staticApis[0]; decisive = staticRows.find(row => row.api === inputApi); reason = 'single-capability'; }
  else if (staticApis.length > 1 || capabilities.length > 1) reason = 'multiple-capabilities';

  const wrapper = inputApi ? presentationWrapper(exe, inputApi, exeBits, pe, coverage) : null;
  if (wrapper) {
    decisive = signal(signals, null, 'presentation-wrapper', wrapper.path, `${path.basename(wrapper.path)} 已识别为 ${wrapper.kind}：${API_LABELS[inputApi]} 输入转换为 Vulkan 呈现，尚未运行验证`, { kind: 'clue', confidence: 'high' });
    reason = 'presentation-wrapper';
  }
  let presentationApi = wrapper?.api || inputApi;
  if (observedApi) {
    const observedPresentation = normalizeApi(log.presentationApi) || observedApi;
    if (configuredApi && observedApi !== configuredApi && observedPresentation !== presentationApi) { conflicts.push({ kind: 'configuration-runtime', apis: [configuredApi, observedApi], sources: ['configuration', 'runtime-log'] }); reason = 'runtime-conflict'; }
    else if (!conflicts.length) { inputApi = wrapper?.inputApi || observedApi; presentationApi = observedPresentation; decisive = signals.find(row => row.kind === 'observed'); reason = 'current-runtime'; }
  }
  // Mixed remains compatible with route-selection callers. The assessment
  // distinguishes multiple capabilities from conflicting current settings.
  let detectedApi = conflicts.length ? 'mixed' : presentationApi || (reason === 'multiple-capabilities' ? 'mixed' : 'unknown');
  if (detectedApi === 'unknown' && chosen.api && !normalizeApi(chosen.api) && !['dxgi', 'unknown'].includes(text(chosen.api).toLowerCase())) detectedApi = 'unsupported';
  const confidence = conflicts.length || ['mixed', 'unknown', 'unsupported'].includes(detectedApi) ? 'none' : decisive?.confidence || 'low';
  const evidence = [...new Set(signals.flatMap(row => [row.message, ...row.messages]))];
  const detectedApiResolution = { api: detectedApi, source: decisive?.source || signals[0]?.source || 'none', confidence, evidence };
  const effectiveApi = override || detectedApi;
  const apiResolution = override ? { api: override, source: 'override', confidence: 'high', evidence: [`用户显式选择 ${API_LABELS[override]}`] } : detectedApiResolution;
  const bridgeStatus = wrapper ? { required: true, kind: wrapper.kind, status: 'detected-unverified', verified: false }
    : effectiveApi === 'dx11' ? { required: true, kind: 'dx11-carrier', status: 'required', verified: false }
      : ['mixed', 'unknown', 'unsupported'].includes(effectiveApi) ? { required: null, kind: null, status: 'unknown', verified: false }
        : { required: false, kind: null, status: 'not-required', verified: false };
  const apiAssessment = { version: 1, capabilities, configuredApi, observedApi, inputApi, presentationApi, effectiveApi,
    confidence: override ? 'high' : confidence, source: apiResolution.source, resolutionReason: override ? 'manual-override' : reason,
    evidence: signals, conflicts, coverage, bridgeStatus, launchMode: context.launchMode === 'steam' ? 'steam' : 'exe' };
  return { ...scan, chosen: { ...chosen, detectedApi, detectedApiResolution, apiResolution, apiAssessment,
    ...(rdr2State.matched ? { supportedApis: rdr2State.supportedApis, apiSettings: { kind: 'rdr2-system-xml', api: rdr2State.api, file: rdr2State.file,
      sha256: rdr2State.sha256, canSync: rdr2State.canSync, steamAppId: '1174180', entryRoot: context.entryRoot, exe } } : {}) } };
}

function readReshadeClues(exe) {
  let log;
  try { log = path.join(path.dirname(exe), 'ReShade.log'); if (!fs.statSync(log).isFile() || fs.statSync(log).mtimeMs < fs.statSync(exe).mtimeMs) return null; } catch { return null; }
  let fd;
  try {
    fd = fs.openSync(log, 'r'); const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(16 * 1024, size)); fs.readSync(fd, head, 0, head.length, 0);
    const tail = Buffer.alloc(Math.min(64 * 1024, Math.max(0, size - head.length))); fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    const contents = Buffer.concat([head, tail]).toString('utf8');
    const sessions = [...contents.matchAll(/Initializing[^\r\n]+ReShade[^\r\n]+into ['"]([^'"]+)['"]/g)], session = sessions[sessions.length - 1];
    if (!session || !samePath(session[1], exe)) return { bound: false, evidence: '已有 ReShade.log 无法绑定当前 EXE，未据此判定 API' };
    const apis = [...new Set([...contents.slice(session.index).matchAll(/\bD3D(11|12)(?:CreateDevice|CreateDeviceAndSwapChain)\b/g)].map(match => `dx${match[1]}`))];
    return { bound: false, apis, evidence: `当前 EXE 的历史 ReShade.log${apis.length ? `含 ${apis.join('/')} 设备创建` : '未提供可确认的呈现 API'}；不是当前运行路线证明` };
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Manual candidates use the same bounded classifier, retaining non-DX APIs.
function executableApiEvidence(file, pe) {
  const result = annotateApi({ chosen: { path: file, api: 'unknown', bitness: bitness(file, pe) } }, path.dirname(file), { pe, engineModules: [], skipLogEvidence: true }).chosen;
  const api = result.apiResolution.api;
  if (!normalizeApi(api)) return null;
  return { api: ['dx11', 'dx12'].includes(api) ? 'dxgi' : api, apiLabel: API_LABELS[api], via: result.apiResolution.source, apiAssessment: result.apiAssessment };
}

module.exports = { annotateApi, normalizeApi, steamEntryContext, readRdr2GraphicsApi, executableApiEvidence };
