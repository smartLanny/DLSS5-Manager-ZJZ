'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveComponentStack } = require('../src/product/component-stack');

const core = { version:'0.4.7', label:'0.4.7（默认）', ready:true };
const runtime = { label:'RTX 50 系 NR 运行库', ready:true };

test('DX12 native route explicitly excludes Bridge and Feeder', () => {
  const result = resolveComponentStack({ api:'dx12', route:'native', core, runtime });
  assert.equal(result.status, 'ready');
  assert.match(result.title, /原生 DLSS/);
  assert.match(result.reason, /不需要 DLSS5 Bridge/);
  assert.equal(result.items.find(row => row.key === 'input').value, '游戏原生 DLSS 输入');
});

test('DX11 route binds one compatible DLSS5 Bridge to the selected Core', () => {
  const result = resolveComponentStack({ api:'dx11', route:'native', core, runtime,
    bridge:{label:'1.4.12 · NR 适配',ready:true,compatible:true} });
  assert.equal(result.status, 'ready'); assert.equal(result.manualBridge, true);
  assert.match(result.items.find(row => row.key === 'input').value, /DLSS5 Bridge/);
  const blocked = resolveComponentStack({ api:'dx11', route:'native', core, runtime,
    bridge:{label:'1.4.13-pre8',ready:true,compatible:false} });
  assert.equal(blocked.status, 'missing'); assert.match(blocked.items.find(row => row.key === 'input').detail, /接口不匹配/);
});

test('Feeder route owns its Core pairing and never also advertises Bridge', () => {
  const result = resolveComponentStack({ api:'dx10', route:'feeder', runtime,
    feeder:{version:'1.16.0-beta.2',coreVersion:'0.4.7-feeder',ready:true} });
  assert.equal(result.status, 'ready'); assert.match(result.title, /DLSS5 Feeder/);
  assert.match(result.items.find(row => row.key === 'core').detail, /不能任意混用/);
  assert.ok(result.items.every(row => !row.value.includes('Bridge')));
});

test('unknown API never guesses a component route', () => {
  const result = resolveComponentStack({ api:'mixed', core, runtime });
  assert.equal(result.status, 'needs-api'); assert.equal(result.route, 'unresolved');
  assert.match(result.reason, /不会猜测桥接器/);
});

test('component management uses explicit product names and hides source complexity by default', () => {
  const ui = fs.readFileSync(path.join(__dirname, '../src/renderer/component-library-ui.js'), 'utf8');
  const markup = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const game = fs.readFileSync(path.join(__dirname, '../src/renderer/game-page-ui.js'), 'utf8');
  assert.match(ui, /DLSS5 Bridge/); assert.match(ui, /DLSS5 Feeder/); assert.match(ui, /下载并准备/);
  assert.doesNotMatch(ui, /下载到缓存|图形桥|输入桥/);
  assert.match(markup, /id="componentRouteGameSelect"/); assert.match(markup, /class="panel component-expert-panel"/);
  assert.match(markup, /高级设置与存储位置/); assert.match(game, /AI 增强组件/);
});

