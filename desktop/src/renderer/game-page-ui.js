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
  const errorText = value => `${value?.code ? `[${value.code}] ` : ''}${value?.message || value || '操作未完成。'}`;
  const option = (value, label, selected, disabled = false) => `<option value="${esc(value)}"${String(value) === String(selected) ? ' selected' : ''}${disabled ? ' disabled' : ''}>${esc(label)}</option>`;
  const badge = (status, fallback) => `<span class="badge ${['passed', 'enabled', 'configurable'].includes(status) ? 'good' : ['failed', 'bypassed', 'version-mismatch'].includes(status) ? 'bad' : ''}">${esc(STATUS[status] || fallback || status || '待确认')}</span>`;
  const line = (label, value) => `<div class="gp-fact"><span>${esc(label)}</span><strong>${esc(value ?? '待确认')}</strong></div>`;
  const sourceText = value => typeof value === 'string' ? value : value?.api || value?.value || null;
  const apiLabel = value => API[sourceText(value)] || sourceText(value) || '尚未确认';
  const hasFgComponents = assessment => ['installed', 'managed', 'receipt', 'needsRecovery', 'needsCleanup', 'fileRecoveryPending', 'fileOperationActive', 'migrationPending'].some(key => assessment?.enhancements?.fgComponents?.[key]);
  const TAB_SECTION = { overview: 'installation', nr: 'installation', enhance: 'enhancements' };
  const DETAIL_TAB = { overview: 'enhance', nr: 'graphics', enhance: 'advanced' };
  // Main picker: the catalog's recommended and stable Cores. Every other Core
  // stays under “历史版本与回退”.
  const CORE_CATALOG = scope.ManagerCoreCatalog;
  const STANDARD_CORES = CORE_CATALOG.MAIN_MENU;
  const COMPARISON_VERSION = '0.4.7beta-bg3-bridge1411';
  const coreLabel = value => String(value || '').replace(/(?:beta\s*0\.4\.7|0\.4\.7(?:-?beta)?)(?![\d.])/gi, '0.4.7beta');
  function adoptionMarkup(plan, prefix = 'gp') {
    const adoption = plan?.adoption;
    if (!adoption?.required && !plan?.requiresAdoptionConfirmation) return '';
    const hosts = adoption?.hosts || [], unknown = hosts.filter(row => row.kind === 'unknown-proxy');
    const labels = { 'addon-compatible': '可加载 Add-on 的 ReShade', 'reshade-standard': '普通 ReShade，需备份并更换', 'unknown-proxy': '来源未确认的入口' };
    return `<section class="gp-adoption"><h4>确认接管已有安装</h4><p>现有文件会按本次清单备份，个人配置保留。确认后才修改游戏；取消会保留当前草稿。</p>${hosts.map(row => `<p><strong>${esc(labels[row.kind] || '现有加载入口')}</strong><small>${esc(row.path)}</small></p>`).join('')}${adoption?.hostState === 'missing' ? '<p>发现配置或插件残留，尚未发现可用加载入口；将补齐所需文件。</p>' : ''}${unknown.length && !adoption?.replaceProxy ? `<label class="gp-field"><span>允许备份并替换的入口</span><select data-${prefix}-adoption-proxy><option value="">请选择具体文件</option>${unknown.map((row, index) => option(index, row.path, '')).join('')}</select></label><button type="button" class="button subtle" data-${prefix}-action="repreview-proxy">重新预览所选入口</button><p class="gp-caption">选择文件只生成新的替换预览，仍需再次确认应用。</p>` : ''}</section>`;
  }
  function nrConflictMarkup(plan) {
    const conflicts = plan?.nrConflicts;
    if (!conflicts?.required) return '';
    const transfers = (conflicts.files || []).filter(row => row.action === 'transfer-backup');
    return `<section class="gp-nr-conflicts"><h4>${transfers.length === conflicts.files?.length ? '隔离备份随安装迁移' : '发现 NR 组件冲突'}</h4><p>先保留冲突备份，再应用所选组件。取消会保留当前草稿。</p>${transfers.length ? `<p>隔离文件继续停用；卸载后恢复到：</p><ul>${transfers.map(row => `<li>${esc(row.restorePath)}</li>`).join('')}</ul>` : ''}<p>备份保留在以下固定目录：</p><ul>${(conflicts.backupDirectories || []).map(directory => `<li>${esc(directory)}</li>`).join('')}</ul><details><summary>冲突文件详情</summary><div class="gp-change-list">${(conflicts.files || []).map(row => `<div><strong>${esc(row.name || row.path)}</strong><span>${esc(({ 'backup-isolate': '备份并隔离', 'isolate': '备份并隔离', replace: '备份并替换', 'retire-core': '备份旧 Core', 'retire-carrier': '备份旧 NR 组件', 'transfer-backup': '迁移隔离备份' })[row.action] || row.action)}</span><small>${esc(row.path)}</small></div>`).join('')}</div></details></section>`;
  }
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
      readinessState = null, readinessEpoch = -1, readinessOrder = -1, assessmentOrder = 0, launchAttempt = 0,
      apiSave = Promise.resolve(), draftBackup = null, waitingUnsubscribe = null, progressUnsubscribe = null, configChecking = false, resumeAfterImport = null, progress = null, waitingBackupIdentity = null;
    const pageDrafts = new Map();
    const loaded = new Set(), sectionRequests = new Map(), sectionTokens = new Map(), sectionFailures = new Map();
    const draftCount = () => new Set([...Object.keys(draft), ...Object.keys(invalidFields)]).size;
    const dirty = () => draftCount() > 0;
    const draftSignature = () => JSON.stringify({ draft, invalidFields });
    const act = (name, label, disabled = false, kind = '', title = '') => `<button type="button" class="button ${kind}" data-gp-action="${name}"${title ? ` title="${esc(title)}"` : ''}${disabled ? ' disabled' : ''}>${label}</button>`;
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
      return (blocker?.message ? errorText(blocker) : '') || (info.state === 'unknown' ? '启动前状态暂时无法确认，请重新检查设置。' : '启动前还有需要处理的设置。');
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
      if (next === 'maintenance') await loadMaintenance();
      else await loadSection(TAB_SECTION[next]);
    }
    const operationApi = api => scope.ManagerOperationApi.resolveOperationApi({ ...data.game,
      operationApi:{ ...data.game.operationApi, detectedApi:data.api?.detectedApi || data.game.operationApi?.detectedApi } }, {api});
    const detectedApi = () => operationApi('auto').detectedApi;
    const effectiveApi = () => operationApi(selected('api', options.selectedApi?.() || data.game.apiOverride || data.defaults?.api || 'auto')).effectiveApi;
    const apiReady = () => ['dx9', 'dx10', 'dx11', 'dx12', 'vulkan'].includes(effectiveApi());
    const isComparison = row => row.comparisonOnly === true || row.id === COMPARISON_VERSION;
    function specialInfo(route = specialRoute()) {
      const current = data.game[route] || {}, selected = current.selections?.[effectiveApi()];
      return !current.installed && selected ? { ...current, ...selected, selectionAvailable: selected.available } : current;
    }
    function versionRows() {
      if (hoyoCoreScope()) return scope.ManagerHoYoCorePolicy.menu(data.coreVersions || [], { route: hoyoInputRoute() });
      const special = specialRoute(), info = special ? specialInfo(special) : null;
      return special ? [{ id: info.packageId || '', label: `${special === 'vulkan' ? 'Vulkan' : `${apiLabel(info.api || effectiveApi())} Feeder`} · ${info.coreVersion || '固定配套'}`, ready: info.selectionAvailable ?? info.available },
        ...(data.coreVersions || []).filter(row => CORE_CATALOG.isProviderCoreId(row.id))] : data.coreVersions || [];
    }
    function mainVersions() {
      if (hoyoCoreScope()) return versionRows();
      const installed = data.deployment?.version || data.game.addonVersion;
      return versionRows().filter(row => !isComparison(row) && (specialRoute() || STANDARD_CORES.includes(row.id) || row.id === installed || row.id === currentVersion()));
    }
    function rollbackVersions() {
      if (hoyoCoreScope()) return '';
      const rows = versionRows().filter(row => !isComparison(row) && !STANDARD_CORES.includes(row.id));
      if (specialRoute() || !rows.length) return '';
      return `<details class="gp-section gp-rollback" data-gp-detail="rollback"><summary>历史版本与回退</summary><p class="gp-caption">仅在需要回退时选择；个人画面设置会保留。</p>${selectField('route', 'version', '回退到指定 Core', option('', '选择历史版本', '') + rows.map(row => option(row.id, coreLabel(row.label || row.id), currentVersion(), row.ready === false)).join(''), busy)}</details>`;
    }
    function currentVersion() {
      if (Object.hasOwn(draft, 'version')) return draft.version || '';
      if (hoyoCoreScope()) {
        if (data.game.installed) return data.deployment?.version || data.game.addonVersion || data.game.feeder?.coreVersion || '';
        if (data.game.existingInstallation?.detected === true) return '';
        const available = versionRows().filter(row => row.ready !== false);
        return available.find(row => row.id === data.defaults?.version)?.id || available[0]?.id || '';
      }
      const special = specialRoute();
      if (special) return specialInfo(special).packageId || '';
      if (data.game.installed) return data.deployment?.version || data.game.addonVersion || data.defaults?.version || '';
      if (data.game.existingInstallation?.detected === true) return '';
      const available = (data.coreVersions || []).filter(row => row.ready !== false);
      return (STANDARD_CORES.includes(data.defaults?.version) ? data.defaults.version : null) || available.find(row => row.id === '0.4.7beta')?.id || available.find(row => STANDARD_CORES.includes(row.id))?.id || available[0]?.id || '';
    }
    function hoyoLoading() { return options.hoyoSettingsOnly === true || selected('loadingBackend', data.layout?.loadingBackend || 'local') === 'hoyoshade'; }
    function hoyoCoreScope() { return hoyoLoading() || Boolean(data.game.hoyo?.profileOptions?.length); }
    function hoyoInputRoute() {
      return draft.route && draft.route !== 'auto' ? draft.route : data.layout?.inputRoute || data.componentChoices?.stack?.route || 'auto';
    }
    function hoyoCoreReady() { return versionRows().some(row => row.id === currentVersion() && row.ready !== false); }
    function hoyoCoreNotice() {
      if (!hoyoCoreScope()) return '';
      const current = data.game.installed ? data.deployment?.version || data.game.addonVersion || data.game.feeder?.coreVersion : null;
      const unavailable = Object.hasOwn(draft, 'version') && !hoyoCoreReady();
      const reason = versionRows().find(row => row.id === currentVersion())?.reason;
      return `${current ? `<p class="gp-caption">当前安装：${esc(coreLabel(current))}。画面设置、修复和恢复仍使用此安装。</p>` : ''}${unavailable ? `<p class="gp-message">${esc(reason || '所选 Core 不在当前米哈游配套中。')}请重新选择可用版本；原草稿已保留。</p>` : ''}`;
    }
    function deploymentMode() { return hoyoLoading() ? 'external' : selected('deployment', specialRoute() ? data.layout?.mode || (specialRoute() === 'vulkan' ? 'external' : 'local') : data.game.installed ? data.layout?.mode || 'local' : data.defaults?.deployment || 'local'); }
    function hasVersionUpdate() {
      const installed = data.deployment?.version || data.game.addonVersion;
      return !specialRoute() && data.game.installed && installed && currentVersion() && installed !== currentVersion();
    }
    function installRequest() {
      if (hoyoCoreScope() && !hoyoCoreReady()) throw new Error('请重新选择当前米哈游路线可用的 Core；原草稿已保留。');
      const route = specialRoute();
      const request = { ...draft, version: currentVersion(), api: selected('api', data.game.apiOverride || data.defaults?.api || 'auto'), ...(route ? { route } : {
        deployment: deploymentMode(), ...(deploymentMode() === 'external' ? { loadingMode: selected('loadingMode', data.layout?.loadingMode || data.defaults?.loadingMode || 'proxy') } : {}) }) };
      if (hoyoLoading()) {
        Object.assign(request, { loadingBackend: 'hoyoshade', deployment: 'external', loadingMode: 'helper' });
        delete request.proxyEntry;
      }
      return request;
    }
    function apiBlocked(request = draft) {
      if (request.repair === true) return false;
      if (Object.keys(request).length && Object.keys(request).every(key => ['nr', 'hotkeys', 'launchMode'].includes(key))) return false;
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
      if (['dx9', 'dx10'].includes(api) || Number(data.game.chosen?.bitness) === 32 && data.game.feeder?.selections?.[api]?.available) return 'feeder';
      return null;
    }
    function feature(domain) { return data?.enhancements?.featureStates?.[domain] || { eligible: false, blockers: [{ message: '尚未确认此功能的支持条件。' }] }; }
    function head() {
      const tabs = [['overview', '安装与启动'], ['nr', 'NR 画面增强'], ['enhance', 'DLSS 超分与补帧']];
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
        ${(data.failures || []).length ? `<details class="gp-section"><summary>部分检查暂不可用</summary>${data.failures.map(row => `<p class="gp-caption">${esc(row.section)}：${esc(errorText(row))}</p>`).join('')}</details>` : ''}`;
    }
    function selectField(group, key, label, markup, disabled = false, note = '') {
      return `<label class="gp-field"><span>${label}</span><select data-gp-group="${group}" data-gp-field="${key}"${disabled ? ' disabled' : ''}>${markup}</select>${note ? `<small>${note}</small>` : ''}</label>`;
    }
    function nrFields() {
      const nr = { ...(data.nr || {}), ...(data.nr?.contract?.colourMemory && data.nr.effective?.ColorStrength != null ? { ColorStrength: data.nr.effective.ColorStrength } : {}), ...(draft.nr || {}) }, available = Boolean(data.game.installed && data.nr && data.nr.status !== 'error' && data.nr.readable !== false);
      if (data.nr?.capabilities?.Layer2Enabled === true) return uniformNrFields(nr, available);
      const primary = ['Intensity', 'LocalToneStrength', 'LocalStructureStrength'];
      const controls = rows => rows.filter(([key]) => data.nr?.capabilities?.[key] !== false).map(([key, label, min, max, step]) => {
          const capable = available && (!Object.hasOwn(data.nr?.capabilities || {}, key) || data.nr.capabilities[key] === true);
          if (NR_CHOICES[key]) return selectField('nr', key, label, NR_CHOICES[key].map((label, value) => option(value, label, nr[key] ?? 0)).join(''), !capable);
          const limits = data.nr?.limits?.[key] || {}, lower = limits.min === undefined ? key === 'SkinStructureStrength' ? 0 : min : Number(limits.min), upper = limits.max === undefined ? max : Number(limits.max);
          const source = data.nr?.fields?.[key];
          return `<label class="gp-field"><span>${label}</span><input type="number" min="${lower}" max="${upper}" step="any" value="${esc(nr[key] ?? '')}" data-gp-group="nr" data-gp-field="${key}"${capable ? '' : ' disabled'}>${source?.status === 'invalid' ? `<small>保存值无效：${esc(source.raw)}；请核对后修改。</small>` : source?.source === 'default' ? '<small>此键未保存，显示当前 Core 缺省值。</small>' : ''}${capable ? key === 'CustomWorkScale' ? '<small>工作模式选为“自定义”后生效。</small>' : '' : '<small>当前 Core 或配置未提供此项。</small>'}</label>`;
      }).join('');
      return `<section class="gp-section"><div class="gp-section-title"><h3>NR 画面增强</h3><label class="check-line gp-check"><input type="checkbox" data-gp-group="nr" data-gp-field="Enabled"${nr.Enabled ? ' checked' : ''}${available ? '' : ' disabled'}>开启</label></div>
        ${!available ? `<p class="gp-caption">${esc((data.nr?.error ? errorText(data.nr.error) : '') || (data.game.installed ? '当前配置或 Core 身份尚未核实，请重新检查。' : '安装后可调整画面增强。'))}</p>` : ''}
        ${effectiveApi() === 'dx9' ? '<p class="gp-caption">游戏内面板提供 NR 回填开关；完整参数在此调整，退出游戏后应用。</p>' : ''}
        <div class="gp-controls gp-nr-primary">${controls(NR.filter(([key]) => primary.includes(key)))}</div>
        ${data.nr?.contract?.dualLayer ? `<div class="gp-controls gp-dual-layer">${selectField('nr', 'NRPasses', '增强层数', option(1, '单层', nr.NRPasses) + option(2, '双层', nr.NRPasses), !available)}<details class="gp-nr-details" data-gp-detail="dual-scale"><summary>第二层工作比例 · ${esc(nr.NRSecondScaleNumerator)} / ${esc(nr.NRSecondScaleDenominator)}</summary><div class="gp-controls">${controls([['NRSecondScaleNumerator', '分子', 1, 10000, 1], ['NRSecondScaleDenominator', '分母', 1, 10000, 1]])}</div><p class="gp-caption">比例范围 1/4–1；切回单层会保留此设置。</p></details></div>` : ''}
        <div class="gp-face-control"><label class="check-line gp-check"><input type="checkbox" data-gp-group="face" data-gp-field="enabled"${nr.AutoMask ? ' checked' : ''}${available && data.nr?.capabilities?.SkinStructureStrength !== false ? '' : ' disabled'}>人脸调节</label>${nr.AutoMask ? controls([['SkinStructureStrength', '人脸强度', 0, 2, .05]]) : '<small>关闭时保留上次强度。</small>'}</div>
        <details class="gp-nr-details" data-gp-detail="nr"><summary>更多 NR 参数</summary><div class="gp-controls">${controls(NR.filter(([key]) => !primary.includes(key) && key !== 'SkinStructureStrength' && (key !== 'CustomWorkScale' || Number(nr.WorkMode) === 5)))}</div></details></section>`;
    }
    function uniformNrFields(nr, available) {
      const capable = key => available && data.nr?.capabilities?.[key] === true;
      const note = key => {
        if (Object.hasOwn(draft.nr || {}, key)) return '<small>待应用</small>';
        const field = data.nr?.fields?.[key];
        if (!field) return '<small>此项状态尚未确认</small>';
        if (field.status === 'invalid') return `<small>文件保存：${esc(field.raw)}；Core ${field.effectiveKnown ? '采用：' + esc(field.effective) : '采用值待确认'}</small>`;
        if (field.adjusted) return `<small>文件保存值；Core 采用：${esc(field.effective)}</small>`;
        if (!field.effectiveKnown) return `<small>${field.present ? '文件保存值' : '当前 Core 缺省参考'}；运行时采用值待确认</small>`;
        if (field.source === 'migration') return '<small>文件未写入；Core 将从旧层设置迁移此值</small>';
        return field.source === 'default' ? '<small>文件未写入，当前 Core 缺省值</small>' : '';
      };
      const check = (key, label) => `<label class="check-line gp-check"><input type="checkbox" data-gp-group="nr" data-gp-field="${key}"${Number(nr[key]) ? ' checked' : ''}${capable(key) ? '' : ' disabled'}>${label}${note(key)}</label>`;
      const number = (key, label, min = 0, max = 2, step = 'any') => `<label class="gp-field"><span>${label}</span><input type="number" step="${step}" min="${min}" max="${max}" value="${esc(nr[key] ?? '')}" data-gp-group="nr" data-gp-field="${key}"${capable(key) ? '' : ' disabled'}>${note(key)}</label>`;
      const choice = (key, label, choices) => selectField('nr', key, label,
        (choices.some(([value]) => String(value) === String(nr[key])) ? '' : option(nr[key], `文件保存：${nr[key] ?? '未写入'}`, nr[key], true)) +
        choices.map(([value, text]) => option(value, text, nr[key])).join(''), !capable(key), note(key));
      const model = (prefix, layer) => `<div class="gp-controls">${choice(prefix + 'Style', '画面风格', NR_CHOICES.Style.map((label, value) => [value, label]))}${number(prefix + 'Intensity', '模型强度')}</div><details class="gp-nr-details" data-gp-detail="layer-${layer}"><summary>明暗、结构与保护</summary><div class="gp-controls">${number(prefix + 'LocalToneStrength', '局部明暗')}${number(prefix + 'LocalStructureStrength', '局部结构')}${number(prefix + 'SkinStructureStrength', '皮肤强度', -1, 2)}</div><div class="gp-small-actions">${check(prefix + 'AutoMask', '原生皮肤遮罩')}${check(prefix + 'UICorrection', '文字 / UI 保护')}${act('nr-reset-layer-' + layer, '恢复本层默认', !available, 'subtle')}</div></details>`;
      return `<section class="gp-section"><div class="gp-section-title"><h3>NR 画面增强</h3>${check('Enabled', '开启')}</div>${available ? '' : '<p class="gp-caption">配置暂不可编辑，请检查安装或读取错误。</p>'}
        ${(data.nr?.warnings || []).map(row => `<p class="gp-caption">${esc(row.message)}</p>`).join('')}
        <div class="gp-controls">${number('TransferStrength', '最终增强', 1, 4)}${number('ColorStrength', 'AI 色彩')}</div>
        <section class="gp-layer"><h4>第 1 层</h4>${model('', 1)}</section>
        <details class="gp-nr-details" data-gp-detail="layers"><summary>多层增强 · 已启用 ${1 + [2, 3, 4, 5].filter(layer => nr['Layer' + layer + 'Enabled']).length} 层</summary><p class="gp-caption">停用某层会保留参数。</p>${[2, 3, 4, 5].map(layer => `<section class="gp-layer"><h4>${check('Layer' + layer + 'Enabled', '第 ' + layer + ' 层')}</h4>${nr['Layer' + layer + 'Enabled'] ? model('Layer' + layer, layer) : ''}</section>`).join('')}</details>
        <details class="gp-nr-details" data-gp-detail="nr-work"><summary>处理顺序与性能</summary><div class="gp-controls">${choice('ProcessingStart', '处理顺序', [['Before', '增强 → 放大'], ['After', '放大 → 增强'], ['Present', '自动兼容']])}
        ${choice('WorkMode', '统一工作模式', NR_CHOICES.WorkMode.map((label, value) => [value, label]))}${Number(nr.WorkMode) === 5 ? number('CustomWorkScale', '前置统一工作比例', 0, 1) : ''}${number('PostWorkPercent', '后置工作比例 %', 0, 100, 1)}${number('CompatPostPercent', '兼容工作比例 %', 50, 100, 1)}</div>
        ${capable('ColourLabMode') ? `<div class="gp-controls">${choice('ColourLabMode', '颜色策略', [[2, '保守 · 默认'], [1, '颜色优先 · 实验'], [0, '保留旧版许可设置']])}</div><p class="gp-caption">保守模式不放行未经确认的 HDR 颜色；颜色优先允许尝试。两种策略分别记住 AI 色彩强度，切换不会覆盖另一组。</p>` : ''}
        <p class="gp-caption">工作比例正常范围为 50–100%；自定义比例和后置比例设为 0 会停用增强。实际运行效果需在游戏内确认。</p>
        </details>
        <details class="gp-nr-details" data-gp-detail="nr-common"><summary>光照、细节与保护</summary><div class="gp-controls">${choice('NRInputFilter', '输入滤波', [[0, '关闭'], [1, '开启']])}${number('LightingLock', '亮度锁定', 0, 1)}${number('EdgeGuard', '边缘保护', 0, 1)}${number('DetailStability', '细节稳定', 0, 1)}${choice('LightControlMode', '光照控制', [[0, '分项光照'], [1, '整体明暗']])}${choice('LightPreset', '光照预设', [[0, '原始'], [1, '自然'], [2, '减少光晕'], [3, '自定义']])}${number('LightBroad', '整体光照')}${number('LightDark', '暗部光照')}${number('LightReflection', '反射')}${number('LightStructure', '光照结构')}${number('LightGlow', '光晕', 0, 1)}</div><div class="gp-small-actions">${check('HighStrengthProtection', '高强度保护')}${check('ColorProtection', '色彩保护')}</div></details></section>`;
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
        controls = selectField('sr', 'preset', '超分模型', option('', '保持游戏原设置', f.preset) + ['M', 'K', 'L'].map(value => option(value, `${labels[value]}${model === value ? ' · 本机推荐' : ''}`, f.preset)).join('') + option('auto', 'NVIDIA 自动选择', f.preset), !active || f.quality === 'game', f.quality === 'game' ? '应用后恢复游戏原设置。' : f.preset === 'L' ? '偏重画质，性能开销较高。' : f.preset === 'auto' ? '按 DLSS 档位自动搭配模型。' : f.preset ? `应用后使用 ${f.preset} 模型。` : '保持游戏当前模型。') +
          selectField('sr', 'quality', 'DLSS 档位', Object.entries({ preserve: '保持游戏档位，仅修改模型', game: '恢复游戏控制', dlaa: 'DLAA', quality: '质量', balanced: '平衡', performance: '性能', ultraPerformance: '超级性能', custom: '自定义比例' }).map(([key, label]) => option(key, label, f.quality, !active && key !== 'game')).join(''), !active && !allowRestore) +
          (f.quality === 'custom' ? `<label class="gp-field"><span>输入比例</span><input type="number" min="33" max="100" step="1" value="${esc(f.renderPercent)}" data-gp-group="sr" data-gp-field="renderPercent"${active ? '' : ' disabled'}><small>33–100%。</small></label>` : '');
      } else {
        const modes = info.availableModes || [], multipliers = info.availableMultipliers || [];
        const sm86 = f.backend === 'dlssg-sm86';
        controls = selectField('fg', 'mode', '补帧模式', Object.entries({ restore: '使用原有设置', follow: sm86 ? '启用 · 最多 4×' : '跟随游戏倍率', off: sm86 ? '停用此补帧组件' : '驱动关闭 FG', fixed: sm86 ? '选择倍率上限' : '固定总倍率', ...(!sm86 ? { dynamic: '动态目标帧率' } : {}) }).map(([key, label]) => option(key, label, f.mode, key !== 'restore' && (!active || !modes.includes(key)))).join(''), !active && !allowRestore) +
          (f.mode === 'fixed' ? selectField('fg', 'multiplier', sm86 ? '倍率上限' : '总帧率倍率', [2, 3, 4, 5, 6].map(value => option(value, `${value}×${multipliers.includes(value) ? '' : ' · 待确认支持'}`, f.multiplier, !multipliers.includes(value))).join(''), !active, f.backend === 'mfgunlock' ? 'MFG 使用绝对倍率，可以提高或降低游戏请求。' : '') : '') +
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
      return `<section class="gp-section"><div class="gp-section-title"><div><h3>${sr ? 'DLSS 超分' : f.backend === 'dlssg-sm86' ? 'RTX20/30 多帧生成 · 实验' : f.backend === 'mfgunlock' ? 'RTX40 补帧' : f.backend === 'nvidia' ? 'RTX50 帧生成' : '帧生成'}</h3></div>${badge(info.state || (active ? 'configurable' : 'unavailable'))}</div>
        ${reasons.length && reasons[0] !== activationText ? `<p class="gp-caption" title="${esc(reasons.join('；'))}">${esc(reasons[0])}</p>` : ''}${activationText ? `<p class="gp-caption" role="status">${esc(activationText)}</p>` : ''}${warnings.map(value => `<p class="gp-caption">${esc(value)}</p>`).join('')}
        ${domain === 'fg' && data.enhancements?.current?.fg?.source === 'active-ini' ? `<p class="gp-caption">已读取游戏内保存的当前设置${data.enhancements.current.fg.differsFromLastApplied ? '，与上次管理器请求不同' : ''}。${draft.fg ? '当前草稿保留，应用前会重新核对。' : ''}</p>` : ''}
        <div class="gp-controls">${controls}</div>${!sr && f.backend === 'dlssg-sm86' ? `<p class="gp-caption gp-fg-evidence">文件${data.enhancements?.fgComponents?.ready ? '已准备' : '尚未准备'} · 组件加载待确认 · 实际帧生成待验证</p>` : ''}${!sr && f.backend === 'dlssg-sm86' ? '<p class="gp-caption">倍率是允许的上限，实际由游戏请求决定。默认优化档 1、最多 4×；修改后重启游戏。RTX20/30 实机尚待验证。</p>' : ''}${!sr && f.backend === 'mfgunlock' ? `<details class="gp-capability-details" data-gp-detail="mfg-source"><summary>组件与游戏内菜单</summary><p class="gp-caption">游戏内菜单：ReShade → Add-ons → MFG Unlock。当前组件：${esc(data.enhancements?.fgComponents?.installedProviderDetails?.version || data.enhancements?.fgComponents?.catalog?.find(row => row.id === data.enhancements?.fgComponents?.defaultProvider)?.version || '1.0（推荐）')}；来源：mavismmg/MFGAdaUnlock-RenoDx。设置读回不等于生成帧已验证。</p><div class="gp-small-actions">${act('mfg-source', '查看开源项目', busy, 'subtle')}</div></details>` : ''}${unavailableOptions.length ? `<details class="gp-capability-details"><summary>未开放档位说明</summary>${unavailableOptions.map(row => `<p class="gp-caption"><strong>${esc(row.label)}</strong> · ${esc(row.message)}</p>`).join('')}</details>` : ''}<p class="gp-caption">${owned ? owned.readbackVerified ? '已应用，重启游戏后生效。' : '设置已变化，请重新预览。' : '尚未应用覆盖设置。'}</p>
        <div class="gp-small-actions">${sr ? act('recommend-sr', '使用推荐', busy || !active || !scope.launchSettingsUi.recommendedPreset(currentHardware()), 'subtle') : ''}${allowRestore ? act(`restore-${domain}`, '恢复原设置', busy, 'subtle') : ''}${owned?.requiresReapply ? act('reapply', '重新预览', busy) : ''}</div>${sr ? `<details class="gp-capability-details" data-gp-detail="sr-preview"><summary>查看当前设置的变更清单</summary>${act('preview-sr', '预览当前超分设置', busy || data.operation?.pending || !apiReady() || !loaded.has('enhancements') || (!feature('sr').eligible && !(fields.sr.quality === 'game' && data.enhancements?.applied?.sr)), 'subtle')}</details>` : ''}</section>`;
    }
    function componentStackOverview() {
      const saved = data.componentChoices?.stack;
      if (!saved) return '';
      const changed = Boolean(draft.api || draft.version || draft.route || draft.components?.bridge);
      if (!changed) return `<div class="gp-component-stack ${saved.status === 'ready' ? 'is-ready' : 'needs-attention'}"><div><small>自动组件搭配</small><strong>${esc(saved.title)}</strong><span>${esc(saved.summary)}</span></div><div class="gp-component-stack-items">${(saved.items || []).filter(row => row.key !== 'api').map(row => `<span class="is-${esc(row.status || 'pending')}"><b>${esc(row.label)}</b>${esc(row.value)}</span>`).join('')}</div><p>${esc(saved.reason || '')}</p></div>`;
      const api = effectiveApi(), route = selected('route', saved.route || 'auto'), version = currentVersion();
      const input = route === 'feeder' || ['dx9','dx10'].includes(api) ? 'DLSS5 Feeder' : api === 'dx11' ? 'DLSS5 Bridge' : api === 'vulkan' ? 'Vulkan 专用配套' : '游戏原生 DLSS 输入';
      const combination = CORE_CATALOG.isProviderCoreId(version)
        ? `${coreLabel(version)} + ${input} + 显卡运行库（兼容路线为实验支持）`
        : input === 'DLSS5 Feeder' ? `${input} + 专用 Core / 运行库` : input === 'Vulkan 专用配套' ? input : `${coreLabel(version || '待选 Core')} + ${input} + 显卡运行库`;
      return `<div class="gp-component-stack needs-attention"><div><small>修改后的预期搭配</small><strong>${esc(apiLabel(api))} · ${esc(input)}</strong><span>${esc(combination)}</span></div><p>预览时会重新校验 Core、接口与组件摘要；不匹配时不会写入游戏。</p></div>`;
    }
    function inputRouteControl() {
      const uncertain = (data.failures || []).some(row => row.code === 'INPUT_ROUTE_UNCONFIRMED') ||
        /INPUT_ROUTE_UNCONFIRMED/.test(message) || options.inputRouteUnconfirmed?.();
      if ((!uncertain && !draft.route) || !['dx11', 'dx12'].includes(effectiveApi())) return '';
      return `<section class="gp-section gp-input-choice"><h3>选择输入方式</h3><p class="gp-caption">${draft.route
        ? `已选择${draft.route === 'native' ? '原生 DLSS' : 'Feeder'}，将与当前 Core、API 一起应用。`
        : '尚未确认原生 DLSS 集成。游戏内有 DLSS 选项可选原生路线，也可使用 Feeder。'}</p><div class="gp-small-actions">${act('input-native', '使用原生 DLSS', busy, draft.route === 'native' ? 'primary' : 'subtle')}${act('input-feeder', '使用 Feeder', busy, draft.route === 'feeder' ? 'primary' : 'subtle')}</div></section>`;
    }
    function installation() {
      const game = data.game, api = selected('api', game.apiOverride || data.defaults?.api || 'auto'), effective = effectiveApi(), special = specialRoute();
      const existing = !game.installed && game.existingInstallation?.detected === true ? game.existingInstallation : null;
      const version = currentVersion(), visibleVersion = version === COMPARISON_VERSION ? '0.4.7beta' : version;
      const versions = mainVersions();
      const pending = data.operation?.pending || data.deployment?.needsRecovery;
      if (options.hoyoSettingsOnly) {
        const pickerRows = versions;
        const picker = `<section class="gp-section"><div class="gp-controls">${selectField('route', 'version', 'AI 增强组件',
          (pickerRows.some(row => row.id === version) ? '' : option('', '选择要安装或更换的 Core', '', true)) +
          pickerRows.map(row => option(row.id, coreLabel(row.label || row.id), version, row.ready === false)).join(''), busy || pending,
          pickerRows.find(row => row.ready === false && row.reason)?.reason || '')}</div>${hoyoCoreNotice()}</section>`;
        return `${picker}${inputRouteControl()}${options.installationContent?.() || ''}${runtimeImportControl()}<details class="gp-section" data-gp-detail="startup"><summary>启动与快捷键</summary>${startupFields()}${hotkeySection()}</details>${rollbackVersions()}${maintenancePanel()}${options.maintenanceContent?.() || ''}`;
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
        ${selectField('route', 'version', 'AI 增强组件', (!visibleVersion || hoyoCoreScope() && !versions.some(row => row.id === visibleVersion) ? option('', '请选择 AI 增强组件', '', true) : versions.some(row => row.id === visibleVersion) ? '' : option(visibleVersion, `${coreLabel(visibleVersion)} · 来源待检查`, visibleVersion, true)) + versions.map(row => option(row.id, coreLabel(row.label || row.id), visibleVersion, row.ready === false)).join(''), busy, hoyoCoreScope() ? versions.find(row => row.ready === false && row.reason)?.reason || '' : '')}</div>${hoyoCoreNotice()}
        ${CORE_CATALOG.isProviderCoreId(visibleVersion) ? '<p class="gp-caption" title="自动核对并匹配当前图形接口需要的 Bridge / Feeder；运行效果需进游戏确认。">自动搭配 Bridge / Feeder · 兼容路线为实验支持</p>' : ''}
        ${runtimeImportControl()}${inputRouteControl()}
        ${(data.failures || []).filter(row => ['operation', 'layout', 'defaults'].includes(row.section)).map(row => `<p class="gp-message error">检查未完成：${esc(errorText(row))}。处理后点击“重新检查”。</p>`).join('')}
        ${pending || readinessNotice || !apiReady() || data.layout?.needsInputPreparation || !version ? `<div class="gp-compatibility needs-attention" role="status"><span>${esc(status)}</span>${pending ? act('recover-operation', '恢复操作', busy, 'subtle') : attention && readinessActionName() !== 'resolve-readiness' ? act(readinessActionName(), readinessActionLabel(), busy, 'subtle') : ''}</div>` : ''}
        ${existing ? `<div class="gp-message"><strong>发现已有插件</strong><p>选择 Core 后应用，确认备份再替换。</p><details><summary>查看已有文件</summary><p>${esc(existingNames.join('、') || '已有插件文件')}。原件保留在 _DLSS5_Backup，未知文件会单独确认。</p></details></div>` : ''}
        ${hasVersionUpdate() ? `<p class="gp-caption">已安装 ${esc(data.deployment?.version || game.addonVersion)}，应用后更新。</p>` : ''}${proxyEntryControl()}</section>${hoyoControls()}<details class="gp-section" data-gp-detail="startup"><summary>启动与快捷键</summary>${startupFields()}${hotkeySection()}</details>${rollbackVersions()}<details class="gp-section" data-gp-detail="technical"><summary>高级设置</summary>${componentStackOverview()}${advanced()}</details>${maintenancePanel()}`;
    }
    function runtimeImportControl() {
      return manager.pickRuntimeDlc && (options.runtimeRequired?.(currentVersion()) || resumeAfterImport && error && /运行库|DLC|nvngx_dlssnr/i.test(message))
        ? `<div class="gp-small-actions">${act('import-runtime', '导入运行库 DLC', busy, 'subtle')}<small>导入后可继续应用。</small></div>` : '';
    }
    function savedProxyEntry() {
      const sources = [data.defaults?.proxyEntry, data.deployment?.proxyEntry, data.layout?.proxyEntry,
        ...(data.deployment?.proxyPaths || []), ...(data.layout?.proxyPaths || [])];
      for (const source of sources) {
        const name = String(source || '').split(/[\\/]/).pop().toLowerCase().replace(/\.dll$/, '');
        if (['dxgi', 'd3d12'].includes(name)) return name;
      }
      return 'dxgi';
    }
    function proxySwitchVisible() {
      return loaded.has('installation') && effectiveApi() === 'dx12' && !hoyoLoading() &&
        selected('loadingMode', data.layout?.loadingMode || data.defaults?.loadingMode || 'proxy') !== 'helper';
    }
    function proxyEntryControl() {
      if (!proxySwitchVisible()) return '';
      const entry = draft.proxyEntry || savedProxyEntry(), next = entry === 'd3d12' ? 'DXGI' : 'D3D12';
      return `<div class="gp-small-actions gp-proxy-entry"><span>加载入口：<strong>${entry.toUpperCase()}</strong></span><button type="button" class="button subtle" data-gp-action="switch-proxy" title="遇到 DXGI 冲突时可切换加载入口；点击应用后生效。"${busy ? ' disabled' : ''}>改用 ${next}</button></div>`;
    }
    function startupFields() {
      if (hoyoLoading()) return `<section class="gp-section gp-startup"><h3>启动设置</h3><div class="gp-controls">${selectField('route', 'deployment', '安装位置', option('external', '独立配套目录', 'external'), true)}${selectField('route', 'loadingMode', '加载方式', option('helper', '通过加载助手', 'helper'), true)}</div><p class="gp-caption">米哈游模式使用独立配套目录，由绑定的启动器和加载助手启动。</p></section>`;
      const layout = data.layout || {}, special = specialRoute(), mode = deploymentMode();
      return `<section class="gp-section gp-startup"><h3>启动设置</h3><div class="gp-controls">${selectField('route', 'launchMode', '启动方式', option('auto', '自动 · 官方启动器优先', selected('launchMode', data.launch?.selected || 'auto')) + option('steam', '通过 Steam', selected('launchMode', data.launch?.selected || 'auto'), !data.launch?.steamAvailable) + option('exe', '直接启动游戏程序', selected('launchMode', data.launch?.selected || 'auto')), busy)}${selectField('route', 'deployment', '安装位置', special ? option(mode, '此路线使用独立配套目录', mode) : option('local', '游戏目录（默认）', mode) + option('external', '独立配套目录', mode), busy || Boolean(special))}${mode === 'external' ? selectField('route', 'loadingMode', '加载方式', option('proxy', '随游戏加载', selected('loadingMode', layout.loadingMode || 'proxy')) + option('helper', '通过加载助手', selected('loadingMode', layout.loadingMode || 'proxy'), !data.game.installed), busy || Boolean(special), !data.game.installed ? '首次安装完成后可切换加载助手。' : '') : ''}</div></section>`;
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
      const special = specialRoute();
      const bridges = data.componentChoices?.bridges || [], bridge = draft.components?.bridge || data.componentChoices?.selected?.bridge;
      const userAddons = data.componentChoices?.addons || [];
      return `<section class="gp-section"><h3>高级加载</h3><div class="gp-controls">
        ${selectField('input-route', 'route', 'NR 输入方式', option('auto', '自动核对并匹配配套', draft.route || 'auto') + option('native', '原生 DLSS 输入', draft.route || 'auto', ['dx9', 'dx10'].includes(effectiveApi())) + option('feeder', 'Feeder 提供输入', draft.route || 'auto', effectiveApi() === 'vulkan'), busy, '检测依据绑定所选游戏程序与本次 API；证据不足时可手动选择输入方式。')}
        ${effectiveApi() === 'dx11' && !special && bridges.length ? selectField('component', 'bridge', 'DX11 桥接器', bridges.map(row => option(row.id, row.label, bridge, !row.ready || !row.compatible)).join(''), busy, '独立选择适配桥接器，保持 Core 版本。') : '<p class="gp-caption">当前路线无需可单独选择的 DX11 桥接器。</p>'}</div></section>
        <section class="gp-section"><h3>用户 Add-on</h3><p class="gp-caption">从组件管理导入任意 64 位 .addon64 后，可在这里按游戏加载。管理器只删除自己部署且摘要未变化的文件。</p><div class="gp-module-list">${userAddons.length ? userAddons.map(row => `<div><strong>${esc(row.label)}</strong><small>${esc(row.name)}${row.classification && row.classification !== 'unknown' ? ` · ${esc(row.classification)}` : ''}</small><small>${row.installed ? '已由管理器加载' : row.present ? '游戏中已有同名文件' : '尚未加载'}</small><button type="button" class="button ${row.installed ? 'subtle' : ''}" data-gp-action="user-addon" data-gp-component="${esc(row.id)}" data-gp-enable="${row.installed ? 'false' : 'true'}"${busy || !row.canApply || row.present && !row.installed ? ' disabled' : ''}>${row.installed ? '移除' : row.present ? '已存在' : '加载到游戏'}</button></div>`).join('') : '<p class="gp-caption">尚未导入用户 Add-on。可到“组件管理”导入 .addon64；导入不会立即修改游戏。</p>'}</div></section>
        <section class="gp-section"><h3>游戏条目</h3><p class="gp-caption">这里只修改管理器中的显示名称，不会改动游戏文件。</p><div class="gp-actions">${act('rename-game', '修改游戏名称', busy)}</div></section>`;
    }
    function deploymentChanged() {
      return error && message.includes('DEPLOYMENT_FILE_CHANGED') || readinessBlocker()?.code === 'DEPLOYMENT_FILE_CHANGED' || data.deployment?.error?.code === 'DEPLOYMENT_FILE_CHANGED' || (data.failures || []).some(row => row.code === 'DEPLOYMENT_FILE_CHANGED') ||
        (data.deployment?.blockers || []).some(row => row.code === 'DEPLOYMENT_FILE_CHANGED');
    }
    function recoveryNotice() {
      return deploymentChanged() && manager.previewDeploymentRescue ? act('maintenance-tab', '查看恢复选项', busy, 'subtle') : '';
    }
    function rescueTools() {
      const rescue = data.deployment?.rescue;
      if (!manager.previewDeploymentRescue || rescue?.available !== true) return '';
      return `<section class="gp-section gp-rescue"><h3>恢复受管环境</h3><p class="gp-caption">预览当前文件和备份位置，确认后再处理。未知路径不会修改。</p><div class="gp-actions">${rescue.pending ? act('rescue-recover', '处理未完成部署', busy) : act('rescue-repair', '修复运行目录', busy) + act('rescue-clean', '强制清理受管环境', busy, 'danger')}</div></section>`;
    }
    function removeLibraryEntry() {
      return manager.removeGame ? `<section class="gp-section"><h3>游戏库条目</h3><p class="gp-caption">只移出管理器列表，保留游戏文件和全部备份；之后可重新添加。</p>${act('remove-game', '移出游戏库', busy, 'subtle')}</section>` : '';
    }
    function maintenancePanel() {
      return `<details class="gp-section gp-maintenance-details" data-gp-detail="maintenance"><summary>维护与诊断</summary>${loaded.has('diagnostics') && loaded.has('enhancements') ? maintenance() + (options.hoyoSettingsOnly ? '' : diagnosticsContent()) : '<p class="gp-caption">展开后读取恢复记录和运行检测。</p>'}</details>`;
    }
    function maintenance() {
      const dep = data.deployment || {}, env = data.maintenance || {}, records = data.operation?.record;
      const hasSettings = Object.keys(data.enhancements?.applied || {}).length > 0 || hasFgComponents(data);
      if (options.hoyoSettingsOnly) return rescueTools() + removeLibraryEntry();
      return `${rescueTools()}<section class="gp-section" role="tabpanel" aria-label="维护与备份"><h3>恢复记录</h3><div class="gp-facts">${line('安装前基线', dep.baseline ? `${dep.baseline.version || '已记录'} · ${dep.baseline.api || ''}` : '由原安装记录保留')}
        ${line('上一完整部署', dep.previous ? `${dep.previous.version || ''} · ${dep.previous.mode || ''}` : '尚无外置切换记录')}${line('当前部署', `${dep.version || data.game.addonVersion || '未安装'} · ${dep.mode === 'external' ? '外置' : '游戏目录'}`)}
        ${line('清理归档', env.backupDirectory || (env.isolated ? '已备份隔离' : '尚无清理归档'))}</div>
        ${records ? `<div class="gp-message error"><strong>上次统一应用尚未完成</strong><p>${esc(records.error ? errorText(records.error) : '请恢复未完成事务后继续。')}</p>${(records.stages || []).map(row => `<span class="badge">${esc(row.kind)} · ${esc(row.status)}</span>`).join('')}${act('recover-operation', '恢复未完成操作', busy, 'primary')}</div>` : ''}
        ${data.enhancements?.pending?.length ? act('recover-settings', '恢复超分补帧事务', busy) : ''}${data.enhancements?.fgComponents?.fileRecoveryPending || data.enhancements?.fgComponents?.migrationPending ? act('recover-fg-components', '恢复未完成补帧组件操作', busy) : ''}${dep.needsRecovery ? act('recover-operation', '恢复部署事务', busy) : ''}
        <div class="gp-actions">${act('repair-install', '预览修复', busy || !data.game.installed || data.operation?.pending || dep.needsRecovery)}${!(data.enhancements?.fgComponents?.fileRecoveryPending || data.enhancements?.fgComponents?.migrationPending) ? act('recover-operation', '恢复未完成操作', busy || !(data.operation?.pending || dep.needsRecovery)) : ''}${act('back-local', '迁回游戏目录', busy || dep.mode !== 'external')}${act('open-folder', '打开游戏文件夹')}${act('feedback', '保存反馈与验收记录', busy)}</div></section>
        <section class="gp-section"><h3>卸载与原样恢复</h3><p class="gp-caption">每次选择本次的处理方式，预览文件后再应用。安装前备份和历史归档都会保留。</p><div class="gp-uninstall"><div><h4>干净移除</h4><p>移除摘要一致的受管文件，旧代理和旧插件继续留在备份中。</p>${act('uninstall-clean', '预览干净移除', busy || !data.game.installed, 'danger')}</div><div><h4>恢复安装前</h4><p>恢复有原始记录及摘要的文件。未知 .bak 不会自动当作原件。</p>${act('uninstall-restore', '预览恢复安装前', busy || !data.game.installed)}</div></div></section>
        <section class="gp-section"><h3>环境检查与清理</h3><p class="gp-caption">${esc(env.scope || '')}</p><div class="gp-module-list">${(env.remainingFiles || []).map(row => `<div><strong>${esc(row.name)}</strong><small>${esc(row.kind || row.classification || '需核对来源')}</small><small>${esc(row.sha256?.slice(0, 20) || '')}</small></div>`).join('') || '<p class="gp-caption">当前检查未发现额外代理或 Add-on。</p>'}</div>
        ${data.game.installed || hasSettings ? '<p class="gp-caption">请先明确移除配套并恢复超分补帧设置，再隔离剩余文件。</p>' : ''}<div class="gp-actions">${act('clean-environment', '预览剩余文件隔离', busy || data.game.installed || hasSettings || env.isolated)}${act('restore-environment', '撤销上次清理', busy || !env.canRestore || data.game.installed || hasSettings || data.operation?.pending || dep.needsRecovery, '', '卸载当前配套后可恢复')}</div></section>
        ${removeLibraryEntry()}`;
    }
    function hotkeySection() {
      return `<section class="gp-section"><h3>游戏内面板快捷键</h3><p class="gp-caption">ReShade：${esc(bindingLabel(draft.hotkeys?.reshade || data.hotkeys?.reshade))} · NR：${esc(data.hotkeys?.nr?.label || '由 Core 提供')}</p>
        <p class="gp-caption">新安装默认使用 Home；已有自定义键会保留，也可以在这里修改。</p><div class="gp-small-actions">${act('capture-hotkey', capturingHotkey ? '请按组合键 · Esc 取消' : '点击录入快捷键', busy || !data.game.installed)}${act('panel-default', '恢复默认 Home', busy || !data.game.installed)}</div></section>`;
    }
    function draftSummary() {
      const rows = [], labels = Object.fromEntries(NR.map(([key, label]) => [key, label]));
      const layerLabels = { Style: '风格', Intensity: '模型强度', LocalToneStrength: '局部明暗', LocalStructureStrength: '结构', SkinStructureStrength: '皮肤强度', UICorrection: 'UI 保护', AutoMask: '皮肤遮罩', Enabled: '启用' };
      for (const [key, value] of Object.entries(draft)) {
        if (key === 'nr') for (const [name, next] of Object.entries(value)) {
          if (/Configured$|^StrengthConfigVersion$|^PostTransferStrength$/.test(name)) continue;
          const layer = /^Layer([2-5])(.+)$/.exec(name), label = layer ? `第 ${layer[1]} 层 · ${layerLabels[layer[2]] || layer[2]}` : labels[name] || ({ ProcessingStart: '处理顺序', TransferStrength: '最终增强', ColorStrength: 'AI 色彩', PostWorkPercent: '后置比例', CompatPostPercent: '兼容比例' })[name] || name;
          rows.push(`${label}：${data.nr?.[name] ?? '未保存'} → ${next}`);
        } else if (key === 'version') rows.push(`Core：${coreLabel(data.game.addonVersion || '') || '未安装'} → ${coreLabel(value)}`);
        else if (key === 'proxyEntry') rows.push(`加载入口：${savedProxyEntry().toUpperCase()} → ${String(value).toUpperCase()}`);
        else if (key === 'api') rows.push(`图形接口：${apiLabel(value)}`);
        else if (key === 'sr') rows.push(`超分：${({ preserve: '保持档位', game: '恢复游戏控制', dlaa: 'DLAA', quality: '质量', balanced: '平衡', performance: '性能', ultraPerformance: '超级性能', custom: '自定义比例' })[value.quality] || value.quality} · ${value.preset || '保持模型'}`);
        else if (key === 'fg') rows.push(`补帧：${({ restore: '恢复原设置', follow: '跟随游戏', fixed: '设置倍率', off: '停用', dynamic: '动态目标' })[value.mode] || value.mode}${value.multiplier ? ' · ' + value.multiplier + '×' : ''}`);
        else rows.push(({ route: '更新输入路线', deployment: '更新安装位置', loadingMode: '更新加载方式', loadingBackend: '更新加载组件', components: '更新组件搭配', hotkeys: '更新快捷键', hoyo: '更新启动设置' })[key] || '更新其他设置');
      }
      return rows.length ? `<details class="gp-draft-summary" data-gp-detail="draft-summary"><summary>本次改动 · ${rows.length} 项</summary><ul>${rows.map(row => `<li>${esc(row)}</li>`).join('')}</ul></details>` : '';
    }
    function actionState() {
      const invalid = Object.keys(invalidFields).length > 0;
      const pending = Boolean(data.operation?.pending || data.deployment?.needsRecovery || data.enhancements?.pending?.length);
      const waiting = data.waiting?.pending === true;
      const locked = busy || launching;
      let action = 'launch', label = '启动', disabled = locked;
      if (pending) { action = data.enhancements?.pending?.length ? 'recover-settings' : 'recover-operation'; label = '恢复未完成操作'; }
      else if (waiting) { action = 'cancel-waiting'; label = '取消等待'; }
      else if (!dirty() && data.waiting?.requiresReview && data.waiting?.draftBackup && draftBackup) { action = 'restore-draft-backup'; label = '核对待应用修改'; }
      else if (dirty() && Object.keys(draft).every(key => ['sr', 'fg', 'reapplyExternalChanges'].includes(key))) {
        action = 'preview'; label = '应用'; disabled ||= invalid || apiBlocked();
      }
      else if (options.preparationRequired?.() && !Object.keys(draft).some(key => ['nr', 'sr', 'fg', 'hotkeys'].includes(key))) {
        action = 'prepare'; label = '应用'; disabled ||= !loaded.has('installation') || !currentVersion();
      }
      else if (!data.game.installed) {
        action = 'prepare'; label = '应用';
        disabled ||= !loaded.has('installation') || !apiReady() || !currentVersion() || versionRows().find(row => row.id === currentVersion())?.ready === false;
      } else if (dirty()) { action = 'preview'; label = '应用'; disabled ||= invalid || apiBlocked(); }
      else if (hasVersionUpdate() || data.layout?.needsInputPreparation || data.deployment?.verified === false && data.deployment?.inspection !== 'summary') {
        action = hasVersionUpdate() ? 'prepare' : 'repair-install'; label = '应用'; disabled ||= !loaded.has('installation') || !apiReady();
      } else if (readinessNeedsAction()) { action = readinessActionName(); label = readinessActionLabel(); disabled ||= !loaded.has('installation'); }
      if (hoyoCoreScope() && (action === 'prepare' || action === 'preview' && ['version', 'api', 'route', 'deployment', 'loadingMode', 'loadingBackend', 'hoyo'].some(key => Object.hasOwn(draft, key)))) disabled ||= !hoyoCoreReady();
      if (launching) label = '等待游戏…';
      return { action, label, disabled, pending, waiting, dirty: dirty(), busy, launching, readiness: launchReadiness(), readinessOrder };
    }
    function footer() {
      const state = actionState(), invalid = Object.keys(invalidFields).length > 0;
      const launchState = session || data.launch?.session, launch = launchState?.historical ? null : launchState;
      const readinessNotice = readinessNeedsNotice();
      const phases = { deployment: '备份并更新组件', nr: '保存并回读画质设置', sr: '应用超分设置', fg: '准备并应用补帧', hotkeys: '保存快捷键', proxy: '切换加载入口', launch: '保存启动方式', 'restore-fg': '恢复旧补帧组件', repair: '修复组件', uninstall: '恢复文件' };
      const status = busy ? progress ? `${phases[progress.phase] || '正在处理'} · ${progress.completed + 1}/${progress.total}` : '正在检查本次修改…' : state.waiting ? '等待游戏退出' : invalid ? '请先修正输入' : dirty() ? `${draftCount()} 组修改待应用` : state.pending ? '有未完成操作' : readinessNeedsAction() ? '启动前需要处理' : readinessNotice ? '启动时检查设置' : LAUNCH[launch?.status] || (data.game.installed ? '设置已就绪' : data.game.existingInstallation?.detected ? '已有安装待确认' : '确认设置后应用');
      const detail = (data.waiting?.message && (state.waiting || data.waiting.requiresReview) ? `<small>${esc(data.waiting.message)}</small>` : dirty() ? '' : readinessNotice ? `<small>${esc(readinessMessage())}</small>` : launch?.status === 'waiting-launcher' && launch.launchInstruction ? `<small>${esc(launch.launchInstruction)}</small>` : '') + draftSummary();
      return `<div class="gp-apply-bar${dirty() ? ' is-dirty' : readinessNotice ? ' needs-attention' : ''}" aria-label="当前游戏操作"><div role="status"><strong>${esc(status)}</strong>${detail}</div><div class="gp-main-actions">${dirty() ? act('discard', '放弃修改', busy, 'subtle') : act('refresh', '重新检查', busy, 'subtle')}${draftBackup && state.action !== 'restore-draft-backup' ? act('restore-draft-backup', '恢复原草稿', busy, 'subtle') : ''}${act(state.action, state.label, state.disabled, 'primary')}${launching ? act('cancel-launch', '取消启动等待', false, 'subtle') : ''}${act('back', '收起', false, 'subtle')}</div></div>`;
    }
    function syncHeaderAction() {
      const card = host.closest('.game-card'), start = card?.querySelector('.unified-launch-btn'), state = actionState();
      card?.classList.toggle('has-pending-draft', dirty());
      options.onActionState?.({ ...state, hasPrimary: true });
      if (!start) return;
      start.disabled = state.disabled || state.waiting || state.pending || card.classList.contains('expanded') && state.action !== 'launch';
      start.textContent = state.label;
      start.hidden = card.classList.contains('expanded');
      start.classList.toggle('primary', !start.hidden);
    }
    async function runPrimary() {
      if (busy || launching) return;
      await loadSection('installation', true);
      const state = actionState();
      if (state.disabled || state.waiting || state.pending) return;
      if (state.action === 'prepare') await prepare();
      else if (state.action === 'preview') await preview();
      else if (state.action === 'restore-draft-backup') host.querySelector('[data-gp-action="restore-draft-backup"]')?.click();
      else if (state.action === 'repair-install') await preview({ repair: true });
      else if (state.action === 'launch') await launchGame();
      else await resolveReadiness({ refresh: false });
    }
    async function prepare() {
      if (hoyoCoreScope() && !hoyoCoreReady()) { message = '请重新选择当前米哈游路线可用的 Core；原草稿已保留。'; error = true; render(); return; }
      if (options.onPrepare && options.preparationRequired?.()) return options.onPrepare({ version: currentVersion(),
        ...(['native', 'feeder'].includes(draft.route) ? { route: draft.route } : {}) });
      Object.assign(draft, installRequest()); await preview();
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
      const notice = `<div class="gp-message${error ? ' error' : ''}" role="${error ? 'alert' : 'status'}"${message || deploymentChanged() ? '' : ' hidden'}>${esc(message)}${recoveryNotice()}</div>`;
      host.innerHTML = options.maintenanceOnly ? notice + (loaded.has('diagnostics') && loaded.has('enhancements') ? maintenance() : '<p class="gp-caption" role="status">正在读取维护记录…</p>') : footer() + head() + notice + ['overview', 'nr', 'enhance'].map(key => `<div class="detail-panel" data-detail-panel="${DETAIL_TAB[key]}" role="tabpanel"${tab === key ? '' : ' hidden'}>${tab === key ? key === 'overview' ? installation() : key === 'nr' ? nrFields() : enhancements() : ''}</div>`).join('');
      if (!options.maintenanceOnly) syncHeaderAction(); else options.onActionState?.({ busy });
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
      const modalTitle = plan?.nrConflicts?.required ? '确认备份冲突并应用' : ({ leave: '离开前处理修改', visual: '本次画面对照记录', cleanup: '备份隔离文件预览', remove: '移出游戏库', rescue: ({ repair: '修复运行目录预览', clean: '清理受管环境预览', recover: '恢复未完成部署预览' })[plan?.mode] })[modal.kind] || '本次操作预览';
      const content = modal.kind === 'remove' ? '<p>只将此游戏移出管理器列表，不会卸载或删除文件。确认后放弃未应用草稿，游戏文件和全部备份保留，之后可以重新添加。</p>' : modal.kind === 'leave' ? '<p>当前修改尚未应用。离开后可放弃这些修改。</p>' : modal.kind === 'visual' ?
        '<p>记录绑定本次游戏程序、会话和 Core 摘要。来源会标为用户观察，NR 成功状态仍独立核对。</p><label class="check-line gp-check"><input type="checkbox" data-gp-same-scene>我已完成同场景、相同设置下的增强开关对照</label><label class="gp-field"><span>观察结果</span><select data-gp-visual-result><option value="uncertain">暂时无法确认</option><option value="changed">观察到画面变化</option><option value="unchanged">没有观察到画面变化</option></select></label><label class="gp-field"><span>观察说明</span><textarea data-gp-visual-note maxlength="2000" rows="3" placeholder="例如同一存档位置的人脸、材质或光照变化"></textarea></label><label class="gp-field"><span>F8 / ColorDiag 或截图材料名称（可选）</span><input data-gp-visual-evidence maxlength="240"></label>' : modal.kind === 'cleanup'
        ? `<p>${esc(plan.scope)}</p>${plan.candidates.map(row => `<label class="gp-file-choice"><input type="checkbox" data-gp-clean="${esc(row.name)}"${row.selectedByDefault ? ' checked' : ''}${row.selectable ? '' : ' disabled'}><span><strong>${esc(row.name)}</strong><small>${esc(row.kind)} · ${esc(row.note)}</small><small>${esc(row.sha256)}</small></span></label>`).join('')}`
        : `${modal.kind === 'rescue' ? `<p>${esc(plan.scope || '')}</p>${plan.archiveDirectory ? `<p>备份目录：${esc(plan.archiveDirectory)}</p>` : ''}${(plan.warnings || []).map(row => `<p class="gp-caption">${esc(errorText(row))}</p>`).join('')}` : adoptionMarkup(plan) + nrConflictMarkup(plan)}<p>核对本次变更；操作过程中请保持游戏关闭。</p>${plan.nrConflicts?.required ? '<details><summary>完整变更清单</summary>' : ''}<div class="gp-change-list">${(plan.changes || []).map(row => `<div><strong>${esc(row.name || row.key || row.domain || row.action)}</strong><span>${esc(({ create: '新增', replace: '替换', remove: '移除', keep: '保留', 'set-config-key': '写入配置', 'set-launch-mode': '修改启动方式', archive: '备份隔离', backup: '备份', isolate: '备份隔离', restore: '恢复' })[row.action] || row.description || row.action)}${row.value !== undefined ? ` → ${esc(row.value)}` : ''}</span><small>${esc(row.path || '')}</small>${row.beforeSha256 !== undefined ? `<details><summary>核验摘要</summary><small>变更前 ${esc(row.beforeSha256 || '不存在')}<br>变更后 ${esc(row.afterSha256 || '移除')}</small></details>` : ''}</div>`).join('')}</div>
        ${plan.nrConflicts?.required ? '</details>' : ''}
        ${modal.addonChoices.length ? `<section class="gp-section"><h4>未知插件保留选择</h4><p class="gp-caption">默认备份隔离。确认需要保留的插件后，重新预览当前组合。</p>${modal.addonChoices.map((row, index) => `<label class="gp-file-choice"><input type="checkbox" data-gp-addon-keep="${index}"${row.explicitKeep ? ' checked' : ''}><span><strong>保留 ${esc(row.name)}</strong><small>${esc(row.path)}</small></span></label>`).join('')}${act('repreview-addons', '按保留选择重新预览', busy)}</section>` : ''}
        ${(plan.blockers || []).map(row => `<p class="gp-message error">${esc(errorText(row))}</p>`).join('')}
        ${(modal.kind === 'rescue' ? plan.requiresAntiCheat : data.antiCheat?.detected || plan.deployment?.requiresAntiCheat) ? '<label class="check-line gp-check"><input type="checkbox" data-gp-consent>我已了解反作弊可能阻止加载及账号风险，并决定应用。</label>' : ''}`;
      host.insertAdjacentHTML('beforeend', `<div class="gp-modal" role="dialog" aria-modal="true" aria-label="${modalTitle}"><div class="gp-modal-card"><h3>${modalTitle}</h3>${content}<div class="gp-message gp-modal-message" role="status">${error ? esc(message) : ''}</div><div class="gp-modal-actions">${act('modal-cancel', modal.kind === 'leave' ? '继续编辑' : '取消', busy)}${modal.kind === 'leave' ? act('leave-confirm', '放弃修改并离开', busy, 'danger') : modal.kind === 'visual' ? act('save-visual', '保存用户观察', busy, 'primary') : modal.kind === 'remove' ? act('remove-confirm', '确认移出', busy, 'danger') : `${modal.kind === 'apply' && manager.applyOperationElevated ? act('apply-elevated', '以管理员权限应用本次操作', busy || plan.blockers?.length > 0) : ''}${act('modal-apply', modal.kind === 'cleanup' ? '备份并隔离所选文件' : plan.nrConflicts?.required ? '备份冲突并应用' : '应用本次变更', busy || plan.blockers?.length > 0, 'primary')}`}</div></div></div>`);
      host.querySelector('.gp-modal button')?.focus();
    }
    function updateBar() {
      const bar = host.querySelector('.gp-apply-bar'); if (bar) bar.outerHTML = footer();
      syncHeaderAction();
      const notice = host.querySelector(':scope > .gp-message');
      if (notice) { notice.innerHTML = esc(message) + recoveryNotice(); notice.hidden = !message && !deploymentChanged(); notice.classList.toggle('error', error); notice.setAttribute('role', error ? 'alert' : 'status'); }
    }
    function keepDraftBackup(reason) {
      draftBackup = { draft: structuredClone(draft), fields: structuredClone(fields), reason };
      try { scope.localStorage?.setItem('manager-draft-backup:' + id, JSON.stringify(draftBackup)); } catch {}
    }
    function externalConfiguration(value) {
      const signature = nr => nr?.fingerprint || JSON.stringify(nr?.saved || Object.fromEntries(Object.entries(nr || {}).filter(([, v]) => typeof v === 'number' || typeof v === 'string')));
      const nrChanged = value.nr && data.nr && signature(value.nr) !== signature(data.nr);
      const affectedNr = nrChanged ? Object.keys(draft.nr || {}).filter(key => value.nr.readable === false || JSON.stringify(value.nr.contract) !== JSON.stringify(data.nr.contract) || value.nr[key] !== data.nr[key]) : [];
      const fgChanged = value.enhancements?.current?.fg && data.enhancements?.current?.fg && JSON.stringify(value.enhancements.current.fg.request) !== JSON.stringify(data.enhancements.current.fg.request);
      if (nrChanged || fgChanged) resumeAfterImport = null;
      if (affectedNr.length || fgChanged && draft.fg) {
        keepDraftBackup('外部配置已改变');
        for (const key of affectedNr) { delete draft.nr[key]; delete invalidFields['nr:' + key]; }
        if (draft.nr && !Object.keys(draft.nr).length) delete draft.nr;
        if (fgChanged) { delete draft.fg; delete invalidFields.fg; }
        message = '已读取外部最新配置；未应用修改已保留为可恢复草稿。'; error = false;
      }
    }
    async function checkCurrentConfiguration() {
      if (disposed || busy || configChecking || !id || !data?.game?.installed || !manager.readNrSettings || host.hidden || !host.isConnected) return;
      const gameId = id, epoch = generation; configChecking = true;
      try {
        const nr = unwrap(await manager.readNrSettings(gameId));
        if (disposed || gameId !== id || epoch !== generation) return;
        const previous = JSON.stringify(data.nr); externalConfiguration({ nr }); data.nr = nr;
        if (previous !== JSON.stringify(nr) && !modal) render();
      } catch (failure) { message = errorText(failure); error = true; updateBar(); }
      finally { configChecking = false; }
    }
    function mergeAssessment(value, section, order) {
      if (value.gameId && value.gameId !== id) throw new Error('检测结果与当前游戏不一致。');
      const currentExe = data.game?.chosen?.path?.toLowerCase(), nextExe = value.game?.chosen?.path?.toLowerCase();
      if (currentExe && nextExe && currentExe !== nextExe) throw new Error('游戏程序已改变，请收起后重新打开设置。');
      const candidate = section === 'enhancements' ? value.enhancements?.launchReadiness : section === 'installation' ? value.launch?.readiness : null;
      if (candidate?.state) {
        if (readinessEpoch !== generation || order >= readinessOrder) { readinessState = candidate; readinessEpoch = generation; readinessOrder = order; }
      }
      externalConfiguration(value);
      data = { ...data, ...value, ...(value.game ? { game: { ...data.game, ...value.game } } : {}) };
      const waitingIdentity = value.waiting?.draftBackup ? JSON.stringify([value.waiting.acceptedAt, value.waiting.draftBackup]) : null;
      if (waitingIdentity && waitingIdentity !== waitingBackupIdentity) {
        waitingBackupIdentity = waitingIdentity;
        draftBackup = { draft: structuredClone(value.waiting.draftBackup), reason: value.waiting.message };
        try { scope.localStorage?.setItem('manager-draft-backup:' + id, JSON.stringify(draftBackup)); } catch {}
      }
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
          message = errorText(failure); error = true; if (!modal) render();
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
      if (options.maintenanceOnly || host.querySelector('[data-gp-detail="maintenance"][open]')) { needed.add('diagnostics'); needed.add('enhancements'); }
      await Promise.all([...needed].map(section => loadSection(section, true)));
    }
    async function loadMaintenance() {
      await Promise.all([loadSection('diagnostics'), loadSection('enhancements')]);
    }
    host.addEventListener('toggle', event => {
      if (event.target.matches?.('[data-gp-detail="maintenance"]') && event.target.open) void loadMaintenance();
    }, { capture: true, signal: eventController.signal });
    function selectTab(next) {
      if (next === 'maintenance') { tab = 'overview'; render(); const details = host.querySelector('[data-gp-detail="maintenance"]'); if (details) details.open = true; void loadMaintenance(); return; }
      if (!Object.hasOwn(TAB_SECTION, next) || disposed) return;
      tab = next; render();
      host.querySelector(`[data-gp-tab="${tab}"]`)?.focus({ preventScroll: true });
      void loadSection(TAB_SECTION[tab]);
      if (tab === 'maintenance') void loadSection('enhancements');
    }
    async function work(fn, success, preserve = false) {
      if (busy) return; busy = true; message = ''; error = false; render();
      const gameId = id;
      try { const result = unwrap(await fn()); if (disposed || id !== gameId) return result; message = result?.notice || success || '操作已完成。'; if (!preserve) { draft = {}; fields = {}; invalidFields = {}; pageDrafts.delete(gameId); } modal = null; await refresh(preserve); return result; }
      catch (failure) { if (id === gameId) { message = errorText(failure); error = true; modal = null; try { await refresh(true); } catch {} } }
      finally { if (id === gameId) { busy = false; render(); } }
    }
    async function preview(request = draft) {
      if (busy) return; busy = true; progress = null; message = ''; error = false; render();
      const gameId = id;
      try {
        if (request === draft && Object.keys(invalidFields).some(key => key.startsWith('nr:'))) throw new Error(Object.values(invalidFields).join('；'));
        if (apiBlocked(request)) throw new Error('请先选择游戏实际使用的 API。');
        if (request === draft) for (const domain of ['sr', 'fg']) if (draft[domain] || invalidFields[domain]) {
          // Validate the visible values again; an earlier valid draft must not
          // survive an invalid edit and silently become the request sent out.
          draft[domain] = scope.launchSettingsUi.createRequest(domain, fields[domain]); delete invalidFields[domain];
        }
        if (request === draft && ['api', 'version', 'route', 'deployment', 'loadingMode', 'loadingBackend', 'hoyo'].some(key => Object.hasOwn(draft, key))) request = installRequest();
        await apiSave;
        if (disposed || id !== gameId) return;
        request = structuredClone(request);
        resumeAfterImport = { gameId, request, draftSignature: draftSignature() };
        if (manager.requestOperation && !request.uninstall && !request.repair) {
          const result = unwrap(await manager.requestOperation(gameId, request, { allowAntiCheat: false }));
          if (disposed || id !== gameId) return;
          if (result.needsAttention || result.confirmationRequired) modal = { kind: 'apply', plan: result.plan };
          else {
            draft = {}; invalidFields = {}; fields = {}; modal = null; resumeAfterImport = null; pageDrafts.delete(gameId);
            message = result.notice || '配置已应用。'; await refresh(false); await options.onChanged?.(gameId);
          }
        } else modal = { kind: 'apply', plan: unwrap(await manager.previewOperation(id, request)) };
      }
      catch (failure) { if (id === gameId) { message = errorText(failure); error = true; } }
      finally { if (id === gameId) { busy = false; render(); } }
    }
    async function apply(elevated = false) {
      if (!modal || busy) return;
      const value = modal, allowAntiCheat = host.querySelector('[data-gp-consent]')?.checked === true;
      if ((value.kind === 'rescue' ? value.plan?.requiresAntiCheat : value.kind === 'apply' && (data.antiCheat?.detected || value.plan?.deployment?.requiresAntiCheat)) && !allowAntiCheat) { host.querySelector('.gp-modal-message').textContent = '请先确认已了解本次游戏的反作弊提示。'; return; }
      if (value.kind === 'rescue') {
        await work(() => manager.applyDeploymentRescue(id, value.plan.planId, { confirm: true, allowAntiCheat }), '受管环境已处理，可重新检查当前状态。', true);
      } else if (value.kind === 'cleanup') {
        const names = [...host.querySelectorAll('[data-gp-clean]:checked')].map(input => input.dataset.gpClean);
        if (!names.length) { host.querySelector('.gp-modal-message').textContent = '请先选择需要隔离的文件。'; return; }
        await work(() => manager.applyEnvironmentCleanup(id, value.plan.planId, names), '所选文件已备份隔离，可撤销。');
      } else await work(() => (elevated ? manager.applyOperationElevated : manager.applyOperation)(id, value.plan.planId,
        { confirm: true, fingerprint: value.plan.fingerprint, allowAntiCheat }), '配置已应用；实际增强待游戏验证。');
      options.onChanged?.(id);
    }
    function requestLeave(callback) { if (dirty()) pageDrafts.set(id, { draft: structuredClone(draft), fields: structuredClone(fields), invalidFields: { ...invalidFields } }); callback(); return true; }
    async function open(gameId, initialTab = 'overview', seed = {}) {
      if (id && dirty()) pageDrafts.set(id, { draft: structuredClone(draft), fields: structuredClone(fields), invalidFields: { ...invalidFields } });
      launchAttempt++; launching = false;
      generation++; id = gameId; resumeAfterImport = null; waitingBackupIdentity = null; loaded.clear(); sectionTokens.clear(); sectionRequests.clear(); sectionFailures.clear(); draft = {}; invalidFields = {};
      tab = initialTab === 'maintenance' ? 'overview' : Object.hasOwn(TAB_SECTION, initialTab) ? initialTab : 'overview'; modal = null; message = ''; error = false; busy = false; launching = false; capturingHotkey = false; faceStrength = 1;
      readinessState = null; readinessEpoch = -1; readinessOrder = -1;
      const game = seed.game || { id: gameId, name: '游戏', installed: false };
      data = { gameId, game, api: game.chosen?.apiAssessment || { effectiveApi: game.apiOverride && game.apiOverride !== 'auto' ? game.apiOverride : game.chosen?.apiResolution?.api || 'unknown' }, ...seed };
      try { draftBackup = JSON.parse(scope.localStorage?.getItem('manager-draft-backup:' + id) || 'null'); } catch { draftBackup = null; }
      fields = initialFields(data);
      const savedDraft = pageDrafts.get(id); if (savedDraft) { draft = savedDraft.draft; fields = savedDraft.fields; invalidFields = savedDraft.invalidFields; }
      render();
      await loadSection('installation');
      if (options.maintenanceOnly) await loadMaintenance();
      else if (initialTab === 'maintenance') selectTab('maintenance');
      if (tab !== 'overview') { void loadSection(TAB_SECTION[tab]); if (tab === 'maintenance') void loadSection('enhancements'); }
    }
    function resume(game) {
      if (disposed || !data || game.id !== id) return;
      readinessState = null; readinessEpoch = -1; readinessOrder = -1; data.game = { ...data.game, ...game }; render();
      void loadSection('installation'); if (tab !== 'overview') void loadSection(TAB_SECTION[tab]);
    }
    async function launchGame() {
      if (busy || launching || dirty() || data.waiting?.pending || data.operation?.pending || data.deployment?.needsRecovery) { message = '请先应用或放弃当前修改。'; error = true; render(); return; }
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
      if (data.waiting?.pending || data.operation?.pending || data.deployment?.needsRecovery || !data.game.installed) { launching = false; message = data.waiting?.pending ? '正在等待游戏退出，请先取消等待再启动。' : '请先完成安装或恢复未完成操作。'; error = true; render(); return; }
      if (readinessNeedsAction()) {
        launching = false;
        message = readinessMessage() || '启动前还有需要处理的设置。'; error = true; render();
        await resolveReadiness({ refresh: false });
        return;
      }
      try {
        const result = options.onLaunch ? await options.onLaunch(targetId) : unwrap(await manager.launch(targetId));
        if (!disposed && id === targetId && attempt === launchAttempt) { session = result.launched || result; void loadSection('installation', true); }
      }
      catch (failure) { if (!disposed && id === targetId && attempt === launchAttempt) { message = errorText(failure); error = true; session = failure.details?.launchSession || session; } }
      finally { if (attempt === launchAttempt) { launching = false; render(); } }
    }
    function change(input) {
      const group = input.dataset.gpGroup, key = input.dataset.gpField; if (!key || input.disabled || busy) return;
      if (group === 'route' && key === 'version' && !input.value) return;
      resumeAfterImport = null;
      const value = input.type === 'checkbox' ? Number(input.checked) : input.type === 'number' && input.value === '' ? '' : group === 'nr' && key !== 'ProcessingStart' || input.type === 'range' || input.type === 'number' ? Number(input.value) : input.value;
      if (group === 'nr') {
        const invalidKey = 'nr:' + key;
        if (input.type === 'number' && (input.value === '' || !Number.isFinite(value) || !input.validity.valid)) {
          invalidFields[invalidKey] = `${input.closest('label')?.querySelector('span')?.textContent || key}：请输入 ${input.min}～${input.max} 范围内的有效数值。`;
          input.setAttribute('aria-invalid', 'true');
        } else { delete invalidFields[invalidKey]; input.removeAttribute('aria-invalid'); }
        message = Object.values(invalidFields).join('；'); error = Boolean(message);
        if (data.nr?.capabilities?.ColourLabMode && ['ColourLabMode', 'ColorStrength'].includes(key)) {
          const current = { ...data.nr.effective, ...draft.nr };
          const mode = key === 'ColourLabMode' ? value : current.ColourLabMode;
          const bank = mode === 1 || mode === 0 && current.AllowUnverifiedHdrColor ? 'ColourPriorityStrength' : 'ColourConservativeStrength';
          draft.nr = { ...draft.nr, [key]: value,
            [bank]: key === 'ColorStrength' ? value : current[bank],
            ColorStrength: key === 'ColorStrength' ? value : current[bank] };
          if (key === 'ColourLabMode') render(); else updateBar();
          return;
        }
        draft.nr = { ...(draft.nr || {}), [key]: value };
        if (value === data.nr?.[key]) delete draft.nr[key]; if (!Object.keys(draft.nr).length) delete draft.nr;
        const out = input.parentElement.querySelector('output'); if (out) out.textContent = key === 'SkinStructureStrength' && value === -1 ? '关闭' : value;
        if (key === 'SkinStructureStrength' && value >= 0) faceStrength = value;
        if (data.nr?.capabilities?.Layer2Enabled === true && key === 'TransferStrength') draft.nr = { ...(draft.nr || {}), TransferStrength: value, PostTransferStrength: value, StrengthConfigVersion: 1 };
        if (/^Layer[2-5]Enabled$/.test(key)) {
          const layer = Number(key[5]); draft.nr ||= {};
          for (let n = value ? 2 : layer; n <= (value ? layer : 5); n++) {
            draft.nr[`Layer${n}Enabled`] = value;
            if (value) draft.nr[`Layer${n}Configured`] = 1;
          }
          render(); return;
        }
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
        const version = currentVersion();
        if (value === 'auto') delete draft.route; else draft.route = value;
        if (version) draft.version = version;
      } else if (group === 'route') {
        draft[key] = value;
        if (key === 'deployment' && value === 'local') delete draft.loadingMode;
        if (key === 'loadingBackend') {
          if (value === 'hoyoshade') { draft.hoyo = hoyoDraft(); draft.deployment = 'external'; draft.loadingMode = 'helper'; delete draft.proxyEntry; }
          else { delete draft.hoyo; delete draft.loadingMode; }
        }
        if (key === 'api') {
          if (manager.setGameApiPreference) {
            const gameId = id, epoch = generation;
            apiSave = apiSave.catch(() => {}).then(async () => {
              unwrap(await manager.setGameApiPreference(gameId, value));
              if (disposed || gameId !== id || epoch !== generation) return;
              data.game.apiOverride = value;
              if (!data.game.installed) delete draft.api;
              message = 'API 已记住，可继续准备组件或应用设置。'; error = false;
              await loadSection('installation', true);
            }).catch(failure => { if (gameId === id) { message = errorText(failure); error = true; render(); } throw failure; });
            void apiSave.catch(() => {});
          }
          delete draft.route;
          if (effectiveApi() !== 'dx12') delete draft.proxyEntry;
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
        else if (/^nr-reset-layer-[1-5]$/.test(action)) {
          const layer = Number(action.at(-1)), prefix = layer === 1 ? '' : `Layer${layer}`;
          for (const [key, value] of Object.entries({ Intensity: 1.5, LocalToneStrength: 1, LocalStructureStrength: 1, SkinStructureStrength: .4, AutoMask: 1, Style: 0, UICorrection: 1 })) {
            draft.nr = { ...draft.nr, [prefix + key]: data.nr.defaults?.[prefix + key] ?? value };
          }
          if (layer > 1) draft.nr[`${prefix}Configured`] = 1;
          message = `第 ${layer} 层已恢复默认草稿，应用后生效。`; render();
        }
        else if (action === 'preview-sr') { draft.sr = scope.launchSettingsUi.createRequest('sr', fields.sr); delete invalidFields.sr; await preview(); }
        else if (action === 'recommend-sr') { fields.sr = scope.launchSettingsUi.initialSrFields({}, currentHardware()); draft.sr = scope.launchSettingsUi.createRequest('sr', fields.sr); delete invalidFields.sr; message = ''; error = false; render(); }
        else if (action === 'cancel-waiting') await work(() => manager.cancelWaitingOperation(id), '已取消等待。', true);
        else if (action === 'import-runtime') {
          const gameId = id, epoch = generation, resume = resumeAfterImport;
          const result = unwrap(await manager.pickRuntimeDlc());
          if (result && !disposed && id === gameId && generation === epoch) {
            modal = null; message = result.message || '运行库已准备。';
            if (result.state) scope.dispatchEvent?.(new CustomEvent('manager-components-changed', { detail: result.state }));
            await refresh(true);
            if (disposed || id !== gameId || generation !== epoch + 1) return;
            await options.onComponentsChanged?.(result);
            if (disposed || id !== gameId) return;
            await options.onChanged?.(gameId);
            if (!disposed && id === gameId && resume?.gameId === gameId && resumeAfterImport === resume && resume.draftSignature === draftSignature()) await preview(resume.request);
          }
        }
        else if (action === 'restore-draft-backup') { if (draftBackup) {
          resumeAfterImport = null; draft = structuredClone(draftBackup.draft || {}); invalidFields = {};
          fields = { ...initialFields(data), ...structuredClone(draftBackup.fields || {}) };
          if (draft.sr) fields.sr = scope.launchSettingsUi.initialSrFields({ requests: { sr: { request: draft.sr } } }, currentHardware());
          if (draft.fg) fields.fg = { backend: draft.fg.backend, mode: 'restore', multiplier: 2, targetFps: 0, ...draft.fg };
          message = '已恢复草稿；再次应用后才会写入。'; error = false; render();
        } }
        else if (action === 'discard') { resumeAfterImport = null; draft = {}; invalidFields = {}; fields = initialFields(data); message = '已放弃尚未应用的修改。'; error = false; render(); }
        else if (action === 'switch-proxy') { if (!busy && proxySwitchVisible()) { draft.proxyEntry = (draft.proxyEntry || savedProxyEntry()) === 'd3d12' ? 'dxgi' : 'd3d12'; message = '加载入口已暂存，点击应用后生效。'; error = false; render(); } }
        else if (action === 'input-native' || action === 'input-feeder') {
          const version = currentVersion();
          if (version) draft.version = version;
          draft.route = action === 'input-native' ? 'native' : 'feeder';
          message = '输入方式已暂存，点击应用后一起生效。'; error = false; render();
        }
        else if (action === 'prepare') await prepare();
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
        else if (action === 'repreview-proxy') {
          const choice = host.querySelector('[data-gp-adoption-proxy]')?.value;
          const selected = choice === '' || choice === undefined ? null : modal?.plan?.adoption?.hosts?.filter(row => row.kind === 'unknown-proxy')[Number(choice)];
          if (!selected) { host.querySelector('.gp-modal-message').textContent = '请先选择允许备份替换的具体入口。'; return; }
          const request = structuredClone(modal.plan.request);
          request.adoption = { replaceProxy: { path: selected.path, sha256: selected.sha256, configFingerprint: modal.plan.adoption.configFingerprint } };
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
        else if (/^rescue-(repair|clean|recover)$/.test(action)) {
          const gameId = id;
          busy = true; modal = null; message = ''; error = false; render();
          try {
            const plan = unwrap(await manager.previewDeploymentRescue(gameId, action.slice(7)));
            if (!disposed && id === gameId) modal = { kind: 'rescue', plan };
          } catch (failure) { if (!disposed && id === gameId) { message = errorText(failure); error = true; } }
          finally { if (!disposed && id === gameId) { busy = false; render(); } }
        }
        else if (action === 'remove-game') { modal = { kind: 'remove' }; renderModal(); }
        else if (action === 'remove-confirm') {
          busy = true; render();
          try { unwrap(await manager.removeGame(id, { keepFiles: true, confirm: true })); draft = {}; fields = {}; invalidFields = {}; draftBackup = null; pageDrafts.delete(id); scope.localStorage?.removeItem('manager-draft-backup:' + id); modal = null; if (options.onRemoved) await options.onRemoved(id); else { await options.onChanged?.(id); options.onBack?.(); } }
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
      } catch (failure) { message = errorText(failure); error = true; render(); }
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
        event.preventDefault(); const keys = ['overview', 'nr', 'enhance'], at = keys.indexOf(tab);
        selectTab(event.key === 'Home' ? keys[0] : event.key === 'End' ? keys[2] : keys[(at + (event.key === 'ArrowRight' ? 1 : 2)) % 3]);
      }
      if (event.key === 'Escape' && modal && !busy) { modal = null; host.querySelector('.gp-modal')?.remove(); }
      if (event.key === 'Tab' && modal) {
        const focusable = [...host.querySelectorAll('.gp-modal button:not([disabled]),.gp-modal input:not([disabled]),.gp-modal select:not([disabled]),.gp-modal textarea:not([disabled]),.gp-modal summary')], first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && event.target === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && event.target === last) { event.preventDefault(); first?.focus(); }
      }
    }, { signal: eventController.signal });
    scope.addEventListener?.('focus', () => { void checkCurrentConfiguration(); if (!disposed && !busy && id && host.isConnected && !host.hidden && loaded.has('enhancements')) void loadSection('enhancements', true); }, { signal: eventController.signal });
    const configTimer = setInterval(() => { void checkCurrentConfiguration(); }, 3000); configTimer.unref?.();
    if (manager.onWaitingOperation) waitingUnsubscribe = manager.onWaitingOperation(value => { if (!disposed && value.gameId === id) { data.waiting = { ...data.waiting, ...value }; message = value.message; render(); void refresh(true); } });
    if (manager.onOperationProgress) progressUnsubscribe = manager.onOperationProgress(value => { if (!disposed && value.gameId === id) { progress = value; updateBar(); } });
    if (manager.onLaunchSession) unsubscribe = manager.onLaunchSession(value => { if (!disposed && value.gameId === id) { session = value; if (!modal) render(); } });
    return { open, resume, refresh, refreshView: () => { if (data) render(); }, selectTab, runPrimary, resolveReadiness, launchGame, requestLeave, updateLaunchReadiness, previewRepair: () => preview({ repair: true }), hasDraft: dirty, discard: () => { draft = {}; invalidFields = {}; }, getState: () => ({ id, data, action: data ? actionState() : null, draft: structuredClone(draft), fields: structuredClone(fields), tab, busy, launching, readiness: structuredClone(launchReadiness()), readinessOrder, assessmentOrder, loaded: [...loaded] }), dispose: () => { disposed = true; generation++; eventController.abort(); clearInterval(configTimer); waitingUnsubscribe?.(); progressUnsubscribe?.(); tabController?.dispose(); unsubscribe?.(); } };
  }
  const api = { mount, recommendedModel, initialFields, adoptionMarkup, nrConflictMarkup };
  if (typeof module === 'object' && module.exports) module.exports = api; else scope.GamePageUi = api;
})(typeof window === 'object' ? window : globalThis);
