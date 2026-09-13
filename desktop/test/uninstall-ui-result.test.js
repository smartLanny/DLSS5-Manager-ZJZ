'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { executeUiAction } = require('../src/renderer/action-flow');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');

function fixture() {
  const notices = [], elements = new Map(); let refreshes = 0;
  const context = { window: { executeUiAction, manager: {} },
    $: id => { if (!elements.has(id)) elements.set(id, { checked: false }); return elements.get(id); },
    toast: (message, error = false) => notices.push({ message, error }),
    renderFeedbackSelect() {}, queueRefreshRetry() {}, closeModal() {},
    refreshGames: async () => { refreshes++; }, loadRepairDiagnostic: async () => {},
    setBusy(value) { vm.runInContext(`state.busy = ${Boolean(value)}`, context); } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('const state ='), source.indexOf('function escapeHtml(')), context);
  vm.runInContext(source.slice(source.indexOf('function coreVersionLabel('), source.indexOf('function versionOptionsMarkup(')), context);
  vm.runInContext(source.slice(source.indexOf('async function runAction('), source.indexOf('function queueRefreshRetry(')), context);
  vm.runInContext(source.slice(source.indexOf("$('modalConfirm').onclick = async"), source.indexOf("$('minBtn').onclick")), context);
  return { context, notices, elements, state: vm.runInContext('state', context), refreshes: () => refreshes };
}

test('successful archive feedback uses only the shared backup folder and notes externally changed sidecars', () => {
  const { context } = fixture();
  const result = { removed: true, historyRel: 'C:/Users/private-user/game/_DLSS5_Backup/xiaofeng-history/receipt.json', retainedSidecars: [], archivedConflictCopies: 2 };
  assert.equal(context.actionSuccessMessage('卸载完成', result), '卸载完成；备份已集中保存在 _DLSS5_Backup');
  result.retainedSidecars = ['C:/Users/private-user/game/changed.backup'];
  const message = context.actionSuccessMessage('卸载完成', result);
  assert.match(message, /被外部改动的备份已原位保留/);
  assert.doesNotMatch(message, /private-user|receipt\.json|changed\.backup|C:/);
  assert.equal(context.actionSuccessMessage('安装完成', {}), '安装完成');
});

test('failed service envelopes never show uninstall success and remain assigned to the selected game', async () => {
  const f = fixture();
  await f.context.runAction(async () => ({ ok: false, error: { code: 'ERR_FILE_CHANGED', message: '文件已被外部修改：kept.dll' } }), '卸载完成', true, 'failed-game');
  assert.equal(f.refreshes(), 0);
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0].error, true);
  assert.match(f.notices[0].message, /kept\.dll.*ERR_FILE_CHANGED/); assert.doesNotMatch(f.notices[0].message, /卸载完成/);
  assert.equal(f.state.lastFailureGame, 'failed-game'); assert.equal(f.state.feedbackGame, 'failed-game');
  assert.equal(f.state.busy, false);
});

test('a legacy success envelope carrying removed false is also prevented from producing a success toast', async () => {
  const f = fixture();
  await f.context.runAction(async () => ({ ok: true, value: { removed: false, warnings: [] } }), '卸载完成', true, 'legacy-game');
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0].error, true);
  assert.match(f.notices[0].message, /卸载未完成/); assert.doesNotMatch(f.notices[0].message, /卸载完成/);
  assert.equal(f.state.lastFailureGame, 'legacy-game');
});

test('the real uninstall confirmation handler forwards the game id for failure attribution', async () => {
  const f = fixture(), calls = [];
  f.state.pendingModal = { type: 'uninstall', id: 'confirmed-game' };
  f.context.$('removeSettingsCheck').checked = true;
  f.context.window.manager.uninstall = async (...args) => { calls.push(args); return { ok: false, error: { code: 'ERR_BACKUP_INVALID', message: '恢复记录需要处理。' } }; };
  await f.context.$('modalConfirm').onclick();
  assert.deepEqual(calls, [['confirmed-game', true]]);
  assert.equal(f.state.lastFailureGame, 'confirmed-game'); assert.equal(f.state.feedbackGame, 'confirmed-game');
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0].error, true); assert.doesNotMatch(f.notices[0].message, /卸载完成/);
});
