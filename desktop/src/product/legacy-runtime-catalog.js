'use strict';

// A recipe describes the game's input API separately from the API used by the
// loader and transport. It never turns a proxy filename into API evidence.
const UPSTREAM = Object.freeze({ repository: 'jlrouzies-fr/DLSS5-Feeder', version: '0.15.1',
  commit: '3f624855276c4bde55145c712782477639b30e85', ipcVersion: 9 });
const VORT = Object.freeze({ repository: 'vortigern11/vort_Shaders',
  commit: 'b410b9f0c0fbb83c8cb42164aaf1655fab386f4a', provider: 2,
  licenses: Object.freeze(['MIT', 'CC-BY-NC-4.0']) });
const APIS = Object.freeze(['dx9', 'dx10', 'dx11', 'dx12']);
const ARCHITECTURES = Object.freeze(['x86', 'x64']);
const HARDWARE = Object.freeze(['RTX40', 'RTX50']);
const BACKENDS = Object.freeze(['local', 'hoyoshade']);
const ENTRIES = Object.freeze(['auto', 'd3d9', 'dxgi', 'd3d11', 'd3d12']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}

function resolve(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['api', 'architecture', 'hardwareFamily', 'loadingBackend', 'proxyEntry'].includes(key)))
    fail('LEGACY_RECIPE_BAD_REQUEST', '旧 API 配套选择参数无效。');
  const { api, architecture, hardwareFamily, loadingBackend = 'local', proxyEntry = 'auto' } = input;
  if (!APIS.includes(api) || !ARCHITECTURES.includes(architecture) || !HARDWARE.includes(hardwareFamily) ||
      !BACKENDS.includes(loadingBackend) || !ENTRIES.includes(proxyEntry))
    fail('LEGACY_RECIPE_UNSUPPORTED', '找不到匹配 API、位数、显卡和加载方式的 Feeder 配套。');
  if (api === 'dx12' && architecture === 'x86')
    fail('LEGACY_RECIPE_UNSUPPORTED', '当前 DX12 Feeder 使用 x64 游戏入口。');
  if (api === 'dx9' && loadingBackend === 'hoyoshade')
    fail('LEGACY_RECIPE_UNSUPPORTED', 'DX9 系统 D3D9On12 配套使用本地固定入口。');
  const proxyEntries = loadingBackend === 'hoyoshade' ? ['auto'] :
    api === 'dx9' ? ['auto', 'd3d9'] : api === 'dx12' ? ['auto', 'dxgi', 'd3d12'] : ['auto', 'dxgi', 'd3d11'];
  if (!proxyEntries.includes(proxyEntry))
    fail('LEGACY_PROXY_UNSUPPORTED', '所选加载入口不适用于该配套，游戏 API 未改变。');
  const hostRequired = architecture === 'x86' || api === 'dx10' || api === 'dx9';
  const renderApi = api;
  return freeze({ schema: 1,
    id: `feeder-0151-${api}-${architecture}-${hardwareFamily.toLowerCase()}-${loadingBackend}`,
    componentId: 'feeder-0151-external-v1', route: 'feeder', api, gameApi: api, renderApi,
    architecture, hardwareFamily, loadingBackend,
    proxyEntry: loadingBackend === 'hoyoshade' ? null : proxyEntry === 'auto' ? api === 'dx9' ? 'd3d9' : 'dxgi' : proxyEntry,
    proxyEntries, hostRequired, transport: hostRequired ? 'shared-textures-ipc-v9' : 'in-process-d3d12',
    relay: api === 'dx10' ? 'd3d10-to-d3d11' : null,
    wrapper: api === 'dx9' ? { id: 'xiaofeng-system-d3d9on12', version: '1', outputApi: 'dx12', entry: 'd3d9.dll',
      systemRuntime: true, privateRuntimeBundled: false, minimumWindows: 'Windows 10 with Direct3DCreate9On12' } : null,
    deliveryBlocked: false,
    upstream: UPSTREAM, motionVectors: VORT, coreInterface: 'NRExternalProviderV1',
    provenance: 'Synthetic', scope: 'post-process', srInjected: false, fgInjected: false,
    acceptance: { fileVerified: false, controlledRuntimeVerified: false, realGameVerified: false },
    // Paths are role names only. An internal verified layout binds them later.
    componentRoles: [
      { role: 'game-provider', architecture },
      ...(loadingBackend === 'local' ? [{ role: 'game-loader', architecture }] : []),
      ...(api === 'dx9' ? [{ role: 'api-wrapper', architecture }] : []),
      ...(hostRequired ? [{ role: 'host', architecture: 'x64' }, { role: 'host-loader', architecture: 'x64' }] : []),
      { role: 'core', architecture: 'x64' }, { role: 'chain', architecture: 'x64' },
      { role: 'nr-runtime', architecture: 'x64', hardwareFamily }, { role: 'motion-shaders', architecture: null }
    ] });
}

function list() {
  const result = [];
  for (const api of APIS) for (const architecture of ARCHITECTURES) {
    if (api === 'dx12' && architecture === 'x86') continue;
    for (const hardwareFamily of HARDWARE) for (const loadingBackend of BACKENDS) {
      if (api === 'dx9' && loadingBackend === 'hoyoshade') continue;
      result.push(resolve({ api, architecture, hardwareFamily, loadingBackend }));
    }
  }
  return result;
}

function validateLayout(game, layout) {
  const path = require('node:path');
  const { inside } = require('./launch-safety');
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' &&
    path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const exe = game?.scan?.chosen?.path || game?.chosen?.path;
  if (!layout || typeof layout !== 'object' || layout.verified !== true ||
      !same(layout.gameDir, game?.dir) || !same(layout.exePath, exe) ||
      !['local', 'hoyoshade-profile'].includes(layout.source) || !own(layout, 'generation') ||
      !['runtimeDir', 'addonDirectory', 'activeConfigPath', 'nrConfigDir'].every(key =>
        typeof layout[key] === 'string' && path.isAbsolute(layout[key]) && !layout[key].includes('\0')) ||
      !inside(layout.runtimeDir, layout.addonDirectory) || !inside(layout.runtimeDir, layout.nrConfigDir) ||
      !(inside(layout.runtimeDir, layout.activeConfigPath) || layout.source === 'local' &&
        inside(path.dirname(exe), layout.activeConfigPath)))
    fail('LEGACY_LAYOUT_UNVERIFIED', 'Feeder 运行目录必须由当前游戏的加载布局核验后提供。');
  return layout;
}

module.exports = { UPSTREAM, VORT, APIS, ARCHITECTURES, HARDWARE, BACKENDS, resolve, list, validateLayout };
