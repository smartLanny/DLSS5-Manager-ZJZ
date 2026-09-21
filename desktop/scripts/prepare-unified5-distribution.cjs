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
    if (id === core.ID) continue;
    const row = bundle.versions[id];
    for (const [name, digest] of Object.entries({ ...row.files, ...row.companions }))
      copy(path.join(priorRoot, 'versions', id, name), path.join(payloadRoot, 'versions', id, name), digest);
  }
  const record = handoff.languages['zh-CN'];
  const entry = { ...record.catalogFragment, id: core.ID, label: '0.5 Unified5 · 五层统一设置（测试）',
    source: core.SOURCE, configContract: core.CONTRACT, compatibility: 'dx11', supportsPresent: true,
    stableRelease: false, comparisonOnly: false, implementedInterfaces: record.implementedInterfaces,
    // Only an explicit per-game Unified5 choice enables the experimental stack.
    // Existing installations and the global default are never migrated.
    externalRoutesAutoEnabled: false, explicitSelectionAutoPairs: true, routeStatus: handoff.routeStatus,
    notes: '完整 Unified5 Core；双颜色策略分别记忆。选用本版后自动匹配 Bridge / Feeder，兼容路线为实验支持；不会自动升级已有安装。' };
  for (const [name, digest] of Object.entries({ ...entry.files, ...entry.companions }))
    copy(path.join(delivery, 'zh-CN', name), path.join(payloadRoot, 'versions', core.ID, name), digest);
  if (entry.files['nr_before_sr.ini'] !== core.INI || entry.files['nrchain_nvngx.dll'] !== core.CHAIN ||
      entry.files['dlss5-native-carrier-045-dx11-compat.addon64'] !== core.CARRIER ||
      pe.getBitness(path.join(payloadRoot, 'versions', core.ID, 'nr-before-sr.zh-CN.addon64')) !== 64)
    throw new Error('Incomplete Unified5 Core pair');
  bundle.versions[core.ID] = entry; bundle.defaultVersion = '0.4.7beta';
  manifest.core.payloadRoot = payloadRoot; manifest.core.versions = [...new Set([...manifest.core.versions, core.ID])];
  const bridge = manifest.components.find(row => row.id === 'bridge-1.4.13-pre8-official-20260916');
  if (bridge) {
    checked(path.join(bridge.sourceRoot, 'dlss5-bridge.addon64'), { sha256: 'c4c8b5bc4b26b2b3f3bf2767cdb708546d62f7d0bbb63d24e940c736da9efe26', bytes: 546304 });
    Object.assign(bridge, { sourceType: 'official-release', immutable: true, defaultEligible: false,
      repository: 'NIGos/dlss5-bridge', commit: 'ecd1b00674020a1e8c76a9cb653a1a21d11676a0',
      downloadUrl: 'https://github.com/NIGos/dlss5-bridge/releases/download/v1.4.13-pre8/dlss5-bridge.addon64' });
  }
  manifest.packageVersion = version;
  const noticeRoot = path.join(output, 'core-notices');
  manifest.resources = manifest.resources.filter(row => !row.path.startsWith('core-notices/unified5/'));
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
