'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createHoYoLauncher, validateStarwardProtocol } = require('../src/product/hoyo-launcher');
const { createLaunchSessions } = require('../src/product/launch-session');
const { HOYO_RECIPE, HOYO_CLIENTS, launcherRequest, fingerprint } = require('../src/product/hoyoshade-profiles');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t, kind = 'hoyoplay') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoyo-launch-beta3-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { force: true, recursive: true }); });
  const exe = path.join(root, '游戏安装路径 & 空格', 'YuanShen.exe'); fs.mkdirSync(path.dirname(exe)); fs.writeFileSync(exe, 'fixture game');
  const launcher = path.join(root, kind === 'starward' ? 'Starward.exe' : 'HYP.exe'); fs.writeFileSync(launcher, 'fixture launcher');
  const body = { version: 1, recipeId: HOYO_RECIPE.id, sourceCommit: HOYO_RECIPE.sourceCommit, family: 'genshin', channel: 'cn',
    releaseCategory: 'public', exePath: exe, exeSha256: digest(exe), architecture: 64, inputRoute: 'native',
    launcher: { ...launcherRequest(HOYO_CLIENTS[0], { kind, path: launcher }), sha256: digest(launcher) } };
  const binding = { ...body, bindingId: fingerprint(body) };
  const layout = { installed: true, verified: true, source: 'hoyoshade-profile', gameId: 'fixture', exe,
    hoyoProfile: binding, bindingId: binding.bindingId };
  const calls = [], order = [], broker = { launch: async row => { order.push('launcher'); calls.push(row); } };
  let protocol = { enabled: true, command: `"${launcher}" "%1"` };
  const adapter = createHoYoLauncher({ broker, readProtocol: async () => protocol, readExecutionLevel: () => 'asInvoker' });
  return { root, exe, launcher, layout, calls, order, broker, adapter, setProtocol: row => { protocol = row; } };
}

test('HoYoPlay opens the bound launcher after this helper Ready and waits for the exact game independently of NR', async t => {
  const f = fixture(t); let queries = 0;
  const helper = { prepare: async row => { f.order.push('prepare'); return { ...row, configHash: 'fixture-config' }; },
    start: async row => { f.order.push('ready'); return row; }, alive: () => true, watch: async () => {} };
  const sessions = createLaunchSessions({ userData: path.join(f.root, 'data'), broker: f.broker, helper,
    game: () => f.adapter.resolve(f.layout), launchHoYo: () => f.adapter.launch(f.layout),
    processes: { find: async () => ++queries === 1 ? [] : [{ pid: 37, exe: f.exe, startedAt: new Date().toISOString() }] } });
  const result = await sessions.start('fixture');
  assert.deepEqual(f.order, ['prepare', 'ready', 'launcher']); assert.deepEqual(f.calls, [{ exe: f.launcher, args: [], cwd: f.root }]);
  assert.equal(result.mode, 'hoyoplay'); assert.equal(result.process.pid, 37); assert.equal(result.helper.status, 'ready');
  assert.equal(result.status, 'waiting-enhancement'); assert.equal(result.runtimeVerified, false); assert.match(result.launchInstruction, /点击/);
});

test('Starward invokes only its bound executable and derived game URI, with encoded actual installation path', async t => {
  const f = fixture(t, 'starward'); const result = await f.adapter.launch(f.layout);
  assert.equal(f.calls[0].exe, f.launcher); assert.equal(f.calls[0].args.length, 1);
  assert.equal(f.calls[0].args[0], `starward://startgame/hk4e_cn?install_path=${encodeURIComponent(path.dirname(f.exe))}`);
  assert.equal(result.launchMode, 'starward');
  for (const command of [`"${f.launcher}" "%1" --extra`, `"${path.join(f.root, 'other.exe')}" "%1"`, 'cmd /c %1'])
    assert.throws(() => validateStarwardProtocol({ enabled: true, command }, { path: f.launcher }), { code: 'HOYO_LAUNCH_PROTOCOL' });
  f.setProtocol({ enabled: false, command: `"${f.launcher}" "%1"` });
  await assert.rejects(f.adapter.launch(f.layout), { code: 'HOYO_LAUNCH_PROTOCOL' }); assert.equal(f.calls.length, 1);
});

test('launcher update between Ready and dispatch stops launch and cleans only the helper', async t => {
  const f = fixture(t); let stops = 0;
  const helper = { prepare: async row => ({ ...row, configHash: 'config' }), start: async row => { fs.writeFileSync(f.launcher, 'updated launcher'); return row; },
    alive: () => true, stop: async () => { stops++; return { status: 'stopped' }; } };
  const sessions = createLaunchSessions({ userData: path.join(f.root, 'data'), broker: f.broker, helper,
    game: () => f.adapter.resolve(f.layout), launchHoYo: () => f.adapter.launch(f.layout), processes: { find: async () => [] } });
  await assert.rejects(sessions.start('fixture'), { code: 'HOYO_LAUNCH_CHANGED' });
  assert.equal(f.calls.length, 0); assert.equal(stops, 1); assert.equal(fs.readFileSync(f.exe, 'utf8'), 'fixture game');
});

test('fake Ready and launcher timeout cannot trigger direct game fallback', async t => {
  const f = fixture(t); let stopped = 0, direct = 0, time = Date.now();
  const helper = { prepare: async row => ({ ...row, configHash: 'config' }), start: async row => ({ ...row, sessionId: 'expired' }),
    alive: () => true, stop: async () => { stopped++; return { status: 'stopped' }; } };
  const options = { userData: path.join(f.root, 'data'), broker: f.broker, helper, launchDirect: () => { direct++; },
    game: () => f.adapter.resolve(f.layout), launchHoYo: () => f.adapter.launch(f.layout), processes: { find: async () => [] },
    timeoutMs: 20, pollMs: 10, now: () => time, delay: async ms => { time += ms; } };
  await assert.rejects(createLaunchSessions(options).start('fixture'), { code: 'LAUNCH_HELPER_IDENTITY' }); assert.equal(f.calls.length, 0);
  helper.start = async row => row;
  await assert.rejects(createLaunchSessions(options).start('fixture'), { code: 'LAUNCH_TARGET_TIMEOUT' });
  assert.equal(f.calls.length, 1); assert.equal(direct, 0); assert.equal(stopped, 2);
});
