'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalog = require('../src/shared/core-catalog');
const { CORE_033, REQUIRED_CORE_IDS, validate033Identity, assertExact033, assertVulkanBridgeDeployment } = require('../scripts/release-gate.cjs');

test('formal release gate accepts only the registered 0.3.3.4 identity', () => {
  const entry = { files: { [CORE_033.file]: CORE_033.sha256 } };
  assert.deepEqual(validate033Identity(entry, { size: CORE_033.bytes }, CORE_033.sha256), {
    id: CORE_033.id, displayVersion: '0.3.3.4', bytes: CORE_033.bytes, sha256: CORE_033.sha256
  });
  assert.throws(() => validate033Identity({ ...entry, substitute: true }, { size: CORE_033.bytes }, CORE_033.sha256), /禁止用其他版本改名/);
  assert.throws(() => validate033Identity(entry, { size: CORE_033.bytes }, 'a'.repeat(64)), /不是登记的精确原文件/);
});

test('formal release gate blocks an otherwise complete bundle while exact 0.3.3.4 is absent', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-release-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const versions = Object.fromEntries(REQUIRED_CORE_IDS.filter(id => id !== CORE_033.id).map(id => [id, { files: {} }]));
  fs.writeFileSync(path.join(root, 'bundle.json'), JSON.stringify({ version: 4, defaultVersion: catalog.RECOMMENDED, versions }));
  assert.throws(() => assertExact033(root), /精确 0\.3\.3\.4/);
});

test('formal release gate requires the catalog recommended Core as the default with its exact bytes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-release-gate-default-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const versions = Object.fromEntries(REQUIRED_CORE_IDS.map(id => [id, { files: {} }]));
  versions[catalog.RECOMMENDED] = { files: { [CORE_033.file]: catalog.byId(catalog.RECOMMENDED).addon['zh-CN'] } };
  const write = bundle => fs.writeFileSync(path.join(root, 'bundle.json'), JSON.stringify({ version: 4, versions, ...bundle }));
  write({ defaultVersion: '0.4.7beta' });
  assert.throws(() => assertExact033(root), /为默认值/);
  const withoutRecommended = { ...versions }; delete withoutRecommended[catalog.RECOMMENDED];
  write({ defaultVersion: catalog.RECOMMENDED, versions: withoutRecommended });
  assert.throws(() => assertExact033(root), /当前推荐 Core/);
  // The listed digest is the catalog's, but the file on disk is a stand-in.
  fs.mkdirSync(path.join(root, 'versions', catalog.RECOMMENDED), { recursive: true });
  fs.writeFileSync(path.join(root, 'versions', catalog.RECOMMENDED, CORE_033.file), 'not the delivered Core');
  write({ defaultVersion: catalog.RECOMMENDED });
  assert.throws(() => assertExact033(root), /与 Core 清单登记的文件不一致/);
});

test('formal release gate does not confuse a Vulkan-capable addon with a deployable Bridge Profile', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-vulkan-bridge-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'resources', 'components'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ schemaVersion: 1, packages: [{
    id: 'bridge-1.4.13-pre8-official', kind: 'bridge', gameApis: ['dx11', 'vulkan'],
    capabilities: ['vulkan-requires-reshade-layer']
  }] }));
  assert.throws(() => assertVulkanBridgeDeployment(root), /可部署的 Vulkan Bridge Profile/);
});
