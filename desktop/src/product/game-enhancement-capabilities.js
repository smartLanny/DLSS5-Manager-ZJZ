'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fgBackend } = require('./gpu');
// NVIDIA's DLSS 4.5 announcement names 595.79 as the minimum driver for
// Dynamic Multi Frame Generation and 6X Mode. Setting enumeration is separate.
// https://www.nvidia.com/en-us/geforce/news/dlss-4-5-rtx-path-tracing-game-announcements-gdc-2026/
const NVIDIA_FG_DRIVER = Object.freeze({ standard: 57216, advanced: 59579 });
const MFG_DYNAMIC_DRIVER = 59541;

// Static DLL evidence is not a runtime capability or a generated-frame result.
// Manager-owned external NR assets can never upgrade a game's SR/FG eligibility.
function x64Header(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd), dos = Buffer.alloc(64);
    if (fs.readSync(fd, dos, 0, 64, 0) !== 64 || dos.readUInt16LE(0) !== 0x5a4d) return false;
    const offset = dos.readUInt32LE(0x3c), header = Buffer.alloc(26);
    return offset >= 64 && offset <= 1024 * 1024 && offset + 26 <= stat.size &&
      fs.readSync(fd, header, 0, 26, offset) === 26 && header.readUInt32LE(0) === 0x4550 &&
      header.readUInt16LE(4) === 0x8664 && header.readUInt16LE(24) === 0x20b;
  } finally { fs.closeSync(fd); }
}
function inspectNativeEnhancementCapabilities(scan, options = {}) {
  function contains(rows, expected) {
    return Array.isArray(rows) && rows.some(row => {
      const file = row?.path || row?.file;
      if (typeof file !== 'string' || !path.isAbsolute(file) || path.basename(file).toLowerCase() !== expected ||
          /(?:^|[\\/])(?:_DLSS5_Feeder|_DLSS5_Backup|feeder-runtime|vulkan-runtime)(?:[\\/]|$)/i.test(file)) return false;
      try {
        const stat = fs.lstatSync(file);
        return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
          (options.pe ? options.pe.getBitness(file) === 64 : x64Header(file));
      } catch { return false; }
    });
  }
  const nativeDlssAvailable = contains(scan?.dlssFiles, 'nvngx_dlss.dll') || contains([scan?.primaryDlss], 'nvngx_dlss.dll');
  const nativeFgAvailable = contains(scan?.dlssFiles, 'nvngx_dlssg.dll') && contains(scan?.streamlineFiles, 'sl.dlss_g.dll') &&
    (contains(scan?.streamlineFiles, 'sl.interposer.dll') || contains(scan?.streamlineFiles, 'sl.common.dll'));
  return { nativeDlssAvailable, nativeFgAvailable, staticOnly: true };
}
// Driver setting enumeration describes the driver, not the selected game's
// implementation. Keep those facts separate all the way to the write boundary.
function assessEnhancementState({ domain, request = {}, game = {}, hardware = {}, driver = {} } = {}) {
  const blockers = [], warnings = [];
  const add = (code, message) => blockers.push({ code, message });
  const support = game.support || { status: 'unknown', source: null, evidence: [] };
  const setting = game.gameSetting || { state: 'unknown', source: null };
  const series = [...new Set(Array.isArray(hardware.series) ? hardware.series : [])];
  const singleGpu = hardware.source !== 'unavailable' && hardware.family !== 'mixed' && series.length === 1;
  const backend = request.backend || (domain === 'sr' ? 'native' : fgBackend(hardware) || 'nvidia');
  const isDriver = backend === 'native' || backend === 'nvidia';
  const feature = domain === 'sr' ? 'DLSS 超分' : 'DLSS 帧生成';
  if (!['sr', 'fg'].includes(domain)) add('SETTINGS_DOMAIN', '图像功能域无效。');
  if (!singleGpu || domain === 'sr' && !/^RTX(?:20|30|40|50)$/.test(series[0] || '') ||
      domain === 'fg' && (backend === 'dlssg-sm86' ? !['RTX20','RTX30'].includes(series[0]) : backend === 'nvidia' ? series[0] !== 'RTX50' : !['mfgunlock', 'rtx40'].includes(backend) || series[0] !== 'RTX40'))
    add('SETTINGS_GPU_UNKNOWN', '当前显卡未确认满足此功能要求。');
  if (support.status !== 'supported' || !['catalog', 'native-integration', 'trusted-mod', 'runtime'].includes(support.source))
    add(support.status === 'unsupported' ? 'SETTINGS_GAME_UNSUPPORTED' : 'SETTINGS_GAME_SUPPORT_UNKNOWN',
      support.status === 'unsupported' ? `当前游戏明确不支持此${feature}路线。` : `尚无可核对的游戏${feature}支持证据。`);
  if (isDriver) {
    if (driver.available !== true) add('SETTINGS_DRIVER_UNAVAILABLE', '无法确认 NVIDIA 驱动设置接口可用。');
    const required = request.requiredSettingIds || [];
    if (!Array.isArray(driver.settingIds) || required.some(id => !driver.settingIds.includes(id)))
      add('SETTINGS_DRIVER_SETTINGS_UNKNOWN', '当前驱动尚未确认提供所需设置；配置值缺失不代表游戏不支持。');
    if (request.minimumDriverVersion && (!Number.isInteger(driver.version) || driver.version < request.minimumDriverVersion))
      add('SETTINGS_DRIVER_VERSION_UNCONFIRMED', '尚未确认当前驱动达到此选项所需版本。');
  }
  const capabilities = support.capabilities || {};
  const sm86Ready = backend === 'dlssg-sm86' && support.status === 'supported' && game.staticEvidence?.nativeFgAvailable === true && game.staticEvidence?.api === 'dx12';
  if (backend === 'dlssg-sm86' && !sm86Ready) add('SETTINGS_SM86_INTEGRATION', 'SM86 需要所选 x64 DX12 游戏已有可信的原生 DLSS 帧生成集成。');
  if (backend === 'mfgunlock' && capabilities.mfgUnlock?.available !== true)
    add('SETTINGS_MFG_RUNTIME_UNCONFIRMED', capabilities.mfgUnlock?.api && capabilities.mfgUnlock.api !== 'dx12'
      ? '当前 MFG Unlock 配套仅对已确认的 DX12 路线开放。'
      : '尚未确认已有 x64 DLSS-G 310.x 或更新运行库，不能准备 MFG Unlock。');
  // Current MFG 1.0 and the retained 0.9 fallback share this fixed/Dynamic
  // contract. Runtime evidence must still identify the actually loaded build.
  // The native integration alone proves neither Dynamic support nor >2x capacity.
  const mfg = capabilities.mfgUnlock || {};
  const versionIs = (value, expected) => typeof value === 'string' && (value === expected || value.startsWith(expected + '.'));
  const mfgDynamicReady = backend === 'mfgunlock' && mfg.available === true && mfg.api === 'dx12' && ['1.0', '0.9'].includes(mfg.providerVersion) &&
    versionIs(mfg.dlssgVersion, '310.9.1') && versionIs(mfg.streamlineVersion, '2.14.1') &&
    mfg.dynamicSupportObserved === true && mfg.dynamicSupported === true && driver.available === true &&
    Number.isInteger(driver.version) && driver.version >= MFG_DYNAMIC_DRIVER;
  const declaredMultipliers = backend === 'dlssg-sm86' ? (sm86Ready ? [2,3,4,...(capabilities.dlssgSm86?.sixXSupported === true && capabilities.dlssgSm86?.gamePluginSupportsSixX === true ? [5,6] : [])] : [])
    : backend === 'mfgunlock' ? (mfg.available === true && Array.isArray(mfg.multipliers) ? mfg.multipliers : [])
    : Array.isArray(capabilities.multipliers) ? capabilities.multipliers : [2];
  let multipliers = [...new Set(declaredMultipliers.filter(value => Number.isInteger(value) && value >= 2 && value <= 6))];
  let modes = backend === 'dlssg-sm86' ? (sm86Ready ? ['off','follow','fixed'] : []) : backend === 'mfgunlock' ? (mfg.available === true ? ['follow', ...(multipliers.length ? ['fixed'] : []), ...(mfgDynamicReady ? ['dynamic'] : [])] : []) : backend === 'nvidia'
    ? ['off', 'fixed', ...(capabilities.dynamic === true ? ['dynamic'] : [])] : [];
  let capabilityOptions = null;
  if (domain === 'fg' && backend === 'nvidia') {
    const option = (value, declared, advanced = false) => {
      const minimumDriverVersion = advanced ? NVIDIA_FG_DRIVER.advanced : NVIDIA_FG_DRIVER.standard;
      let code = null, message = null;
      if (support.status !== 'supported' || !['catalog', 'native-integration', 'trusted-mod', 'runtime'].includes(support.source) || !declared) {
        code = typeof value === 'number' ? 'SETTINGS_MULTIPLIER_UNCONFIRMED' : 'SETTINGS_MODE_UNSUPPORTED';
        message = typeof value === 'number' ? `尚未确认此游戏支持 ${value}×；需要该游戏的官方或运行时能力证据。`
          : '尚未确认此游戏支持该模式；基础帧生成集成不能单独证明支持动态补帧。';
      } else if (!singleGpu || series[0] !== 'RTX50') {
        code = 'SETTINGS_GPU_UNKNOWN'; message = '官方多帧生成需要已确认的 RTX 50 系列显卡。';
      } else if (driver.available !== true) {
        code = 'SETTINGS_DRIVER_UNAVAILABLE'; message = '无法读取 NVIDIA 驱动设置接口。';
      } else if (!Array.isArray(driver.settingIds) || (request.requiredSettingIds || []).some(id => !driver.settingIds.includes(id))) {
        code = 'SETTINGS_DRIVER_SETTINGS_UNKNOWN'; message = '当前驱动未提供完整的补帧设置键。';
      } else if (!Number.isInteger(driver.version) || driver.version < minimumDriverVersion) {
        code = 'SETTINGS_DRIVER_VERSION_UNCONFIRMED'; message = `此选项需要 ${Math.floor(minimumDriverVersion / 100)}.${String(minimumDriverVersion % 100).padStart(2, '0')} 或更新驱动。`;
      }
      return { value, available: code === null, code, message, minimumDriverVersion };
    };
    capabilityOptions = { multipliers: [2, 3, 4, 5, 6].map(value => option(value, multipliers.includes(value), value > 4)),
      modes: ['off', 'fixed', 'dynamic'].map(value => option(value, modes.includes(value), value === 'dynamic')) };
    multipliers = capabilityOptions.multipliers.filter(row => row.available).map(row => row.value);
    modes = capabilityOptions.modes.filter(row => row.available).map(row => row.value);
  }
  if (domain === 'fg' && request.mode && !['restore', ...modes, ...(backend === 'rtx40' ? ['follow', 'fixed', 'dynamic'] : [])].includes(request.mode)) {
    const row = capabilityOptions?.modes.find(value => value.value === request.mode);
    const dynamicMfg = backend === 'mfgunlock' && request.mode === 'dynamic';
    if (!blockers.some(value => value.code === row?.code || dynamicMfg && value.code === 'SETTINGS_MFG_DYNAMIC_UNCONFIRMED'))
      add(dynamicMfg ? 'SETTINGS_MFG_DYNAMIC_UNCONFIRMED' : row?.code || 'SETTINGS_MODE_UNSUPPORTED', dynamicMfg
        ? 'Dynamic MFG 仅在已观察到 D3D12、MFG 1.0/0.9、DLSS-G 310.9.1、Streamline 2.14.1、驱动 595.41+ 且运行库报告支持时开放。'
        : row?.message || '当前后端及游戏证据未确认支持此补帧模式。');
  }
  if (domain === 'fg' && request.mode === 'fixed' && !multipliers.includes(request.multiplier)) {
    const row = capabilityOptions?.multipliers.find(value => value.value === request.multiplier);
    if (!blockers.some(value => value.code === row?.code)) add(row?.code || 'SETTINGS_MULTIPLIER_UNCONFIRMED', row?.message || '此游戏及当前运行库尚未确认支持请求的倍率。');
  }
  // An override can be configured while the feature is off. The game switch is
  // activation evidence, not permission to invent support. Old user statements
  // deliberately have no role in this decision, including the write boundary.
  const activation = { state: ['on', 'off', 'missing'].includes(setting.state) ? setting.state : 'unknown',
    source: setting.source || null, runtimeVerified: false,
    message: setting.state === 'on' ? `游戏配置显示${feature}已开启；实际采用仍待本次运行确认。`
      : setting.state === 'off' ? `游戏配置显示${feature}已关闭；请在游戏中开启后使用本次设置。`
      : setting.state === 'missing' ? `尚未读取到游戏设置；使用时请在游戏中开启${feature}。`
      : `游戏内${feature}开关状态尚未核实；本页不代替游戏开启此功能，实际采用需进入游戏确认。` };
  if (setting.state === 'missing' && setting.requiredForSupport === true)
    add('SETTINGS_FIRST_RUN_REQUIRED', '尚未生成用于验证此游戏集成的必需配置，请正常运行一次后重新检测。');
  const evidence = { support, static: game.staticEvidence || null, driver: { ...driver, perGameSupport: false },
    gameSetting: setting, confirmation: null };
  const state = blockers.some(row => row.code === 'SETTINGS_FIRST_RUN_REQUIRED') ? 'waiting-first-run' : blockers.length ? 'unavailable' : 'configurable';
  return { domain, backend, eligible: blockers.length === 0, blockers, warnings, evidence, activation,
    state, canConfirm: false,
    availableModes: modes, availableMultipliers: multipliers, capabilityOptions, runtimeVerified: false,
    actual: { state: 'unknown', source: null }, officialOverrideCertified: support.source === 'catalog' && support.official === true };
}
module.exports = { inspectNativeEnhancementCapabilities, assessEnhancementState, NVIDIA_FG_DRIVER, MFG_DYNAMIC_DRIVER };
