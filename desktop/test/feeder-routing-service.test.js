'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFeederRoutingService } = require('../src/product/feeder-routing-service');
const oldFile = '_DLSS5_Backup/xiaofeng-feeder.json', newFile = '_DLSS5_Backup/xiaofeng-feeder-v2.json';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feeder-owner-beta3-')); fs.mkdirSync(path.join(root, '_DLSS5_Backup'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const calls = [], game = { id: 'fixture', dir: root, scan: { chosen: { path: path.join(root, 'game.exe'), bitness: 32, apiResolution: { api: 'dx9' } } } };
  const child = name => ({ summary: () => ({ installed: fs.existsSync(path.join(root, name === 'old' ? oldFile : newFile)), available: true }),
    install: async () => { calls.push(name + '-install'); }, restore: async () => { calls.push(name + '-restore'); },
    recover: name === 'new' ? async () => { calls.push('new-recover'); } : undefined });
  let unavailable = false;
  const providerCalls = [], runtime = { load: value => { if (unavailable) throw Object.assign(new Error('pool unavailable'), { code: 'LEGACY_PACKAGE_UNTRUSTED' });
    calls.push(['selection', value]); return { recipe: { id: 'feeder-0151-fixture', coreVersion: '0.4.7beta', gameApi: value.api,
      architecture: value.architecture, loadingBackend: value.loadingBackend, hostRequired: value.architecture === 'x86' } }; },
    externalProviders: { root: path.join(root, 'component-library'), inspect: context => ({ selectedId: null, packages: [], context }),
      select: async (id, context) => { providerCalls.push({ id, context }); return { selectedId: id, changedGames: false, runtimeVerified: false }; } } };
  const service = createFeederRoutingService({ historical: child('old'), modern: child('new'), runtime, hardware: { family: 'RTX40' } });
  return { root, game, calls, providerCalls, service, unavailable: () => { unavailable = true; }, touch: file => fs.writeFileSync(path.join(root, file), '{}') };
}
test('new games select 0.15.1 by actual API, architecture and hardware without falling back to historical resources', async t => {
  const f = fixture(t), status = f.service.summary(f.game);
  assert.equal(status.generation, 'feeder-0151'); assert.equal(status.architecture, 'x86'); assert.equal(status.hostRequired, true);
  assert.deepEqual(f.calls[0][1], { api: 'dx9', architecture: 'x86', hardwareFamily: 'RTX40', loadingBackend: 'local' });
  f.unavailable(); assert.equal(f.service.summary(f.game).available, false); assert.equal(f.service.summary(f.game).reason, 'pool unavailable');
});
test('historical receipt retains its original owner and rejects a new package until restoration', async t => {
  const f = fixture(t); f.touch(oldFile);
  assert.equal(f.service.summary(f.game).generation, 'historical-0131'); await f.service.install(f.game, {});
  assert.deepEqual(f.calls, ['old-install']);
  assert.throws(() => f.service.install(f.game, { version: 'feeder-0151-dx11-x64-rtx40-local' }), { code: 'FEEDER_OWNER_CONFLICT' });
  await f.service.recover(f.game); assert.deepEqual(f.calls, ['old-install', 'old-restore']);
});
test('interrupted historical install without its final receipt still routes to its original recovery owner', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, '_DLSS5_Backup/pending-switch.json'), JSON.stringify({ files: [{ rel: oldFile }] }));
  assert.equal(f.service.generation(f.game), 'historical-0131'); await f.service.recover(f.game);
  assert.deepEqual(f.calls, ['old-restore']);
});
test('mixed ownership blocks writes and a modern receipt remains recoverable without the source pool', async t => {
  const f = fixture(t); f.touch(oldFile); f.touch(newFile);
  assert.equal(f.service.summary(f.game).needsRecovery, true);
  assert.throws(() => f.service.install(f.game, {}), { code: 'FEEDER_OWNER_CONFLICT' }); assert.deepEqual(f.calls, []);
  fs.unlinkSync(path.join(f.root, oldFile)); f.unavailable();
  assert.equal(f.service.summary(f.game).installed, true); assert.equal(f.service.generation(f.game), 'feeder-0151');
  await f.service.recover(f.game); assert.deepEqual(f.calls, ['new-recover']);
});
test('provider inventory selection is global metadata and never takes ownership of an installed game', async t => {
  const f = fixture(t), context = { currentCore: { id: 'core-new' } };
  assert.equal(f.service.providerLibraryRoot, path.join(f.root, 'component-library'));
  assert.equal(f.service.inspectProviders(context).context, context);
  assert.equal((await f.service.selectProvider('provider-new', context)).changedGames, false);
  assert.deepEqual(f.providerCalls, [{ id: 'provider-new', context }]);
  f.touch(oldFile); await f.service.install(f.game, {});
  assert.deepEqual(f.calls, ['old-install']);
});
