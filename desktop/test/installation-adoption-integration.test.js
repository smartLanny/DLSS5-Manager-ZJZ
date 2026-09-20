'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { fixture, peBytes, put, hashFile, INSTALLED_NAMES, PAYLOAD_FILES } = require('./helpers/operation-integration-fixture');
const { createDeferredOperations } = require('../src/product/deferred-operations');
const { createWorkScheduler } = require('../src/product/work-scheduler');
const { readManifest } = require('../src/product/manifest');
const request = { api: 'dx12', version: 'fixture-core-2', deployment: 'local' };
const consent = plan => ({ confirm: true, fingerprint: plan.fingerprint });
function inspectHost(dir) {
  const name = ['dxgi.dll', 'd3d12.dll'].find(name => fs.existsSync(path.join(dir, name)) && fs.readFileSync(path.join(dir, name)).includes('ReShade'));
  return name ? { installed: true, file: name, addonSupport: fs.readFileSync(path.join(dir, name)).includes('Searching for add-ons') } : { installed: false };
}
async function setup(t, host = 'ReShade ordinary build', options = {}) {
  const f = await fixture(t, { ...options, serviceOverrides: { inspectReShade: inspectHost, ...options.serviceOverrides } });
  if (host) put(path.join(f.exeDir, 'dxgi.dll'), peBytes(host));
  put(path.join(f.exeDir, INSTALLED_NAMES.bridge), peBytes('old chain'));
  put(path.join(f.exeDir, INSTALLED_NAMES.config), '[NRBeforeSR]\r\nEnabled=1\r\nIntensity=0.87654321\r\n; personal setting\r\n');
  put(path.join(f.exeDir, 'ReShade.ini'), '[ADDON]\r\nAddonPath=.\r\n[STYLE]\r\nFont=Personal\r\n');
  const scheduler = createWorkScheduler(); let running = false;
  const queue = createDeferredOperations({ userData: f.userData, service: f.service, operations: f.plans,
    run: scheduler.run, assertClosed: async () => { if (running) throw Object.assign(new Error('synthetic running'), { code: 'errGameRunning' }); } });
  const originals = new Map(fs.readdirSync(f.exeDir).map(name => [name, fs.readFileSync(path.join(f.exeDir, name))]));
  return { ...f, queue, originals, running: value => { running = value; } };
}
function unchanged(f) { for (const [name, bytes] of f.originals) assert.deepEqual(fs.readFileSync(path.join(f.exeDir, name)), bytes, name); }

test('ordinary ReShade adoption requires confirmation, preserves INI, backs up originals and restores them', async t => {
  const f = await setup(t), result = await f.queue.submit(f.id, request);
  assert.equal(result.needsAttention, true); assert.equal(result.plan.adoption.hostState, 'reshade-standard');
  assert.equal(result.plan.requiresAdoptionConfirmation, true); assert.equal(readManifest(f.gameRoot), null); unchanged(f);
  await assert.rejects(f.service.install(f.id, { version: 'fixture-core-2' }), { code: 'ADOPTION_CONFIRM_REQUIRED' });
  assert.equal(await f.queue.inspect(f.id), null, 'closing this proposal has no queued operation');
  const ini = result.plan.changes.find(row => row.role === 'config'); assert.equal(ini.action, 'keep');
  assert.equal(result.plan.changes.find(row => row.role === 'reshade').action, 'replace');
  await f.queue.apply(f.id, result.plan.planId, consent(result.plan));
  assert.ok(fs.readFileSync(path.join(f.exeDir, 'dxgi.dll')).includes('Searching for add-ons'));
  assert.deepEqual(fs.readFileSync(path.join(f.exeDir, INSTALLED_NAMES.config)), f.originals.get(INSTALLED_NAMES.config));
  const remove = await f.plans.preview(f.id, { uninstall: 'restore' }); await f.plans.apply(remove.planId, consent(remove));
  unchanged(f);
});

test('unknown proxy needs a path/hash/config-bound choice and a second explicit confirmation', async t => {
  const f = await setup(t, 'unidentified user loader'), first = await f.queue.submit(f.id, request);
  assert.equal(first.plan.adoption.hostState, 'unknown-proxy'); assert.ok(first.plan.blockers.length); unchanged(f);
  const host = first.plan.adoption.hosts[0], adoption = { replaceProxy: { path: host.path, sha256: host.sha256, configFingerprint: first.plan.adoption.configFingerprint } };
  const selected = await f.queue.submit(f.id, { ...request, adoption });
  assert.equal(selected.needsAttention, true); assert.deepEqual(selected.plan.blockers, []); unchanged(f);
  put(path.join(f.exeDir, 'ReShade.ini'), '[ADDON]\nAddonPath=.\n; changed after preview');
  await assert.rejects(f.queue.apply(f.id, selected.plan.planId, consent(selected.plan)), /改变/);
  assert.equal(readManifest(f.gameRoot), null); assert.deepEqual(fs.readFileSync(host.path), f.originals.get('dxgi.dll'));
});

test('a plain ReShade at the existing D3D12 entry is replaced and restored at its original path', async t => {
  const f = await setup(t), old = path.join(f.exeDir, 'd3d12.dll');
  fs.renameSync(path.join(f.exeDir, 'dxgi.dll'), old);
  const original = f.originals.get('dxgi.dll'); f.originals.delete('dxgi.dll'); f.originals.set('d3d12.dll', original);
  const result = await f.queue.submit(f.id, request);
  assert.equal(result.plan.adoption.replaceProxy.name, 'd3d12.dll');
  await f.queue.apply(f.id, result.plan.planId, consent(result.plan)); assert.equal(fs.existsSync(path.join(f.exeDir, 'dxgi.dll')), false);
  const remove = await f.plans.preview(f.id, { uninstall: 'restore' }); await f.plans.apply(remove.planId, consent(remove));
  unchanged(f); assert.equal(fs.existsSync(path.join(f.exeDir, 'dxgi.dll')), false);
});

test('missing Core and missing host can be adopted without treating a leftover chain as an installed version', async t => {
  const f = await setup(t, null), result = await f.queue.submit(f.id, request);
  assert.equal(result.needsAttention, true); assert.equal(result.plan.adoption.hostState, 'missing');
  assert.deepEqual(result.plan.blockers, []); await f.queue.apply(f.id, result.plan.planId, consent(result.plan));
  assert.ok(readManifest(f.gameRoot)); assert.ok(fs.existsSync(path.join(f.exeDir, INSTALLED_NAMES.addon)));
});

test('compatible existing host and renamed known Core share the existing retirement and restore transaction', async t => {
  const f = await setup(t, 'ReShade Searching for add-ons'), old = path.join(f.exeDir, 'user-renamed-old.addon64');
  fs.copyFileSync(path.join(f.payload, 'versions/fixture-core-1', PAYLOAD_FILES.addon), old);
  const oldHash = hashFile(old), result = await f.queue.submit(f.id, request);
  assert.equal(result.plan.adoption.hostState, 'addon-compatible'); assert.equal(result.plan.adoption.replaceProxy, null);
  assert.ok(result.plan.deployment.addonCompatibility.retire.some(row => row.path === old));
  await f.queue.apply(f.id, result.plan.planId, consent(result.plan)); assert.equal(fs.existsSync(old), false);
  const remove = await f.plans.preview(f.id, { uninstall: 'restore' }); await f.plans.apply(remove.planId, consent(remove));
  assert.equal(hashFile(old), oldHash); unchanged(f);
});

test('multiple host candidates return concrete blockers without choosing or changing either file', async t => {
  const f = await setup(t); put(path.join(f.exeDir, 'd3d12.dll'), peBytes('ReShade Searching for add-ons'));
  const result = await f.queue.submit(f.id, request); assert.equal(result.plan.adoption.hostState, 'multiple');
  assert.ok(result.plan.adoption.blockers.some(row => row.code === 'ADOPTION_MULTIPLE_PROXIES')); unchanged(f);
});

test('running adoption cannot enter the queue before confirmation and applies once after exit without launching', async t => {
  const f = await setup(t); f.running(true);
  const result = await f.queue.submit(f.id, request);
  assert.equal(result.needsAttention, true); assert.equal(result.plan.waitingConfirmation, true);
  assert.equal(await f.queue.inspect(f.id), null); unchanged(f);
  const queued = await f.queue.apply(f.id, result.plan.planId, consent(result.plan)); assert.equal(queued.waiting, true); unchanged(f);
  await assert.rejects(f.queue.assertNoWaiting(f.id), { code: 'WAITING_OPERATION_PENDING' });
  await f.queue.tick(); assert.equal(readManifest(f.gameRoot), null);
  f.running(false); await f.queue.tick(); assert.equal((await f.queue.inspect(f.id)).status, 'complete'); assert.ok(readManifest(f.gameRoot));
  await f.queue.assertNoWaiting(f.id);
  const receipt = fs.readFileSync(path.join(f.gameRoot, '_DLSS5_Backup/xiaofeng-manager.json')); await f.queue.tick();
  assert.deepEqual(fs.readFileSync(path.join(f.gameRoot, '_DLSS5_Backup/xiaofeng-manager.json')), receipt);
});

test('confirmed queued adoption rechecks changed old files instead of silently replacing them', async t => {
  const f = await setup(t); f.running(true); const result = await f.queue.submit(f.id, request);
  await f.queue.apply(f.id, result.plan.planId, consent(result.plan));
  put(path.join(f.exeDir, INSTALLED_NAMES.bridge), peBytes('external replacement chain'));
  f.running(false); await f.queue.tick(); assert.equal((await f.queue.inspect(f.id)).status, 'attention');
  assert.equal(readManifest(f.gameRoot), null); assert.ok(fs.readFileSync(path.join(f.exeDir, INSTALLED_NAMES.bridge)).includes('external replacement'));
});

test('external adoption replaces an explicitly reviewed ordinary host and restores its exact bytes', async t => {
  const f = await setup(t), result = await f.queue.submit(f.id, { ...request, deployment: 'external' });
  assert.equal(result.needsAttention, true); assert.deepEqual(result.plan.blockers, []); unchanged(f);
  await f.queue.apply(f.id, result.plan.planId, consent(result.plan));
  assert.equal(f.layout().mode, 'external');
  const remove = await f.plans.preview(f.id, { uninstall: 'restore' }); await f.plans.apply(remove.planId, consent(remove)); unchanged(f);
});

test('a late native adoption failure restores the replaced host, old chain, configuration and receipt baseline', async t => {
  const f = await setup(t), result = await f.queue.submit(f.id, request), copy = fs.promises.copyFile;
  let injected = false;
  t.mock.method(fs.promises, 'copyFile', async (source, destination, ...args) => {
    if (!injected && destination === path.join(f.exeDir, INSTALLED_NAMES.bridge) && source.startsWith(f.payload)) {
      injected = true; throw Object.assign(new Error('injected late adoption write'), { code: 'EIO' });
    }
    return copy(source, destination, ...args);
  });
  await assert.rejects(f.queue.apply(f.id, result.plan.planId, consent(result.plan)), /injected late adoption write/);
  assert.equal(injected, true); unchanged(f); assert.equal(readManifest(f.gameRoot), null);
  assert.equal(fs.existsSync(path.join(f.exeDir, INSTALLED_NAMES.addon)), false);
});

test('a late external adoption failure rolls back the published proxy and original INI', async t => {
  let injected = false;
  const f = await setup(t, 'ReShade ordinary build', { external: { afterWrite: ({ row }) => {
    if (!injected && row.role === 'reshade-config') { injected = true; throw new Error('injected external adoption write'); }
  } } });
  const result = await f.queue.submit(f.id, { ...request, deployment: 'external' });
  await assert.rejects(f.queue.apply(f.id, result.plan.planId, consent(result.plan)), /injected external adoption write/);
  assert.equal(injected, true); unchanged(f); assert.equal(readManifest(f.gameRoot), null);
});

test('importing a missing runtime never skips unmanaged installation confirmation on resume', async t => {
  const os = require('node:os'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-adoption-dlc-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const f = await require('./helpers/manager-experience-fixture.cjs').createExperienceFixture(root);
  await f.add(); const [game] = await f.service.listGames(); await f.service.setGameApiPreference(game.id, 'dx12');
  const chain = path.join(path.dirname(f.exe), INSTALLED_NAMES.bridge); put(chain, peBytes('old chain without current Core'));
  const original = fs.readFileSync(chain), selected = { api: 'dx12', version: '0.4.7beta', deployment: 'local' };
  await assert.rejects(f.deferred.submit(game.id, selected), error => /PAYLOAD|RUNTIME/.test(error.code));
  await f.service.importRuntimeDlc(f.dlc);
  const resumed = await f.deferred.submit(game.id, selected);
  assert.equal(resumed.needsAttention, true); assert.equal(resumed.plan.requiresAdoptionConfirmation, true);
  assert.equal(readManifest(f.gameDir), null); assert.deepEqual(fs.readFileSync(chain), original);
});
