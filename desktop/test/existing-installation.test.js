'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { INSTALLED_NAMES } = require('../src/product/constants');
const { inspectExistingInstallation } = require('../src/product/existing-installation');

test('exact Core footprint is reported separately without guessing a version', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-existing-'));
  try {
    const exe = path.join(root, 'Game.exe'); fs.writeFileSync(exe, 'exe');
    for (const kind of ['addon', 'bridge', 'runtime', 'config']) fs.writeFileSync(path.join(root, INSTALLED_NAMES[kind]), kind);
    const found = inspectExistingInstallation({ executable: exe });
    assert.equal(found.detected, true); assert.equal(found.managed, false);
    assert.equal(found.corePresent, true); assert.equal(found.complete, true);
    assert.equal(found.version, null); assert.equal(found.versionStatus, 'unverified');
    assert.deepEqual(found.files.map(row => row.name).sort(), ['nr-before-sr.zh-CN.addon64', 'nr_before_sr.ini', 'nrchain_nvngx.dll', 'nvngx_dlssnr.dll'].sort());
    assert.equal(inspectExistingInstallation({ executable: exe, managed: true }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('ReShade or a config alone is not mistaken for an existing Core installation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-existing-'));
  try {
    const exe = path.join(root, 'Game.exe'); fs.writeFileSync(exe, 'exe');
    fs.writeFileSync(path.join(root, INSTALLED_NAMES.reshade), 'unrelated reshade');
    fs.writeFileSync(path.join(root, INSTALLED_NAMES.config), 'stale config');
    assert.equal(inspectExistingInstallation({ executable: exe }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
