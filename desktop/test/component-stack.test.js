'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveStack, resolveComponentStack } = require('../src/product/component-stack');

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

test('Vulkan Bridge is presented as DLSS5 Bridge rather than an unnamed special route', () => {
  const result = resolveComponentStack({ api:'vulkan', route:'bridge', core, runtime,
    bridge:{label:'1.4.13-pre8 · 实验',ready:true,compatible:true} });
  assert.match(result.title, /DLSS5 Bridge/);
  assert.match(result.items.find(row => row.key === 'input').value, /1\.4\.13-pre8/);
  assert.equal(result.manualBridge, true);
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

const digest = digit => String(digit).repeat(64);
const routeInventory = () => [
  { id:'0.4.7beta', kind:'core', version:'0.4.7beta', architecture:'x64', inputInterfaces:['NGX-D3D12-Feature1'], ready:true },
  { id:'0.5-dline21', kind:'core', version:'0.5 D21', architecture:'x64', inputInterfaces:['NGX-D3D12-Feature1'], ready:true },
  { id:'feeder-core-v1', kind:'core', version:'Feeder Core 1', architecture:'x64', inputInterfaces:['NRExternalProviderV1'], ready:true },
  { id:'bridge-1.4.12', kind:'bridge', version:'1.4.12', architecture:'x64', gameApis:['dx11','vulkan'], compatibleCoreInterfaces:['NGX-D3D12-Feature1'],
    sha256:digest('a'), source:'official-release', validation:'stable', immutable:true, defaultEligible:true },
  { id:'bridge-1.4.13-pre8', kind:'bridge', version:'1.4.13-pre8', architecture:'x64', gameApis:['dx11','vulkan'], compatibleCoreInterfaces:['NGX-D3D12-Feature1'],
    sha256:digest('b'), source:'official-release', validation:'candidate', immutable:true, defaultEligible:true },
  { id:'feeder-v1', kind:'feeder', version:'1.16.0-beta.2', architecture:'x64', gameApis:['dx9','dx10','dx11','dx12','vulkan'],
    compatibleCoreInterfaces:['NRExternalProviderV1'], pairedCoreId:'feeder-core-v1', sha256:digest('c'), source:'official-release', validation:'candidate', immutable:true }
];

test('new DX11 route selects latest matching official Bridge', () => {
  const result = resolveStack({ effectiveApi:'dx11', coreId:'0.4.7beta', components:routeInventory() });
  assert.equal(result.route, 'bridge');
  assert.equal(result.bridge.id, 'bridge-1.4.13-pre8');
});

test('an exact installed compatible Bridge is preserved instead of silently upgraded', () => {
  const result = resolveStack({ effectiveApi:'dx11', coreId:'0.4.7beta', components:routeInventory(), installedEvidence:{bridgeId:'bridge-1.4.12'} });
  assert.equal(result.route, 'bridge');
  assert.equal(result.bridge.id, 'bridge-1.4.12');
});

test('D21 is native on DX12, experimental Bridge on DX11, and never hard-paired to Feeder', () => {
  const inventory = routeInventory();
  assert.equal(resolveStack({ effectiveApi:'dx12', coreId:'0.5-dline21', components:inventory }).route, 'native');
  const dx11=resolveStack({effectiveApi:'dx11',coreId:'0.5-dline21',components:inventory});
  assert.equal(dx11.route,'bridge'); assert.equal(dx11.bridge.id,'bridge-1.4.13-pre8'); assert.equal(dx11.experimental,true);
  const vulkan=resolveStack({effectiveApi:'vulkan',coreId:'0.5-dline21',components:inventory});
  assert.equal(vulkan.route,'feeder'); assert.equal(vulkan.effectiveCore.id,'feeder-core-v1');
  assert.ok(vulkan.rejected.some(row=>row.kind==='bridge' && /Vulkan Layer/.test(row.reason)));
});

test('Vulkan selects NIGos Bridge only when a complete profile deployer is declared', () => {
  const inventory=routeInventory().map(row=>row.kind === 'bridge' ? {...row,capabilities:['vulkan-profile-deployment']} : row);
  const result=resolveStack({effectiveApi:'vulkan',coreId:'0.5-dline21',components:inventory});
  assert.equal(result.route,'bridge'); assert.equal(result.bridge.id,'bridge-1.4.13-pre8'); assert.equal(result.experimental,true);
});

test('Feeder fallback switches to its declared paired Core and never binds D21 directly', () => {
  const inventory = routeInventory().filter(row => row.kind !== 'bridge');
  const result = resolveStack({ effectiveApi:'dx11', coreId:'0.5-dline21', components:inventory });
  assert.equal(result.route, 'feeder');
  assert.equal(result.core.id, '0.5-dline21');
  assert.equal(result.effectiveCore.id, 'feeder-core-v1');
  assert.equal(result.feeder.pairedCoreId, 'feeder-core-v1');
});

test('an installed Feeder pairing is preserved even when a Bridge is also available', () => {
  const inventory = routeInventory();
  const result = resolveStack({ effectiveApi:'dx11', coreId:'0.4.7beta', components:inventory,
    installedEvidence:{route:'feeder', feederId:'feeder-v1'} });
  assert.equal(result.route, 'feeder');
  assert.equal(result.effectiveCore.id, 'feeder-core-v1');
  assert.match(result.reason, /不静默改换路线/);
});

test('an unverifiable imported manifest never becomes an automatic route', () => {
  const inventory = routeInventory().filter(row => row.kind !== 'bridge');
  inventory.push({ id:'unverified-import', kind:'bridge', version:'99.0', architecture:'x64', gameApis:['dx11'],
    compatibleCoreInterfaces:['NGX-D3D12-Feature1'], sha256:digest('d'), source:'user-imported', validation:'candidate' });
  const result = resolveStack({ effectiveApi:'dx11', coreId:'0.4.7beta', components:inventory });
  assert.equal(result.route, 'feeder');
  assert.ok(result.rejected.some(row => row.id === 'unverified-import' && /不会自动安装|不足以自动使用/.test(row.reason)));
});

test('component management uses explicit product names and hides source complexity by default', () => {
  const ui = fs.readFileSync(path.join(__dirname, '../src/renderer/component-library-ui.js'), 'utf8');
  const markup = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const game = fs.readFileSync(path.join(__dirname, '../src/renderer/game-page-ui.js'), 'utf8');
  assert.match(ui, /bridge: 'Bridge'/); assert.match(ui, /feeder: 'Feeder'/); assert.match(ui, /下载更新/);
  assert.doesNotMatch(ui, /下载到缓存|图形桥|输入桥/);
  assert.match(markup, /id="componentRouteGameSelect"/); assert.match(markup, /class="panel component-expert-panel"/);
  assert.match(markup, /组件详情、手动导入与存储/); assert.match(game, /Core 版本/);
  assert.doesNotMatch(markup, /id="componentProviderSelect"|id="applyBridgeComponentBtn"/);
});
