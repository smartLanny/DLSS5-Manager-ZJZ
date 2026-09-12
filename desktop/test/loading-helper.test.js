'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createLoadingHelper, inspectHelperModules } = require('../src/product/loading-helper');
const { INSTALLED_NAMES } = require('../src/product/constants');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-protocol-'));
  const runtimeDir = path.join(root, 'profile'), resourcesPath = path.join(root, 'resources'), directory = path.join(resourcesPath, 'loading-helper');
  fs.mkdirSync(runtimeDir); fs.mkdirSync(directory, { recursive: true });
  const targetExe = path.join(root, '中文 游戏.exe'), configPath = path.join(runtimeDir, 'ReShade.ini'), executable = path.join(directory, 'dlss5-load-helper.exe');
  fs.writeFileSync(targetExe, 'target'); fs.writeFileSync(executable, 'helper'); fs.writeFileSync(configPath, '[ADDON]\nAddonPath=.\n');
  fs.writeFileSync(path.join(directory, 'component.json'), JSON.stringify({ version: 1, id: 'dlss5-loading-helper', file: path.basename(executable), sha256: sha(executable),
    architecture: 'x64', protocol: 1, policy: { privilege: 'ordinary-user', terminateGame: false, cleanupGameFiles: false, protectionBypass: false } }));
  const moduleManifest = Object.entries({ core: INSTALLED_NAMES.addon, chain: INSTALLED_NAMES.bridge, 'nr-runtime': INSTALLED_NAMES.runtime, reshade: 'ReShade64.dll' }).map(([role, name]) => {
    const file = path.join(runtimeDir, name); fs.writeFileSync(file, role); return { name, path: file, role, sha256: sha(file) };
  });
  const layout = { exe: targetExe, mode: 'external', loadingMode: 'helper', verified: true, api: 'dx12', runtimeDir,
    activeConfigPath: configPath, loaderPath: path.join(runtimeDir, 'ReShade64.dll'), moduleManifest };
  const children = [];
  function spawn() {
    const child = Object.assign(new EventEmitter(), { pid: 432, exitCode: null, killed: false, stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { this.killed = true; this.exitCode = 1; this.emit('exit', 1); this.emit('close', 1); }, unref() {} }); children.push(child); return child;
  }
  const helper = createLoadingHelper({ getLayout: async () => layout, inspectDeployment: async () => ({ ready: true }), getBitness: () => 64,
    resourcesPath, readyTimeoutMs: 50, spawn, ...overrides });
  t.after(async () => { await helper.detach(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const prepare = () => helper.prepare({ gameId: 'fixture', sessionId: crypto.randomUUID(), targetExe });
  const event = (session, type = 'ready', extra = {}) => ({ version: 1, event: type, sessionId: session.sessionId, targetExe, configHash: session.configHash, helperPid: 432, ...extra });
  const send = (session, type, extra) => session.child.stdout.write(JSON.stringify(event(session, type, extra)) + '\n');
  const started = async session => { const promise = helper.start(session); promise.catch(() => {}); while (!session.child && !session.error) await new Promise(resolve => setImmediate(resolve)); return { promise }; };
  return { helper, layout, root, configPath, prepare, event, send, started, children, inspect: () => inspectHelperModules({ directory: runtimeDir, configPath, modules: moduleManifest, api: layout.api, getBitness: () => 64 }) };
}
test('allowlist requires every route module and recognizes ReShade display-name disabled entries', async t => {
  const f = fixture(t); assert.equal((await f.inspect()).ready, true);
  fs.appendFileSync(f.configPath, `DisabledAddons=Project NR@${INSTALLED_NAMES.addon}\n`);
  assert.equal((await f.inspect()).modules.find(row => row.role === 'core').status, 'disabled');
  await assert.rejects(f.prepare(), { code: 'HELPER_MODULES_BLOCKED' });
  fs.writeFileSync(f.configPath, '[ADDON]\nAddonPath=.\n'); f.layout.moduleManifest.splice(1, 1);
  assert.deepEqual((await f.inspect()).missingRoles, ['chain']); await assert.rejects(f.prepare(), { code: 'HELPER_MODULES_BLOCKED' });
});
test('allowlist rejects an unrecorded add-on, wrong role filename, API carrier omission, and changed module before spawn', async t => {
  const f = fixture(t), extra = path.join(f.layout.runtimeDir, 'Unknown.addon64'); fs.writeFileSync(extra, 'unknown');
  assert.equal((await f.inspect()).ready, false); fs.unlinkSync(extra);
  const core = f.layout.moduleManifest[0], original = core.name; core.name = 'other.addon64'; assert.equal((await f.inspect()).modules[0].status, 'path-mismatch'); core.name = original;
  f.layout.api = 'dx11'; assert.deepEqual((await f.inspect()).missingRoles, ['carrier']); f.layout.api = 'dx12';
  const session = await f.prepare(); fs.appendFileSync(core.path, 'changed');
  await assert.rejects(f.helper.start(session), { code: 'HELPER_IDENTITY_CHANGED' }); assert.equal(f.children.length, 0);
});
test('configuration hashing preserves the UTF-8 BOM and rejects invalid bytes', async t => {
  const f = fixture(t); fs.writeFileSync(f.configPath, Buffer.from('\ufeff[ADDON]\nAddonPath=.\n'));
  assert.equal((await f.prepare()).configHash, sha(f.configPath)); fs.writeFileSync(f.configPath, Buffer.from([0xff]));
  await assert.rejects(f.prepare(), { code: 'HELPER_CONFIG_INVALID' });
});

test('cancellation during helper identity revalidation prevents process creation', async t => {
  let f, hold = false, cancelled = false, entered, release;
  const checking = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f = fixture(t, { getLayout: async () => { if (hold) { entered(); await gate; } return f.layout; } });
  const session = await f.prepare(); hold = true;
  const rejected = assert.rejects(f.helper.start(session, { cancelled: () => cancelled }), { code: 'LAUNCH_CANCELLED' });
  await checking; cancelled = true; release(); await rejected;
  assert.equal(f.children.length, 0); assert.equal(session.state, 'prepared');
});
test('Ready accepts split UTF-8 and final Attached output after exit but before close', async t => {
  const f = fixture(t), session = await f.prepare(), { promise } = await f.started(session);
  const bytes = Buffer.from(JSON.stringify(f.event(session)) + '\n'), index = bytes.indexOf(Buffer.from('中文')) + 1;
  session.child.stdout.write(bytes.subarray(0, index)); session.child.stdout.write(bytes.subarray(index)); await promise;
  session.child.exitCode = 0; session.child.emit('exit', 0); f.send(session, 'attached', { gamePid: 700 }); session.child.emit('close', 0);
  assert.equal(session.state, 'attached'); assert.equal(f.helper.alive(session), true);
});
test('Ready timeout, early close, invalid identity, invalid UTF-8 and output overflow all fail closed', async t => {
  for (const mode of ['timeout', 'exit', 'identity', 'utf8', 'overflow']) {
    const f = fixture(t), session = await f.prepare(), { promise } = await f.started(session);
    if (mode === 'exit') { session.child.exitCode = 2; session.child.emit('close', 2); }
    if (mode === 'identity') f.send(session, 'ready', { sessionId: crypto.randomUUID() });
    if (mode === 'utf8') session.child.stdout.write(Buffer.from([0xff, 10]));
    if (mode === 'overflow') session.child.stderr.write(Buffer.alloc(65537));
    await assert.rejects(promise, { code: { timeout: 'HELPER_READY_TIMEOUT', exit: 'HELPER_EXITED', identity: 'HELPER_IDENTITY', utf8: 'HELPER_PROTOCOL', overflow: 'HELPER_PROTOCOL' }[mode] });
    await f.helper.stop(session, 'test'); assert.equal(session.child.killed, mode !== 'exit');
  }
});
test('a post-Ready failure is delivered once and remains failed after later exit and data', async t => {
  const f = fixture(t), session = await f.prepare(), { promise } = await f.started(session); f.send(session, 'ready'); await promise;
  let failures = 0; await f.helper.watch(session, { process: { pid: 800 }, onFailure: () => { failures++; } });
  f.send(session, 'failed', { error: 5 }); f.send(session, 'attached', { gamePid: 800 }); session.child.emit('close', 1);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(failures, 1); assert.equal(session.state, 'failed');
});
test('closing manager settles a pending start and reclaims its Ready waiting helper', async t => {
  const f = fixture(t), waiting = await f.prepare(), first = await f.started(waiting);
  await f.helper.detach(); await assert.rejects(first.promise, { code: 'LAUNCH_CANCELLED' }); assert.equal(waiting.child.killed, true);
  const ready = await f.prepare(), second = await f.started(ready); f.send(ready, 'ready'); await second.promise;
  await f.helper.detach(); assert.equal(ready.child.killed, true);
});
test('a synchronous spawn failure clears its deadline and retains the first error', async t => {
  const f = fixture(t, { readyTimeoutMs: 5, spawn: () => { throw new Error('spawn fixture failure'); } }), session = await f.prepare();
  await assert.rejects(f.helper.start(session), { code: 'HELPER_START_FAILED' });
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(session.error.code, 'HELPER_START_FAILED');
});
test('helper merges an independent MFG owner without adopting unrecorded personal addons', async t => {
  let additional = [];
  const f = fixture(t, { additionalModules: async () => additional }), file = path.join(f.layout.runtimeDir, 'MFGUnlock.addon64');
  fs.writeFileSync(file, 'verified MFG');
  await assert.rejects(f.prepare(), { code: 'HELPER_MODULES_BLOCKED' });
  additional = [{ path: file, name: path.basename(file), role: 'mfgunlock', sha256: sha(file), architecture: 64, owner: 'fg-fixture' }];
  const session = await f.prepare(); assert.equal(session.modules.find(row => row.role === 'mfgunlock').status, 'enabled');
  assert.equal(f.layout.moduleManifest.some(row => row.path === file), false);
  additional = []; await assert.rejects(f.helper.start(session), { code: 'HELPER_IDENTITY_CHANGED' }); assert.equal(f.children.length, 0);
  additional = [{ path: file, name: path.basename(file), role: 'mfgunlock', sha256: sha(file), architecture: 64 }];
  fs.writeFileSync(path.join(f.layout.runtimeDir, 'Personal.addon64'), 'personal addon');
  await assert.rejects(f.prepare(), { code: 'HELPER_MODULES_BLOCKED' });
});
test('two owners may share one unchanged identity but conflicting expected hashes fail before launch', async t => {
  let additional = [];
  const f = fixture(t, { additionalModules: async () => additional });
  additional = [{ ...f.layout.moduleManifest[0], owner: 'second-fixture' }];
  assert.equal((await f.prepare()).modules.filter(row => row.role === 'core').length, 1);
  additional[0].sha256 = '0'.repeat(64); await assert.rejects(f.prepare(), { code: 'HELPER_MODULE_OWNER_CONFLICT' }); assert.equal(f.children.length, 0);
});
