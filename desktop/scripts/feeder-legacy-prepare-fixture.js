'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createLegacyRuntime, DIRECTORY } = require('../src/product/legacy-runtime');
const { fileDigest, resolveFile } = require('../src/product/feeder-runtime');
const { noLinks, atomicJson } = require('../src/product/launch-safety');

async function prepare({ api, architecture, renderer, output, hardwareFamily = 'RTX50' }) {
  renderer = path.resolve(renderer); output = path.resolve(output);
  if (fs.existsSync(output)) throw new Error('Use a new isolated fixture directory.');
  await noLinks(renderer); await noLinks(output);
  const runtime = createLegacyRuntime({ appDir: path.resolve(__dirname, '..') });
  const pkg = await runtime.verify({ api, architecture, hardwareFamily, loadingBackend: 'local' });
  const roots = { game: output, runtime: path.join(output, DIRECTORY), addon: path.join(output, DIRECTORY, 'addons') };
  await fsp.mkdir(output, { recursive: true });
  for (const row of pkg.recipe.files) {
    const target = resolveFile(roots[row.base], row.target);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(resolveFile(pkg.root, row.source), target, fs.constants.COPYFILE_EXCL);
  }
  const ini = `[GENERAL]\nEffectSearchPaths=.\\${DIRECTORY}\\reshade-shaders\\Shaders\\**\nTextureSearchPaths=.\\${DIRECTORY}\\reshade-shaders\\Textures\\**\nPresetPath=.\\${DIRECTORY}\\ReShadePreset.ini\nStartupPresetPath=\nNoReloadOnInit=${api === 'dx9' ? 1 : 0}\nPreprocessorDefinitions=${pkg.recipe.defaults.definitions}\n\n[ADDON]\nAddonPath=.\\${DIRECTORY}\\addons\n`;
  await fsp.writeFile(path.join(output, 'ReShade.ini'), ini, { flag: 'wx' });
  await fsp.writeFile(path.join(roots.addon, 'dlss5-feed.cfg'), pkg.recipe.defaults.feeder, { flag: 'wx' });
  if (pkg.recipe.hostRequired) await fsp.writeFile(path.join(roots.addon, 'host64/ReShade.ini'), '[GENERAL]\nNoReloadOnInit=1\n[ADDON]\nAddonPath=.\\addons\n', { flag: 'wx' });
  if (api === 'dx9') await fsp.writeFile(path.join(roots.addon, 'host64/NRGuides.ini'), pkg.recipe.defaults.hostGuides, { flag: 'wx' });
  await fsp.copyFile(renderer, path.join(output, 'feeder-legacy-present.exe'), fs.constants.COPYFILE_EXCL);
  await atomicJson(path.join(output, 'fixture-identity.json'), { schema: 1, purpose: 'controlled-real-ReShade-callback',
    packageId: pkg.recipe.id, recipe: pkg.recipe, fingerprint: pkg.fingerprint,
    rendererSha256: await fileDigest(renderer), controlledRuntimeVerified: false, realGameVerified: false });
  return { output, packageId: pkg.recipe.id };
}
if (require.main === module) {
  const [api, architecture, renderer, output] = process.argv.slice(2);
  prepare({ api, architecture, renderer, output }).then(console.log).catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { prepare };
