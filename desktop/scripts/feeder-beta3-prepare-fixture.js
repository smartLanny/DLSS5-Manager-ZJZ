'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { fileDigest, resolveFile } = require('../src/product/feeder-runtime');
const { noLinks, atomicJson } = require('../src/product/launch-safety');

async function prepare(build, renderer, output) {
  build = path.resolve(build); renderer = path.resolve(renderer); output = path.resolve(output);
  await noLinks(output);
  if (fs.existsSync(output)) throw new Error('Use a new isolated fixture directory.');
  const validation = JSON.parse(await fsp.readFile(path.join(build, 'validation.json'), 'utf8'));
  const binary = validation.files.find(row => row.name === 'dlss5-feed.addon64');
  if (!validation.compileLinkVerified || await fileDigest(path.join(build, binary.name)) !== binary.sha256) throw new Error('Provider build identity mismatch.');
  const baseRoot = path.resolve(__dirname, '../resources/feeder-runtime');
  const recipe = JSON.parse(await fsp.readFile(path.join(baseRoot, 'recipe.json'), 'utf8'));
  await fsp.mkdir(output, { recursive: true });
  for (const row of recipe.files) {
    if (row.role === 'provider') continue;
    const source = resolveFile(baseRoot, row.source), target = resolveFile(output, row.target);
    if (await fileDigest(source) !== row.sha256) throw new Error('Read-only fixture source changed.');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  }
  const target = path.join(output, '_DLSS5_Feeder/addons/dlss5-feed.addon64');
  await fsp.copyFile(path.join(build, binary.name), target, fs.constants.COPYFILE_EXCL);
  await fsp.copyFile(renderer, path.join(output, 'feeder-dx12-present.exe'), fs.constants.COPYFILE_EXCL);
  await atomicJson(path.join(output, 'fixture-identity.json'), { schema: 1, purpose: 'isolated-controlled-dx12-callback',
    provider: binary.sha256, renderer: await fileDigest(renderer), source: validation.source,
    runtimeVerified: false, realGameVerified: false });
  return { output };
}
if (require.main === module) prepare(...process.argv.slice(2)).then(console.log).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { prepare };
