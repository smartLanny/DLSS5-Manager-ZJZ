'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function execute(program, args) {
  return new Promise(resolve => {
    execFile(program, args, {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 256 * 1024
    }, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function defaultRunner(scriptPath, scriptArgs) {
  const args = [
    '-NoLogo', '-NoProfile', '-NonInteractive',
    '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ...scriptArgs
  ];
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return execute(powershell, args);
}

function parseJsonLine(text) {
  const rows = String(text || '').split(/\r?\n/).map(row => row.trim()).filter(Boolean);
  for (let i = rows.length - 1; i >= 0; --i) {
    if (!rows[i].startsWith('{')) continue;
    try { return JSON.parse(rows[i]); } catch {}
  }
  return null;
}

function createNvapiDrs(options = {}) {
  const scriptPath = options.scriptPath;
  const runner = options.runner || defaultRunner;
  const platform = options.platform || process.platform;
  const exists = options.exists || fs.existsSync;

  async function invoke(scriptArgs) {
    if (platform !== 'win32') {
      return { ok: false, code: 'NVAPI_WINDOWS_ONLY', error: 'NVIDIA DLSS 模型覆盖仅支持 Windows。' };
    }
    if (!scriptPath || !exists(scriptPath)) {
      return { ok: false, code: 'NVAPI_HELPER_MISSING', error: 'NvAPI DRS 启动辅助脚本缺失。' };
    }
    let result;
    try { result = await runner(scriptPath, scriptArgs); }
    catch (error) {
      return { ok: false, code: 'NVAPI_RUNNER_FAILED', error: error && error.message ? error.message : String(error) };
    }
    const parsed = parseJsonLine(result && result.stdout);
    if (parsed && typeof parsed.ok === 'boolean') return parsed;
    const detail = String((result && result.stderr) || '').trim() ||
      (result && result.error && result.error.message) || 'NvAPI DRS 未返回可解析结果。';
    return { ok: false, code: 'NVAPI_BAD_RESPONSE', error: detail };
  }

  function validateExe(exePath) {
    return typeof exePath === 'string' && exePath.length > 0;
  }

  return {
    async readSrState({ exePath }) {
      if (!validateExe(exePath)) return { ok: false, code: 'NVAPI_BAD_EXE', error: '游戏 EXE 路径无效。' };
      return invoke(['-Action', 'read', '-ExePath', exePath]);
    },
    async applySrPreset({ exePath, preset, friendlyName = '' }) {
      const normalized = String(preset || '').toLowerCase();
      if (!['k', 'l', 'm'].includes(normalized)) {
        return { ok: false, code: 'NVAPI_BAD_PRESET', error: `不支持的 DLSS SR 模型：${preset}` };
      }
      if (!validateExe(exePath)) return { ok: false, code: 'NVAPI_BAD_EXE', error: '游戏 EXE 路径无效。' };
      const result = await invoke([
        '-Action', 'apply',
        '-ExePath', exePath,
        '-Preset', normalized.toUpperCase(),
        '-FriendlyName', String(friendlyName || '').slice(0, 160)
      ]);
      return { preset: normalized, ...result };
    },
    async restoreSrState({ exePath, baseline }) {
      if (!validateExe(exePath)) return { ok: false, code: 'NVAPI_BAD_EXE', error: '游戏 EXE 路径无效。' };
      if (!baseline || typeof baseline !== 'object') {
        return { ok: false, code: 'NVAPI_BAD_BASELINE', error: '缺少可恢复的 NVIDIA SR 配置快照。' };
      }
      const enable = baseline.enable && baseline.enable.explicit === true;
      const preset = baseline.preset && baseline.preset.explicit === true;
      return invoke([
        '-Action', 'restore', '-ExePath', exePath,
        '-EnableExplicit', enable ? '1' : '0',
        '-EnableValue', String(enable ? Number(baseline.enable.value) >>> 0 : 0),
        '-PresetExplicit', preset ? '1' : '0',
        '-PresetValue', String(preset ? Number(baseline.preset.value) >>> 0 : 0)
      ]);
    },
    selfTest() {
      return invoke(['-Action', 'selftest']);
    }
  };
}

module.exports = { createNvapiDrs, defaultRunner, parseJsonLine };
