'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectReEngine, createReEngineDetection, RE_ENGINE_PROFILES, REFRAMEWORK_REQUIRED_PROFILES,
  RE_ENGINE_DETECTION_LIMITS: LIMITS } = require('../src/product/re-engine-detection');
const { OFFICIAL_REFRAMEWORK_01417: OFFICIAL, REFRAMEWORK_ADAPTERS } = require('../src/product/reframework-compatibility');

function fixture(t, name = 'UnknownGame.exe', architecture = 64) {
  const gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 're-engine-detect-'));
  t.after(() => fs.rmSync(gameDir, { recursive: true, force: true }));
  const exe = path.join(gameDir, name), bytes = Buffer.alloc(512);
  bytes.write('MZ'); bytes.writeUInt32LE(128, 60); bytes.write('PE\0\0', 128);
  bytes.writeUInt16LE(architecture === 64 ? 0x8664 : 0x14c, 132);
  bytes.writeUInt16LE(architecture === 64 ? 0x20b : 0x10b, 152);
  fs.writeFileSync(exe, bytes);
  const put = (rel, data) => { const file = path.join(gameDir, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
  const pak = (name = 're_chunk_000.pak') => { const bytes = Buffer.alloc(16); bytes.write('KPKA'); bytes[4] = 4; bytes.writeInt32LE(1, 8); return put(name, bytes); };
  return { gameDir, exe, put, pak, input: { gameDir, exe } };
}
function startup(gameDir, game = 're9', commit = OFFICIAL.source_commit) {
  return ['REFramework entry', `Commit hash: ${commit}`, `Game name: ${game}`, `Current game path: ${gameDir}`]
    .map(line => `[2026-09-09 12:00:00.000] [REFramework] [info] ${line}`).join('\n') + '\n';
}

test('an unknown executable with a RE asset header is detected independently of publisher or game profiles', t => {
  const f = fixture(t); f.pak();
  const result = detectReEngine(f.input);
  assert.equal(result.id, 're-engine'); assert.equal(result.label, '卡普空 RE 引擎');
  assert.equal(result.compatibilityKnown, false); assert.equal(result.profile, null);
  assert.deepEqual(result.evidence.map(row => row.kind), ['re-pak-header']);
});

test('publisher, game title, Steam identity, familiar EXE and mod directory names alone do not identify the engine', t => {
  const f = fixture(t, 're9.exe');
  f.put('dinput8.dll', 'unverified loader'); f.put('re2_framework_log.txt', 'REFramework RE Engine');
  fs.mkdirSync(path.join(f.gameDir, 'reframework')); fs.mkdirSync(path.join(f.gameDir, '_storage_'));
  const metadata = { companyName: 'CAPCOM CO., LTD.', productName: 'Resident Evil Requiem', steamAppId: '3764200' };
  assert.equal(detectReEngine({ ...f.input, metadata }), null);
  f.put('re_chunk_000.pak', 'not a RE package');
  assert.equal(detectReEngine({ ...f.input, metadata }), null);
});

test('explicit bounded engine metadata needs the paired natives platform directory', t => {
  const f = fixture(t);
  assert.equal(detectReEngine({ ...f.input, metadata: { engine: 'RE Engine' } }), null);
  fs.mkdirSync(path.join(f.gameDir, 'natives', 'STM'), { recursive: true });
  for (const value of ['CAPCOM', 'Unreal Engine', 'PreEngine', 'REFramework', 'x'.repeat(513) + ' RE Engine']) {
    assert.equal(detectReEngine({ ...f.input, metadata: { engine: value } }), null, value.slice(0, 30));
  }
  const result = detectReEngine({ ...f.input, metadata: { fileDescription: 'Built with RE Engine' } });
  assert.equal(result.id, 're-engine'); assert.equal(result.compatibilityKnown, false);
  assert.deepEqual(result.evidence.map(row => row.kind), ['engine-metadata', 're-native-directory']);
});

test('verified resources plus exact implemented profiles identify automatic compatibility; demos and substring names do not inherit it', t => {
  for (const name of ['re9.exe', 'OnimushaWotS.exe']) {
    const f = fixture(t, name); f.pak();
    const result = detectReEngine(f.input);
    assert.equal(result.compatibilityKnown, true); assert.equal(result.profile.automatic, true);
    assert.equal(result.profile.gameRuntimeVerified, false); assert.equal(result.profile.storage, '_storage_');
    assert.ok(REFRAMEWORK_ADAPTERS.some(row => row.id === result.profile.adapterId));
  }
  for (const name of ['backup_re9.exe', 're9demo.exe', 'OnimushaWotS_demo.exe']) {
    const f = fixture(t, name); f.pak();
    assert.equal(detectReEngine(f.input).compatibilityKnown, false);
  }
});

test('Steam metadata can name an unknown RE title but cannot authorize a renamed EXE, and a conflicting identity blocks an adapter', t => {
  const f = fixture(t); f.pak();
  const renamed = detectReEngine({ ...f.input, metadata: { steamAppId: 3764200 } });
  assert.equal(renamed.profile.gameId, 're9'); assert.equal(renamed.compatibilityKnown, false);
  assert.equal(renamed.profile.adapterId, null);
  const re9 = fixture(t, 're9.exe'); re9.pak();
  const conflict = detectReEngine({ ...re9.input, metadata: { steamAppId: '2054970' } });
  assert.equal(conflict.id, 're-engine'); assert.equal(conflict.profile, null); assert.equal(conflict.compatibilityKnown, false);
  assert.ok(conflict.evidence.some(row => row.kind === 'identity-conflict'));
});

test('official required profiles keep fixed storage rules separate from general REF support', t => {
  assert.deepEqual(REFRAMEWORK_REQUIRED_PROFILES.filter(row => row.requirement === 'rhi').map(row => row.gameId).sort(), ['dd2', 'mhwilds', 're9', 'sf6']);
  for (const [id, tdb, storage] of [['dd2', 83, '_storage_'], ['mhwilds', 81, '_storage_'], ['sf6', 71, null]]) {
    const profile = RE_ENGINE_PROFILES.find(row => row.gameId === id);
    assert.equal(profile.tdbVersion, tdb); assert.equal(profile.storage, storage);
    assert.ok(profile.requirementSource.includes('/b2044965806d2ed01ff6f214da53f720aab4ff3e/'));
    const f = fixture(t, profile.executables[0]); f.pak();
    const result = detectReEngine(f.input);
    assert.equal(result.profile.requirement, 'rhi');
    assert.equal(result.compatibilityKnown, true); assert.ok(result.profile.adapterId);
    if (id === 'sf6') assert.equal(result.profile.storage, null);
  }
  assert.equal(RE_ENGINE_PROFILES.find(row => row.gameId === 're2').requirement, null);
});

test('bound pinned REF startup plus the exact official loader supplies a fallback without reading asset archives', t => {
  const f = fixture(t, 're9.exe');
  f.put('re2_framework_log.txt', startup(f.gameDir));
  const loader = f.put('dinput8.dll', ''); fs.truncateSync(loader, OFFICIAL.dll_bytes);
  let hashes = 0;
  const detector = createReEngineDetection({ fileDigest: file => { assert.equal(file, loader); hashes++; return OFFICIAL.dll_sha256; } });
  const result = detector.inspect(f.input);
  assert.equal(result.id, 're-engine'); assert.equal(result.compatibilityKnown, true); assert.equal(hashes, 1);
  assert.deepEqual(result.evidence.slice(0, 2).map(row => row.kind), ['bound-reframework-log', 'official-reframework-file']);
  assert.equal(createReEngineDetection({ fileDigest: () => '0'.repeat(64) }).inspect(f.input), null);
  for (const invalid of [startup(path.dirname(f.gameDir)), startup(f.gameDir, 'dd2'), startup(f.gameDir, 're9', '0'.repeat(40)), startup(f.gameDir) + startup(f.gameDir), startup(f.gameDir).replace('[REFramework]', '[another]')]) {
    f.put('re2_framework_log.txt', invalid);
    assert.equal(detector.inspect(f.input), null);
  }
  assert.equal(hashes, 1, 'invalid startup evidence must be rejected before any DLL hash');
});

test('directory scope, plain paths and architecture constrain evidence without mutating anything', t => {
  const f = fixture(t, 're9.exe'); f.pak();
  const before = fs.readdirSync(f.gameDir).sort();
  assert.equal(detectReEngine({ gameDir: path.dirname(f.gameDir), exe: f.exe }), null);
  assert.equal(detectReEngine({ gameDir: f.gameDir, exe: path.join(f.gameDir, 'missing.exe') }), null);
  assert.equal(detectReEngine({ gameDir: '.', exe: f.exe }), null);
  const hardlink = path.join(f.gameDir, 'copy.bin'); fs.linkSync(path.join(f.gameDir, 're_chunk_000.pak'), hardlink);
  assert.equal(detectReEngine(f.input), null); fs.unlinkSync(hardlink);
  const x86 = fixture(t, 're9.exe', 32); x86.pak();
  assert.equal(detectReEngine(x86.input).id, 're-engine');
  assert.equal(detectReEngine(x86.input).compatibilityKnown, false);
  assert.deepEqual(fs.readdirSync(f.gameDir).sort(), before);
});

test('large game/archive files use fixed header reads, never whole-file or recursive scans', t => {
  const f = fixture(t, 're9.exe'); const pak = f.pak();
  fs.truncateSync(pak, 1024 * 1024 * 1024); fs.truncateSync(f.exe, 600 * 1024 * 1024);
  let bytes = 0; const opened = new Set(), dirs = [];
  const observed = { ...fs,
    readFileSync() { assert.fail('whole-file reads are forbidden'); },
    opendirSync(dir) { dirs.push(dir); return fs.opendirSync(dir); },
    openSync(file, mode) { assert.equal(mode, 'r'); const fd = fs.openSync(file, mode); opened.add(file); return fd; },
    readSync(fd, buffer, offset, length, position) { assert.ok(length <= 64); bytes += length; return fs.readSync(fd, buffer, offset, length, position); }
  };
  assert.equal(createReEngineDetection({ fs: observed }).inspect(f.input).compatibilityKnown, true);
  assert.equal(bytes, 106); assert.deepEqual(dirs, [f.gameDir]);
  assert.deepEqual([...opened].sort(), [f.exe, pak].sort());
});

test('overlong log prefixes, excessive directories and inaccessible evidence remain unknown', t => {
  const f = fixture(t, 're9.exe'); f.put('re2_framework_log.txt', ' '.repeat(LIMITS.logBytes) + startup(f.gameDir));
  const loader = f.put('dinput8.dll', ''); fs.truncateSync(loader, OFFICIAL.dll_bytes);
  assert.equal(createReEngineDetection({ fileDigest: () => { assert.fail('outside-bound startup cannot cause a hash'); } }).inspect(f.input), null);
  const unavailable = { ...fs, opendirSync() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
  assert.equal(createReEngineDetection({ fs: unavailable }).inspect(f.input), null);
  let count = 0, closed = false;
  const overfull = { ...fs, opendirSync() { return { readSync() { return { name: `entry-${count++}` }; }, closeSync() { closed = true; } }; } };
  assert.equal(createReEngineDetection({ fs: overfull }).inspect(f.input), null);
  assert.equal(count, LIMITS.directoryEntries + 1); assert.equal(closed, true);
});
