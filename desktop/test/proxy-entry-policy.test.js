'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { proxyEntryDefault } = require('../src/product/proxy-entry-policy');
const { createExperienceFixture } = require('./helpers/manager-experience-fixture.cjs');
const { readManifest } = require('../src/product/manifest');
const { sha256 } = require('../src/product/payload');
const confirm = plan => ({ confirm: true, fingerprint: plan.fingerprint });

test('proxy defaults bind the selected executable, preserve explicit and installed choices, and respect API/backend', () => {
  const input = { game: { scan: { chosen: { path: 'C:/game/HTGame.exe' } } }, api: 'dx12' };
  assert.equal(proxyEntryDefault(input), 'd3d12');
  assert.equal(proxyEntryDefault({ ...input, api: 'dx11' }), 'auto');
  assert.equal(proxyEntryDefault({ ...input, request: { proxyEntry: 'dxgi' } }), 'dxgi');
  assert.equal(proxyEntryDefault({ ...input, manifest: {} }), 'dxgi');
  assert.equal(proxyEntryDefault({ ...input, api: 'dx11', manifest: { reshadeRoute: 'd3d12' } }), 'dxgi');
  assert.equal(proxyEntryDefault({ ...input, request: { loadingBackend: 'hoyoshade' } }), 'auto');
  assert.equal(proxyEntryDefault({ ...input, layout: { mode: 'external', proxyPaths: ['C:/game/dxgi.dll'] } }), 'dxgi');
  assert.equal(proxyEntryDefault({ ...input, layout: { mode: 'external', proxyPaths: ['C:/game/d3d12.dll'] } }), 'd3d12');
  assert.equal(proxyEntryDefault({ ...input, layout: { mode: 'external', loadingMode: 'helper' } }), 'auto');
  assert.equal(proxyEntryDefault({ ...input, layout: { source: 'feeder', recipe: { proxyEntry: 'd3d12' } } }), 'd3d12');
  assert.equal(proxyEntryDefault({ ...input, game: { name: '异环', scan: { chosen: { path: 'C:/game/Game.exe' } } } }), 'auto');
});

async function fixture(t, executableName = 'HTGame.exe') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-proxy-entry-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const f = await createExperienceFixture(root, { executableName });
  await f.service.boot(); await f.add();
  const id = (await f.service.listGames())[0].id;
  await f.service.setGameApiPreference(id, 'dx12'); await f.service.importRuntimeDlc(f.dlc);
  return { ...f, id, exeDir: path.dirname(f.exe) };
}
for (const deployment of ['local', 'external']) test(`NTE ${deployment} applies D3D12 by default, preserves it across Core updates, and can switch back`, async t => {
  const f = await fixture(t), proxy = path.join(f.exeDir, 'd3d12.dll'), dxgi = path.join(f.exeDir, 'dxgi.dll');
  assert.equal(f.service.installationDefaults(f.id).proxyEntry, 'd3d12');
  const first = await f.operations.preview(f.id, { version: '0.4.7beta', deployment });
  assert.deepEqual(first.blockers, []); assert.equal(first.request.proxyEntry, 'd3d12');
  assert.equal(fs.existsSync(proxy), false, 'preview does not deploy');
  await f.operations.apply(first.planId, confirm(first));
  assert.equal(fs.existsSync(proxy), true); assert.equal(fs.existsSync(dxgi), false);
  assert.equal(f.service.installationDefaults(f.id).proxyEntry, 'd3d12');
  const loaderHash = sha256(proxy), ini = (await f.service.readNrSettings(f.id)).file;
  const config = fs.readFileSync(ini);
  const update = await f.operations.preview(f.id, { version: '0.4.2' });
  assert.deepEqual(update.blockers, []); await f.operations.apply(update.planId, confirm(update));
  assert.equal(sha256(proxy), loaderHash); assert.deepEqual(fs.readFileSync(ini), config);
  const back = await f.operations.preview(f.id, { proxyEntry: 'dxgi' });
  assert.deepEqual(back.blockers, []); await f.operations.apply(back.planId, confirm(back));
  assert.equal(fs.existsSync(proxy), false); assert.equal(sha256(dxgi), loaderHash);
  const again = await f.operations.preview(f.id, { version: '0.4.7beta' });
  assert.deepEqual(again.blockers, []); await f.operations.apply(again.planId, confirm(again));
  assert.equal(fs.existsSync(proxy), false, 'later updates preserve the explicit DXGI selection');
  assert.equal(sha256(dxgi), loaderHash);
  await f.service.uninstall(f.id, { mode: 'restore', removeSettings: false });
  assert.equal(fs.existsSync(dxgi), false); assert.equal(fs.existsSync(proxy), false);
});

test('ordinary DX12 switch checks an occupied target before any writes and retains Core/settings', async t => {
  const f = await fixture(t, 'Game.exe');
  const first = await f.operations.preview(f.id, { version: '0.4.7beta' });
  await f.operations.apply(first.planId, confirm(first));
  const target = path.join(f.exeDir, 'd3d12.dll'), original = Buffer.from('unrelated user proxy'); fs.writeFileSync(target, original);
  const coreBefore = readManifest(f.gameDir), ini = (await f.service.readNrSettings(f.id)).file, config = fs.readFileSync(ini);
  const blocked = await f.operations.preview(f.id, { proxyEntry: 'd3d12' });
  assert.match(blocked.blockers.join(' '), /d3d12.dll.*占用/);
  await assert.rejects(f.operations.apply(blocked.planId, confirm(blocked)), { code: 'OPERATION_BLOCKED' });
  assert.deepEqual(fs.readFileSync(target), original); assert.deepEqual(readManifest(f.gameDir), coreBefore);
  assert.deepEqual(fs.readFileSync(ini), config); assert.equal((await f.operations.inspect(f.id)).pending, false);
  fs.unlinkSync(target);
  const apply = await f.operations.preview(f.id, { proxyEntry: 'd3d12' });
  await f.operations.apply(apply.planId, confirm(apply));
  assert.equal(fs.existsSync(target), true); assert.equal(fs.existsSync(path.join(f.exeDir, 'dxgi.dll')), false);
  assert.deepEqual(fs.readFileSync(ini), config);
});

for (const deployment of ['local', 'external']) test(`changing ${deployment} D3D12 to DX11 stages a DXGI entry with the supported carrier`, async t => {
  const f = await require('./helpers/operation-integration-fixture').fixture(t);
  await f.apply({ api: 'dx12', version: 'fixture-core-1', deployment, proxyEntry: 'd3d12' });
  const plan = await f.plans.preview(f.id, { api: 'dx11' });
  assert.equal(plan.request.proxyEntry, 'dxgi'); assert.deepEqual(plan.blockers, []);
  await f.plans.apply(plan.planId, confirm(plan));
  assert.equal(fs.existsSync(path.join(f.exeDir, 'dxgi.dll')), true);
  assert.equal(fs.existsSync(path.join(f.exeDir, 'd3d12.dll')), false);
  assert.equal(f.service.installationDefaults(f.id).proxyEntry, 'dxgi');
});
