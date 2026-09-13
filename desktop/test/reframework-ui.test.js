'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');

function uiContext() {
  const context = { escapeHtml: value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]) };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('const REFRAMEWORK_PROFILE'), source.indexOf('function detailKey(')), context);
  return context;
}

test('Capcom RE compatibility row is limited to the exact supported profile', () => {
  const context = uiContext();
  context.game = { reframework: { matched: true, label: 'REFramework', profile: 'onimusha-wots-reframework-01417' } };
  const html = vm.runInContext('reframeworkHostMarkup(game)', context);
  assert.match(html, /卡普空 RE 引擎兼容/);
  assert.match(html, /REFramework 01417 · 正在检查/);
  assert.doesNotMatch(html, /config-block/);
  context.game = { installed: false, reframework: { matched: true, profile: 're9-reframework-01417' } };
  const re9 = vm.runInContext('reframeworkHostMarkup(game)', context);
  assert.match(re9, /data-reframework-profile="re9-reframework-01417"/);
  assert.match(re9, /卡普空 RE 引擎兼容/);
  context.game.reframework.profile = 'bad profile!';
  assert.equal(vm.runInContext('reframeworkHostMarkup(game)', context), '');
});

test('unknown RE engine evidence stays informational and has no deployment action', () => {
  const context = uiContext();
  context.game = { engine: { id: 're-engine', label: '卡普空 RE 引擎', compatibilityKnown: false,
    evidence: [{ kind: 'module', source: 're9.exe', detail: '检测到 RE Engine 模块' }] } };
  const html = vm.runInContext('unknownReEngineMarkup(game)', context);
  assert.match(html, /当前没有已确认的兼容配套/);
  assert.match(html, /不会自动部署 REFramework/);
  assert.match(html, /检测到 RE Engine 模块/);
  assert.doesNotMatch(html, /reframework-(?:prepare|restore|recover)-btn/);
});

test('card actions follow readiness and loader ownership without visual runtime claims', () => {
  const context = uiContext();
  context.info = { matched: true, ready: false, canPrepare: true, loader: { exists: false, ownership: 'absent' },
    config: { effective: false, existingStoragePreferred: true, seed: {} }, blockers: [], warnings: [], gameRuntimeVerified: true };
  let html = vm.runInContext('reframeworkCardMarkup(info)', context);
  assert.match(html, /待安装/); assert.match(html, /准备 REFramework/); assert.doesNotMatch(html, /撤销 REFramework/);
  assert.match(html, /一键安装时自动准备 REFramework/);
  assert.doesNotMatch(html, /gameRuntimeVerified|游戏验证/);

  context.info = { ...context.info, ready: true, canPrepare: false, loader: { exists: true, ownership: 'external' } };
  html = vm.runInContext('reframeworkCardMarkup(info)', context);
  assert.match(html, /已使用现有框架/); assert.match(html, /不会取得删除权/);
  assert.doesNotMatch(html, /reframework-(?:prepare|restore)-btn/);

  context.info = { ...context.info, loader: { exists: true, ownership: 'owned' } };
  html = vm.runInContext('reframeworkCardMarkup(info)', context);
  assert.match(html, /已就绪/); assert.match(html, /撤销 REFramework/); assert.match(html, /玩家设置/);
});

test('blockers warnings and operation errors stay inside the card and are escaped', () => {
  const context = uiContext();
  context.info = { ready: false, canPrepare: false, loader: { ownership: 'absent' }, config: {},
    blockers: [{ code: 'B', message: '关闭<冲突>' }], warnings: ['保留已有配置'] };
  context.error = '恢复失败<ERR>';
  const html = vm.runInContext('reframeworkCardMarkup(info, false, error)', context);
  assert.match(html, /需处理/); assert.match(html, /关闭&lt;冲突&gt;/);
  assert.match(html, /保留已有配置/); assert.match(html, /恢复失败&lt;ERR&gt;/);
  assert.match(html, /role="alert"/);
});

test('unfinished operations expose recovery instead of install or restore', () => {
  const context = uiContext();
  context.info = { ready: false, canPrepare: false, needsRecovery: true,
    loader: { exists: true, ownership: 'owned' }, config: {},
    blockers: ['兼容组件有未完成操作，请先恢复'], warnings: [] };
  const html = vm.runInContext('reframeworkCardMarkup(info)', context);
  assert.match(html, /需恢复/);
  assert.match(html, /恢复未完成操作/);
  assert.doesNotMatch(html, /reframework-(?:prepare|restore)-btn/);
});

test('compatibility repair keeps D3D12 and Capcom RE actions at the same level with solid buttons', () => {
  const detail = source.slice(source.indexOf('function gameDetail('), source.indexOf('function renderGames('));
  const compatibility = source.slice(source.indexOf('function compatibilityRepairMarkup('), source.indexOf('function reframeworkMessage('));
  assert.match(compatibility, /d3d12-btn/);
  assert.match(compatibility, /compat-action-grid.*\$\{d3d12\}\$\{reframework\}/s);
  assert.match(compatibility, /<details class="compat-help">/);
  assert.match(detail, /compatibilityRepairMarkup\(game, true\)/);
  assert.doesNotMatch(detail, /button subtle d3d12-btn/);
  const card = source.slice(source.indexOf('function reframeworkCardMarkup('), source.indexOf('function detailKey('));
  assert.match(card, /button reframework-restore-btn/);
  assert.doesNotMatch(card, /button subtle reframework-restore-btn/);
});

test('automatic RE preparation preserves native success and reports its own result', () => {
  const context = { coreVersionLabel: String };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function actionSuccessMessage('), source.indexOf('function versionOptionsMarkup(')), context);
  const failed = vm.runInContext("actionSuccessMessage('安装完成', { reframework: { automatic: true, ready: false, error: { code: 'RF_COPY', message: '复制失败' } } })", context);
  assert.equal(failed, '核心已安装；卡普空 RE 引擎兼容未完成：复制失败 [RF_COPY]');
  const ready = vm.runInContext("actionSuccessMessage('修复完成', { reframework: { automatic: true, ready: true } })", context);
  assert.equal(ready, '核心已更新；已自动准备卡普空 RE 引擎兼容');
});

test('renderer wires standard read prepare and restore envelopes and refreshes only the card', () => {
  const seam = source.slice(source.indexOf('function bindReframeworkCard('), source.indexOf('async function loadExpanded('));
  assert.match(seam, /window\.manager\.readReframework\(id\)/);
  assert.match(seam, /window\.manager\.prepareReframework\(id, \{ allowAntiCheat \}\)/);
  assert.match(seam, /window\.manager\.restoreReframework\(id\)/);
  assert.match(seam, /window\.manager\.recoverReframework\(id\)/);
  assert.match(seam, /runConfirmedAction\(/); assert.match(seam, /runAction\(/);
  assert.match(seam, /await loadReframeworkCard\(root, id/);
  assert.doesNotMatch(seam, /refreshGames\(/);
});

test('0.4.7 beta labels retain the beta marker', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function coreVersionLabel('), source.indexOf('function catalogReplacement(')), context);
  assert.equal(vm.runInContext("coreVersionLabel('0.4.7beta')", context), '0.4.7beta');
  assert.equal(vm.runInContext("coreVersionLabel('0.4.7-beta')", context), '0.4.7beta');
  assert.equal(vm.runInContext("coreVersionLabel('0.4.6-hotfix.1')", context), '0.4.6-hotfix.1 · Beta');
  assert.equal(vm.runInContext("coreVersionLabel('0.2.0-beta.2')", context), '0.2.0');
});

test('beta0.4.7 is selectable for both DX11 and DX12 with its matching companion', () => {
  const context = { escapeHtml: String, state: { payload: { selectedVersion: '0.4.6-hotfix.1', versions: {
    '0.4.6-hotfix.1': { label: '0.4.6-hotfix.1 · Beta', compatibility: 'dx11' },
    '0.4.7beta': { label: 'beta0.4.7', compatibility: 'dx11' }
  } }, addons: [] } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function coreVersionLabel('), source.indexOf('function poster(')), context);
  context.game = { chosen: { apiResolution: { api: 'dx11' } } };
  const dx11 = vm.runInContext("versionOptionsMarkup('0.4.6-hotfix.1', false, game)", context);
  assert.match(dx11, /value="0\.4\.7beta">0\.4\.7beta/);
  assert.doesNotMatch(dx11, /仅原生 DX12|0\.4\.7beta"[^>]*disabled/);
  context.game.chosen.apiResolution.api = 'dx12';
  const dx12 = vm.runInContext("versionOptionsMarkup('0.4.7beta', false, game)", context);
  assert.match(dx12, /value="0\.4\.7beta" selected>0\.4\.7beta/);
  assert.doesNotMatch(dx12, /0\.4\.7beta"[^>]*disabled/);
});
