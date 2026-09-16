'use strict';

const API_LABELS = Object.freeze({
  dx9: 'DirectX 9', dx10: 'DirectX 10', dx11: 'DirectX 11', dx12: 'DirectX 12', vulkan: 'Vulkan'
});

const ready = (value, fallback = '未准备') => value || fallback;
const state = value => value === true ? 'ready' : value === false ? 'missing' : 'pending';

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
      { key:'api', label:'游戏 API', value:'待确认', status:'attention', detail:'回到游戏设置选择实际使用的 API。' },
      { key:'input', label:'输入适配', value:'确认后自动匹配', status:'pending', detail:'不会同时安装 Bridge 和 Feeder。' }
    ]
  };

  const route = ['native', 'feeder', 'vulkan'].includes(input.route) ? input.route :
    ['dx9', 'dx10'].includes(api) ? 'feeder' : api === 'vulkan' ? 'vulkan' : 'native';
  const core = input.core || {}, bridge = input.bridge || {}, feeder = input.feeder || {};
  const vulkan = input.vulkan || {}, runtime = input.runtime || {};
  const items = [{ key:'api', label:'游戏 API', value:apiLabel, status:'ready', detail:input.apiAutomatic === false ? '使用这个游戏保存的手动选择。' : '由游戏程序和已保存设置识别。' }];
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
      { key:'runtime', label:'显卡运行库', value:ready(runtime.label, '由 Feeder 配套校验'), status:state(feeder.ready), detail:'安装前会核对显卡系列、位数和运行库摘要。' }
    );
  } else if (route === 'vulkan') {
    title = 'Vulkan · 专用兼容路线';
    summary = '使用 Vulkan 专用配套，不与 DirectX Bridge 或普通 Core 混装。';
    reason = 'Vulkan 使用独立加载配置；切换到 DirectX 前需要先恢复当前路线。';
    items.push(
      { key:'input', label:'输入适配', value:ready(vulkan.label, 'Vulkan 专用桥接'), status:state(vulkan.ready), detail:ready(vulkan.reason, '由当前 Vulkan Provider 统一管理。') },
      { key:'core', label:'AI 增强 Core', value:ready(vulkan.coreVersion, '由 Vulkan 配套提供'), status:state(vulkan.ready), detail:'Core 与 Vulkan Provider 作为固定配套。' },
      { key:'runtime', label:'显卡运行库', value:ready(runtime.label, '由 Vulkan 配套校验'), status:state(vulkan.ready), detail:'不会复用不匹配的 DirectX 路线。' }
    );
  } else if (api === 'dx11') {
    manualBridge = true;
    title = 'DirectX 11 · DLSS5 Bridge 路线';
    summary = 'AI Core 与一份接口匹配的 DLSS5 Bridge 搭配，再使用对应显卡运行库。';
    reason = 'DX11 需要 Bridge 把输入交给 Core；管理器只启用一个已验证匹配的版本。';
    items.push(
      { key:'core', label:'AI 增强 Core', value:ready(core.label || core.version, '未选择'), status:state(core.ready), detail:'Core 版本由当前游戏单独保存。' },
      { key:'input', label:'输入适配', value:bridge.label ? `DLSS5 Bridge · ${bridge.label}` : 'DLSS5 Bridge · 未准备', status:state(bridge.ready && bridge.compatible), detail:bridge.compatible === false ? '当前 Bridge 与所选 Core 接口不匹配。' : '按 Core 接口自动选择；高级设置可手动回退。' },
      { key:'runtime', label:'显卡运行库', value:ready(runtime.label, 'NR 运行库'), status:state(runtime.ready), detail:'按 RTX 系列选择，不与其他显卡运行库混用。' }
    );
  } else {
    title = `${apiLabel} · 原生 DLSS 路线`;
    summary = '游戏直接向 AI Core 提供 DLSS 输入，只需要 Core、输入链和对应显卡运行库。';
    reason = '此路线不需要 DLSS5 Bridge，也不安装 DLSS5 Feeder。';
    items.push(
      { key:'core', label:'AI 增强 Core', value:ready(core.label || core.version, '未选择'), status:state(core.ready), detail:'Core 与输入链作为同一配套校验。' },
      { key:'input', label:'输入适配', value:'游戏原生 DLSS 输入', status:'ready', detail:'无需额外 Bridge / Feeder。' },
      { key:'runtime', label:'显卡运行库', value:ready(runtime.label, 'NR 运行库'), status:state(runtime.ready), detail:'按 RTX 系列选择，不与其他显卡运行库混用。' }
    );
  }

  const missing = items.filter(item => item.status === 'missing').length;
  const pending = items.filter(item => ['pending', 'attention'].includes(item.status)).length;
  return { api, apiLabel, route, title, summary, reason, manualBridge, items,
    status: missing ? 'missing' : pending ? 'pending' : 'ready', missingCount: missing };
}

module.exports = { API_LABELS, resolveComponentStack };

