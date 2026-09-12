'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PAYLOAD_FILES } = require('../src/product/constants');
const { createCompactBundle, inspectPayload, requirePayload } = require('../src/product/payload');
const { resolvePayloadDirectory, inspectSource } = require('../src/product/payload-source');

function fixture(t) {
  const owner = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-payload-source-')), dir = path.join(owner, 'payload', 'nr-before-sr');
  t.after(() => fs.rmSync(owner, { recursive: true, force: true }));
  for (const family of ['RTX40', 'RTX50']) {
    const fixed = path.join(dir, 'fixed', family); fs.mkdirSync(fixed, { recursive: true });
    for (const kind of ['reshade', 'bridge', 'runtime']) fs.writeFileSync(path.join(fixed, PAYLOAD_FILES[kind]), `${family}:${kind}`);
  }
  const version = path.join(dir, 'versions', 'v1'); fs.mkdirSync(version, { recursive: true });
  fs.writeFileSync(path.join(version, PAYLOAD_FILES.addon), 'v1:addon'); fs.writeFileSync(path.join(version, PAYLOAD_FILES.config), 'v1:config');
  const bundle = createCompactBundle(dir, [{ id: 'v1', label: 'fixture' }], 'v1'); fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify(bundle));
  return { owner, dir, bundleFile: path.join(dir, 'bundle.json'), addon: path.join(version, PAYLOAD_FILES.addon) };
}

test('resolves a bundle, payload root, nr-before-sr parent and outer payload parent', t => {
  const f = fixture(t), canonical = fs.realpathSync(f.dir);
  for (const selected of [f.bundleFile, f.dir, path.dirname(f.dir), f.owner]) assert.equal(resolvePayloadDirectory(selected), canonical);
  const inspected = inspectSource(f.owner, { hardwareFamily: 'RTX50', version: 'v1' });
  assert.equal(inspected.dir, canonical); assert.equal(inspected.selectedVersion, 'v1'); assert.equal(inspected.ready, true);
});

test('missing paths and unrelated files fail without creating anything', t => {
  const f = fixture(t), unrelated = path.join(f.owner, 'notes.txt'); fs.writeFileSync(unrelated, 'keep');
  const before = fs.readdirSync(f.owner).sort();
  assert.throws(() => resolvePayloadDirectory(path.join(f.owner, 'missing')), { code: 'ERR_PAYLOAD_SOURCE_MISSING' });
  assert.throws(() => resolvePayloadDirectory(unrelated), { code: 'ERR_PAYLOAD_SOURCE_INVALID' });
  assert.deepEqual(fs.readdirSync(f.owner).sort(), before); assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
});

test('source inspection distinguishes a missing file from a bad hash', t => {
  const f = fixture(t); fs.appendFileSync(f.addon, 'tampered');
  assert.throws(() => inspectSource(f.dir, { hardwareFamily: 'RTX40', version: 'v1' }), error =>
    error.code === 'ERR_PAYLOAD_SOURCE_HASH' && error.details.files.includes(PAYLOAD_FILES.addon) && error.details.path === fs.realpathSync(f.dir));
  fs.writeFileSync(f.addon, 'v1:addon'); fs.unlinkSync(path.join(f.dir, 'versions', 'v1', PAYLOAD_FILES.config));
  assert.throws(() => inspectSource(f.dir, { hardwareFamily: 'RTX40', version: 'v1' }), error =>
    error.code === 'ERR_PAYLOAD_SOURCE_MISSING' && error.details.files.includes(PAYLOAD_FILES.config));
});

test('manifest version and file keys cannot escape the payload root', t => {
  const f = fixture(t), outside = path.join(f.owner, 'outside.bin'); fs.writeFileSync(outside, 'do-not-read-or-change');
  const bundle = JSON.parse(fs.readFileSync(f.bundleFile, 'utf8'));
  bundle.versions['../outside'] = bundle.versions.v1; bundle.defaultVersion = '../outside'; fs.writeFileSync(f.bundleFile, JSON.stringify(bundle));
  assert.throws(() => inspectSource(f.dir, { hardwareFamily: 'RTX40' }), { code: 'ERR_PAYLOAD_SOURCE_HASH' });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'do-not-read-or-change');

  delete bundle.versions['../outside']; bundle.defaultVersion = 'v1';
  bundle.versions.v1.files[path.resolve(outside)] = '0'.repeat(64); fs.writeFileSync(f.bundleFile, JSON.stringify(bundle));
  assert.throws(() => inspectSource(f.dir, { hardwareFamily: 'RTX40' }), { code: 'ERR_PAYLOAD_SOURCE_HASH' });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'do-not-read-or-change');
});

test('a linked payload directory or linked declared file is rejected', t => {
  const f = fixture(t), link = path.join(f.owner, 'linked-payload');
  fs.symlinkSync(f.dir, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => resolvePayloadDirectory(link), { code: 'ERR_PAYLOAD_SOURCE_INVALID' }); fs.unlinkSync(link);

  const versionDir = path.dirname(f.addon), external = path.join(f.owner, 'external-version');
  fs.cpSync(versionDir, external, { recursive: true }); fs.rmSync(versionDir, { recursive: true });
  fs.symlinkSync(external, versionDir, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => inspectSource(f.dir, { hardwareFamily: 'RTX40', version: 'v1' }), { code: 'ERR_PAYLOAD_SOURCE_HASH' });
  assert.throws(() => requirePayload(f.dir, 'RTX40', 'v1'), { code: 'ERR_PAYLOAD_HASH' });
  fs.unlinkSync(versionDir); assert.equal(fs.readFileSync(path.join(external, PAYLOAD_FILES.addon), 'utf8'), 'v1:addon');
});

test('replacing a previously resolved directory is freshly rejected', t => {
  const f = fixture(t), canonical = resolvePayloadDirectory(f.dir), parked = `${f.dir}-parked`;
  fs.renameSync(f.dir, parked); fs.mkdirSync(f.dir, { recursive: true });
  assert.throws(() => inspectSource(canonical, { hardwareFamily: 'RTX40', version: 'v1' }), { code: 'ERR_PAYLOAD_SOURCE_MISSING' });
  assert.deepEqual(fs.readdirSync(f.dir), [], 'inspection did not populate the replacement directory');
});

const real = path.resolve(__dirname, '..', 'payload', 'nr-before-sr');
test('production v4 layout remains readable through the external-source boundary', { skip: !fs.existsSync(path.join(real, 'bundle.json')) }, () => {
  const inspected = inspectSource(real, { hardwareFamily: 'RTX50' });
  assert.equal(inspected.bundle.version, 4); assert.equal(inspected.ready, true);
  assert.equal(inspectPayload(real, { hardwareFamily: 'RTX50' }).ready, true);
});

test('a prototype property cannot stand in for a catalog default version', t => {
  const f = fixture(t), bundle = JSON.parse(fs.readFileSync(f.bundleFile, 'utf8'));
  bundle.defaultVersion = 'constructor';
  fs.writeFileSync(f.bundleFile, JSON.stringify(bundle));
  assert.throws(() => inspectSource(f.dir, { hardwareFamily: 'RTX40' }), { code: 'ERR_PAYLOAD_SOURCE_HASH' });
});
