'use strict';

const API_LABELS = Object.freeze({
  dx9: 'DirectX 9', dx10: 'DirectX 10', dx11: 'DirectX 11', dx12: 'DirectX 12', vulkan: 'Vulkan'
});

const ready = (value, fallback = '未准备') => value || fallback;
const state = value => value === true ? 'ready' : value === false ? 'missing' : 'pending';

const KINDS = new Set(['core', 'bridge', 'feeder', 'mfg', 'nr-runtime']);
const AUTOMATIC_SOURCES = new Set(['bundled', 'catalog', 'official-release', 'github-release']);

function strings(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => typeof item === 'string' ? item : item?.name).filter(Boolean);
}

function normalizeDescriptor(value = {}) {
  const kind = KINDS.has(value.kind) ? value.kind : 'unknown';
  const architecture = String(value.architecture || '').toLowerCase();
  const source = String(value.sourceType || value.origin || value.source || 'unknown');
  const validation = String(value.validation || value.maturity || 'candidate').toLowerCase();
  const sha256 = String(value.sha256 || '').toLowerCase();
  const inputInterfaces = strings(value.inputInterfaces?.length ? value.inputInterfaces : [value.interface]);
  const compatibleCoreInterfaces = strings(value.compatibleCoreInterfaces?.length ? value.compatibleCoreInterfaces : [value.consumerInterface]);
  const gameApis = strings(value.gameApis).map(item => item.toLowerCase());
  const capabilities = strings(value.capabilities);
  const verifiedSource = value.verifiedSource === true || AUTOMATIC_SOURCES.has(source);
  const immutable = value.immutable === true || /^[a-f0-9]{40}$/.test(String(value.commit || '')) || /^[a-f0-9]{64}$/.test(sha256);
  const available = value.available !== false && value.ready !== false;
  return Object.freeze({ ...value, id:String(value.id || ''), kind, version:String(value.version || ''), architecture, source,
    validation, sha256, inputInterfaces, compatibleCoreInterfaces, gameApis, capabilities, verifiedSource, immutable, available });
}

function versionParts(version) {
  const match = String(version).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-.]?(?:pre|beta|rc|d)(\d+))?/i);
  return match ? [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0), match[4] == null ? 1e9 : Number(match[4])] : [0, 0, 0, 0];
}

function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return String(left).localeCompare(String(right), undefined, { numeric:true, sensitivity:'base' });
}

function automaticCandidate(row) {
  const architectureReady = row.kind === 'feeder' ? ['x64', 'mixed'].includes(row.architecture) : row.architecture === 'x64';
  return row.available && architectureReady && /^[a-f0-9]{64}$/.test(row.sha256) && row.verifiedSource && row.immutable &&
    !['blocked', 'invalid', 'unverified'].includes(row.validation);
}

function supportsInterface(adapter, core) {
  if (!adapter.compatibleCoreInterfaces.length) return false;
  return adapter.compatibleCoreInterfaces.some(name => core.inputInterfaces.includes(name));
}

function nativeCapable(api, core) {
  return api === 'dx12' && core.inputInterfaces.includes('NGX-D3D12-Feature1') && core.available;
}

function rejection(row, reason) { return { id:row.id, kind:row.kind, reason }; }

// The single compatibility seam used by preview, deployment, maintenance and
// launch. It is deliberately pure: callers supply inventory and installed
// evidence, and receive one auditable route without touching the filesystem.
function resolveStack({ effectiveApi, coreId, installedEvidence = {}, components = [] } = {}) {
  const targetApi = String(effectiveApi || 'unknown').toLowerCase();
  const descriptors = components.map(normalizeDescriptor);
  const rejected = [];
  if (!API_LABELS[targetApi]) return { targetApi, coreId:coreId || null, route:'unresolved', status:'needs-api',
    reason:'API 未确认，未选择 Core、DLSS5 Bridge 或 DLSS5 Feeder。', core:null, bridge:null, feeder:null, effectiveCore:null, rejected };

  const requestedCore = descriptors.find(row => row.kind === 'core' && row.id === coreId) || null;
  if (!requestedCore || !requestedCore.available) return { targetApi, coreId:coreId || null, route:'unresolved', status:'missing-core',
    reason:'所选 AI 增强 Core 尚未准备，未改用其他 Core。', core:requestedCore, bridge:null, feeder:null, effectiveCore:null, rejected };

  if (nativeCapable(targetApi, requestedCore)) return { targetApi, coreId, route:'native', status:'ready',
    reason:'游戏可直接提供 Core 所需的 NGX-D3D12-Feature1 输入，不安装 Bridge 或 Feeder。',
    core:requestedCore, effectiveCore:requestedCore, bridge:null, feeder:null, experimental:false, rejected };

  const cores = descriptors.filter(row => row.kind === 'core');
  const feeders = descriptors.filter(row => row.kind === 'feeder');
  const resolveFeeder = feeder => {
    if (!feeder || !feeder.gameApis.includes(targetApi) || !automaticCandidate(feeder)) return null;
    const pairedCore = cores.find(row => row.id === feeder.pairedCoreId);
    if (!pairedCore?.available || !supportsInterface(feeder, pairedCore)) return null;
    return { targetApi, coreId, route:'feeder', status:'ready', core:requestedCore, effectiveCore:pairedCore, bridge:null, feeder,
      experimental:feeder.validation !== 'stable', reason:`DLSS5 Bridge 不适用；改用 ${feeder.version} 及其固定配套 Core ${pairedCore.version || pairedCore.id}。`, rejected };
  };
  if (installedEvidence.route === 'feeder') {
    const installedFeeder = feeders.find(row => row.id === installedEvidence.feederId || row.sha256 && row.sha256 === installedEvidence.feederSha256);
    const preserved = resolveFeeder(installedFeeder);
    if (preserved) return { ...preserved, reason:`保留现有 DLSS5 Feeder ${installedFeeder.version} 及其固定配套 Core，不静默改换路线。` };
  }

  const bridges = descriptors.filter(row => row.kind === 'bridge');
  const installedBridge = bridges.find(row => row.id === installedEvidence.bridgeId || row.sha256 && row.sha256 === installedEvidence.bridgeSha256);
  const bridgeEligible = row => {
    if (!row.gameApis.includes(targetApi)) { rejected.push(rejection(row, `不支持 ${targetApi}`)); return false; }
    if (!supportsInterface(row, requestedCore)) { rejected.push(rejection(row, 'Core 输入接口不匹配')); return false; }
    const isInstalledExact = row === installedBridge && installedEvidence.allowInstalledCandidate !== false;
    if (targetApi === 'vulkan' && !row.capabilities.includes('vulkan-profile-deployment')) {
      rejected.push(rejection(row, '缺少可部署的 ReShade Vulkan Layer/Profile 配套')); return false;
    }
    if (!isInstalledExact && row.defaultEligible !== true) { rejected.push(rejection(row, '只允许手动选择，不会自动安装')); return false; }
    if (!automaticCandidate(row) && !isInstalledExact) { rejected.push(rejection(row, '来源、摘要、架构或验证状态不足以自动使用')); return false; }
    return true;
  };
  const eligibleBridges = bridges.filter(bridgeEligible).sort((a, b) => compareVersions(b.version, a.version));
  const bridge = installedBridge && eligibleBridges.includes(installedBridge) ? installedBridge : eligibleBridges[0];
  if (bridge) {
    const experimental = requestedCore.id === '0.5-dline21' || bridge.validation !== 'stable';
    return { targetApi, coreId, route:'bridge', status:'ready', core:requestedCore, effectiveCore:requestedCore, bridge, feeder:null,
      experimental, reason:experimental
        ? `${API_LABELS[targetApi]} 使用接口匹配的 DLSS5 Bridge；这是实验桥接，不等同于原生兼容。`
        : `${API_LABELS[targetApi]} 使用来源与接口均已验证的 DLSS5 Bridge。`, rejected };
  }

  for (const feeder of feeders.sort((a, b) => compareVersions(b.version, a.version))) {
    if (!feeder.gameApis.includes(targetApi)) { rejected.push(rejection(feeder, `不支持 ${targetApi}`)); continue; }
    if (!automaticCandidate(feeder)) { rejected.push(rejection(feeder, '来源、摘要、架构或验证状态不足以自动使用')); continue; }
    const pairedCore = cores.find(row => row.id === feeder.pairedCoreId);
    if (!pairedCore?.available) { rejected.push(rejection(feeder, '配套 Core 未准备')); continue; }
    if (!supportsInterface(feeder, pairedCore)) { rejected.push(rejection(feeder, '配套 Core 未声明 Feeder 所需接口')); continue; }
    return resolveFeeder(feeder);
  }

  return { targetApi, coreId, route:'unresolved', status:'incompatible', core:requestedCore, effectiveCore:null, bridge:null, feeder:null,
    reason:'没有同时满足目标 API、Core 输入接口、来源与摘要要求的可用路线，未写入游戏目录。', rejected };
}

// One small read interface for the UI. Installers still own file writes and
// compatibility enforcement; this module explains the exact route they chose.
function resolveComponentStack(input = {}) {
  const api = String(input.api || 'unknown').toLowerCase();
  const apiLabel = API_LABELS[api] || '待确认';
  if (!API_LABELS[api]) return {
    api, apiLabel, route: 'unresolved', status: 'needs-api', title: '先确认游戏使用的图形接口',
    summary: '确认 API 后，管理器会自动选择 Core、DLSS5 Bridge 或 DLSS5 Feeder。',
    reason: 'API 未确认时不会猜测桥接器，也不会向游戏目录写入组件。', manualBridge: false,
    items: [
      { key:'api', label:'图形 API', value:'待确认', status:'attention', detail:'回到游戏设置选择实际使用的 API。' },
      { key:'input', label:'输入适配', value:'确认后自动匹配', status:'pending', detail:'不会同时安装 Bridge 和 Feeder。' }
    ]
  };

  const route = ['native', 'bridge', 'feeder', 'vulkan'].includes(input.route) ? input.route :
    ['dx9', 'dx10'].includes(api) ? 'feeder' : api === 'vulkan' ? 'vulkan' : 'native';
  const core = input.core || {}, bridge = input.bridge || {}, feeder = input.feeder || {};
  const vulkan = input.vulkan || {}, runtime = input.runtime || {};
  const items = [{ key:'api', label:'图形 API', value:apiLabel, status:'ready', detail:input.apiAutomatic === false ? '使用这个游戏保存的手动选择。' : '由游戏程序和已保存设置识别。' }];
  let title, summary, reason, manualBridge = false;

  if (route === 'feeder') {
    title = `${apiLabel} · DLSS5 Feeder 兼容路线`;
    summary = '使用 DLSS5 Feeder 提供输入，再交给与它配套的 AI Core 和运行库。';
    reason = ['dx9', 'dx10'].includes(api)
      ? `${apiLabel} 不能直接使用原生 DLSS5 输入，因此自动选择 Feeder。`
      : '没有确认到可用的原生 DLSS 输入，因此自动选择 Feeder；不会另外叠加 DLSS5 Bridge。';
    items.push(
      { key:'input', label:'输入适配', value:`DLSS5 Feeder${feeder.version ? ` ${feeder.version}` : ''}`, status:state(feeder.ready), detail:ready(feeder.reason, 'Feeder 负责兼容输入与加载。') },
      { key:'core', label:'AI 增强 Core', value:ready(feeder.coreVersion, '由 Feeder 配套提供'), status:state(feeder.ready), detail:'Core 与 Feeder 按同一配套安装，不能任意混用。' },
      { key:'runtime', label:'DLSS5 模型', value:ready(runtime.label, '由 Feeder 配套校验'), status:state(feeder.ready), detail:'安装前会核对显卡系列、位数和运行库摘要。' }
    );
  } else if (route === 'vulkan') {
    title = 'Vulkan · 专用兼容路线';
    summary = '使用 Vulkan 专用配套，不与 DirectX Bridge 或普通 Core 混装。';
    reason = 'Vulkan 使用独立加载配置；切换到 DirectX 前需要先恢复当前路线。';
    items.push(
      { key:'input', label:'输入适配', value:ready(vulkan.label, 'Vulkan 专用桥接'), status:state(vulkan.ready), detail:ready(vulkan.reason, '由当前 Vulkan Provider 统一管理。') },
      { key:'core', label:'AI 增强 Core', value:ready(vulkan.coreVersion, '由 Vulkan 配套提供'), status:state(vulkan.ready), detail:'Core 与 Vulkan Provider 作为固定配套。' },
      { key:'runtime', label:'DLSS5 模型', value:ready(runtime.label, '由 Vulkan 配套校验'), status:state(vulkan.ready), detail:'不会复用不匹配的 DirectX 路线。' }
    );
  } else if (route === 'bridge' || api === 'dx11') {
    manualBridge = true;
    title = `${apiLabel} · DLSS5 Bridge 路线`;
    summary = 'AI Core 与一份接口匹配的 DLSS5 Bridge 搭配，再使用 DLSS5 模型。';
    reason = `${apiLabel} 需要 Bridge 把输入交给 Core；管理器只启用一个已验证匹配的版本。`;
    items.push(
      { key:'core', label:'AI 增强 Core', value:ready(core.label || core.version, '未选择'), status:state(core.ready), detail:'Core 版本由当前游戏单独保存。' },
      { key:'input', label:'输入适配', value:bridge.label ? `DLSS5 Bridge · ${bridge.label}` : 'DLSS5 Bridge · 未准备', status:state(bridge.ready && bridge.compatible), detail:bridge.compatible === false ? '当前 Bridge 与所选 Core 接口不匹配。' : '按 Core 接口自动选择；高级设置可手动回退。' },
      { key:'runtime', label:'DLSS5 模型', value:ready(runtime.label, 'DLSS5 模型'), status:state(runtime.ready), detail:'当前使用的 DLSS5 模型，可在组件管理里更换。' }
    );
  } else {
    title = `${apiLabel} · 原生 DLSS 路线`;
    summary = '游戏直接向 AI Core 提供 DLSS 输入，只需要 Core、输入链和 DLSS5 模型。';
    reason = '此路线不需要 DLSS5 Bridge，也不安装 DLSS5 Feeder。';
    items.push(
      { key:'core', label:'AI 增强 Core', value:ready(core.label || core.version, '未选择'), status:state(core.ready), detail:'Core 与输入链作为同一配套校验。' },
      { key:'input', label:'输入适配', value:'游戏原生 DLSS 输入', status:'ready', detail:'无需额外 Bridge / Feeder。' },
      { key:'runtime', label:'DLSS5 模型', value:ready(runtime.label, 'DLSS5 模型'), status:state(runtime.ready), detail:'当前使用的 DLSS5 模型，可在组件管理里更换。' }
    );
  }

  const missing = items.filter(item => item.status === 'missing').length;
  const pending = items.filter(item => ['pending', 'attention'].includes(item.status)).length;
  return { api, apiLabel, route, title, summary, reason, manualBridge, items,
    status: missing ? 'missing' : pending ? 'pending' : 'ready', missingCount: missing };
}

module.exports = { API_LABELS, normalizeDescriptor, resolveStack, resolveComponentStack };
