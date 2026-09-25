'use strict';
const crypto = require('node:crypto');

// Manager-owned layouts for unchanged, owner-approved Provider packages.
// The package definitions and DLLs remain immutable. HoYo's existing verified
// profile owns the loader; the Provider owns only its addon/runtime files.
const PACKAGES = Object.freeze({
  'feeder-stable-external-of-r3': { version: '0.15.1', files: '6a5691e0141350afe6b60d588e0a0804419cd85c5ca487500d0532c99233ec07', routes: ['dx12-x64-stable-of'] },
  'feeder-legacy-host-d16-r3': { version: '0.15.1-d16-adapter-r3', files: 'cbd8e74fcf8c473f7fec157486b5d6e073537ac3f272d1a3138b2102d6042dcc', routes: ['dx11-x64-legacy-direct', 'dx12-x64-legacy-direct'], shader: true }
});
const SHADER = Object.freeze({ name: 'DLSS5_Feed.fx', bytes: 51193,
  sha256: 'cdac08a721b14b97187dd86c5b5bead157c9063d7ee859a0f131a8ee791695f1' });
function fileIdentity(files) {
  const rows = files.map(file => [file.name, file.sha256, file.bytes]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
function adaptProfile({ row, byName, manifest, inventory }) {
  const pin = PACKAGES[row.id], adaptations = {};
  if (!pin || row.version !== pin.version || row.source !== 'bundled' || row.verifiedSource !== true || row.immutable !== true ||
      fileIdentity(row.files) !== pin.files) return { manifest, byName, adaptations };
  const files = new Map(byName), routes = [...manifest.routes];
  let shader;
  if (pin.shader) {
    shader = inventory.packages.flatMap(item => item.files || []).find(file => file.sha256 === SHADER.sha256 && file.bytes === SHADER.bytes &&
      file.name?.replaceAll('\\', '/').split('/').at(-1) === SHADER.name && file.file === `objects/${SHADER.sha256}/${SHADER.name}`);
    if (!shader) return { manifest, byName, adaptations, dependencyUnavailable: 'Feeder 缺少 DLSS5_Feed.fx，请重新导入完整内置组件。' };
    files.set('manager-profile/dlss5_feed.fx', { ...shader, name: 'manager-profile/DLSS5_Feed.fx', source: shader.file });
  }
  const metadata = originalId => ({ id: 'manager-provider-layout', version: 1, originalRouteId: originalId,
    originalFilesIdentity: pin.files, compatibilitySource: 'owner-confirmed-2026-09-22', runtimeVerified: false,
    ...(shader ? { supplementalShader: { source: shader.file, ...SHADER } } : {}) });
  const supplemental = { role: 'shader', file: 'manager-profile/DLSS5_Feed.fx', base: 'runtime',
    target: 'reshade-shaders/Shaders/DLSS5_Feed.fx', architecture: null, mutable: false };
  // The omitted shader is also needed by this package's local routes. Existing
  // receipts retain their original definition when validated by the caller.
  if (shader) for (let index = 0; index < routes.length; index++) {
    routes[index] = { ...routes[index], files: [...routes[index].files, { ...supplemental }] };
    adaptations[routes[index].id] = metadata(routes[index].id);
  }
  for (const originalId of pin.routes) {
    const original = manifest.routes.find(route => route.id === originalId);
    if (!original || original.loadingBackend !== 'local' || original.architecture !== 'x64' || original.hostRequired ||
        original.files.filter(file => file.role === 'game-loader' && file.base === 'game' && file.target === 'dxgi.dll').length !== 1)
      throw new Error('已知 Provider 的加载布局与管理器配套不符。');
    const route = { ...original, id: `hoyoshade-${original.id}`, loadingBackend: 'hoyoshade', proxyEntries: ['auto'],
      files: original.files.filter(file => file.role !== 'game-loader').map(file => ({ ...file })) };
    if (route.files.some(file => file.base === 'game')) throw new Error('米哈游 Provider 不应接管游戏目录代理。');
    if (shader) route.files.push({ ...supplemental });
    routes.push(route);
    adaptations[route.id] = metadata(original.id);
  }
  return { manifest: { ...manifest, routes }, byName: files, adaptations };
}
module.exports = { adaptProfile, fileIdentity, SHADER };
