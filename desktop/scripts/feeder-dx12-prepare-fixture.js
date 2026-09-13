'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createFeederService } = require('../src/product/feeder-service');
const { detectGpu } = require('../src/product/gpu');
const { noLinks, atomicJson } = require('../src/product/launch-safety');
const { fileDigest } = require('../src/product/feeder-runtime');

async function prepare(renderer, output) {
  if (!path.isAbsolute(renderer) || !path.isAbsolute(output) || fs.existsSync(output)) throw new Error('Explicit renderer and new candidate directory required.');
  await noLinks(renderer); await noLinks(output);
  const manifest = JSON.parse(await fsp.readFile(path.join(path.dirname(renderer), 'build-present.json'), 'utf8'));
  if (!manifest.compileLinkVerified || await fileDigest(renderer) !== manifest.exeSha256) throw new Error('Renderer differs from its successful build identity.');
  await fsp.mkdir(output, { recursive: true });
  const exe = path.join(output, 'feeder-dx12-present.exe'); await fsp.copyFile(renderer, exe, fs.constants.COPYFILE_EXCL);
  const appDir = path.resolve(__dirname, '..'), hardware = detectGpu();
  const service = createFeederService({ appDir, userData: path.join(output, 'manager-fixture-state'), hardware });
  const game = { id: 'feeder-dx12-controlled-renderer', dir: output, scan: {
    chosen: { path: exe, bitness: 64, apiResolution: { api: 'dx12', source: 'owned-fixture' } }, primaryDlss: null, dlssFiles: [], streamlineFiles: [] } };
  const installed = await service.install(game);
  const result = { ...installed, fixture: true, launched: false, exeSha256: await fileDigest(exe), rendererSourceSha256: manifest.sourceSha256,
    selectedApi: 'dx12', source: 'real-installer/real-ordinary-privilege-preflight', gpu: hardware };
  await atomicJson(path.join(output, 'candidate-prepare.json'), result);
  return result;
}
if (require.main === module) {
  const [renderer, output] = process.argv.slice(2);
  if (!renderer || !output) throw new Error('Usage: node scripts/feeder-dx12-prepare-fixture.js <renderer.exe> <new-candidate-directory>');
  prepare(path.resolve(renderer), path.resolve(output)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(`${error.code || 'error'}: ${error.message}`); process.exitCode = 1; });
}
module.exports = { prepare };
