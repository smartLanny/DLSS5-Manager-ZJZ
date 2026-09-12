'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { noLinks, digestFile, atomicJson, fail } = require('./launch-safety');

function createGameFeatureConfirmations({ file, resolveExecutable }) {
  let serial = Promise.resolve();
  const serialize = work => { const next = serial.then(work, work); serial = next.catch(() => {}); return next; };
  async function identity(id, domain) {
    if (!['sr', 'fg'].includes(domain)) fail('SETTINGS_DOMAIN', '图像功能域无效。');
    const exe = path.resolve(resolveExecutable(id)); await noLinks(exe);
    const before = await fs.stat(exe), exeIdentity = await digestFile(exe), after = await fs.stat(exe);
    if (!before.isFile() || !exeIdentity || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino)
      fail('SETTINGS_EXE_CHANGED', '游戏程序在识别时改变，请刷新后重试。');
    return { exe, exeIdentity, domain };
  }
  const key = value => `${value.exe.toLowerCase()}|${value.domain}`;
  async function read() {
    await noLinks(file);
    let text; try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { version: 1, entries: {} }; throw error; }
    let state; try { state = JSON.parse(text); } catch { fail('SETTINGS_CONFIRMATION_INVALID', '游戏开关确认记录损坏。'); }
    if (text.length > 1024 * 1024 || state?.version !== 1 || !state.entries || Array.isArray(state.entries) || typeof state.entries !== 'object' ||
        Object.entries(state.entries).some(([entryKey, row]) => !row || !['sr', 'fg'].includes(row.domain) || row.enabled !== true ||
          typeof row.exe !== 'string' || !path.isAbsolute(row.exe) || !/^[a-f0-9]{64}$/.test(row.exeIdentity || '') || entryKey !== key(row)))
      fail('SETTINGS_CONFIRMATION_INVALID', '游戏开关确认记录无效。');
    return state;
  }
  async function inspect(id, domain, setting = {}) {
    return serialize(async () => {
      const bound = await identity(id, domain), state = await read(), stored = state.entries[key(bound)];
      // Seeing a known-off setting revokes an earlier confirmation permanently;
      // a later unreadable configuration must not revive it.
      const invalid = stored && (stored.exeIdentity !== bound.exeIdentity || setting.state === 'off');
      if (invalid) { delete state.entries[key(bound)]; await atomicJson(file, state); }
      return { ...bound, confirmation: invalid ? null : stored || null, runtimeVerified: false };
    });
  }
  async function confirm(id, domain, input, setting = {}) {
    if (input?.enabled !== true || Object.keys(input).some(name => name !== 'enabled')) fail('SETTINGS_CONFIRMATION_INPUT', '请明确确认已在游戏中开启此功能。');
    if (setting.state === 'off') fail('SETTINGS_GAME_FEATURE_OFF', '游戏配置显示功能已关闭，用户确认不能覆盖此证据。');
    if (setting.state === 'missing' && setting.requiresFirstRun === true) fail('SETTINGS_FIRST_RUN_REQUIRED', '请先运行游戏生成配置。');
    return serialize(async () => {
      const bound = await identity(id, domain), state = await read();
      const confirmation = { ...bound, enabled: true, confirmedAt: new Date().toISOString(), source: 'user-confirmation' };
      state.entries[key(bound)] = confirmation; await atomicJson(file, state);
      return { ...bound, confirmation, runtimeVerified: false };
    });
  }
  return Object.freeze({ identity, inspect, confirm });
}
module.exports = { createGameFeatureConfirmations };
