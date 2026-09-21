'use strict';
const path = require('node:path');

// Keep row.rel bound to the installation-before path for restoration. The
// currently active entry can move in either direction without moving baseline.
function nativeTargetRel(manifest, row) {
  return row.kind === 'reshade' && ['dxgi', 'd3d12'].includes(manifest.reshadeRoute) && /^(dxgi|d3d12)\.dll$/i.test(path.basename(row.rel))
    ? path.join(path.dirname(row.rel), manifest.reshadeRoute + '.dll') : row.rel;
}
function nativeEntryForTarget(manifest, rel) {
  return manifest.files.find(row => path.normalize(nativeTargetRel(manifest, row)).toLowerCase() === path.normalize(rel).toLowerCase());
}
module.exports = { nativeTargetRel, nativeEntryForTarget };
