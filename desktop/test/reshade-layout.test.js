'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { inspectAddonLayout, addonValues } = require('../src/product/reshade-layout');

test('ReShade scalar AddonPath uses the first repeated value and unescapes commas', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(inspectAddonLayout(root).ok, true);
  fs.writeFileSync(path.join(root, 'ReShade.ini'), '\uFEFF[ADDON]\nAddonPath=.\nAddonPath=elsewhere\n');
  assert.equal(inspectAddonLayout(root).ok, true);
  assert.deepEqual(addonValues('[ADDON]\nAddonPath=with,,comma,next\n').get('AddonPath'), ['with,comma', 'next']);
  fs.writeFileSync(path.join(root, 'ReShade.ini'), '[ADDON]\nAddonPath=elsewhere\nAddonPath=.\n');
  assert.equal(inspectAddonLayout(root).code, 'ERR_ADDON_SEARCH_PATH');
});

test('ordinary direct-loaded HDR addon is retained, competing direct NR/carrier loading is diagnosed', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ini = path.join(root, 'ReShade.ini');
  fs.writeFileSync(ini, '[ADDON]\nLoadFromDllMain=renodx-hdr.addon64\n');
  assert.equal(inspectAddonLayout(root).ok, true);
  fs.appendFileSync(ini, 'LoadFromDllMain=C:\\old\\dlss5-bridge.addon64\n');
  assert.equal(inspectAddonLayout(root).code, 'ERR_ADDON_DIRECT_LOAD');
  fs.writeFileSync(ini, Buffer.from([0xff, 0xfe, 0x41, 0x00]));
  assert.equal(inspectAddonLayout(root).code, 'ERR_RESHADE_CONFIG');
});

test('valid BasePath and inherited base overrides cannot hide the actual addon configuration', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const external = path.join(root, 'custom'); fs.mkdirSync(external);
  fs.writeFileSync(path.join(root, 'ReShade.ini'), '[INSTALL]\nBasePath=custom\n[ADDON]\nAddonPath=.\n');
  assert.equal(inspectAddonLayout(root, {}).code, 'ERR_ADDON_SEARCH_PATH');
  fs.writeFileSync(path.join(root, 'ReShade.ini'), '[INSTALL]\nBasePath=missing\n');
  assert.equal(inspectAddonLayout(root, {}).ok, true, 'a missing override falls back as ReShade does');
  assert.equal(inspectAddonLayout(root, { RESHADE_BASE_PATH_OVERRIDE: external }).code, 'ERR_ADDON_SEARCH_PATH');
  fs.writeFileSync(path.join(root, 'ReShade.ini'), '[INSTALL]\nBasePath=.\n');
  assert.equal(inspectAddonLayout(root, { RESHADE_BASE_PATH_OVERRIDE: external }).ok, true, 'valid INI override precedes the environment');
});
