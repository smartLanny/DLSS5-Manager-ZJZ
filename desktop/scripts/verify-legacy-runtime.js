'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createLegacyRuntime } = require('../src/product/legacy-runtime');
const catalog = require('../src/product/legacy-runtime-catalog');
const { fileDigest, resolveFile, PE } = require('../src/product/feeder-runtime');
const { noLinks } = require('../src/product/launch-safety');
const pe = require('../src/core/pe');

async function verifyLegacyRuntime(appDir = path.resolve(__dirname, '..')) {
  const runtime = createLegacyRuntime({ appDir, resourcesPath: path.join(appDir, 'resources') });
  const baselines = catalog.list(), recipes = [];
  for (const row of baselines) for (const proxyEntry of row.proxyEntries)
    recipes.push(runtime.load({ api: row.gameApi, architecture: row.architecture, hardwareFamily: row.hardwareFamily, loadingBackend: row.loadingBackend, proxyEntry }).recipe);
  // load() above validates the code-pinned manifest before any file it names is used.
  const manifest = JSON.parse(fs.readFileSync(path.join(runtime.root, 'manifest.json'), 'utf8'));
  if (manifest.protocols?.adapterEnumeration !== 1 || manifest.protocols?.hostVortGuides !== 1 || manifest.protocols?.frameCompletion !== 'project-frame-completion-v1') throw new Error('Legacy protocol contract missing.');
  await noLinks(runtime.root);
  const expectedFiles = new Set(['manifest.json', ...manifest.assets.map(row => row.source)]);
  function inspectDirectory(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Linked entry in legacy pool: ${relative}`);
      if (entry.isDirectory()) inspectDirectory(path.join(directory, entry.name), relative + '/');
      else if (!entry.isFile() || !expectedFiles.delete(relative)) throw new Error(`Unpinned entry in legacy pool: ${relative}`);
    }
  }
  inspectDirectory(runtime.root);
  if (expectedFiles.size) throw new Error(`Missing legacy pool files: ${[...expectedFiles].join(', ')}`);
  let peAssets = 0;
  // Hash each physical asset once. The two 165 MB model runtimes are shared by
  // all recipes and must not be re-read for every route/GPU/entry combination.
  for (const row of manifest.assets) {
    if (/dgvoodoo|\.zip$/i.test(row.source)) throw new Error('Blocked archive must not enter the distributable pool.');
    const file = resolveFile(runtime.root, row.source); await noLinks(file);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== row.bytes || await fileDigest(file) !== row.sha256) throw new Error(`Legacy asset digest mismatch: ${row.id}`);
    if (PE.test(row.source)) {
      if (pe.getBitness(file) !== (row.architecture === 'x86' ? 32 : 64)) throw new Error(`Legacy asset architecture mismatch: ${row.id}`);
      ++peAssets;
    }
  }
  for (const recipe of recipes) {
    const one = role => { const found = recipe.files.filter(row => row.role === role); if (found.length !== 1) throw new Error(`${recipe.id}: expected one ${role}`); return found[0]; };
    if (recipe.deliveryBlocked || recipe.srInjected || recipe.fgInjected || recipe.coreInterface !== 'NRExternalProviderV1') throw new Error(`${recipe.id}: unsupported processing contract`);
    if (one('provider').architecture !== recipe.architecture || one('core').architecture !== 'x64' || one('nr-runtime').id !== `runtime-${recipe.hardwareFamily.toLowerCase()}`) throw new Error(`${recipe.id}: component architecture/family mismatch`);
    if (recipe.hostRequired) {
      if (one('host').architecture !== 'x64' || !one('core').target.startsWith('host64/addons/') || !one('nr-runtime').target.startsWith('host64/addons/')) throw new Error(`${recipe.id}: host isolation mismatch`);
    } else if (recipe.files.some(row => row.role === 'host' || row.target.startsWith('host64/'))) throw new Error(`${recipe.id}: unexpected host`);
    if (recipe.loadingBackend === 'hoyoshade' && recipe.files.some(row => row.role === 'game-loader' || row.base === 'game')) throw new Error(`${recipe.id}: profile loader ownership mismatch`);
    if (recipe.gameApi === 'dx9' && (recipe.loadingBackend !== 'local' || recipe.wrapper?.systemRuntime !== true || one('api-wrapper').target !== 'd3d9.dll' || one('game-loader').base !== 'runtime' || !recipe.defaults.hostGuides)) throw new Error(`${recipe.id}: system D3D9On12 contract mismatch`);
  }
  const reportAsset = manifest.assets.find(row => row.id === 'controlled-acceptance');
  if (!reportAsset) throw new Error('Final binary controlled acceptance is absent.');
  const acceptance = JSON.parse(fs.readFileSync(resolveFile(runtime.root, reportAsset.source), 'utf8'));
  if (acceptance.schema !== 1 || acceptance.hardwareFamily !== 'RTX50' || acceptance.realGameVerified !== false || !Array.isArray(acceptance.routes)) throw new Error('Invalid controlled acceptance contract.');
  const expectedRoutes = new Set(baselines.filter(row => row.hardwareFamily === 'RTX50' && row.loadingBackend === 'local').map(row => `${row.gameApi}-${row.architecture}`));
  for (const report of acceptance.routes) {
    const key = `${report.api}-${report.architecture}`;
    if (!expectedRoutes.delete(key) || report.controlledRuntimeVerified !== true || report.resizeVerified !== true || report.rendererExitCode !== 0 || report.realGameVerified !== false || !report.proof?.beforeResize || !report.proof?.afterResize) throw new Error(`Missing/invalid final route acceptance: ${key}`);
    const pkg = runtime.load({ api: report.api, architecture: report.architecture, hardwareFamily: 'RTX50', loadingBackend: 'local' });
    for (const row of pkg.recipe.files) if (!report.components?.some(proof => proof.id === row.id && proof.sha256 === row.sha256 && proof.base === row.base && proof.target === row.target)) throw new Error(`Acceptance was produced by other assets: ${key}/${row.id}`);
    const admitted = pkg.recipe.acceptance;
    if (admitted.controlledRuntimeVerified !== true || admitted.reportAsset !== reportAsset.id) throw new Error(`Recipe acceptance metadata mismatch: ${key}`);
  }
  if (expectedRoutes.size) throw new Error(`Unverified final routes: ${[...expectedRoutes].join(', ')}`);
  const r40 = manifest.assets.find(row => row.id === 'runtime-rtx40'), r50 = manifest.assets.find(row => row.id === 'runtime-rtx50');
  if (!r40 || !r50 || r40.sha256 === r50.sha256) throw new Error('RTX40 and RTX50 must use their own fixed model runtime.');
  return { manifestFingerprint: runtime.lock.manifestFingerprint, assets: manifest.assets.length, peAssets, baselineRecipes: baselines.length,
    recipeSelections: recipes.length, controlledRoutes: acceptance.routes.length, controlledHardware: acceptance.hardware,
    RTX40: { fileVerified: true, controlledRuntimeVerified: false }, realGameVerified: false };
}
if (require.main === module) verifyLegacyRuntime(process.argv[2] ? path.resolve(process.argv[2]) : undefined)
  .then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { verifyLegacyRuntime };
