'use strict';

// Reuse the already verified small-component inventory from a prior Manager
// build while replacing its Core catalog and machine-local source paths.
const fs = require('node:fs');
const path = require('node:path');

const CORE_VERSIONS = Object.freeze(['0.2.0-beta.2', '0.4.2', '0.4.7beta', '0.5-dline21']);
const RUNTIMES = Object.freeze({
  RTX40: { bytes:165830144, sha256:'6eb209e764f39872625debd6abaf45e2bb6322f6f270f781f70c059ae30b3927' },
  RTX50: { bytes:165840496, sha256:'e16bcf15e16e13f527491cdf7845b2fe6521a738d8f7c9c721866a8496e1fc8e' }
});
// MFG releases come only from the provider pin catalog.
const MFG_CATALOG = require('../src/product/fg-mfgunlock-providers.json');
const MFG = Object.freeze(Object.fromEntries(MFG_CATALOG.providers.map(row => [row.version, Object.freeze({ id:row.id,
  bytes:row.files.addon.bytes, sha256:row.files.addon.sha256, recommended:row.id === MFG_CATALOG.defaultProvider, url:row.files.addon.url })])));
const SUPERSEDED_COMPONENTS = Object.freeze(new Set(['bridge-1.4.13-pre7-manager-core-compat-20260912']));

function fail(message) { throw new Error(message); }
function stripPrefix(value, prefix, label) {
  const normalized = String(value || '').replaceAll('\\', '/');
  if (!normalized.startsWith(prefix) || normalized.length === prefix.length) fail(`${label} 路径不属于预期目录：${value}`);
  return normalized.slice(prefix.length);
}
function createManifest({ prior, resourcesRoot, selectedIds, payloadRoot, runtime40, runtime50, mfgDir, officialBridges = null }) {
  const stage = prior?.stage || prior;
  const packages = stage?.components?.packages;
  const verifiedResources = stage?.resources?.files;
  if (!Array.isArray(packages) || !Array.isArray(verifiedResources)) fail('既有报告缺少已验证 components/resources。');
  if (!Array.isArray(selectedIds) || !selectedIds.length || new Set(selectedIds).size !== selectedIds.length) fail('必须提供不重复的组件 ID。');
  const byId = new Map(packages.map(row => [row.id, row]));
  let components = selectedIds.map(id => {
    if (SUPERSEDED_COMPONENTS.has(id)) fail(`Bridge pre7 已被官方 pre8 取代，不能进入 beta2 发布包：${id}`);
    const row = byId.get(id);
    if (!row) fail(`既有报告没有组件：${id}`);
    const prefix = `components/${id}/`;
    const { schema, source, files, ...metadata } = structuredClone(row);
    return {
      ...metadata,
      includeIn: ['base', 'offline'],
      sourceRoot: path.join(path.resolve(resourcesRoot), 'components', id),
      files: files.map(file => ({
        source: stripPrefix(file.path, prefix, `组件 ${id}`),
        path: stripPrefix(file.path, prefix, `组件 ${id}`),
        bytes: file.bytes,
        sha256: file.sha256
      }))
    };
  });
  if (officialBridges) {
    if (officialBridges.schemaVersion !== 1 || !Array.isArray(officialBridges.components) || officialBridges.components.length !== 2 ||
        officialBridges.components.some(row => row?.kind !== 'bridge' || !path.isAbsolute(row.sourceRoot || '') || !Array.isArray(row.files)))
      fail('官方 Bridge staging 片段无效。');
    components = components.filter(row => row.kind !== 'bridge');
    for (const row of officialBridges.components) {
      if (components.some(item => item.id === row.id)) fail(`官方 Bridge ID 重复：${row.id}`);
      components.push(structuredClone(row));
    }
  }
  const resources = verifiedResources.map(row => {
    const relative = stripPrefix(row.path, 'resources/', '小资源');
    return { source:path.join(path.resolve(resourcesRoot), ...relative.split('/')), path:relative, bytes:row.bytes, sha256:row.sha256 };
  });
  return {
    schemaVersion: 1,
    packageVersion: '0.5.0-beta.2',
    core: { payloadRoot:path.resolve(payloadRoot), version:'0.4.7beta', versions:[...CORE_VERSIONS] },
    runtime: { sourceRoot:path.dirname(path.resolve(runtime40)), families: {
      RTX40: { file:path.resolve(runtime40), ...RUNTIMES.RTX40 },
      RTX50: { file:path.resolve(runtime50), ...RUNTIMES.RTX50 }
    } },
    // --mfg-dir holds <version>/renodx-mfgunlock.addon64 for every pinned provider.
    mfg: { defaultProvider:MFG_CATALOG.defaultProvider, providers: Object.entries(MFG).map(([version, pin]) =>
      ({ file:path.resolve(mfgDir, version, 'renodx-mfgunlock.addon64'), version, ...pin })) },
    components,
    resources,
    bridge: { status:'reserved', id:'nigos-dlss5-bridge', version:'1.4.12', url:'https://github.com/NIGos/dlss5-bridge' }
  };
}
function parseArgs(argv) {
  const out = {};
  for (let i=2;i<argv.length;i+=2) {
    const key = argv[i];
    if (!/^--(?:prior-report|resources-root|components|payload|runtime40|runtime50|mfg-dir|official-bridges|output)$/.test(key) || !argv[i+1]) fail('参数不完整。');
    out[key.slice(2)] = argv[i+1];
  }
  for (const key of ['prior-report','resources-root','components','payload','runtime40','runtime50','mfg-dir','output']) if (!out[key]) fail(`缺少 --${key}。`);
  return out;
}
if (require.main === module) {
  try {
    const args = parseArgs(process.argv), prior = JSON.parse(fs.readFileSync(path.resolve(args['prior-report']), 'utf8'));
    const officialBridges = args['official-bridges'] ? JSON.parse(fs.readFileSync(path.resolve(args['official-bridges']),'utf8')) : null;
    const manifest = createManifest({ prior, resourcesRoot:args['resources-root'], selectedIds:args.components.split(',').filter(Boolean),
      payloadRoot:args.payload, runtime40:args.runtime40, runtime50:args.runtime50, mfgDir:args['mfg-dir'], officialBridges });
    const output = path.resolve(args.output);
    fs.mkdirSync(path.dirname(output), { recursive:true });
    fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { encoding:'utf8', flag:'wx' });
    console.log(JSON.stringify({ output, components:manifest.components.map(row => row.id), resources:manifest.resources.length }, null, 2));
  } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
module.exports = { CORE_VERSIONS, RUNTIMES, MFG, SUPERSEDED_COMPONENTS, createManifest };
