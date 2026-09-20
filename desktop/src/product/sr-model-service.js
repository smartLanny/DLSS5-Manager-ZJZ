'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { appError } = require('./errors');
const { detectGpu } = require('./gpu');
const { createNvapiDrs } = require('./nvapi-drs');
const { atomicJson } = require('./launch-safety');
const policyWrites = require('./work-scheduler').createWorkScheduler();
const {
  CHOICES,
  normalizeChoice,
  hardwareSeries,
  recommendSrPreset,
  effectiveSrPreset,
  hasFp8Penalty
} = require('./sr-model-policy');

function normalizeEntry(value) {
  if (typeof value === 'string') return { selection: normalizeChoice(value), baseline: null };
  if (!value || typeof value !== 'object') return { selection: 'auto', baseline: null };
  const baseline = value.baseline && typeof value.baseline === 'object' ? value.baseline : null;
  return { selection: normalizeChoice(value.selection), baseline,
    baselineExecutable: typeof value.baselineExecutable === 'string' ? value.baselineExecutable : null,
    lastAppliedPreset: ['k', 'l', 'm'].includes(value.lastAppliedPreset) ? value.lastAppliedPreset : null };
}

function loadPolicies(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = {};
    for (const [key, value] of Object.entries(parsed && parsed.games || {})) {
      if (typeof key !== 'string' || !path.isAbsolute(key)) continue;
      out[path.resolve(key).toLowerCase()] = normalizeEntry(value);
    }
    return out;
  } catch {
    return {};
  }
}

async function savePolicies(file, games) {
  await atomicJson(file, { version: 2, games });
}

function resolveHelperPath(resourcesPath, appDir) {
  const packaged = resourcesPath ? path.join(resourcesPath, 'nvapi-drs.ps1') : null;
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.join(appDir, 'src', 'product', 'nvapi-drs.ps1');
}

function createSrModelService(options) {
  const policyFile = path.join(options.userData, 'sr-model-policies.json');
  const detectHardware = options.detectHardware || detectGpu;
  const gameDirectory = options.gameDirectory;
  const gameExecutable = options.gameExecutable;
  const nvapi = options.nvapi || createNvapiDrs({
    scriptPath: resolveHelperPath(options.resourcesPath, options.appDir)
  });

  function keyForGame(id) {
    const dir = gameDirectory(id);
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw appError('ERR_UNKNOWN_GAME');
    return path.resolve(dir).toLowerCase();
  }

  function entryForGame(id, games = loadPolicies(policyFile)) {
    return games[keyForGame(id)] || { selection: 'auto', baseline: null };
  }

  async function read(id) {
    assertPoliciesReadable();
    const hardware = detectHardware();
    const entry = entryForGame(id);
    const selection = entry.selection;
    const recommended = recommendSrPreset(hardware);
    const effective = effectiveSrPreset(selection, hardware);
    return {
      configured: Object.hasOwn(loadPolicies(policyFile), keyForGame(id)),
      selection,
      effective,
      recommended,
      hardwareSeries: hardwareSeries(hardware),
      hardwareNames: Array.isArray(hardware && hardware.names) ? hardware.names : [],
      hardwareFamily: hardware && hardware.family || 'unknown',
      fp8Penalty: hasFp8Penalty(hardware, effective),
      baselineCaptured: Boolean(entry.baseline)
    };
  }

  async function write(id, selection) {
    assertPoliciesReadable();
    const normalized = String(selection || '').trim().toLowerCase();
    if (!CHOICES.includes(normalized)) throw appError('ERR_BAD_REQUEST', { selection });
    const games = loadPolicies(policyFile);
    const key = keyForGame(id);
    const existing = games[key] || { selection: 'auto', baseline: null };
    games[key] = { ...existing, selection: normalized };
    await savePolicies(policyFile, games);
    return read(id);
  }

  async function applyBeforeLaunch(id) {
    const state = await read(id);
    const exe = gameExecutable(id);
    if (typeof exe !== 'string' || !path.isAbsolute(exe) || path.extname(exe).toLowerCase() !== '.exe') {
      throw appError('ERR_NO_GAME_EXE');
    }
    const key = keyForGame(id);
    const games = loadPolicies(policyFile);
    if (!Object.hasOwn(games, key)) {
      return { ...state, apply: { ok: true, skipped: true, restored: false, reason: 'no-explicit-model-selection' } };
    }
    const entry = games[key] || { selection: state.selection, baseline: null };
    if (entry.baseline && entry.baselineExecutable && path.resolve(entry.baselineExecutable).toLowerCase() !== path.resolve(exe).toLowerCase()) {
      throw Object.assign(new Error('旧 SR 配置属于另一个 EXE，请先恢复原程序的设置。'), { code: 'SETTINGS_EXE_CHANGED' });
    }

    if (state.effective === 'default') {
      if (!entry.baseline) {
        return { ...state, apply: { ok: true, skipped: true, restored: false, reason: 'no-manager-owned-override' } };
      }
      let restored;
      try { restored = await nvapi.restoreSrState({ exePath: exe, baseline: entry.baseline }); }
      catch (error) { restored = { ok: false, code: 'NVAPI_RESTORE_FAILED', error: error && error.message ? error.message : String(error) }; }
      if (restored.ok) {
        games[key] = { ...entry, baseline: null };
        await savePolicies(policyFile, games);
      }
      return { ...state, apply: { ...restored, restored: restored.ok === true } };
    }

    if (!entry.baseline) {
      let baseline;
      try { baseline = await nvapi.readSrState({ exePath: exe }); }
      catch (error) { baseline = { ok: false, code: 'NVAPI_READ_FAILED', error: error && error.message ? error.message : String(error) }; }
      if (!baseline.ok) {
        return {
          ...state,
          apply: {
            ok: false,
            code: baseline.code || 'NVAPI_BASELINE_UNAVAILABLE',
            error: `无法安全读取当前 NVIDIA 每游戏 SR 配置，因此没有覆盖原设置：${baseline.error || 'unknown error'}`
          }
        };
      }
      entry.baseline = {
        profileFound: baseline.profileFound === true,
        enable: baseline.enable || { explicit: false, value: 0 },
        preset: baseline.preset || { explicit: false, value: 0 }
      };
      entry.baselineExecutable = exe;
      games[key] = entry;
      await savePolicies(policyFile, games);
    }

    const hash = crypto.createHash('sha256').update(path.resolve(exe).toLowerCase()).digest('hex').slice(0, 8);
    const friendlyName = `Xiaofeng DLSS5 - ${path.basename(exe, path.extname(exe))} [${hash}]`;
    let apply;
    try { apply = await nvapi.applySrPreset({ exePath: exe, preset: state.effective, friendlyName }); }
    catch (error) { apply = { ok: false, code: 'NVAPI_APPLY_FAILED', error: error && error.message ? error.message : String(error) }; }
    if (apply.ok) {
      games[key] = { ...entry, lastAppliedPreset: state.effective };
      await savePolicies(policyFile, games);
    }
    return { ...state, apply };
  }

  function assertPoliciesReadable() {
    if (!fs.existsSync(policyFile)) return;
    try {
      const value = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
      if (!value || !value.games || typeof value.games !== 'object' || Array.isArray(value.games)) throw new Error('Invalid policies');
      for (const row of Object.values(value.games)) {
        if (!row?.baseline) continue;
        for (const name of ['enable', 'preset']) {
          const item = row.baseline[name];
          if (!item || typeof item.explicit !== 'boolean' || !(item.explicit === false && item.value === null) &&
              (!Number.isInteger(item.value) || item.value < 0 || item.value > 0xffffffff)) throw new Error('Invalid baseline');
        }
      }
    } catch {
      throw Object.assign(new Error('旧 SR 恢复记录无法可靠读取，已保留原文件，未启用新覆盖。'), { code: 'SETTINGS_LEGACY_MIGRATION' });
    }
  }
  async function migrationInfo(id) { assertPoliciesReadable(); return read(id); }
  async function prepareMigration(id) {
    assertPoliciesReadable();
    const state = await read(id), key = keyForGame(id), games = loadPolicies(policyFile);
    const entry = games[key];
    if (!entry?.baseline) return { ok: true, restored: false, ...state };
    const exe = gameExecutable(id);
    const sameExe = value => typeof value === 'string' && path.resolve(value).toLowerCase() === path.resolve(exe).toLowerCase();
    if (entry.baselineExecutable && !sameExe(entry.baselineExecutable)) {
      throw Object.assign(new Error('旧 SR 恢复记录属于另一个 EXE，未覆盖当前程序。'), { code: 'SETTINGS_EXE_CHANGED' });
    }
    const current = await nvapi.readSrState({ exePath: exe });
    if (!current.ok) throw Object.assign(new Error('无法读取旧 SR 配置，未启用新覆盖。'), { code: 'SETTINGS_LEGACY_MIGRATION' });
    const hash = crypto.createHash('sha256').update(path.resolve(exe).toLowerCase()).digest('hex').slice(0, 8);
    const expectedProfile = `Xiaofeng DLSS5 - ${path.basename(exe, path.extname(exe))} [${hash}]`;
    if (!entry.baselineExecutable && current.profile !== expectedProfile) {
      throw Object.assign(new Error('旧版本未记录 SR 所属 EXE，且当前不是可确认的专属配置；保留旧恢复记录，请先核对原游戏程序。'), { code: 'SETTINGS_LEGACY_MIGRATION' });
    }
    const sameSetting = (actual, baseline) => baseline?.explicit === true
      ? actual?.explicit === true && actual.value === baseline.value : actual?.explicit !== true;
    const alreadyRestored = sameSetting(current.enable, entry.baseline.enable) && sameSetting(current.preset, entry.baseline.preset);
    const expectedPreset = { k: 11, l: 12, m: 13 }[entry.lastAppliedPreset || state.effective];
    if (!alreadyRestored && !(current.enable?.explicit === true && current.enable.value === 1 &&
        current.preset?.explicit === true && current.preset.value === expectedPreset)) {
      throw Object.assign(new Error('旧 SR 设置已被其他工具修改，未自动覆盖。'), { code: 'SETTINGS_EXTERNAL_CHANGE' });
    }
    if (!alreadyRestored) {
      const result = await nvapi.restoreSrState({ exePath: exe, baseline: entry.baseline });
      if (!result.ok) throw Object.assign(new Error('恢复旧 SR 配置失败，原恢复记录已保留。'), { code: 'SETTINGS_LEGACY_MIGRATION' });
      const verified = await nvapi.readSrState({ exePath: exe });
      if (!verified.ok || !sameSetting(verified.enable, entry.baseline.enable) || !sameSetting(verified.preset, entry.baseline.preset)) {
        throw Object.assign(new Error('旧 SR 配置恢复后的读回不一致，未启用新覆盖。'), { code: 'SETTINGS_LEGACY_MIGRATION' });
      }
    }
    games[key] = { ...entry, baseline: null, baselineExecutable: null, lastAppliedPreset: null };
    await savePolicies(policyFile, games);
    return { ok: true, restored: true, selection: state.selection, effective: state.effective };
  }

  const serialized = fn => (...args) => policyWrites.run(path.resolve(policyFile).toLowerCase(), () => fn(...args));
  return { read, write: serialized(write), applyBeforeLaunch: serialized(applyBeforeLaunch), prepareMigration: serialized(prepareMigration), migrationInfo, policyFile };
}

module.exports = { createSrModelService, loadPolicies, savePolicies, resolveHelperPath, normalizeEntry };
