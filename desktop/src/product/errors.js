'use strict';

const MESSAGES = Object.freeze({
  ERR_BAD_REQUEST: '请求参数无效。',
  ERR_UNKNOWN_GAME: '游戏不在当前扫描结果中，请重新扫描。',
  ERR_NO_GAME_EXE: '没有找到可用的游戏主程序。',
  ERR_INSTALL_EXE_CHANGED: '当前选择的游戏程序与已有安装备份不一致。为避免同时修改两个目录，已停止操作；请重新选择原安装程序并恢复或卸载后，再安装到新程序。',
  ERR_OTA_CORE_ONLY: '这是仅供 D3D12 验收的核心测试包，不能作为 Manager OTA 导入。请使用配套的管理器更新包。',
  CORE_UPDATE_BASE_REQUIRED: '此测试 Core 仅更新已有的 DX12 原生安装。请先使用默认 Core 完成 DX12 安装，再预览切换。',
  ERR_UNSUPPORTED_API: '所选组件不支持这条图形路线。DirectX 11 需要包含配套 carrier 的兼容包；其他图形 API 暂不支持。',
  ERR_API_SELECTION_REQUIRED: '图形 API 证据不足或存在多条路线，请进入游戏详情，按游戏的实际启动设置选择 API。',
  ERR_API_ROUTE_PENDING: '游戏 API 选择与已部署组件不一致，请先点击修复或应用版本，再启动游戏。',
  ERR_CARRIER_NOT_SELECTED: 'DX11 兼容桥接尚未就绪。请确认游戏 API 为 DirectX 11，再使用完整配套组件安装或修复；桥接会自动配置。',
  ERR_UNSUPPORTED_BITNESS: '当前基础版只支持 64 位游戏。',
  ERR_NO_DLSS: '没有检测到游戏自带的普通 DLSS 超分组件。',
  ERR_EMULATOR_UNSUPPORTED: '当前基础版暂不自动安装到模拟器。',
  ERR_ANTI_CHEAT_CONFIRM: '检测到可能的反作弊组件。继续安装可能导致游戏无法启动、触发安全策略或封禁风险；管理器不会修改或绕过反作弊文件。请确认后继续。',
  ERR_GAME_RUNNING: '请先关闭游戏，再进行安装、修复或卸载。',
  ERR_PROCESS_CHECK: '无法确认游戏是否已关闭，请退出游戏后重新检查。若检查受权限限制，可在具体变更预览中选择本次以管理员权限应用。',
  ERR_NO_WRITE_ACCESS: '没有游戏目录写入权限。请先恢复未完成事务，再重新预览，并选择本次以管理员权限应用。',
  ERR_PAYLOAD_MISSING: '缺少安装组件，操作未完成。请重新选择完整组件目录，或重新下载完整安装包后重试。',
  ERR_PAYLOAD_HASH: '安装组件校验不匹配，文件可能损坏或混用了版本。请重新选择同一版本的完整组件目录，或重新下载完整安装包。',
  ERR_PAYLOAD_SOURCE_INVALID: '所选目录不是有效的组件目录。请选择包含有效 bundle.json 和配套文件的目录。',
  ERR_PAYLOAD_SOURCE_MISSING: '外部组件来源缺失，操作未完成。请检查目录、bundle.json 及所选版本的配套文件，再重新选择完整组件目录。',
  ERR_PAYLOAD_SOURCE_HASH: '外部组件目录的文件与版本清单不匹配。请换用同一版本的完整组件目录，检查通过后再重试。',
  ERR_PAYLOAD_SOURCE_UNAVAILABLE: '组件目录当前不可访问，操作未完成。请重新连接所在磁盘、检查目录权限，或重新选择组件目录。',
  ERR_PAYLOAD_SOURCE_CHANGED: '组件目录或文件在检查后发生变化，已停止本次操作。请重新选择并检查组件目录后重试。',
  ERR_ADDON_INVALID: 'Addon 文件无效；请选择 64 位 .addon64 文件。',
  ERR_ADDON_NOT_FOUND: '找不到这个导入的 Addon 版本。',
  ERR_D3D12_CONFLICT: 'd3d12.dll 槽位已被其他文件占用，未覆盖。请先核对文件归属；若属于其他插件，请用原工具还原后重试。',
  ERR_GPU_UNSUPPORTED: '未能确认 RTX 20 / 30 / 40 / 50 系列显卡，已停止安装以避免误用组件。',
  ERR_RESHADER_CONFLICT: 'dxgi.dll 槽位已被其他文件占用，未覆盖。请先核对现有 ReShade 或插件，并用原工具还原冲突文件后重试。',
  ERR_RESHADER_NO_ADDON: '现有 ReShade 不支持 Add-on，无法加载本插件。',
  ERR_ADDON_SEARCH_PATH: '现有 ReShade 从自定义目录加载插件，当前安装路线尚不能接入该目录，已保留原配置和其他插件。请在“修复”页保存反馈，核对加载目录后再处理。',
  ERR_ADDON_DIRECT_LOAD: '现有 ReShade 配置会直接加载旧超分插件或桥接器，普通冲突清理无法控制这条链路。已停止修改；请用原工具还原该加载设置后重试。',
  ERR_RESHADE_CONFIG: '无法完整读取现有 ReShade 配置，已停止安装以保留其他插件的设置。请保留 ReShade.ini 并在“修复”页保存反馈。',
  ERR_HOTKEY_UNSUPPORTED: '当前 Addon 版本的 NR 效果切换键由插件固定为 F6，暂不支持改键。',
  ERR_NOT_INSTALLED: '该游戏尚未由本管理器安装。',
  ERR_BACKUP_INVALID: '备份文件或恢复记录缺失、损坏或校验不匹配，已停止写入。请保留游戏目录和 _DLSS5_Backup，在“修复”页保存反馈后处理。',
  ERR_FILE_CHANGED: '文件与本工具记录不一致，未覆盖或删除。请先核对其他插件的改动；无法确认时，在“修复”页保存反馈。',
  ERR_JOB_BUSY: '当前游戏已有操作正在进行。',
  ERR_INTERNAL: '操作失败，尚未确认完成。请在“修复”页保存反馈，附上刚才的操作步骤。',
  ENOENT: '所需文件或目录不存在。请检查路径及文件是否被移动，重新选择后重试。',
  EACCES: '无法访问所需文件或目录。请检查目录权限，先恢复未完成事务；需要提权时，重新预览并选择本次以管理员权限应用。',
  EPERM: '系统拒绝修改文件。请关闭占用程序并检查目录权限，再重试。',
  EBUSY: '文件正在被占用。请完全退出游戏及相关工具后重试。',
  ENOSPC: '磁盘空间不足，操作未完成。请释放游戏目录和备份目录所在磁盘的空间后重试。',
  SETTINGS_LAUNCH_FAILED: '游戏启动失败。请在“修复”页保存反馈，核对主程序路径及启动权限。',
  SETTINGS_RECOVERY_FIRST: '上次操作尚未恢复完成。请先使用 SR / FG 区域的恢复操作；若仍失败，请保留备份并在“修复”页保存反馈。',
  RECOVERY_FIRST: '上次操作尚未恢复完成。请先恢复未完成的操作；若仍失败，请保留备份并在“修复”页保存反馈。',
  BACKUP_INVALID: '恢复记录无效，已停止恢复。请保留现有文件和备份，在“修复”页保存反馈。',
  BACKUP_DAMAGED: '恢复备份已损坏或校验不匹配，已停止恢复。请保留备份，在“修复”页保存反馈。',
  WRITE_VERIFY_FAILED: '文件写入后校验不匹配，操作未完成。请检查恢复状态，并在“修复”页保存反馈。'
});

function appError(code, details = {}) {
  const error = new Error(MESSAGES[code] || MESSAGES.ERR_INTERNAL);
  error.code = code;
  error.details = details;
  return error;
}

function shortText(value, limit = 320) {
  if (typeof value !== 'string') return '';
  // Errors may include a stack in message itself. Never copy its frame lines.
  const text = value.split(/\r?\n\s*(?:at\s|Traceback\b)/, 1)[0]
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function safeDetails(value) {
  let remaining = 256, textBudget = 12000;
  const seen = new WeakSet();
  const priority = new Set(['phase', 'gameStarted', 'recoverableDomains', 'recoveryStateKnown', 'launchSettings', 'pending', 'allowAntiCheat', 'planId']);
  function copy(item, depth) {
    if (--remaining < 0 || depth > 6) return undefined;
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string') { const text = shortText(item, Math.min(512, textBudget)); textBudget = Math.max(0, textBudget - text.length); return text; }
    if (!item || typeof item !== 'object' || Buffer.isBuffer(item) || seen.has(item)) return undefined;
    seen.add(item);
    if (Array.isArray(item)) {
      const result = item.slice(0, 32).map(row => copy(row, depth + 1)).filter(row => row !== undefined);
      seen.delete(item); return result;
    }
    const entries = Object.keys(item).sort((a, b) => Number(priority.has(b)) - Number(priority.has(a))).slice(0, 48);
    const output = {};
    for (const key of entries) {
      if (/^(?:__proto__|constructor|prototype|stack|stdout|stderr|logs?|rawLogs?|metadata|baselineText|beforeText|afterText)$/i.test(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) continue;
      const result = copy(descriptor.value, depth + 1);
      const name = shortText(key, 80);
      if (result !== undefined && !['__proto__', 'constructor', 'prototype'].includes(name)) output[name] = result;
    }
    seen.delete(item);
    return output;
  }
  const output = copy(value, 0);
  return output && typeof output === 'object' && !Array.isArray(output) ? output : {};
}

function fileSummary(details) {
  const files = [];
  for (const value of [details.file, details.path, details.rel, details.sourceRel, details.directory, details.dir,
    ...(Array.isArray(details.files) ? details.files : [])]) {
    const name = typeof value === 'string' ? value : value && (value.file || value.path || value.rel || value.name);
    const text = shortText(name, 120);
    if (text && !files.includes(text)) files.push(text);
  }
  return files.length ? ` 涉及文件或目录：${files.slice(0, 3).join('、')}${files.length > 3 ? '等' : ''}。` : '';
}

function normalizeError(error) {
  const incoming = error && typeof error === 'object' ? error : {};
  const originalCode = typeof incoming.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(incoming.code) ? incoming.code : null;
  const launchError = /^(SETTINGS_|NVAPI_|FG_)[A-Z_]+$/.test(originalCode || '') ||
    ['EXE_REQUIRED', 'RECOVERY_FIRST', 'PLAN_EXPIRED', 'CONFIRM_REQUIRED', 'GAME_RUNNING', 'PROCESS_UNKNOWN',
      'FILE_CHANGED', 'WRITE_VERIFY_FAILED', 'BACKUP_INVALID', 'BACKUP_DAMAGED', 'STAGE_CHANGED', 'JOURNAL_INVALID',
      'AMBIGUOUS_INI', 'CONFLICTING_REQUEST', 'DUPLICATE_JSON_KEY', 'INVALID_INPUT', 'INVALID_JSON',
      'INVALID_JSON_VALUE', 'INVALID_RANGE', 'INVALID_TEXT', 'PROTOCOL_MISMATCH', 'UNKNOWN_FIELD',
      'UNKNOWN_MODE', 'UNKNOWN_PRESET', 'UNKNOWN_QUALITY', 'INVALID_EXE', 'INVALID_SNAPSHOT'].includes(originalCode);
  const codeMap = {
    errGameRunning: 'ERR_GAME_RUNNING',
    errProcessCheck: 'ERR_PROCESS_CHECK',
    errJobBusy: 'ERR_JOB_BUSY',
    errUnsafeTarget: 'ERR_BACKUP_INVALID',
    errBackupInvalid: 'ERR_BACKUP_INVALID',
    errBackendRecovery: 'ERR_BACKUP_INVALID'
  };
  const code = Object.hasOwn(codeMap, originalCode) ? codeMap[originalCode] : originalCode || 'ERR_INTERNAL';
  const vulkanError = /^(VULKAN_|FEEDER_|SPECIAL_|GAME_LAUNCH_|GAME_API_|RDR2_|REGISTRY_|REF_|PREPARATION_|ENVIRONMENT_|DEPLOYMENT_|OPERATION_|LAUNCH_|HELPER_|ASSESSMENT_|LIBRARY_|WAITING_)[A-Z_]+$/.test(code);
  const details = safeDetails(incoming.details || incoming.params || {});
  for (const field of ['phase', 'gameStarted', 'recoveryStateKnown', 'recoverableDomains']) {
    if (details[field] === undefined && incoming[field] !== undefined) Object.assign(details, safeDetails({ [field]: incoming[field] }));
  }
  for (const field of ['cause', 'recoveryError']) {
    const nested = incoming[field];
    if (nested && typeof nested === 'object') details[field] = safeDetails({ code: nested.code,
      message: shortText(nested.message), details: nested.details || nested.params });
  }
  let message = Object.hasOwn(MESSAGES, code) ? MESSAGES[code]
    : launchError || vulkanError ? shortText(incoming.message) || MESSAGES.ERR_INTERNAL : MESSAGES.ERR_INTERNAL;
  if (originalCode === 'errBackendRecovery') message = '上次操作的回退尚未完成，恢复文件可能缺失。请保留游戏目录和 _DLSS5_Backup，先处理恢复；若仍失败，在“修复”页保存反馈。';
  if (originalCode === 'errUnsafeTarget') message = '目标路径或链接不符合安全写入条件，已停止操作。请核对游戏目录；无法确认时，在“修复”页保存反馈。';
  const sourceReason = shortText(incoming.message, 180);
  if (code.startsWith('ERR_PAYLOAD_SOURCE_') && sourceReason && sourceReason !== MESSAGES[code] && sourceReason !== MESSAGES.ERR_INTERNAL) message += ` 原因：${sourceReason}`;
  message += fileSummary(details);
  const reasons = { 'not-x64': '文件不是所需的 64 位组件。', 'missing-file': '配套文件缺失。', hash: '文件校验值与版本记录不匹配。', 'dx11-compatibility-metadata': 'DX11 桥接配套信息不匹配。' };
  if (typeof details.reason === 'string' && Object.hasOwn(reasons, details.reason)) message += ` ${reasons[details.reason]}`;
  if (code === 'ERR_GAME_RUNNING' && Array.isArray(details.processes)) {
    const names = [...new Set(details.processes.map(row => row && row.name)
      .filter(name => typeof name === 'string' && name.trim())
      .map(name => name.replace(/[\r\n\t]/g, ' ').slice(0, 100)))];
    if (names.length) message += ` 检测到：${names.slice(0, 3).join('、')}${names.length > 3 ? '等进程' : ''}。`;
  }
  const recovery = Boolean(incoming.recoveryError) || /RECOVER|RESTORE|BACKUP|RECEIPT|JOURNAL/.test(code) || /recover|restore|rollback/.test(String(details.phase || ''));
  if (launchError && !Object.hasOwn(MESSAGES, code)) {
    if (recovery) message += ' 请保留现有文件和备份，先核对恢复状态；若仍失败，在“修复”页保存反馈。';
    else if (/CONFLICT|EXTERNAL_CHANGE|FILE_CHANGED/.test(code)) message += ' 请先核对其他工具的改动，再重新预览；无法确认时，在“修复”页保存反馈。';
    else if (/RESOURCES|BACKEND_MISSING/.test(code)) message += ' 请检查所选组件目录是否完整，再准备组件或修复。';
    else if (/WRITE|APPLY|LAUNCH|LOAD|RUNTIME|NVAPI_/.test(code)) message += ' 请在“修复”页保存反馈，并核对 SR / FG 区域的设置及恢复状态。';
  }
  if (recovery && !message.includes('保留')) message += ' 恢复尚未确认完成，请保留现有文件和备份，在“修复”页保存反馈。';
  if (details.gameStarted === false) message += ' 本次未启动游戏。';
  const domains = Array.isArray(details.recoverableDomains) ? details.recoverableDomains.filter(value => value === 'sr' || value === 'fg') : [];
  if (domains.length) message += ` ${domains.map(value => value.toUpperCase()).join(' / ')} 设置仍有恢复记录，可在对应区域还原。`;
  if (details.recoveryStateKnown === false) message += ' 当前恢复状态无法确认，请勿反复写入。';
  if (!recovery && details.gameStarted === true && /LOAD|RUNTIME|runtime|load/.test(`${code} ${details.phase || ''}`)) {
    message += ' 若已进入游戏且核心面板可用，可按 F8 查看加载状态，并保存反馈。';
  }
  return {
    code,
    message: shortText(message, 1100),
    details,
    ...(originalCode && code !== originalCode ? { originalCode } : {})
  };
}

module.exports = { MESSAGES, appError, normalizeError };
