'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PRODUCT } = require('../src/product/constants');

const required = [
  'LICENSE',
  'src/library.js',
  'src/core/pe.js',
  'src/core/emulators.js',
  'src/core/feeder-release.js',
  'src/core/file-journal.js',
  'src/core/scan.js',
  'src/core/install-guards.js'
];
const root = path.join(__dirname, '..', 'vendor', 'DLSS5-Swapper');
const missing = required.filter(rel => !fs.existsSync(path.join(root, rel)));
if (missing.length) {
  console.error('DLSS5-Swapper vendor source is missing or incomplete.');
  console.error('For a git clone, run: git submodule update --init --recursive');
  console.error('For a source archive, run: powershell -File scripts/bootstrap-vendor.ps1');
  for (const rel of missing) console.error(`  missing: ${rel}`);
  process.exit(1);
}

// A git checkout can prove the exact upstream revision. Source archives may
// have a vendored copy without .git metadata, so file presence remains the
// fallback there and the baseline is still documented in UPSTREAM.md.
if (fs.existsSync(path.join(root, '.git'))) {
  let actual = '';
  try {
    actual = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', windowsHide: true
    }).trim();
  } catch (error) {
    console.error('Unable to read the DLSS5-Swapper submodule revision.');
    process.exit(1);
  }
  if (actual !== PRODUCT.upstreamCommit) {
    console.error(`Unexpected DLSS5-Swapper revision: ${actual}`);
    console.error(`Expected: ${PRODUCT.upstreamCommit}`);
    process.exit(1);
  }
}

console.log(`Pinned DLSS5-Swapper vendor is ready (${PRODUCT.upstreamCommit}).`);
