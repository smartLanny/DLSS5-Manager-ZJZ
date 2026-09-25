'use strict';

// Final-publication gate. RC builds may remain intentionally incomplete, but
// a public portable release must contain the exact historical Core and the
// declared open-source routing components. No nearby build may be renamed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CORE_033 = Object.freeze({
  id: '0.3.3-dev-r4',
  displayVersion: '0.3.3.4',
  file: 'nr-before-sr.zh-CN.addon64',
  bytes: 652288,
  sha256: '2869d7d6b2d184b4200c3eb7ac671db0299be64e7625c4f816ee26b41890bfb9'
});
const REQUIRED_CORE_IDS = Object.freeze(['0.2.0-beta.2', CORE_033.id, '0.4.2', '0.4.7beta', '0.5-dline21']);
const REQUIRED_BRIDGES = Object.freeze([
  Object.freeze({ id:'bridge-1.4.13-pre8-official', version:'1.4.13-pre8', validation:'candidate', bytes:546304,
    sha256:'c4c8b5bc4b26b2b3f3bf2767cdb708546d62f7d0bbb63d24e940c736da9efe26' }),
  Object.freeze({ id:'bridge-1.4.12-official', version:'1.4.12', validation:'stable', bytes:508928,
    sha256:'4f2acecc1026ae89ac0b92767be66ceea2662ad0ef88710b89c7da7840d548d4' })
]);

function fail(message, details = {}) {
  const error = new Error(message);
  error.code = 'RELEASE_GATE';
  error.details = details;
  throw error;
}
function plainFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { fail(`${label} 不存在。`, { file }); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail(`${label} 必须是普通文件。`, { file });
  return stat;
}
function readJson(file, label) {
  const stat = plainFile(file, label);
  if (stat.size > 4 * 1024 * 1024) fail(`${label} 过大。`, { file, bytes: stat.size });
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail(`${label} 不是有效 JSON。`, { file, cause: error.message }); }
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function validate033Identity(entry, stat, actual) {
  if (!entry || entry.files?.[CORE_033.file] !== CORE_033.sha256 || entry.substitute === true) {
    fail('0.3.3.4 清单身份缺失或被替代；禁止用其他版本改名。', { expected: CORE_033 });
  }
  if (stat.size !== CORE_033.bytes || actual !== CORE_033.sha256) {
    fail('0.3.3.4 Core 不是登记的精确原文件。', { expectedBytes: CORE_033.bytes, actualBytes: stat.size, expectedSha256: CORE_033.sha256, actualSha256: actual });
  }
  return { id: CORE_033.id, displayVersion: CORE_033.displayVersion, bytes: stat.size, sha256: actual };
}
function assertExact033(payloadRoot, selectedVersions = null) {
  const root = path.resolve(payloadRoot), bundle = readJson(path.join(root, 'bundle.json'), 'Core bundle');
  if (bundle.version !== 4 || bundle.defaultVersion !== '0.4.7beta' || !bundle.versions || Array.isArray(bundle.versions)) {
    fail('发布 Core bundle 必须是以 0.4.7beta 为默认值的 v4 清单。');
  }
  const selected = selectedVersions || Object.keys(bundle.versions);
  if (!Array.isArray(selected) || REQUIRED_CORE_IDS.some(id => !selected.includes(id))) {
    fail('正式发布必须保留 0.2、精确 0.3.3.4、0.4.2、0.4.7beta 与可手选 D21。', { selected, required: REQUIRED_CORE_IDS });
  }
  const entry = bundle.versions[CORE_033.id];
  const addon = path.join(root, 'versions', CORE_033.id, CORE_033.file), stat = plainFile(addon, '0.3.3.4 Core');
  const actual = sha256(addon);
  const identity = validate033Identity(entry, stat, actual);
  if (bundle.versions['0.5-dline21']?.stableRelease === true) fail('D21 只能作为显式测试选项，不能标成稳定默认。');
  return identity;
}
function assertOfficialBridges(stageRoot) {
  const root=path.resolve(stageRoot), catalog=readJson(path.join(root,'resources','components','catalog.json'),'组件目录');
  const rows=Array.isArray(catalog) ? catalog : catalog.packages;
  if (!Array.isArray(rows)) fail('组件目录缺少 packages。');
  const result=[];
  for (const expected of REQUIRED_BRIDGES) {
    const row=rows.find(item=>item.id===expected.id), componentRoot=path.join(root,'resources','components',expected.id);
    if (!row || row.kind !== 'bridge' || row.version !== expected.version || row.architecture !== 'x64' ||
        row.interface !== 'NGX-D3D12-Feature1' || row.sourceType !== 'official-release' || row.immutable !== true ||
        row.defaultEligible !== true || row.validation !== expected.validation ||
        !['dx11','vulkan'].every(api=>row.gameApis?.includes(api)) ||
        !row.compatibleCoreInterfaces?.includes('NGX-D3D12-Feature1'))
      fail(`正式发布缺少可信的 DLSS5 Bridge ${expected.version} 契约。`,{expected,row});
    const addon=path.join(componentRoot,'dlss5-bridge.addon64'), stat=plainFile(addon,`DLSS5 Bridge ${expected.version}`), actual=sha256(addon);
    if (stat.size !== expected.bytes || actual !== expected.sha256)
      fail(`DLSS5 Bridge ${expected.version} 不是登记的官方发布资产。`,{expected,actualBytes:stat.size,actualSha256:actual});
    const manifest=readJson(path.join(componentRoot,'component-manifest.json'),`DLSS5 Bridge ${expected.version} 清单`);
    if (manifest.id !== expected.id || manifest.sourceType !== 'official-release' || manifest.immutable !== true ||
        manifest.defaultEligible !== true || !['dx11','vulkan'].every(api=>manifest.gameApis?.includes(api)) ||
        !manifest.capabilities?.includes('vulkan-requires-reshade-layer') || manifest.capabilities?.includes('vulkan-profile-deployment'))
      fail(`DLSS5 Bridge ${expected.version} 清单未准确声明 Vulkan 部署边界。`);
    result.push({id:expected.id,version:expected.version,sha256:actual});
  }
  return result;
}
function assertVulkanBridgeDeployment(stageRoot) {
  const root=path.resolve(stageRoot), catalog=readJson(path.join(root,'resources','components','catalog.json'),'组件目录');
  const rows=Array.isArray(catalog) ? catalog : catalog.packages;
  const bridge=Array.isArray(rows) && rows.find(row=>row.kind === 'bridge' && row.gameApis?.includes('vulkan') &&
    row.capabilities?.includes('vulkan-profile-deployment'));
  if (!bridge) fail('正式发布必须包含可部署的 Vulkan Bridge Profile；仅有 Bridge .addon64 或 Feeder Profile 不能算完成。');
  const recipe=readJson(path.join(root,'resources','vulkan-bridge','recipe.json'),'Vulkan Bridge Profile 清单');
  const roles=new Set(Array.isArray(recipe.files) ? recipe.files.map(row=>row?.role) : []);
  if (recipe.version !== 1 || recipe.id !== 'vulkan-bridge-profile-v1' || recipe.api !== 'vulkan' ||
      recipe.loadingBackend !== 'vulkan-profile' || recipe.architecture !== 64 || recipe.bridgeId !== bridge.id ||
      recipe.inputInterface !== 'NGX-D3D12-Feature1' || recipe.layerRecipe !== 'vulkan-reshade/recipe.json' ||
      !['bridge','core','core-chain','core-config','nr-runtime'].every(role=>roles.has(role))) {
    fail('Vulkan Bridge Profile 没有把 Bridge、Core、chain、配置、NR 运行库与 ReShade Vulkan Layer 绑定成完整合同。');
  }
  return { id:recipe.id, bridgeId:bridge.id, roles:[...roles].sort() };
}
function assertReleaseStage(stageRoot) {
  const root = path.resolve(stageRoot), payloadRoot = path.join(root, 'payload', 'nr-before-sr');
  const core = assertExact033(payloadRoot);
  for (const family of ['RTX40', 'RTX50']) {
    const runtime = path.join(payloadRoot, 'fixed', family, 'nvngx_dlssnr.dll');
    if (fs.existsSync(runtime)) fail('公开精简便携包不能内置 RTX40/50 NR DLL。', { runtime });
  }
  const bridges = assertOfficialBridges(root);
  const vulkanBridge = assertVulkanBridgeDeployment(root);
  const components = readJson(path.join(root, 'resources', 'components', 'catalog.json'), '组件目录');
  const rows = Array.isArray(components) ? components : components.packages;
  if (!Array.isArray(rows) || !rows.some(row => row.kind === 'bridge') || !rows.some(row => row.kind === 'feeder')) {
    fail('公开精简便携包必须同时包含已登记的 DLSS5 Bridge 与 DLSS5 Feeder。');
  }
  const mfg = readJson(path.join(root, 'resources', 'fg-mfgunlock', 'manifest.json'), 'MFG 资源清单');
  const mfgPins = require('../src/product/fg-mfgunlock-providers.json');
  if (mfg.defaultProvider !== mfgPins.defaultProvider || !Array.isArray(mfg.providers) ||
      !mfgPins.providers.every(pin => mfg.providers.some(row => row.id === pin.id)) ||
      mfg.providers.some(row => /^mfgunlock-0[.]7(?:$|-)/.test(row.id || ''))) {
    fail(`MFG 发布矩阵必须以 ${mfgPins.defaultProvider} 为默认并包含全部固定回退版本，且不得重新提供 0.7。`);
  }
  return { ok: true, core, bridges, vulkanBridge, routes: ['bridge', 'feeder'], mfg: mfgPins.providers.map(row => row.version), runtimeSplit: true };
}

module.exports = { CORE_033, REQUIRED_CORE_IDS, REQUIRED_BRIDGES, validate033Identity, assertExact033, assertOfficialBridges,
  assertVulkanBridgeDeployment, assertReleaseStage };
