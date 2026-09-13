'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createAppService } = require('../src/product/app-service');
const { createLibraryWorkerClient } = require('../src/product/library-worker-client');
const { createCompactBundle } = require('../src/product/payload');
const { PAYLOAD_FILES } = require('../src/product/constants');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'library-refresh-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function fixture(t) {
  const root = temporary(t), gameDir = path.join(root, 'game'), exe = path.join(gameDir, 'Game.exe');
  fs.mkdirSync(gameDir); fs.writeFileSync(exe, 'synthetic selected executable');
  const payload = path.join(root, 'payload', 'nr-before-sr'), version = '0.3.3.5';
  for (const family of ['RTX40', 'RTX50']) {
    const dir = path.join(payload, 'fixed', family); fs.mkdirSync(dir, { recursive: true });
    for (const name of ['ReShade64.dll', 'nrchain_nvngx.dll', 'nvngx_dlssnr.dll']) fs.writeFileSync(path.join(dir, name), `${family}:${name}`);
  }
  const versionDir = path.join(payload, 'versions', version); fs.mkdirSync(versionDir, { recursive: true });
  for (const name of [PAYLOAD_FILES.addon, PAYLOAD_FILES.config]) fs.writeFileSync(path.join(versionDir, name), `fixture:${name}`);
  fs.writeFileSync(path.join(payload, 'bundle.json'), JSON.stringify(createCompactBundle(payload, [{ id: version, label: version }], version)));

  let installed = false, hold = null, failNext = false;
  const calls = [];
  const library = { scanAll: async (_state, revision) => {
    const chosen = { path: exe, api: 'dxgi', apiLabel: 'DirectX 12', dx12: true, bitness: 64 };
    const rows = [{ id: 'g', name: 'Fixture game', dir: gameDir, installed, chosen, scan: { chosen } }];
    calls.push({ installed, revision });
    if (failNext) { failNext = false; throw new Error('synthetic refresh failure'); }
    if (hold) { const current = hold; hold = null; current.started(); await current.wait; }
    return rows;
  } };
  const service = createAppService({ userData: path.join(root, 'user'), appDir: root, resourcesPath: root,
    overrides: { library, detectGpu: () => ({ family: 'RTX50', series: ['RTX50'] }), installer: {
      install: async () => { installed = true; return { installed: true }; },
      uninstall: async () => { installed = false; return { removed: true }; }
    } } });
  return { service, calls, version, failNextScan: () => { failNext = true; },
    holdNextScan() {
      let release, started;
      const wait = new Promise(resolve => { release = resolve; });
      const ready = new Promise(resolve => { started = resolve; });
      hold = { wait, started };
      return { ready, release };
    }
  };
}

test('completed install and uninstall refresh once and subsequent list reads use fresh snapshots', async t => {
  const f = fixture(t);
  assert.equal((await f.service.refresh())[0].installed, false);
  assert.deepEqual(await f.service.install('g', { version: f.version }), { installed: true });
  assert.equal((await f.service.listGames())[0].installed, true);
  await f.service.listGames(); assert.equal(f.calls.length, 2, 'install performs one scan; rendering does not repeat it');
  assert.deepEqual(await f.service.uninstall('g'), { removed: true });
  assert.equal((await f.service.listGames())[0].installed, false);
  await f.service.listGames(); assert.equal(f.calls.length, 3, 'uninstall performs one scan; rendering does not repeat it');
});

test('a scan started before mutation cannot replace the post-mutation snapshot', async t => {
  const f = fixture(t); await f.service.refresh();
  const held = f.holdNextScan(), oldRefresh = f.service.refresh(); await held.ready;
  try {
    await f.service.install('g', { version: f.version });
    assert.equal((await f.service.listGames())[0].installed, true);
    assert.equal(f.calls.length, 3, 'mutation starts a new scan even when settings are unchanged');
    assert.notEqual(f.calls[1].revision, f.calls[2].revision, 'worker receives a new disk revision');
  } finally { held.release(); }
  assert.equal((await oldRefresh)[0].installed, true, 'old caller receives the current snapshot');
  assert.equal((await f.service.listGames())[0].installed, true, 'late old result cannot overwrite the collection');
});

test('a committed mutation remains successful when scanning fails and a list read retries', async t => {
  const f = fixture(t); await f.service.refresh(); f.failNextScan();
  assert.deepEqual(await f.service.install('g', { version: f.version }), { installed: true });
  assert.equal((await f.service.listGames())[0].installed, true);
  assert.equal(f.calls.length, 3, 'failed post-mutation scan leaves the snapshot stale and retryable');
});

test('worker scan revisions bypass singleflight without leaking an extra library argument', async t => {
  const root = temporary(t), workerFile = path.join(root, 'revision-worker.cjs');
  fs.writeFileSync(workerFile, `const {parentPort}=require('node:worker_threads');
    parentPort.on('message', request => setTimeout(() => parentPort.postMessage({id:request.id,ok:true,value:{requestId:request.id,args:request.args}}),40));`);
  const client = createLibraryWorkerClient({ workerFile }); t.after(() => client.dispose());
  const state = { scanDrives: false, manualGames: [] };
  const old = client.scanAll(state, 7), same = client.scanAll(state, 7), fresh = client.scanAll(state, 8);
  assert.equal(same, old);
  assert.notEqual(fresh, old);
  const [first, second] = await Promise.all([old, fresh]);
  assert.notEqual(first.requestId, second.requestId);
  assert.deepEqual(first.args, [state]); assert.deepEqual(second.args, [state]);
});
