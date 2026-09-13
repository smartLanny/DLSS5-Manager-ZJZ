'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const { fileDigest, fingerprint, resolveFile } = require('../src/product/feeder-runtime');
const { atomicJson } = require('../src/product/launch-safety');
const catalog = require('../src/product/legacy-runtime-catalog');
const { createLegacyRuntime } = require('../src/product/legacy-runtime');

function receiptPins(runtime) {
  const values = new Set(runtime.lock.restorableRecipeFingerprints || []);
  for (const descriptor of catalog.list().filter(row => !row.deliveryBlocked)) {
    for (const proxyEntry of descriptor.proxyEntries) values.add(runtime.load({ api: descriptor.gameApi,
      architecture: descriptor.architecture, hardwareFamily: descriptor.hardwareFamily,
      loadingBackend: descriptor.loadingBackend, proxyEntry }).fingerprint);
  }
  return values;
}

async function update(build) {
  build = path.resolve(build);
  const appDir = path.resolve(__dirname, '..'), pool = path.join(appDir, 'resources/legacy-runtime');
  const historical = receiptPins(createLegacyRuntime({ appDir }));
  const validated = JSON.parse((await fsp.readFile(path.join(build, 'validation.json'), 'utf8')).replace(/^\uFEFF/, ''));
  if (!validated.compileLinkVerified || validated.source.upstreamCommit !== '3f624855276c4bde55145c712782477639b30e85') throw new Error('Wrong upstream build.');
  if (!validated.source.files?.['nr_lab_interop/nr_feeder_host_guides.h'] || !validated.source.files?.['nr_lab_interop/nr_feeder_adapter_inventory.h']) throw new Error('Host build does not provide the admitted guide and adapter-enumeration protocols.');
  const manifest = JSON.parse(await fsp.readFile(path.join(pool, 'manifest.json'), 'utf8'));
  const replacements = [];
  for (const item of manifest.assets.filter(row => ['provider-x64', 'provider-x86', 'provider-relay-x64', 'host-x64'].includes(row.id))) {
    const name = path.basename(item.source), row = validated.files.find(value => value.name === name);
    if (!row || await fileDigest(resolveFile(build, name)) !== row.sha256) throw new Error('Provider build hash changed.');
    replacements.push({ item, row, name });
  }
  // Validate every source before changing the first pool file. The separately
  // compiled D3D9 provider and system shim keep their independent identities.
  for (const { item, row, name } of replacements) {
    await fsp.copyFile(resolveFile(build, name), resolveFile(pool, item.source));
    item.sha256 = row.sha256; item.bytes = row.bytes;
    item.provenance.source = validated.source.files;
  }
  manifest.protocols = { adapterEnumeration: 1, hostVortGuides: 1, frameCompletion: 'project-frame-completion-v1' };
  manifest.acceptance = {}; // A new binary never inherits runtime acceptance silently.
  await atomicJson(path.join(pool, 'manifest.json'), manifest);
  const hash = fingerprint(manifest);
  for (const value of receiptPins(createLegacyRuntime({ appDir, lock: { manifestFingerprint: hash } }))) historical.add(value);
  await fsp.writeFile(path.join(appDir, 'src/product/legacy-runtime-lock.js'),
    `'use strict';\n\n// Source-pinned pool and historical receipts; never updated by an IPC request.\nmodule.exports = Object.freeze(${JSON.stringify({ manifestFingerprint: hash, restorableRecipeFingerprints: [...historical].sort() }, null, 2)});\n`);
  return { manifestFingerprint: hash };
}
if (require.main === module) update(process.argv[2]).then(console.log).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { update, receiptPins };
