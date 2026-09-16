'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
  fs.writeFileSync(path.join(root, 'bundle.json'), JSON.stringify({ version: 4, defaultVersion: '0.4.7beta', versions }));
  assert.throws(() => assertExact033(root), /精确 0\.3\.3\.4/);
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
