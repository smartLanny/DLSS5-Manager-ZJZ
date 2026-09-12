'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createGameVerificationRecords } = require('../src/product/game-verification-records');
const { fixture: appFixture, peBytes, put, sha, hashFile } = require('./helpers/operation-integration-fixture');
const { specialFixture } = require('./helpers/operation-special-fixture');
const { manifestPath } = require('../src/product/manifest');

function liveSession(exe, id = 'game') {
  return { version: 1, gameId: id, sessionId: crypto.randomUUID(), targetExe: exe, status: 'waiting-enhancement',
    requestedAt: new Date(Date.now() - 2000).toISOString(), process: { pid: 12345, exe, startedAt: new Date(Date.now() - 1500).toISOString() },
    helper: { status: 'not-applicable' }, runtimeVerified: false };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-observation-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const game = path.join(root, 'game'), exe = path.join(game, 'Game.exe'), core = path.join(game, '项目 Core β.addon64'), userData = path.join(root, 'user');
  put(exe, peBytes('game generation 1')); put(core, peBytes('owned Core generation 1'));
  let expected = { path: core, sha256: hashFile(core), version: 'core-1', verified: true }, session = liveSession(exe);
  const options = { userData, gameExecutable: () => exe, layout: () => ({ exe, gameRoot: game, addonDirectory: game }),
    coreIdentity: async () => expected && { ...expected }, launchSession: async () => structuredClone(session) };
  const records = createGameVerificationRecords(options);
  const input = (result = 'changed', extra = {}) => ({ sessionId: session.sessionId, sameScene: true, result, note: '同一场景开关观察。', ...extra });
  return { root, game, exe, core, userData, options, records, input, get expected() { return expected; }, get session() { return session; },
    setExpected(value) { expected = value; }, setSession(value) { session = value; } };
}
function snapshotTree(root) {
  const rows = [];
  const visit = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) visit(file); else rows.push([path.relative(root, file), hashFile(file)]);
  } };
  if (fs.existsSync(root)) visit(root); return rows.sort((a, b) => a[0].localeCompare(b[0]));
}
function savedFile(f, row) { return path.join(f.userData, 'game-verification', sha(path.resolve(f.exe).toLowerCase()), row.id + '.json'); }

test('same-scene observation records bind current EXE, managed Core and matched process, with only user provenance', async t => {
  const f = fixture(t), gameBefore = snapshotTree(f.game);
  assert.equal(await f.records.inspect('game', f.session), null); assert.equal(fs.existsSync(f.userData), false);
  const note = `..\..\game\should-not-exist.txt\n<script>not executed</script>\n${f.exe}`;
  const written = await f.records.record('game', f.input('changed', { note, evidenceLabel: path.join(f.game, 'evidence-is-a-label.png') }));
  assert.equal(written.recorded, true); assert.equal(written.record.source, 'user-comparison');
  assert.equal(written.record.automaticVerification, false); assert.equal(written.record.coreSha256, f.expected.sha256);
  assert.equal(written.record.exeSha256, hashFile(f.exe)); assert.equal(written.record.corePath, f.core);
  assert.equal(written.record.process.pid, f.session.process.pid); assert.equal(written.record.note, note);
  assert.deepEqual(snapshotTree(f.game), gameBefore, 'notes and evidence labels never become game-file paths');
  const check = await f.records.inspect('game', f.session);
  assert.equal(check.status, 'passed'); assert.equal(check.source, 'user-comparison'); assert.equal(check.automaticVerification, false);
  assert.equal('nr' in check, false); assert.equal('runtimeVerified' in check, false); assert.equal('samples' in check, false);
  assert.match(check.detail, /用户观察/);
});

for (const [result, status] of [['unchanged', 'not-observed'], ['uncertain', 'unverified']]) test(`${result} user observations never become passed or automatic NR evidence`, async t => {
  const f = fixture(t); await f.records.record('game', f.input(result));
  const actual = await f.records.inspect('game', f.session);
  assert.equal(actual.status, status); assert.equal(actual.automaticVerification, false);
});

test('historical Ready, wrong sessions and unmatched process identities cannot record or reuse an observation', async t => {
  const f = fixture(t); await f.records.record('game', f.input()); const original = structuredClone(f.session);
  const rejected = [
    { ...original, historical: true, helper: { status: 'ready' } },
    { ...original, sessionId: crypto.randomUUID() },
    { ...original, process: null, status: 'waiting-game', helper: { status: 'ready' } },
    { ...original, process: { ...original.process, exe: path.join(f.game, 'Launcher.exe') } },
    { ...original, process: { ...original.process, pid: 0 } },
    { ...original, process: { ...original.process, startedAt: new Date(Date.now() - 60000).toISOString() } }
  ];
  for (const current of rejected) {
    f.setSession(current); assert.equal(await f.records.inspect('game', original), null);
    await assert.rejects(f.records.record('game', { ...f.input(), sessionId: original.sessionId }), { code: 'ASSESSMENT_SESSION' });
  }
  f.setSession(original);
  assert.equal(await f.records.inspect('game', { ...original, historical: true }), null, 'a caller cannot promote its historical snapshot');
  f.setSession({ ...original, process: { ...original.process, pid: original.process.pid + 1 } });
  assert.equal(await f.records.inspect('game', f.session), null, 'even the same session ID cannot reuse another PID observation');
});

test('EXE and Core replacement or lost managed metadata invalidate old observations without blessing current file hashes', async t => {
  const f = fixture(t); await f.records.record('game', f.input()); const originalExe = fs.readFileSync(f.exe), originalCore = fs.readFileSync(f.core);
  put(f.exe, peBytes('game generation 2')); assert.equal(await f.records.inspect('game', f.session), null);
  put(f.exe, originalExe); put(f.core, peBytes('externally replaced Core'));
  assert.equal(await f.records.inspect('game', f.session), null);
  await assert.rejects(f.records.record('game', f.input()), { code: 'ASSESSMENT_CORE_IDENTITY' });
  f.setExpected({ ...f.expected, sha256: hashFile(f.core), version: 'core-2' });
  assert.equal(await f.records.inspect('game', f.session), null, 'a legitimate new owner generation does not inherit old user acceptance');
  put(f.core, originalCore); f.setExpected(null);
  assert.equal(await f.records.inspect('game', f.session), null);
  await assert.rejects(f.records.record('game', f.input()), { code: 'ASSESSMENT_CORE_IDENTITY' });
});

test('record rejects identity changes during the save preflight and never writes an observation for stale metadata', async t => {
  const f = fixture(t); let calls = 0;
  const records = createGameVerificationRecords({ ...f.options, coreIdentity: async () => {
    if (++calls === 2) put(f.core, peBytes('changed during save')); return f.expected;
  } });
  await assert.rejects(records.record('game', f.input()), { code: 'ASSESSMENT_CORE_IDENTITY' });
  assert.equal(fs.existsSync(f.userData), false);
});

test('invalid requests and modified record provenance cannot create a current passed result', async t => {
  const f = fixture(t);
  for (const input of [null, [], 'text', { ...f.input(), sameScene: false }, { ...f.input(), result: 'passed' }, { ...f.input(), note: 'x'.repeat(2001) },
    { ...f.input(), file: path.join(f.game, 'forged.json') }]) await assert.rejects(f.records.record('game', input), { code: 'ASSESSMENT_INPUT' });
  const { record } = await f.records.record('game', f.input()), file = savedFile(f, record);
  for (const patch of [{ automaticVerification: true }, { source: 'nr-counter' }, { process: { ...record.process, pid: 54321 } }, { result: 'passed' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...record, ...patch })); assert.equal(await f.records.inspect('game', f.session), null);
  }
});

test('AppService Core identity comes from the ordinary and external owner receipt and remains read-only', async t => {
  const f = await appFixture(t); assert.equal(await f.service.gameCoreIdentity(f.id), null);
  await f.apply({ api: 'dx12', version: 'fixture-core-1', deployment: 'local' });
  const before = snapshotTree(f.root), ordinary = await f.service.gameCoreIdentity(f.id);
  assert.equal(ordinary.verified, true); assert.equal(ordinary.version, 'fixture-core-1'); assert.equal(ordinary.sha256, hashFile(ordinary.path));
  const ordinaryModules = await f.service.gameModuleManifest(f.id);
  assert.equal(ordinaryModules.find(row => row.role === 'core').sha256, ordinary.sha256);
  assert.equal(ordinaryModules.find(row => row.role === 'reshade').path, path.join(f.exeDir, 'dxgi.dll'));
  assert.deepEqual(snapshotTree(f.root), before);
  const manifest = manifestPath(f.gameRoot), saved = fs.readFileSync(manifest); fs.unlinkSync(manifest);
  assert.equal(await f.service.gameCoreIdentity(f.id), null, 'an existing Core alone is not ownership evidence'); put(manifest, saved);
  await f.apply({ deployment: 'external', loadingMode: 'proxy' });
  const proxyModules = await f.service.gameModuleManifest(f.id);
  assert.equal(proxyModules.find(row => row.role === 'core').path.startsWith(f.layout().runtimeDir), true);
  assert.equal(proxyModules.find(row => row.role === 'reshade').path, path.join(f.exeDir, 'dxgi.dll'));
  await f.apply({ loadingMode: 'helper' });
  const external = await f.service.gameCoreIdentity(f.id); assert.equal(external.verified, true); assert.equal(external.sha256, ordinary.sha256);
  assert.equal((await f.service.gameModuleManifest(f.id)).find(row => row.role === 'reshade').path, path.join(f.layout().runtimeDir, 'ReShade64.dll'));
  const retainedHelper = path.join(f.layout().runtimeDir, 'ReShade64.dll'), retainedHash = hashFile(retainedHelper);
  await f.apply({ loadingMode: 'proxy' });
  const returned = await f.service.gameModuleManifest(f.id), activeLoaders = returned.filter(row => row.role === 'reshade');
  assert.equal(activeLoaders.length, 1); assert.equal(activeLoaders[0].path, path.join(f.exeDir, 'dxgi.dll'));
  assert.equal(activeLoaders[0].sha256, retainedHash);
  assert.equal(returned.find(row => row.path === retainedHelper).role, 'inactive-loader');
  assert.equal(hashFile(retainedHelper), retainedHash, 'returning to the proxy preserves the reusable profile loader');
  assert.notEqual(external.path, ordinary.path); const expected = external.sha256; put(external.path, peBytes('replaced external Core'));
  assert.notEqual(hashFile(external.path), expected); assert.equal(await f.service.gameCoreIdentity(f.id), null);
});

for (const route of ['vulkan', 'feeder']) test(`AppService ${route} Core identity follows its fixed recipe role and rejects missing ownership metadata`, async t => {
  const f = await specialFixture(t, route);
  if (route === 'vulkan') {
    const recipeFile = path.join(f.resourcesPath, 'vulkan-runtime/recipe.json'), recipe = JSON.parse(fs.readFileSync(recipeFile));
    const core = recipe.files.find(row => row.target.endsWith('/core.addon64'));
    const actualName = 'addons/项目 Core β.addon64';
    fs.renameSync(path.join(f.resourcesPath, 'vulkan-runtime', core.source), path.join(f.resourcesPath, 'vulkan-runtime', actualName));
    core.source = core.target = actualName;
    core.license = 'project Core; separate from vendor shaders/runtime'; core.identity = { sourceManifestSha256: 'a'.repeat(64) };
    fs.writeFileSync(recipeFile, JSON.stringify(recipe));
  }
  await f.apply({ route, api: route === 'vulkan' ? 'vulkan' : 'dx12', version: f.special.packageId, deployment: route === 'vulkan' ? 'external' : 'local' });
  const before = snapshotTree(f.root), identity = await f.service.gameCoreIdentity(f.id);
  assert.ok(identity); assert.equal(identity.verified, true); assert.equal(identity.version, f.special.version);
  assert.equal(identity.sha256, hashFile(identity.path)); assert.notEqual(path.basename(identity.path), 'nr-before-sr.zh-CN.addon64');
  assert.deepEqual(snapshotTree(f.root), before);
  const session = liveSession(f.exe, f.id), records = createGameVerificationRecords({ userData: f.userData,
    gameExecutable: () => f.exe, layout: () => f.layout(), coreIdentity: id => f.service.gameCoreIdentity(id), launchSession: () => session });
  await records.record(f.id, { sessionId: session.sessionId, sameScene: true, result: 'changed', note: '固定配套同场景观察。' });
  assert.equal((await records.inspect(f.id, session)).source, 'user-comparison');
  const metadata = route === 'vulkan' ? path.join(f.special.owner.configDir((await f.service.listGames())[0]), '.xiaofeng-vulkan-runtime.json') :
    path.join(f.gameRoot, '_DLSS5_Backup/xiaofeng-feeder.json');
  fs.unlinkSync(metadata); assert.equal(await f.service.gameCoreIdentity(f.id), null);
  assert.equal(await records.inspect(f.id, session), null);
  await assert.rejects(records.record(f.id, { sessionId: session.sessionId, sameScene: true, result: 'changed', note: '不能继承。' }), { code: 'ASSESSMENT_CORE_IDENTITY' });
});
