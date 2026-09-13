'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAppService } = require('../src/product/app-service');
const { createFeedbackCollector } = require('../src/product/feedback');

test('successful UI reads do not write operation history while failures and mutations remain recorded', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-quiet-reads-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createAppService({ userData: root, appDir: root, resourcesPath: root, overrides: { library: {}, installer: {}, detectGpu: () => ({ family: 'RTX50' }) } });
  const operations = path.join(root, 'feedback', 'operations.jsonl');
  for (const action of ['boot', 'games-refresh', 'game-icon', 'game-art', 'game-diagnose', 'launch-settings-inspect', 'nr-read']) {
    assert.equal((await service.withError(async () => 'result', { action })).ok, true);
  }
  assert.equal(fs.existsSync(operations), false);
  assert.equal((await service.withError(async () => { throw new Error('failed read'); }, { action: 'game-diagnose' })).ok, false);
  await service.withError(async () => true, { action: 'game-install' });
  const rows = fs.readFileSync(operations, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => [row.action, row.ok]), [['game-diagnose', false], ['game-install', true]]);
});

test('feedback reads at most 256 KiB from a large runtime log', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-bounded-feedback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'ReShade.log');
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, 64 * 1024 * 1024);
  fs.writeSync(fd, Buffer.from('STARTUP_BUILD_IDENTITY\n'), 0, 23, 0);
  fs.writeSync(fd, Buffer.from('LATEST_RELEVANT_ERROR\n'), 0, 22, 64 * 1024 * 1024 - 22); fs.closeSync(fd);
  const originalOpen = fs.promises.open.bind(fs.promises); let readBytes = 0;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === file) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => { const result = await read(...readArgs); readBytes += result.bytesRead; return result; };
    }
    return handle;
  });
  const collector = createFeedbackCollector({ userData: path.join(root, 'user') });
  const report = await collector.buildReport({ game: { dir: root, chosen: { path: path.join(root, 'Game.exe') } } });
  assert.ok(readBytes > 0 && readBytes <= 256 * 1024, 'large logs must stay within the I/O budget');
  assert.match(report.text, /STARTUP_BUILD_IDENTITY/); assert.match(report.text, /LATEST_RELEVANT_ERROR/);
  assert.match(report.text, /省略中间日志/);
});

test('rendering a completed scan does not scan again, and a failed refresh can be retried', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-scan-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let scans = 0;
  const service = createAppService({ userData: root, appDir: root, resourcesPath: root, overrides: { library: { scanAll: async () => {
    scans++; if (scans === 2) throw new Error('temporary scan failure'); return [];
  } }, installer: {}, detectGpu: () => ({ family: 'RTX50' }) } });
  await service.refresh(); await service.listGames(); await service.listGames(); assert.equal(scans, 1);
  await assert.rejects(service.refresh(), /temporary scan failure/); await service.listGames(); assert.equal(scans, 3);
});
