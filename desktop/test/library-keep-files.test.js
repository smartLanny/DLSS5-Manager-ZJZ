'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { createExperienceFixture } = require('./helpers/manager-experience-fixture.cjs');
const { createLaunchCoordinator } = require('../src/product/launch-coordinator');
const { createDeferredOperations } = require('../src/product/deferred-operations');
const { createWorkScheduler } = require('../src/product/work-scheduler');
function tree(dir, base = dir) {
  return Object.fromEntries(fs.readdirSync(dir, { withFileTypes: true }).flatMap(row => {
    const file = path.join(dir, row.name);
    return row.isDirectory() ? Object.entries(tree(file, base)) : [[path.relative(base, file), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]];
  }).sort(([a], [b]) => a.localeCompare(b)));
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-library-keep-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const f = await createExperienceFixture(root); await f.add();
  const id = (await f.service.listGames())[0].id;
  await f.service.setGameApiPreference(id, 'dx12'); await f.service.importRuntimeDlc(f.dlc);
  await f.service.install(id, { version: '0.4.7beta' });
  return { ...f, id, userData: path.join(root, 'user-data') };
}
test('confirmed library removal preserves modified managed files, pending WAL, external data and re-add recovery', async t => {
  const f = await fixture(t), ini = path.join(path.dirname(f.exe), 'ReShade.ini');
  fs.appendFileSync(ini, '\n[STYLE]\nFont=User changed after install\n');
  fs.writeFileSync(path.join(path.dirname(f.exe), 'dxgi.dll'), 'user replaced loader');
  const pending = path.join(f.gameDir, '_DLSS5_Backup', 'pending-switch.json');
  fs.writeFileSync(pending, '{"interrupted":"original bytes must remain"}');
  const external = path.join(f.userData, 'external-runtime', 'orphaned-owned-runtime');
  fs.mkdirSync(external, { recursive: true }); fs.writeFileSync(path.join(external, 'ReShade.ini'), 'external originals');
  const before = tree(f.gameDir), externalBefore = tree(external);
  await assert.rejects(f.service.dismissGame(f.id, { libraryOnly: true }), { code: 'LIBRARY_RESTORE_FIRST' });
  await assert.rejects(f.service.dismissGame(f.id, { keepFiles: true }), { code: 'LIBRARY_CONFIRM_REQUIRED' });
  assert.deepEqual(tree(f.gameDir), before); assert.equal((await f.service.listGames()).length, 1);
  const result = await f.service.dismissGame(f.id, { keepFiles: true, confirm: true });
  assert.equal(result.removedFromLibrary, true); assert.equal(result.filesKept, true); assert.equal(result.restored, false);
  assert.equal((await f.service.listGames()).length, 0); assert.deepEqual(tree(f.gameDir), before); assert.deepEqual(tree(external), externalBefore);
  const archive = JSON.parse(fs.readFileSync(result.archiveFile));
  assert.equal(archive.game.id, f.id); assert.equal(archive.game.executable, f.exe);
  assert.equal(archive.gameOverrides[f.gameDir.toLowerCase()].api, 'dx12');
  assert.ok(archive.recovery.recoveryFiles.some(row => row.file === pending && row.sha256));
  await f.service.addManualSelection({ root: f.gameDir, executable: f.exe });
  const again = (await f.service.listGames())[0]; assert.equal(again.id, f.id); assert.equal(again.apiOverride, 'dx12');
  assert.deepEqual(tree(f.gameDir), before); assert.equal((await f.service.inspectDeployment(f.id)).needsRecovery, true);
});
test('missing EXE and owned settings cannot block explicitly confirmed metadata removal', async t => {
  const f = await fixture(t); fs.unlinkSync(f.exe); const before = tree(f.gameDir);
  const forbidden = async () => { throw new Error('recovery guard must not run'); };
  const coordinator = createLaunchCoordinator({ service: f.service, settings: { assertReady: forbidden, hasOwnedState: forbidden },
    legacySrModel: { migrationInfo: forbidden }, guards: { assertGameClosed: forbidden } });
  await assert.rejects(coordinator.removeLibraryEntry(f.id, { keepFiles: true }), { code: 'LIBRARY_CONFIRM_REQUIRED' });
  const result = await coordinator.removeLibraryEntry(f.id, { keepFiles: true, confirm: true });
  assert.equal(result.filesKept, true); assert.deepEqual(tree(f.gameDir), before); assert.equal((await f.service.listGames()).length, 0);
});
test('cancelling inside the directory queue preserves the waiting record and prevents a captured tick from applying after removal', async t => {
  const f = await fixture(t), scheduler = createWorkScheduler(); let running = true, applications = 0;
  const queue = createDeferredOperations({ userData: f.userData, service: f.service, run: scheduler.run,
    assertClosed: async () => { if (running) throw Object.assign(new Error('running'), { code: 'errGameRunning' }); },
    operations: { preview: async () => ({ blockers: [], fingerprint: 'fixture' }), apply: async () => { applications++; } } });
  await queue.submit(f.id, { nr: { Intensity: 1.2 } });
  const dir = path.join(f.userData, 'waiting-operations'), record = path.join(dir, fs.readdirSync(dir)[0]), bytes = fs.readFileSync(record);
  const before = tree(f.gameDir); let cancelled, release, entered;
  const paused = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const removing = scheduler.run(f.gameDir, async () => { entered(); await paused; cancelled = await queue.cancelWithinQueue(f.id);
    await f.service.dismissGame(f.id, { keepFiles: true, confirm: true, waitingArchive: cancelled }); });
  await started; running = false;
  const capturedTick = queue.tick(); await new Promise(resolve => setTimeout(resolve, 20)); release();
  await Promise.all([removing, capturedTick]);
  assert.deepEqual(fs.readFileSync(cancelled.archiveFile), bytes); assert.equal(fs.existsSync(record), false);
  running = false; await queue.tick(); assert.equal(applications, 0); assert.deepEqual(tree(f.gameDir), before);
  await f.add(); await queue.tick(); assert.equal(applications, 0); assert.equal(await queue.inspect(f.id), null);
});

test('a missing selected EXE and damaged waiting record can still be archived without erasing recovery evidence', async t => {
  const f = await fixture(t), scheduler = createWorkScheduler();
  const queue = createDeferredOperations({ userData: f.userData, service: f.service, run: scheduler.run, assertClosed: async () => {}, operations: {} });
  const key = crypto.createHash('sha256').update(JSON.stringify(path.resolve(f.gameDir).toLowerCase())).digest('hex');
  const record = path.join(f.userData, 'waiting-operations', key + '.json');
  fs.mkdirSync(path.dirname(record), { recursive: true }); fs.writeFileSync(record, '{interrupted invalid JSON');
  const gameExecutable = f.service.gameExecutable; f.service.gameExecutable = () => null;
  const before = tree(f.gameDir), cancelled = await scheduler.run(f.gameDir, () => queue.cancelWithinQueue(f.id));
  assert.equal(fs.readFileSync(cancelled.archiveFile, 'utf8'), '{interrupted invalid JSON');
  assert.equal(fs.existsSync(record), false); assert.deepEqual(tree(f.gameDir), before);
  f.service.gameExecutable = gameExecutable; await queue.tick(); assert.equal(await queue.inspect(f.id), null);
});

test('failure to save the manager archive never hides the library row or changes game files', async t => {
  const f = await fixture(t), before = tree(f.gameDir), settings = f.service.store.read();
  fs.writeFileSync(path.join(f.userData, 'library-archives'), 'occupied archive destination');
  await assert.rejects(f.service.dismissGame(f.id, { keepFiles: true, confirm: true }));
  assert.equal((await f.service.listGames()).some(game => game.id === f.id), true);
  assert.deepEqual(f.service.store.read(), settings); assert.deepEqual(tree(f.gameDir), before);
});
