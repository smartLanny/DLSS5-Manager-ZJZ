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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-unreal-'));
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
