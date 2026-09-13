'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createGameEnvironment, RECEIPT, PRODUCT } = require('../src/product/game-environment');
const journal = require('../src/core/file-journal');

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-environment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, 'game'), dir = path.join(game, 'Game'), exe = path.join(dir, 'eldenring.exe');
  fs.mkdirSync(dir, { recursive: true });
  const originals = { 'eldenring.exe': 'actual-game-executable', 'dxgi.dll': 'ReShade known loader', 'old-nr.addon64': 'old NR Add-on',
    'version.dll': 'unknown external file', 'd3d12.dll': 'Microsoft Direct3D runtime', 'nvngx_dlss.dll': 'native DLSS', 'regulation.bin': 'game data' };
  for (const [name, body] of Object.entries(originals)) fs.writeFileSync(path.join(dir, name), body);
  fs.mkdirSync(path.join(dir, 'reshade-shaders')); fs.writeFileSync(path.join(dir, 'reshade-shaders', 'user.fx'), 'user shader');
  fs.mkdirSync(path.join(game, 'saves')); fs.writeFileSync(path.join(game, 'saves', 'slot.sl2'), 'save game');
  const controls = { running: false };
  const options = { gameDirectory: () => game, gameExecutable: () => exe,
    guards: { assertGameClosed: async () => { if (controls.running) throw Object.assign(new Error('running'), { code: 'ERR_GAME_RUNNING' }); } },
    pe: { versionMentions: (file, text) => fs.readFileSync(file, 'utf8').includes(text) }, ...overrides };
  return { root, game, dir, exe, controls, originals, options, service: createGameEnvironment(options),
    file: name => path.join(dir, name), receipt: path.join(game, RECEIPT), pending: journal.pendingPath(game) };
}
function expectOriginals(f) { for (const [name, body] of Object.entries(f.originals)) assert.equal(fs.readFileSync(f.file(name), 'utf8'), body, name); }
async function isolate(f, names = ['dxgi.dll', 'old-nr.addon64']) {
  const preview = await f.service.preview('g'); return f.service.apply('g', preview.planId, names);
}
function failDuringCopy({ at = 2, preservePending = false } = {}) {
  let copies = 0;
  return async (source, destination, flags) => {
    if (++copies !== at) return fsp.copyFile(source, destination, flags);
    const bytes = await fsp.readFile(source);
    await fsp.writeFile(destination, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))), { flag: 'wx' });
    throw Object.assign(new Error('interrupted in the middle of a file copy'), { code: 'EIO', preservePending });
  };
}
function expectArchive(f) {
  const receipt = JSON.parse(fs.readFileSync(f.receipt));
  for (const row of receipt.files) assert.equal(fs.readFileSync(path.join(f.game, row.backup), 'utf8'), f.originals[path.basename(row.rel)]);
}

test('cleanup preview is read-only and distinguishes known plugins, unknown DLLs and native runtimes', async t => {
  const f = fixture(t), preview = await f.service.preview('g'); expectOriginals(f);
  assert.equal(fs.existsSync(f.receipt), false); assert.equal(fs.existsSync(f.pending), false);
  const byName = Object.fromEntries(preview.candidates.map(row => [row.name, row]));
  assert.equal(byName['dxgi.dll'].selectedByDefault, true); assert.equal(byName['old-nr.addon64'].selectedByDefault, true);
  assert.equal(byName['version.dll'].selectedByDefault, false); assert.equal(byName['version.dll'].selectable, true);
  assert.equal(byName['d3d12.dll'].selectable, false);
  assert.equal(byName['eldenring.exe'], undefined); assert.equal(byName['nvngx_dlss.dll'], undefined); assert.equal(byName['regulation.bin'], undefined);
});

test('confirmed cleanup isolates only selected files and restores their original bytes after a restart', async t => {
  const f = fixture(t), result = await isolate(f);
  assert.equal(result.cleaned, true); assert.equal(result.cleanGameVerified, false);
  assert.equal(fs.existsSync(f.file('dxgi.dll')), false); assert.equal(fs.existsSync(f.file('old-nr.addon64')), false);
  assert.equal(fs.readFileSync(f.file('version.dll'), 'utf8'), f.originals['version.dll']);
  assert.equal(fs.readFileSync(path.join(f.game, 'saves', 'slot.sl2'), 'utf8'), 'save game');
  assert.equal(fs.readFileSync(path.join(f.dir, 'reshade-shaders', 'user.fx'), 'utf8'), 'user shader');
  assert.equal((await f.service.inspect('g')).canRestore, true);
  const restarted = createGameEnvironment(f.options); const restored = await restarted.restore('g');
  assert.equal(restored.restored, true); expectOriginals(f); assert.equal((await restarted.inspect('g')).canRestore, false);
  assert.equal(fs.existsSync(result.backupDirectory), true, 'undo retains its archive');
});

test('unknown proxy files require an explicit selection and still receive a reversible backup', async t => {
  const f = fixture(t); await isolate(f, ['version.dll']);
  assert.equal(fs.existsSync(f.file('version.dll')), false); assert.equal(fs.existsSync(f.file('dxgi.dll')), true);
  await f.service.restore('g'); expectOriginals(f);
});

test('forged selections cannot clean the game EXE, native DLSS, system runtime or paths outside the game', async t => {
  const f = fixture(t);
  for (const name of ['eldenring.exe', 'nvngx_dlss.dll', 'd3d12.dll', '../outside.dll']) {
    const preview = await f.service.preview('g');
    await assert.rejects(f.service.apply('g', preview.planId, [name]), { code: 'ENVIRONMENT_SELECTION_INVALID' });
    expectOriginals(f); assert.equal(fs.existsSync(f.receipt), false);
  }
});

test('a changed EXE or proxy invalidates confirmation without replacing current files', async t => {
  for (const name of ['eldenring.exe', 'dxgi.dll']) {
    const f = fixture(t), preview = await f.service.preview('g'); fs.writeFileSync(f.file(name), 'external replacement');
    await assert.rejects(f.service.apply('g', preview.planId, ['dxgi.dll']), { code: 'ENVIRONMENT_FILE_CHANGED' });
    assert.equal(fs.readFileSync(f.file(name), 'utf8'), 'external replacement'); assert.equal(fs.existsSync(f.receipt), false);
  }
});

test('running games block preview, cleanup and restoration', async t => {
  const f = fixture(t); f.controls.running = true;
  await assert.rejects(f.service.preview('g'), { code: 'ERR_GAME_RUNNING' });
  f.controls.running = false; const preview = await f.service.preview('g'); f.controls.running = true;
  await assert.rejects(f.service.apply('g', preview.planId, ['dxgi.dll']), { code: 'ERR_GAME_RUNNING' });
  f.controls.running = false; await isolate(f); f.controls.running = true;
  await assert.rejects(f.service.restore('g'), { code: 'ERR_GAME_RUNNING' }); assert.equal(fs.existsSync(f.file('dxgi.dll')), false);
});

test('restoration never overwrites a component installed after cleanup', async t => {
  const f = fixture(t); await isolate(f); const before = fs.readFileSync(f.receipt);
  fs.writeFileSync(f.file('dxgi.dll'), 'new user proxy');
  await assert.rejects(f.service.restore('g'), { code: 'ENVIRONMENT_FILE_CHANGED' });
  assert.equal(fs.readFileSync(f.file('dxgi.dll'), 'utf8'), 'new user proxy'); assert.deepEqual(fs.readFileSync(f.receipt), before);
  assert.equal((await f.service.inspect('g')).canRestore, true);
});

test('modified backups stop restoration before writing any original target', async t => {
  const f = fixture(t); await isolate(f); const row = JSON.parse(fs.readFileSync(f.receipt));
  fs.writeFileSync(path.join(f.game, row.files[1].backup), 'damaged');
  await assert.rejects(f.service.restore('g'), { code: 'ENVIRONMENT_BACKUP_CHANGED' });
  assert.equal(fs.existsSync(f.file('dxgi.dll')), false); assert.equal(fs.existsSync(f.file('old-nr.addon64')), false);
});

test('an interrupted cleanup before its receipt has a dedicated restart recovery', async t => {
  let copies = 0;
  const f = fixture(t, { copyFile: async (...args) => { await fsp.copyFile(...args); if (++copies === 2) throw Object.assign(new Error('interrupted after backup'), { preservePending: true }); } });
  await assert.rejects(isolate(f), { code: 'errBackendRecovery' });
  assert.equal(fs.existsSync(f.file('dxgi.dll')), false); assert.equal(fs.existsSync(f.receipt), false);
  const wal = JSON.parse(fs.readFileSync(f.pending)); assert.equal(wal.owner.product, PRODUCT);
  const restarted = createGameEnvironment({ ...f.options, copyFile: fsp.copyFile });
  assert.equal((await restarted.inspect('g')).pending, true);
  await assert.rejects(restarted.assertReady('g'), { code: 'ENVIRONMENT_RECOVERY_REQUIRED' });
  assert.equal((await restarted.restore('g')).restored, true); expectOriginals(f); assert.equal(fs.existsSync(f.pending), false);
});

test('external changes during an interrupted cleanup preserve both the file and its WAL', async t => {
  let copies = 0;
  const f = fixture(t, { copyFile: async (...args) => { await fsp.copyFile(...args); if (++copies === 2) throw Object.assign(new Error('interrupted'), { preservePending: true }); } });
  await assert.rejects(isolate(f)); fs.writeFileSync(f.file('dxgi.dll'), 'new external proxy');
  const before = fs.readFileSync(f.pending);
  await assert.rejects(createGameEnvironment(f.options).restore('g'), { code: 'ENVIRONMENT_FILE_CHANGED' });
  assert.equal(fs.readFileSync(f.file('dxgi.dll'), 'utf8'), 'new external proxy'); assert.deepEqual(fs.readFileSync(f.pending), before);
});

test('cleanup recovery rejects an injected target outside its graphics-file allowlist', async t => {
  const f = fixture(t, { copyFile: async (...args) => { await fsp.copyFile(...args); throw Object.assign(new Error('interrupted'), { preservePending: true }); } });
  await assert.rejects(isolate(f)); const wal = JSON.parse(fs.readFileSync(f.pending));
  wal.owner.checks.push({ rel: 'Game/eldenring.exe', before: null, after: [null] }); fs.writeFileSync(f.pending, JSON.stringify(wal));
  await assert.rejects(f.service.restore('g'), { code: 'ENVIRONMENT_RECOVERY_INVALID' });
  assert.equal(fs.readFileSync(f.exe, 'utf8'), f.originals['eldenring.exe']); assert.equal(fs.existsSync(f.pending), true);
});

test('another component WAL is never recovered by the environment-cleanup owner', async t => {
  const f = fixture(t); fs.mkdirSync(path.dirname(f.pending), { recursive: true });
  const bytes = JSON.stringify({ version: 1, owner: { product: 'another-component' }, files: [] }); fs.writeFileSync(f.pending, bytes);
  await assert.rejects(f.service.preview('g'), { code: 'ENVIRONMENT_OTHER_RECOVERY' });
  assert.equal((await f.service.recoverPending('g')).recovered, false); assert.equal(fs.readFileSync(f.pending, 'utf8'), bytes);
});

test('interrupted undo can resume after restart without losing the isolation archive', async t => {
  const f = fixture(t); const result = await isolate(f);
  let copies = 0;
  const interrupted = createGameEnvironment({ ...f.options, copyFile: async (...args) => {
    await fsp.copyFile(...args); if (++copies === 1) throw Object.assign(new Error('interrupted undo'), { preservePending: true });
  } });
  await assert.rejects(interrupted.restore('g'));
  assert.equal((await interrupted.inspect('g')).pending, true);
  await createGameEnvironment(f.options).restore('g'); expectOriginals(f);
  assert.equal(fs.existsSync(result.backupDirectory), true); assert.equal(fs.existsSync(f.pending), false);
});

for (const preservePending of [false, true]) {
  const interruption = preservePending ? 'a process exit' : 'a copy error';
  test(`cleanup interrupted halfway through a copy by ${interruption} remains recoverable`, async t => {
    const f = fixture(t, { copyFile: failDuringCopy({ preservePending }) });
    await assert.rejects(isolate(f));
    assert.equal(fs.existsSync(f.pending), preservePending);
    const restarted = createGameEnvironment({ ...f.options, copyFile: fsp.copyFile });
    if (preservePending) {
      assert.equal(fs.existsSync(f.file('dxgi.dll')), false, 'the earlier isolation really committed before interruption');
      assert.equal((await restarted.inspect('g')).canRestore, true);
      await assert.rejects(restarted.assertReady('g'), { code: 'ENVIRONMENT_RECOVERY_REQUIRED' });
      assert.equal((await restarted.restore('g')).restored, true);
    }
    expectOriginals(f);
    assert.equal(fs.existsSync(f.pending), false);
    assert.equal((await restarted.inspect('g')).canRestore, false);
    await restarted.assertReady('g');
  });

  test(`undo interrupted halfway through a copy by ${interruption} preserves its archive and can finish`, async t => {
    const f = fixture(t), result = await isolate(f);
    const interrupted = createGameEnvironment({ ...f.options, copyFile: failDuringCopy({ preservePending }) });
    await assert.rejects(interrupted.restore('g'));
    assert.equal(fs.existsSync(f.pending), preservePending);
    assert.equal(fs.existsSync(f.file('old-nr.addon64')), false, 'a partial copy must not appear as an active Add-on');
    if (!preservePending) assert.equal(fs.existsSync(f.file('dxgi.dll')), false, 'automatic rollback returns to the isolated state');
    expectArchive(f);
    const restarted = createGameEnvironment(f.options);
    assert.equal((await restarted.inspect('g')).canRestore, true);
    assert.equal((await restarted.restore('g')).restored, true);
    expectOriginals(f); expectArchive(f);
    assert.equal(fs.existsSync(result.backupDirectory), true);
    assert.equal(fs.existsSync(f.pending), false);
    assert.equal((await restarted.inspect('g')).canRestore, false);
  });
}

test('recovery interrupted halfway through a rollback copy remains retryable after another restart', async t => {
  const f = fixture(t, { copyFile: failDuringCopy({ preservePending: true }) });
  await assert.rejects(isolate(f));
  assert.equal(fs.existsSync(f.file('dxgi.dll')), false);
  const interruptedRecovery = createGameEnvironment({ ...f.options, copyFile: failDuringCopy({ at: 1, preservePending: true }) });
  await assert.rejects(interruptedRecovery.recoverPending('g'));
  assert.equal(fs.existsSync(f.pending), true);
  assert.equal((await interruptedRecovery.inspect('g')).canRestore, true);
  for (const name of ['dxgi.dll', 'old-nr.addon64']) {
    if (fs.existsSync(f.file(name))) assert.equal(fs.readFileSync(f.file(name), 'utf8'), f.originals[name], 'rollback never publishes a partial file');
  }
  const restarted = createGameEnvironment({ ...f.options, copyFile: fsp.copyFile });
  assert.equal((await restarted.recoverPending('g')).recovered, true);
  expectOriginals(f);
  assert.equal(fs.existsSync(f.pending), false);
  assert.equal((await restarted.inspect('g')).canRestore, false);
  await restarted.assertReady('g');
});

test('a failed final pending-file deletion restores original files through atomic owner rollback', async t => {
  const copies = [];
  const f = fixture(t, { copyFile: async (source, destination, flags) => {
    copies.push({ source, destination });
    return fsp.copyFile(source, destination, flags);
  } });
  const unlink = fsp.unlink;
  let injected = false;
  fsp.unlink = async file => {
    if (!injected && path.resolve(file) === path.resolve(f.pending)) {
      injected = true;
      throw Object.assign(new Error('pending-file deletion denied after successful cleanup'), { code: 'EACCES' });
    }
    return unlink(file);
  };
  try {
    await assert.rejects(isolate(f), { code: 'EACCES' });
  } finally {
    fsp.unlink = unlink;
  }
  assert.equal(injected, true);
  const rollbackCopies = copies.filter(row => row.source.replaceAll('\\', '/').includes('/_DLSS5_Backup/.transactions/'));
  assert.equal(rollbackCopies.length, 2, 'both removed originals must be restored through the environment copy hook');
  for (const row of rollbackCopies) {
    assert.match(path.relative(f.game, row.destination).replaceAll('\\', '/'), /^_DLSS5_Backup\/environment-staging\/[a-f0-9-]+\.part$/,
      'rollback must stage complete bytes before publishing the active file');
  }
  expectOriginals(f);
  assert.equal(fs.existsSync(f.pending), false);
  assert.equal(fs.existsSync(f.receipt), false);
  assert.equal((await createGameEnvironment(f.options).inspect('g')).canRestore, false);
});
test('unknown plugins default to isolation, verified HDR stays and confirmed NR cannot be omitted from reversible cleanup', async t => {
  const f = fixture(t), addons = { 'renodx-hdr.addon64': 'DLSS NVNGX references only', 'overlay.addon64': 'ordinary overlay',
    'neutral.addon64': 'RenoDX HDR Color Grading', 'renodx-generic.addon64': 'RenoDX Generic NR', 'MFGUnlock.addon64': 'MFG Unlock',
    'personal.addon64': 'ordinary unknown addon', 'nr-before-sr-hdr.addon64': 'RenoDX HDR' };
  for (const [name, contents] of Object.entries(addons)) fs.writeFileSync(f.file(name), contents);
  f.options.knownComponents = () => [{ path: f.file('neutral.addon64'),
    sha256: require('node:crypto').createHash('sha256').update(addons['neutral.addon64']).digest('hex'), role: 'renodx-hdr', compatibility: 'compatible' }];
  const preview = await f.service.preview('g'), rows = Object.fromEntries(preview.candidates.map(row => [row.name, row]));
  for (const name of Object.keys(addons)) { assert.equal(rows[name].selectedByDefault, name !== 'neutral.addon64', name); assert.equal(rows[name].selectable, true, name); }
  assert.equal(rows['renodx-hdr.addon64'].source, 'filename'); assert.equal(rows['renodx-hdr.addon64'].confidence, 'hint');
  assert.equal(rows['neutral.addon64'].source, 'content-declaration'); assert.equal(rows['old-nr.addon64'].selectedByDefault, true);
  assert.equal(rows['renodx-generic.addon64'].mandatory, true);
  await assert.rejects(f.service.apply('g', preview.planId, ['renodx-hdr.addon64']), { code: 'ENVIRONMENT_CONFLICT_REQUIRED' });
  const confirmed = await f.service.preview('g');
  await f.service.apply('g', confirmed.planId, ['renodx-hdr.addon64', 'renodx-generic.addon64']); assert.equal(fs.existsSync(f.file('renodx-hdr.addon64')), false);
  for (const name of Object.keys(addons).filter(name => !['renodx-hdr.addon64', 'renodx-generic.addon64'].includes(name))) assert.equal(fs.readFileSync(f.file(name), 'utf8'), addons[name]);
  await f.service.restore('g'); assert.equal(fs.readFileSync(f.file('renodx-hdr.addon64'), 'utf8'), addons['renodx-hdr.addon64']); expectOriginals(f);
});

test('rollback atomically replaces an already existing environment JSON receipt on Windows PowerShell', async t => {
  const f = fixture(t);
  await isolate(f); await f.service.restore('g');
  const originalReceipt = fs.readFileSync(f.receipt);
  const failingJournal = { ...journal, transaction: (gameDir, work, options) =>
    journal.transaction(gameDir, async () => {
      await work();
      throw new Error('fixture failure after publishing the new receipt');
    }, options) };
  const service = createGameEnvironment({ ...f.options, journal: failingJournal });
  const plan = await service.preview('g');
  await assert.rejects(service.apply('g', plan.planId, ['dxgi.dll']), /fixture failure after publishing/);
  expectOriginals(f);
  assert.deepEqual(fs.readFileSync(f.receipt), originalReceipt);
  assert.equal(fs.existsSync(f.pending), false);
});

test('snapshot tampering stops interrupted recovery before changing game files', async t => {
  const f = fixture(t, { copyFile: async (...args) => { await fsp.copyFile(...args); throw Object.assign(new Error('interrupted'), { preservePending: true }); } });
  await assert.rejects(isolate(f)); const wal = JSON.parse(fs.readFileSync(f.pending));
  const snapshot = wal.files.find(row => row.existed);
  // The initial manifest may not exist; create an original record fixture if needed.
  if (snapshot) fs.writeFileSync(path.join(f.game, snapshot.snapshot), 'tampered');
  else { wal.files[0].existed = true; fs.writeFileSync(f.pending, JSON.stringify(wal)); }
  await assert.rejects(f.service.recoverPending('g'), { code: 'ENVIRONMENT_RECOVERY_INVALID' });
  expectOriginals(f); assert.equal(fs.existsSync(f.pending), true);
});

test('another live process owns its interrupted transaction exclusively', async t => {
  const f = fixture(t, { copyFile: async (...args) => { await fsp.copyFile(...args); throw Object.assign(new Error('interrupted'), { preservePending: true }); } });
  await assert.rejects(isolate(f)); const wal = JSON.parse(fs.readFileSync(f.pending)); wal.owner.pid = process.ppid;
  fs.writeFileSync(f.pending, JSON.stringify(wal));
  await assert.rejects(f.service.recoverPending('g'), { code: 'ENVIRONMENT_BUSY' }); expectOriginals(f);
});

test('parallel cleanup submissions are rejected while the first owns the game', async t => {
  let release, started;
  const copied = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { copyFile: async (...args) => { await fsp.copyFile(...args); started(); await new Promise(resolve => { release = resolve; }); } });
  const first = await f.service.preview('g'), second = await f.service.preview('g');
  const operation = f.service.apply('g', first.planId, ['dxgi.dll']); await copied;
  await assert.rejects(f.service.apply('g', second.planId, ['version.dll']), { code: 'ENVIRONMENT_BUSY' });
  release(); await operation; assert.equal(fs.existsSync(f.file('version.dll')), true);
});

test('junction targets are rejected without modifying the external directory', async t => {
  const f = fixture(t), external = path.join(f.root, 'outside'); fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'keep.txt'), 'outside');
  fs.mkdirSync(path.dirname(f.receipt), { recursive: true });
  fs.symlinkSync(external, path.join(f.game, '_DLSS5_Backup', 'environment-cleanup'), 'junction');
  await assert.rejects(isolate(f)); expectOriginals(f);
  assert.equal(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8'), 'outside'); assert.equal(fs.readdirSync(external).length, 1);
});

test('the ordinary pending guard does not require a present selected EXE', async t => {
  const f = fixture(t, { gameExecutable: () => null });
  await f.service.assertReady('g');
  fs.mkdirSync(path.dirname(f.pending), { recursive: true }); fs.writeFileSync(f.pending, JSON.stringify({ owner: { product: PRODUCT } }));
  await assert.rejects(f.service.assertReady('g'), { code: 'ENVIRONMENT_RECOVERY_REQUIRED' });
});
