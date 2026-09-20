'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PAYLOAD_FILES, DX11_COMPAT_VERSION, DX11_COMPAT_LABEL, DX11_COMPAT_CARRIER } = require('../src/product/constants');
const { createBundle, createVariantsBundle, createVersionedBundle, createCompactBundle, inspectPayload, requirePayload } = require('../src/product/payload');

test('unified3 requires every exact face resource, hashes nested files and rejects arbitrary paths', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified3-payload-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const id = '0.5-dline21-unified3', names = require('../src/product/payload-companions').NAMES;
  for (const family of ['RTX40', 'RTX50']) for (const kind of ['reshade', 'bridge', 'runtime']) {
    const file = path.join(dir, 'fixed', family, PAYLOAD_FILES[kind]); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, kind);
  }
  for (const name of [PAYLOAD_FILES.addon, PAYLOAD_FILES.config, ...names]) {
    const file = path.join(dir, 'versions', id, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, name);
  }
  const bundle = createCompactBundle(dir, [{ id }], id), save = () => fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify(bundle)); save();
  assert.equal(requirePayload(dir, 'RTX40', id).companions.length, 7);
  fs.appendFileSync(path.join(dir, 'versions', id, names[0]), 'changed');
  assert.throws(() => requirePayload(dir, 'RTX40', id), { code: 'ERR_PAYLOAD_HASH' });
  fs.writeFileSync(path.join(dir, 'versions', id, names[0]), names[0]);
  bundle.versions[id].companions['nr_face/unknown.dll'] = 'a'.repeat(64); save();
  assert.throws(() => requirePayload(dir, 'RTX40', id), { code: 'ERR_PAYLOAD_HASH' });
  delete bundle.versions[id].companions; save();
  assert.throws(() => requirePayload(dir, 'RTX40', id), { code: 'ERR_PAYLOAD_HASH' });
});

test('requires every payload file and detects tampering', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-payload-'));
  for (const name of Object.values(PAYLOAD_FILES)) fs.writeFileSync(path.join(dir, name), name);
  const bundle = createBundle(dir);
  fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify(bundle));
  assert.equal(inspectPayload(dir).ready, true);
  fs.appendFileSync(path.join(dir, PAYLOAD_FILES.bridge), 'changed');
  const changed = inspectPayload(dir);
  assert.equal(changed.ready, false);
  assert.deepEqual(changed.invalid, [PAYLOAD_FILES.bridge]);
});

test('selects the matching RTX 40 / RTX 50 payload variant', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-payload-variants-'));
  for (const family of ['RTX40', 'RTX50']) {
    const variant = path.join(dir, family);
    fs.mkdirSync(variant);
    for (const name of Object.values(PAYLOAD_FILES)) fs.writeFileSync(path.join(variant, name), `${family}:${name}`);
  }
  fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify(createVariantsBundle(dir)));
  const inspected = inspectPayload(dir);
  assert.equal(inspected.ready, true);
  assert.equal(requirePayload(dir, 'RTX40').hardwareFamily, 'RTX40');
  assert.equal(requirePayload(dir, 'RTX50').hardwareFamily, 'RTX50');
  assert.throws(() => requirePayload(dir, 'unknown'), error => error.code === 'ERR_GPU_UNSUPPORTED');
});

test('selects a version and then the matching GPU variant', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-payload-versions-'));
  for (const version of ['0.4.1-r2', '0.4.4test']) {
    for (const family of ['RTX40', 'RTX50']) {
      const variant = path.join(dir, 'versions', version, family);
      fs.mkdirSync(variant, { recursive: true });
      for (const name of Object.values(PAYLOAD_FILES)) fs.writeFileSync(path.join(variant, name), `${version}:${family}:${name}`);
    }
  }
  const bundle = createVersionedBundle(dir, [
    { id: '0.4.1-r2', label: '0.4.1-r2' },
    { id: '0.4.4test', label: '0.4.4test' }
  ], '0.4.1-r2');
  fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify(bundle));
  const inspected = inspectPayload(dir, { hardwareFamily: 'RTX50', version: '0.4.4test' });
  assert.equal(inspected.selectedVersion, '0.4.4test');
  assert.equal(inspected.ready, true);
  assert.equal(requirePayload(dir, 'RTX40', '0.4.1-r2').version, '0.4.1-r2');
});

test('shares fixed runtime files while switching only the versioned addon and config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-payload-compact-'));
  for (const family of ['RTX40', 'RTX50']) {
    const fixed = path.join(dir, 'fixed', family);
    fs.mkdirSync(fixed, { recursive: true });
    for (const name of ['ReShade64.dll', 'nrchain_nvngx.dll', 'nvngx_dlssnr.dll']) fs.writeFileSync(path.join(fixed, name), `${family}:${name}`);
  }
  for (const version of ['0.3.3.5', '0.4.1-r2', '0.4.4test']) {
    const versionDir = path.join(dir, 'versions', version);
    fs.mkdirSync(versionDir, { recursive: true });
    fs.writeFileSync(path.join(versionDir, PAYLOAD_FILES.addon), `${version}:addon`);
    fs.writeFileSync(path.join(versionDir, PAYLOAD_FILES.config), `${version}:config`);
  }
  const bundle = createCompactBundle(dir, [
    { id: '0.3.3.5', label: '0.3.3.5' },
    { id: '0.4.1-r2', label: '0.4.1-r2' },
    { id: '0.4.4test', label: '0.4.4test' }
  ], '0.4.1-r2');
  fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify(bundle));
  const inspected = inspectPayload(dir, { hardwareFamily: 'RTX50', version: '0.4.4test' });
  assert.equal(inspected.selectedVersion, '0.4.4test');
  assert.equal(inspected.ready, true);
  assert.match(requirePayload(dir, 'RTX40', '0.4.4test').addon.file, /versions[\\/]0\.4\.4test[\\/]/);
  assert.match(requirePayload(dir, 'RTX40', '0.4.4test').runtime.file, /fixed[\\/]RTX40[\\/]/);
});

test('0.4.5 compatibility entry owns its matched bridge and carrier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-payload-dx11-compat-'));
  for (const family of ['RTX40', 'RTX50']) {
    const fixed = path.join(dir, 'fixed', family);
    fs.mkdirSync(fixed, { recursive: true });
    for (const name of ['ReShade64.dll', 'nrchain_nvngx.dll', 'nvngx_dlssnr.dll']) {
      fs.writeFileSync(path.join(fixed, name), `fixed:${family}:${name}`);
    }
  }
  for (const version of ['0.3.3.5', DX11_COMPAT_VERSION]) {
    const versionDir = path.join(dir, 'versions', version);
    fs.mkdirSync(versionDir, { recursive: true });
    fs.writeFileSync(path.join(versionDir, PAYLOAD_FILES.addon), `${version}:addon`);
    fs.writeFileSync(path.join(versionDir, PAYLOAD_FILES.config), `${version}:config`);
  }
  const compatDir = path.join(dir, 'versions', DX11_COMPAT_VERSION);
  fs.writeFileSync(path.join(compatDir, PAYLOAD_FILES.bridge), 'matched:bridge');
  fs.writeFileSync(path.join(compatDir, DX11_COMPAT_CARRIER), 'matched:carrier');
  const bundle = createCompactBundle(dir, [
    { id: '0.3.3.5', label: '0.3.3.5' },
    { id: DX11_COMPAT_VERSION, label: DX11_COMPAT_LABEL, compatibility: 'dx11' }
  ], '0.3.3.5');
  fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify(bundle));

  const stable = requirePayload(dir, 'RTX40', '0.3.3.5');
  const compat = requirePayload(dir, 'RTX40', DX11_COMPAT_VERSION);
  assert.match(stable.bridge.file, /fixed[\\/]RTX40[\\/]nrchain_nvngx\.dll$/);
  assert.match(compat.bridge.file, /versions[\\/]0\.4\.5-ota[\\/]nrchain_nvngx\.dll$/);
  assert.equal(compat.carrier.name, DX11_COMPAT_CARRIER);
  assert.equal(compat.versionInfo.label, DX11_COMPAT_LABEL);
});
