'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFeedbackCollector } = require('../src/product/feedback');

test('feedback collector records failures, redacts paths, and includes relevant logs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-feedback-'));
  const userData = path.join(root, 'user-data');
  const gameDir = path.join(root, 'game');
  const exeDir = path.join(gameDir, 'bin');
  fs.mkdirSync(exeDir, { recursive: true });
  fs.writeFileSync(path.join(exeDir, 'ReShade.log'), 'ReShade loaded\ninstall failed\n', 'utf8');

  const collector = createFeedbackCollector({ userData, productVersion: 'test-version' });
  await collector.record({ action: 'game-install', gameId: 'game-1', ok: false, errorCode: 'ERR_NO_WRITE_ACCESS', errorMessage: '没有权限' });

  const report = await collector.buildReport({
    gameId: 'game-1',
    game: {
      name: '示例游戏',
      launcher: '手动添加',
      dir: gameDir,
      chosen: { path: path.join(gameDir, 'bin', 'Game.exe'), apiLabel: 'DirectX 12', bitness: 64 }
    },
    diagnostic: { complete: false, components: [{ label: '写入权限', ok: false, detail: '异常' }] },
    hardware: { family: 'RTX40' },
    payload: { selectedVersion: '0.3.3.4', ready: true, missing: [], invalid: [] },
    settings: { customPath: path.join(os.homedir(), 'Documents', 'Private') }
  });

  assert.match(report.text, /ERR_NO_WRITE_ACCESS/);
  assert.match(report.text, /ReShade loaded/);
  assert.match(report.text, /%USERPROFILE%/);
  assert.doesNotMatch(report.text, new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  assert.match(report.suggestedName, /DLSS5-反馈-示例游戏-/);
});

test('feedback reports anti-cheat confirmation separately from a real failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-feedback-confirm-'));
  const collector = createFeedbackCollector({ userData: path.join(root, 'user-data'), productVersion: 'test-version' });
  await collector.record({
    action: 'game-repair',
    gameId: 'game-1',
    ok: false,
    outcome: '需确认',
    errorCode: 'ERR_ANTI_CHEAT_CONFIRM',
    errorMessage: '请确认后继续。'
  });

  const report = await collector.buildReport({
    gameId: 'game-1',
    game: { name: '示例游戏', launcher: 'Steam', dir: root, chosen: null },
    diagnostic: { complete: true, components: [] }
  });

  assert.match(report.text, /game-repair \| 需确认 \[ERR_ANTI_CHEAT_CONFIRM\]/);
  assert.doesNotMatch(report.text, /game-repair \| 失败 \[ERR_ANTI_CHEAT_CONFIRM\]/);
});

test('external Vulkan feedback retains startup identity and recent failure with bounded reads', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-feedback-vulkan-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const userData = path.join(root, 'user'), profile = path.join(userData, 'vulkan-runtime/game'), addons=path.join(profile,'addons');
  fs.mkdirSync(addons,{recursive:true});
  fs.writeFileSync(path.join(addons,'dlss5-feed.log'),'SOURCE_COMMIT=verified\n'+'routine frame\n'.repeat(150000)+'NR_COMPLETION_FAILED\n');
  fs.writeFileSync(path.join(profile,'ReShade.log'),'Vulkan layer loaded\n');
  const collector=createFeedbackCollector({userData});
  const report=await collector.buildReport({game:{name:'sample',dir:root},managedLogDirs:[profile,addons]});
  assert.match(report.text,/SOURCE_COMMIT=verified/);assert.match(report.text,/NR_COMPLETION_FAILED/);
  assert.match(report.text,/Vulkan layer loaded/);assert.match(report.text,/省略中间日志/);
  assert.ok(Buffer.byteLength(report.text)<28*1024);
  const outside=path.join(root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'dlss5-feed.log'),'OUTSIDE_NOT_INCLUDED');
  const refused=await collector.buildReport({game:{name:'sample',dir:root},managedLogDirs:[outside]});
  assert.doesNotMatch(refused.text,/OUTSIDE_NOT_INCLUDED/);
});

test('feedback distinguishes an incomplete Vulkan preparation from a deployed route', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-feedback-vulkan-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const collector = createFeedbackCollector({ userData: path.join(root, 'user') });
  const game = { name: 'Endfield fixture', dir: root,
    chosen: { path: path.join(root, 'Endfield.exe'), apiLabel: 'Vulkan', bitness: 64 } };
  const components = [
    { key: 'vulkan-profile', label: '外部运行组件', ok: true },
    { key: 'vulkan-layer', label: 'Vulkan 加载层', ok: false, detail: '需要管理员权限，加载层尚未写入' },
    { key: 'vulkan-activation', label: '按游戏激活', ok: false, detail: '尚未完成激活' }
  ];
  const prepared = await collector.buildReport({ game, diagnostic: {
    complete: false, pending: true, deploymentApi: 'vulkan', components
  } });
  assert.match(prepared.text, /部署状态：Vulkan 准备未完成/);
  assert.doesNotMatch(prepared.text, /已部署 API：vulkan/);
  assert.match(prepared.text, /Vulkan 加载层：需要管理员权限，加载层尚未写入/);

  const deployed = await collector.buildReport({ game, diagnostic: {
    complete: true, pending: false, deploymentApi: 'vulkan',
    components: components.map(row => ({ ...row, ok: true, detail: null }))
  } });
  assert.match(deployed.text, /已部署 API：vulkan/);
  assert.doesNotMatch(deployed.text, /Vulkan 准备未完成/);
});
