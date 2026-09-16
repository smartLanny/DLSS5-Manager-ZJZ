'use strict';

const $ = id => document.getElementById(id);
let startupFinished = false;
window.addEventListener('error', event => {
  if (!startupFinished) window.manager?.startupFailed?.(event.message || '界面脚本执行失败');
});
window.addEventListener('unhandledrejection', event => {
  if (!startupFinished) window.manager?.startupFailed?.(event.reason?.message || '界面初始化请求失败');
});
const state = {
  product: null,
  settings: null,
  payload: null,
  hardware: null,
  addons: [],
  games: [],
  hoyoGameIds: new Set(),
  activeView: 'games',
  expanded: null,
  expandedLoadToken: 0,
  repairLoadToken: 0,
  detailTabs: new Map(),
  repairGame: null,
  feedbackGame: null,
  lastFailureGame: null,
  diagnostics: null,
  busy: false,
  pendingModal: null,
  gameSelection: null,
  saveTimers: new Map(),
  saveRevisions: new Map(),
  pendingPatches: new Map(),
  routeDrafts: new Map(),
  installing: new Set()
};
const inlineGameDetails = new Map();
let repairController = null, repairControllerId = null, hoyoController = null;
let motionSaveGeneration = 0, themeSaveGeneration = 0;
const overlayTimers = new WeakMap();
const systemTheme = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function applyThemePreference(preference = 'system') {
  if (typeof document === 'undefined') return;
  const selected = ['system', 'light', 'dark'].includes(preference) ? preference : 'system';
  const resolved = selected === 'system' ? (systemTheme?.matches ? 'dark' : 'light') : selected;
  document.documentElement.dataset.themePreference = selected;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  const select = $('themeSelect');
  if (select) select.value = selected;
}

if (systemTheme) {
  const syncSystemTheme = () => {
    if ((state.settings?.theme || document.documentElement.dataset.themePreference) === 'system') applyThemePreference('system');
  };
  if (typeof systemTheme.addEventListener === 'function') systemTheme.addEventListener('change', syncSystemTheme);
  else if (typeof systemTheme.addListener === 'function') systemTheme.addListener(syncSystemTheme);
}
if (typeof document !== 'undefined') applyThemePreference('system');

function motionAllowed() {
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return document.documentElement.dataset.motion !== 'off' && !reduced;
}

function applyMotionPreference(enabled) {
  const active = enabled !== false;
  document.documentElement.dataset.motion = active ? 'on' : 'off';
  const toggle = $('animationsToggle');
  if (toggle) toggle.checked = active;
}

function replayMotion(element, className) {
  if (!element || !motionAllowed()) return;
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
  clearTimeout(element.motionReplayTimer);
  element.motionReplayTimer = setTimeout(() => element.classList.remove(className), 260);
}

function showOverlay(element) {
  if (!element) return;
  clearTimeout(overlayTimers.get(element));
  element.classList.remove('is-closing', 'hidden');
}

function hideOverlay(element) {
  if (!element) return;
  clearTimeout(overlayTimers.get(element));
  if (!motionAllowed()) {
    element.classList.remove('is-closing');
    element.classList.add('hidden');
    return;
  }
  element.classList.add('is-closing');
  overlayTimers.set(element, setTimeout(() => {
    element.classList.add('hidden');
    element.classList.remove('is-closing');
    overlayTimers.delete(element);
  }, 150));
}

function mountRepairActions(game) {
  const host = $('repairMaintenance');
  if (!host || !window.GamePageUi || !window.manager.assessGame) return;
  if (!game) { repairController?.dispose(); repairController = null; repairControllerId = null; host.innerHTML = ''; return; }
  if (repairControllerId === game.id && repairController) { void repairController.refresh(true); return; }
  repairController?.dispose(); host.innerHTML = ''; repairControllerId = game.id;
  repairController = window.GamePageUi.mount(host, window.manager, { maintenanceOnly: true,
    onChanged: async gameId => { await refreshGames({ gameId }); await loadRepairDiagnostic(); },
    onBack: () => {}, onFeedback: gameId => { state.feedbackGame = gameId; }
  });
  void repairController.open(game.id, 'maintenance', { game, hardware: state.hardware });
}
function openGamePage(id, initialTab) {
  if (!window.GamePageUi || typeof window.manager.assessGame !== 'function') return;
  const reopen = state.expanded !== id && inlineGameDetails.has(id);
  if (state.activeView !== 'games') switchView('games');
  state.expanded = id;
  renderGames({ preserveExpanded: true });
  const entry = inlineGameDetails.get(id);
  if (initialTab) entry?.controller.selectTab(initialTab);
  if (reopen) void entry?.controller.refresh(true);
  return entry?.controller;
}

function mountInlineDetail(card, game) {
  const placeholder = card.querySelector('.game-detail');
  if (!placeholder) return;
  let entry = inlineGameDetails.get(game.id);
  const exe = String(game.chosen?.path || '').toLowerCase();
  if (entry && entry.exe !== exe) {
    entry.controller.dispose(); inlineGameDetails.delete(game.id); entry = null;
  }
  if (entry) {
    if (placeholder !== entry.host) placeholder.replaceWith(entry.host);
    entry.controller.resume(game);
    return;
  }
  const controller = window.GamePageUi.mount(placeholder, window.manager, {
    onBack: () => { state.expanded = null; renderGames(); },
    onRename: gameId => confirmRenameGame(gameId),
    onChanged: async () => {
      state.games = mergeGameVisuals(state.games, unwrap(await window.manager.listGames()));
      renderGames({ preserveExpanded: true });
    }
  });
  entry = { host: placeholder, controller, exe };
  inlineGameDetails.set(game.id, entry);
  const seed = { game, hardware: state.hardware, coreVersions: state.addons,
    defaults: { version: game.installed ? game.addonVersion : state.payload?.selectedVersion,
      deployment: game.installed ? 'local' : 'external', loadingMode: 'proxy' } };
  void controller.open(game.id, 'overview', seed);
}

function unwrap(result) {
  if (!result || result.ok !== true) {
    const error = result && result.error ? result.error : { message: '操作失败。' };
    throw Object.assign(new Error(error.message), error);
  }
  return result.value;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
}

const KEY_NAMES = Object.freeze({
  8: 'Backspace', 9: 'Tab', 13: 'Enter', 27: 'Esc', 32: 'Space',
  33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home', 37: 'Left',
  38: 'Up', 39: 'Right', 40: 'Down', 45: 'Insert', 46: 'Delete',
  0xBA: ';', 0xBB: '=', 0xBC: ',', 0xBD: '-', 0xBE: '.', 0xBF: '/',
  0xC0: '`', 0xDB: '[', 0xDC: '\\', 0xDD: ']', 0xDE: "'"
});

// ReShade uses Windows VK_OEM codes, not the Unicode character produced by
// the current input method. Keep Shift/Ctrl/Alt separate from the physical key.
const OEM_KEY_CODES = Object.freeze({
  Semicolon: 0xBA, Equal: 0xBB, Comma: 0xBC, Minus: 0xBD, Period: 0xBE, Slash: 0xBF,
  Backquote: 0xC0, BracketLeft: 0xDB, Backslash: 0xDC, BracketRight: 0xDD, Quote: 0xDE
});

function hotkeyLabel(binding) {
  if (!binding) return '未设置';
  const key = Number(binding.key);
  let name = KEY_NAMES[key] || (key >= 112 && key <= 135 ? `F${key - 111}` : String.fromCharCode(key));
  if (key >= 48 && key <= 57) name = String.fromCharCode(key);
  const modifiers = [];
  if (binding.ctrl) modifiers.push('Ctrl');
  if (binding.shift) modifiers.push('Shift');
  if (binding.alt) modifiers.push('Alt');
  return [...modifiers, name].join('+');
}

function keyBindingFromEvent(event) {
  const code = String(event.code || '');
  let key = 0;
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) key = 111 + Number(code.slice(1));
  else if (/^Key[A-Z]$/.test(code)) key = code.charCodeAt(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.charCodeAt(5);
  else if (/^Numpad[0-9]$/.test(code)) key = 96 + Number(code.slice(6));
  else if (code === 'Home') key = 36;
  else if (code === 'End') key = 35;
  else if (code === 'Insert') key = 45;
  else if (code === 'Delete') key = 46;
  else if (code === 'PageUp') key = 33;
  else if (code === 'PageDown') key = 34;
  else if (code === 'ArrowLeft') key = 37;
  else if (code === 'ArrowUp') key = 38;
  else if (code === 'ArrowRight') key = 39;
  else if (code === 'ArrowDown') key = 40;
  else if (code === 'Space') key = 32;
  else if (code === 'Tab') key = 9;
  else if (code === 'Enter') key = 13;
  else if (Object.hasOwn(OEM_KEY_CODES, code)) key = OEM_KEY_CODES[code];
  if (!key) return null;
  return { key, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey };
}

function toast(message, error = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

function setBusy(value) {
  state.busy = value;
  document.body.classList.toggle('is-busy', value);
}

function setInstallBusy(id, value) {
  if (value) state.installing.add(id);
  else state.installing.delete(id);
  const card = [...document.querySelectorAll('.game-card')].find(row => row.dataset.id === id);
  const apply = card && card.querySelector('.route-apply-btn');
  if (apply) {
    apply.disabled = value || apply.dataset.baseDisabled === 'true';
    apply.setAttribute('aria-busy', String(value));
    apply.textContent = value ? '正在应用…' : apply.dataset.idleLabel;
  }
  const button = card && card.querySelector('.install-btn');
  if (!button) return;
  button.disabled = value;
  button.classList.toggle('is-busy', value);
  button.setAttribute('aria-busy', String(value));
  button.setAttribute('aria-live', 'polite');
  button.innerHTML = value
    ? '<span class="button-spinner" aria-hidden="true"></span><span>正在安装…</span>'
    : '一键安装';
}

function feederOwnsVulkan(game) { return game?.feeder?.installed === true && game?.feeder?.api === 'vulkan'; }
function isVulkanRoute(game) { return !feederOwnsVulkan(game) && globalThis.ManagerOperationApi.resolveOperationApi(game).effectiveApi === 'vulkan'; }
function coreSupportsPresent(game, selection) {
  const version = selection?.version || routeSelection(game).version;
  return state.payload?.versions?.[version]?.supportsPresent ?? game?.coreCapabilities?.supportsPresent ?? false;
}
function isFeederRoute(game, selection) { const api = selection?.resolvedApi ?? globalThis.ManagerOperationApi.resolveOperationApi(game).effectiveApi; return game?.feeder?.installed === true ||
  api === 'vulkan' && feederOwnsVulkan(game) || Number(game?.chosen?.bitness) === 32 && game?.feeder?.selections?.[api]?.available ||
  ['dx9', 'dx10'].includes(api) || game?.nativeDlssAvailable === false && (api === 'dx11' || api === 'dx12' && !coreSupportsPresent(game, selection)); }
function routeInstalled(game) { return isVulkanRoute(game) ? game?.vulkan?.installed === true : game?.installed === true; }
function routeSupported(game) { return isVulkanRoute(game) ? game?.vulkan?.available === true : isFeederRoute(game)
  ? (game?.feeder?.selections?.[game?.chosen?.apiResolution?.api]?.available ?? game?.feeder?.available) === true : game?.supported === true; }

function supportBadge(game) {
  if (game.feeder?.needsRecovery === true) return '<span class="badge bad">Feeder 需恢复</span>';
  if (isVulkanRoute(game) && game.vulkan?.needsRecovery === true) return '<span class="badge bad">Vulkan 需恢复</span>';
  if (routeInstalled(game)) return '<span class="badge good">已安装</span>';
  if (game.existingInstallation?.detected === true) return '<span class="badge">已有插件待确认</span>';
  if (isFeederRoute(game) && !game.installed && routeSupported(game)) return '<span class="badge">可准备 Feeder</span>';
  if (routeSupported(game)) return '<span class="badge good">支持安装</span>';
  if (isVulkanRoute(game)) return '<span class="badge bad">Vulkan 暂不可用</span>';
  if (game.supportCode === 'ERR_API_SELECTION_REQUIRED') return '<span class="badge">API 待确认</span>';
  if (game.supportCode === 'ERR_CARRIER_NOT_SELECTED') return '<span class="badge">兼容组件已关闭</span>';
  return '<span class="badge bad">暂不支持</span>';
}

function hardwareLabel() {
  if (!state.hardware) return '显卡待识别';
  if (state.hardware.family === 'RTX40') {
    const series = Array.isArray(state.hardware.series) ? state.hardware.series : [];
    return series.length ? `${series.map(value => value.replace('RTX', 'RTX ')).join(' / ')}（使用 RTX 40 兼容组件）` : 'RTX 20 / 30 / 40';
  }
  if (state.hardware.family === 'RTX50') return 'RTX 50';
  if (state.hardware.family === 'mixed') return '多套 RTX';
  return '显卡不支持自动匹配';
}

function payloadReadyForHardware() {
  if (!state.payload) return false;
  if (state.payload.versions) return Boolean(state.payload.ready && state.hardware && ['RTX40', 'RTX50'].includes(state.hardware.family));
  if (!state.payload.variants) return state.payload.ready;
  const family = state.hardware && state.hardware.family;
  return Boolean(family && state.payload.variants[family] && state.payload.variants[family].ready);
}

function refreshSelectedPayload(version) {
  if (!state.payload || !state.payload.versions) return;
  const versions = state.payload.versions;
  // Saved selections can outlive a bundled version after an upgrade. Keep the
  // backend's verified fallback instead of treating an absent key as bad files.
  const selectedVersion = [catalogReplacement(version), version, state.payload.selectedVersion, ...Object.keys(versions)]
    .find(id => Object.prototype.hasOwnProperty.call(versions, id));
  const item = versions[selectedVersion];
  const family = state.hardware && state.hardware.family;
  const variant = item && family && item.variants && item.variants[family];
  state.payload.selectedVersion = item ? selectedVersion : state.payload.selectedVersion;
  state.payload.hardwareFamily = family || null;
  state.payload.files = variant ? variant.files : [];
  state.payload.ready = Boolean(variant && variant.ready);
  state.payload.missing = variant ? variant.missing : [];
  state.payload.invalid = variant ? variant.invalid : [];
}

function renderPayloadNotice(removedSelection = false) {
  const notice = $('payloadNotice');
  if (!notice) return;
  const payload = state.payload;
  const family = state.hardware?.family;
  const familyLabel = family === 'RTX50' ? 'RTX 50 系' : family === 'RTX40' ? 'RTX 40 系（兼容 RTX 20/30）' : '对应显卡系列';
  const packName = family === 'RTX50' ? 'NR-Runtime-RTX50.zip' : family === 'RTX40' ? 'NR-Runtime-RTX40.zip' : 'NR-Runtime-RTX40+RTX50.zip';
  let markup = '';
  if (!state.hardware || !['RTX40', 'RTX50'].includes(state.hardware.family)) {
    markup = `<div class="payload-guidance-icon" aria-hidden="true">GPU</div><div class="payload-guidance-copy"><strong>先确认显卡系列</strong><span>管理器暂时无法自动匹配运行库。请检查显卡识别结果，或到组件管理导入合并 DLC。</span></div><div class="payload-guidance-actions"><button class="button primary" id="payloadOpenComponentsBtn">打开组件管理</button><button class="button" id="payloadOpenSettingsBtn">检查显卡</button></div>`;
  } else if (!payloadReadyForHardware()) {
    const problems = [...((payload && payload.missing) || []), ...((payload && payload.invalid) || [])];
    if (payload?.source?.runtimeDlcRequired === true || problems.length > 0 && problems.every(file => String(file).split(/[\\/]/).pop().toLowerCase() === 'nvngx_dlssnr.dll')) {
      markup = `<div class="payload-guidance-icon" aria-hidden="true">DLC</div><div class="payload-guidance-copy"><strong>还差一份 ${escapeHtml(familyLabel)}运行库</strong><span>管理器与 Core 已就绪。导入 <b>${escapeHtml(packName)}</b> 后即可安装，不会自动改动已有游戏。</span></div><div class="payload-guidance-actions"><button class="button primary" id="payloadImportRuntimeBtn">立即导入运行库 DLC</button><button class="button" id="payloadOpenComponentsBtn">打开组件管理</button></div>`;
    } else {
      const labels = problems.slice(0, 3).map(file => {
        const name = String(file).split(/[\\/]/).pop();
        if (/nrchain_nvngx\.dll/i.test(name)) return 'Core 配套连接组件';
        if (/\.addon64$/i.test(name)) return '增强 Core';
        if (/bundle\.json/i.test(name)) return '组件清单';
        return name || '安装组件';
      });
      const issue = labels.length ? `需要处理：${labels.join('、')}。` : '安装来源需要重新检查。';
      markup = `<div class="payload-guidance-icon warn" aria-hidden="true">!</div><div class="payload-guidance-copy"><strong>安装组件需要处理</strong><span>${escapeHtml(issue)}请到组件管理重新导入，或改用完整组件目录。</span></div><div class="payload-guidance-actions"><button class="button primary" id="payloadOpenComponentsBtn">打开组件管理</button></div>`;
    }
  } else if (removedSelection) {
    const item = payload.versions[payload.selectedVersion];
    markup = `<div class="payload-guidance-icon neutral" aria-hidden="true">i</div><div class="payload-guidance-copy"><strong>默认 Core 已更新</strong><span>上次选择的版本已退出常规分发，当前提供 ${escapeHtml(coreVersionLabel(payload.selectedVersion, item))}。已安装核心不会自动更换。</span></div>`;
  }
  notice.innerHTML = markup;
  notice.classList.toggle('hidden', !markup);
  const importButton = $('payloadImportRuntimeBtn');
  if (importButton) importButton.onclick = () => importRequiredRuntimeDlc(importButton);
  const componentsButton = $('payloadOpenComponentsBtn');
  if (componentsButton) componentsButton.onclick = () => openComponentManager();
  const settingsButton = $('payloadOpenSettingsBtn');
  if (settingsButton) settingsButton.onclick = () => switchView('settings');
}

function openComponentManager() {
  switchView('addons');
  const button = $('importRuntimeDlcBtn');
  button?.focus();
  replayMotion($('componentRuntimeGuide') || button, 'motion-reenter');
}

async function importRequiredRuntimeDlc(button) {
  if (state.busy) return;
  setBusy(true);
  if (button) button.disabled = true;
  try {
    const result = unwrap(await window.manager.pickRuntimeDlc());
    if (!result) return;
    if (result.state) window.dispatchEvent(new CustomEvent('manager-components-changed', { detail: result.state }));
    toast(result.message || '运行库 DLC 已导入。');
    if (!result.activated) openComponentManager();
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(false);
    if (button) button.disabled = false;
  }
}

function renderVersionSelector() {
  const select = $('addonVersionSelect');
  if (!select) return;
  const versions = state.payload && state.payload.versions;
  if (!versions || !Object.keys(versions).length) {
    select.innerHTML = '<option value="">随安装组件</option>';
    select.disabled = true;
    renderPayloadNotice();
    return;
  }
  const saved = state.settings.addonVersion;
  const removedSelection = Boolean(saved && !Object.prototype.hasOwnProperty.call(versions, saved));
  refreshSelectedPayload(saved);
  const selected = state.payload.selectedVersion;
  select.innerHTML = Object.entries(versions).map(([id, item]) => `<option value="${escapeHtml(id)}">${escapeHtml(coreVersionLabel(id, item))}</option>`).join('');
  select.value = selected;
  $('addonVersionNote').textContent = '用于新安装；已安装游戏保留自己的版本，在游戏卡片中选择并应用。';
  select.disabled = false;
  renderPayloadNotice(removedSelection);
}

function coreVersionLabel(id, item) {
  if (id === '0.3.3-dev-r4') return '0.3.3.4 · 稳定兼容';
  if (/^(?:beta)?0\.4\.7(?:-?beta)?$/i.test(id)) return '0.4.7beta';
  const raw = String(item && item.label || id);
  const version = raw.match(/^(0\.\d+\.\d+(?:\.\d+)?(?:-hotfix\.\d+)?)([-\s]?beta(?:\.\d+)?)?/i);
  if (version) {
    const value = version[1] + (version[2] ? version[2].replace(/^\s+/, '') : '');
    if (value.startsWith('0.2.')) return version[1];
    if (value.startsWith('0.3.')) return `${value} · 历史对照`;
    if (value.startsWith('0.4.') || version[2]) return `${value} · Beta`;
    return value;
  }
  return raw.replace(/(?:\s*[-–—]\s*|\s*[（(])(?:DXGI|DX11|DX12|DirectX\s*11|DirectX\s*12)\b.*$/i, '').trim() || String(id);
}

function catalogReplacement(id) {
  const map = state.payload?.bundle?.supersededVersions || state.payload?.supersededVersions;
  if (!id || !map || typeof map !== 'object') return null;
  const seen = new Set(); let current = id;
  while (Object.prototype.hasOwnProperty.call(map, current)) {
    if (seen.has(current) || seen.size >= 16 || typeof map[current] !== 'string') return null;
    seen.add(current); current = map[current];
  }
  return current !== id && Object.prototype.hasOwnProperty.call(state.payload?.versions || {}, current) ? current : null;
}

function actionSuccessMessage(success, value) {
  if (value?.restored === true && value?.route === 'feeder-dx12' && value.notice) return value.notice;
  if (value?.removed === false) throw Object.assign(new Error('卸载未完成，请核对保留的恢复记录并保存反馈。'), { code: 'ERR_BACKUP_INVALID' });
  if (value?.removed === true && typeof value.historyRel === 'string' && value.historyRel) {
    const retained = Array.isArray(value.retainedSidecars) ? value.retainedSidecars.length : Number(value.retainedSidecars) || 0;
    return `卸载完成；备份已集中保存在 _DLSS5_Backup${retained > 0 ? '；被外部改动的备份已原位保留' : ''}`;
  }
  if (value?.reframework?.automatic === true) {
    const nativeResult = success === '安装完成' ? '核心已安装'
      : success === '修复完成' || success.startsWith('已应用核心 ') ? '核心已更新' : success;
    if (value.reframework.ready === false) {
      const error = value.reframework.error || {};
      const detail = `${error.message || '准备未完成'}${error.code ? ` [${error.code}]` : ''}`;
      return `${nativeResult}；卡普空 RE 引擎兼容未完成：${detail}`;
    }
    if (value.reframework.ready === true) return `${nativeResult}；已自动准备卡普空 RE 引擎兼容`;
  }
  const replacement = value?.payloadReplacement;
  return replacement?.from && replacement?.to && replacement.from !== replacement.to
    ? `${success}；已应用替代核心 ${coreVersionLabel(replacement.to)}（原选择 ${coreVersionLabel(replacement.from)} 已退出常规分发）`
    : success;
}

function versionOptionsMarkup(selected = state.payload && state.payload.selectedVersion, includeImported = true, game = null) {
  const versions = state.payload && state.payload.versions ? Object.entries(state.payload.versions)
    .sort(([left], [right]) => left.localeCompare(right, 'en', { numeric: true })) : [];
  const imported = includeImported ? (state.addons || []).filter(item => item.addonOnly).map(item => [item.id, item]) : [];
  const all = [...versions, ...imported];
  if (!all.length) return '<option value="">当前组件</option>';
  const missingInstalled = includeImported && selected && !all.some(([id])=>id===selected);
  const option = (id, item, active = false) => {
    return `<option value="${escapeHtml(id)}"${active ? ' selected' : ''}>${escapeHtml(coreVersionLabel(id,item))}${item.addonOnly ? '（导入）' : ''}</option>`;
  };
  if (missingInstalled) return `<option value="${escapeHtml(selected)}" selected disabled>${/^imported-/.test(selected)?'当前导入核心':escapeHtml(coreVersionLabel(selected))}（原安装源不可用）</option>`+
    all.map(([id,item])=>option(id,item)).join('');
  if (!all.some(([id]) => id === selected)) selected = catalogReplacement(selected) || (state.payload && state.payload.selectedVersion);
  return all.map(([id, item]) => option(id, item, id === selected)).join('');
}

function poster(game) {
  // Steam art is authoritative. An EXE icon is only a fallback when Steam
  // has no poster/icon, so a slow artwork request cannot leave a blurry icon
  // permanently preferred over the later high-resolution cover.
  // Posters are the high-resolution source for every launcher. EXE icons are
  // only the fallback when no artwork could be found; this also lets manually
  // added games upgrade from a shell icon after the artwork lookup completes.
  const source = game.poster || game.icon;
  if (source) {
    const url = /^(?:file:|data:|https?:)/i.test(source)
      ? source
      : `file:///${encodeURI(source.replace(/\\/g, '/').replace(/^\/+/, ''))}`;
    return `<div class="poster"><img src="${escapeHtml(url)}" alt=""></div>`;
  }
  const first = escapeHtml((game.name || '?').trim().slice(0, 1).toUpperCase());
  return `<div class="poster">${first}</div>`;
}

function visibleGames() {
  const query = $('searchInput').value.trim().toLowerCase();
  const filter = $('gameFilter').value;
  return state.games.filter(game => {
    if (game.hoyoManaged || state.hoyoGameIds.has(game.id)) return false;
    const matchesQuery = !query || `${game.name} ${game.launcher}`.toLowerCase().includes(query);
    const matchesFilter = filter === 'all' ||
      (filter === 'installed' && game.installed) ||
      (filter === 'supported' && !game.installed && routeSupported(game)) ||
      (filter === 'unsupported' && !routeSupported(game));
    return matchesQuery && matchesFilter;
  });
}

function cardAction(game) {
  if (typeof window === 'object' && typeof window.manager?.assessGame === 'function') return `<button class="button primary unified-launch-btn" type="button">启动游戏</button><button class="button open-game-page-btn" type="button">${game.installed ? '设置' : game.existingInstallation?.detected === true ? '检查已有安装' : '安装与设置'}</button>`;
  const installBusy = Boolean(state.installing && state.installing.has(game.id));
  const installButton = `<button class="button primary install-btn${installBusy ? ' is-busy' : ''}" aria-live="polite" aria-busy="${installBusy}"${installBusy ? ' disabled' : ''}>${installBusy ? '<span class="button-spinner" aria-hidden="true"></span><span>正在安装…</span>' : game.existingInstallation?.detected === true ? '预览已有安装' : '一键安装'}</button>`;
  const rename = '<button class="button subtle rename-game-btn" type="button" title="修改游戏名称">改名</button>';
  const dismiss = '<button class="icon-button dismiss-game-btn" title="移除这个游戏" aria-label="移除这个游戏">×</button>';
  if (game.feeder?.needsRecovery === true)
    return `<button class="button primary feeder-recover-btn" type="button">恢复并卸载 Feeder</button><button class="button subtle card-open">设置</button>${rename}${dismiss}`;
  if (game.vulkan?.installed === true && game.vulkan?.needsRecovery === true)
    return `<button class="button" disabled>需先恢复配套</button><button class="button primary card-open">恢复配套</button>${rename}${dismiss}`;
  if (routeInstalled(game)) return `<button class="button primary launch-btn">启动游戏</button><button class="button subtle card-open">设置</button>${rename}${dismiss}`;
  if (isFeederRoute(game, routeSelection(game)) && routeSelection(game).resolvedApi === 'dx12') return feederSelectionState(game).available ? `${installButton}${rename}${dismiss}` : `<button class="button" disabled>Feeder 暂不可用</button>${rename}${dismiss}`;
  if (state.routeDrafts?.has(game.id) && ['dx11', 'dx12', 'vulkan'].includes(routeSelection(game).resolvedApi)) {
    const selected = routeSelection(game);
    if (routeNeedsRestore(game, selected)) return `<button class="button" disabled>需先恢复配套</button>${rename}${dismiss}`;
    if (selected.resolvedApi === 'dx12' && game.nativeDlssAvailable === false && (game.feeder?.installed || !coreSupportsPresent(game, selected)) && !feederSelectionState(game, selected).available)
      return `<button class="button" disabled>Feeder 暂不可用</button>${rename}${dismiss}`;
    if (selected.resolvedApi === 'vulkan' && !feederOwnsVulkan(game) && (!vulkanSelectionState(game).available || !game.vulkan?.packageId))
      return `<button class="button" disabled>Vulkan 暂不可用</button>${rename}${dismiss}`;
    return `${installButton}${rename}${dismiss}`;
  }
  if (isVulkanRoute(game)) return vulkanSelectionState(game).available && game.vulkan?.packageId ? `${installButton}${rename}${dismiss}` : `<button class="button" disabled>Vulkan 暂不可用</button>${rename}${dismiss}`;
  if (game.supported && payloadReadyForHardware()) return `${installButton}${rename}${dismiss}`;
  if (game.supported) return `<button class="button subtle payload-open-btn">检查安装组件</button>${rename}${dismiss}`;
  if (game.supportCode === 'ERR_API_SELECTION_REQUIRED') return `<button class="button subtle">请选择游戏 API</button>${rename}${dismiss}`;
  return `<button class="button" disabled>无法安装</button>${rename}${dismiss}`;
}

const API_LABELS = { dx9: 'DirectX 9', dx10: 'DirectX 10', dx11: 'DirectX 11', dx12: 'DirectX 12',
  vulkan: 'Vulkan', opengl: 'OpenGL', mixed: '多条 API 线索，待确认', unknown: 'API 待确认', unsupported: '不支持的 API' };

function nativeRouteVersion(game) {
  const versions = state.payload?.versions || {};
  const current = game?.installed && !game.vulkan?.installed ? game.addonVersion : null;
  const latest = Object.keys(versions).find(id => /^(?:beta)?0\.4\.7(?:-?beta)?$/i.test(id));
  // A new-install recommendation must never become an implicit upgrade.
  if (current) return current;
  return latest || catalogReplacement(current) || game?.recommendedAddonVersion || state.payload?.selectedVersion || '';
}
function routeDraft(game) {
  const drafts = state.routeDrafts || (state.routeDrafts = new Map());
  const draft = drafts.get(game?.id);
  const exe = String(game?.chosen?.path || '').toLowerCase();
  if (draft && draft.exe !== exe) { drafts.delete(game.id); return null; }
  return draft || null;
}
function routeSelection(game) {
  const draft = routeDraft(game), api = draft?.api || game?.apiOverride ||
    (game?.chosen?.apiResolution?.source === 'override' ? game.chosen.apiResolution.api : 'auto');
  const resolvedApi = globalThis.ManagerOperationApi.resolveOperationApi(game, { api }).effectiveApi;
  const nativeVersion = draft?.nativeVersion || nativeRouteVersion(game);
  const version = resolvedApi === 'vulkan' ? (feederOwnsVulkan(game) ? game?.feeder?.packageId || game?.feeder?.selections?.vulkan?.packageId : game?.vulkan?.packageId) || '' : draft?.version || nativeVersion;
  return { api, resolvedApi, version, nativeVersion, dirty: Boolean(draft), exe: String(game?.chosen?.path || '').toLowerCase() };
}
function updateRouteDraft(game, patch) {
  const current = routeSelection(game), draft = { ...current, ...patch, dirty: true };
  draft.resolvedApi = globalThis.ManagerOperationApi.resolveOperationApi(game, { api: draft.api }).effectiveApi;
  if (patch.version !== undefined && current.resolvedApi !== 'vulkan') draft.nativeVersion = patch.version;
  draft.version = draft.resolvedApi === 'vulkan' ? (feederOwnsVulkan(game) ? game.feeder?.packageId || game.feeder?.selections?.vulkan?.packageId : game.vulkan?.packageId) || '' : draft.nativeVersion;
  state.routeDrafts.set(game.id, draft);
  return draft;
}
function routeNeedsRestore(game, selection = routeSelection(game)) {
  return game.feeder?.needsRecovery === true || game.feeder?.installed === true && selection.resolvedApi !== (game.feeder.api || 'dx12') ||
    game.vulkan?.needsRecovery === true || game.vulkan?.installed === true && selection.resolvedApi !== 'vulkan' ||
    game.installed === true && game.vulkan?.installed !== true && selection.resolvedApi === 'vulkan' && !feederOwnsVulkan(game);
}
function vulkanCoreLabel(game) {
  const version = typeof game?.vulkan?.coreVersion === 'string' ? game.vulkan.coreVersion : '';
  return version ? `${coreVersionLabel(version)} · Vulkan 桥接` : 'Vulkan 桥接（版本待确认）';
}
function vulkanSelectionState(game) {
  const info = game.vulkan || {}, explicit = typeof info.selectionAvailable === 'boolean';
  const available = (explicit ? info.selectionAvailable : info.available) === true && info.needsRecovery !== true;
  const reason = explicit ? info.selectionReason : info.reason;
  return { available, reason: typeof reason === 'string' ? reason.trim() : '' };
}
function feederSelectionState(game, selected = routeSelection(game)) {
  const info = game.feeder || {}, explicit = typeof info.selectionAvailable === 'boolean';
  return { available: selected.resolvedApi === 'dx12' && info.needsRecovery !== true && (explicit ? info.selectionAvailable : info.available) === true,
    reason: (explicit ? info.selectionReason : info.reason) || '' };
}
function routeApplyRow(game) {
  const selected = routeSelection(game), recovery = routeNeedsRestore(game, selected);
  if (selected.resolvedApi === 'dx12' && game.nativeDlssAvailable === false && (game.feeder?.installed || !coreSupportsPresent(game, selected))) {
    const feederSelection = feederSelectionState(game, selected);
    const disabled = recovery || !feederSelection.available || !game.chosen, busy = Boolean(state.installing?.has(game.id));
    if (game.feeder?.installed) return '<p class="config-note">固定 Feeder 配套已安装；修复、卸载和环境清理统一在“维护与恢复”中。</p>';
    const label = '一键准备 Feeder';
    return `<div class="route-apply-row"><p class="config-note">${escapeHtml(feederSelection.reason || '固定配套提供成品帧 NR；不会给游戏增加原生 DLSS 超分或补帧。')}</p><button class="button primary route-apply-btn" data-base-disabled="${disabled}" data-idle-label="${label}"${disabled || busy ? ' disabled' : ''}>${busy ? '正在准备…' : label}</button></div>`;
  }
  const vulkan = selected.resolvedApi === 'vulkan' && !feederOwnsVulkan(game);
  const note = recovery ? '已有配套需要先卸载。请在下方设置中点击“卸载插件”，再应用新的 API 与核心。'
    : `${selected.dirty ? '尚未应用：' : '将一起应用：'}${API_LABELS[selected.resolvedApi] || 'API 待确认'} · ${vulkan ? vulkanCoreLabel(game) : coreVersionLabel(selected.version)}。`;
  const label = game.installed || game.vulkan?.installed ? '应用设置' : '一键准备画面增强';
  const unavailableVersion = !vulkan && !Object.prototype.hasOwnProperty.call(state.payload?.versions || {}, selected.version) &&
    !(game.installed && state.addons?.some(item => item.id === selected.version && item.addonOnly));
  const disabled = recovery || !game.chosen || !['dx11', 'dx12', 'vulkan'].includes(selected.resolvedApi) || !selected.version ||
    unavailableVersion || vulkan && (!game.vulkan?.packageId || !vulkanSelectionState(game).available);
  const busy = Boolean(state.installing?.has(game.id));
  return `<div class="route-apply-row"><p class="config-note route-draft-note${recovery ? ' launch-error' : ''}" role="status">${escapeHtml(note)}</p><button class="button primary route-apply-btn" type="button" data-base-disabled="${disabled}" data-idle-label="${label}" aria-live="polite" aria-busy="${busy}"${disabled || busy ? ' disabled' : ''}>${busy ? '正在应用…' : label}</button></div>`;
}
function routeControlsMarkup(game) {
  const selected = routeSelection(game);
  if (isFeederRoute(game, selected) && game.feeder?.generation === 'external-provider-v1') return `${apiControls(game)}<div class="config-block core-selection"><h4>外部输入配套</h4><p class="config-note">${escapeHtml(game.feeder.coreVersion || '当前 Core')} · ${escapeHtml(game.feeder.providerPackageId || '已选输入桥')}。接口和文件身份在安装前核对，运行画面请进游戏确认。</p></div>${routeApplyRow(game)}`;
  if (selected.resolvedApi === 'dx12' && game.nativeDlssAvailable === false && (game.feeder?.installed || !coreSupportsPresent(game, selected))) return `${apiControls(game)}<div class="config-block core-selection"><h4>无原生 DLSS · Feeder 试验路线</h4><p class="config-note">${escapeHtml(game.feeder?.coreVersion || '0.4.7beta')} 固定配套 · RTX50 / 64 位 DX12 / 已确认 sRGB 的 RGBA8 画面。</p><p class="config-note">提供成品帧 NR 后处理；当前不支持 HDR，实际处理状态需进游戏确认。</p><p class="config-note feeder-entry-note">加载入口：DXGI。此固定配套暂不提供 DXGI → D3D12 切换；它不能作为反作弊报错的通用修复。</p></div>${routeApplyRow(game)}`;
  return `${apiControls(game)}${selected.resolvedApi === 'vulkan' && !feederOwnsVulkan(game) ? vulkanRouteMarkup(game) : `<div class="config-block core-selection"><h4>Addon 核心版本</h4>${addonVersionRow(game)}<p class="config-note">API 与核心版本选好后，一次应用。新安装使用当前安装来源的默认核心；已有安装保留当前版本。</p></div>`}${routeApplyRow(game)}`;
}

function refreshRouteControls(card, game, focusSelector = null) {
  const host = card.querySelector('.game-route-controls'); if (!host) return;
  const anchor = captureGameViewAnchor(game.id);
  host.innerHTML = routeControlsMarkup(game);
  const actions = card.querySelector('.card-action');
  if (actions) {
    const arrow = actions.querySelector('.expand-arrow')?.outerHTML || '';
    actions.innerHTML = cardAction(game) + arrow;
    bindCardHeaderActions(card, game);
  }
  bindRouteControls(card, game);
  restoreGameViewAnchor(anchor);
  if (focusSelector) card.querySelector(focusSelector)?.focus({ preventScroll: true });
}
function bindCardHeaderActions(card, game) {
  const id = game.id, install = card.querySelector('.install-btn');
  if (install) install.onclick = event => { event.stopPropagation(); void applyCardRoute(game); };
  const sourceButton = card.querySelector('.payload-open-btn');
  if (sourceButton) sourceButton.onclick = event => { event.stopPropagation(); switchView('addons'); $('choosePayloadSourceBtn').focus(); };
  const launch = card.querySelector('.launch-btn');
  const feederRecovery = card.querySelector('.feeder-recover-btn');
  if (feederRecovery) feederRecovery.onclick = event => { event.stopPropagation(); void runAction(() => window.manager.restoreFeeder(id), 'Feeder 已恢复并卸载；一键准备记录如仍存在，请继续恢复准备', true, id); };
  if (launch) launch.onclick = event => { event.stopPropagation(); runAction(() => window.manager.launch(id), '已发起游戏启动，请核对游戏窗口', false, id); };
  const rename = card.querySelector('.rename-game-btn');
  if (rename) rename.onclick = event => { event.stopPropagation(); confirmRenameGame(id); };
  const dismiss = card.querySelector('.dismiss-game-btn');
  if (dismiss) dismiss.onclick = event => { event.stopPropagation(); confirmDismissGame(id); };
}
function bindRouteControls(card, game) {
  const api = card.querySelector('.game-api-select'), version = card.querySelector('.game-version-select');
  if (api) api.onchange = () => { updateRouteDraft(game, { api: api.value }); refreshRouteControls(card, game, '.game-api-select'); };
  if (version) version.onchange = () => { updateRouteDraft(game, { version: version.value }); refreshRouteControls(card, game, '.game-version-select'); };
  const apply = card.querySelector('.route-apply-btn');
  if (apply) apply.onclick = event => { event.stopPropagation(); void applyCardRoute(game); };
}
async function applyCardRoute(game) {
  if (state.busy || state.installing.has(game.id)) return false;
  const selected = routeSelection(game), submitted = routeDraft(game);
  if (routeNeedsRestore(game, selected) || selected.resolvedApi === 'vulkan' && !feederOwnsVulkan(game) &&
      (!game.vulkan?.packageId || !vulkanSelectionState(game).available)) return false;
  if (selected.resolvedApi === 'dx12' && game.nativeDlssAvailable === false && (game.feeder?.installed || !coreSupportsPresent(game, selected)) && !feederSelectionState(game, selected).available) return false;
  setInstallBusy(game.id, true);
  try {
    return await runConfirmedAction(async allowAntiCheat => {
      const feeder = isFeederRoute(game, selected);
      const result = feeder && game.feeder?.installed
        ? await window.manager.installFeeder(game.id, { api: selected.api, allowAntiCheat })
        : !game.installed
          ? await window.manager.prepareGame(game.id, { api: selected.api, version: selected.version, route: feeder ? 'feeder' : 'native', allowAntiCheat })
          : await window.manager.applyGameRoute(game.id, { api: selected.api, version: selected.version, allowAntiCheat });
      // Keep failed or superseded drafts. Clear only the exact successful
      // submission, before the action's list refresh renders the saved state.
      if (result?.ok === true && routeDraft(game) === submitted) state.routeDrafts.delete(game.id);
      return result;
    }, game.installed || game.vulkan?.installed ? '设置已应用，核心已更新' : '一键准备完成，请核对各项结果', true, game.id);
  } finally { setInstallBusy(game.id, false); }
}

function detectedApiResolution(chosen) {
  return { ...(chosen?.detectedApiResolution || {}),
    api: globalThis.ManagerOperationApi.resolveOperationApi({ chosen }, { api: 'auto' }).detectedApi };
}

function apiControls(game) {
  if (!game.chosen) return '';
  const selection = routeSelection(game), resolution = { api: selection.resolvedApi };
  const detected = detectedApiResolution(game.chosen);
  const selected = selection.api;
  const knownApis = Array.isArray(game.chosen.supportedApis) && game.chosen.supportedApis.length
    ? new Set(game.chosen.supportedApis) : null;
  const detectedLabel = detected.api === 'dx11' ? 'DX11 桥接' : detected.api === 'dx12' ? 'DX12' : API_LABELS[detected.api] || 'API 待确认';
  const options = [['auto', `${detectedLabel}（自动）`],
    ['dx12', 'DX12（无需桥接）'], ['dx11', 'DX11 桥接'],
    ['vulkan', 'Vulkan'], ['dx10', 'DirectX 10（暂不支持 NR）'],
    ['dx9', 'DirectX 9（暂不支持 NR）'], ['opengl', 'OpenGL（暂不支持 NR）']]
    .filter(([id]) => !knownApis || id === 'auto' || knownApis.has(id) || id === selected)
    .map(([id, label]) => `<option value="${id}"${id === selected ? ' selected' : ''}${knownApis && id !== 'auto' && !knownApis.has(id) ? ' disabled' : ''}>${escapeHtml(label)}</option>`).join('');
  const deployment = resolution.api === 'dx11' ? '兼容桥接随 DirectX 11 自动部署。'
    : resolution.api === 'dx12' ? 'DirectX 12 无需兼容桥接。'
      : resolution.api === 'vulkan' ? (vulkanSelectionState(game).available ? 'Vulkan 使用独立试验桥接，不部署 DirectX 兼容组件。' : 'Vulkan 试验桥接当前不可用。')
        : ['dx9', 'dx10', 'opengl', 'unsupported'].includes(resolution.api) ? '当前 API 暂不支持 NR，不部署兼容桥接。' : 'API 待确认，暂不部署兼容桥接。';
  const evidence = (detected.evidence || []).join('；');
  const entryMismatch = detected.source === 'game-entry' && selected !== 'auto' && selected !== detected.api
    ? `<p class="config-note" role="status">此 EXE 的已知入口为 ${escapeHtml(API_LABELS[detected.api] || detected.api)}；切换下拉框不会切换程序入口。请通过“选择 EXE”选择对应入口。${escapeHtml(evidence)}</p>` : '';
  const syncNote = game.chosen.apiSettings?.canSync === true
    ? `<p class="config-note">自动跟随游戏当前图形设置。选择 DX12 或 Vulkan 并应用，会同步游戏设置，下次启动使用所选 API；请先关闭游戏。${selected !== 'auto' && game.chosen.apiSettings.api && selected !== game.chosen.apiSettings.api ? `游戏当前保存为 ${escapeHtml(API_LABELS[game.chosen.apiSettings.api])}，与此处选择不同；点击“应用设置”后同步，或选择自动跟随游戏。` : ''}</p>`
    : game.chosen.apiSettings?.kind === 'rdr2-system-xml' ? '<p class="config-note">已识别游戏支持 DX12 和 Vulkan；当前图形设置文件无法安全读取，选择只配置插件路线，管理器不会改写游戏设置。首次运行游戏并保存后，请重新扫描以重新尝试读取。</p>' : '';
  return `<div class="config-block api-config-block"><h4>游戏图形 API</h4><div class="control-row"><select class="game-api-select" aria-label="游戏图形 API">${options}</select></div><p class="api-route-status">${escapeHtml(deployment)}</p>${syncNote}${entryMismatch}<details class="api-help"><summary>检测与桥接说明</summary><p>自动项展示检测结果；可手动改为实际使用的 API，桥接随选择自动处理。API 与核心版本一起应用，选择绑定当前 EXE 保存，重新扫描不会覆盖；不会替你修改游戏启动参数。</p>${evidence ? `<p>检测线索：${escapeHtml(evidence)}</p>` : ''}</details></div>`;
}

function addonVersionRow(game) {
  const selected = routeSelection(game).version;
  const options = versionOptionsMarkup(selected, Boolean(game.installed), game);
  const installed = game.installed && game.addonVersion;
  const replacement = installed ? catalogReplacement(installed) : null;
  const installedNote = installed ? `<p class="config-note installed-version-note">已安装：${escapeHtml(coreVersionLabel(installed))}${replacement ? `；可更新为 ${escapeHtml(coreVersionLabel(replacement))}。` : '。'}点击“应用设置”后才会更换核心。</p>` : '';
  return `<div class="control-row addon-version-row"><label>${installed ? '应用核心版本' : '核心版本'}</label><select class="game-version-select" aria-label="核心版本">${options}</select></div>${installedNote}`;
}

function gameApiLabel(chosen) {
  const resolution = chosen && chosen.apiResolution;
  if (!resolution) return chosen && chosen.apiLabel || 'API 未确认';
  const label = resolution.api === 'dx11' ? 'DX11 桥接' : resolution.api === 'dx12' ? 'DX12' : API_LABELS[resolution.api] || 'API 待确认';
  return `${label}${resolution.source === 'override' ? '（已指定）' : ['dx11', 'dx12', 'vulkan'].includes(resolution.api) ? '（自动）' : ''}`;
}

function vulkanVersionOption(game) {
  const version = typeof game?.vulkan?.packageId === 'string' ? game.vulkan.packageId : '';
  return `<option value="${escapeHtml(version)}" selected>${escapeHtml(vulkanCoreLabel(game))}</option>`;
}
function vulkanRouteMarkup(game) {
  const info = game.vulkan || {};
  const version = typeof info.packageId === 'string' ? info.packageId : '';
  const installed = info.installed === true;
  const selection = vulkanSelectionState(game), available = selection.available;
  const recovery = info.needsRecovery === true;
  const status = recovery ? '需恢复' : installed ? '已安装' : available ? '可准备' : '暂不可用';
  const reason = !available && selection.reason ? selection.reason :
    (!available ? '当前没有通过校验的 Vulkan 配套运行资产。' : '');
  return `<div class="config-block core-selection vulkan-route-block"><h4>Addon 核心版本</h4>
    <div class="control-row addon-version-row"><label>配套核心</label><select class="game-version-select" aria-label="Vulkan 配套核心版本" disabled>${vulkanVersionOption(game)}</select></div>
    <p class="config-note"><span class="badge ${!recovery && (available || installed) ? 'good' : 'bad'}">${status}</span> Vulkan 使用按游戏保存的独立配套；当前核心为 ${escapeHtml(info.coreVersion ? coreVersionLabel(info.coreVersion) : '待确认')}。其他核心版本的 Vulkan 支持尚未验证。</p>
    ${reason ? `<p class="config-note launch-error" role="status">${escapeHtml(reason)}</p>` : ''}
    <p class="config-note">提供 NR 画面增强，通过画面和深度估算运动。实际效果请在游戏内验证。</p></div>`;
}

const REFRAMEWORK_PROFILE = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
function reframeworkProfile(game) {
  const profile = game?.reframework?.profile;
  return game?.reframework?.matched === true && typeof profile === 'string' && REFRAMEWORK_PROFILE.test(profile) ? profile : '';
}
function isReframeworkGame(game) {
  return Boolean(reframeworkProfile(game));
}

function reframeworkHostMarkup(game) {
  const profile = reframeworkProfile(game);
  return profile
    ? `<div class="compat-action reframework-host" data-reframework-profile="${escapeHtml(profile)}" aria-label="卡普空 RE 引擎兼容"><div class="reframework-heading"><strong>卡普空 RE 引擎兼容</strong><span class="badge">读取中</span></div><span class="compat-action-note">REFramework 01417 · 正在检查</span></div>`
    : '';
}

function unknownReEngineMarkup(game) {
  if (isReframeworkGame(game) || game?.engine?.id !== 're-engine' || game.engine.compatibilityKnown !== false) return '';
  const evidence = Array.isArray(game.engine.evidence) ? game.engine.evidence.map(item => typeof item === 'string' ? item : item?.detail || item?.source || '').filter(Boolean).map(escapeHtml) : [];
  return `<div class="compat-engine-note" role="status"><strong>${escapeHtml(game.engine.label || '卡普空 RE 引擎')}</strong><span>检测到 RE 引擎线索；当前没有已确认的兼容配套，不会自动部署 REFramework。</span>${evidence.length ? `<details><summary>检测依据</summary><p>${evidence.join('；')}</p></details>` : ''}</div>`;
}

function compatibilityRepairMarkup(game, includeD3d12 = true) {
  const reframework = reframeworkHostMarkup(game) || unknownReEngineMarkup(game);
  if (!includeD3d12 && !reframework) return '';
  const d3d12 = includeD3d12 ? `<div class="compat-action d3d12-compat-action"><div class="compat-action-heading"><strong>D3D12 兼容修复</strong><span class="badge">手动</span></div><button class="button d3d12-btn">${game.d3d12Route ? '撤销 D3D12 修复' : '使用 D3D12 修复'}</button><details class="compat-help"><summary>适用说明</summary><p>针对异环等部分 DX12 网游的加载报错、DXGI 入口冲突。只适用于 DX12，保留原文件，可随时撤销。</p></details></div>` : '';
  return `<div class="route-advanced"><h4>兼容修复</h4><div class="compat-action-grid">${d3d12}${reframework}</div></div>`;
}

function reframeworkMessage(value) {
  if (typeof value === 'string') return value;
  return value && typeof value.message === 'string' ? value.message : '';
}

function reframeworkCardMarkup(info, busy = false, error = '') {
  const stateValue = info && typeof info === 'object' ? info : {};
  const loader = stateValue.loader && typeof stateValue.loader === 'object' ? stateValue.loader : {};
  const config = stateValue.config && typeof stateValue.config === 'object' ? stateValue.config : {};
  const external = stateValue.ready === true && loader.ownership === 'external';
  const owned = stateValue.ready === true && loader.ownership === 'owned';
  const needsRecovery = stateValue.needsRecovery === true;
  const status = needsRecovery ? '需恢复' : external ? '已使用现有框架' : stateValue.ready === true ? '已就绪' : stateValue.canPrepare === true ? '待安装' : '需处理';
  const badge = needsRecovery ? 'bad' : stateValue.ready === true ? 'good' : stateValue.canPrepare === true ? '' : 'bad';
  const blockers = Array.isArray(stateValue.blockers) ? stateValue.blockers.map(reframeworkMessage).filter(Boolean) : [];
  const warnings = Array.isArray(stateValue.warnings) ? stateValue.warnings.map(reframeworkMessage).filter(Boolean) : [];
  const action = needsRecovery
    ? `<button class="button primary reframework-recover-btn" type="button"${busy ? ' disabled aria-busy="true"' : ''}>${busy ? '正在恢复…' : '恢复未完成操作'}</button>`
    : stateValue.canPrepare === true && stateValue.ready !== true
    ? `<button class="button primary reframework-prepare-btn" type="button"${busy ? ' disabled aria-busy="true"' : ''}>${busy ? '正在准备…' : '准备 REFramework'}</button>`
    : owned
      ? `<button class="button reframework-restore-btn" type="button"${busy ? ' disabled aria-busy="true"' : ''}>${busy ? '正在撤销…' : '撤销 REFramework'}</button>`
      : '';
  const configNote = config.existingStoragePreferred === true || config.effective
    ? '保留已有配置；准备和撤销不会删除玩家设置。'
    : '为此游戏准备兼容设置，并保留玩家已有配置。';
  return `<div class="reframework-heading"><strong>卡普空 RE 引擎兼容</strong><span class="badge ${badge}">${status}</span></div>
    <span class="compat-action-note">REFramework 01417 · 已检测到兼容配套</span>
    ${action || ''}
    <details class="compat-help"><summary>适用说明</summary><p>一键安装时自动准备 REFramework。${configNote}${external ? ' 当前使用游戏已有的框架，管理器不会取得删除权。' : ''}</p></details>
    ${blockers.length ? `<ul class="reframework-messages" aria-label="需要处理">${blockers.map(message => `<li>${escapeHtml(message)}</li>`).join('')}</ul>` : ''}
    ${warnings.length ? `<ul class="reframework-messages warning" aria-label="提示">${warnings.map(message => `<li>${escapeHtml(message)}</li>`).join('')}</ul>` : ''}
    ${error ? `<p class="config-note launch-error reframework-error" role="alert">${escapeHtml(error)}</p>` : ''}`;
}

function detailKey(game) {
  return `${game.id}:${String(game.chosen?.path || game.dir || '').toLowerCase()}`;
}

function gameDetail(game) {
  if (typeof window === 'object' && typeof window.manager?.assessGame === 'function') return `<div class="game-detail gp-inline" data-game-detail="${escapeHtml(game.id)}"></div>`;
  const key = detailKey(game);
  const active = state.detailTabs.get(key) === 'graphics' ? 'graphics' : 'enhance';
  const vulkan = isVulkanRoute(game);
  const installed = routeInstalled(game);
  const supported = routeSupported(game);
  const title = supported ? '安装条件已确认'
    : game.supportCode === 'ERR_API_SELECTION_REQUIRED' ? '等待应用 API 与核心' : '安装前需要处理';
  const installDetail = supported
    ? (vulkan ? '已匹配固定 Vulkan 试验组件，可使用上方“一键安装”。' : isFeederRoute(game) ? '已匹配无原生 DLSS 的 Feeder 试验配套，可使用上方“一键准备”。' : payloadReadyForHardware() ? `已匹配 ${hardwareLabel()} 组件，可使用上方“一键安装”。` : '请到“组件管理”选择完整安装组件，再返回安装。')
    : game.supportCode === 'ERR_API_SELECTION_REQUIRED' ? '请在上方选择游戏实际使用的 API 与核心，然后点击“应用并安装”。'
    : vulkan ? game.vulkan?.reason || 'Vulkan 试验桥接当前不可用。'
    : isFeederRoute(game) ? game.feeder?.reason || 'Feeder 试验配套当前不可用。'
    : game.supportText || '请先选择游戏实际运行的 EXE。';
  const routeRepair = vulkan || isFeederRoute(game) ? '' : compatibilityRepairMarkup(game, true);
  const maintenance = '<button class="button maintenance-inline-btn" type="button">维护与恢复</button>';
  const installationStatus = installed ? `<div class="config-block component-block"><div class="config-title"><div><h4>安装状态</h4><p class="section-caption">文件与安装记录</p></div><span class="component-summary" role="status">检查中</span></div><div class="component-body">正在检查…</div><div class="diagnostic-actions">${maintenance}</div>${routeRepair}</div>` : '';
  const launchJump = game.nativeDlssAvailable === false && game.nativeFgAvailable === false ? '<p class="config-note">未检测到游戏自带的 DLSS 超分或补帧组件；当前提供画面增强设置。</p>' : '<button class="button subtle launch-jump-btn" type="button">调整超分补帧</button>';
  const preinstallCompatibility = !installed && !vulkan ? compatibilityRepairMarkup(game, false) : '';
  const nr = installed ? `<div class="enhancement-layout">
    <div class="config-block enhancement-controls">
      <div class="config-title"><div><h4>画面设置</h4><p class="section-caption">调整后自动保存到这个游戏</p></div><span class="save-state" role="status">正在读取…</span></div>
      <div class="control-row"><label>风格</label><div class="segmented style-segment"><button data-value="0">默认</button><button data-value="1">自然</button><button data-value="2">电影</button></div><span></span></div>
      <div class="control-row"><label title="模型内部强度，默认 1.00，范围 0–2。">模型强度</label><div class="range-wrap"><input class="nr-model-strength" aria-label="NR 模型强度" type="range" min="0" max="2" step="0.01"><span class="value-pill nr-model-value">1.00</span></div><span></span></div>
      <div class="control-row"><label title="对应核心 NR 效果倍率，默认 1.00，范围 0–4。">额外强度</label><div class="range-wrap"><input class="nr-effect-strength" aria-label="NR 额外强度" type="range" min="0" max="4" step="0.01"><span class="value-pill nr-effect-value">1.00</span></div><span></span></div>
      <p class="config-note">模型强度影响内部处理；额外强度控制最终混合。默认均为 1.00。</p>
      <div class="skin-settings">
        <div class="control-row"><label title="模型内部的皮肤结构控制，不是独立人脸遮罩。">皮肤结构保护</label><span class="skin-summary">读取中</span><input class="switch nr-mask" aria-label="皮肤结构保护" type="checkbox"></div>
        <div class="control-row skin-strength-row"><label>保护强度</label><div class="range-wrap"><input class="nr-skin-strength" aria-label="皮肤结构强度" type="range" min="-1" max="2" step="0.01"><span class="value-pill nr-skin-value">关闭</span></div><span></span></div>
        <p class="config-note">对应模型内部控制，不等于独立人脸遮罩。NR 工作分辨率与色调跟随在游戏内 ReShade 面板调整。</p>
      </div>
      <div class="config-actions"><button class="button subtle default-btn">恢复 NR 默认</button></div>
    </div>
    <aside class="enhancement-sidebar">${installationStatus}<div class="config-block enhancement-guide"><h4>快捷操作</h4><p class="config-note">用 F6 对比增强前后的画面，实际效果以游戏内表现为准。</p>
      <div class="shortcut-block"><div class="shortcut-row"><label>NR 效果切换</label><button class="button subtle nr-hotkey-btn" disabled>F6 开关</button></div><div class="shortcut-row"><label>ReShade 菜单</label><button class="button subtle reshade-hotkey-btn">Home</button></div><p class="config-note">新安装默认按 Home 打开菜单；保留已有自定义键，修改后下次启动游戏生效。</p></div>
      ${launchJump}
    </div></aside>
  </div>` : `<div class="config-block detail-empty"><h4>${title}</h4><p class="config-note">${escapeHtml(installDetail)}</p><p class="config-note">安装完成后，可在这里调整风格和增强强度。</p>${game.chosen ? maintenance : ''}${preinstallCompatibility}</div>`;
  const graphics = game.chosen ? '<section class="launch-settings-host" aria-label="超分补帧启动设置"><p class="config-note">正在读取超分补帧设置…</p></section>'
    : '<div class="config-block detail-empty"><h4>请先确认游戏 EXE</h4><p class="config-note">选择实际运行程序后，才能读取此游戏的超分补帧设置。</p></div>';
  const route = `<details class="route-options"${installed ? '' : ' open'}><summary>安装配置 · ${escapeHtml(routeSelection(game).resolvedApi.toUpperCase())}${isFeederRoute(game) ? ' · Feeder' : ''}</summary><div class="route-layout game-route-controls">${routeControlsMarkup(game)}</div></details>`;
  const tabs = [['enhance', '画面设置'], ['graphics', '超分补帧']];
  return `<div class="game-detail" data-game-detail="${escapeHtml(game.id)}" data-detail-key="${escapeHtml(key)}">
    <div class="preparation-host" aria-label="安装恢复状态" hidden></div>
    ${game.feeder?.launchWarning ? `<p class="game-launch-notice" role="status">${escapeHtml(game.feeder.launchWarning)}</p>` : ''}
    <div class="detail-tabs" role="tablist" aria-label="游戏设置分类">${tabs.map(([id, label]) => `<button id="detail-${encodeURIComponent(game.id)}-${id}-tab" type="button" data-detail-tab="${id}" aria-controls="detail-${encodeURIComponent(game.id)}-${id}-panel" aria-selected="${id === active}" tabindex="${id === active ? 0 : -1}">${label}</button>`).join('')}</div>
    ${[['enhance', route + nr], ['graphics', graphics]].map(([id, content]) => `<section id="detail-${encodeURIComponent(game.id)}-${id}-panel" data-detail-panel="${id}" aria-labelledby="detail-${encodeURIComponent(game.id)}-${id}-tab"${id !== active ? ' hidden' : ''}>${content}</section>`).join('')}
    <div class="detail-footer"><span class="path-line" title="${escapeHtml(game.chosen?.path || game.dir)}">${escapeHtml(game.chosen?.path || game.dir)}</span><button class="button subtle open-folder-btn">打开目录</button></div>
  </div>`;
}

function preparationMarkup(game, pending = null) {
  if (!pending?.pending) return '';
  return `<p class="launch-error" role="alert">上次安装未完成，恢复记录已保留。${escapeHtml(pending.failure?.message || '')}</p><button class="button preparation-recover-btn" type="button">恢复未完成准备</button>`;
}
async function loadPreparationCard(host, game) {
  if (!host || !window.manager.inspectPreparation) return;
  try {
    const pending = unwrap(await window.manager.inspectPreparation(game.id));
    if (host.isConnected === false) return;
    host.innerHTML = preparationMarkup(game, pending);
    host.hidden = !pending?.pending;
    bindPreparationActions(host, game);
  } catch (error) { if (host.isConnected !== false) { host.hidden = false; host.innerHTML = `<p class="launch-error" role="alert">安装恢复状态读取失败：${escapeHtml(error.message)}</p><button class="button subtle preparation-check-btn" type="button">重新检查</button>`; bindPreparationActions(host, game); } }
}
function bindPreparationActions(host, game) {
  const check = host.querySelector('.preparation-check-btn');
  if (check) check.onclick = () => loadPreparationCard(host, game);
  const recover = host.querySelector('.preparation-recover-btn');
  if (recover) recover.onclick = () => runAction(() => window.manager.recoverPreparation(game.id), '本次准备内容已恢复', true, game.id);
}


function renderGames(options = {}) {
  const previousExpanded = options?.preserveExpanded === true && typeof window.manager.assessGame !== 'function'
    ? [...document.querySelectorAll('.game-card')].find(card => card.dataset.id === state.expanded) : null;
  const rows = visibleGames();
  updateGameListMeta(rows);
  $('gameList').innerHTML = rows.map(game => `<article class="game-card${state.expanded === game.id ? ' expanded' : ''}" data-id="${game.id}">
    <div class="game-card-head">
      ${poster(game)}
      <div class="game-meta"><div class="game-title"><h3>${escapeHtml(game.name)}</h3>${supportBadge(game)}</div><p>${escapeHtml(game.launcher)} · ${escapeHtml(game.chosen ? `${gameApiLabel(game.chosen)} / ${game.chosen.bitness} 位` : game.supportText)}</p>${game.chosen?.path ? `<p class="game-exe-path" title="${escapeHtml(game.chosen.path)}">${escapeHtml(game.chosen.path)}</p>` : ''}</div>
      <div class="card-action">${cardAction(game)}<button class="expand-arrow" type="button" aria-label="展开或收起游戏详情" aria-expanded="${state.expanded === game.id}"></button></div>
    </div>
    ${state.expanded === game.id ? gameDetail(game) : ''}
  </article>`).join('');
  let reusedExpanded = false;
  if (previousExpanded) {
    const replacement = [...document.querySelectorAll('.game-card')].find(card => card.dataset.id === previousExpanded.dataset.id);
    if (replacement) {
      replacement.replaceWith(previousExpanded); reusedExpanded = true;
      const currentGame = state.games.find(game => game.id === previousExpanded.dataset.id);
      if (currentGame && typeof window.manager.assessGame !== 'function') refreshRouteControls(previousExpanded, currentGame);
    }
  }
  bindGameCards();
  for (const [id, entry] of inlineGameDetails) if (!state.games.some(game => game.id === id)) {
    entry.controller.dispose(); inlineGameDetails.delete(id);
  }
  if (state.expanded && !reusedExpanded) loadExpanded(state.expanded);
  renderRepairSelect();
  renderFeedbackSelect();
}

function captureGameViewAnchor(gameId = state.expanded) {
  const view = $('view-games');
  if (!view?.classList.contains('active') || !gameId) return null;
  const card = [...document.querySelectorAll('.game-card')].find(row => row.dataset.id === gameId);
  if (!card) return null;
  const active = document.activeElement;
  const focusSelector = active && card.contains(active)
    ? ['.route-apply-btn', '.game-api-select', '.game-version-select', '.d3d12-btn',
      '.reframework-prepare-btn', '.reframework-restore-btn', '.reframework-recover-btn', '.expand-arrow']
      .find(selector => active.matches?.(selector)) || null
    : null;
  const anchor = focusSelector ? active : card.querySelector('.game-card-head');
  if (!anchor?.getClientRects().length) return null;
  return { gameId, focusSelector, top: anchor.getBoundingClientRect().top };
}

function restoreGameViewAnchor(saved) {
  if (!saved) return;
  const view = $('view-games');
  const restore = () => {
    if (!view?.classList.contains('active')) return;
    const card = [...document.querySelectorAll('.game-card')].find(row => row.dataset.id === saved.gameId);
    const anchor = saved.focusSelector ? card?.querySelector(saved.focusSelector) : card?.querySelector('.game-card-head');
    if (!anchor?.getClientRects().length) return;
    view.scrollTop += anchor.getBoundingClientRect().top - saved.top;
    if (saved.focusSelector) anchor.focus({ preventScroll: true });
  };
  restore();
  requestAnimationFrame(() => requestAnimationFrame(restore));
}

function visualKey(game) {
  return String(game && (game.dir || game.id || `${game.launcher}:${game.name}`) || '').toLowerCase();
}

function mergeGameVisuals(previous, next) {
  const cached = new Map((previous || []).map(game => [visualKey(game), game]));
  return (next || []).map(game => {
    const old = cached.get(visualKey(game));
    return {
      ...game,
      poster: game.poster || (old && old.poster) || null,
      icon: old?.iconCheckedFor === (game.chosen?.path || game.id) ? old.icon : game.icon || old?.icon || null,
      iconCheckedFor: old?.iconCheckedFor === (game.chosen?.path || game.id) ? old.iconCheckedFor : null
    };
  });
}

function updateGameListMeta(rows = visibleGames()) {
  const ordinary = state.games.filter(game => !game.hoyoManaged && !state.hoyoGameIds.has(game.id));
  $('gameSummary').textContent = `已找到 ${ordinary.length} 个游戏 · 支持 ${ordinary.filter(routeSupported).length} 个`;
  const hasFilter = $('searchInput').value.trim() || $('gameFilter').value !== 'all';
  $('emptyState').querySelector('h3').textContent = hasFilter ? '没有匹配的游戏' : '还没有找到游戏';
  $('emptyState').querySelector('p').textContent = hasFilter ? '换个关键词或筛选条件试试。' : '先自动扫描 Steam、Epic、GOG；也可以选择游戏文件夹或实际运行 EXE。';
  $('emptyAddBtn').classList.toggle('hidden', Boolean(hasFilter));
  $('emptyState').classList.toggle('hidden', rows.length !== 0);
}

function bindGameCards() {
  document.querySelectorAll('.launch-jump-btn').forEach(button => {
    button.onclick = event => {
      event.stopPropagation();
      const host = button.closest('.game-card')?.querySelector('.launch-settings-host');
      if (!host) return;
      button.closest('.game-detail')?.detailTabController?.select('graphics');
      const view = host.closest('.view');
      if (view) view.scrollTop += host.getBoundingClientRect().top - view.getBoundingClientRect().top - 12;
      host.querySelector('select, button')?.focus({ preventScroll: true });
    };
  });
  document.querySelectorAll('#gameList .game-card').forEach(card => {
    const id = card.dataset.id;
    const game = state.games.find(row => row.id === id);
    if (typeof window.manager.assessGame === 'function') {
      mountInlineDetail(card, game);
      card.querySelector('.game-card-head').onclick = event => {
        if (event.target.closest('.unified-launch-btn')) return;
        if (state.expanded === id) { state.expanded = null; renderGames(); } else openGamePage(id);
      };
      const launch = card.querySelector('.unified-launch-btn');
      if (launch) launch.onclick = event => { event.stopPropagation(); void openGamePage(id)?.launchGame(); };
      return;
    }
    const detail = card.querySelector('.game-detail');
    if (detail?.querySelector('.preparation-host')) void loadPreparationCard(detail.querySelector('.preparation-host'), game);
    if (detail && !detail.detailTabController && window.GameDetailTabs) {
      const mountGraphics = () => {
        const host = detail.querySelector('.launch-settings-host');
        if (host && window.launchSettingsUi && !host.launchSettingsController) window.launchSettingsUi.mount(host, id, {nativeDlssAvailable:game?.nativeDlssAvailable,nativeFgAvailable:game?.nativeFgAvailable});
      };
      detail.detailTabController = window.GameDetailTabs.mount(detail, {
        initial: state.detailTabs.get(detail.dataset.detailKey) === 'graphics' ? 'graphics' : 'enhance',
        onSelect: tab => { state.detailTabs.set(detail.dataset.detailKey, tab); if (tab === 'graphics') mountGraphics(); }
      });
      if (detail.detailTabController.active() === 'graphics') mountGraphics();
    }
    card.querySelector('.game-card-head').onclick = event => {
      if (event.target.closest('.install-btn') || event.target.closest('.launch-btn') || event.target.closest('.feeder-recover-btn') || event.target.closest('.rename-game-btn') || event.target.closest('.dismiss-game-btn')) return;
      state.expanded = state.expanded === id ? null : id;
      renderGames();
    };
    bindCardHeaderActions(card, game);
    bindRouteControls(card, game);
    const openFolder = card.querySelector('.open-folder-btn');
    if (openFolder) openFolder.onclick = () => window.manager.openFolder(id);
    const maintenance = card.querySelector('.maintenance-inline-btn');
    if (maintenance) maintenance.onclick = () => openMaintenance(id);
    const d3d12 = card.querySelector('.d3d12-btn');
    if (d3d12) d3d12.onclick = event => { event.stopPropagation(); confirmD3D12(id); };
    const defaultButton = card.querySelector('.default-btn');
    if (defaultButton) defaultButton.onclick = async () => {
      await runAction(() => window.manager.restoreDefault(id), '已恢复插件默认设置', false);
      await loadExpanded(id);
    };
  });
}

function reframeworkErrorText(error) {
  const message = error?.message || '兼容组件操作失败。';
  return `${message}${error?.code ? ` [${error.code}]` : ''}`;
}

function bindReframeworkCard(root, id) {
  const host = root.querySelector('.reframework-host');
  if (!host || host.dataset.busy === 'true') return;
  const run = async action => {
    if (host.dataset.busy === 'true') return;
    host.dataset.busy = 'true';
    host.innerHTML = reframeworkCardMarkup(host.reframeworkInfo, true);
    let operationError = '';
    const captureError = error => { operationError = reframeworkErrorText(error); };
    const completed = action === 'prepare'
      ? await runConfirmedAction(
        allowAntiCheat => window.manager.prepareReframework(id, { allowAntiCheat }),
        '兼容组件已安装', false, id, captureError)
      : action === 'restore' ? await runAction(
        () => window.manager.restoreReframework(id),
        '兼容组件已撤销，玩家配置已保留', false, id, captureError)
        : await runAction(
          () => window.manager.recoverReframework(id),
          '未完成操作已恢复', false, id, captureError);
    if (!host.isConnected) return;
    host.dataset.busy = 'false';
    await loadReframeworkCard(root, id, completed ? '' : operationError);
  };
  const prepare = host.querySelector('.reframework-prepare-btn');
  if (prepare) prepare.onclick = event => { event.stopPropagation(); void run('prepare'); };
  const restore = host.querySelector('.reframework-restore-btn');
  if (restore) restore.onclick = event => { event.stopPropagation(); void run('restore'); };
  const recover = host.querySelector('.reframework-recover-btn');
  if (recover) recover.onclick = event => { event.stopPropagation(); void run('recover'); };
}

async function loadReframeworkCard(root, id, operationError = '') {
  const host = root.querySelector('.reframework-host');
  if (!host) return;
  const revision = Number(host.dataset.loadRevision || 0) + 1;
  host.dataset.loadRevision = String(revision);
  if (!host.reframeworkInfo) {
    host.innerHTML = '<div class="reframework-heading"><strong>卡普空 RE 引擎兼容</strong><span class="badge">读取中</span></div><span class="compat-action-note">REFramework 01417 · 正在检查</span>';
  }
  try {
    const info = unwrap(await window.manager.readReframework(id));
    if (!host.isConnected || Number(host.dataset.loadRevision) !== revision) return;
    host.reframeworkInfo = info;
    host.innerHTML = reframeworkCardMarkup(info, false, operationError);
    bindReframeworkCard(root, id);
  } catch (error) {
    if (!host.isConnected || Number(host.dataset.loadRevision) !== revision) return;
    host.innerHTML = reframeworkCardMarkup(host.reframeworkInfo, false,
      operationError || `读取失败：${reframeworkErrorText(error)}`);
    bindReframeworkCard(root, id);
  }
}

async function loadExpanded(id) {
  if (typeof window.manager.assessGame === 'function') return;
  const loadToken = (state.expandedLoadToken || 0) + 1;
  state.expandedLoadToken = loadToken;
  const root = document.querySelector(`[data-game-detail="${id}"]`);
  if (!root) return;
  void loadReframeworkCard(root, id);
  if (!root.querySelector('.nr-mask')) return;
  const nrControls = root.querySelectorAll('.nr-mask, .style-segment button, .nr-model-strength, .nr-effect-strength, .nr-skin-strength, .default-btn');
  const indicator = root.querySelector('.save-state');
  const hotkeyButton = root.querySelector('.reshade-hotkey-btn');
  nrControls.forEach(control => { control.disabled = true; });
  indicator.textContent = '正在读取…'; indicator.classList.remove('error');
  root.querySelector('.nr-read-error')?.remove();
  hotkeyButton.disabled = true; hotkeyButton.textContent = '正在读取…'; hotkeyButton.title = '';
  const [nrResult, diagnosticResult, hotkeyResult] = await Promise.allSettled([
    () => window.manager.readNr(id), () => window.manager.diagnose(id), () => window.manager.readHotkeys(id)
  ].map(read => Promise.resolve().then(read).then(unwrap)));
  if (state.expandedLoadToken !== loadToken || state.expanded !== id || !root.isConnected) return;
  const failureText = result => {
    const error = result.reason || {};
    return `${error.message || '返回的读取结果无效。'}${error.code ? ` [${error.code}]` : ''}`;
  };
  if (nrResult.status === 'fulfilled' && nrResult.value && typeof nrResult.value === 'object') {
    const settings = nrResult.value;
    nrControls.forEach(control => { control.disabled = false; });
    root.querySelector('.nr-mask').checked = Boolean(settings.AutoMask);
    root.querySelector('.skin-summary').textContent = settings.AutoMask ? '已开启' : '已关闭';
    indicator.textContent = '已读取设置'; indicator.classList.remove('error');
    root.querySelectorAll('.style-segment button').forEach(b => b.classList.toggle('active', Number(b.dataset.value) === Number(settings.Style)));
    const intensity = Number(settings.Intensity ?? 1);
    const model = root.querySelector('.nr-model-strength');
    const modelValue = root.querySelector('.nr-model-value');
    if (model) model.value = String(intensity);
    if (modelValue) modelValue.textContent = intensity.toFixed(2);
    const effect = root.querySelector('.nr-effect-strength');
    const effectValue = root.querySelector('.nr-effect-value');
    const effectSupported = settings.capabilities?.TransferStrength === true && settings.capabilities?.PostTransferStrength === true;
    if (effect) {
      effect.value = String(settings.TransferStrength ?? 1);
      effect.disabled = !effectSupported;
      effect.title = effectSupported ? 'NR 效果倍率；调整时同步最终混合强度。' : '当前核心配置未提供额外强度参数。';
    }
    if (effectValue) effectValue.textContent = effectSupported ? Number(settings.TransferStrength ?? 1).toFixed(2) : '未提供';
    const skin = root.querySelector('.nr-skin-strength');
    const skinValue = root.querySelector('.nr-skin-value');
    if (skin) skin.value = String(settings.SkinStructureStrength ?? -1);
    if (skinValue) skinValue.textContent = Number(settings.SkinStructureStrength ?? -1) < 0 ? '关闭' : Number(settings.SkinStructureStrength).toFixed(2);
    if (skin) skin.disabled = !settings.AutoMask;
    bindNrControls(root, id);
  } else {
    indicator.textContent = '读取失败'; indicator.classList.add('error');
    root.querySelector('.skin-summary').textContent = '未读取';
    const notice = document.createElement('p');
    notice.className = 'config-note launch-error nr-read-error'; notice.setAttribute('role', 'alert');
    notice.textContent = `NR 设置读取失败：${failureText(nrResult)}`;
    indicator.closest('.config-title').after(notice);
  }
  if (diagnosticResult.status === 'fulfilled' && Array.isArray(diagnosticResult.value?.components)) {
    const diagnostic = diagnosticResult.value;
    root.querySelector('.component-body').innerHTML = diagnosticRows(diagnostic.components);
    const problems = diagnostic.components.filter(row => row.ok === false).length;
    root.querySelector('.component-summary').textContent = problems ? `${problems} 项需要处理` : '文件检查通过';
  } else {
    root.querySelector('.component-summary').textContent = '诊断读取失败';
    root.querySelector('.component-body').innerHTML = `<p class="launch-error">${escapeHtml(failureText(diagnosticResult))}</p>`;
  }
  if (hotkeyResult.status === 'fulfilled' && hotkeyResult.value && typeof hotkeyResult.value === 'object') {
    hotkeyButton.textContent = hotkeyLabel(hotkeyResult.value.reshade);
    hotkeyButton.disabled = false;
    bindHotkeyControls(root, id, hotkeyResult.value);
  } else {
    hotkeyButton.textContent = '读取失败'; hotkeyButton.title = failureText(hotkeyResult);
  }
  root.querySelector('.nr-hotkey-btn').textContent = 'F6 开关';
}

function queueSetting(id, patch, root) {
  const revision = (state.saveRevisions.get(id) || 0) + 1;
  state.saveRevisions.set(id, revision);
  const indicator = root.querySelector('.save-state');
  if (indicator) { indicator.textContent = '正在保存…'; indicator.classList.remove('error'); }
  state.pendingPatches.set(id, { ...(state.pendingPatches.get(id) || {}), ...patch });
  clearTimeout(state.saveTimers.get(id));
  state.saveTimers.set(id, setTimeout(async () => {
    const pending = state.pendingPatches.get(id) || {};
    state.pendingPatches.delete(id);
    try {
      unwrap(await window.manager.writeNr(id, pending));
      if (indicator && state.saveRevisions.get(id) === revision) {
        indicator.textContent = '已保存'; indicator.classList.remove('error');
      }
    } catch (error) {
      if (indicator && state.saveRevisions.get(id) === revision) { indicator.textContent = '保存失败'; indicator.classList.add('error'); }
      // A newer patch can concern a different field; the earlier failure still matters.
      toast(error.message, true);
    }
  }, 180));
}

function bindNrControls(root, id) {
  root.querySelector('.nr-mask').onchange = e => {
    const enabled = e.target.checked;
    root.querySelector('.skin-summary').textContent = enabled ? '已开启' : '已关闭';
    const skin = root.querySelector('.nr-skin-strength');
    if (skin) skin.disabled = !enabled;
    queueSetting(id, { AutoMask: enabled ? 1 : 0 }, root);
  };
  root.querySelectorAll('.style-segment button').forEach(button => button.onclick = () => {
    root.querySelectorAll('.style-segment button').forEach(b => b.classList.toggle('active', b === button));
    queueSetting(id, { Style: Number(button.dataset.value) }, root);
  });
  const model = root.querySelector('.nr-model-strength');
  const modelValue = root.querySelector('.nr-model-value');
  if (model) model.oninput = () => {
    if (modelValue) modelValue.textContent = Number(model.value).toFixed(2);
    queueSetting(id, { Intensity: Number(model.value) }, root);
  };
  const effect = root.querySelector('.nr-effect-strength');
  const effectValue = root.querySelector('.nr-effect-value');
  if (effect) effect.oninput = () => {
    if (effect.disabled) return;
    const value = Number(effect.value);
    if (effectValue) effectValue.textContent = value.toFixed(2);
    queueSetting(id, { TransferStrength: value, PostTransferStrength: value }, root);
  };
  const skin = root.querySelector('.nr-skin-strength');
  const skinValue = root.querySelector('.nr-skin-value');
  if (skin) skin.oninput = () => {
    const value = Number(skin.value);
    if (skinValue) skinValue.textContent = value < 0 ? '关闭' : value.toFixed(2);
    queueSetting(id, { SkinStructureStrength: value }, root);
  };
}

function bindHotkeyControls(root, id, hotkeys) {
  const button = root.querySelector('.reshade-hotkey-btn');
  if (!button) return;
  button.onclick = event => {
    event.stopPropagation();
    confirmHotkey(id, 'reshade', hotkeys && hotkeys.reshade);
  };
}

async function runAction(work, success, refresh = true, gameId = null, onError = null) {
  if (state.busy) return false;
  setBusy(true);
  try {
    const outcome = await window.executeUiAction(
      () => Promise.resolve(work()).then(unwrap),
      refresh ? () => refreshGames({ gameId }) : null
    );
    if (!outcome.completed) throw outcome.error;
    if (gameId && Array.isArray(outcome.value?.stages)) {
      (state.preparationResults ||= new Map()).set(gameId, outcome.value);
      state.expanded = gameId; renderGames();
    } else if (gameId && (outcome.value?.restored === true || outcome.value?.removed === true) && state.preparationResults?.has(gameId)) {
      state.preparationResults.delete(gameId); renderGames();
    }
    const automaticReframeworkFailure = outcome.value?.reframework?.automatic === true && outcome.value.reframework.ready === false;
    toast(actionSuccessMessage(success, outcome.value), automaticReframeworkFailure);
    if (gameId && outcome.value?.reframework?.automatic === true) {
      const root = document.querySelector(`[data-game-detail="${CSS.escape(gameId)}"]`);
      if (root?.querySelector('.reframework-host')) {
        const error = automaticReframeworkFailure
          ? `自动准备未完成：${reframeworkErrorText(outcome.value.reframework.error)}` : '';
        await loadReframeworkCard(root, gameId, error);
      }
    }
    if (outcome.refreshError) queueRefreshRetry();
    return true;
  } catch (error) {
    if (typeof onError === 'function') onError(error);
    if (!error.silent) {
      if (gameId) {
        state.lastFailureGame = gameId;
        state.feedbackGame = gameId;
        renderFeedbackSelect();
      }
      const code = error.code && error.code !== 'ERR_INTERNAL' ? ` [${error.code}]` : '';
      const hint = gameId ? '；可在“修复”页保存反馈日志' : '';
      const permission = error.details?.recoveryAction === 'restart-elevated' ? '；请在“设置”中选择“以管理员身份重启”后重试' : '';
      toast(`${error.message}${code}${permission}${hint}`, true);
      if (gameId && /^PREPARATION_/.test(error.code || '')) {
        const game = state.games.find(row => row.id === gameId);
        const host = [...document.querySelectorAll('.game-card')].find(card => card.dataset.id === gameId)?.querySelector('.preparation-host');
        if (game && host) void loadPreparationCard(host, game);
      }
    }
    return false;
  }
  finally { setBusy(false); }
}

function queueRefreshRetry(attempt = 0) {
  if (queueRefreshRetry.timer) return;
  queueRefreshRetry.timer = setTimeout(async () => {
    queueRefreshRetry.timer = null;
    try {
      await refreshGames();
    } catch {
      if (attempt < 2) queueRefreshRetry(attempt + 1);
    }
  }, 250 * (attempt + 1));
}

async function refreshGames(options = {}) {
  const anchor = captureGameViewAnchor(options.gameId || state.expanded);
  const response = await (window.manager.listGames ? window.manager.listGames() : window.manager.refresh());
  state.games = mergeGameVisuals(state.games, unwrap(response));
  renderGames();
  restoreGameViewAnchor(anchor);
  scheduleArtworkEnrichment();
  if (state.repairGame && !state.games.some(g => g.id === state.repairGame)) state.repairGame = null;
}

async function runConfirmedAction(work, success, refresh = true, gameId = null, onError = null) {
  return runAction(async () => {
    try {
      return await window.resolveUiEnvelope(() => work(false), unwrap);
    } catch (error) {
      if (error.code !== 'ERR_ANTI_CHEAT_CONFIRM') throw error;
      setBusy(false);
      const confirmed = await confirmAntiCheat(gameId);
      if (!confirmed) {
        const cancelled = new Error('已取消操作');
        cancelled.silent = true;
        throw cancelled;
      }
      setBusy(true);
      return await window.resolveUiEnvelope(() => work(true), unwrap);
    }
  }, success, refresh, gameId, onError);
}

function renderRepairSelect() {
  const installed = state.games.filter(game => game.chosen);
  const select = $('repairGameSelect');
  const current = installed.some(game => game.id === state.repairGame) ? state.repairGame : installed[0]?.id || '';
  state.repairGame = current;
  select.innerHTML = installed.length ? installed.map(game => `<option value="${game.id}">${escapeHtml(game.name)}</option>`).join('') : '<option value="">请先选择游戏 EXE</option>';
  select.value = current;
  select.disabled = !installed.length;
  $('repairBtn').disabled = !installed.length;
  $('copyDiagBtn').disabled = !installed.length;
  if (state.activeView === 'repair') loadRepairDiagnostic();
}

function renderFeedbackSelect() {
  const select = $('feedbackGameSelect');
  if (!select) return;
  const current = state.feedbackGame || state.lastFailureGame || state.games[0]?.id || '';
  state.feedbackGame = state.games.some(game => game.id === current) ? current : (state.games[0]?.id || '');
  select.innerHTML = state.games.length
    ? state.games.map(game => `<option value="${escapeHtml(game.id)}">${escapeHtml(game.name)}${game.installed ? '（已安装）' : ''}</option>`).join('')
    : '<option value="">没有可反馈的游戏</option>';
  select.value = state.feedbackGame;
  select.disabled = !state.games.length;
  $('copyFeedbackBtn').disabled = !state.games.length;
  $('exportFeedbackBtn').disabled = !state.games.length;
}

function renderAddonVersions() {
  const root = $('addonVersionList');
  if (!root) return;
  const rows = state.addons || [];
  renderPayloadSource();
  $('addonListHint').textContent = rows.length ? `${rows.length} 个版本 · 在游戏设置中应用` : '还没有可用版本';
  root.innerHTML = rows.length ? rows.map(item => `<div class="addon-row">
    <div class="addon-symbol"><span class="nav-icon nav-icon-addons" aria-hidden="true"></span></div>
    <div><div class="addon-name">${escapeHtml(coreVersionLabel(item.id, item))}</div><div class="addon-meta">${item.addonOnly ? `导入文件：${escapeHtml(item.sourceName || '')} · ${item.ota ? '配套更新包，按 API 应用所需组件' : '仅更新核心，保留配套组件'}` : escapeHtml(item.notes || '完整安装组件')}</div></div>
    <span class="addon-tag">${item.ready ? '可用' : '组件未准备'}</span>
    ${item.deletable ? `<button class="button danger addon-remove-btn" data-id="${escapeHtml(item.id)}">移出版本库</button>` : `<span class="addon-tag">${item.source === 'external' ? '外部目录' : '随程序提供'}</span>`}
  </div>`).join('') : '<p class="muted">首次安装请先选择完整组件目录；已有安装可导入标准 OTA 或核心更新文件。</p>';
  root.querySelectorAll('.addon-remove-btn').forEach(button => button.onclick = () => confirmRemoveAddon(button.dataset.id));
}

function renderPayloadSource() {
  const source = state.payload?.source;
  const status = $('payloadSourceStatus');
  if (!status) return;
  const runtimeDlcRequired = source?.runtimeDlcRequired === true;
  const ready = source ? source.ready && !source.error : Boolean(state.payload?.ready);
  const family = source?.requiredHardwareFamily === 'RTX50' ? 'RTX 50 系' : source?.requiredHardwareFamily === 'RTX40' ? 'RTX 40 系' : '对应显卡';
  status.textContent = ready ? '组件检查通过' : runtimeDlcRequired ? `待导入 ${family}运行库` : '需要处理';
  status.className = `badge ${ready ? 'good' : 'warn'}`;
  $('payloadSourceLabel').textContent = runtimeDlcRequired ? '精简管理器本体' : source?.mode === 'external' ? '外部组件目录' : source?.mode === 'unconfigured' ? '尚未选择组件' : '随程序提供';
  $('payloadSourcePath').textContent = runtimeDlcRequired ? 'Core 已包含；大型运行库按显卡系列单独导入。' : source?.mode === 'unconfigured' ? '选择完整组件目录后会记住位置。' : source?.path || state.payload?.dir || '未提供完整组件目录';
  $('payloadSourceDetail').textContent = runtimeDlcRequired ? `请点击上方“导入运行库 DLC”，选择 ${source?.requiredHardwareFamily === 'RTX50' ? 'NR-Runtime-RTX50.zip' : 'NR-Runtime-RTX40.zip'}。导入后会自动匹配并用于后续安装。`
    : source?.mode === 'unconfigured' ? '本程序未附带完整 NR 组件；选择已有的完整组件目录即可继续。'
    : source?.error?.message || (ready ? '已核对清单和文件；安装或修复前还会再次校验。' : '请确认完整组件、文件校验和显卡匹配。');
  $('payloadSourceDetail').classList.toggle('error', !runtimeDlcRequired && Boolean(source?.error) && source?.mode !== 'unconfigured');
  $('resetPayloadSourceBtn').classList.toggle('hidden', source?.mode !== 'external' || source?.bundledAvailable === false);
}

async function changePayloadSource(action) {
  if (state.busy) return;
  const message = $('payloadSourceFeedback');
  const buttons = ['choosePayloadSourceBtn', 'recheckPayloadSourceBtn', 'resetPayloadSourceBtn'].map($);
  setBusy(true); buttons.forEach(button => { button.disabled = true; });
  message.textContent = '正在核对组件目录和文件，请稍候…'; message.className = 'payload-source-feedback';
  const update = data => {
    state.settings = data.settings; state.payload = data.payload; state.addons = data.addons;
    renderVersionSelector(); renderAddonVersions(); renderGames({ preserveExpanded: true });
  };
  try {
    const result = unwrap(await window.manager[action]());
    if (result) { update(result); message.textContent = '组件来源已保存；已安装游戏可在游戏设置中选择并应用版本。'; }
    else message.textContent = '已取消选择，继续使用当前组件来源。';
  } catch (error) {
    try { update(unwrap(await window.manager.readPayloadSource())); } catch {}
    message.textContent = error.message; message.className = 'payload-source-feedback error';
    message.classList.toggle('hidden', state.payload?.source?.error?.message === error.message);
  } finally { setBusy(false); buttons.forEach(button => { button.disabled = false; }); }
}

window.addEventListener('manager-components-changed', event => {
  if (event.detail) {
    state.settings = event.detail.settings; state.payload = event.detail.payload; state.addons = event.detail.addons;
    renderVersionSelector(); renderAddonVersions();
  }
  refreshGames().catch(error => { $('payloadSourceFeedback').textContent = error.message; });
});

function confirmRemoveAddon(id) {
  const item = (state.addons || []).find(row => row.id === id);
  state.pendingModal = { type: 'remove-addon', id };
  $('modalTitle').textContent = '删除导入的 Addon';
  $('modalBody').textContent = `将从管理器版本库移除“${coreVersionLabel(id, item)}”。不会删除已经安装到游戏目录的文件。`;
  $('removeSettingsLine').classList.add('hidden');
  showOverlay($('modal'));
}

function diagnosticRows(rows) {
  const markup = row => {
    const status = row.ok === true ? 'ok' : row.ok === false ? 'bad' : 'pending';
    return `<div class="diag-row"><span class="diag-icon ${status}">${status === 'ok' ? '✓' : status === 'bad' ? '×' : '○'}</span><span>${escapeHtml(row.label)}</span><span class="diag-detail">${escapeHtml(row.detail || (status === 'ok' ? '完整' : status === 'bad' ? '异常' : '待验证'))}</span></div>`;
  };
  const failed = rows.filter(row => row.ok === false), pending = rows.filter(row => row.ok !== true && row.ok !== false), passed = rows.filter(row => row.ok === true);
  return `${failed.map(markup).join('')}${pending.map(markup).join('')}${passed.length ? `<details class="healthy-components"><summary>${failed.length || pending.length ? '其余 ' : ''}${passed.length} 项文件检查通过</summary>${passed.map(markup).join('')}</details>` : ''}`;
}

async function loadRepairDiagnostic() {
  const id = state.repairGame;
  const token = ++state.repairLoadToken;
  state.diagnostics = null;
  const game = state.games.find(row => row.id === id);
  $('repairBtn').disabled = !game?.installed;
  mountRepairActions(game);
  $('copyDiagBtn').disabled = true;
  if (!id) {
    $('diagnostics').innerHTML = '<p>选择需要检查的游戏；尚未安装也可以保存反馈。</p>';
    state.diagnostics = null;
    return;
  }
  if (!game?.installed) {
    $('diagnostics').innerHTML = '<p>当前没有本管理器的安装记录。可在“维护与恢复”中检查外部组件，或撤销之前的环境清理。</p>';
    return;
  }
  $('diagnostics').innerHTML = '<p>正在检查组件…</p>';
  try {
    const diagnostic = unwrap(await window.manager.diagnose(id));
    if (token !== state.repairLoadToken || state.repairGame !== id) return;
    state.diagnostics = diagnostic;
    const problems = diagnostic.components.filter(row => row.ok === false).length;
    $('diagnostics').innerHTML = `<div class="diagnostic-heading"><div><h3>${problems ? `${problems} 项需要处理` : '文件检查通过'}</h3><p>${problems ? '先处理以下异常，已通过的项目收在下方。' : '已核对当前安装文件；游戏实际效果仍需在游戏内确认。'}</p></div><span class="badge ${problems ? 'warn' : 'good'}">${escapeHtml(game?.name || '')}</span></div>${diagnostic.availableUpdate ? `<p class="config-note">有更新：${escapeHtml(diagnostic.availableUpdate.from)} → ${escapeHtml(diagnostic.availableUpdate.label)}。修复保持已装组合；更新请在安装页预览。</p>` : ''}${diagnostic.sourceNotice ? `<p class="config-note">${escapeHtml(diagnostic.sourceNotice)}</p>` : ''}${diagnosticRows(diagnostic.components)}`;
    $('copyDiagBtn').disabled = false;
  } catch (error) { if (token === state.repairLoadToken) $('diagnostics').innerHTML = `<p class="launch-error">${escapeHtml(error.message)}</p>`; }
}

function diagnosticText() {
  const game = state.games.find(row => row.id === state.repairGame);
  if (!game || !state.diagnostics) return '';
  return [
    'DLSS 5 AI 超分管理器诊断',
    `版本：${state.product.version || ''}`,
    `游戏：${game.name}`,
    `目录：${game.dir}`,
    `接口：${game.chosen ? game.chosen.apiLabel : '未知'}`,
    ...state.diagnostics.components.map(row => `${row.label}：${row.detail || (row.ok ? '完整' : '异常')}`)
  ].join('\n');
}

function confirmUninstall(id) {
  const game = state.games.find(row => row.id === id), feeder = game?.feeder?.installed === true;
  state.pendingModal = { type: 'uninstall', id };
  $('modalTitle').textContent = '卸载插件';
  $('modalBody').textContent = feeder ? `将移除本次 Feeder，并把参数配置归档到安装备份。${game.feeder.retainedFiles?.length ? `安装前已有的 ${game.feeder.retainedFiles.join('、')} 会保留；反作弊仍可能拒绝原有 ReShade。` : '恢复的是安装前状态，不会清除其他模组。'}` : '将恢复管理器安装前的文件。默认保留你的 nr_before_sr.ini 参数设置。';
  $('removeSettingsLine').classList.toggle('hidden', feeder);
  $('removeSettingsCheck').checked = false;
  showOverlay($('modal'));
}

function openMaintenance(id) {
  if (state.busy) return;
  if (state.activeView === 'repair') { mountRepairActions(state.games.find(row => row.id === id)); $('repairMaintenance')?.scrollIntoView({ block: 'start', behavior: motionAllowed() ? 'smooth' : 'auto' }); return; }
  if (typeof window.manager.assessGame === 'function') { openGamePage(id, 'maintenance'); return; }
  const game = state.games.find(row => row.id === id);
  if (!game || !window.gameMaintenanceUi) return;
  return window.gameMaintenanceUi.open({ game, manager: window.manager,
    onChanged: async gameId => { await refreshGames({ gameId }); return state.games.find(row => row.id === gameId); },
    onFeedback: gameId => { state.repairGame = gameId; state.feedbackGame = gameId; switchView('repair'); }
  });
}

function confirmDismissGame(id) {
  const game = state.games.find(row => row.id === id);
  state.pendingModal = { type: 'dismiss-game', id };
  $('modalTitle').textContent = '卸载组件并移除游戏';
  $('modalBody').textContent = `将先卸载本工具为“${game ? game.name : id}”部署的组件，撤销超分补帧覆盖并恢复安装前备份，然后移出列表。保留游戏本体和个人配置；恢复失败时保留条目，方便继续处理。之后可重新添加。`;
  $('removeSettingsLine').classList.add('hidden');
  showOverlay($('modal'));
}

function confirmRenameGame(id) {
  const game = state.games.find(row => row.id === id);
  if (!game) return;
  const input = $('renameGameInput');
  state.pendingModal = { type: 'rename-game', id, originalName: String(game.name || '').trim() };
  $('modalTitle').textContent = '修改游戏名称';
  $('modalBody').textContent = '只修改列表显示名称，不会改变游戏文件、安装路径或 API/EXE 绑定。';
  input.value = state.pendingModal.originalName;
  $('renameGameLine').classList.remove('hidden');
  $('removeSettingsLine').classList.add('hidden');
  $('modalConfirm').textContent = '保存名称';
  showOverlay($('modal'));
  const focus = () => { input.focus(); input.select(); };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus); else focus();
}

async function dismissGameFromList(id) {
  if (state.busy) return;
  setBusy(true);
  try {
    const next = mergeGameVisuals(state.games, unwrap(await window.manager.dismissGame(id)));
    state.games = next;
    if (state.expanded === id) state.expanded = null;
    const card = [...document.querySelectorAll('.game-card')].find(row => row.dataset.id === id);
    if (card) card.remove();
    updateGameListMeta();
    renderRepairSelect();
    toast('已从列表移除');
  } catch (error) { toast(error.message, true); }
  finally { setBusy(false); }
}

function confirmD3D12(id) {
  const game = state.games.find(row => row.id === id);
  const enabled = !(game && game.d3d12Route);
  state.pendingModal = { type: 'd3d12', id, enabled };
  $('modalTitle').textContent = enabled ? '应用 D3D12 兼容修复' : '撤销 D3D12 兼容修复';
  $('modalBody').textContent = enabled
    ? '请先完全退出游戏。此操作会切换加载入口并保留原始文件，可用于异环等部分 DX12 网游的加载报错。只适用于 DX12；修复无效时可撤销。'
    : '请先完全退出游戏。会撤销本次兼容修复，恢复原来的加载入口。';
  $('removeSettingsLine').classList.add('hidden');
  showOverlay($('modal'));
}

function confirmAntiCheat(id = null) {
  return new Promise(resolve => {
    const game = id ? state.games.find(row => row.id === id) : null;
    state.pendingModal = { type: 'anti-cheat', resolve };
    $('modalTitle').textContent = '反作弊风险提示';
    $('modalBody').textContent = `检测到“${game ? game.name : '该游戏'}”目录中存在可能的反作弊组件。继续安装可能导致游戏无法启动、触发安全策略或封禁风险。管理器不会修改、删除或绕过反作弊文件；只有你确认后才会继续写入插件文件。`;
    $('removeSettingsLine').classList.add('hidden');
    $('modalConfirm').textContent = '确认继续安装';
    showOverlay($('modal'));
  });
}

function confirmHotkey(id, target, current) {
  state.pendingModal = { type: 'hotkey', id, target, binding: null };
  $('modalTitle').textContent = target === 'reshade' ? '设置 ReShade 菜单快捷键' : '设置 NR 效果切换快捷键';
  $('modalBody').textContent = `当前快捷键：${hotkeyLabel(current)}。请按下新的组合键，再点击确认保存。`;
  $('removeSettingsLine').classList.add('hidden');
  $('modalConfirm').textContent = '保存快捷键';
  $('modalConfirm').disabled = true;
  showOverlay($('modal'));
}

function closeModal(result = false) {
  const pending = state.pendingModal;
  state.pendingModal = null;
  hideOverlay($('modal'));
  $('renameGameLine').classList.add('hidden');
  $('renameGameInput').value = '';
  $('removeSettingsLine').classList.add('hidden');
  $('modalConfirm').textContent = '确认';
  $('modalConfirm').disabled = false;
  if (pending && pending.type === 'anti-cheat' && typeof pending.resolve === 'function') pending.resolve(result === true);
}

function switchView(view) {
  if (view !== 'hoyo') hoyoController?.deactivate();
  state.activeView = view;
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === `view-${view}`));
  document.querySelectorAll('.nav').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  const titles = {
    games: ['我的游戏', '选择游戏，确认兼容性后安装'],
    hoyo: ['米哈游游戏', '选择游戏，确认启动器后安装与设置'],
    repair: ['问题修复', '检查组件完整性，并安全恢复缺失文件'],
    settings: ['设置', '只保留真正会影响使用的选项'],
    addons: ['组件管理', '准备安装来源，按游戏应用与回退核心']
  };
  $('pageTitle').textContent = titles[view][0];
  $('pageSubtitle').textContent = titles[view][1];
  replayMotion(document.querySelector('.page-title'), 'motion-reenter');
  $('addGameBtn').classList.toggle('hidden', view !== 'games');
  $('addExeBtn').classList.toggle('hidden', view !== 'games');
  $('refreshBtn').classList.toggle('hidden', view !== 'games');
  if (view === 'repair') loadRepairDiagnostic();
  if (view === 'addons') renderAddonVersions();
  if (view === 'hoyo') {
    if (!hoyoController) hoyoController = window.HoYoPageUi.mount($('hoyoWorkspace'), window.manager, {
      onChanged: flow => { if (flow.gameId) state.hoyoGameIds.add(flow.gameId); }
    });
    void hoyoController.activate();
  }
  if (view === 'games') renderGames({ preserveExpanded: true });
}

async function boot() {
  try {
    const data = unwrap(await window.manager.boot());
    state.product = data.product;
    state.settings = data.settings;
    state.hardware = data.hardware;
    state.payload = data.payload;
    state.addons = data.addons || [];
    state.games = data.games;
    applyThemePreference(state.settings.theme);
    applyMotionPreference(state.settings.animationsEnabled);
    document.title = state.product.name;
    $('brandName').textContent = state.product.name.replace(/\s*(?:AI\s*)?超分管理器$/, '').trim();
    $('brandEdition').textContent = state.product.edition;
    $('authorText').textContent = state.product.author ? `by ${state.product.author}` : '';
    $('settingsAuthor').textContent = state.product.author;
    $('versionText').textContent = `v${state.product.version}`;
    $('settingsVersion').textContent = state.product.version;
    $('settingsHardware').textContent = hardwareLabel();
    renderVersionSelector();
    $('scanDrivesToggle').checked = state.settings.scanDrives;
    $('bilibiliBtn').classList.toggle('hidden', !state.product.bilibiliUrl);
    $('qqBtn').textContent = state.product.qqGroup ? `QQ群二群：${state.product.qqGroup}` : '加入交流群';
    $('qqBtn').classList.toggle('hidden', !state.product.qqGroup);
    $('updateBtn').classList.toggle('hidden', !state.product.releaseUrl);
    const gpu = state.hardware;
    const gpuFacts = window.launchSettingsUi?.hardwareFacts(gpu), recommended = window.launchSettingsUi?.recommendedPreset(gpu);
    $('hardwareNotice').textContent = recommended
      ? `${gpuFacts.label} · 默认超分模型 ${recommended}，可按游戏调整。`
      : '显卡尚未确认，模型保持游戏原有设置。';
    $('hardwareNotice').classList.remove('hidden');
    renderGames();
    renderAddonVersions();
    startupFinished = true;
    window.manager.startupReady?.();
    if (data.discoveryWarnings?.length) toast(data.discoveryWarnings.map(row => row.message).join('；'), true);
    setTimeout(enrichMissingArtwork, 80);
  } catch (error) { window.manager.startupFailed?.(error.message); toast(error.message, true); }
}

async function enrichMissingArtwork() {
  for (const game of state.games) {
    let changed = false;
    // Manual games do not have a reliable store identity. Do not search the
    // web for a guessed poster; keep their EXE icon (now extracted at the
    // largest Windows shell size) unless the user supplied artwork elsewhere.
    if (!game.poster && game.launcher !== '手动添加') {
      try {
        const poster = unwrap(await window.manager.fetchGameArt(game.id));
        if (poster) { game.poster = poster; changed = true; }
      } catch {}
    }
    if (!game.poster && game.iconCheckedFor !== (game.chosen?.path || game.id)) {
      try {
        const icon = unwrap(await window.manager.getGameIcon(game.id, game.icon));
        if (icon) { game.icon = icon; changed = true; }
        game.iconCheckedFor = game.chosen?.path || game.id;
      } catch {}
    }
    if (changed) updateGameCardArtwork(game);
  }
}

function updateGameCardArtwork(game) {
  const card = [...document.querySelectorAll('.game-card')].find(row => row.dataset.id === game.id);
  const current = card && card.querySelector('.poster');
  if (!current) return;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = poster(game);
  const next = wrapper.firstElementChild;
  if (next) current.replaceWith(next);
}

function scheduleArtworkEnrichment() {
  clearTimeout(scheduleArtworkEnrichment.timer);
  scheduleArtworkEnrichment.timer = setTimeout(() => enrichMissingArtwork(), 80);
}

function formatExeSize(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function selectedGameCandidate() {
  const selection = state.gameSelection;
  if (!selection) return null;
  return selection.candidates.find(candidate => candidate.path === selection.selectedPath) || selection.chosen || null;
}

function renderGameIconPreview() {
  const preview = $('gameIconPreview');
  if (!preview) return;
  const icon = state.gameSelection && state.gameSelection.icon;
  preview.innerHTML = icon
    ? `<img src="${escapeHtml(icon)}" alt="">`
    : '<span>?</span>';
}

async function selectGameCandidate(index) {
  const selection = state.gameSelection;
  if (!selection || !selection.candidates[index]) return;
  const candidate = selection.candidates[index];
  selection.selectedPath = candidate.path;
  document.querySelectorAll('.game-candidate').forEach((row, rowIndex) => row.classList.toggle('selected', rowIndex === index));
  const nameInput = $('gameNameInput');
  if (nameInput && !selection.nameTouched) nameInput.value = selection.name || candidate.name.replace(/\.exe$/i, '');
  try { selection.icon = unwrap(await window.manager.getExecutableIcon(candidate.path)); } catch { selection.icon = null; }
  renderGameIconPreview();
}

function renderGameSelection() {
  const selection = state.gameSelection;
  if (!selection) return;
  const candidates = selection.candidates || [];
  $('gamePickerPath').textContent = selection.root;
  $('gamePickerHint').textContent = candidates.length
    ? '已自动找到可能的运行程序；默认根据路径结构、程序名、API 和 DLSS 关联选择本体，启动器/报告程序会标成辅助项。文件大小仅作参考，不作为硬性门槛。'
    : '这个目录没有检测到可用的图形程序，请返回后选择更上层的游戏目录或实际 EXE。';
  $('gameCandidateList').innerHTML = candidates.length ? candidates.map((candidate, index) => `
    <button type="button" class="game-candidate${candidate.path === selection.selectedPath ? ' selected' : ''}" data-index="${index}">
      <span class="candidate-check">${candidate.path === selection.selectedPath ? '✓' : ''}</span>
      <span class="candidate-main"><strong>${escapeHtml(candidate.rel || candidate.name)}</strong><small>${escapeHtml(candidate.apiLabel || '图形 API 未知')} · ${candidate.bitness || '?'} 位 · ${formatExeSize(candidate.size)}</small></span>
      <span class="candidate-state">${candidate.helper ? '辅助程序' : (candidate.recommended ? '建议' : '手动可选')}</span>
    </button>`).join('') : '<p class="muted">没有候选程序。</p>';
  $('gameCandidateList').querySelectorAll('.game-candidate').forEach(button => {
    button.onclick = () => selectGameCandidate(Number(button.dataset.index));
  });
  const candidate = selectedGameCandidate();
  $('gameNameInput').value = selection.name || (candidate && candidate.name ? candidate.name.replace(/\.exe$/i, '') : '');
  renderGameIconPreview();
  $('confirmGameBtn').disabled = !candidate;
  showOverlay($('gamePickerModal'));
  if (candidate) {
    const index = candidates.findIndex(row => row.path === candidate.path);
    if (index >= 0) selectGameCandidate(index);
  }
}

async function openGameSelection(picker) {
  if (state.busy) return;
  setBusy(true);
  try {
    const selection = unwrap(await picker());
    if (!selection) return;
    state.gameSelection = { ...selection, selectedPath: selection.chosen && selection.chosen.path, nameTouched: false, icon: null };
    renderGameSelection();
  } catch (error) { toast(error.message, true); }
  finally { setBusy(false); }
}

function closeGameSelection() {
  state.gameSelection = null;
  hideOverlay($('gamePickerModal'));
}

async function confirmGameSelection() {
  const selection = state.gameSelection;
  const candidate = selectedGameCandidate();
  if (!selection || !candidate) return;
  setBusy(true);
  try {
    state.games = unwrap(await window.manager.confirmGame({
      root: selection.root,
      executable: candidate.path,
      name: $('gameNameInput').value.trim() || selection.name || candidate.name.replace(/\.exe$/i, ''),
      icon: selection.icon || null
    }));
    closeGameSelection();
    renderGames();
    scheduleArtworkEnrichment();
    toast('游戏已添加');
  } catch (error) { toast(error.message, true); }
  finally { setBusy(false); }
}

document.querySelectorAll('.nav').forEach(button => button.onclick = () => switchView(button.dataset.view));
$('searchInput').oninput = () => {
  clearTimeout(renderGames.searchTimer);
  renderGames.searchTimer = setTimeout(() => renderGames({ preserveExpanded: true }), 120);
};
$('gameFilter').onchange = () => renderGames({ preserveExpanded: true });
$('refreshBtn').onclick = () => runAction(async () => { const result = await window.manager.refresh(); state.games = unwrap(result); return result; }, '扫描完成', false).then(() => { renderGames(); scheduleArtworkEnrichment(); });
async function pickAndRefresh(picker, success) {
  if (state.busy) return;
  setBusy(true);
  try {
    const games = unwrap(await picker());
    if (!games) return;
    state.games = games;
    renderGames();
    scheduleArtworkEnrichment();
    toast(success);
  } catch (error) { toast(error.message, true); }
  finally { setBusy(false); }
}
$('addGameBtn').onclick = $('emptyAddBtn').onclick = () => openGameSelection(window.manager.pickGame);
$('addExeBtn').onclick = () => openGameSelection(window.manager.pickExecutable);
$('gameNameInput').oninput = () => { if (state.gameSelection) state.gameSelection.nameTouched = true; };
$('gamePickerCancel').onclick = closeGameSelection;
$('confirmGameBtn').onclick = confirmGameSelection;
$('chooseGameIconBtn').onclick = async () => {
  if (!state.gameSelection) return;
  try {
    const picked = unwrap(await window.manager.pickGameIcon());
    if (picked && picked.icon) { state.gameSelection.icon = picked.icon; renderGameIconPreview(); }
  } catch (error) { toast(error.message, true); }
};
$('importAddonBtn').onclick = async () => {
  if (state.busy) return;
  setBusy(true);
  try {
    const addons = unwrap(await window.manager.pickAddon());
    if (addons) {
      state.addons = addons;
      renderAddonVersions();
      if (state.activeView === 'games') renderGames();
      window.dispatchEvent(new CustomEvent('manager-components-changed'));
      toast('文件已导入；普通 Add-on 可在游戏的“高级与维护”中加载');
    }
  } catch (error) { toast(error.message, true); }
  finally { setBusy(false); }
};
$('choosePayloadSourceBtn').onclick = () => changePayloadSource('pickPayloadSource');
$('recheckPayloadSourceBtn').onclick = () => changePayloadSource('recheckPayloadSource');
$('resetPayloadSourceBtn').onclick = () => changePayloadSource('resetPayloadSource');
$('addonDropZone').ondragover = event => { event.preventDefault(); $('addonDropZone').classList.add('dragging'); };
$('addonDropZone').ondragleave = () => $('addonDropZone').classList.remove('dragging');
$('addonDropZone').ondrop = async event => {
  event.preventDefault();
  $('addonDropZone').classList.remove('dragging');
  const file = event.dataTransfer.files && event.dataTransfer.files[0];
  const filePath = file && window.manager.pathForFile(file);
  if (!filePath) return;
  try {
    state.addons = unwrap(await window.manager.importAddon(filePath));
    renderAddonVersions();
    if (state.activeView === 'games') renderGames();
    window.dispatchEvent(new CustomEvent('manager-components-changed'));
    toast(/\.zip$/i.test(filePath) ? '标准 OTA 已导入' : '文件已导入；普通 Add-on 可在游戏的“高级与维护”中加载');
  } catch (error) { toast(error.message, true); }
};
$('addFolderBtn').onclick = () => pickAndRefresh(window.manager.pickScanFolder, '游戏库已添加');
$('themeSelect').onchange = async event => {
  const token = ++themeSaveGeneration;
  const requested = event.target.value;
  applyThemePreference(requested);
  try {
    const saved = unwrap(await window.manager.updateSettings({ theme: requested }));
    if (token !== themeSaveGeneration) return;
    state.settings = saved;
    applyThemePreference(saved.theme);
    toast(saved.theme === 'system' ? '外观已改为跟随系统' : saved.theme === 'dark' ? '已切换到深色外观' : '已切换到浅色外观');
  } catch (error) {
    if (token !== themeSaveGeneration) return;
    applyThemePreference(state.settings?.theme);
    toast(error.message, true);
  }
};
$('animationsToggle').onchange = async event => {
  const token = ++motionSaveGeneration;
  const requested = event.target.checked;
  applyMotionPreference(requested);
  try {
    const saved = unwrap(await window.manager.updateSettings({ animationsEnabled: requested }));
    if (token !== motionSaveGeneration) return;
    state.settings = saved;
    applyMotionPreference(saved.animationsEnabled);
    toast(saved.animationsEnabled === false ? '界面动画已关闭' : '界面动画已开启');
  } catch (error) {
    if (token !== motionSaveGeneration) return;
    applyMotionPreference(state.settings?.animationsEnabled);
    toast(error.message, true);
  }
};
$('scanDrivesToggle').onchange = event => runAction(async () => {
  state.settings = unwrap(await window.manager.updateSettings({ scanDrives: event.target.checked }));
  state.games = unwrap(await window.manager.refresh());
  return true;
}, '扫描范围已更新', false).then(() => { renderGames(); scheduleArtworkEnrichment(); });
$('addonVersionSelect').onchange = event => runAction(async () => {
  state.settings = unwrap(await window.manager.updateSettings({ addonVersion: event.target.value || null }));
  refreshSelectedPayload(event.target.value);
  renderVersionSelector();
  return true;
}, '新安装默认版本已保存；已安装游戏保持当前版本', false).then(() => renderGames({ preserveExpanded: true }));
$('bilibiliBtn').onclick = () => window.manager.openExternal('bilibiliUrl');
$('qqBtn').onclick = async () => { await window.manager.copyText(state.product.qqGroup); toast('群号已复制'); };
$('updateBtn').onclick = () => window.manager.openExternal('releaseUrl');
$('repairGameSelect').onchange = event => { state.repairGame = event.target.value; loadRepairDiagnostic(); };
$('repairBtn').onclick = () => repairController?.previewRepair();
$('exportStartupBtn').onclick = async () => {
  try { await window.manager.exportStartupDiagnostic(); } catch (error) { toast(`无法保存启动诊断：${error.message}`, true); }
};
$('copyDiagBtn').onclick = async () => { const text = diagnosticText(); if (text) { await window.manager.copyText(text); toast('诊断信息已复制'); } };
$('feedbackGameSelect').onchange = event => {
  state.feedbackGame = event.target.value;
  state.lastFailureGame = state.feedbackGame;
};
$('copyFeedbackBtn').onclick = async () => {
  const id = $('feedbackGameSelect').value;
  if (!id || state.busy) return;
  setBusy(true);
  try {
    const report = unwrap(await window.manager.buildFeedback(id, { includePaths: $('feedbackIncludePaths').checked }));
    await window.manager.copyText(report.text);
    toast('完整反馈日志已复制，可以直接发给开发者');
  } catch (error) { toast(error.message, true); }
  finally { setBusy(false); }
};
$('exportFeedbackBtn').onclick = async () => {
  const id = $('feedbackGameSelect').value;
  if (!id || state.busy) return;
  setBusy(true);
  try {
    const file = unwrap(await window.manager.exportFeedback(id, { includePaths: $('feedbackIncludePaths').checked }));
    if (file) toast(`反馈日志已保存：${file}`);
  } catch (error) { toast(error.message, true); }
  finally { setBusy(false); }
};
$('modalCancel').onclick = closeModal;
$('renameGameInput').onkeydown = event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  $('modalConfirm').click();
};
document.addEventListener('keydown', event => {
  const pending = state.pendingModal;
  if (!pending || pending.type !== 'hotkey') return;
  const binding = keyBindingFromEvent(event);
  if (!binding) return;
  event.preventDefault();
  event.stopPropagation();
  pending.binding = binding;
  $('modalBody').textContent = `已捕获：${hotkeyLabel(binding)}。点击“保存快捷键”写入当前游戏的 ReShade.ini。`;
  $('modalConfirm').disabled = false;
}, true);
$('modalConfirm').onclick = async () => {
  const pending = state.pendingModal;
  if (!pending) return;
  if (pending.type === 'anti-cheat') {
    closeModal(true);
    return;
  }
  if (pending.type === 'hotkey') {
    if (!pending.binding) return;
    closeModal();
    await runAction(() => window.manager.writeHotkey(pending.id, pending.target, pending.binding), '快捷键已保存；下次启动游戏生效', false);
    await loadExpanded(pending.id);
    return;
  }
  if (pending.type === 'rename-game') {
    const name = String($('renameGameInput').value || '').trim().slice(0, 160);
    if (!name) { toast('游戏名称不能为空', true); $('renameGameInput').focus(); return; }
    closeModal();
    if (name !== pending.originalName) await runAction(() => window.manager.renameGame(pending.id, name), '游戏名称已保存', true, pending.id);
    return;
  }
  closeModal();
  if (pending.type === 'uninstall') {
    await runAction(() => window.manager.uninstall(pending.id, $('removeSettingsCheck').checked), '卸载完成', true, pending.id);
    await loadRepairDiagnostic();
  }
  if (pending.type === 'remove-addon') {
    await runAction(async () => {
      state.addons = unwrap(await window.manager.removeAddon(pending.id));
      renderAddonVersions();
      return true;
    }, '导入的 Addon 已删除', false);
  }
  if (pending.type === 'dismiss-game') {
    await dismissGameFromList(pending.id);
  }
  if (pending.type === 'd3d12') {
    await runConfirmedAction(allowAntiCheat => window.manager.toggleD3D12(pending.id, pending.enabled, { allowAntiCheat }), pending.enabled ? '已切换到 D3D12 入口' : '已恢复 DXGI 入口', true, pending.id);
  }
};
$('minBtn').onclick = () => window.manager.minimize();
$('maxBtn').onclick = () => window.manager.maximize();
$('closeBtn').onclick = () => window.manager.close();
window.manager.onAddonImported(async () => {
  try {
    state.addons = unwrap(await window.manager.listAddons());
    renderAddonVersions();
    if (state.activeView === 'games') renderGames();
    toast('检测到新的 Addon，已加入版本库');
  } catch (error) { toast(error.message, true); }
});
if (window.manager.onLaunchSettingsApplied) window.manager.onLaunchSettingsApplied(async payload => {
  if (payload?.id !== state.expanded) return;
  const card = [...document.querySelectorAll('.game-card')].find(row => row.dataset.id === payload.id);
  try { await card?.querySelector('.launch-settings-host')?.launchSettingsController?.refresh(); }
  catch (error) { toast(`启动设置状态读取失败：${error.message}`, true); }
  const failures = (payload.outcomes || []).filter(row => row.code || row.reason);
  if (failures.length) toast(failures.map(row => `${String(row.domain || '').toUpperCase()}：${row.reason || row.code}`).join('；'), true);
});
boot();
