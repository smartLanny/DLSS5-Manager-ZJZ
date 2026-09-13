'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { parseCoreSamples, emptyVerification, createRuntimeVerification } = require('../src/product/runtime-verification');
const { specialFixture } = require('./helpers/operation-special-fixture');
const { put, hashFile } = require('./helpers/operation-integration-fixture');
const sample = (success, submitted) => `[stats] session totals: Feature18-success=${success} transfer-prepared=5 transfer-recorded=5 transfer-bound=5 transfer-submitted=${submitted} lifecycle-bypass=0;`;
test('requires growth of both Core success and submitted counters', () => {
  assert.equal(parseCoreSamples(sample(10, 8)).increasing, false);
  assert.equal(parseCoreSamples(sample(10, 8) + '\n' + sample(11, 8)).increasing, false);
  assert.equal(parseCoreSamples(sample(10, 8) + '\n' + sample(11, 9)).increasing, true);
  assert.equal(parseCoreSamples(sample(10, 8) + '\n' + sample(1, 1)).increasing, false);
});
test('TYPELESS rejection and not-attempted remain specific bypass evidence', () => {
  assert.equal(parseCoreSamples('reason=unsupported-input-format format=27\nnot-attempted').firstReason.code, 'unsupported-format');
  assert.match(parseCoreSamples('runtime=not-attempted').firstReason.detail, /不能据此判断运行库缺失/);
});
test('HDR or Generic success never counts as this Core NR success', () => {
  assert.equal(parseCoreSamples('RenoDX HDR success=800\nGeneric NR success=40 submit=40').increasing, false);
});
test('the four acceptance layers cannot promote each other', () => {
  const session = { sessionId: crypto.randomUUID(), targetExe: path.resolve('fixture.exe'), requestedAt: new Date().toISOString() };
  const helper = { status: 'ready', sessionId: session.sessionId, targetExe: session.targetExe, configHash: 'a'.repeat(64), helperPid: 321, readyAt: session.requestedAt };
  const rows = emptyVerification(helper, session);
  assert.equal(rows.helper.status, 'passed'); assert.equal(rows.core.status, 'unverified');
  assert.equal(rows.nr.status, 'unverified'); assert.equal(rows.visual.status, 'unverified');
  assert.equal(emptyVerification(helper, { ...session, historical: true }).helper.status, 'unverified');
  assert.equal(emptyVerification(helper, { ...session, sessionId: crypto.randomUUID() }).helper.status, 'unverified');
  assert.equal(emptyVerification(helper).helper.status, 'unverified');
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-verify-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const exe = path.join(root, 'fixture.exe'), core = path.join(root, 'nr-before-sr.zh-CN.addon64'), loader = path.join(root, 'ReShade64.dll'), log = path.join(root, 'nr-before-sr.log');
  for (const file of [exe, core, loader]) fs.writeFileSync(file, path.basename(file));
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const layout = { exe, gameRoot: root, runtimeDir: root, addonDirectory: root, logDirs: [root], verified: true, generation: crypto.randomUUID(),
    moduleManifest: [{ role: 'core', path: core, sha256: hash(core) }, { role: 'reshade', path: loader, sha256: hash(loader) }] };
  const session = { sessionId: crypto.randomUUID(), targetExe: exe, requestedAt: new Date().toISOString(), helper: { status: 'not-applicable' },
    process: { pid: 400, exe, startedAt: new Date().toISOString() } };
  let modules = [core, loader], alive = true;
  const service = createRuntimeVerification({ layout: async () => layout, processes: { observe: async () => alive ? { ...session.process, modules } : null } });
  const append = text => { fs.appendFileSync(log, text + '\n'); const stamp = new Date(Date.now() + 10); fs.utimesSync(log, stamp, stamp); };
  return { root, core, loader, log, layout, session, service, append, modules: value => { modules = value; }, alive: value => { alive = value; } };
}
test('current module identities are required, old logs remain isolated, and TYPELESS bypass cannot claim NR success', async t => {
  const f = fixture(t); f.append(sample(100, 100) + '\n' + sample(200, 200)); await f.service.prepare('game', f.session);
  let result = await f.service.assess('game', f.session); assert.equal(result.core.status, 'passed'); assert.equal(result.nr.status, 'unverified');
  f.append('reason=unsupported-input-format format=27\nruntime=not-attempted\nRenoDX HDR success=9999');
  result = await f.service.assess('game', f.session); assert.equal(result.nr.status, 'bypassed'); assert.equal(result.nr.firstReason.code, 'unsupported-format');
  f.append(sample(1, 1) + '\n' + sample(2, 2)); result = await f.service.assess('game', f.session);
  assert.equal(result.nr.status, 'passed'); assert.equal(result.nr.firstReason.code, 'unsupported-format'); assert.equal(result.visual.status, 'unverified');
  f.modules([f.core]); result = await f.service.assess('game', f.session);
  assert.equal(result.core.status, 'passed'); assert.equal(result.reshade.status, 'unverified'); assert.equal(result.nr.status, 'unverified');
  f.modules([f.loader]); result = await f.service.assess('game', f.session);
  assert.equal(result.reshade.status, 'passed'); assert.equal(result.core.status, 'unverified'); assert.equal(result.nr.status, 'unverified');
  f.modules([f.core, f.loader]); fs.appendFileSync(f.core, 'changed'); assert.equal((await f.service.assess('game', f.session)).core.status, 'unverified');
});
test('old manifest without hashes, changed deployment, and another session never reuse acceptance', async t => {
  const f = fixture(t); await f.service.prepare('game', f.session); f.append(sample(1, 1) + '\n' + sample(2, 2));
  assert.equal((await f.service.assess('game', { ...f.session, sessionId: crypto.randomUUID() })).core.status, 'unverified');
  assert.equal((await f.service.assess('game', { ...f.session, historical: true })).nr.status, 'unverified');
  f.layout.generation = crypto.randomUUID(); assert.equal((await f.service.assess('game', f.session)).core.status, 'unverified');
  f.layout.moduleManifest = []; await f.service.prepare('game', f.session); assert.equal((await f.service.assess('game', f.session)).core.status, 'unverified');
});

for (const route of ['vulkan', 'feeder']) test(`${route} runtime verification uses its owned Core and actual ReShade loader paths, refusing drift and missing loader authority`, async t => {
  const f = await specialFixture(t, route);
  if (route === 'vulkan') {
    const file = path.join(f.resourcesPath, 'vulkan-runtime/recipe.json'), recipe = JSON.parse(fs.readFileSync(file));
    const core = recipe.files.find(row => row.target.endsWith('/core.addon64'));
    const renamed = 'addons/项目 Core 验收.addon64';
    fs.renameSync(path.join(f.resourcesPath, 'vulkan-runtime', core.source), path.join(f.resourcesPath, 'vulkan-runtime', renamed));
    core.source = core.target = renamed; core.role = 'core'; fs.writeFileSync(file, JSON.stringify(recipe));
  }
  await f.apply({ route, api: route === 'vulkan' ? 'vulkan' : 'dx12', version: f.special.packageId, deployment: route === 'vulkan' ? 'external' : 'local' });
  const expected = await f.service.gameModuleManifest(f.id), core = expected.find(row => row.role === 'core'), loader = expected.find(row => row.role === 'reshade');
  assert.ok(core); assert.ok(loader); assert.equal(core.architecture, 64); assert.equal(loader.architecture, 64);
  assert.notEqual(path.basename(core.path), 'nr-before-sr.zh-CN.addon64');
  assert.equal(core.sha256, hashFile(core.path)); assert.equal(loader.sha256, hashFile(loader.path));
  if (route === 'vulkan') {
    assert.equal(loader.owner, 'vulkan-layer-owned');
    assert.ok(loader.path.startsWith(path.join(f.userData, 'vulkan-deployment/layers')));
    assert.equal(loader.path.startsWith(f.layout().runtimeDir), false, 'the Vulkan loader belongs to its separate layer directory');
  } else assert.equal(loader.path, path.join(f.exeDir, 'dxgi.dll'));
  const originalCore = fs.readFileSync(core.path), originalLoader = fs.readFileSync(loader.path);
  const session = { sessionId: crypto.randomUUID(), targetExe: f.exe, requestedAt: new Date().toISOString(), helper: { status: 'not-applicable' },
    process: { pid: 44500, exe: f.exe, startedAt: new Date().toISOString() } };
  let observedModules = [core.path, loader.path];
  const verification = createRuntimeVerification({ layout: () => f.layout(), modules: id => f.service.gameModuleManifest(id),
    processes: { observe: async () => ({ ...session.process, modules: observedModules }) } });
  const log = path.join(path.dirname(core.path), 'nr-before-sr.log');
  const append = text => { fs.appendFileSync(log, text + '\n'); const stamp = new Date(Date.now() + 25); fs.utimesSync(log, stamp, stamp); };
  append(sample(10, 10) + '\n' + sample(20, 20)); await verification.prepare(f.id, session);
  let result = await verification.assess(f.id, session);
  assert.equal(result.core.status, 'passed'); assert.equal(result.nr.status, 'unverified', 'historical counters are excluded for special routes too');
  append(sample(1, 1) + '\n' + sample(2, 2)); result = await verification.assess(f.id, session);
  assert.equal(result.nr.status, 'passed'); assert.equal(result.visual.status, 'unverified');
  const wrongPath = path.join(f.exeDir, 'Unowned-ReShade.dll'); put(wrongPath, originalLoader);
  observedModules = [core.path, wrongPath]; result = await verification.assess(f.id, session);
  assert.equal(result.core.status, 'passed'); assert.equal(result.reshade.status, 'unverified'); assert.equal(result.nr.status, 'unverified');
  observedModules = [core.path, loader.path];
  for (const [target, bytes] of [[core, originalCore], [loader, originalLoader]]) {
    fs.appendFileSync(target.path, ' externally changed');
    const stillExpected = (await f.service.gameModuleManifest(f.id)).find(row => row.path === target.path);
    assert.equal(stillExpected.sha256, target.sha256, 'the managed expected hash never blesses changed disk content');
    assert.notEqual(stillExpected.sha256, hashFile(target.path));
    result = await verification.assess(f.id, session); assert.equal(result.core.status, target.role === 'core' ? 'unverified' : 'passed'); assert.equal(result.nr.status, 'unverified');
    assert.equal(result.reshade.status, target.role === 'reshade' ? 'unverified' : 'passed');
    await verification.prepare(f.id, session); assert.equal((await verification.assess(f.id, session)).core.status, target.role === 'core' ? 'unverified' : 'passed');
    put(target.path, bytes); await verification.prepare(f.id, session);
  }
  const receiptFile = route === 'vulkan' ? path.join(f.userData, 'vulkan-deployment/receipt.json') : path.join(f.gameRoot, '_DLSS5_Backup/xiaofeng-feeder.json');
  fs.unlinkSync(receiptFile);
  assert.equal((await f.service.gameModuleManifest(f.id)).some(row => row.role === 'reshade'), false);
  append(sample(3, 3) + '\n' + sample(4, 4));
  result = await verification.assess(f.id, session); assert.equal(result.core.status, route === 'vulkan' ? 'passed' : 'unverified'); assert.equal(result.nr.status, 'unverified');
});

test('a Vulkan layer receipt cannot redirect the fixed owned ReShade loader to an arbitrary identical DLL', async t => {
  const f = await specialFixture(t, 'vulkan');
  const sourceFile = path.join(f.resourcesPath, 'vulkan-runtime/recipe.json'), source = JSON.parse(fs.readFileSync(sourceFile));
  source.files.find(row => row.target.endsWith('/core.addon64')).role = 'core'; fs.writeFileSync(sourceFile, JSON.stringify(source));
  await f.apply({ route: 'vulkan', api: 'vulkan', version: f.special.packageId, deployment: 'external' });
  const modules = await f.service.gameModuleManifest(f.id), loader = modules.find(row => row.role === 'reshade'); assert.ok(loader);
  const copy = path.join(f.exeDir, 'ReShade64.dll'); fs.copyFileSync(loader.path, copy);
  const receiptFile = path.join(f.userData, 'vulkan-deployment/receipt.json'), receipt = JSON.parse(fs.readFileSync(receiptFile));
  receipt.layer.library = copy; fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  const rejected = await f.service.gameModuleManifest(f.id);
  assert.equal(rejected.some(row => row.role === 'reshade'), false);
  assert.ok(rejected.some(row => row.role === 'core'), 'the independent Core receipt does not confer loader authority');
});
