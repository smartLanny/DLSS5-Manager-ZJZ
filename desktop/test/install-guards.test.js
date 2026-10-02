'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createInstallGuards } = require('../src/core/install-guards');
const { normalizeError } = require('../src/product/errors');

const root = path.resolve('guard-fixture-game');
const game = path.join(root, 'NBA2K27.exe');
const manager = path.join(root, 'Manager', 'DLSS 5 AI 超分管理器.exe');
const portable = path.join(root, 'DLSS5-Manager-portable-renamed.exe');

function row(ProcessId, ParentProcessId, Name, ExecutablePath) {
  return { ProcessId, ParentProcessId, Name, ExecutablePath };
}

test('Manager process family is ignored only with exact path and process relationships', () => {
  const rows = [
    row(100, 90, 'DLSS 5 AI 超分管理器.exe', manager.toUpperCase()),
    row(101, 100, 'DLSS 5 AI 超分管理器.exe', manager.toUpperCase()),
    row(102, 101, 'DLSS 5 AI 超分管理器.exe', manager),
    row(90, 1, 'renamed-portable.exe', portable.toUpperCase()),
    row(110, 100, 'NBA2K27.exe', game),
    row(111, 100, 'helper.exe', path.join(root, 'tools', 'helper.exe')),
    row(112, 100, 'DLSS 5 AI 超分管理器.exe', path.join(root, 'other', 'DLSS 5 AI 超分管理器.exe')),
    row(114, 1, 'DLSS 5 AI 超分管理器.exe', manager)
  ];
  const guards = createInstallGuards({
    processId: 100,
    executablePath: manager,
    portableExecutablePath: portable,
    queryProcesses: async () => rows
  });
  assert.deepEqual(guards.matchingProcesses(rows, root, game).map(item => item.ProcessId), [110, 111, 112, 114]);
});

test('assertion succeeds when only the proven Manager process family is present', async () => {
  const rows = [
    row(100, 90, 'DLSS 5 AI 超分管理器.exe', manager),
    row(101, 100, 'DLSS 5 AI 超分管理器.exe', manager),
    row(102, 101, 'DLSS 5 AI 超分管理器.exe', manager),
    row(90, 1, 'renamed-portable.exe', portable)
  ];
  const guards = createInstallGuards({
    processId: 100,
    executablePath: manager,
    portableExecutablePath: portable,
    queryProcesses: async () => rows
  });
  await guards.assertGameClosed(root, game);
});

test('portable environment path is not trusted without an exact direct-parent match', () => {
  const rows = [
    row(100, 80, 'DLSS 5 AI 超分管理器.exe', manager),
    row(80, 1, 'powershell.exe', path.join(root, 'powershell.exe')),
    row(90, 1, 'DLSS5-Manager-portable-renamed.exe', portable)
  ];
  const guards = createInstallGuards({
    processId: 100,
    executablePath: manager,
    portableExecutablePath: portable
  });
  assert.deepEqual(guards.matchingProcesses(rows, root, game).map(item => item.ProcessId), [80, 90]);
});

test('selected executable identity is never hidden by Manager path exemptions', () => {
  const rows = [
    row(100, 90, 'DLSS 5 AI 超分管理器.exe', manager),
    row(101, 100, 'DLSS 5 AI 超分管理器.exe', manager),
    row(90, 1, 'renamed-portable.exe', portable)
  ];
  const guards = createInstallGuards({
    processId: 100,
    executablePath: manager,
    portableExecutablePath: portable
  });
  assert.deepEqual(guards.matchingProcesses(rows, path.dirname(manager), manager).map(item => item.ProcessId), [100, 101]);
  assert.deepEqual(guards.matchingProcesses(rows, root, portable).map(item => item.ProcessId), [90]);
});

test('real, unrelated and path-hidden game processes remain blocked with useful details', async () => {
  const rows = [
    row(100, 90, 'DLSS 5 AI 超分管理器.exe', manager),
    row(90, 1, 'renamed-portable.exe', portable),
    row(110, 100, 'NBA2K27.exe', game),
    row(111, 1, 'helper.exe', path.join(root, 'tools', 'helper.exe')),
    row(112, 1, 'NBA2K27.exe', null),
    row(113, 1, 'dlss5-feed-host64.exe', null)
  ];
  const guards = createInstallGuards({
    processId: 100,
    executablePath: manager,
    portableExecutablePath: portable,
    queryProcesses: async () => rows
  });
  let caught;
  try { await guards.assertGameClosed(root, game); } catch (error) { caught = error; }
  assert.equal(caught && caught.code, 'errGameRunning');
  assert.deepEqual(caught.details.processes, [
    { pid: 110, name: 'NBA2K27.exe', relativePath: 'nba2k27.exe', reason: '所选游戏进程仍在运行' },
    { pid: 111, name: 'helper.exe', relativePath: path.join('tools', 'helper.exe'), reason: '游戏目录内的进程仍在运行' },
    { pid: 112, name: 'NBA2K27.exe', relativePath: null, reason: '同名进程路径无法读取' },
    { pid: 113, name: 'dlss5-feed-host64.exe', relativePath: null, reason: '同名进程路径无法读取' }
  ]);
  assert.equal(JSON.stringify(caught.details).includes(root), false);
  const normalized = normalizeError(caught);
  assert.deepEqual(normalized.details, caught.details);
  assert.match(normalized.message, /NBA2K27\.exe/);
});

function unrealFixture(t) {
  // TEMP can be an 8.3 short path (C:\Users\RUNNER~1); these checks compare canonical paths.
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'guard-unreal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exe = path.join(root, 'ht', 'binaries', 'win64', 'htgame.exe');
  const reporter = path.join(root, 'engine', 'binaries', 'win64', 'crashreportclient.exe');
  for (const file of [exe, reporter]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture'); }
  const rows = [row(701, 1, 'CrashReportClient.exe', reporter)];
  const guards = createInstallGuards({ queryProcesses: async () => rows });
  return { root, exe, reporter, rows, guards };
}

test('only an ordinary independent Unreal Engine reporter with no deployment files is excluded', async t => {
  const f = unrealFixture(t);
  assert.deepEqual(f.guards.matchingProcesses(f.rows, f.root, f.exe), []);
  await f.guards.assertGameClosed(f.root, f.exe);
  f.rows.push(row(702, 1, 'HTGame.exe', f.exe));
  assert.deepEqual(f.guards.matchingProcesses(f.rows, f.root, f.exe).map(row => row.ProcessId), [702]);
  f.rows.length = 1;
  for (const name of ['dxgi.dll', 'version.dll', 'nrchain_nvngx.dll', 'test.addon64', 'ReShade.ini']) {
    const marker = path.join(path.dirname(f.reporter), name); fs.writeFileSync(marker, 'managed or external deployment');
    assert.equal(f.guards.matchingProcesses(f.rows, f.root, f.exe).length, 1, name); fs.unlinkSync(marker);
  }
});

test('a reporter beside the selected game remains blocked and reports its deployment-directory scope', async t => {
  const f = unrealFixture(t), local = path.join(path.dirname(f.exe), 'CrashReportClient.exe'); fs.writeFileSync(local, 'fixture');
  f.rows[0].ExecutablePath = local;
  await assert.rejects(f.guards.assertGameClosed(f.root, f.exe), error => {
    assert.equal(error.code, 'errGameRunning');
    assert.equal(error.details.processes[0].reason, '游戏部署目录内的进程仍在运行');
    assert.equal(error.details.processes[0].relativePath, path.relative(f.root, local).toLowerCase()); return true;
  });
  f.rows[0].ExecutablePath = f.reporter;
  assert.equal(f.guards.matchingProcesses(f.rows, f.root, f.reporter).length, 1, 'the reporter itself can be the selected EXE');
});

test('reporter exemptions never trust missing paths, hardlinks, junctions or partial directory checks', t => {
  const f = unrealFixture(t);
  const original = fs.readFileSync(f.reporter); fs.unlinkSync(f.reporter);
  assert.equal(f.guards.matchingProcesses(f.rows, f.root, f.exe).length, 1, 'a stale process path cannot prove independence');
  fs.linkSync(f.exe, f.reporter);
  assert.equal(f.guards.matchingProcesses(f.rows, f.root, f.exe).length, 1, 'same bytes via another hardlink do not prove separate identity');
  fs.unlinkSync(f.reporter); fs.writeFileSync(f.reporter, original);
  if (process.platform === 'win32') {
    const reporterDir = path.dirname(f.reporter), moved = path.join(f.root, 'engine-helper');
    fs.renameSync(reporterDir, moved); fs.symlinkSync(moved, reporterDir, 'junction');
    assert.equal(f.guards.matchingProcesses(f.rows, f.root, f.exe).length, 1, 'reparse paths remain blocked');
    fs.unlinkSync(reporterDir); fs.renameSync(moved, reporterDir);
  }
  for (let index = 0; index < 257; index++) fs.writeFileSync(path.join(path.dirname(f.reporter), `extra-${index}.bin`), 'fixture');
  assert.equal(f.guards.matchingProcesses(f.rows, f.root, f.exe).length, 1, 'over-limit directories cannot be exempted');
});

test('hidden-path matching retains the upstream selected-game and feeder rules without new reporter-name blocks', t => {
  const f = unrealFixture(t);
  const hidden = [row(711, 1, 'HTGame.exe', null), row(712, 1, 'dlss5-feed-host64.exe', null), row(713, 1, 'CrashReportClient.exe', null)];
  assert.deepEqual(f.guards.matchingProcesses(hidden, f.root, f.exe).map(row => row.ProcessId), [711, 712]);
  assert.deepEqual(f.guards.matchingProcesses(hidden, f.root, f.reporter).map(row => row.ProcessId), [712, 713]);
});

test('process-query failure remains a conservative process-check error', async () => {
  const cause = new Error('access denied');
  const guards = createInstallGuards({ queryProcesses: async () => { throw cause; } });
  await assert.rejects(guards.assertGameClosed(root, game), error =>
    error.code === 'errProcessCheck' && error.cause === cause);

  const invalid = createInstallGuards({ queryProcesses: async () => null });
  await assert.rejects(invalid.assertGameClosed(root, game), { code: 'errProcessCheck' });
});

test('every check takes a new process list, so a game started after an earlier check is still blocked', async () => {
  const rows = [row(100, 90, 'DLSS 5 AI 超分管理器.exe', manager)];
  let queries = 0;
  const guards = createInstallGuards({ processId: 100, executablePath: manager, queryProcesses: async () => { queries++; return rows.slice(); } });
  await guards.assertGameClosed(root, game);
  rows.push(row(110, 1, 'NBA2K27.exe', game));
  await assert.rejects(guards.assertGameClosed(root, game), { code: 'errGameRunning' });
  rows.pop();
  await guards.assertGameClosed(root, game);
  assert.equal(queries, 3);
});

const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createProcessHost, hostedProcesses, systemProcesses } = require('../src/core/install-guards');
const encoded = rows => Buffer.from(JSON.stringify(rows), 'utf8').toString('base64');

function fakeHost(answer) {
  const spawned = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', null, 'SIGTERM')); return true; };
    child.stdin = new Writable({ write(chunk, encoding, done) {
      for (const id of String(chunk).split('\n').filter(Boolean)) setImmediate(() => answer(id, child, spawned.length));
      done();
    } });
    spawned.push(child);
    return child;
  };
  return { spawn, spawned };
}

test('the process host answers each request with a list taken for that request and keeps running between checks', async () => {
  const lists = [[row(1, 0, 'System', null)], [row(1, 0, 'System', null), row(110, 1, '游戏.exe', 'D:\\游戏\\游戏.exe')]];
  const requests = [];
  const fake = fakeHost((id, child) => {
    requests.push(id);
    // Stray lines are ignored; only the exact answer line counts. Chunks may split a line.
    const answer = `WARNING: stray text\r\n${id} OK ${encoded(lists[requests.length - 1])}\r\n`;
    child.stdout.write(answer.slice(0, 40)); child.stdout.write(answer.slice(40));
  });
  const host = createProcessHost({ spawn: fake.spawn });
  assert.deepEqual(await host.query(), lists[0]);
  const second = await host.query();
  assert.deepEqual(second, lists[1]);
  assert.equal(second[1].ExecutablePath, 'D:\\游戏\\游戏.exe', 'non-ASCII paths arrive intact');
  assert.equal(fake.spawned.length, 1);
  assert.equal(new Set(requests).size, 2);
  assert.ok(requests.every(id => /^[0-9a-f]{32}$/.test(id)));
  host.dispose();
  assert.equal(fake.spawned[0].killed, true);
});

test('concurrent checks are answered one after another, each with its own list', async () => {
  let count = 0;
  const fake = fakeHost((id, child) => { count++; child.stdout.write(`${id} OK ${encoded([row(count, 0, `p${count}.exe`, null)])}\n`); });
  const host = createProcessHost({ spawn: fake.spawn });
  const [a, b] = await Promise.all([host.query(), host.query()]);
  assert.deepEqual([a[0].ProcessId, b[0].ProcessId], [1, 2]);
});

test('a host that never answers correctly is stopped and the one-shot query is used for the rest of the session', async t => {
  for (const [name, answer, options] of [
    ['exit', (id, child) => child.emit('exit', 1, null), {}],
    ['garbled', (id, child) => child.stdout.write(`${id} OK not-base64!\n`), {}],
    ['wrong id', (id, child) => child.stdout.write(`${'0'.repeat(32)} OK ${encoded([])}\n`), {}],
    ['timeout', () => {}, { timeoutMs: 20 }]
  ]) {
    await t.test(name, async () => {
      const fake = fakeHost(answer);
      const host = createProcessHost({ spawn: fake.spawn, ...options });
      let oneShot = 0;
      const fallback = async () => { oneShot++; return [row(7, 0, 'one-shot.exe', null)]; };
      assert.deepEqual(await hostedProcesses(host, fallback), [row(7, 0, 'one-shot.exe', null)]);
      assert.equal(fake.spawned[0].killed, true);
      assert.equal(host.usable, false);
      await hostedProcesses(host, fallback);
      assert.equal(fake.spawned.length, 1, 'no new host after it never answered');
      assert.equal(oneShot, 2);
    });
  }
});

test('a working host is restarted after one failure and given up after a second', async () => {
  let mode = 'ok';
  const fake = fakeHost((id, child) => mode === 'ok' ? child.stdout.write(`${id} OK ${encoded([])}\n`) : child.emit('exit', 1, null));
  const host = createProcessHost({ spawn: fake.spawn });
  const fallback = async () => 'one-shot';
  assert.deepEqual(await hostedProcesses(host, fallback), []);
  mode = 'exit';
  assert.equal(await hostedProcesses(host, fallback), 'one-shot');
  assert.equal(host.usable, true);
  mode = 'ok';
  assert.deepEqual(await hostedProcesses(host, fallback), []);
  assert.equal(fake.spawned.length, 2);
  mode = 'exit';
  assert.equal(await hostedProcesses(host, fallback), 'one-shot');
  assert.equal(host.usable, false);
});

test('a query error inside the host falls back for that check without stopping the host', async () => {
  let calls = 0;
  const fake = fakeHost((id, child) => child.stdout.write(++calls === 1 ? `${id} ERR\n` : `${id} OK ${encoded([])}\n`));
  const host = createProcessHost({ spawn: fake.spawn });
  await assert.rejects(host.query(), { code: 'ERR_PROCESS_QUERY' });
  assert.deepEqual(await host.query(), []);
  assert.equal(fake.spawned.length, 1);
  assert.equal(fake.spawned[0].killed, false);
  host.dispose();
});

test('an idle host is stopped and a later check starts a new one', async () => {
  const fake = fakeHost((id, child) => child.stdout.write(`${id} OK ${encoded([])}\n`));
  const host = createProcessHost({ spawn: fake.spawn, idleMs: 10 });
  await host.query();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(fake.spawned[0].killed, true);
  await host.query();
  assert.equal(fake.spawned.length, 2);
  host.dispose();
});

test('the one-shot query decodes UTF-8 lists and rejects empty or garbled output', async () => {
  const rows = [row(110, 1, '测试.exe', 'D:\\测试游戏\\测试.exe')];
  assert.deepEqual(await systemProcesses(async () => `${encoded(rows)}\r\n`), rows);
  for (const output of ['', '   ', '[]', 'not base64!', encoded('text')]) {
    await assert.rejects(systemProcesses(async () => output), TypeError, JSON.stringify(output));
  }
});

test('Windows: a game in a Chinese-named folder is seen by the host and the one-shot query as soon as it starts', { skip: process.platform !== 'win32' && '只在 Windows 上运行' }, async t => {
  const { spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), '装机宅测试-'));
  const gameDir = path.join(dir, '测试游戏'), exe = path.join(gameDir, '测试游戏.exe');
  fs.mkdirSync(gameDir);
  fs.copyFileSync(process.execPath, exe); // A hardlink to the running node.exe could not be deleted afterwards.
  let child = null, exited = null;
  t.after(async () => {
    // A killed process reports signalCode, not exitCode; wait on the one exit promise.
    if (child) { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  let spawns = 0;
  const { spawnProcessHost } = require('../src/core/install-guards');
  const host = createProcessHost({ spawn: () => { spawns++; return spawnProcessHost(); } });
  t.after(() => host.dispose());
  const guards = createInstallGuards({ queryProcesses: () => host.query() });
  await guards.assertGameClosed(gameDir, exe);
  child = spawn(exe, ['-e', 'setTimeout(() => {}, 120000)'], { windowsHide: true, stdio: 'ignore' });
  exited = new Promise(resolve => child.once('exit', resolve));
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  await assert.rejects(guards.assertGameClosed(gameDir, exe), error => {
    assert.equal(error.code, 'errGameRunning');
    assert.deepEqual(error.details.processes.map(item => [item.pid, item.name, item.reason]), [[child.pid, '测试游戏.exe', '所选游戏进程仍在运行']]);
    return true;
  });
  const oneShot = createInstallGuards({ queryProcesses: () => systemProcesses() });
  await assert.rejects(oneShot.assertGameClosed(gameDir, exe), { code: 'errGameRunning' });
  child.kill(); await exited;
  await guards.assertGameClosed(gameDir, exe);
  assert.equal(spawns, 1, 'all three host checks used one PowerShell');
  assert.equal(host.usable, true);
});
