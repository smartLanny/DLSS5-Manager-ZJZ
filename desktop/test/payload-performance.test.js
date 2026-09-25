'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PAYLOAD_FILES } = require('../src/product/constants');
const { createCompactBundle, inspectPayload, requirePayload } = require('../src/product/payload');
const { createPayloadInspectionCache } = require('../src/product/payload-inspection-cache');

function fixture(t, versions = ['one', 'two', 'three']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-payload-perf-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const family of ['RTX40', 'RTX50']) {
    const dir = path.join(root, 'fixed', family); fs.mkdirSync(dir, { recursive: true });
    for (const kind of ['reshade', 'bridge', 'runtime']) fs.writeFileSync(path.join(dir, PAYLOAD_FILES[kind]), `${family}-${kind}-shared`);
  }
  for (const version of versions) {
    const dir = path.join(root, 'versions', version); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, PAYLOAD_FILES.addon), `${version}-addon`);
    fs.writeFileSync(path.join(dir, PAYLOAD_FILES.config), `${version}-config`);
  }
  const bundle = createCompactBundle(root, versions.map(id => ({ id })), versions[0]);
  fs.writeFileSync(path.join(root, 'bundle.json'), JSON.stringify(bundle)); return root;
}

function countReads(root, work) {
  const originalOpen = fs.openSync, originalRead = fs.readSync, originalClose = fs.closeSync;
  const calls = new Map(), handles = new Map(); let bytes = 0;
  fs.openSync = function(file, ...args) {
    const fd = originalOpen.call(this, file, ...args), resolved = path.resolve(String(file)).toLowerCase();
    if (resolved.startsWith(path.resolve(root).toLowerCase() + path.sep)) {
      handles.set(fd, resolved); calls.set(resolved, (calls.get(resolved) || 0) + 1);
    }
    return fd;
  };
  fs.readSync = function(fd, ...args) { const n = originalRead.call(this, fd, ...args); if (handles.has(fd)) bytes += n; return n; };
  fs.closeSync = function(fd) { handles.delete(fd); return originalClose.call(this, fd); };
  try { const value = work(); return { value, calls, bytes }; }
  finally { fs.openSync = originalOpen; fs.readSync = originalRead; fs.closeSync = originalClose; }
}

test('compact inspection hashes each shared physical file once per fresh call', t => {
  const root = fixture(t), runtime = path.resolve(root, 'fixed', 'RTX40', PAYLOAD_FILES.runtime).toLowerCase();
  const once = countReads(root, () => inspectPayload(root, { hardwareFamily: 'RTX40' }));
  assert.equal(once.value.ready, true); assert.equal(once.calls.get(runtime), 1);
  const required = countReads(root, () => [requirePayload(root, 'RTX40'), requirePayload(root, 'RTX40')]);
  assert.equal(required.calls.get(runtime), 2, 'requirePayload starts a fresh integrity inspection on every call');
});

test('display cache invalidates on content, missing-file and explicit invalidation changes', t => {
  const root = fixture(t), cache = createPayloadInspectionCache({ maxEntries: 2 });
  const addon = path.join(root, 'versions', 'one', PAYLOAD_FILES.addon), addonKey = path.resolve(addon).toLowerCase();
  const warm = countReads(root, () => [cache.inspect(root, { hardwareFamily: 'RTX40' }), cache.inspect(root, { hardwareFamily: 'RTX40' })]);
  assert.equal(warm.calls.get(addonKey), 1, 'unchanged display inspection reuses hashes');
  const copy = cache.inspect(root, { hardwareFamily: 'RTX40' }); copy.ready = false;
  assert.equal(cache.inspect(root, { hardwareFamily: 'RTX40' }).ready, true, 'callers cannot mutate the cached result');

  fs.writeFileSync(addon, 'tampered-x'); fs.utimesSync(addon, new Date(), new Date(Date.now() + 2000));
  const changed = countReads(root, () => cache.inspect(root, { hardwareFamily: 'RTX40' }));
  assert.equal(changed.value.ready, false); assert.ok(changed.value.invalid.includes(PAYLOAD_FILES.addon)); assert.equal(changed.calls.get(addonKey), 1);
  const invalidRetry = countReads(root, () => cache.inspect(root, { hardwareFamily: 'RTX40' }));
  assert.equal(invalidRetry.calls.get(addonKey), 1, 'invalid results are inspected again instead of cached');

  const config = path.join(root, 'versions', 'one', PAYLOAD_FILES.config), originalConfig = 'one-config'; fs.unlinkSync(config);
  assert.ok(cache.inspect(root, { hardwareFamily: 'RTX40' }).missing.includes(PAYLOAD_FILES.config));
  fs.writeFileSync(config, originalConfig);
  assert.equal(cache.inspect(root, { hardwareFamily: 'RTX40' }).missing.includes(PAYLOAD_FILES.config), false, 'a newly created missing file invalidates the cache');

  cache.invalidate(root);
  const invalidated = countReads(root, () => cache.inspect(root, { hardwareFamily: 'RTX40' }));
  assert.equal(invalidated.calls.get(addonKey), 1);
});

test('display cache is bounded and does not retain failed inspections', t => {
  const root = fixture(t), cache = createPayloadInspectionCache({ maxEntries: 1 });
  const runtime = path.resolve(root, 'fixed', 'RTX40', PAYLOAD_FILES.runtime).toLowerCase();
  cache.inspect(root, { hardwareFamily: 'RTX40', version: 'one' });
  cache.inspect(root, { hardwareFamily: 'RTX40', version: 'two' });
  const evicted = countReads(root, () => cache.inspect(root, { hardwareFamily: 'RTX40', version: 'one' }));
  assert.equal(evicted.calls.get(runtime), 1);

  const bundle = path.join(root, 'bundle.json'), valid = fs.readFileSync(bundle, 'utf8'); fs.writeFileSync(bundle, '{bad'); cache.invalidate(root);
  assert.throws(() => cache.inspect(root), { code: 'ERR_PAYLOAD_HASH' });
  fs.writeFileSync(bundle, valid); assert.equal(cache.inspect(root, { hardwareFamily: 'RTX40' }).ready, true, 'fixed bundle is inspected instead of replaying an error');
});

test('selected install reads only one full-size runtime and its selected Core', t => {
  const root = fixture(t);
  for (const family of ['RTX40', 'RTX50']) {
    const file = path.join(root, 'fixed', family, PAYLOAD_FILES.runtime);
    const fd = fs.openSync(file, 'w'); fs.ftruncateSync(fd, 165830144); fs.writeSync(fd, Buffer.from(family), 0, family.length, 165830144-family.length); fs.closeSync(fd);
  }
  fs.writeFileSync(path.join(root, 'bundle.json'), JSON.stringify(createCompactBundle(root, [{id:'one'}, {id:'two'}], 'one')));
  const measured = countReads(root, () => requirePayload(root, 'RTX50', 'one'));
  assert.equal(measured.calls.get(path.resolve(root, 'fixed', 'RTX50', PAYLOAD_FILES.runtime).toLowerCase()), 1);
  assert.equal(measured.calls.has(path.resolve(root, 'fixed', 'RTX40', PAYLOAD_FILES.runtime).toLowerCase()), false);
  assert.equal(measured.calls.has(path.resolve(root, 'versions', 'two', PAYLOAD_FILES.addon).toLowerCase()), false);
  assert.ok(measured.bytes < 180 * 1024 * 1024, `selected install read ${measured.bytes} bytes`);
});

test('worker priming leaves the main event loop responsive and populates the identical display snapshot', async t => {
  const root = fixture(t), cache = createPayloadInspectionCache(), options = { allowMissingBundle: true, hardwareFamily: 'RTX40', version: 'two' };
  const expected = inspectPayload(root, options), originalOpen = fs.openSync;
  t.mock.method(fs, 'openSync', function(file, ...args) {
    if (/\.(?:dll|addon64)$/i.test(String(file))) throw new Error('main-thread binary read is forbidden during priming');
    return originalOpen.call(this, file, ...args);
  });
  let timerRan = false; const timer = setTimeout(() => { timerRan = true; }, 0);
  const [first, second] = await Promise.all([cache.prime(root, options), cache.prime(root, options)]); clearTimeout(timer);
  assert.equal(timerRan, true); assert.deepEqual(first, expected); assert.deepEqual(second, expected);
  first.ready = false; assert.equal(cache.inspect(root, options).ready, true);
  assert.equal(Object.keys(second.versions).length, 3, 'background warmup preserves every catalog entry');
});

test('worker cache respects selectedOnly, stat changes, fresh checks and explicit invalidation', async t => {
  const root = fixture(t), cache = createPayloadInspectionCache(), options = { hardwareFamily: 'RTX40', version: 'one' };
  const selected = await cache.prime(root, { ...options, selectedOnly: true }); assert.deepEqual(Object.keys(selected.versions), ['one']);
  const full = await cache.prime(root, options); assert.equal(Object.keys(full.versions).length, 3);
  const runtime = path.resolve(root, 'fixed', 'RTX40', PAYLOAD_FILES.runtime).toLowerCase();
  const fresh = countReads(root, () => cache.inspect(root, { ...options, fresh: true })); assert.equal(fresh.calls.get(runtime), 1);
  const addon = path.join(root, 'versions', 'one', PAYLOAD_FILES.addon); fs.appendFileSync(addon, 'tampered');
  assert.equal((await cache.prime(root, options)).ready, false); assert.throws(() => requirePayload(root, 'RTX40', 'one'), { code: 'ERR_PAYLOAD_HASH' });
  fs.writeFileSync(addon, 'one-addon'); await cache.prime(root, options); cache.invalidate(root);
  assert.equal(countReads(root, () => cache.inspect(root, options)).calls.get(runtime), 1);
});

test('an invalidated in-flight worker cannot repopulate the display cache', async t => {
  const root = fixture(t), cache = createPayloadInspectionCache(), options = { hardwareFamily: 'RTX40' };
  const pending = cache.prime(root, options); cache.invalidate(root); await pending;
  const measured = countReads(root, () => cache.inspect(root, options)); assert.ok(measured.bytes > 0);
});

test('a failed worker inspection does not poison retries after the source is repaired', async t => {
  const root = fixture(t), cache = createPayloadInspectionCache(), bundle = path.join(root, 'bundle.json'), saved = fs.readFileSync(bundle);
  fs.writeFileSync(bundle, '{invalid'); await assert.rejects(cache.prime(root), { code: 'ERR_PAYLOAD_HASH' });
  fs.writeFileSync(bundle, saved); assert.equal((await cache.prime(root, { hardwareFamily: 'RTX40' })).ready, true);
});
