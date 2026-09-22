'use strict';

function installHoYoMock() {
  const clone = value => structuredClone(value), ok = value => ({ ok: true, value: clone(value) }), game = window.__gpMock.assessments['fixture-hoyo'];
  game.game.hoyoManaged = true;
  game.coreVersions.push({ id: '0.5-dline21-unified5', label: '0.5 Unified5 · verified fixture', ready: true, supportsPresent: true });
  const launchers = [{ id: 'launcher-one', kind: 'hoyoplay', path: 'C:\\UI-fixture\\HoYoPlay\\launcher.exe' }, { id: 'launcher-two', kind: 'starward', path: 'C:\\UI-fixture\\Starward\\Starward.exe' }];
  const mock = window.__hoyoMock = { calls: [], requiresAntiCheat: false, flow: { id: 'client-one', gameId: 'fixture-hoyo', name: '崩坏：星穹铁道', exePath: game.game.chosen.path,
    gameRoot: game.game.dir, family: 'starrail', channel: null, channelLabel: '客户端待确认', gameVersion: '4.3.0',
    api: { api: null, source: 'ambiguous', requiresConfirmation: true, evidence: [] },
    binding: { status: 'needs-confirmation', launcher: null, launchers, channels: [{ channel: 'cn', channelLabel: '国服' }, { channel: 'global', channelLabel: '国际服' }] },
    installation: { installed: false, ready: false, needsRecovery: false, error: null }, phase: 'binding', nextAction: 'bind', session: null,
    verification: { helper: { state: 'unverified' }, reshade: { state: 'unverified' }, core: { state: 'unverified' }, nr: { state: 'unverified' } }, error: null, busy: false } };
  const api = window.manager;
  api.hoyoDiscover = async () => { mock.calls.push(['discover']); return ok({ games: [mock.flow, ...(mock.extraFlow ? [mock.extraFlow] : [])], launchers, warnings: [] }); };
  api.hoyoInspect = async (id, options) => { mock.calls.push(['inspect', id, clone(options)]); return ok(id === mock.extraFlow?.id ? mock.extraFlow : mock.flow); };
  api.hoyoPickGame = async () => { mock.calls.push(['pick-game']); return ok({ cancelled: true }); };
  api.hoyoPickLauncher = async id => { mock.calls.push(['pick-launcher', id]); mock.flow.binding.launcher = launchers[0]; return ok(mock.flow); };
  api.hoyoBind = async (id, value) => {
    mock.calls.push(['bind', id, clone(value)]);
    if (value.launcherId) mock.flow.binding.launcher = launchers.find(row => row.id === value.launcherId);
    if (value.channel) { mock.flow.channel = value.channel; mock.flow.channelLabel = value.channel === 'cn' ? '国服' : '国际服'; }
    if (value.api) { mock.flow.api = { api: value.api, source: 'user', requiresConfirmation: false, evidence: [] }; game.api.effectiveApi = game.api.detectedApi = game.game.chosen.apiResolution.api = value.api;
      if (mock.flow.installation.installed) mock.flow.installation.ready = false; }
    mock.flow.binding.status = 'confirmed'; mock.flow.phase = value.api ? 'install' : 'api'; mock.flow.nextAction = value.api ? 'preview-install' : 'select-api'; return ok(mock.flow);
  };
  const pickRuntime = api.pickRuntimeDlc;
  api.pickRuntimeDlc = async () => { if (!mock.runtimeMissing) return pickRuntime(); mock.calls.push(['import-runtime']); mock.runtimeMissing = false; return ok({ message: '已导入运行库 DLC' }); };
  api.hoyoPreview = async (id, action, options = {}) => { mock.calls.push(['preview', id, action, clone(options)]); mock.previewAction = action; mock.previewRequest = clone(options);
    if (mock.runtimeMissing) return { ok: false, error: { code: 'ERR_PAYLOAD_MISSING', message: '请先导入运行库 DLC' } };
    return ok({ planId: 'hoyo-plan-1', fingerprint: 'f'.repeat(64), gameId: 'fixture-hoyo', request: clone(options),
    changes: [{ name: 'ReShade', action: 'create', path: 'C:\\UI-fixture\\independent-profile\\ReShade64.dll' }, { name: 'Core 0.4.7beta', action: 'create' }, { name: 'NR 配置', action: 'create' }], blockers: [], requiresElevation: true, requiresAntiCheat: mock.requiresAntiCheat, flow: mock.flow }); };
  api.hoyoApply = async (id, plan, consent) => {
    mock.calls.push(['apply', id, plan, clone(consent)]); const action = mock.previewAction;
    if (mock.applyGate) await mock.applyGate;
    if (action === 'restore') { mock.flow.phase = 'install'; mock.flow.nextAction = 'preview-install'; mock.flow.installation = { installed: false, ready: false, needsRecovery: false, error: null }; game.game.installed = false; return ok(mock.flow); }
    mock.flow.phase = 'ready'; mock.flow.nextAction = 'start'; mock.flow.installation = { installed: true, ready: true, needsRecovery: false, error: null };
    game.game.installed = true; game.game.addonVersion = mock.previewRequest?.version || '0.4.7beta'; game.deployment.version = game.game.addonVersion; game.nr = clone(window.__gpMock.baseline.nr);
    game.game.feeder = { ...game.game.feeder, packageId: game.game.addonVersion, coreVersion: game.game.addonVersion };
    game.layout = { ...clone(window.__gpMock.baseline.layout), loadingBackend: 'hoyoshade', inputRoute: 'feeder' }; return ok(mock.flow);
  };
  api.hoyoStart = async id => { mock.calls.push(['start', id]); mock.flow.phase = 'waiting-helper'; mock.flow.nextAction = 'wait'; mock.flow.session = { status: 'waiting-helper', gameId: 'fixture-hoyo' }; return ok(mock.flow); };
  api.hoyoCancel = async id => { mock.calls.push(['cancel', id]); mock.flow.phase = 'ready'; mock.flow.nextAction = 'start'; mock.flow.session = null; return ok(mock.flow); };
  api.hoyoRecover = async id => { mock.calls.push(['recover', id]); mock.flow.error = null; mock.flow.installation.error = null; mock.flow.installation.needsRecovery = false;
    mock.flow.phase = 'ready'; mock.flow.nextAction = 'start'; mock.flow.installation.ready = true; return ok(mock.flow); };
}

async function smokeHoYo(options = {}) {
  const mock = window.__hoyoMock, gp = window.__gpMock, delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let assertions = 0;
  const assert = (value, message) => { assertions++; if (!value) throw Error(message); };
  const until = async (predicate, label, timeout = 6500) => { const start = performance.now(); while (performance.now() - start < timeout) { if (predicate()) return; await delay(20); } throw Error('HoYo UI timeout: ' + label); };
  const host = () => document.getElementById('hoyoWorkspace'), button = action => host().querySelector(action === 'prepare' ? '.hoyo-settings-host [data-gp-action="prepare"]' : `[data-hoyo-action="${action}"]`);
  const click = action => { if (!button(action)) host().querySelector('[data-gp-tab="overview"]')?.click(); const node = button(action); assert(node && !node.disabled, 'available HoYo action ' + action);
    const details = node.closest('details'); if (details && !details.open) details.querySelector('summary').click(); node.click(); };
  const field = key => host().querySelector(`[data-hoyo-field="${key}"]`);
  const set = (key, value) => { assert(field(key) && !field(key).disabled, 'available HoYo field ' + key); field(key).value = value; field(key).dispatchEvent(new Event('change', { bubbles: true })); };
  const primary = () => [...host().querySelectorAll('.game-card .primary')].filter(row => row.getClientRects().length);
  const count = name => mock.calls.filter(row => row[0] === name).length;
  await until(() => document.querySelector('.game-card'), 'library ready');
  assert(!document.querySelector('.game-card[data-id="fixture-hoyo"]'), 'managed HoYo clients are excluded from ordinary games');
  document.querySelector('[data-view="hoyo"]').click(); await until(() => button('bind'), 'discovery and binding');
  assert(document.getElementById('pageTitle').textContent === '米哈游' && primary().length === 1 && button('bind').disabled, 'separate view exposes only the unresolved binding step');
  assert(host().querySelector('.game-list .game-card.expanded .game-card-head .game-meta') && host().querySelector('.game-detail.gp-inline .gp-apply-bar') && !host().querySelector('.hoyo-workspace,.hoyo-clients,.hoyo-settings-modal'), 'HoYo reuses the library card and inline operation layout without a second master-detail UI');
  const navigationIcon = getComputedStyle(document.querySelector('.nav-icon-hoyo'));
  assert(navigationIcon.getPropertyValue('--nav-icon').includes('phosphor/crown-simple.svg') && navigationIcon.maskImage.includes('phosphor/crown-simple-fill.svg'), 'HoYo navigation retains a crown identity and uses the new active fill icon');
  set('launcherId', 'launcher-two'); set('channel', 'global'); click('bind'); await until(() => field('api'), 'API confirmation');
  assert(mock.calls.find(row => row[0] === 'bind')[2].launcherId === 'launcher-two' && mock.flow.binding.launcher.kind === 'starward', 'the exact chosen launcher remains bound');
  assert(button('bind').disabled, 'ambiguous API is not silently defaulted'); set('api', 'dx11'); click('bind'); await until(() => button('prepare') && !button('prepare').disabled, 'shared install step');
  assert(!host().querySelector('[data-hoyo-field]') && primary().length === 1, 'completed choices collapse into the next single operation');
  const initialEditor = host().querySelector('.hoyo-settings-host');
  assert([...initialEditor.querySelectorAll('[role="tab"]')].map(row => row.textContent).join('|') === '安装与启动|NR 画面增强|DLSS 超分与补帧', 'first installation already exposes the same three pages');
  initialEditor.querySelector('[data-gp-tab="enhance"]').click();
  await until(() => initialEditor.querySelector('[data-gp-group="sr"][data-gp-field="quality"]:not([disabled])'), 'independent SR before Core installation');
  const srQuality = initialEditor.querySelector('[data-gp-group="sr"][data-gp-field="quality"]');
  srQuality.value = 'quality'; srQuality.dispatchEvent(new Event('change', { bubbles: true }));
  const srApply = initialEditor.querySelector('[data-gp-action="preview"]');
  assert(srApply && !srApply.disabled && !button('prepare'), 'an SR-only draft uses the shared Apply without forcing first Core installation');
  srApply.click(); await until(() => initialEditor.querySelector('[data-gp-action="modal-apply"]'), 'independent SR preview');
  assert(Object.keys(gp.plan.request).join(',') === 'sr' && count('preview') === 0, 'independent SR preview keeps the existing settings transaction and does not call HoYo installation');
  initialEditor.querySelector('[data-gp-action="modal-apply"]').click();
  await until(() => !initialEditor.__gpController.getState().busy && !initialEditor.querySelector('.gp-modal'), 'independent SR applied');
  assert(!gp.assessments['fixture-hoyo'].game.installed && !mock.flow.installation.installed && count('apply') === 0 && count('start') === 0, 'SR application does not install Core or launch the client');
  initialEditor.querySelector('[data-gp-tab="overview"]').click();
  mock.runtimeMissing = true; click('prepare');
  await until(() => host().querySelector('[data-gp-action="import-runtime"]:not([disabled])'), 'first-install DLC guidance without an earlier draft');
  assert(initialEditor.__gpController.hasDraft() === false && count('apply') === 0 && count('start') === 0, 'missing first-install DLC leaves a clean uninstalled state');
  host().querySelector('[data-gp-action="import-runtime"]').click(); await until(() => button('apply'), 'first-install DLC resumes the HoYo preview');
  assert(count('import-runtime') === 1 && count('apply') === 0 && count('start') === 0, 'DLC import continues to confirmation without auto-install or launch');
  click('close-plan');
  assert(!initialEditor.querySelector('[data-gp-action="import-runtime"]'), 'successful DLC preparation removes the stale import prompt');
  const core = initialEditor.querySelector('[data-gp-group="route"][data-gp-field="version"]');
  assert(core && [...core.options].some(row => row.value === '0.5-dline21-unified5' && !row.disabled), 'verified Core candidate is selectable before first installation');
  core.value = '0.5-dline21-unified5'; core.dispatchEvent(new Event('change', { bubbles: true }));
  click('prepare'); await until(() => button('apply'), 'preview dialog');
  assert(mock.calls.filter(row => row[0] === 'preview').at(-1)[3].version === '0.5-dline21-unified5' && count('apply') === 0 && count('start') === 0, 'the first-install Core choice reaches the existing HoYo preview without installing or launching');
  assert(host().querySelectorAll('.gp-modal .primary').length === 1 && host().querySelector('.gp-modal').textContent.includes('Windows 权限确认'), 'elevated preview retains one explicit Apply button');
  assert(!host().querySelector('[data-hoyo-consent]'), 'an ordinary preview does not add an unrelated protection prompt');
  click('close-plan'); assert(count('apply') === 0 && initialEditor.__gpController.getState().draft.version === '0.5-dline21-unified5', 'preview cancel never installs and retains the selected Core'); mock.requiresAntiCheat = true; click('prepare'); await until(() => button('apply'), 'second preview'); click('apply');
  assert(count('apply') === 0 && host().querySelector('.hoyo-plan-message')?.hidden === false, 'a requested protection acknowledgement must be checked before Apply');
  host().querySelector('[data-hoyo-consent]').checked = true;
  let releaseInstall; mock.applyGate = new Promise(resolve => { releaseInstall = resolve; }); click('apply');
  assert(button('working')?.disabled && button('working').textContent === '正在应用安装…' && host().querySelector('.hoyo-next-step strong').textContent === '正在应用安装…', 'a pending installation replaces the old step and button with its actual operation');
  await delay(60); assert(!button('start') && primary().length === 1 && host().querySelector('.hoyo-next-step').textContent.includes('本次操作正在执行'), 'pending install keeps one disabled operation until its promise settles');
  releaseInstall(); mock.applyGate = null;
  await until(() => button('start') && !button('start').disabled, 'ready after explicit apply');
  assert(count('start') === 0 && gp.assessments['fixture-hoyo'].game.addonVersion === '0.5-dline21-unified5', 'explicit installation reads back the selected Core and never auto-launches');
  assert(count('apply') === 1 && mock.calls.find(row => row[0] === 'apply')[3].fingerprint === 'f'.repeat(64) && mock.calls.find(row => row[0] === 'apply')[3].allowAntiCheat === true, 'Apply is bound to the visible fingerprint and explicit acknowledgement');
  const bindingsBeforeEdit = count('bind'); click('edit-api');
  assert(field('api')?.value === 'dx11' && !button('start') && button('confirm-api').disabled && primary().length === 1, 'editing an installed API is a local single step that blocks launch');
  set('api', 'dx12'); assert(count('bind') === bindingsBeforeEdit && mock.flow.api.api === 'dx11', 'changing the selector does not save or change the installed route');
  click('cancel-api'); assert(button('start') && mock.flow.api.api === 'dx11' && count('bind') === bindingsBeforeEdit, 'cancel restores the original ready view without a backend mutation');
  click('edit-api'); set('api', 'dx12'); click('confirm-api'); await until(() => button('prepare') && !button('prepare').disabled, 'changed API requires a fresh installation preview');
  assert(host().querySelector('.hoyo-settings-host').textContent.includes('图形接口：DirectX 12'), 'the retained editor redraws the actual newly selected API');
  assert(JSON.stringify(mock.calls.filter(row => row[0] === 'bind').at(-1)[2]) === JSON.stringify({ api: 'dx12' }) && count('apply') === 1 && !button('start'), 'API confirmation only saves the explicit API and cannot bypass the new-route preview');
  click('prepare'); await until(() => button('apply'), 'changed-route preview'); host().querySelector('[data-hoyo-consent]').checked = true; click('apply');
  await until(() => button('start') && !button('start').disabled, 'changed route explicitly applied');
  assert(mock.flow.api.api === 'dx12' && count('apply') === 2 && mock.flow.binding.launcher.id === 'launcher-two', 'explicit route application restores start while preserving the launcher binding');
  const staticReads = count('inspect'); await delay(2200); assert(count('inspect') === staticReads, 'a ready static page does not poll');
  host().querySelector('[data-gp-tab="nr"]').click();
  await until(() => host().querySelector('.hoyo-settings-host [data-gp-field="Intensity"]:not([disabled])'), 'inline NR settings');
  const settings = () => host().querySelector('.hoyo-settings-host'), gpButton = action => settings().querySelector(`[data-gp-action="${action}"]`);
  assert(settings().querySelectorAll('[role="tab"]').length === 3 && gpButton('launch') && !gpButton('prepare') && !settings().querySelector('[data-gp-field="loadingBackend"]'), 'HoYo uses three shared pages with the common primary action');
  assert(settings().closest('.game-detail.gp-inline') && !settings().closest('.gp-modal') && button('start').closest('.game-card-head') && button('start').closest('.hoyo-header-action').hidden, 'the common editor expands in the card with launch above the draft actions');
  assert([...settings().querySelectorAll('[role="tab"]')].map(row => row.textContent).join('|') === '安装与启动|NR 画面增强|DLSS 超分与补帧', 'the supported tabs use the ordinary page vocabulary');
  const currentStatus = () => settings().querySelector('.gp-apply-bar [role="status"] strong').textContent;
  const setLaunchRecord = async (status, historical) => {
    gp.assessments['fixture-hoyo'].launch.session = status ? { gameId: 'fixture-hoyo', status, historical } : null;
    await settings().__gpController.refresh(true);
  };
  for (const status of ['failed', 'waiting-enhancement']) {
    await setLaunchRecord(status, true);
    assert(currentStatus() === '设置已就绪' && host().querySelector('.game-card.expanded [data-hoyo-status]').textContent === '已准备，可以启动', 'a historical ' + status + ' record cannot override the ready card or current operation status');
    assert(settings().__gpController.getState().data.launch.session.status === status && settings().__gpController.getState().data.launch.session.historical === true, 'historical ' + status + ' remains available to diagnostics and historical-session guards');
  }
  await setLaunchRecord('waiting-enhancement', false);
  assert(currentStatus() === '游戏已启动，增强待确认', 'a current waiting session still describes the active launch');
  await setLaunchRecord('failed', false);
  assert(currentStatus() === '本次启动失败', 'a current failed session remains visible in the operation bar');
  const input = settings().querySelector('[data-gp-field="Intensity"]'); input.value = '0.75'; input.dispatchEvent(new Event('input', { bubbles: true }));
  assert(currentStatus() === '1 组修改待应用', 'a dirty draft retains priority over the current launch failure');
  await setLaunchRecord(null, false);
  assert(!button('start') && primary().length === 1 && primary()[0] === gpButton('preview'), 'a dirty inline editor owns the only primary action and disables the header launch');
  assert(host().querySelector('.game-card.expanded [data-hoyo-status]').textContent === '有修改待应用', 'a pending draft cannot keep claiming that the client can launch');
  host().querySelector('[data-hoyo-toggle]').click(); assert(!settings() && button('apply-editor') && !button('start'), 'collapsing keeps a draft and cannot enable launch');
  host().querySelector('[data-hoyo-toggle]').click();
  assert(settings().querySelector('[data-gp-field="Intensity"]').value === '0.75' && gpButton('preview'), 'expanding reuses the common editor and preserves its draft');
  gpButton('preview').click(); await until(() => gpButton('modal-apply'), 'NR operation preview');
  assert(gpButton('apply-elevated') && settings().querySelectorAll('.gp-modal .gp-modal-actions .primary').length === 1, 'NR preview retains one primary Apply and the existing protected-directory recovery route');
  assert(gp.plan.request.nr.Intensity === .75 && !gp.plan.request.route && !gp.plan.request.version, 'NR edits use the existing scoped operation transaction');
  gpButton('modal-apply').click(); await until(() => !settings().querySelector('.gp-modal') && !settings().__gpController.getState().busy, 'NR applied');
  assert(gp.assessments['fixture-hoyo'].nr.Intensity === .75, 'the current HoYo profile receives the new NR value');
  settings().querySelector('[data-gp-tab="overview"]').click(); await until(() => gpButton('capture-hotkey'), 'HoYo hotkeys');
  assert(settings().textContent.includes('恢复默认 Home'), 'HoYo keeps the same new Home default'); gpButton('back').click();
  assert(!host().querySelector('.game-card.expanded') && button('start'), 'the common editor back action collapses the original card');
  host().querySelector('[data-hoyo-toggle]').click();
  mock.flow.phase = 'recovery'; mock.flow.nextAction = 'recover'; mock.flow.error = { code: 'FIXTURE', message: '待恢复的安装错误' };
  mock.flow.installation.needsRecovery = true; mock.flow.installation.ready = false; click('inspect'); await until(() => button('recover'), 'recovery priority');
  assert(!button('start') && primary().length === 1, 'an error cannot hide the recovery action or expose start'); click('recover'); await until(() => button('start'), 'recovered');
  click('start'); await until(() => host().textContent.includes('正在准备加载助手') && button('cancel'), 'helper stage');
  assert(host().querySelectorAll('.hoyo-evidence .confirmed').length === 0, 'starting a helper cannot promote load or NR evidence');
  mock.flow.phase = 'waiting-launcher'; mock.flow.verification.helper.state = 'passed';
  await until(() => host().textContent.includes('在官方启动器中启动游戏'), 'active polling launcher step');
  mock.flow.phase = 'running'; mock.flow.verification.reshade.state = 'passed'; mock.flow.verification.core.state = 'passed'; mock.flow.verification.nr.state = 'confirmed';
  await until(() => host().textContent.includes('游戏已启动') && host().querySelectorAll('.hoyo-evidence .confirmed').length === 2, 'independent loading checks');
  assert(host().querySelectorAll('.hoyo-evidence article')[2].textContent.includes('待确认'), 'a confirmed alias cannot promote NR; only passed is accepted');
  mock.flow.verification.nr = { state: 'passed', detail: '已观察到本次 NR 完成与回填计数增长。' };
  await until(() => host().querySelectorAll('.hoyo-evidence .confirmed').length === 3, 'independent NR completion');
  click('cancel'); await until(() => button('start'), 'cancel wait');
  assert(mock.calls.some(row => row[0] === 'inspect' && row[2] === undefined) && mock.calls.some(row => row[0] === 'inspect' && row[2]?.retry === true), 'only explicit rechecks request retry; passive status polls preserve launch errors');
  assert(mock.flow.binding.launcher.id === 'launcher-two' && mock.flow.channel === 'global' && count('cancel') === 1, 'cancelling keeps the exact client and launcher binding');
  mock.flow.error = { message: '重新核对所需文件' }; click('inspect'); await until(() => !button('start') && primary().length === 1, 'error cannot remain ready');
  mock.flow.error = null; click('inspect'); await until(() => button('start'), 'ready after recheck');
  click('preview-restore'); await until(() => button('apply'), 'restore preview'); host().querySelector('[data-hoyo-consent]').checked = true;
  let releaseRestore; mock.applyGate = new Promise(resolve => { releaseRestore = resolve; }); click('apply');
  assert(host().querySelector('.hoyo-next-step strong').textContent === '正在卸载并恢复…' && button('working')?.disabled && !button('start'), 'a pending restore cannot continue showing the old ready title or start button');
  await delay(60); assert(host().querySelector('.game-card.expanded [data-hoyo-status]').textContent === '正在卸载并恢复…' && primary().length === 1, 'both selected-client status and the single main action stay busy until restore completes');
  releaseRestore(); mock.applyGate = null; await until(() => button('prepare') && !button('prepare').disabled && !button('working'), 'restore completion reveals the next actual state');
  assert(host().querySelector('.hoyo-settings-host [role="status"] strong').textContent === '确认设置后应用' && !button('start'), 'completed restore returns to the shared uninstalled page instead of premature readiness');
  mock.extraFlow = { ...structuredClone(mock.flow), id: 'client-two', gameId: 'fixture-hoyo-second', family: 'genshin', name: '原神', channel: 'cn', channelLabel: '国服', exePath: 'C:\\UI-fixture\\Genshin Impact\\YuanShen.exe', gameVersion: '6.0.0',
    binding: { ...structuredClone(mock.flow.binding), status: 'automatic' } };
  gp.assessments['fixture-hoyo-second'] = structuredClone(gp.assessments['fixture-hoyo']);
  Object.assign(gp.assessments['fixture-hoyo-second'], { gameId: 'fixture-hoyo-second' });
  Object.assign(gp.assessments['fixture-hoyo-second'].game, { id: 'fixture-hoyo-second', name: '原神', chosen: { ...gp.assessments['fixture-hoyo-second'].game.chosen, path: mock.extraFlow.exePath } });
  click('discover'); await until(() => host().querySelectorAll('.game-card').length === 2 && !button('working'), 'second automatic client');
  host().querySelector('[data-hoyo-toggle="client-two"]').click(); await until(() => host().querySelector('.game-card.expanded')?.dataset.hoyoCard === 'client-two' && !button('working'), 'switch automatic client');
  await until(() => button('prepare') && !button('prepare').disabled, 'automatic client shared installation');
  assert(button('prepare') && !button('bind') && !field('launcherId'), 'an automatically bound client opens directly at the shared installation page');
  assert(host().querySelectorAll('.game-card.expanded').length === 1 && host().querySelectorAll('.hoyo-current').length === 1, 'the library expands only the selected client');
  host().querySelector('[data-hoyo-toggle="client-one"]').click(); await until(() => host().querySelector('.game-card.expanded')?.dataset.hoyoCard === 'client-one' && !button('working'), 'return to first client');
  assert(!document.querySelector('#gameList [data-id="fixture-hoyo"]'), 'ordinary games remain separate after shared-card rendering and client switches');
  if (options.hoyoCapture) {
    mock.flow.phase = 'ready'; mock.flow.nextAction = 'start'; mock.flow.installation.installed = mock.flow.installation.ready = gp.assessments['fixture-hoyo'].game.installed = true;
    click('inspect'); await until(() => settings()?.querySelector('[data-gp-tab="nr"]'), 'capture ready inline editor'); settings().querySelector('[data-gp-tab="nr"]').click();
    if (options.dirty) { const input = settings().querySelector('[data-gp-field="Intensity"]'); input.value = '0.95'; input.dispatchEvent(new Event('input', { bubbles: true })); }
    for (const node of host().querySelectorAll('[data-hoyo-detail]')) node.open = false;
  }
  assert(host().scrollWidth <= host().clientWidth + 1, 'the shared card layout has no horizontal overflow');
  document.getElementById('view-hoyo').scrollTop = 0;
  return { scope: 'production renderer with deterministic HoYo IPC boundary fixture', assertions, discovered: count('discover'), bound: count('bind'), previews: count('preview'), applies: count('apply'), starts: count('start'), independentVerification: true, onePrimaryAction: true };
}

module.exports = { installHoYoMock, smokeHoYo };
