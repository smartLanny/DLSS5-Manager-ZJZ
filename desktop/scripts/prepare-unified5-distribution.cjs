'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('../src/product/unified5-core');
const pe = require('../src/core/pe');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function checked(file, expected) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || hash(file) !== expected.sha256 || expected.bytes !== undefined && stat.size !== expected.bytes)
    throw new Error(`Component identity mismatch: ${path.basename(file)}`);
}
function prepare({ priorFile, delivery, output, version }) {
  const handoff = JSON.parse(fs.readFileSync(path.join(delivery, 'manager-core-handoff.json')));
  if (handoff.schema !== 'dlss5-core-manager-handoff-v1' || handoff.sourceCommit !== core.SOURCE || handoff.stableRelease !== false)
    throw new Error('Unsupported Core handoff');
  for (const [language, record] of Object.entries(handoff.languages)) {
    if (!['zh-CN', 'en'].includes(language) || record.directory !== language) throw new Error('Unsupported Core language');
    for (const row of record.files) {
      if (!/^[a-zA-Z0-9_.\/-]+$/.test(row.file) || row.file.split('/').some(part => !part || part === '..')) throw new Error('Unsafe Core file');
      checked(path.join(delivery, language, row.file), row);
    }
    checked(path.join(delivery, language, `nr-before-sr.${language}.addon64`), { sha256: core.HASHES[language] });
  }
  const manifest = JSON.parse(fs.readFileSync(priorFile));
  const priorRoot = manifest.core.payloadRoot;
  const bundle = JSON.parse(fs.readFileSync(path.join(priorRoot, 'bundle.json')));
  if (fs.existsSync(output)) throw new Error('Use a fresh output directory');
  const payloadRoot = path.join(output, 'core-catalog');
  const copy = (source, target, sha256) => {
    checked(source, { sha256 }); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); checked(target, { sha256 });
  };
  for (const [family, row] of Object.entries(bundle.fixed)) for (const [name, digest] of Object.entries(row.files)) {
    if (name === 'nvngx_dlssnr.dll') continue; // Runtime DLC remains separate.
    copy(path.join(priorRoot, 'fixed', family, name), path.join(payloadRoot, 'fixed', family, name), digest);
  }
  for (const id of manifest.core.versions) {
    const row = bundle.versions[id];
    for (const [name, digest] of Object.entries({ ...row.files, ...row.companions }))
      copy(path.join(priorRoot, 'versions', id, name), path.join(payloadRoot, 'versions', id, name), digest);
  }
  const record = handoff.languages['zh-CN'];
  const entry = { ...record.catalogFragment, id: core.ID, label: '0.5 Unified5 · 五层统一设置（测试）',
    source: core.SOURCE, configContract: core.CONTRACT, compatibility: 'dx11', supportsPresent: true,
    stableRelease: false, comparisonOnly: false, implementedInterfaces: record.implementedInterfaces,
    // The delivered ABI host tests are not a Feeder component acceptance result.
    // Preserve existing matched Feeder profiles instead of silently replacing them.
    externalRoutesAutoEnabled: false, routeStatus: handoff.routeStatus,
    notes: '完整 Unified5 Core；双颜色策略分别记忆。外部接口已实现；现有 Feeder/Vulkan 使用各自配套，不自动换入本版。' };
  for (const [name, digest] of Object.entries({ ...entry.files, ...entry.companions }))
    copy(path.join(delivery, 'zh-CN', name), path.join(payloadRoot, 'versions', core.ID, name), digest);
  if (entry.files['nr_before_sr.ini'] !== core.INI || entry.files['nrchain_nvngx.dll'] !== core.CHAIN ||
      entry.files['dlss5-native-carrier-045-dx11-compat.addon64'] !== core.CARRIER ||
      pe.getBitness(path.join(payloadRoot, 'versions', core.ID, 'nr-before-sr.zh-CN.addon64')) !== 64)
    throw new Error('Incomplete Unified5 Core pair');
  bundle.versions[core.ID] = entry; bundle.defaultVersion = '0.4.7beta';
  manifest.core.payloadRoot = payloadRoot; manifest.core.versions.push(core.ID);
  manifest.packageVersion = version;
  const noticeRoot = path.join(output, 'core-notices');
  for (const name of ['LICENSES.txt', 'NVIDIA-NGX-LICENSE.txt']) {
    const row = record.files.find(row => row.file === name), target = path.join(noticeRoot, name);
    copy(path.join(delivery, 'zh-CN', name), target, row.sha256);
    manifest.resources.push({ source: target, path: `core-notices/unified5/${name}`, bytes: row.bytes, sha256: row.sha256 });
  }
  fs.writeFileSync(path.join(payloadRoot, 'bundle.json'), JSON.stringify(bundle, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'staging.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { output, sourceCommit: core.SOURCE, coreId: core.ID, defaultVersion: bundle.defaultVersion, languagesVerified: Object.keys(handoff.languages) };
}
if (require.main === module) {
  const [priorFile, delivery, output, version] = process.argv.slice(2);
  if (!priorFile || !delivery || !output || !version) throw new Error('Usage: prepare-unified5-distribution prior.json delivery output manager-version');
  console.log(JSON.stringify(prepare({ priorFile, delivery, output, version }), null, 2));
}
module.exports = { prepare };
