'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sha256, SOURCE_BUILD_ID, SOURCE_BUILD_SHA256 } = require('../src/product/fg-mfgunlock-resources');
const SAFETY_PATCH_ID = 'flip-metering-serialization-v1';
const GATE_SHA256 = 'd5ff66f0c1cdb52367796fa854a6d89c58a89d07857472cfdd72f6bc359487a8';
function verifySource(root = path.resolve(__dirname, '../native/mfgunlock')) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'source-lock.json'), 'utf8'));
  if (lock.upstream.commit !== 'ffe6169b5e98ad578fcf2c30614d06a567790fe1' || lock.provider !== SOURCE_BUILD_ID) throw new Error('Unreviewed MFG source identity.');
  for (const [file, digest] of Object.entries(lock.upstream.files)) {
    if (path.basename(file) !== file || sha256(fs.readFileSync(path.join(root, 'upstream', file))) !== digest)
      throw new Error('MFG upstream source changed: ' + file);
  }
  const normalize = text => text.replaceAll('\r\n', '\n');
  let expected = normalize(fs.readFileSync(path.join(root, 'upstream/addon.cpp'), 'utf8'));
  for (const file of ['framecount.hpp', 'loadhook.hpp', 'midpoint.hpp', 'ngx_hook.hpp']) expected = expected.replace('#include "./' + file + '"', '#include "./upstream/' + file + '"');
  const start = expected.indexOf('void OnRegisterOverlay('), end = expected.indexOf('void LoadConfig()', start);
  if (start < 0 || end < 0) throw new Error('The upstream overlay boundary changed.');
  expected = expected.slice(0, start) + '#include "./panel_zh.inl"\n\n' + expected.slice(end);
  const safetyPatch = { id: SAFETY_PATCH_ID, files: { 'patch_gate.hpp': GATE_SHA256 } };
  if (JSON.stringify(lock.localSafetyPatches) !== JSON.stringify([safetyPatch]) ||
      sha256(fs.readFileSync(path.join(root, 'patch_gate.hpp'))) !== GATE_SHA256)
    throw new Error('MFG patch serialization gate changed outside the reviewed safety patch.');
  const patches = [
    ['#include "./upstream/ngx_hook.hpp"', '#include "./upstream/ngx_hook.hpp"\n#include "./patch_gate.hpp"'],
    ['int g_flip_meter_attempts = 0;', 'std::atomic_int g_flip_meter_attempts{0};\nSRWLOCK g_flip_meter_lock = SRWLOCK_INIT;'],
    ['void TryPatchFlipMetering() {\n', 'void TryPatchFlipMetering() {\n  const mfgunlock::TryPatchGuard guard(g_flip_meter_lock);\n  if (!guard) return;\n'],
    ['// Keep compatibility retries away from Present.', 'void RestorePacingPatches() {\n  const mfgunlock::TryPatchGuard guard(g_flip_meter_lock);\n  if (!guard) return;\n  RestoreFrameCountCeiling();\n  RestoreFlipMetering();\n}\n\n// Keep compatibility retries away from Present.'],
    ['      RestoreFrameCountCeiling();\n      RestoreFlipMetering();', '      RestorePacingPatches();']
  ];
  for (const [before, after] of patches) {
    if (expected.split(before).length !== 2) throw new Error('The reviewed MFG safety patch boundary changed.');
    expected = expected.replace(before, after);
  }
  if (normalize(fs.readFileSync(path.join(root, 'addon.cpp'), 'utf8')) !== expected)
    throw new Error('MFG runtime code changed outside the isolated overlay and reviewed patch serialization changes.');
  const panel = fs.readFileSync(path.join(root, 'panel_zh.inl'), 'utf8');
  const keys = [...panel.matchAll(/set_config_value\(nullptr, kConfigSection, "([^"]+)"/g)].map(match => match[1]).sort();
  const wanted = ['DepthEdgeGuardLevel', 'Enabled', 'ForceFlipMeteringOff', 'ForceMultiplier', 'HDRCompatibilityMode', 'MaxCount', 'TemporalFix'].sort();
  if (JSON.stringify(keys) !== JSON.stringify(wanted) || !panel.includes('const unsigned int choices[] = {0, 2, 3, 4};') ||
      /(?:AddFont|BuildAtlas|GetIO\(\)\.Fonts|GlyphRanges)/.test(panel)) throw new Error('MFG panel crossed its preserved configuration/font contract.');
  return { upstreamCommit: lock.upstream.commit, runtimeChangesRestrictedTo: ['overlay', SAFETY_PATCH_ID], runtimeSafetyPatches: [safetyPatch],
    configurationKeysPreserved: true, fontAtlasOwnedByHost: true,
    binarySha256: SOURCE_BUILD_SHA256, panelSha256: sha256(Buffer.from(panel)), sourceSha256: sha256(fs.readFileSync(path.join(root, 'addon.cpp'))) };
}
if (require.main === module) console.log(JSON.stringify(verifySource(), null, 2));
module.exports = { verifySource };
