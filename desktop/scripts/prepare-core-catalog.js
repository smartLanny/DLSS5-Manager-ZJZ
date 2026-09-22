'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { preferredBundleDefault } = require('../src/product/core-menu');

function prepareCoreCatalog(input) {
  if (!input || input.version !== 4 || !input.versions || Array.isArray(input.versions)) throw new Error('需要已校验的 v4 成品目录。');
  const bundle = structuredClone(input);
  const preferred = preferredBundleDefault(bundle);
  const oldDefault = bundle.versions[bundle.defaultVersion];
  const retainedDefault = oldDefault?.supportsPresent === true && oldDefault.coreUpdateOnly !== true &&
    oldDefault.comparisonOnly !== true && Array.isArray(oldDefault.inputInterfaces) &&
    oldDefault.inputInterfaces.includes('NGX-D3D12-Feature1') ? bundle.defaultVersion : null;
  const hotfixes = Object.keys(bundle.versions).filter(id => /^0\.4\.6-hotfix\.\d+$/.test(id))
    .sort((left, right) => Number(left.split('.').at(-1)) - Number(right.split('.').at(-1)));
  const latestHotfix = hotfixes.at(-1);
  const replacement = latestHotfix || ['0.4.6', '0.4.6-ota'].find(id => Object.hasOwn(bundle.versions, id));
  const removed = [];
  const superseded = { ...(bundle.supersededVersions || {}) };
  if (replacement) for (const id of Object.keys(bundle.versions)) {
    if (/^0\.4\.5(?:$|[.-])/.test(id) || latestHotfix && ['0.4.6', '0.4.6-ota'].includes(id)) {
      delete bundle.versions[id]; superseded[id] = replacement; removed.push(id);
    }
  }
  if (latestHotfix) {
    bundle.defaultVersion = latestHotfix;
    // Retain migration hints even when a previous preparation already removed
    // these entries, so persisted selections can explain their replacement.
    for (const id of ['0.4.5', '0.4.5-ota', '0.4.6', '0.4.6-ota']) superseded[id] = latestHotfix;
  } else if (!Object.hasOwn(bundle.versions, bundle.defaultVersion) && replacement) bundle.defaultVersion = replacement;
  if (Object.hasOwn(bundle.versions, '0.4.7beta')) bundle.defaultVersion = '0.4.7beta';
  // Once the current default includes its DX11 companion, retired automatic
  // choices follow that full package instead of pinning new installs to 0.4.6.
  if (bundle.defaultVersion === '0.4.7beta' && bundle.versions['0.4.7beta'].compatibility === 'dx11') {
    for (const id of Object.keys(bundle.versions)) if (/^0\.4\.6(?:$|[.-])/.test(id)) {
      delete bundle.versions[id]; superseded[id] = bundle.defaultVersion; removed.push(id);
    }
    for (const id of Object.keys(superseded)) if (/^0\.4\.[56](?:$|[.-])/.test(id)) superseded[id] = bundle.defaultVersion;
  }
  if (Object.keys(superseded).length) bundle.supersededVersions = superseded;
  const hasR4Baseline = Object.hasOwn(bundle.versions,'0.3.3-dev-r4');
  for (const [id, entry] of Object.entries(bundle.versions)) {
    if (/^0\.2\./.test(id)) entry.label = `${id.match(/^0\.2\.\d+(?:\.\d+)?/)[0]}（历史兼容）`;
    if (/^0\.4\./.test(id) && entry.comparisonOnly !== true && entry.coreUpdateOnly !== true) entry.label = id === '0.4.7beta' ? 'beta0.4.7' : `${id} · Beta`;
    if (/^0\.3\./.test(id)) {
      // A recovered exact historical release keeps its own scope and provenance.
      if (id === '0.3.7' && entry.configContract === 'nr-037') continue;
      if (hasR4Baseline) entry.label = id === '0.3.3-dev-r4' ? '0.3.3.4 · 稳定兼容' : `${id} · 历史对照`;
      else {
        entry.label = `${id} · 稳定基线`;
        entry.notes = '0.3 稳定基线，用于日常使用与回退对照；0.4 系列仍为 Beta。';
      }
    }
  }
  if (preferred) bundle.defaultVersion = preferred;
  else if (retainedDefault && Object.hasOwn(bundle.versions, retainedDefault)) bundle.defaultVersion = retainedDefault;
  if (!Object.hasOwn(bundle.versions, bundle.defaultVersion)) throw new Error('核心目录没有可用的默认版本。');
  return { bundle, removed };
}

function main(file = path.join(__dirname, '../payload/nr-before-sr/bundle.json')) {
  const result = prepareCoreCatalog(JSON.parse(fs.readFileSync(file, 'utf8')));
  fs.writeFileSync(file, `${JSON.stringify(result.bundle, null, 2)}\n`, 'utf8');
  console.log(`核心目录：默认 ${result.bundle.defaultVersion}；0.3 稳定基线，0.4 Beta。`);
  if (result.removed.length) console.log(`已退出常规分发：${result.removed.join('、')}；替代关系已记录。`);
  return result;
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { prepareCoreCatalog, main };
