'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createLegacyRuntimeVerification } = require('../src/product/legacy-runtime-verification');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const LUID = '00000000:00014EC3';
async function fixture(t, hoyo = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-verification-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const addon = path.join(root, 'runtime/addons'); fs.mkdirSync(path.join(addon, 'host64/addons'), { recursive: true });
  const write = (file, value) => { fs.writeFileSync(file, value); return { path: file, sha256: sha(value) }; };
  const exe = write(path.join(root, 'Game.exe'), 'game');
  const specs = [{ role: 'provider', base: 'addon', target: 'provider.addon64' },
    { role: 'core', base: 'addon', target: 'host64/addons/core.addon64' },
    { role: 'host', base: 'addon', target: 'host64/host.exe' },
    { role: 'host-loader', base: 'addon', target: 'host64/dxgi.dll' }];
  if (!hoyo) specs.push({ role: 'game-loader', base: 'game', target: 'dxgi.dll' });
  const roots = { game: root, addon };
  const files = specs.map(row => ({ ...row, architecture: 'x64', ...write(path.join(roots[row.base], row.target), row.role) }));
  const loader = hoyo ? write(path.join(root, 'runtime/overlay.dll'), 'hoyo-reshade') : null;
  const context = { game: { exePath: exe.path, exeSha256: exe.sha256 },
    layout: { verified: true, exePath: exe.path, runtimeDir: path.dirname(addon), addonDirectory: addon },
    recipe: { hardwareFamily: 'RTX50', hostRequired: true, files }, ...(loader ? { loader } : {}) };
  const start = Date.now() - 4000;
  const game = { pid: 42, startedAt: new Date(start).toISOString(), exe: exe.path,
    modules: [...files.filter(row => !row.target.startsWith('host64/')).map(row => row.path), ...(loader ? [loader.path] : [])] };
  const hostSpec = files.find(row => row.role === 'host');
  const host = { pid: 43, parentPid: 42, startedAt: new Date(start + 1000).toISOString(), exe: hostSpec.path,
    modules: files.filter(row => row.target.startsWith('host64/') && row.role !== 'host').map(row => row.path) };
  const gameLog = path.join(addon, 'dlss5-feed.log'), hostLog = path.join(addon, 'host64/dlss5-feed-host.log');
  fs.writeFileSync(gameLog, '[nr-feeder-session] pid=42 source=0151-external-v1\n'); fs.writeFileSync(hostLog, 'host initialized\n');
  const state = { game, host, context, adapters: [
    { vendorId: 0x10de, software: false, description: 'NVIDIA GeForce RTX 5090', luid: '00000000:00000001' },
    { vendorId: 0x10de, software: false, description: 'NVIDIA GeForce RTX 5090', luid: LUID }] };
  const verification = createLegacyRuntimeVerification({ context: async () => state.context,
    runtime: { validateStored() {}, adapterProbe: () => ({ file: hostSpec.path, sha256: hostSpec.sha256, args: ['--list-adapters-json'] }) },
    processes: { observe: async target => [state.game, state.host].find(row => row && row.pid === target.pid && row.startedAt === target.startedAt) || null,
      find: async () => state.host ? [state.host] : [] },
    execute: async () => ({ stdout: JSON.stringify({ schema: 1, adapters: state.adapters }) }) });
  const session = { sessionId: 'session-1', targetExe: exe.path, process: game };
  await verification.prepare('game', session); await verification.matched('game', session);
  return { state, session, verification, loader, files, gameLog, hostLog,
    assess: () => verification.assess('game', session),
    append(frame = 60) {
      fs.appendFileSync(gameLog, `[nr-feeder-client-completion] frame=${frame} output_ready=1 nr_completed=1\n`);
      fs.appendFileSync(hostLog, `[nr-feeder-host-ack] pid=${state.host.pid} game_pid=42 frame=${frame} epoch=2 output_ready=1 nr_completed=1 luid=${LUID}\n`);
    } };
}
test('actual reader accepts the matching second system adapter and never reuses a completed interval', async t => {
  const f = await fixture(t); f.append();
  const result = await f.assess(); assert.equal(result.reshade.status, 'passed'); assert.equal(result.core.status, 'passed'); assert.equal(result.nr.status, 'passed', JSON.stringify(result));
  assert.equal(result.nr.evidence[0].adapter.luid, LUID); assert.equal((await f.assess()).nr.status, 'unverified');
  f.append(90); assert.equal((await f.assess()).nr.status, 'passed');
  f.session.historical = true; assert.equal((await f.assess()).nr.status, 'unverified');
});
test('HoYo loader must be loaded in the game even when the host completes NR', async t => {
  const f = await fixture(t, true); f.state.game.modules = f.state.game.modules.filter(file => file !== f.loader.path); f.append();
  const missing = await f.assess(); assert.equal(missing.core.status, 'passed'); assert.equal(missing.reshade.status, 'unverified'); assert.equal(missing.nr.status, 'unverified');
  f.state.game.modules.push(f.loader.path); f.append(90); assert.equal((await f.assess()).nr.status, 'passed');
});
test('host recreation establishes a new baseline and needs new completion from the new host', async t => {
  const f = await fixture(t); f.append(); assert.equal((await f.assess()).nr.status, 'passed');
  f.state.host = { ...f.state.host, pid: 44, startedAt: new Date(Date.now() - 500).toISOString() };
  fs.writeFileSync(f.hostLog, 'host recreated\n'); f.append(90);
  assert.match((await f.assess()).nr.detail, /重建/); assert.equal((await f.assess()).nr.status, 'unverified');
  f.append(120); assert.equal((await f.assess()).nr.status, 'passed');
});
test('module mutation, foreign host and context changes cannot produce verified processing', async t => {
  const f = await fixture(t); f.append(); f.state.host.parentPid = 999;
  assert.equal((await f.assess()).nr.status, 'unverified'); f.state.host.parentPid = 42;
  fs.writeFileSync(f.files.find(row => row.role === 'core').path, 'changed'); assert.equal((await f.assess()).nr.status, 'unverified');
  f.state.context = { ...f.state.context, recipe: { ...f.state.context.recipe, revision: 2 } }; assert.match((await f.assess()).nr.detail, /改变/);
});
test('unsupported or missing system adapters cannot borrow a matching LUID from logs', async t => {
  const f = await fixture(t); f.append(); f.state.adapters = [{ vendorId: 0x10de, software: false, description: 'NVIDIA GeForce RTX 3090', luid: LUID }];
  assert.equal((await f.assess()).nr.status, 'unverified'); f.state.adapters = [];
  assert.equal((await f.assess()).nr.status, 'unverified');
});
