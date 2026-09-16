'use strict';

(function (scope) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const API = { auto: '自动检测', dx11: 'DirectX 11', dx12: 'DirectX 12', vulkan: 'Vulkan', dx9: 'DirectX 9', dx10: 'DirectX 10', opengl: 'OpenGL', mixed: '多种能力，待确认', unknown: '尚未确认' };
  const STATUS = { deployed: '已部署', passed: '已确认', 'not-observed': '未观察到变化', unverified: '待确认', bypassed: '已旁路', failed: '失败', 'not-applicable': '不适用',
    configurable: '可配置', unavailable: '暂不可用', reusable: '受管版本一致', 'version-conflict': '版本冲突', 'duplicate-load': '重复加载风险', 'other-mod': '其他组件 · 保留', unknown: '来源待确认', 'waiting-confirmation': '等待确认游戏开关', 'waiting-game-setting': '请先在游戏中开启',
    'waiting-first-run': '请先运行一次游戏', enabled: '已启用', disabled: '被配置禁用', missing: '文件缺失', 'version-mismatch': '版本不符', 'path-mismatch': '路径不符' };
  const LAUNCH = { preflight: '正在检查启动条件', 'waiting-helper': '等待加载助手就绪', 'request-sending': '正在发送启动请求', 'waiting-launcher': '等待启动器产生所选游戏进程',
    'waiting-game': '等待所选游戏进程', 'game-matched': '已匹配游戏进程', 'waiting-enhancement': '游戏已启动，增强待确认', 'enhancement-failed': '游戏仍保留，加载失败', failed: '本次启动失败', cancelled: '已取消等待' };
  const NR_CHOICES = { WorkMode: ['参考 · Reference', '质量 · Quality', '平衡 · Balanced', '性能 · Performance', '极致性能 · Ultra', '自定义 · Custom'], Style: ['默认', '自然', '电影'] };
    const NR = [ ['Intensity', '模型强度', 0, 2, .05], ['LocalToneStrength', '局部明暗对比', 0, 2, .05], ['LocalStructureStrength', '整体细节强度', 0, 2, .05], ['WorkMode', 'NR 工作模式', 0, 5, 1], ['CustomWorkScale', '自定义工作比例', .5, 1, .05],
    ['Style', '画面风格', 0, 2, 1], ['ColorStrength', '颜色强度', 0, 2, .05], ['SkinStructureStrength', '人脸强度', -1, 2, .05],
    ['TransferStrength', '前置传递强度', 0, 4, .05], ['PostTransferStrength', '后置传递强度', 0, 4, .05] ];
  const unwrap = result => { if (result?.ok !== true) throw Object.assign(new Error(result?.error?.message || '操作未完成。'), result?.error); return result.value; };
  const option = (value, label, selected, disabled = false) => `<option value="${esc(value)}"${String(value) === String(selected) ? ' selected' : ''}${disabled ? ' disabled' : ''}>${esc(label)}</option>`;
  const badge = (status, fallback) => `<span class="badge ${['passed', 'enabled', 'configurable'].includes(status) ? 'good' : ['failed', 'bypassed', 'version-mismatch'].includes(status) ? 'bad' : ''}">${esc(STATUS[status] || fallback || status || '待确认')}</span>`;
  const line = (label, value) => `<div class="gp-fact"><span>${esc(label)}</span><strong>${esc(value ?? '待确认')}</strong></div>`;
  const sourceText = value => typeof value === 'string' ? value : value?.api || value?.value || null;
  const apiLabel = value => API[sourceText(value)] || sourceText(value) || '尚未确认';
  const hasFgComponents = assessment => ['installed', 'managed', 'receipt', 'needsRecovery', 'needsCleanup', 'fileRecoveryPending', 'fileOperationActive', 'migrationPending'].some(key => assessment?.enhancements?.fgComponents?.[key]);
  const TAB_SECTION = { overview: 'installation', enhance: 'enhancements', maintenance: 'diagnostics' };
  const DETAIL_TAB = { overview: 'enhance', enhance: 'graphics', maintenance: 'advanced' };
  const COMPARISON_VERSION = '0.4.7beta-bg3-bridge1411';
  const coreLabel = value => String(value || '').replace(/(?:beta\s*0\.4\.7|0\.4\.7(?:-?beta)?)(?![\d.])/gi, '0.4.7beta');
  function recommendedModel(quality) { return quality === 'performance' ? 'M' : quality === 'ultraPerformance' ? 'L' : ['quality', 'balanced', 'dlaa', 'custom'].includes(quality) ? 'K' : null; }
  const KEY_NAMES = { 8: 'Backspace', 9: 'Tab', 13: 'Enter', 32: 'Space', 33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home', 37: '←', 38: '↑', 39: '→', 40: '↓', 45: 'Insert', 46: 'Delete', 186: ';', 187: '=', 188: ',', 189: '-', 190: '.', 191: '/', 192: '`', 219: '[', 220: '\\', 221: ']', 222: "'" };
  function bindingLabel(binding) { if (!binding) return '未设置'; const key = KEY_NAMES[binding.key] || (binding.key >= 112 && binding.key <= 135 ? `F${binding.key - 111}` : binding.key >= 48 && binding.key <= 90 ? String.fromCharCode(binding.key) : `VK ${binding.key}`); return [binding.ctrl && 'Ctrl', binding.shift && 'Shift', binding.alt && 'Alt', key].filter(Boolean).join(' + '); }
  function capturedBinding(event) {
    if (event.metaKey || ['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'Unidentified'].includes(event.key)) return null;
    const code = event.code, punctuation = { Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backquote: 192, BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222 };
    const key = /^Key[A-Z]$/.test(code) ? code.charCodeAt(3) : /^Digit[0-9]$/.test(code) ? code.charCodeAt(5) : /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code) ? 111 + Number(code.slice(1)) : punctuation[code] || event.keyCode;
    return Number.isInteger(key) && key > 0 && key <= 255 && ![16, 17, 18, 27, 91, 92, 93].includes(key) ? { key, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey } : null;
  }
  function initialFields(assessment) {
    const settings = assessment.enhancements || {}, hardware = settings.hardware || assessment.hardware || {};
    const helper = scope.launchSettingsUi || (typeof require === 'function' ? require('./launch-settings-ui') : null);
    const backend = helper.hardwareFacts(hardware).fgBackend || '';
    return { sr: helper.initialSrFields(settings, hardware),
      fg: { backend: hasFgComponents(assessment) && settings.fgComponents?.backend || backend, mode: 'restore', multiplier: 2, targetFps: 0, ...(settings.current?.fg?.valid ? settings.current.fg.request : settings.requests?.fg?.request || settings.applied?.fg?.request || {}) } };
  }
  function mount(host, manager, options = {}) {
    const eventController = new AbortController();
    let id = null, data = null, draft = {}, fields = {}, invalidFields = {}, tab = 'overview', busy = false, launching = false, message = '', error = false,
      modal = null, generation = 0, session = null, unsubscribe = null, disposed = false, tabController = null, capturingHotkey = false, faceStrength = 1,
      readinessState = null, readinessEpoch = -1, readinessOrder = -1, assessmentOrder = 0, launchAttempt = 0;
    const loaded = new Set(), sectionRequests = new Map(), sectionTokens = new Map(), sectionFailures = new Map();
    const draftCount = () => new Set([...Object.keys(draft), ...Object.keys(invalidFields)]).size;
    const dirty = () => draftCount() > 0;
    const act = (name, label, disabled = false, kind = '') => `<button type="button" class="button ${kind}" data-gp-action="${name}"${disabled ? ' disabled' : ''}>${label}</button>`;
    const selected = (name, baseline) => draft[name] ?? baseline;
    const currentHardware = () => data.enhancements?.hardware || data.hardware || {};
    function launchReadiness() {
      const fallback = data?.enhancements?.launchReadiness?.state ? data.enhancements.launchReadiness : data?.launch?.readiness;
      return readinessState?.state ? readinessState : fallback || null;
    }
    function updateLaunchReadiness(gameId, value) {
      if (disposed || id !== gameId || !value?.state) return;
      readinessState = structuredClone(value); readinessEpoch = generation; readinessOrder = ++assessmentOrder;
      render();
    }
    function readinessBlocker() {
      const info = launchReadiness();
      return Array.isArray(info?.blockers) ? info.blockers.find(row => row && row.message) || info.blockers[0] || null : null;
    }
    function readinessNeedsAction() {
      const info = launchReadiness();
      return info?.state === 'blocked' || info?.state === 'unknown' && Array.isArray(info.blockers) && info.blockers.length > 0;
    }
    function readinessNeedsNotice() {
      const info = launchReadiness();
      return readinessNeedsAction() || info?.state === 'unknown';
    }
    function readinessActionKind() {
      const action = readinessBlocker()?.action;
      return typeof action === 'string' ? action : action?.kind || null;
    }
    function readinessMessage() {
      const info = launchReadiness(), blocker = readinessBlocker();
      if (!info || !readinessNeedsNotice()) return '';
      if (info.state === 'unknown' && !blocker && info.source === 'metadata') return '已保存设置；启动时会检查当前状态。';
      return blocker?.message || (info.state === 'unknown' ? '启动前状态暂时无法确认，请重新检查设置。' : '启动前还有需要处理的设置。');
    }
    function readinessActionName() {
      const kind = readinessActionKind();
      const fgRecovery = data?.enhancements?.fgComponents?.fileRecoveryPending || data?.enhancements?.fgComponents?.migrationPending;
      if (kind === 'recover' && fgRecovery) return 'recover-fg-components';
      if (kind === 'recover' && (data?.enhancements?.pending?.length || data?.operation?.pending || data?.deployment?.needsRecovery)) {
        return data?.enhancements?.pending?.length ? 'recover-settings' : 'recover-operation';
      }
      return 'resolve-readiness';
    }
    function readinessActionLabel() {
      const kind = readinessActionKind();
      if (kind === 'recover') return readinessBlocker()?.domain === 'fg' ? '前往补帧恢复' : '恢复未完成操作';
      if (kind === 'migrate') return '前往补帧设置';
      if (kind === 'reapply') return '重新预览设置';
      if (kind === 'open-settings') return '前往超分补帧设置';
      return launchReadiness()?.state === 'unknown' ? '重新检查启动条件' : '处理启动前设置';
    }
    async function resolveReadiness({ refresh: recheck = true } = {}) {
      const targetId = id, targetGeneration = generation;
      if (recheck || !loaded.has('installation')) await loadSection('installation', recheck);
      if (disposed || id !== targetId || generation !== targetGeneration) return;
      const kind = readinessActionKind();
      if (kind === 'recover' && (data?.enhancements?.fgComponents?.fileRecoveryPending || data?.enhancements?.fgComponents?.migrationPending)) return work(() => manager.recoverFgComponents(id), '未完成补帧组件操作已恢复。', true);
      if (kind === 'recover' && data?.enhancements?.pending?.length) return work(() => manager.recoverLaunchSettings(id), '未完成设置事务已恢复。', true);
      if (kind === 'recover' && (data?.operation?.pending || data?.deployment?.needsRecovery)) return work(() => manager.recoverOperation(id), '已检查并恢复未完成操作。', true);
      const next = kind === 'recover' ? 'maintenance' : 'enhance';
      selectTab(next);
      await loadSection(TAB_SECTION[next]);
      if (next === 'maintenance') await loadSection('enhancements');
    }
    const operationApi = api => scope.ManagerOperationApi.resolveOperationApi({ ...data.game,
      operationApi:{ ...data.game.operationApi, detectedApi:data.api?.detectedApi || data.game.operationApi?.detectedApi } }, {api});
    const detectedApi = () => operationApi('auto').detectedApi;
    const effectiveApi = () => operationApi(selected('api', data.game.apiOverride || data.defaults?.api || 'auto')).effectiveApi;
    const apiReady = () => ['dx9', 'dx10', 'dx11', 'dx12', 'vulkan'].includes(effectiveApi());
    const isComparison = row => row.comparisonOnly === true || row.id === COMPARISON_VERSION;
    function specialInfo(route = specialRoute()) {
      const current = data.game[route] || {}, selected = current.selections?.[effectiveApi()];
      return !current.installed && selected ? { ...current, ...selected, selectionAvailable: selected.available } : current;
    }
    function versionRows() {
      const special = specialRoute(), info = special ? specialInfo(special) : null;
      return special ? [{ id: info.packageId || '', label: `${special === 'vulkan' ? 'Vulkan' : `${apiLabel(info.api || effectiveApi())} Feeder`} · ${info.coreVersion || '固定配套'}`, ready: info.selectionAvailable ?? info.available }] : data.coreVersions || [];
    }
    function currentVersion() {
      const special = specialRoute();
      if (special) return specialInfo(special).packageId || '';
      if (Object.hasOwn(draft, 'version')) return draft.version || '';
      if (data.game.installed) return data.deployment?.version || data.game.addonVersion || data.defaults?.version || '';
      if (data.game.existingInstallation?.detected === true) return '';
      return data.defaults?.version || (data.coreVersions || []).find(row => row.ready !== false)?.id || '';
    }
    function deploymentMode() { return selected('deployment', data.game.installed ? data.layout?.mode || 'local' : data.defaults?.deployment || 'local'); }
    function hasVersionUpdate() {
      const installed = data.deployment?.version || data.game.addonVersion;
      return !specialRoute() && data.game.installed && installed && currentVersion() && installed !== currentVersion();
    }
    function installRequest() {
      const route = specialRoute();
      return { ...draft, version: currentVersion(), api: selected('api', data.game.apiOverride || data.defaults?.api || 'auto'), ...(route ? { route } : {
        deployment: deploymentMode(), ...(deploymentMode() === 'external' ? { loadingMode: selected('loadingMode', data.layout?.loadingMode || data.defaults?.loadingMode || 'proxy') } : {}) }) };
    }
    function apiBlocked(request = draft) {
      if (request.repair === true) return false;
      if (Object.keys(request).length && Object.keys(request).every(key => key === 'launchMode')) return false;
      if (request.uninstall || request.sr?.quality === 'game' || request.fg?.mode === 'restore') {
        const other = Object.keys(request).filter(key => !['uninstall', 'sr', 'fg'].includes(key));
        if (!other.length && (!request.sr || request.sr.quality === 'game') && (!request.fg || request.fg.mode === 'restore')) return false;
      }
      return !apiReady();
    }
    function specialRoute() {
      const api = effectiveApi();
      if (draft.route && draft.route !== 'auto') return draft.route === 'native' ? null : draft.route;
      if (data.layout?.inputRoute === 'feeder' || data.game.feeder?.installed || data.layout?.source === 'feeder') return 'feeder';
      if (api === 'vulkan' && data.game.vulkanRouteOwner === 'external-provider') return 'vulkan';
      if (data.layout?.source === 'vulkan' || api === 'vulkan') return 'vulkan';
      const coreId = draft.version || data.deployment?.version || data.game.addonVersion || data.defaults?.version;
      const present = (data.coreVersions || []).find(row => row.id === coreId)?.supportsPresent ?? data.game.coreCapabilities?.supportsPresent;
      if (['dx9', 'dx10'].includes(api) || Number(data.game.chosen?.bitness) === 32 && data.game.feeder?.selections?.[api]?.available ||
          data.game.nativeDlssAvailable === false && (api === 'dx11' || api === 'dx12' && !present)) return 'feeder';
      return null;
    }
    function feature(domain) { return data?.enhancements?.featureStates?.[domain] || { eligible: false, blockers: [{ message: '尚未确认此功能的支持条件。' }] }; }
    function head() {
      const allowHoyoEnhance = options.hoyoSettingsOnly && (readinessNeedsAction() || tab === 'enhance');
      const tabs = options.hoyoSettingsOnly ? [['overview', '安装与画面'], ...(allowHoyoEnhance ? [['enhance', '超分与补帧']] : []), ['maintenance', '高级与维护']] : [['overview', '安装与画面'], ['enhance', '超分与补帧'], ['maintenance', '高级与维护']];
      return `<div class="detail-tabs gp-tabs" role="tablist" aria-label="游戏设置">${tabs.map(([key, label]) => `<button class="detail-tab" type="button" role="tab" data-detail-tab="${DETAIL_TAB[key]}" data-gp-tab="${key}" aria-selected="${tab === key}" tabindex="${tab === key ? 0 : -1}">${label}</button>`).join('')}</div>`;
    }
    function diagnosticsContent() {
      const api = data.api || {}, v = data.verification || {}, modules = data.helperModules?.modules || [], deployment = data.deployment || {};
      return `<section class="gp-section" role="tabpanel" aria-label="概览与兼容性"><div class="gp-section-title"><h3>本次运行验收</h3>${act('refresh', '重新检查', busy, 'subtle')}</div>
        <div class="gp-verification">${[['helper', '加载助手就绪'], ['reshade', 'ReShade 已加载'], ['core', data.layout?.hostRequired ? '宿主 Core 已加载' : '本 Core 已加载'], ['nr', 'NR 完成并回填'], ['visual', '同场景画面变化']].map(([key, label], index) => `<article><div class="gp-step">0${index + 1}</div><h4>${label}</h4>${badge(v[key]?.status || 'unverified')}<p>${esc(v[key]?.detail || '等待本次证据。')}</p></article>`).join('')}</div>
        <p class="gp-caption">配置保存、助手就绪和 HDR 成功分别记录；NR 处理和画面变化需要各自的证据。</p>
        ${manager.recordVisualComparison ? act('record-visual', '记录本次画面对照', busy || !(session || data.launch?.session)?.process || (session || data.launch?.session)?.historical) : ''}</section>
        <section class="gp-section"><h3>API 对照</h3><div class="gp-facts">${line('游戏能力', (api.capabilities || []).map(apiLabel).join(' / ') || '证据不足')}${line('当前配置', apiLabel(api.configuredApi))}
        ${line('当前采用', apiLabel(api.effectiveApi))}${line('用户选择', apiLabel(data.game.apiOverride || 'auto'))}${line('本次观察', apiLabel(api.observedApi))}${line('实际呈现', apiLabel(api.presentationApi))}
        ${line('检测可信度', { confirmed: '本次已确认', high: '高', medium: '中', low: '低', none: '证据不足' }[api.confidence])}${line('桥接条件', api.bridgeStatus?.required ? `${api.bridgeStatus.kind || '需要桥接'} · ${api.bridgeStatus.verified ? '已验证' : '实际运行待验证'}` : api.bridgeStatus?.required === false ? '无需桥接' : '待确认')}</div>
        ${api.effectiveApi === 'mixed' && !api.conflicts?.length ? '<p class="gp-caption">可用 API 不止一种，请按游戏当前设置确认。</p>' : ''}
        ${(api.conflicts || []).map(row => `<p class="gp-message error">${esc(row.message || row.reason || JSON.stringify(row))}</p>`).join('')}
        <details class="gp-evidence"><summary>查看检测依据与覆盖范围</summary><ul>${(api.evidence || []).map(row => `<li><strong>${apiLabel(row.api)}</strong> · ${esc(row.message || row.detail || row.kind || '')}<small>${esc(row.source || '')} ${esc(row.path || '')}</small></li>`).join('') || '<li>尚无足够的检测依据。</li>'}</ul><pre>${esc(JSON.stringify(api.coverage || {}, null, 2))}</pre></details></section>
        <section class="gp-section"><h3>当前部署</h3><div class="gp-facts">${line('运行方式', deployment.mode === 'external' ? `外置目录 · ${deployment.loadingMode === 'helper' ? '加载助手' : '代理加载'}` : '游戏目录')}
        ${line('Core 版本', deployment.version || data.game.addonVersion || '尚未安装')}${line('活动配置', data.layout?.activeConfigPath)}${line('运行目录', data.layout?.runtimeDir)}</div></section>
        ${modules.length ? `<section class="gp-section"><h3>插件允许清单</h3><p class="gp-caption">按部署记录的名称、位数和摘要核验；被禁用的插件需要在配置中启用后重新应用。</p><div class="gp-module-list">${modules.map(row => `<div><strong>${esc(row.name)}</strong>${badge(row.status)}<small>${esc(row.path)}</small><small>${esc(row.architecture || '位数待确认')} · ${esc(row.sha256?.slice(0, 16) || '无摘要')}…</small></div>`).join('')}</div></section>` : ''}
        ${data.components ? `<section class="gp-section"><h3>组件来源与冲突</h3><p class="gp-caption">本 Core、Generic NR、HDR 和补帧组件分别识别。静态文件检查不代表已被本次进程加载。</p>
          <div class="gp-module-list">${(data.components.files || []).map(row => `<div><strong>${esc(row.name)}</strong>${badge(row.status)}<small>${esc(row.label)} · ${{ verified: '固定摘要已核对', declared: '组件自声明', hint: '仅文件名线索', unknown: '证据不足' }[row.confidence] || '待确认'}</small><small>${esc(row.path)}</small><small>${esc(({ enabled: '配置允许加载', disabled: '配置已禁用', candidate: '代理候选', dependency: '依赖文件', 'inactive-or-unverified': '加载位置待确认' })[row.loadState] || '')} · ${esc(row.architecture || '')}</small></div>`).join('') || '<p class="gp-caption">当前范围未发现需核对的组件。</p>'}</div>
          ${[...(data.components.conflicts || []), ...(data.components.warnings || [])].map(row => `<p class="gp-message">${esc(row.detail)}</p>`).join('')}</section>` : ''}
        ${data.antiCheat?.detected ? `<section class="gp-section gp-risk"><h3>游戏保护与账号风险</h3><p>${esc(data.antiCheat.message)}</p><div class="gp-actions">${act('anti-cheat', '官方说明')}${act('compatibility-search', '搜索此游戏兼容资料')}${act('maintenance-tab', '维护与恢复')}</div></section>` : ''}
        ${(data.failures || []).length ? `<details class="gp-section"><summary>部分检查暂不可用</summary>${data.failures.map(row => `<p class="gp-caption">${esc(row.section)}：${esc(row.message)}</p>`).join('')}</details>` : ''}`;
    }
    function selectField(group, key, label, markup, disabled = false, note = '') {
      return `<label class="gp-field"><span>${label}</span><select data-gp-group="${group}" data-gp-field="${key}"${disabled ? ' disabled' : ''}>${markup}</select>${note ? `<small>${note}</small>` : ''}</label>`;
    }
    function nrFields() {
      const nr = { ...(data.nr || {}), ...(draft.nr || {}) }, available = Boolean(data.game.installed && data.nr);
      if (nr.AutoMask && nr.SkinStructureStrength < 0) nr.SkinStructureStrength = 0;
      const primary = ['Intensity', 'LocalToneStrength', 'LocalStructureStrength'];
      const controls = rows => rows.map(([key, label, min, max, step]) => {
          const capable = available && (!Object.hasOwn(data.nr?.capabilities || {}, key) || data.nr.capabilities[key] === true);
          if (NR_CHOICES[key]) return selectField('nr', key, label, NR_CHOICES[key].map((label, value) => option(value, label, nr[key] ?? 0)).join(''), !capable);
          const limits = data.nr?.limits?.[key] || {}, lower = limits.min === undefined ? key === 'SkinStructureStrength' ? 0 : min : Number(limits.min), upper = limits.max === undefined ? max : Number(limits.max);
          return `<label class="gp-field"><span>${label}</span><div class="gp-range"><input type="range" min="${lower}" max="${upper}" step="${step}" value="${esc(nr[key] ?? lower)}" data-gp-group="nr" data-gp-field="${key}"${capable ? '' : ' disabled'}><output>${esc(nr[key] ?? lower)}</output></div>${capable ? key === 'CustomWorkScale' ? '<small>工作模式选为“自定义”后生效。</small>' : '' : '<small>当前 Core 或配置未提供此项。</small>'}</label>`;
      }).join('');
      return `<section class="gp-section"><div class="gp-section-title"><h3>NR 画面增强</h3><label class="check-line gp-check"><input type="checkbox" data-gp-group="nr" data-gp-field="Enabled"${nr.Enabled ? ' checked' : ''}${available ? '' : ' disabled'}>开启</label></div>
        ${!available ? '<p class="gp-caption">安装后可调整画面增强。</p>' : ''}
        ${effectiveApi() === 'dx9' ? '<p class="gp-caption">游戏内面板提供 NR 回填开关；完整参数在此调整，退出游戏后应用。</p>' : ''}
        <div class="gp-controls gp-nr-primary">${controls(NR.filter(([key]) => primary.includes(key)))}</div>
        <div class="gp-face-control"><label class="check-line gp-check"><input type="checkbox" data-gp-group="face" data-gp-field="enabled"${nr.AutoMask ? ' checked' : ''}${available && data.nr?.capabilities?.SkinStructureStrength !== false ? '' : ' disabled'}>人脸调节</label>${nr.AutoMask ? controls([['SkinStructureStrength', '人脸强度', 0, 2, .05]]) : '<small>关闭时保留上次强度。</small>'}</div>
        <details class="gp-nr-details" data-gp-detail="nr"><summary>更多 NR 参数</summary><div class="gp-controls">${controls(NR.filter(([key]) => !primary.includes(key) && key !== 'SkinStructureStrength' && (key !== 'CustomWorkScale' || Number(nr.WorkMode) === 5)))}</div></details></section>`;
    }
    function featurePanel(domain) {
      const info = feature(domain), f = fields[domain], owned = data.enhancements?.applied?.[domain], active = info.eligible === true, allowRestore = Boolean(owned) || domain === 'fg' && hasFgComponents(data), sr = domain === 'sr';
      const reasons = (info.blockers || []).map(row => row.message || row);
      const activationText = info.activation?.message || (info.activation ? ({ on: '已读取到游戏开关开启。', off: '请先在游戏中开启此功能。', unknown: '游戏内开关状态尚未核实；可先配置，实际采用需进游戏确认。', missing: '请先运行游戏以生成设置。' })[info.activation.state] || '游戏开关状态待确认。' : '');
      const warnings = [...new Set((info.warnings || []).map(row => row.message || row))].filter(value => value && value !== activationText && !reasons.includes(value));
      const unavailableOptions = !sr && info.capabilityOptions ? [...(info.capabilityOptions.multipliers || []).map(row => ({ ...row, label: `${row.value}×` })), ...(info.capabilityOptions.modes || []).filter(row => row.value === 'dynamic').map(row => ({ ...row, label: '动态目标帧率' }))].filter(row => row.available === false && row.message) : [];
      let controls;
      if (sr) {
        const model = scope.launchSettingsUi.recommendedPreset(currentHardware()), labels = scope.launchSettingsUi.SR_MODEL_LABELS;
        controls = selectField('sr', 'preset', '超分模型', option('', '保持原有模型', f.preset) + ['M', 'K', 'L'].map(value => option(value, `${labels[value]}${model === value ? ' · 本机推荐' : ''}`, f.preset)).join('') + option('auto', 'NVIDIA 按档位推荐', f.preset), !active || f.quality === 'game', f.preset === 'L' ? '主要优化 4K 超级性能档位。' : f.preset === 'auto' ? `按所选档位推荐${recommendedModel(f.quality) ? ` ${recommendedModel(f.quality)}` : '，当前档位待确认'}。` : '') +
          selectField('sr', 'quality', 'DLSS 档位', Object.entries({ preserve: '保持游戏档位，仅修改模型', game: '恢复游戏控制', dlaa: 'DLAA', quality: '质量', balanced: '平衡', performance: '性能', ultraPerformance: '超级性能', custom: '自定义比例' }).map(([key, label]) => option(key, label, f.quality, !active && key !== 'game')).join(''), !active && !allowRestore) +
          (f.quality === 'custom' ? `<label class="gp-field"><span>输入比例</span><input type="number" min="33" max="100" step="1" value="${esc(f.renderPercent)}" data-gp-group="sr" data-gp-field="renderPercent"${active ? '' : ' disabled'}><small>33–100%。</small></label>` : '');
      } else {
        const modes = info.availableModes || [], multipliers = info.availableMultipliers || [];
        controls = selectField('fg', 'mode', '补帧模式', Object.entries({ restore: '使用原有设置', follow: '跟随游戏倍率', off: '驱动关闭 FG', fixed: '固定总倍率', dynamic: '动态目标帧率' }).map(([key, label]) => option(key, label, f.mode, key !== 'restore' && (!active || !modes.includes(key)))).join(''), !active && !allowRestore) +
          (f.mode === 'fixed' ? selectField('fg', 'multiplier', '总帧率倍率', [2, 3, 4, 5, 6].map(value => option(value, `${value}×${multipliers.includes(value) ? '' : ' · 待确认支持'}`, f.multiplier, !multipliers.includes(value))).join(''), !active, f.backend === 'mfgunlock' ? 'MFG 0.9 是绝对倍率，可以提高或降低游戏请求。' : '') : '') +
          (f.mode === 'dynamic' ? `<label class="gp-field"><span>动态目标帧率</span><input type="number" min="0" max="1000" step="1" value="${esc(f.targetFps)}" data-gp-group="fg" data-gp-field="targetFps"${active && modes.includes('dynamic') ? '' : ' disabled'}><small>0 表示自动目标；只在完整运行时已确认支持时开放。</small></label>` : '');
        if (f.backend === 'mfgunlock' && f.mode !== 'restore') {
          const tri = (key, label, note = '') => { const selected = f[key] === true ? 'on' : f[key] === false ? 'off' : f[key]; return selectField('fg', key, label,
            option('', '保持插件当前设置', selected) + option('on', '开启', selected) + option('off', '关闭', selected), !active, note); };
          controls += `<details class="gp-capability-details"><summary>高级兼容设置 · 遇到问题时再调整</summary><div class="gp-controls">
            ${selectField('fg', 'runtimeMode', '运行库策略', option('', '保持插件当前设置', f.runtimeMode) + option('game', '游戏自带（推荐）', f.runtimeMode) + option('local', '优先本地', f.runtimeMode) + option('ota', 'NVIDIA OTA', f.runtimeMode), !active)}
            ${selectField('fg', 'hdrMode', 'HDR 兼容', option('', '保持插件当前设置', f.hdrMode) + option('native', '原生路径', f.hdrMode) + option('ui-composition', 'UI 合成', f.hdrMode) + option('automatic', '自动选择', f.hdrMode) + option('final-color', '最终颜色', f.hdrMode), !active)}
            ${selectField('fg', 'depthEdgeGuard', '边缘保护', option('', '保持插件当前设置', f.depthEdgeGuard) + [0, 1, 2, 3, 4].map(value => option(value, value === 0 ? '0 · 关闭' : value, f.depthEdgeGuard)).join(''), !active)}
            ${selectField('fg', 'maxCount', '运行库报告倍率上限', option('', '保持插件当前设置', f.maxCount) + [2, 3, 4, 5].map(value => option(value, `${value}×`, f.maxCount)).join(''), !active)}
            ${tri('freezeFallback', '3×/4× 卡死救援', '卡死时尝试软件节奏；正常游戏保持插件设置。')}${f.mode === 'dynamic' ? tri('reflexSourceCap', 'Dynamic Reflex 源帧限制') : ''}
            ${tri('temporalFix', '时序修复')}${tri('blackwellFrameworkKernels', 'Blackwell 框架内核')}
            ${tri('thinGeometryIntermediateScatter', '细线中间帧保护')}${tri('thinGeometryValidatedWarpBlend', '细线校验混合')}
            ${tri('thinGeometryPreviousScatter', '细线上一帧保护', '实验项，可能影响旧游戏。')}${tri('raiseFrameCeiling', '提高帧上限', '仅在确认需要 5×/6× 时考虑。')}
          </div></details>`;
        }
      }
      return `<section class="gp-section"><div class="gp-section-title"><div><h3>${sr ? 'DLSS 超分' : f.backend === 'mfgunlock' ? 'RTX40 补帧' : f.backend === 'nvidia' ? 'RTX50 帧生成' : '帧生成'}</h3></div>${badge(info.state || (active ? 'configurable' : 'unavailable'))}</div>
        ${reasons.length && reasons[0] !== activationText ? `<p class="gp-caption" title="${esc(reasons.join('；'))}">${esc(reasons[0])}</p>` : ''}${activationText ? `<p class="gp-caption" role="status">${esc(activationText)}</p>` : ''}${warnings.map(value => `<p class="gp-caption">${esc(value)}</p>`).join('')}
        ${domain === 'fg' && data.enhancements?.current?.fg?.source === 'active-ini' ? `<p class="gp-caption">已读取游戏内保存的当前设置${data.enhancements.current.fg.differsFromLastApplied ? '，与上次管理器请求不同' : ''}。${draft.fg ? '当前草稿保留，应用前会重新核对。' : ''}</p>` : ''}
        <div class="gp-controls">${controls}</div>${!sr && f.backend === 'mfgunlock' ? `<p class="gp-caption">游戏内菜单：ReShade → Add-ons → MFG Unlock。来源：mavismmg/MFGAdaUnlock-RenoDx 0.9；设置读回不等于生成帧已验证。</p><div class="gp-small-actions">${act('mfg-source', '查看开源项目', busy, 'subtle')}</div>` : ''}${unavailableOptions.length ? `<details class="gp-capability-details"><summary>未开放档位说明</summary>${unavailableOptions.map(row => `<p class="gp-caption"><strong>${esc(row.label)}</strong> · ${esc(row.message)}</p>`).join('')}</details>` : ''}<p class="gp-caption">${owned ? owned.readbackVerified ? '已应用，重启游戏后生效。' : '设置已变化，请重新预览。' : '尚未应用覆盖设置。'}</p>
        <div class="gp-small-actions">${sr ? act('recommend-sr', '恢复推荐', busy || !active || !scope.launchSettingsUi.recommendedPreset(currentHardware()), 'subtle') + act('preview-sr', '预览当前超分设置', busy || data.operation?.pending || !apiReady() || !loaded.has('enhancements') || (!feature('sr').eligible && !(fields.sr.quality === 'game' && data.enhancements?.applied?.sr)), 'subtle') : ''}${allowRestore ? act(`restore-${domain}`, '恢复原设置', busy, 'subtle') : ''}${owned?.requiresReapply ? act('reapply', '重新预览', busy) : ''}</div></section>`;
    }
    function componentStackOverview() {
      const saved = data.componentChoices?.stack;
      if (!saved) return '';
      const changed = Boolean(draft.api || draft.version || draft.route || draft.components?.bridge);
      if (!changed) return `<div class="gp-component-stack ${saved.status === 'ready' ? 'is-ready' : 'needs-attention'}"><div><small>自动组件搭配</small><strong>${esc(saved.title)}</strong><span>${esc(saved.summary)}</span></div><div class="gp-component-stack-items">${(saved.items || []).filter(row => row.key !== 'api').map(row => `<span class="is-${esc(row.status || 'pending')}"><b>${esc(row.label)}</b>${esc(row.value)}</span>`).join('')}</div><p>${esc(saved.reason || '')}</p></div>`;
      const api = effectiveApi(), route = selected('route', saved.route || 'auto'), version = currentVersion();
      const input = route === 'feeder' || ['dx9','dx10'].includes(api) ? 'DLSS5 Feeder' : api === 'dx11' ? 'DLSS5 Bridge' : api === 'vulkan' ? 'Vulkan 专用配套' : '游戏原生 DLSS 输入';
      const combination = input === 'DLSS5 Feeder' ? `${input} + 专用 Core / 运行库` : input === 'Vulkan 专用配套' ? input : `${coreLabel(version || '待选 Core')} + ${input} + 显卡运行库`;
      return `<div class="gp-component-stack needs-attention"><div><small>修改后的预期搭配</small><strong>${esc(apiLabel(api))} · ${esc(input)}</strong><span>${esc(combination)}</span></div><p>预览时会重新校验 Core、接口与组件摘要；不匹配时不会写入游戏。</p></div>`;
    }
    function installation() {
      const game = data.game, api = selected('api', game.apiOverride || data.defaults?.api || 'auto'), effective = effectiveApi(), special = specialRoute();
      const existing = !game.installed && game.existingInstallation?.detected === true ? game.existingInstallation : null;
      const version = currentVersion(), visibleVersion = version === COMPARISON_VERSION ? '0.4.7beta' : version;
      const versions = versionRows().filter(row => !isComparison(row));
      const pending = data.operation?.pending || data.deployment?.needsRecovery;
      if (options.hoyoSettingsOnly) {
        const current = data.deployment?.version || game.addonVersion || game.feeder?.coreVersion || '待确认';
        const picker = special ? '' : `<section class="gp-section"><div class="gp-controls">${selectField('route', 'version', 'AI 增强组件',
          (versions.some(row => row.id === version) ? '' : option(version, `${coreLabel(version)} · 来源待检查`, version, true)) +
          versions.map(row => option(row.id, coreLabel(row.label || row.id), version, row.ready === false)).join(''), busy || pending,
          versions.find(row => row.id === version)?.notes || '切换前会预览本次文件变更；保留此客户端的绑定和个人配置。')}</div></section>`;
        return `<p class="gp-caption">当前 Core：${esc(coreLabel(current))} · 此客户端独立配置</p>${picker}${nrFields()}`;
      }
      const attention = readinessNeedsAction(), readinessNotice = readinessNeedsNotice();
      const unresolved = !effective || ['mixed', 'unknown', 'auto'].includes(effective);
      const automatic = detectedApi(), automaticLabel = !automatic || ['mixed', 'unknown', 'auto'].includes(automatic) ? '需要手动选择' : `${apiLabel(automatic)}（自动）`;
      let status = !loaded.has('installation') ? '正在检查安装条件…' : pending ? '有未完成操作，请先恢复。' : attention ? readinessMessage() : readinessNotice ? '启动时检查设置。' : !apiReady()
        ? unresolved ? '需要手动选择游戏实际使用的 API。' : `${apiLabel(effective)} 当前不支持安装。`
        : data.layout?.needsInputPreparation ? '加载配置已准备，请预览修复以补齐输入配套。' : game.installed ? data.deployment?.verified === false && data.deployment?.inspection !== 'summary' ? '安装需要检查，可预览修复。' : '已安装，可以调整画面或启动游戏。'
        : existing ? '检测到已有插件，但没有本管理器的安装回执；请选择替换目标并预览处理。'
        : '基础条件已确认，安装前将预览本次变更。';
      if (data.antiCheat?.detected && !pending && !readinessNotice && apiReady()) status = '检测到游戏保护，安装前需确认兼容提示。';
      if (loaded.has('installation') && !pending && !readinessNotice && apiReady() && !version) status = existing
        ? '已有安装的版本无法可靠确认；请选择目标 Core，然后预览备份与替换。'
        : '配套版本尚未确定，请选择可用 Core。';
      const existingNames = existing?.files?.map(row => row.name).slice(0, 6) || [];
      return `<section class="gp-section gp-install-section"><div class="gp-controls">
        ${selectField('route', 'api', '游戏 API', option('auto', automaticLabel, api) + ['dx9', 'dx10', 'dx11', 'dx12', 'vulkan'].map(key => option(key, API[key] || key.toUpperCase(), api)).join(''), busy)}
        ${selectField('route', 'version', 'AI 增强组件', (!visibleVersion ? option('', '请选择 AI 增强组件', '', true) : versions.some(row => row.id === visibleVersion) ? '' : option(visibleVersion, `${coreLabel(visibleVersion)} · 来源待检查`, visibleVersion, true)) + versions.map(row => option(row.id, coreLabel(row.label || row.id), visibleVersion, row.ready === false)).join(''), busy || Boolean(special))}</div>
        ${componentStackOverview()}
        <div class="gp-compatibility ${pending || readinessNotice || !apiReady() ? 'needs-attention' : ''}" role="status"><strong>兼容性</strong><span>${esc(status)}</span>${pending ? act('recover-operation', '恢复操作', busy, 'subtle') : attention && readinessActionName() !== 'resolve-readiness' ? act(readinessActionName(), readinessActionLabel(), busy, 'subtle') : ''}</div>
        ${existing ? `<div class="gp-message"><strong>检测到已有未受管安装</strong><p>${esc(existingNames.join('、') || '已有插件文件')}。管理器没有对应回执，因此不会把它冒充成“已安装”，也不会依据旧日志猜测版本。</p><p>选择目标 Core 后只会先打开逐文件预览；确认应用时，旧文件会备份到 _DLSS5_Backup 下再替换，取消预览不会改动游戏。</p></div>` : ''}
        ${hasVersionUpdate() ? `<p class="gp-caption">当前已安装 ${esc(data.deployment?.version || game.addonVersion)}；应用后才会更新所选配套。</p>` : existing ? '<p class="gp-caption">不会自动沿用全局“新安装默认 Core”；请明确选择要替换成的版本。</p>' : !game.installed && !special ? `<p class="gp-caption">默认使用游戏目录；安装预览会核对真实 DLSS 集成，无原生输入时匹配 Feeder。</p>` : ''}</section>${hoyoControls()}${nrFields()}`;
    }
    function enhancements() {
      const facts = scope.launchSettingsUi.hardwareFacts(currentHardware());
      const fg = data.enhancements?.fgComponents || {}, current = draft.components?.mfgUnlock || fg.installedProvider || fg.defaultProvider;
      return `<div class="gp-hardware"><strong>${esc(facts.label)}</strong>${loaded.has('enhancements') ? '' : '<span role="status">正在读取超分补帧条件…</span>'}</div><div class="launch-grid">${featurePanel('sr')}${featurePanel('fg')}</div>${fg.catalog?.length && fields.fg?.backend === 'mfgunlock' ? `<section class="gp-section">${selectField('component', 'mfgUnlock', '独立补帧插件', fg.catalog.map(row => option(row.id, row.label || row.id, current)).join(''), busy, '插件独立于 NR；切换后重启游戏，游戏内面板修改会在重新检查后读回。')}</section>` : ''}`;
    }
    function hoyoControls() {
      const rows = data.game.hoyo?.profileOptions || [];
      if (!rows.length) return '';
      const backend = selected('loadingBackend', data.layout?.loadingBackend || 'local'), selection = draft.hoyo || data.layout?.hoyo || data.game.hoyo?.selected;
      const channel = selection?.channel || rows[0].channel, kind = selection?.launcher?.kind || 'hoyoplay';
      return `<section class="gp-section"><h3>米哈游兼容</h3><div class="gp-controls">${selectField('route', 'loadingBackend', '加载模式', option('local', '常规加载', backend) + option('hoyoshade', 'HoYoShade · 实验', backend), busy)}${backend === 'hoyoshade' ? selectField('hoyo', 'channel', '正式客户端', rows.map(row => option(row.channel, `${row.familyLabel} · ${row.channelLabel}`, channel)).join(''), busy) + selectField('hoyo', 'kind', '绑定启动器', option('hoyoplay', 'HoYoPlay · 就绪后点击启动', kind) + option('starward', 'Starward · 已注册协议', kind), busy) : ''}</div>${backend === 'hoyoshade' ? `<p class="gp-caption">${esc(selection?.launcher?.path || '尚未选择启动器程序')}</p>${act('pick-hoyo-launcher', '选择启动器程序', busy)}<p class="gp-caption">每游戏独立外置目录；助手就绪后等待所选正式客户端，加载与 NR 结果分别核验。</p>` : ''}</section>`;
    }
    function hoyoDraft() {
      const rows = data.game.hoyo?.profileOptions || [], current = draft.hoyo || data.layout?.hoyo || data.game.hoyo?.selected || {};
      return { family: current.family || rows[0]?.family, channel: current.channel || rows[0]?.channel,
        launcher: { kind: current.launcher?.kind || 'hoyoplay', path: current.launcher?.path || '' } };
    }
    function advanced() {
      if (options.hoyoSettingsOnly) return hotkeySection() + (options.maintenanceContent?.() || '');
      const layout = data.layout || {}, special = specialRoute(), mode = deploymentMode(), hoyo = selected('loadingBackend', layout.loadingBackend || 'local') === 'hoyoshade';
      const bridges = data.componentChoices?.bridges || [], bridge = draft.components?.bridge || data.componentChoices?.selected?.bridge;
      const userAddons = data.componentChoices?.addons || [];
      return `<section class="gp-section"><h3>加载与启动</h3><div class="gp-controls">
        ${selectField('route', 'deployment', '组件目录', hoyo ? option('external', 'HoYoShade 外置目录', 'external') : special ? option(mode, `${special === 'vulkan' ? 'Vulkan 外置' : 'Feeder 专用'}目录`, mode) : option('external', '每游戏外置目录', mode) + option('local', '游戏目录', mode), busy || Boolean(special) || hoyo)}
        ${selectField('route', 'loadingMode', '加载方式', option('proxy', '代理加载', hoyo ? 'helper' : selected('loadingMode', layout.loadingMode || 'proxy')) + option('helper', '外置加载助手', hoyo ? 'helper' : selected('loadingMode', layout.loadingMode || 'proxy'), !hoyo && !data.game.installed), busy || Boolean(special) || mode !== 'external' || hoyo, !hoyo && !data.game.installed && !special ? data.game.existingInstallation?.detected === true ? '已有安装完成受管备份与替换后，才可切换助手。' : '首次安装使用代理；安装后可切换助手。' : '')}
        ${selectField('input-route', 'route', 'NR 输入方式', option('auto', '自动核对并匹配配套', draft.route || 'auto') + option('native', '原生 DLSS 输入', draft.route || 'auto', ['dx9', 'dx10'].includes(effectiveApi())) + option('feeder', 'Feeder · 无原生 DLSS', draft.route || 'auto', effectiveApi() === 'vulkan'), busy, '检测依据绑定所选游戏程序；仅有 DLSS DLL 不代表原生集成。')}
        ${hoyo ? `<p class="gp-caption">启动方式由已绑定的 ${esc(data.launch?.effective === 'starward' ? 'Starward' : 'HoYoPlay')} 决定。</p>` : selectField('route', 'launchMode', '启动方式', option('auto', '自动 · Steam 优先', selected('launchMode', data.launch?.selected || 'auto')) + option('steam', '通过 Steam', selected('launchMode', data.launch?.selected || 'auto'), !data.launch?.steamAvailable) + option('exe', '直接启动 EXE', selected('launchMode', data.launch?.selected || 'auto')), busy)}
        ${!hoyo && effectiveApi() !== 'vulkan' ? selectField('route', 'proxyEntry', '加载入口', option('auto', '自动 · 保留现有入口', selected('proxyEntry', data.defaults?.proxyEntry || 'auto')) + option('dxgi', 'dxgi.dll', selected('proxyEntry', data.defaults?.proxyEntry || 'auto')) + option('d3d12', 'd3d12.dll · DX12 兼容', selected('proxyEntry', data.defaults?.proxyEntry || 'auto'), effectiveApi() !== 'dx12'), busy, '入口文件名独立于图形 API，预览会检查目标占用。') : ''}
        ${effectiveApi() === 'dx11' && !special && bridges.length ? selectField('component', 'bridge', 'DX11 桥接器', bridges.map(row => option(row.id, row.label, bridge, !row.ready || !row.compatible)).join(''), busy, '独立选择适配桥接器，保持 Core 版本。') : '<p class="gp-caption">当前路线无需可单独选择的 DX11 桥接器。</p>'}</div></section>
        <section class="gp-section"><h3>用户 Add-on</h3><p class="gp-caption">从组件管理导入任意 64 位 .addon64 后，可在这里按游戏加载。管理器只删除自己部署且摘要未变化的文件。</p><div class="gp-module-list">${userAddons.length ? userAddons.map(row => `<div><strong>${esc(row.label)}</strong><small>${esc(row.name)}${row.classification && row.classification !== 'unknown' ? ` · ${esc(row.classification)}` : ''}</small><small>${row.installed ? '已由管理器加载' : row.present ? '游戏中已有同名文件' : '尚未加载'}</small><button type="button" class="button ${row.installed ? 'subtle' : ''}" data-gp-action="user-addon" data-gp-component="${esc(row.id)}" data-gp-enable="${row.installed ? 'false' : 'true'}"${busy || !row.canApply || row.present && !row.installed ? ' disabled' : ''}>${row.installed ? '移除' : row.present ? '已存在' : '加载到游戏'}</button></div>`).join('') : '<p class="gp-caption">尚未导入用户 Add-on。可到“组件管理”导入 .addon64；导入不会立即修改游戏。</p>'}</div></section>
        <section class="gp-section"><h3>游戏条目</h3><p class="gp-caption">这里只修改管理器中的显示名称，不会改动游戏文件。</p><div class="gp-actions">${act('rename-game', '修改游戏名称', busy)}</div></section>
        ${hotkeySection()}
        ${loaded.has('diagnostics') && loaded.has('enhancements') ? `<details class="gp-section gp-maintenance-details"><summary>卸载、恢复与环境清理</summary>${maintenance()}</details><details class="gp-section gp-diagnostics-details"><summary>运行验收与详细检测</summary>${diagnosticsContent()}</details>` : '<p class="gp-caption" role="status">正在读取恢复记录与详细检测…</p>'}`;
    }
    function maintenance() {
      const dep = data.deployment || {}, env = data.maintenance || {}, records = data.operation?.record;
      const hasSettings = Object.keys(data.enhancements?.applied || {}).length > 0 || hasFgComponents(data);
      return `<section class="gp-section" role="tabpanel" aria-label="维护与备份"><h3>恢复记录</h3><div class="gp-facts">${line('安装前基线', dep.baseline ? `${dep.baseline.version || '已记录'} · ${dep.baseline.api || ''}` : '由原安装记录保留')}
        ${line('上一完整部署', dep.previous ? `${dep.previous.version || ''} · ${dep.previous.mode || ''}` : '尚无外置切换记录')}${line('当前部署', `${dep.version || data.game.addonVersion || '未安装'} · ${dep.mode === 'external' ? '外置' : '游戏目录'}`)}
        ${line('清理归档', env.backupDirectory || (env.isolated ? '已备份隔离' : '尚无清理归档'))}</div>
        ${records ? `<div class="gp-message error"><strong>上次统一应用尚未完成</strong><p>${esc(records.error?.message || '请恢复未完成事务后继续。')}</p>${(records.stages || []).map(row => `<span class="badge">${esc(row.kind)} · ${esc(row.status)}</span>`).join('')}${act('recover-operation', '恢复未完成操作', busy, 'primary')}</div>` : ''}
        ${data.enhancements?.pending?.length ? act('recover-settings', '恢复超分补帧事务', busy) : ''}${data.enhancements?.fgComponents?.fileRecoveryPending || data.enhancements?.fgComponents?.migrationPending ? act('recover-fg-components', '恢复未完成补帧组件操作', busy) : ''}${dep.needsRecovery ? act('recover-operation', '恢复部署事务', busy) : ''}
        <div class="gp-actions">${act('repair-install', '预览修复', busy || !data.game.installed || data.operation?.pending || dep.needsRecovery)}${!(data.enhancements?.fgComponents?.fileRecoveryPending || data.enhancements?.fgComponents?.migrationPending) ? act('recover-operation', '恢复未完成操作', busy || !(data.operation?.pending || dep.needsRecovery)) : ''}${act('back-local', '迁回游戏目录', busy || dep.mode !== 'external')}${act('open-folder', '打开游戏文件夹')}${act('feedback', '保存反馈与验收记录', busy)}</div></section>
        <section class="gp-section"><h3>卸载与原样恢复</h3><p class="gp-caption">每次选择本次的处理方式，预览文件后再应用。安装前备份和历史归档都会保留。</p><div class="gp-uninstall"><div><h4>干净移除</h4><p>移除摘要一致的受管文件，旧代理和旧插件继续留在备份中。</p>${act('uninstall-clean', '预览干净移除', busy || !data.game.installed, 'danger')}</div><div><h4>恢复安装前</h4><p>恢复有原始记录及摘要的文件。未知 .bak 不会自动当作原件。</p>${act('uninstall-restore', '预览恢复安装前', busy || !data.game.installed)}</div></div></section>
        <section class="gp-section"><h3>环境检查与清理</h3><p class="gp-caption">${esc(env.scope || '')}</p><div class="gp-module-list">${(env.remainingFiles || []).map(row => `<div><strong>${esc(row.name)}</strong><small>${esc(row.kind || row.classification || '需核对来源')}</small><small>${esc(row.sha256?.slice(0, 20) || '')}</small></div>`).join('') || '<p class="gp-caption">当前检查未发现额外代理或 Add-on。</p>'}</div>
        ${data.game.installed || hasSettings ? '<p class="gp-caption">请先明确移除配套并恢复超分补帧设置，再隔离剩余文件。</p>' : ''}<div class="gp-actions">${act('clean-environment', '预览剩余文件隔离', busy || data.game.installed || hasSettings || env.isolated)}${act('restore-environment', '撤销上次清理', busy || !env.canRestore)}</div></section>
        ${manager.removeGame ? `<section class="gp-section"><h3>游戏库条目</h3><p class="gp-caption">先完成卸载与设置恢复，再移出游戏库；之后可重新添加。</p>${act('remove-game', '移出游戏库', busy || dirty() || data.game.installed || hasSettings || data.operation?.pending || dep.needsRecovery || env.isolated, 'subtle')}</section>` : ''}`;
    }
    function hotkeySection() {
      return `<section class="gp-section"><h3>游戏内面板快捷键</h3><p class="gp-caption">ReShade：${esc(bindingLabel(draft.hotkeys?.reshade || data.hotkeys?.reshade))} · NR：${esc(data.hotkeys?.nr?.label || '由 Core 提供')}</p>
        <p class="gp-caption">新安装默认使用 Home；已有自定义键会保留，也可以在这里修改。</p><div class="gp-small-actions">${act('capture-hotkey', capturingHotkey ? '请按组合键 · Esc 取消' : '点击录入快捷键', busy || !data.game.installed)}${act('panel-default', '恢复默认 Home', busy || !data.game.installed)}</div></section>`;
    }
    function footer() {
      const invalid = Object.keys(invalidFields).length > 0, pending = data.operation?.pending || data.deployment?.needsRecovery, readinessBlocked = readinessNeedsAction();
      let primary;
      if (dirty()) primary = act('preview', '预览并应用', busy || invalid || pending || apiBlocked(), 'primary');
      else if (readinessBlocked) primary = act(readinessActionName(), readinessActionLabel(), busy || (readinessActionName() === 'resolve-readiness' && !loaded.has('installation')), 'primary');
      else if (pending) primary = act(data.enhancements?.pending?.length ? 'recover-settings' : 'recover-operation', '恢复未完成操作', busy, 'primary');
      else if (tab === 'overview' && (!data.game.installed || hasVersionUpdate() || data.layout?.needsInputPreparation || data.deployment?.verified === false && data.deployment?.inspection !== 'summary')) primary = act(data.game.installed && !hasVersionUpdate() ? 'repair-install' : 'prepare', !data.game.installed ? data.game.existingInstallation?.detected === true ? '预览已有安装处理' : '安装并启用' : hasVersionUpdate() ? '预览更新配套' : '预览修复安装', busy || pending || !loaded.has('installation') || !apiReady() || !currentVersion() || versionRows().find(row => row.id === currentVersion())?.ready === false, 'primary');
      else primary = '';
      const launchState = session || data.launch?.session, launch = launchState?.historical ? null : launchState;
      if (options.hoyoSettingsOnly && !dirty()) primary = '';
      const hasHeaderLaunch = options.hoyoSettingsOnly || Boolean(host.closest('.game-card')?.querySelector('.unified-launch-btn'));
      const readinessNotice = readinessNeedsNotice();
      const status = invalid ? '请先修正输入' : !apiReady() && apiBlocked() ? '请先在“安装与画面”确认 API' : dirty() ? `${draftCount()} 组修改待应用` : readinessBlocked ? '启动前需要处理' : readinessNotice ? '启动时检查设置' : LAUNCH[launch?.status] || (data.game.installed ? '设置已就绪' : data.game.existingInstallation?.detected === true ? '已有安装待确认' : '确认 API 后安装');
      const detail = dirty() ? '<small>先预览本次修改，再确认应用。</small>' : readinessNotice ? `<small>${esc(readinessMessage())}</small>` : launch?.status === 'waiting-launcher' && launch.launchInstruction ? `<small>${esc(launch.launchInstruction)}</small>` : '';
      return `<div class="gp-apply-bar${dirty() ? ' is-dirty' : readinessNotice ? ' needs-attention' : ''}" aria-label="当前游戏操作"><div role="status"><strong>${status}</strong>${detail}</div><div>${dirty() ? act('discard', '放弃修改', busy, 'subtle') : act('refresh', '重新检查', busy, 'subtle')}${primary}${!hasHeaderLaunch && !dirty() ? act('launch', launching ? '等待游戏…' : data.game.installed ? '启动游戏' : '原样启动', busy || launching || pending || readinessBlocked, primary ? 'subtle' : 'primary') : ''}${launching ? act('cancel-launch', '取消等待') : ''}${act('back', '收起', busy, 'subtle')}</div></div>`;
    }
    function syncHeaderAction() {
      const card = host.closest('.game-card'), start = card?.querySelector('.unified-launch-btn');
      card?.classList.toggle('has-pending-draft', dirty());
      options.onActionState?.({ dirty: dirty(), busy, launching, hasPrimary: Boolean(host.querySelector('.gp-apply-bar .primary')), readiness: launchReadiness(), readinessOrder });
      if (!start) return;
      start.disabled = busy || launching || dirty() || data.operation?.pending || data.deployment?.needsRecovery || readinessNeedsAction();
      start.textContent = launching ? '等待游戏…' : '启动游戏';
      start.classList.toggle('primary', !host.querySelector('.gp-apply-bar .primary'));
    }
    function render() {
      if (disposed) return;
      if (!data) { host.innerHTML = `<div class="gp-section">${act('back', '← 返回游戏库')}<p role="status">${esc(message || '正在读取游戏状态…')}</p>${error ? act('refresh', '重试') : ''}</div>`; return; }
      const focused = host.contains(document.activeElement) ? document.activeElement : null;
      const focusKey = focused?.dataset?.gpField, focusGroup = focused?.dataset?.gpGroup;
      const focusTab = focused?.dataset?.gpTab, focusAction = focused?.dataset?.gpAction;
      const top = host.closest('.view')?.scrollTop;
      const expanded = [...host.querySelectorAll('details[data-gp-detail][open]')].map(row => row.dataset.gpDetail);
      tabController?.dispose();
      const notice = `<div class="gp-message${error ? ' error' : ''}" role="${error ? 'alert' : 'status'}"${message ? '' : ' hidden'}>${esc(message)}</div>`;
      host.innerHTML = options.maintenanceOnly ? notice + (loaded.has('diagnostics') && loaded.has('enhancements') ? maintenance() : '<p class="gp-caption" role="status">正在读取维护记录…</p>') : footer() + head() + notice + ['overview', 'enhance', 'maintenance'].map(key => `<div class="detail-panel" data-detail-panel="${DETAIL_TAB[key]}" role="tabpanel"${tab === key ? '' : ' hidden'}>${tab === key ? key === 'overview' ? installation() : key === 'enhance' ? enhancements() : advanced() : ''}</div>`).join('');
      if (!options.maintenanceOnly) syncHeaderAction();
      if (scope.GameDetailTabs && !options.maintenanceOnly) tabController = scope.GameDetailTabs.mount(host, { initial: DETAIL_TAB[tab], onSelect: value => selectTab(Object.keys(DETAIL_TAB).find(key => DETAIL_TAB[key] === value)) });
      for (const key of expanded) { const detail = host.querySelector(`details[data-gp-detail="${key}"]`); if (detail) detail.open = true; }
      if (focusKey) host.querySelector(`[data-gp-group="${focusGroup}"][data-gp-field="${focusKey}"]`)?.focus({ preventScroll: true });
      else if (focusTab) host.querySelector(`[data-gp-tab="${focusTab}"]`)?.focus({ preventScroll: true });
      else if (focusAction) host.querySelector(`[data-gp-action="${focusAction}"]`)?.focus({ preventScroll: true });
      if (top !== undefined) host.closest('.view').scrollTop = top;
      host.setAttribute('aria-busy', String(busy)); if (modal) renderModal();
    }
    function renderModal() {
      host.querySelector('.gp-modal')?.remove();
      const plan = modal.plan;
      const addonRows = plan?.deployment?.addonCompatibility?.decisions || [];
      modal.addonChoices = addonRows.filter(row => row.moduleMayLoad && !row.mandatory && !['core', 'native-carrier'].includes(row.classification) && (row.action === 'isolate' || row.explicitKeep || row.explicit && row.action === 'preserve'));
      const modalTitle = ({ leave: '离开前处理修改', visual: '本次画面对照记录', cleanup: '备份隔离文件预览', remove: '移出游戏库' })[modal.kind] || '本次操作预览';
      const content = modal.kind === 'remove' ? '<p>将此游戏移出管理器列表。游戏文件与历史备份保留，之后可以重新添加。</p>' : modal.kind === 'leave' ? '<p>当前修改尚未应用。离开后可放弃这些修改。</p>' : modal.kind === 'visual' ?
        '<p>记录绑定本次游戏程序、会话和 Core 摘要。来源会标为用户观察，NR 成功状态仍独立核对。</p><label class="check-line gp-check"><input type="checkbox" data-gp-same-scene>我已完成同场景、相同设置下的增强开关对照</label><label class="gp-field"><span>观察结果</span><select data-gp-visual-result><option value="uncertain">暂时无法确认</option><option value="changed">观察到画面变化</option><option value="unchanged">没有观察到画面变化</option></select></label><label class="gp-field"><span>观察说明</span><textarea data-gp-visual-note maxlength="2000" rows="3" placeholder="例如同一存档位置的人脸、材质或光照变化"></textarea></label><label class="gp-field"><span>F8 / ColorDiag 或截图材料名称（可选）</span><input data-gp-visual-evidence maxlength="240"></label>' : modal.kind === 'cleanup'
        ? `<p>${esc(plan.scope)}</p>${plan.candidates.map(row => `<label class="gp-file-choice"><input type="checkbox" data-gp-clean="${esc(row.name)}"${row.selectedByDefault ? ' checked' : ''}${row.selectable ? '' : ' disabled'}><span><strong>${esc(row.name)}</strong><small>${esc(row.kind)} · ${esc(row.note)}</small><small>${esc(row.sha256)}</small></span></label>`).join('')}`
        : `<p>核对本次变更；操作过程中请保持游戏关闭。</p><div class="gp-change-list">${(plan.changes || []).map(row => `<div><strong>${esc(row.name || row.key || row.domain || row.action)}</strong><span>${esc(({ create: '新增', replace: '替换', remove: '移除', keep: '保留', 'set-config-key': '写入配置', 'set-launch-mode': '修改启动方式' })[row.action] || row.description || row.action)}${row.value !== undefined ? ` → ${esc(row.value)}` : ''}</span><small>${esc(row.path || '')}</small>${row.beforeSha256 !== undefined ? `<details><summary>核验摘要</summary><small>变更前 ${esc(row.beforeSha256 || '不存在')}<br>变更后 ${esc(row.afterSha256 || '移除')}</small></details>` : ''}</div>`).join('')}</div>
        ${modal.addonChoices.length ? `<section class="gp-section"><h4>未知插件保留选择</h4><p class="gp-caption">默认备份隔离。确认需要保留的插件后，重新预览当前组合。</p>${modal.addonChoices.map((row, index) => `<label class="gp-file-choice"><input type="checkbox" data-gp-addon-keep="${index}"${row.explicitKeep ? ' checked' : ''}><span><strong>保留 ${esc(row.name)}</strong><small>${esc(row.path)}</small></span></label>`).join('')}${act('repreview-addons', '按保留选择重新预览', busy)}</section>` : ''}
        ${(plan.blockers || []).map(row => `<p class="gp-message error">${esc(row.message || row)}</p>`).join('')}
        ${data.antiCheat?.detected || plan.deployment?.requiresAntiCheat ? '<label class="check-line gp-check"><input type="checkbox" data-gp-consent>我已了解反作弊可能阻止加载及账号风险，并决定应用。</label>' : ''}`;
      host.insertAdjacentHTML('beforeend', `<div class="gp-modal" role="dialog" aria-modal="true" aria-label="${modalTitle}"><div class="gp-modal-card"><h3>${modalTitle}</h3>${content}<div class="gp-message gp-modal-message" role="status"></div><div class="gp-modal-actions">${act('modal-cancel', modal.kind === 'leave' ? '继续编辑' : '取消', busy)}${modal.kind === 'leave' ? act('leave-confirm', '放弃修改并离开', busy, 'danger') : modal.kind === 'visual' ? act('save-visual', '保存用户观察', busy, 'primary') : modal.kind === 'remove' ? act('remove-confirm', '确认移出', busy, 'danger') : `${modal.kind === 'apply' && manager.applyOperationElevated ? act('apply-elevated', '以管理员权限应用本次操作', busy || plan.blockers?.length > 0) : ''}${act('modal-apply', modal.kind === 'cleanup' ? '备份并隔离所选文件' : '应用本次变更', busy || plan.blockers?.length > 0, 'primary')}`}</div></div></div>`);
      host.querySelector('.gp-modal button')?.focus();
    }
    function updateBar() {
      const bar = host.querySelector('.gp-apply-bar'); if (bar) bar.outerHTML = footer();
      syncHeaderAction();
      const notice = host.querySelector(':scope > .gp-message');
      if (notice) { notice.textContent = message; notice.hidden = !message; notice.classList.toggle('error', error); notice.setAttribute('role', error ? 'alert' : 'status'); }
    }
    function mergeAssessment(value, section, order) {
      if (value.gameId && value.gameId !== id) throw new Error('检测结果与当前游戏不一致。');
      const currentExe = data.game?.chosen?.path?.toLowerCase(), nextExe = value.game?.chosen?.path?.toLowerCase();
      if (currentExe && nextExe && currentExe !== nextExe) throw new Error('游戏程序已改变，请收起后重新打开设置。');
      const candidate = section === 'enhancements' ? value.enhancements?.launchReadiness : section === 'installation' ? value.launch?.readiness : null;
      if (candidate?.state) {
        if (readinessEpoch !== generation || order >= readinessOrder) { readinessState = candidate; readinessEpoch = generation; readinessOrder = order; }
      }
      data = { ...data, ...value, ...(value.game ? { game: { ...data.game, ...value.game } } : {}) };
      sectionFailures.set(section, value.failures || []);
      data.failures = [...sectionFailures.values()].flat();
      if (value.launch) session = value.launch.session;
      if (value.nr && !draft.nr) faceStrength = Math.max(0, value.nr.SkinStructureStrength ?? 0);
      const initial = initialFields(data);
      for (const domain of ['sr', 'fg']) if (!draft[domain] && !invalidFields[domain]) fields[domain] = initial[domain];
    }
    async function loadSection(section, force = false) {
      if (disposed || !id) return;
      if (!force && loaded.has(section)) return;
      if (!force && sectionRequests.has(section)) return sectionRequests.get(section);
      const currentGeneration = generation, token = (sectionTokens.get(section) || 0) + 1, order = ++assessmentOrder;
      if (force) loaded.delete(section);
      sectionTokens.set(section, token);
      const task = Promise.resolve().then(() => manager.assessGame(id, { sections: [section] })).then(unwrap).then(value => {
        if (disposed || generation !== currentGeneration || sectionTokens.get(section) !== token) return;
        mergeAssessment(value, section, order);
        for (const name of value.sections || [section]) loaded.add(name);
        if (!modal) render();
      }).catch(failure => {
        if (!disposed && generation === currentGeneration && sectionTokens.get(section) === token) {
          if (section === 'installation' && order >= readinessOrder) {
            readinessState = { state: 'unknown', source: 'unavailable', known: false,
              blockers: [{ domain: 'settings', code: failure.code || 'ASSESSMENT_UNAVAILABLE', message: failure.message, action: { kind: 'open-settings' } }] };
            readinessEpoch = generation; readinessOrder = order;
          }
          message = failure.message; error = true; if (!modal) render();
        }
      }).finally(() => { if (sectionTokens.get(section) === token) sectionRequests.delete(section); });
      sectionRequests.set(section, task); return task;
    }
    async function refresh(preserve = true) {
      if (!id || disposed) return;
      // A write or an explicit recheck can change any section. Reopen unseen
      // sections lazily, and reject responses that started before this refresh.
      generation++; loaded.clear(); sectionRequests.clear();
      if (!preserve) { fields = initialFields(data); }
      const needed = new Set(['installation', TAB_SECTION[tab]]);
      if (tab === 'maintenance') needed.add('enhancements');
      await Promise.all([...needed].map(section => loadSection(section, true)));
    }
    function selectTab(next) {
      if (!Object.hasOwn(TAB_SECTION, next) || disposed || options.hoyoSettingsOnly && next === 'enhance' && !readinessNeedsAction() && tab !== 'enhance') return;
      tab = next; render();
      host.querySelector(`[data-gp-tab="${tab}"]`)?.focus({ preventScroll: true });
      void loadSection(TAB_SECTION[tab]);
      if (tab === 'maintenance') void loadSection('enhancements');
    }
    async function work(fn, success, preserve = false) {
      if (busy) return; busy = true; message = ''; error = false; render();
      try { const result = unwrap(await fn()); message = result?.notice || success || '操作已完成。'; if (!preserve) { draft = {}; fields = {}; invalidFields = {}; } modal = null; await refresh(preserve); return result; }
      catch (failure) { message = failure.message; error = true; modal = null; try { await refresh(true); } catch {} }
      finally { busy = false; render(); }
    }
    async function preview(request = draft) {
      if (busy) return; busy = true; message = ''; error = false; render();
      try {
        if (apiBlocked(request)) throw new Error('请先选择游戏实际使用的 API。');
        if (request === draft) for (const domain of ['sr', 'fg']) if (draft[domain] || invalidFields[domain]) {
          // Validate the visible values again; an earlier valid draft must not
          // survive an invalid edit and silently become the request sent out.
          draft[domain] = scope.launchSettingsUi.createRequest(domain, fields[domain]); delete invalidFields[domain];
        }
        if (request === draft && ['api', 'version', 'route', 'deployment', 'loadingMode', 'loadingBackend', 'hoyo'].some(key => Object.hasOwn(draft, key))) request = installRequest();
        modal = { kind: 'apply', plan: unwrap(await manager.previewOperation(id, request)) };
      }
      catch (failure) { message = failure.message; error = true; }
      finally { busy = false; render(); }
    }
    async function apply(elevated = false) {
      if (!modal || busy) return;
      const value = modal, allowAntiCheat = host.querySelector('[data-gp-consent]')?.checked === true;
      if (value.kind === 'apply' && (data.antiCheat?.detected || value.plan?.deployment?.requiresAntiCheat) && !allowAntiCheat) { host.querySelector('.gp-modal-message').textContent = '请先确认已了解本次游戏的反作弊提示。'; return; }
      if (value.kind === 'cleanup') {
        const names = [...host.querySelectorAll('[data-gp-clean]:checked')].map(input => input.dataset.gpClean);
        if (!names.length) { host.querySelector('.gp-modal-message').textContent = '请先选择需要隔离的文件。'; return; }
        await work(() => manager.applyEnvironmentCleanup(id, value.plan.planId, names), '所选文件已备份隔离，可撤销。');
      } else await work(() => (elevated ? manager.applyOperationElevated : manager.applyOperation)(id, value.plan.planId,
        { confirm: true, fingerprint: value.plan.fingerprint, allowAntiCheat }), '配置已应用；实际增强待游戏验证。');
      options.onChanged?.(id);
    }
    function requestLeave(callback) { if (busy) return false; callback(); return true; }
    async function open(gameId, initialTab = 'overview', seed = {}) {
      launchAttempt++; launching = false;
      generation++; id = gameId; loaded.clear(); sectionTokens.clear(); sectionRequests.clear(); sectionFailures.clear(); draft = {}; invalidFields = {};
      tab = initialTab; modal = null; message = ''; error = false; launching = false; capturingHotkey = false; faceStrength = 1;
      readinessState = null; readinessEpoch = -1; readinessOrder = -1;
      const game = seed.game || { id: gameId, name: '游戏', installed: false };
      data = { gameId, game, api: game.chosen?.apiAssessment || { effectiveApi: game.apiOverride && game.apiOverride !== 'auto' ? game.apiOverride : game.chosen?.apiResolution?.api || 'unknown' }, ...seed };
      fields = initialFields(data); render();
      await loadSection('installation');
      if (tab !== 'overview') { void loadSection(TAB_SECTION[tab]); if (tab === 'maintenance') void loadSection('enhancements'); }
    }
    function resume(game) {
      if (disposed || !data || game.id !== id) return;
      readinessState = null; readinessEpoch = -1; readinessOrder = -1; data.game = { ...data.game, ...game }; render();
      void loadSection('installation'); if (tab !== 'overview') void loadSection(TAB_SECTION[tab]);
    }
    async function launchGame() {
      if (busy || launching || dirty()) { message = '请先应用或放弃当前修改。'; error = true; render(); return; }
      const targetId = id, targetGeneration = generation, attempt = ++launchAttempt;
      launching = true; message = ''; error = false; render();
      // Collapsed library cards may retain a controller whose installation
      // snapshot was read before the card was closed. Always read this small
      // metadata section for the current launch attempt so the gate uses the
      // current readiness, while the launch lock prevents a second request.
      await loadSection('installation', true);
      if (disposed || attempt !== launchAttempt) return;
      if (id !== targetId || generation !== targetGeneration) { if (id === targetId) { launching = false; render(); } return; }
      if (busy || !launching || dirty()) { launching = false; if (dirty()) { message = '请先应用或放弃当前修改。'; error = true; } render(); return; }
      if (!loaded.has('installation')) { launching = false; render(); return; }
      if (readinessNeedsAction()) {
        launching = false;
        message = readinessMessage() || '启动前还有需要处理的设置。'; error = true; render();
        await resolveReadiness({ refresh: false });
        return;
      }
      try {
        const result = unwrap(await manager.launch(targetId));
        if (!disposed && id === targetId && attempt === launchAttempt) { session = result.launched || result; void loadSection('installation', true); }
      }
      catch (failure) { if (!disposed && id === targetId && attempt === launchAttempt) { message = failure.message; error = true; session = failure.details?.launchSession || session; } }
      finally { if (attempt === launchAttempt) { launching = false; render(); } }
    }
    function change(input) {
      const group = input.dataset.gpGroup, key = input.dataset.gpField; if (!key || input.disabled || busy) return;
      const value = input.type === 'checkbox' ? Number(input.checked) : input.type === 'number' && input.value === '' ? '' : group === 'nr' || input.type === 'range' || input.type === 'number' ? Number(input.value) : input.value;
      if (group === 'nr') {
        draft.nr = { ...(draft.nr || {}), [key]: value };
        if (value === data.nr?.[key]) delete draft.nr[key]; if (!Object.keys(draft.nr).length) delete draft.nr;
        const out = input.parentElement.querySelector('output'); if (out) out.textContent = key === 'SkinStructureStrength' && value === -1 ? '关闭' : value;
        if (key === 'SkinStructureStrength' && value >= 0) faceStrength = value;
      } else if (group === 'face') {
        const current = draft.nr?.SkinStructureStrength ?? data.nr?.SkinStructureStrength;
        if (current >= 0) faceStrength = current;
        draft.nr = { ...(draft.nr || {}), AutoMask: value };
        if (value && current < 0) draft.nr.SkinStructureStrength = 0;
        if (draft.nr.AutoMask === data.nr?.AutoMask) delete draft.nr.AutoMask;
        if (!Object.keys(draft.nr).length) delete draft.nr;
        render(); return;
      } else if (group === 'component') {
        draft.components = { ...(draft.components || {}), [key]: value };
      } else if (group === 'hoyo') {
        draft.hoyo = hoyoDraft();
        if (key === 'channel') draft.hoyo.channel = value;
        if (key === 'kind') { draft.hoyo.launcher.kind = value; draft.hoyo.launcher.path = ''; }
      } else if (group === 'input-route') {
        if (value === 'auto') delete draft.route; else draft.route = value;
        delete draft.version;
      } else if (group === 'route') {
        draft[key] = value;
        if (key === 'deployment' && value === 'local') delete draft.loadingMode;
        if (key === 'loadingBackend') {
          if (value === 'hoyoshade') { draft.hoyo = hoyoDraft(); draft.deployment = 'external'; draft.loadingMode = 'helper'; delete draft.proxyEntry; }
          else { delete draft.hoyo; delete draft.loadingMode; }
        }
        if (key === 'api') {
          delete draft.route;
          if (draft.components?.bridge && effectiveApi() !== 'dx11') { delete draft.components.bridge; if (!Object.keys(draft.components).length) delete draft.components; }
        }
      } else if (group === 'sr' || group === 'fg') {
        fields[group][key] = value;
        if (group === 'sr' && key === 'quality') {
          const ratio = { dlaa: 100, quality: 67, balanced: 59, performance: 50, ultraPerformance: 33 }[value];
          if (ratio) fields.sr.renderPercent = ratio;
        }
        try { draft[group] = scope.launchSettingsUi.createRequest(group, fields[group]); delete invalidFields[group]; }
        catch (failure) { invalidFields[group] = failure.message; }
        message = Object.values(invalidFields).join('；'); error = Boolean(message);
      }
      if (input.tagName === 'SELECT') { const field = input.dataset.gpField; render(); host.querySelector(`[data-gp-group="${group}"][data-gp-field="${field}"]`)?.focus({ preventScroll: true }); }
      else updateBar();
    }
    host.addEventListener('input', event => { if (event.target.type === 'range' || event.target.type === 'number') change(event.target); }, { signal: eventController.signal });
    host.addEventListener('change', event => {
      if (event.target.dataset.gpAddonKeep !== undefined && modal?.kind === 'apply') {
        modal.keepChanged = true;
        for (const button of host.querySelectorAll('[data-gp-action="modal-apply"],[data-gp-action="apply-elevated"]')) button.disabled = true;
        host.querySelector('.gp-modal-message').textContent = '保留选择已改变，请先重新预览。'; return;
      }
      if (!['range', 'number'].includes(event.target.type)) change(event.target);
    }, { signal: eventController.signal });
    host.addEventListener('click', async event => {
      const tabButton = event.target.closest('[data-gp-tab]'); if (tabButton) { if (!scope.GameDetailTabs) selectTab(tabButton.dataset.gpTab); return; }
      const button = event.target.closest('[data-gp-action]'); if (!button || button.disabled) return; const action = button.dataset.gpAction;
      try {
        if (action === 'back') requestLeave(() => options.onBack?.());
        else if (action === 'refresh') { message = ''; error = false; await refresh(true); if (!error) message = '已重新检查。'; render(); }
        else if (action === 'preview') await preview();
        else if (action === 'preview-sr') { draft.sr = scope.launchSettingsUi.createRequest('sr', fields.sr); delete invalidFields.sr; await preview(); }
        else if (action === 'recommend-sr') { fields.sr = scope.launchSettingsUi.initialSrFields({}, currentHardware()); draft.sr = scope.launchSettingsUi.createRequest('sr', fields.sr); delete invalidFields.sr; message = ''; error = false; render(); }
        else if (action === 'discard') { draft = {}; invalidFields = {}; fields = initialFields(data); message = '已放弃尚未应用的修改。'; error = false; render(); }
        else if (action === 'prepare') { Object.assign(draft, installRequest()); await preview(); }
        else if (action === 'resolve-readiness') await resolveReadiness();
        else if (action === 'pick-hoyo-launcher') {
          const file = unwrap(await manager.pickHoYoLauncher());
          if (file) { draft.hoyo = hoyoDraft(); draft.hoyo.launcher.path = file; render(); }
        }
        else if (action === 'repreview-addons') {
          const request = structuredClone(modal.plan.request);
          request.addonKeep = [...host.querySelectorAll('[data-gp-addon-keep]:checked')].map(input => modal.addonChoices[Number(input.dataset.gpAddonKeep)])
            .map(row => ({ path: row.path, sha256: row.sha256, configFingerprint: row.configFingerprint }));
          await preview(request);
        }
        else if (action === 'repair-install') await preview({ repair: true });
        else if (action === 'capture-hotkey') { capturingHotkey = true; render(); host.querySelector('[data-gp-action="capture-hotkey"]')?.focus(); }
        else if (action === 'panel-default') { draft.hotkeys = { reshade: { key: 36, ctrl: false, shift: false, alt: false } }; render(); }
        else if (action === 'restore-sr' || action === 'restore-fg') { const domain = action.slice(-2); fields[domain][domain === 'sr' ? 'quality' : 'mode'] = domain === 'sr' ? 'game' : 'restore'; draft[domain] = scope.launchSettingsUi.createRequest(domain, fields[domain]); delete invalidFields[domain]; message = Object.values(invalidFields).join('；'); error = Boolean(message); render(); }
        else if (action === 'reapply') { draft.reapplyExternalChanges = true; for (const domain of ['sr', 'fg']) if (data.enhancements?.applied?.[domain]?.requiresReapply) draft[domain] = data.enhancements.applied[domain].request; await preview(); }
        else if (action === 'modal-cancel') { modal = null; host.querySelector('.gp-modal')?.remove(); }
        else if (action === 'leave-confirm') { const callback = modal.callback; draft = {}; invalidFields = {}; modal = null; callback?.(); }
        else if (action === 'modal-apply' || action === 'apply-elevated') await apply(action === 'apply-elevated');
        else if (action === 'record-visual') { modal = { kind: 'visual' }; renderModal(); }
        else if (action === 'remove-game') { modal = { kind: 'remove' }; renderModal(); }
        else if (action === 'remove-confirm') {
          busy = true; render();
          try { unwrap(await manager.removeGame(id)); draft = {}; modal = null; await options.onChanged?.(id); options.onBack?.(); }
          finally { busy = false; if (modal) render(); }
        }
        else if (action === 'save-visual') {
          if (!host.querySelector('[data-gp-same-scene]').checked) { host.querySelector('.gp-modal-message').textContent = '请先完成并确认同场景开关对照。'; return; }
          const input = { sessionId: (session || data.launch?.session).sessionId, sameScene: true, result: host.querySelector('[data-gp-visual-result]').value,
            note: host.querySelector('[data-gp-visual-note]').value, evidenceLabel: host.querySelector('[data-gp-visual-evidence]').value };
          await work(() => manager.recordVisualComparison(id, input), '已保存用户观察。', true);
        }
        else if (action === 'uninstall-clean' || action === 'uninstall-restore') await preview({ uninstall: action.slice('uninstall-'.length) });
        else if (action === 'back-local') { draft.deployment = 'local'; await preview(); }
        else if (action === 'recover-operation') await work(() => manager.recoverOperation(id), '已检查并恢复未完成操作。', true);
        else if (action === 'recover-settings') await work(() => manager.recoverLaunchSettings(id), '未完成设置事务已恢复。', true);
        else if (action === 'recover-fg-components') await work(() => manager.recoverFgComponents(id), '未完成补帧组件操作已恢复。', true);
        else if (action === 'restore-environment') await work(() => manager.restoreEnvironment(id), '已恢复隔离前环境。', true);
        else if (action === 'clean-environment') { modal = { kind: 'cleanup', plan: unwrap(await (manager.previewEnvironmentCleanup || manager.prepareEnvironmentCleanup)(id)) }; renderModal(); }
        else if (action === 'open-folder') unwrap(await manager.openFolder(id));
        else if (action === 'user-addon') await work(() => manager.setUserAddon(id, button.dataset.gpComponent, button.dataset.gpEnable === 'true'), button.dataset.gpEnable === 'true' ? '用户 Add-on 已加载。' : '用户 Add-on 已移除。', true);
        else if (action === 'rename-game') options.onRename?.(id);
        else if (action === 'feedback') await manager.exportFeedback(id);
        else if (action === 'anti-cheat') unwrap(await manager.openExternal('antiCheatPolicy'));
        else if (action === 'mfg-source') unwrap(await manager.openExternal('mfgUnlockUrl'));
        else if (action === 'compatibility-search') unwrap(await manager.openExternal(`gameCompatibility:${id}`));
        else if (action === 'maintenance-tab') selectTab('maintenance');
        else if (action === 'cancel-launch') unwrap(await manager.cancelLaunch(id));
        else if (action === 'launch') await launchGame();
      } catch (failure) { message = failure.message; error = true; render(); }
    }, { signal: eventController.signal });
    host.addEventListener('keydown', event => {
      if (capturingHotkey) {
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape') { capturingHotkey = false; render(); return; }
        const binding = capturedBinding(event);
        if (binding) { draft.hotkeys = { reshade: binding }; capturingHotkey = false; message = `已录入 ${bindingLabel(binding)}，应用后生效。`; error = false; render(); }
        return;
      }
      const current = event.target.closest('[data-gp-tab]');
      if (current && !scope.GameDetailTabs && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const keys = ['overview', 'enhance', 'maintenance'], at = keys.indexOf(tab);
        selectTab(event.key === 'Home' ? keys[0] : event.key === 'End' ? keys[2] : keys[(at + (event.key === 'ArrowRight' ? 1 : 2)) % 3]);
      }
      if (event.key === 'Escape' && modal && !busy) { modal = null; host.querySelector('.gp-modal')?.remove(); }
      if (event.key === 'Tab' && modal) {
        const focusable = [...host.querySelectorAll('.gp-modal button:not([disabled]),.gp-modal input:not([disabled]),.gp-modal select:not([disabled]),.gp-modal textarea:not([disabled]),.gp-modal summary')], first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && event.target === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && event.target === last) { event.preventDefault(); first?.focus(); }
      }
    }, { signal: eventController.signal });
    if (manager.onLaunchSession) unsubscribe = manager.onLaunchSession(value => { if (!disposed && value.gameId === id) { session = value; if (!modal) render(); } });
    return { open, resume, refresh, selectTab, resolveReadiness, launchGame, requestLeave, updateLaunchReadiness, previewRepair: () => preview({ repair: true }), hasDraft: dirty, discard: () => { draft = {}; invalidFields = {}; }, getState: () => ({ id, data, draft: structuredClone(draft), fields: structuredClone(fields), tab, busy, launching, readiness: structuredClone(launchReadiness()), readinessOrder, assessmentOrder, loaded: [...loaded] }), dispose: () => { disposed = true; generation++; eventController.abort(); tabController?.dispose(); unsubscribe?.(); } };
  }
  const api = { mount, recommendedModel, initialFields };
  if (typeof module === 'object' && module.exports) module.exports = api; else scope.GamePageUi = api;
})(typeof window === 'object' ? window : globalThis);
