'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createLegacyEvidenceReader } = require('../src/product/legacy-runtime-evidence');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const LUID = '00000000:00014EC3';
async function fixture(t, hostRequired = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-evidence-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const addon = path.join(root, 'runtime/addons'), exe = path.join(root, 'Game.exe'); fs.mkdirSync(path.join(addon, 'host64/addons'), { recursive: true }); fs.writeFileSync(exe, 'game');
  const files = [{ role: 'game-loader', base: 'game', target: 'dxgi.dll' }, { role: 'provider', base: 'addon', target: 'provider.addon64' },
    { role: 'core', base: 'addon', target: hostRequired ? 'host64/addons/core.addon64' : 'core.addon64' }];
  if (hostRequired) files.push({ role: 'host', base: 'addon', target: 'host64/host.exe' }, { role: 'host-loader', base: 'addon', target: 'host64/dxgi.dll' });
  const roots = { game: root, addon }, components = files.map(row => { const file = path.join(roots[row.base], row.target); fs.writeFileSync(file, row.role); return { ...row, architecture: 'x64', sha256: sha(row.role), path: file }; });
  const gameLog = path.join(addon, 'dlss5-feed.log'), hostLog = path.join(addon, 'host64/dlss5-feed-host.log');
  fs.writeFileSync(gameLog, '[nr-feeder-session] pid=42 source=0151-external-v1\n'); fs.writeFileSync(hostLog, 'host initialized\n');
  const start = Date.now() - 3000, game = { pid: 42, startedAt: new Date(start).toISOString(), exePath: exe, exeSha256: sha('game'), modules: components.filter(row => !row.target.startsWith('host64/')) };
  const hostFile = components.find(row => row.role === 'host');
  const host = { pid: 43, parentPid: 42, startedAt: new Date(start + 1000).toISOString(), exePath: hostFile?.path, exeSha256: hostFile?.sha256, modules: components.filter(row => row.target.startsWith('host64/') && row.role !== 'host') };
  const reader = createLegacyEvidenceReader({ validateRecipe: () => {} });
  const cursor = await reader.prepareLegacyEvidence({ game: { exePath: exe, exeSha256: sha('game') }, layout: { verified: true, exePath: exe, runtimeDir: path.dirname(addon), addonDirectory: addon }, recipe: { files: components, hostRequired }, liveGame: game });
  return { ...reader, cursor, gameLog, hostLog, game, host,
    assess: overrides => reader.assessLegacyEvidence({ cursor, liveProcesses: hostRequired ? [game, host] : [game], expectedHardwareLuid: LUID, ...overrides }),
    append(frame = 60, nr = 1) {
      fs.appendFileSync(gameLog, hostRequired ? `[nr-feeder-client-completion] frame=${frame} output_ready=1 nr_completed=${nr}\n` : `[nr-feeder-device] pid=42 epoch=2 luid=${LUID}\n[nr-feeder-completion] frame=${frame} epoch=2 nr_completed=1 output_recorded=1 provenance=Synthetic\n`);
      if (hostRequired) fs.appendFileSync(hostLog, `[nr-feeder-host-ack] pid=43 game_pid=42 frame=${frame} epoch=2 output_ready=1 nr_completed=${nr} luid=${LUID}\n`);
    } };
}
test('fresh host acknowledgements require live matching game, host, modules, adapter and same frame', async t => {
  const f = await fixture(t); f.append();
  assert.equal((await f.assess({ expectedHardwareLuid: '00000000:00000001' })).processed, false);
  assert.equal((await f.assess({ liveProcesses: [f.game, { ...f.host, parentPid: 99 }] })).processed, false);
  assert.equal((await f.assess({ liveProcesses: [f.game, { ...f.host, modules: [] }] })).processed, false);
  const result = await f.assess(); assert.equal(result.processed, true); assert.equal(result.runtimeVerified, true); assert.equal(result.newFrames, 1); assert.equal(result.frame, 60);
  assert.equal((await f.assess()).processed, false); // Success cannot be reused without a new frame.
  f.append(90); assert.equal((await f.assess()).processed, true);
});
test('exited or reused process IDs and forged cursors cannot inherit a successful session', async t => {
  const f = await fixture(t); f.append();
  assert.equal((await f.assess({ liveProcesses: [f.host] })).reason, 'game-process-no-longer-matches');
  assert.equal((await f.assess({ liveProcesses: [{ ...f.game, startedAt: new Date().toISOString() }, f.host] })).processed, false);
  assert.equal((await f.assess({ cursor: { ...f.cursor } })).reason, 'session-cursor-unavailable');
  assert.equal((await f.assess({ liveProcesses: [{ ...f.game, exeSha256: 'a'.repeat(64) }, f.host] })).processed, false);
});
test('declines, stale frames, different host frames and later retention do not establish processing', async t => {
  const f = await fixture(t); f.append(60, 0); assert.equal((await f.assess()).processed, false);
  fs.appendFileSync(f.gameLog, '[nr-feeder-client-completion] frame=90 output_ready=1 nr_completed=1\n');
  assert.equal((await f.assess()).processed, false);
  f.append(120); fs.appendFileSync(f.gameLog, '[nr-feeder-client-retained] host lost\n'); assert.equal((await f.assess()).processed, false);
});
test('truncated or replaced logs fail closed even if new text contains a successful frame', async t => {
  const f = await fixture(t); fs.writeFileSync(f.gameLog, 'short\n'); assert.equal((await f.assess()).reason, 'log-replaced-or-truncated');
  const other = await fixture(t); fs.renameSync(other.hostLog, other.hostLog + '.old'); fs.writeFileSync(other.hostLog, 'replacement\n'); other.append();
  assert.equal((await other.assess()).reason, 'log-replaced-or-truncated');
});
test('native processing needs a new completion and actual device LUID in this process generation', async t => {
  const f = await fixture(t, false); assert.equal((await f.assess()).processed, false); f.append();
  const result = await f.assess(); assert.equal(result.host, null); assert.equal(result.targetLoader, true); assert.equal(result.processed, true);
  assert.equal((await f.assess()).processed, false);
});
test('long verification intervals use bounded new tail records while keeping old-generation anchors', async t => {
  const f = await fixture(t);
  fs.appendFileSync(f.gameLog, 'ordinary status line\n'.repeat(20000)); fs.appendFileSync(f.hostLog, 'ordinary host line\n'.repeat(20000)); f.append(900);
  assert.equal((await f.assess()).processed, true);
  const rewritten = fs.readFileSync(f.gameLog, 'utf8').replace('pid=42', 'pid=43'); fs.writeFileSync(f.gameLog, rewritten); f.append(930);
  assert.equal((await f.assess()).reason, 'log-rewritten');
});
