'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('../src/product/fg-mfgunlock-resources');
const UPSTREAM_COMMIT = '4a7b7bcd5f4e951c0cae9ffa7db7e5bdf5f8d40b';
const PROVIDER = 'mfgunlock-0.9-zh-CN';
function verifySource(root = path.resolve(__dirname, '../native/mfgunlock')) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'source-lock.json'), 'utf8'));
  if (lock.upstream.commit !== UPSTREAM_COMMIT || lock.provider !== PROVIDER ||
      JSON.stringify(lock.localSafetyPatches) !== '[]') throw new Error('Unreviewed MFG source identity.');
  for (const [file, digest] of Object.entries(lock.upstream.files)) {
    if (path.basename(file) !== file || sha256(fs.readFileSync(path.join(root, 'upstream', file))) !== digest)
      throw new Error('MFG upstream source changed: ' + file);
  }
  const normalize = text => text.replaceAll('\r\n', '\n');
  let expected = normalize(fs.readFileSync(path.join(root, 'upstream/addon.cpp'), 'utf8'));
  for (const file of ['framecount.hpp', 'loadhook.hpp', 'midpoint.hpp', 'ngx_hook.hpp', 'pacing_policy.hpp', 'thin_geometry.hpp', 'blackwell.hpp']) {
    const before = '#include "./' + file + '"';
    if (expected.split(before).length !== 2) throw new Error('The upstream include boundary changed: ' + file);
    expected = expected.replace(before, '#include "./upstream/' + file + '"');
  }
  const start = expected.indexOf('void OnRegisterOverlay('), end = expected.indexOf('void LoadConfig()', start);
  if (start < 0 || end < 0) throw new Error('The upstream overlay boundary changed.');
  expected = expected.slice(0, start) + '#include "./panel_zh.inl"\n\n' + expected.slice(end);
  if (normalize(fs.readFileSync(path.join(root, 'addon.cpp'), 'utf8')) !== expected)
    throw new Error('MFG runtime code changed outside the isolated localized overlay.');
  const panel = fs.readFileSync(path.join(root, 'panel_zh.inl'), 'utf8');
  const keys = [...panel.matchAll(/set_config_value\([\s\S]{0,160}?kConfigSection,\s*"([^"]+)"/g)].map(match => match[1]).sort();
  const wanted = ['BlackwellFrameworkKernels', 'DepthEdgeGuardLevel', 'DynamicMFG', 'DynamicReflexSourceCap', 'DynamicTargetFPS',
    'Enabled', 'ForceFlipMeteringOff', 'ForceMultiplier', 'HDRCompatibilityMode', 'MaxCount', 'RuntimeSelectionMode', 'TemporalFix',
    'ThinGeometryIntermediateScatter', 'ThinGeometryPreviousScatter', 'ThinGeometryValidatedWarpBlend'].sort();
  if (lock.localizedPanel?.file !== 'panel_zh.inl' || lock.localizedPanel.sha256 !== sha256(Buffer.from(panel)) ||
      JSON.stringify(keys) !== JSON.stringify(wanted) || !panel.includes('固定总帧倍率（绝对值）') || !panel.includes('3x/4x 卡死救援') ||
      /(?:AddFont|BuildAtlas|GetIO\(\)\.Fonts|GlyphRanges)/.test(panel)) throw new Error('MFG panel crossed its preserved configuration/font contract.');
  return { upstreamCommit: lock.upstream.commit, runtimeChangesRestrictedTo: ['localized-overlay'], runtimeSafetyPatches: [],
    configurationKeysPreserved: true, fontAtlasOwnedByHost: true,
    binarySha256: null, panelSha256: sha256(Buffer.from(panel)), sourceSha256: sha256(fs.readFileSync(path.join(root, 'addon.cpp'))) };
}
if (require.main === module) console.log(JSON.stringify(verifySource(), null, 2));
module.exports = { verifySource };
