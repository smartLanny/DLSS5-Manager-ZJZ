'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readBundle, sha256 } = require('./payload');
const { DX11_COMPAT_CARRIER } = require('./constants');
// Public beta.2 defaults to the standard 0.4.7 Chinese Core. The fixed
// 1.4.12 carrier below is automatic only for this exact Core/chain pair;
// newer candidate Bridges remain explicit opt-in components.
const CORE = '93011d9283615ea9dc8e92955f5ca6aeff01435925f63e941dc1eea1128a372c';
const CHAIN = '46041a5ff91ae2fd907e310d132aabc3c4a1ecd48dace511b8672909d5d9c2fb';
const BRIDGES = Object.freeze([
  Object.freeze({ id: 'nigos-1.4.12-nr', label: 'NIGos Bridge 1.4.12 · NR 适配', upstreamVersion: '1.4.12',
    registeredName: 'DLSS 5 Bridge 1.4.12', sourceVersion: '0.4.7beta', channel: 'compatible', default: true,
    sha256: '4656d9aac382a6f9b5c8488669aa5365283f03b5b94b2267f1c7f9b53927dc86',
    source: 'https://github.com/smartLanny/dlss5-nr-before-sr-lab', patchId: 'nr-carrier-045-dx11-compat',
    note: '本项目已适配组件；版本名相同的上游 DLL 不能直接替换。' }),
  Object.freeze({ id: 'nigos-1.4.11-nr', label: 'NIGos Bridge 1.4.11 · 回退', upstreamVersion: '1.4.11',
    registeredName: 'DLSS 5 Bridge 1.4.11', sourceVersion: '0.4.7beta-bg3-bridge1411', channel: 'fallback', default: false,
    sha256: '73d438ee9427e73d9919d169a107c7f5d73f60b291ea2cd66bd33279a35d3e95',
    source: 'https://github.com/smartLanny/dlss5-nr-before-sr-lab/issues/224', patchId: 'issue-224-fixed-bridge1411',
    note: '保留已知回退；Core 可能提示版本差异，实际 NR 仍按游戏验收。' })
]);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function bridgeGameId(game) {
  const executable = game?.scan?.chosen?.path || game?.chosen?.path || '';
  return String(game?.steamAppId || game?.appId || '') === '1086940' || /^bg3(?:_dx11)?\.exe$/i.test(path.basename(executable)) ? 'bg3' : 'manual-component';
}
function importedBridges(root, core = {}, installedHash, gameId = 'manual-component', api = 'dx11', trustedComponents = null) {
  if (!root) return [];
  const { readCachedComponents, relativeName } = require('./component-library');
  const { planBridgeDlc } = require('./generated/bridge-contract.cjs');
  return readCachedComponents(root).filter(row => row.kind === 'bridge').map(row => {
    const module = Array.isArray(row.files) && row.files.find(file => /\.addon64$/i.test(file.name));
    if (!module) return null;
    const name = relativeName(module.file), file = path.join(root, name);
    const expected = trustedComponents instanceof Map ? trustedComponents.get(row.id) : trustedComponents?.[row.id];
    const official = expected?.kind === 'bridge' && expected.version === row.version && expected.sha256 === module.sha256 &&
      expected.architecture === row.architecture && expected.sourceType === 'official-release' && expected.immutable === true &&
      Array.isArray(expected.gameApis) && expected.gameApis.every(value => row.gameApis?.includes(value));
    const notices = row.files.filter(item => /(?:^|\/)(?:license(?:s)?(?:\.[^/]*)?|[^/]*notice[^/]*)$/i.test(item.name)).map(item => item.name);
    const context = { enabled: true, gameApi: api, architecture: 'x64', nativeInputs: 'unknown', intent: 'native-bridge', allowPreview: true,
      core: { buildId: core.id || 'unknown', inputInterfaces: core.inputInterfaces || [], nativeD3D12: true },
      packages: [{ component: 'bridge', version: row.version, variant: row.variant || 'external', sha256: module.sha256,
        gameApis: row.gameApis || ['dx11'], gameArchitectures: [row.architecture], consumerInterface: row.interface,
        compatibleCoreBuilds: [], compatibilityPolicy: 'interface', x64HostIncluded: false,
        licenseNoticeFiles: notices.length ? notices : row.source === 'catalog' ? ['THIRD_PARTY_NOTICES.md'] : [] }] };
    const plan = planBridgeDlc({ pins: { bridge: row.version }, gameId }, context);
    return { id: row.id, label: `${row.version} · ${row.variant || 'external'}`, upstreamVersion: row.version,
      filename: DX11_COMPAT_CARRIER, architecture: row.architecture, api, gameApis:row.gameApis || [api], version:row.version,
      compatibleCoreInterfaces:row.compatibleCoreInterfaces?.length ? row.compatibleCoreInterfaces : [row.interface], file, sha256: module.sha256,
      installed: installedHash === module.sha256, ready: fs.existsSync(file), compatible: plan.state === 'candidate' && row.validation !== 'blocked',
      runtimeVerified: false, source: row.source, sourceType:row.sourceType, validation:row.validation,
      capabilities:Array.isArray(row.capabilities) ? row.capabilities : [], defaultEligible:row.defaultEligible === true,
      immutable:row.immutable === true && Boolean(official), verifiedSource:row.verifiedSource === true &&
        row.source === 'bundled' && row.sourceType === 'official-release' && Boolean(official),
      channel: row.validation === 'stable' ? 'stable' : 'candidate', contract: plan, interface: row.interface };
  }).filter(Boolean);
}
function bridgeByHash(digest) { return BRIDGES.find(row => row.sha256 === digest) || null; }
function bridgeCatalog(payloadDir, { coreHash = null, chainHash = null, installedHash = null } = {}) {
  return BRIDGES.map(row => ({ ...row, filename: DX11_COMPAT_CARRIER, architecture: 'x64', api: 'dx11', gameApis:['dx11'],
    version:row.upstreamVersion, compatibleCoreInterfaces:['NGX-D3D12-Feature1'], verifiedSource:true, immutable:true, validation:row.channel === 'compatible' ? 'stable' : 'candidate',
    hardwareFamilies: ['RTX40', 'RTX50'], coreSha256: CORE, chainSha256: CHAIN,
    installed: row.sha256 === installedHash,
    compatible: coreHash === CORE && chainHash === CHAIN,
    ready: fs.existsSync(path.join(payloadDir, 'versions', row.sourceVersion, DX11_COMPAT_CARRIER)), runtimeVerified: false }));
}
function selectNativeComponents(payloadDir, payload, { api, bridgeId, installedHash, componentRoot, gameId = 'manual-component', trustedComponents = null } = {}) {
  if (api !== 'dx11') {
    if (bridgeId) fail('COMPONENT_BRIDGE_API', 'NIGos Bridge 仅适用于原生 DX11 路线；加载入口不会改变游戏 API。');
    return { ...payload, components: { bridge: null } };
  }
  const pinned = bridgeByHash(installedHash);
  const imports = importedBridges(componentRoot, payload.versionInfo, installedHash, gameId, 'dx11', trustedComponents);
  // Preserve exact installed ownership. For a new DX11 install, choose the
  // newest bundled official Bridge that the packaged catalog explicitly marks
  // default-eligible. A user-imported manifest can never grant itself this
  // privilege, even when its visible version string is newer.
  const parts = value => String(value).match(/\d+/g)?.map(Number) || [0];
  const newer = (left, right) => { const a=parts(left.version), b=parts(right.version); for(let i=0;i<Math.max(a.length,b.length);i+=1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (b[i] || 0) - (a[i] || 0); } return String(right.version).localeCompare(String(left.version)); };
  const automatic = imports.filter(row => row.defaultEligible && row.verifiedSource && row.immutable && row.compatible && row.ready && row.gameApis.includes('dx11')).sort(newer)[0];
  const imported = bridgeId ? imports.find(row => row.id === bridgeId) :
    (installedHash ? imports.find(row => row.installed) : automatic);
  if (imported) {
    if (!imported.compatible || !imported.ready) fail('COMPONENT_BRIDGE_CORE', imported.contract.message);
    const stat = fs.lstatSync(imported.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || sha256(imported.file) !== imported.sha256) fail('COMPONENT_BRIDGE_HASH', '外部桥接组件在导入后发生变化。');
    return { ...payload, versionInfo: { ...payload.versionInfo, compatibility: 'dx11' },
      carrier: { name: DX11_COMPAT_CARRIER, file: imported.file, actual: imported.sha256, expected: imported.sha256 },
      components: { bridge: imported.id }, componentMetadata: { bridge: imported } };
  }
  const target = bridgeId ? BRIDGES.find(row => row.id === bridgeId) : pinned || bridgeByHash(payload.carrier?.actual);
  if (gameId === 'bg3' && target?.upstreamVersion !== '1.4.11')
    fail('COMPONENT_GAME_PIN', '此游戏保留 Bridge 1.4.11 例外配套；请导入与所选 Core 接口匹配的 1.4.11 组件。现有安装未修改。');
  if (!target) {
    if (bridgeId) fail('COMPONENT_BRIDGE_UNKNOWN', '找不到所选的适配版桥接器。');
    return payload; // Historical packages retain their own verified companion.
  }
  if (payload.addon?.actual !== CORE || payload.bridge?.actual !== CHAIN) {
    if (bridgeId) fail('COMPONENT_BRIDGE_CORE', '所选 Core 与此桥接器的固定配套接口尚未验证。');
    return payload;
  }
  const file = path.join(payloadDir, 'versions', target.sourceVersion, DX11_COMPAT_CARRIER);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || sha256(file) !== target.sha256)
    fail('COMPONENT_BRIDGE_HASH', '桥接器来源摘要与固定适配版本不一致。');
  return { ...payload, carrier: { ...payload.carrier, name: DX11_COMPAT_CARRIER, file, actual: target.sha256, expected: target.sha256 },
    components: { bridge: target.id }, componentMetadata: { bridge: { ...target } } };
}
function knownPayloadComponents(payloadDir) {
  const bundle = readBundle(payloadDir), result = [];
  for (const [version, row] of Object.entries(bundle.versions || {})) {
    for (const [name, hash] of Object.entries(row.files || {})) {
      if (!/\.addon(?:32|64)?$/i.test(name)) continue;
      const bridge = bridgeByHash(hash), role = name === 'nr-before-sr.zh-CN.addon64' ? 'core' : bridge ? 'carrier' : null;
      if (!role) continue;
      result.push({ sha256: hash, role, version, ...(bridge ? { registeredName: bridge.registeredName, compatibility: 'compatible' } : {}) });
    }
    for (const hash of row.trustedUpgradeFrom || []) result.push({ sha256: hash, role: 'core', version: 'historical' });
  }
  return result;
}
module.exports = { BRIDGES, bridgeGameId, bridgeByHash, bridgeCatalog, importedBridges, selectNativeComponents, knownPayloadComponents };
