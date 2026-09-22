'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { noLinks, digestFile, atomicJson } = require('./launch-safety');
const { PUBLIC_NR_KEYS } = require('./constants');
const { normalizeValue } = require('./nr-config');
const { normalizeBinding } = require('./hotkeys');
const { resolveOperationApi, requiresOperationApi } = require('./operation-api');
const { MESSAGES } = require('./errors');
const policy = require('./launch-settings-policy');
const fail = (code, message, details) => { throw Object.assign(new Error(message), { code: `OPERATION_${code}`, details }); };
const clone = value => structuredClone(value);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fingerprint = ({ request, before, changes, blockers, resolved, adoption }) => hash({ request, before, resolved, ...(adoption ? { adoption } : {}),
  changes: changes.map(row => ['receipt', 'manifest', 'history-receipt'].includes(row.role) && row.afterSha256 !== null ? { ...row, afterSha256: 'generated-manager-record' } : row), blockers });
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function blockerMessages(owner) {
  return [owner?.blockers, owner?.layout?.blockers].filter(Array.isArray).flat().map(row =>
    typeof row === 'string' ? MESSAGES[row] || row : row?.message || MESSAGES[row?.code] || row?.code || '检查发现阻止项，请重新检查本游戏。');
}

function validateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['route', 'api', 'version', 'deployment', 'loadingMode', 'loadingBackend', 'proxyEntry', 'components', 'hoyo', 'addonKeep', 'adoption', 'nr', 'sr', 'fg', 'hotkeys', 'launchMode', 'uninstall', 'repair', 'reapplyExternalChanges'].includes(key))) fail('INPUT', '应用请求含未知选项。');
  const request = clone(value);
  require('./installation-adoption').validateAdoptionChoice(request.adoption);
  if (request.api !== undefined && !['auto', 'dx9', 'dx10', 'dx11', 'dx12', 'vulkan'].includes(request.api)) fail('INPUT', 'API 选择无效。');
  if (request.version !== undefined && (typeof request.version !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(request.version))) fail('INPUT', 'Core 版本无效。');
  if (request.deployment !== undefined && !['local', 'external'].includes(request.deployment)) fail('INPUT', '部署模式无效。');
  if (request.loadingMode !== undefined && !['proxy', 'helper'].includes(request.loadingMode)) fail('INPUT', '加载方式无效。');
  if (request.loadingBackend !== undefined && !['local', 'hoyoshade'].includes(request.loadingBackend)) fail('INPUT', '加载后端无效。');
  if (request.proxyEntry !== undefined && !['auto', 'dxgi', 'd3d11', 'd3d12'].includes(request.proxyEntry)) fail('INPUT', '加载入口无效。');
  if (request.components !== undefined && (!request.components || typeof request.components !== 'object' || Array.isArray(request.components) ||
    Object.keys(request.components).some(key => !['bridge', 'mfgUnlock'].includes(key)) ||
    Object.values(request.components).some(value => typeof value !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(value)))) fail('INPUT', '独立组件选择无效。');
  if (request.addonKeep !== undefined && (!Array.isArray(request.addonKeep) || request.addonKeep.length > 128 || request.addonKeep.some(row =>
    !row || Object.keys(row).some(key => !['path', 'sha256', 'configFingerprint'].includes(key)) || !path.isAbsolute(row.path || '') || row.path.includes('\0') ||
    !/^[a-f0-9]{64}$/.test(row.sha256 || '') || !/^[a-f0-9]{64}$/.test(row.configFingerprint || '')))) fail('INPUT', '插件保留选择必须绑定当前文件和配置摘要。');
  if (request.hoyo !== undefined) {
    const h = request.hoyo;
    if (!h || Object.keys(h).some(key => !['family', 'channel', 'launcher'].includes(key)) ||
      !['genshin', 'honkai3', 'starrail', 'zzz'].includes(h.family) || !['cn', 'bilibili', 'global'].includes(h.channel) ||
      !h.launcher || Object.keys(h.launcher).some(key => !['kind', 'path'].includes(key)) || !['hoyoplay', 'starward'].includes(h.launcher.kind) ||
      !path.isAbsolute(h.launcher.path || '') || !/\.exe$/i.test(h.launcher.path) || h.launcher.path.includes('\0')) fail('INPUT', '米哈游客户端或启动器绑定无效。');
  }
  if (request.route !== undefined && !['native', 'feeder', 'vulkan'].includes(request.route)) fail('INPUT', '增强路线无效。');
  if (request.launchMode !== undefined && !['auto', 'steam', 'exe'].includes(request.launchMode)) fail('INPUT', '启动方式无效。');
  if (request.reapplyExternalChanges !== undefined && typeof request.reapplyExternalChanges !== 'boolean') fail('INPUT', '重新应用选项无效。');
  if (request.nr !== undefined) {
    if (!request.nr || typeof request.nr !== 'object' || Array.isArray(request.nr) || Object.keys(request.nr).some(key => !PUBLIC_NR_KEYS.includes(key))) fail('INPUT', 'NR 参数无效。');
    for (const [key, value] of Object.entries(request.nr)) {
      request.nr[key] = normalizeValue(key, value);
    }
  }
  for (const domain of ['sr', 'fg']) if (request[domain] !== undefined) request[domain] = policy.validateRequest(domain, request[domain]);
  if (request.hotkeys !== undefined) {
    if (!request.hotkeys || typeof request.hotkeys !== 'object' || Object.keys(request.hotkeys).some(key => key !== 'reshade') || !request.hotkeys.reshade) fail('INPUT', '只支持修改受管 ReShade 面板快捷键。');
    request.hotkeys = { reshade: normalizeBinding(request.hotkeys.reshade) };
  }
  if (request.uninstall !== undefined && (!['clean', 'restore'].includes(request.uninstall) || Object.keys(request).length !== 1)) fail('INPUT', '移除必须单独选择干净移除或恢复安装前。');
  if (request.repair !== undefined && (request.repair !== true || Object.keys(request).some(key => !['repair', 'addonKeep'].includes(key)))) fail('INPUT', '修复保持已装组合，只允许同时确认插件保留选择。');
  return request;
}

function createOperationPlans({ userData, service, settings, components, fgWorkflow, environment, preparation, guards,
  applyEnhancement, restoreForUninstall, setLaunchMode, inspectLaunchMode, onChange = () => {}, onProgress = () => {} }) {
  const plans = new Map(), directory = path.join(userData, 'operation-plans');
  function target(id) {
    const exe = service.gameExecutable(id), game = service.gameDirectory(id);
    if (!path.isAbsolute(exe || '') || !path.isAbsolute(game || '')) fail('TARGET', '请先确认游戏 EXE。');
    return { id, exe, game, key: hash(path.resolve(exe).toLowerCase()) };
  }
  const ledgerFile = t => path.join(directory, `${t.key}.pending.json`);
  async function read(file) {
    await noLinks(file);
    try { const stat = await fs.stat(file); if (!stat.isFile() || stat.size > 1024 * 1024) fail('RECORD', '操作记录大小无效。'); return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function inspect(id) {
    const t = target(id), record = await read(ledgerFile(t));
    if (record && (record.version !== 1 || !same(record.exe, t.exe) || !same(record.game, t.game) || !Array.isArray(record.stages))) fail('RECORD', '未完成操作记录与当前游戏不一致。');
    return { pending: Boolean(record), record, runtimeVerified: false };
  }
  async function assertReady(id) { if ((await inspect(id)).pending) fail('RECOVERY_REQUIRED', '上次统一应用未完成，请先在维护页恢复未完成操作。'); }
  async function prepareForWaiting(id, input) {
    const request = validateRequest(input), t = target(id); await assertReady(id);
    await preparation.assertReady(id); await environment.assertReady(id); await settings.assertReady(id);
    const current = typeof service.assessmentSeed === 'function' ? await service.assessmentSeed(id) : (await service.listGames()).find(row => row.id === id);
    const api = resolveOperationApi(current, request);
    if (requiresOperationApi(request) && !api.supported) fail('API_SELECTION_REQUIRED', '请先确认游戏实际使用的图形 API。');
    if (typeof service.validateWaitingComponents !== 'function') fail('WAITING_SOURCE_UNAVAILABLE', '当前组件来源尚不能在游戏运行时核验，请退出游戏后重新应用。');
    const source = await service.validateWaitingComponents(id, request), blockers = [...blockerMessages(source)];
    if (source.ready !== true) blockers.push('所需组件尚未完成来源核验。');
    if (request.nr) {
      if (source.deployment === false) { const current = await service.readNrSettings(id); if (current.status === 'error') fail('NR_UNREADABLE', current.error?.message || '当前 NR 配置无法读取。'); }
      const contract = source.nrContract || (await service.readNrSettings(id)).contract;
      for (const [key, value] of Object.entries(request.nr)) normalizeValue(key, value, contract);
    }
    if (request.components?.mfgUnlock || request.fg && ['mfgunlock', 'dlssg-sm86'].includes(request.fg.backend) && request.fg.mode !== 'restore') {
      const component = await components.previewProvider(id, request.components?.mfgUnlock || (request.fg?.backend === 'dlssg-sm86' ? require('./fg-sm86-components').ID : null));
      blockers.push(...blockerMessages(component));
    }
    for (const domain of ['sr', 'fg']) if (request[domain]) {
      const checked = await settings.preview(id, domain, request[domain], { allowComponentPreparation: true, reapplyExternalChanges: request.reapplyExternalChanges === true });
      blockers.push(...blockerMessages(checked));
    }
    if (request.launchMode === 'steam' && !(await inspectLaunchMode(id)).steamAvailable) blockers.push('没有可验证的 Steam 安装身份。');
    if (source.deployment === true && !['feeder', 'vulkan'].includes(source.route)) {
      // Payload readiness cannot tell us whether an installed Add-on will be
      // isolated. Compile the same read-only native/profile proposal used by
      // Apply, without creating a journal or persisting an actionable plan.
      // Legacy fixed-route owners still require a closed game for their full
      // preview and retain their independently verified-source contract.
      const prepared = await preview(id, request, { readOnlyWhileRunning: true, preparationOnly: true });
      const allBlockers = [...new Set([...blockers, ...prepared.blockers])];
      return { ...prepared, source, ready: !allBlockers.length, blockers: allBlockers,
        preparationOnly: true, identity: prepared.fingerprint };
    }
    const adoption = await service.inspectInstallationAdoption?.(id, request) || null;
    blockers.push(...blockerMessages(adoption));
    return { request, ready: !blockers.length, blockers: [...new Set(blockers)], source, adoption,
      requiresAdoptionConfirmation: adoption?.required === true, identity: hash({ request, source, adoption }),
      changes: [], preparationOnly: true, runtimeVerified: false, gameId: t.id };
  }
  async function nrIdentity(t) {
    const layout = service.getLayout(t.id);
    const current = typeof service.readNrSettings === 'function' ? await service.readNrSettings(t.id).catch(error => {
      if (error.code === 'ERR_NOT_INSTALLED') return null; throw error;
    }) : null;
    const file = current?.file || path.join(layout.nrConfigDir || layout.runtimeDir || path.dirname(t.exe), 'nr_before_sr.ini');
    await noLinks(file);
    return { file, sha256: await digestFile(file) };
  }
  async function snapshot(t) {
    const layout = service.getLayout(t.id), store = service.store.read(), key = path.resolve(t.game).toLowerCase();
    const nr = await nrIdentity(t);
    const files = [...new Set([layout.activeConfigPath, nr.file,
      path.join(t.game, '_DLSS5_Backup', 'xiaofeng-manager.json'), path.join(t.game, '_DLSS5_Backup', 'xiaofeng-external.json')].filter(Boolean))];
    const identities = [];
    for (const file of files) { await noLinks(file); identities.push({ file, sha256: same(file, nr.file) ? nr.sha256 : await digestFile(file) }); }
    return { exe: t.exe, exeSha256: await digestFile(t.exe), layout: { mode: layout.mode, source: layout.source, loadingMode: layout.loadingMode, loadingBackend: layout.loadingBackend, inputRoute: layout.inputRoute, bindingId: layout.bindingId, generation: layout.generation, runtimeDir: layout.runtimeDir, activeConfigPath: layout.activeConfigPath },
      identities, nr, override: store.gameOverrides[key] || null };
  }
  async function preview(id, input, internal = {}) {
    const request = validateRequest(input), t = target(id); await assertReady(id);
    const current = typeof service.assessmentSeed === 'function' ? await service.assessmentSeed(id) :
      (await service.listGames()).find(game => game.id === id);
    if (!current) fail('TARGET', '找不到所选游戏。');
    const apiSelection = resolveOperationApi(current, request), apiDependent = requiresOperationApi(request);
    if (apiDependent && !apiSelection.supported)
      fail('API_SELECTION_REQUIRED', apiSelection.requiresManualSelection ? '需要手动选择游戏实际使用的图形 API，才能安装或应用增强设置。' : '当前图形 API 不支持所选增强路线。');
    await preparation.assertReady(id); await environment.assertReady(id); await settings.assertReady(id);
    const before = await snapshot(t), changes = [], blockers = [], steps = [];
    const routeChange = request.api !== undefined || request.version !== undefined || request.components?.bridge !== undefined;
    const deploy = !request.uninstall && !request.repair && (routeChange || request.deployment !== undefined || request.loadingMode !== undefined || request.loadingBackend !== undefined || request.hoyo !== undefined || request.route !== undefined || request.addonKeep !== undefined || request.proxyEntry !== undefined && (before.layout.mode === 'external' || before.layout.source === 'feeder'));
    const defaults = deploy && service.installationDefaults ? await service.installationDefaults(id, request) : null;
    if (deploy && (!request.proxyEntry || request.proxyEntry === 'auto') && defaults?.proxyEntry && defaults.proxyEntry !== 'auto')
      request.proxyEntry = defaults.proxyEntry;
    const installed = Boolean(current.installed || current.addonVersion || before.layout.source === 'xiaofeng-external-runtime');
    const loadingBackend = request.loadingBackend || before.layout.loadingBackend || defaults?.loadingBackend || 'local';
    const targetMode = loadingBackend === 'hoyoshade' ? 'external' : request.deployment || defaults?.deployment || (installed ? before.layout.mode || 'local' : 'local');
    const loadingMode = loadingBackend === 'hoyoshade' ? 'helper' : request.loadingMode || defaults?.loadingMode || (installed ? before.layout.loadingMode : 'proxy') || 'proxy';
    const route = request.route || (deploy && service.resolveInputRoute ? await service.resolveInputRoute(id, request) : defaults?.route);
    let retainedFg = null, retainedMfgProvider = null;
    const specialOwner = ['vulkan', 'feeder'].includes(route) || ['vulkan', 'feeder'].includes(before.layout.source) || request.api === 'vulkan';
    const changingMode = deploy && installed && !specialOwner && targetMode !== before.layout.mode;
    if (changingMode) {
      const previous = await settings.inspect(id), componentState = await components.inspect(id);
      retainedFg = previous.current?.fg?.valid ? previous.current.fg.request : previous.requests?.fg?.request || previous.applied?.fg?.request || null;
      retainedMfgProvider = componentState.installedProvider || null;
      // Restoring the old owner removes the evidence used to select its provider.
      // Bind both choices before that happens, including game-menu changes.
      before.fgMigration = { request: retainedFg, providerId: retainedMfgProvider };
      if (retainedFg || componentState.managed || componentState.receipt) {
        changes.push({ action: 'restore-fg-before-migration', path: before.layout.runtimeDir, description: '先恢复当前补帧配置和组件，再迁移，并按保留的补帧选择重新准备。' });
        steps.push({ kind: 'restore-fg' });
      }
    }
    let deployment = null;
    if (request.repair) {
      deployment = await service.previewRepair(id, request.addonKeep ? { addonKeep: request.addonKeep } : {});
      changes.push(...(deployment.changes || [])); blockers.push(...blockerMessages(deployment));
      steps.push({ kind: 'repair' });
    } else if (request.uninstall) {
      const settingsBefore = await settings.inspect(id);
      for (const domain of ['fg', 'sr']) if (settingsBefore.applied?.[domain]) {
        const previous = settingsBefore.applied[domain];
        const restore = domain === 'sr' ? { backend: previous.backend, quality: 'game' } : { backend: previous.backend, mode: 'restore' };
        const settingPlan = await settings.preview(id, domain, restore);
        changes.push(...settingPlan.operations.map(row => ({ ...row, domain, path: settingPlan.destination })));
        blockers.push(...blockerMessages(settingPlan));
      }
      deployment = await service.previewUninstall?.(id, { mode: request.uninstall }, { plannedFgRestore: true });
      changes.push(...(deployment?.changes || [{ action: request.uninstall, path: t.game, description: request.uninstall === 'clean' ? '移除摘要匹配的受管组件，保留备份且不放回旧代理。' : '恢复有原始记录的安装前文件，保留历史备份。' }]));
      blockers.push(...blockerMessages(deployment));
      steps.push({ kind: 'uninstall' });
    } else {
      if (deploy) {
        const api = apiSelection.api, special = ['feeder', 'vulkan'].includes(route);
        if (special && loadingMode === 'helper' && loadingBackend !== 'hoyoshade') fail('ROUTE', 'Vulkan 与 Feeder 使用各自的固定加载配套。');
        // Only an actual version in the request is explicit. The deployment
        // owner resolves implicit installed/global defaults and supersession.
        deployment = loadingBackend === 'hoyoshade' ? await service.previewHoYoDeployment(id, { ...request, route, api }, { plannedFgRestore: changingMode, readOnlyWhileRunning: internal.readOnlyWhileRunning === true }) :
          special ? await service.previewSpecialDeployment(id, { route, api, ...(request.version ? { version: request.version } : {}), ...(request.proxyEntry ? { proxyEntry: request.proxyEntry } : {}), ...(request.addonKeep ? { addonKeep: request.addonKeep } : {}) }) :
          await service.previewDeployment(id, { mode: targetMode, ...(request.version ? { version: request.version } : {}), api,
            loadingMode, ...(request.proxyEntry ? { proxyEntry: request.proxyEntry } : {}), ...(request.components ? { components: request.components } : {}), ...(request.addonKeep ? { addonKeep: request.addonKeep } : {}), ...(request.adoption ? { adoption: request.adoption } : {}) }, { plannedFgRestore: changingMode, readOnlyWhileRunning: internal.readOnlyWhileRunning === true });
        changes.push(...(deployment.changes || [])); blockers.push(...blockerMessages(deployment));
        steps.push({ kind: 'deployment', route, routeChange, api, version: request.version,
          resolvedVersion: deployment.version || deployment.packageId || defaults?.version || null, mode: targetMode, loadingMode, loadingBackend });
      }
      if (request.proxyEntry !== undefined && targetMode === 'local' && !['feeder', 'vulkan'].includes(route)) {
        const proxy = await service.previewProxyEntry(id, request.proxyEntry, { deployment });
        changes.push(...proxy.changes); blockers.push(...blockerMessages(proxy));
        if (proxy.changes.length) steps.push({ kind: 'proxy', entry: proxy.entry });
      }
      if (request.nr && Object.keys(request.nr).length) {
        const version = deploy ? deployment?.nrContract || deployment?.version || defaults?.version || '' :
          (await service.readNrSettings?.(id))?.contract || current.addonVersion || '';
        for (const [key, value] of Object.entries(request.nr)) request.nr[key] = normalizeValue(key, value, version);
        changes.push(...Object.entries(request.nr).map(([key, value]) => ({ action: 'set-config-key', path: '当前部署 / nr_before_sr.ini', key, value })));
        steps.push({ kind: 'nr' });
      }
      if (request.hotkeys) { changes.push({ action: 'set-config-key', path: before.layout.activeConfigPath, key: 'INPUT/KeyOverlay',
        value: [request.hotkeys.reshade.key, Number(request.hotkeys.reshade.ctrl), Number(request.hotkeys.reshade.shift), Number(request.hotkeys.reshade.alt)].join(',') }); steps.push({ kind: 'hotkeys' }); }
      let selectedFg = request.fg || retainedFg;
      const selectedMfgProvider = request.components?.mfgUnlock ||
        (selectedFg?.backend === 'mfgunlock' && selectedFg.mode !== 'restore' ? retainedMfgProvider : null);
      if (selectedMfgProvider) {
        const componentPreview = await components.previewProvider(id, selectedMfgProvider);
        changes.push(...componentPreview.files); blockers.push(...blockerMessages(componentPreview));
        if (!selectedFg) {
          const state = await settings.inspect(id);
          selectedFg = state.current?.fg?.valid ? state.current.fg.request : state.requests?.fg?.request || state.applied?.fg?.request || { backend: 'mfgunlock', mode: 'follow' };
        }
        if (selectedFg.backend !== 'mfgunlock' || selectedFg.mode === 'restore') fail('COMPONENT_MFG_ROUTE', 'MFG 插件版本需与兼容补帧设置一起应用。');
      }
      for (const domain of ['sr', 'fg']) if (request[domain] || domain === 'fg' && selectedFg) {
        const desired = domain === 'fg' ? selectedFg : request[domain];
        const preview = await settings.preview(id, domain, desired, { allowComponentPreparation: true, reapplyExternalChanges: request.reapplyExternalChanges === true });
        changes.push(...preview.operations.map(row => ({ ...row, domain, path: preview.destination })));
        if (preview.needsPreparation || preview.preparation) changes.push({ action: 'prepare-components', domain, description: '应用时一并准备并验证所需组件。' });
        blockers.push(...blockerMessages(preview));
        steps.push({ kind: domain, request: desired, preview,
          ...(domain === 'fg' && selectedMfgProvider ? { providerId: selectedMfgProvider } : {}) });
      }
      if (request.launchMode !== undefined) {
        const status = await inspectLaunchMode(id);
        if (request.launchMode === 'steam' && !status.steamAvailable) blockers.push('没有可验证的 Steam 安装身份。');
        changes.push({ action: 'set-launch-mode', value: request.launchMode, path: t.exe }); steps.push({ kind: 'launch' });
      }
    }
    let resolved = apiDependent ? { api: apiSelection.api, effectiveApi: apiSelection.effectiveApi,
      ...(deploy ? { version: deployment.version || deployment.packageId || defaults?.version || null, deployment: targetMode, loadingMode, loadingBackend, route: route || 'native',
        ...(loadingBackend === 'hoyoshade' ? { bindingId: deployment.layout?.helper?.bindingId || deployment.layout?.bindingId,
          launcherSha256: deployment.launcher?.sha256 } : {}) } : {}) } : null;
    if (deployment?.loadingBackend === 'hoyoshade') resolved = { ...resolved, loadingBackend: 'hoyoshade',
      bindingId: deployment.layout?.helper?.bindingId || deployment.layout?.bindingId, launcherSha256: deployment.launcher?.sha256 };
    const adoption = deployment?.adoption || (deploy ? await service.inspectInstallationAdoption?.(id, request) : null) || null;
    blockers.push(...blockerMessages(adoption));
    const value = { version: 1, planId: crypto.randomUUID(), gameId: id, exe: t.exe, game: t.game, request, before, resolved,
      adoption, requiresAdoptionConfirmation: adoption?.required === true,
      nrConflicts: require('./nr-conflict-summary').nrConflictSummary(request.uninstall ? null : deployment, { userData, exe: t.exe, game: t.game }),
      createdAt: Date.now(), expiresAt: Date.now() + 10 * 60000, changes, blockers: [...new Set(blockers.filter(Boolean))],
      steps, deployment, runtimeVerified: false, requiresConfirmation: true };
    value.fingerprint = fingerprint(value);
    if (internal.preparationOnly !== true) {
      plans.set(value.planId, value);
      await atomicJson(path.join(directory, `${value.planId}.preview.json`), value);
    }
    return clone(value);
  }
  async function loadPlan(planId, expectedFingerprint) {
    if (!/^[a-f0-9-]{36}$/i.test(planId || '')) fail('PLAN', '操作预览编号无效。');
    const plan = plans.get(planId) || await read(path.join(directory, `${planId}.preview.json`));
    if (!plan || plan.version !== 1 || plan.planId !== planId || plan.expiresAt < Date.now()) fail('EXPIRED', '操作预览已过期，请重新预览。');
    validateRequest(plan.request);
    if (fingerprint(plan) !== plan.fingerprint || expectedFingerprint && expectedFingerprint !== plan.fingerprint) fail('CHANGED', '操作预览身份已改变，未执行。');
    // Recompile all executable steps from the authenticated request. Never
    // execute arbitrary step names or paths supplied by a persisted JSON file.
    const fresh = await preview(plan.gameId, plan.request);
    if (fresh.fingerprint !== plan.fingerprint) fail('CHANGED', '游戏、配置或可用操作在预览后改变，请重新核对清单。');
    return fresh;
  }
  async function archive(t, record) {
    await atomicJson(path.join(directory, 'history', `${t.key}-${record.planId}.json`), record);
    await fs.unlink(ledgerFile(t));
  }
  async function apply(planId, consent = {}) {
    if (consent.confirm !== true) fail('CONFIRM', '请先核对本次具体变更清单。');
    if (!/^[a-f0-9]{64}$/.test(consent.fingerprint || '')) fail('CONFIRM', '应用必须绑定已核对的预览身份。');
    const plan = await loadPlan(planId, consent.fingerprint), t = target(plan.gameId);
    if (plan.blockers.length) fail('BLOCKED', plan.blockers.join('；'));
    await guards.assertGameClosed(t.game, t.exe);
    const record = { version: 1, planId: plan.planId, gameId: t.id, exe: t.exe, game: t.game, request: plan.request,
      before: plan.before, changes: plan.changes, startedAt: new Date().toISOString(), stages: [], status: 'applying' };
    const persist = () => atomicJson(ledgerFile(t), record);
    let expectedNr = plan.before.nr;
    await persist();
    try {
      for (const step of plan.steps) {
        await guards.assertGameClosed(t.game, t.exe);
        const stage = { kind: step.kind, status: 'started' }; record.stages.push(stage); await persist();
        onProgress({ gameId: t.id, phase: step.kind, completed: record.stages.length - 1, total: plan.steps.length });
        if (step.kind === 'deployment') {
          const special = ['feeder', 'vulkan'].includes(step.route);
          // loadPlan has just rebuilt and verified the deployment preflight.
          // Rebuild once more only if an earlier FG restore changed its files.
          const migration = record.stages.some(row => row.kind === 'restore-fg' && row.status === 'complete') ?
            (step.loadingBackend === 'hoyoshade' ? await service.previewHoYoDeployment(t.id, { ...plan.request, route: step.route, api: step.api }) :
            (special ? await service.previewSpecialDeployment(t.id, { route: step.route, api: step.api, ...(step.version ? { version: step.version } : {}) }) :
              await service.previewDeployment(t.id, { mode: step.mode, ...(step.version ? { version: step.version } : {}), api: step.api,
                ...(step.loadingMode ? { loadingMode: step.loadingMode } : {}), ...(plan.request.proxyEntry ? { proxyEntry: plan.request.proxyEntry } : {}), ...(plan.request.components ? { components: plan.request.components } : {}), ...(plan.request.addonKeep ? { addonKeep: plan.request.addonKeep } : {}) }))) : plan.deployment;
          const blocked = blockerMessages(migration); if (blocked.length) fail('BLOCKED', blocked.join('；'));
          stage.result = await (step.loadingBackend === 'hoyoshade' ? service.applyHoYoDeployment : special ? service.applySpecialDeployment : service.applyDeployment)(migration.planId, { allowAntiCheat: consent.allowAntiCheat === true });
          if (plan.request.nr) {
            const installedNr = await nrIdentity(t);
            // A new location or newly created INI gets a baseline immediately
            // after deployment. Existing INIs retain their reviewed baseline.
            if (!same(installedNr.file, expectedNr.file) || expectedNr.sha256 === null) expectedNr = installedNr;
            stage.nrIdentity = expectedNr;
          }
        } else if (step.kind === 'repair') stage.result = await service.applyRepair(plan.deployment.planId, { allowAntiCheat: consent.allowAntiCheat === true });
        else if (step.kind === 'proxy') stage.result = await service.applyProxyEntry(t.id, step.entry, { allowAntiCheat: consent.allowAntiCheat === true });
        else if (step.kind === 'nr') {
          const currentNr = await nrIdentity(t);
          if (!same(currentNr.file, expectedNr.file) || currentNr.sha256 !== expectedNr.sha256)
            fail('NR_CHANGED', '应用期间 NR 配置已在外部改变，已保留外部版本；请重新核对原选择。');
          stage.nrIdentity = expectedNr;
          stage.result = await service.writeNrSettings(t.id, plan.request.nr, { expectedFingerprint: expectedNr.sha256 });
        }
        else if (step.kind === 'hotkeys') stage.result = await service.writeGameHotkey(t.id, 'reshade', plan.request.hotkeys.reshade);
        else if (step.kind === 'restore-fg') { await settings.restore(t.id, 'fg'); stage.result = await components.restore(t.id); }
        else if (step.kind === 'sr' || step.kind === 'fg') stage.result = await applyEnhancement(t.id, step.kind, step.request, { allowAntiCheat: consent.allowAntiCheat === true, reapplyExternalChanges: plan.request.reapplyExternalChanges === true,
          ...(step.kind === 'fg' && step.providerId ? { providerId: step.providerId } : {}) });
        else if (step.kind === 'launch') stage.result = await setLaunchMode(t.id, plan.request.launchMode);
        else if (step.kind === 'uninstall') {
          await restoreForUninstall(t.id);
          stage.result = await service.uninstall(t.id, { mode: plan.request.uninstall, removeSettings: false });
        }
        stage.status = 'complete'; await persist();
      }
      record.status = 'complete'; record.completedAt = new Date().toISOString(); await persist(); await archive(t, record);
      onChange(t.id); return { applied: true, planId: record.planId, stages: record.stages, runtimeVerified: false, notice: '所选配置已应用。需要重启游戏，实际增强效果仍待本次运行确认。' };
    } catch (error) {
      record.status = 'recovery-required'; record.error = { code: error.code, message: error.message,
        completedPhases: error.details?.completedPhases || [] }; await persist();
      throw Object.assign(error, { details: { ...error.details, operationPlan: record.planId, completedStages: record.stages.filter(row => row.status === 'complete').map(row => row.kind), recoveryRequired: true } });
    }
  }
  async function recover(id) {
    const t = target(id), { record } = await inspect(id);
    await guards.assertGameClosed(t.game, t.exe);
    if (!record) {
      // Older deployments have their own journal without a unified operation
      // ledger. Their current owner still controls validation and recovery.
      const before = await service.inspectDeployment(id);
      if (!before.pending && !before.needsRecovery) return { recovered: false, runtimeVerified: false };
      const result = await service.recoverDeployment(id);
      const after = await service.inspectDeployment(id);
      if (after.pending || after.needsRecovery) fail('RECOVERY_REQUIRED', '部署仍有未完成文件事务，请先恢复该部署。');
      onChange(t.id);
      return { ...result, recovered: true, runtimeVerified: false,
        notice: result?.notice || '原部署的未完成文件事务已恢复，请核对当前配置后重新应用。' };
    }
    // Each owner verifies its own before/after digests. Completed stages remain
    // visible; recovery never claims to roll back a previous full configuration.
    await service.recoverDeployment?.(id);
    const pending = await settings.pending(id);
    if (pending.length) {
      try { await settings.recover(id); }
      catch (error) {
        if (/FG_/.test(error.code || '')) await fgWorkflow.recover(id);
        else if (/REF_/.test(error.code || '')) await service.recoverReframework(id);
        else throw error;
      }
    }
    await environment.recoverPending(id);
    if ((await preparation.inspect(id)).pending) await preparation.recover(id);
    await settings.assertReady(id); await environment.assertReady(id);
    const deployment = await service.inspectDeployment(id);
    if (deployment.needsRecovery || deployment.pending) fail('RECOVERY_REQUIRED', '部署仍有未完成文件事务，请先恢复该部署。');
    record.status = 'recovered'; record.recoveredAt = new Date().toISOString(); await archive(t, record);
    return { recovered: true, stages: record.stages, notice: '未完成文件事务已恢复；此前已完成的设置仍保留，请核对后重新应用。', runtimeVerified: false };
  }
  return { preview, apply, inspect, recover, assertReady, loadPlan, prepareForWaiting };
}
module.exports = { createOperationPlans, validateOperationRequest: validateRequest };
