'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createVulkanRuntimeProfile } = require('../src/product/vulkan-runtime-profile');
const { createVulkanRuntimeEvidence } = require('../src/product/vulkan-runtime-evidence');

async function fixture(t, overrides) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vulkan-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = path.join(root, 'user'), packageRoot = path.join(root, 'package'); fs.mkdirSync(packageRoot);
  fs.writeFileSync(path.join(packageRoot, 'feeder.addon64'), 'fixture-pe64');
  const exe = path.join(root, 'game.exe'); fs.writeFileSync(exe, 'fixture-pe64');
  const recipe = { version: 1, id: 'evidence-runtime', coreVersion: '0.4.6-hotfix.1', sourceRevision: 'e7df0fc', architecture: 64,
    files: [{ source: 'feeder.addon64', target: 'addons/dlss5-feed-external-development.addon64', mutable: false,
      sha256: crypto.createHash('sha256').update('fixture-pe64').digest('hex') }] };
  const profile = createVulkanRuntimeProfile({ userData, pe: { getBitness: () => 64 } });
  const { basePath } = await profile.prepare({ exe, recipe, packageRoot });
  const feeder = path.join(basePath, 'addons', 'dlss5-feed.log'), reshade = path.join(basePath, 'ReShade.log');
  const feederFile = path.join(basePath, recipe.files[0].target), startedAt = Date.now() - 1000, pid = 4242;
  const input = { basePath, startedAt, pid }, service = createVulkanRuntimeEvidence({ userData, overrides });
  const loaded = `05:38:56:149 [ 3344] | INFO  | Initializing crosire's ReShade version '6.8.0.2155' (64-bit) ...\n` +
    `05:38:56:470 [ 3344] | INFO  | Loading add-on from '${feederFile}' ...\n` +
    '05:38:56:488 [ 3344] | INFO  | Registered add-on "DLSS 5 Feed 0.14.0-beta.4" v0.14.0.0 using ReShade API version 20.\n';
  const session = `05:38:56.488  [nr-vulkan-session] pid=${pid}\n`;
  const completion = '05:39:01.055  [nr-vulkan-completion] frame=73 nr_completed=1 output_recorded=1\n';
  const logs = (feedText = session + completion, reshadeText = loaded) => { fs.writeFileSync(feeder, feedText); fs.writeFileSync(reshade, reshadeText); };
  return { root, userData, input, service, basePath, feeder, reshade, feederFile, logs, loaded, session, completion };
}

test('current owned profile requires real ReShade load records and exact PID completion, without claiming presentation', async t => {
  const f = await fixture(t); f.logs();
  const result = await f.service.readEvidence(f.input);
  assert.equal(result.loaded, true); assert.equal(result.processed, true); assert.equal(result.frame, 73);
  assert.match(result.detail, /NR 完成和输出指令/); assert.match(result.detail, /实际画面仍需核对/);
  assert.equal((await f.service.readEvidence({ ...f.input, startedAt: new Date(f.input.startedAt).toISOString() })).processed, true);
});

test('absent, stale, locked and continuously changing logs remain unknown', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.readEvidence(f.input), { loaded: 'unknown', processed: 'unknown', detail: '本次 Feeder 日志缺失、被占用或正在变化，暂无法确认处理结果。' });
  f.logs(); const old = new Date(f.input.startedAt - 1000); fs.utimesSync(f.feeder, old, old); fs.utimesSync(f.reshade, old, old);
  const stale = await f.service.readEvidence(f.input); assert.equal(stale.loaded, 'unknown'); assert.equal(stale.processed, 'unknown');
  f.logs();
  const denied = createVulkanRuntimeEvidence({ userData: f.userData, overrides: { async open(file, mode) {
    if (file === f.feeder) throw Object.assign(new Error('sharing violation'), { code: 'EACCES' }); return fsp.open(file, mode);
  } } });
  assert.equal((await denied.readEvidence(f.input)).loaded, true); assert.equal((await denied.readEvidence(f.input)).processed, 'unknown');
  const changing = createVulkanRuntimeEvidence({ userData: f.userData, overrides: { async open(file, mode) {
    const handle = await fsp.open(file, mode); return { stat: () => handle.stat(), close: () => handle.close(), async read(...args) {
      const result = await handle.read(...args); if (file === f.feeder) fs.appendFileSync(file, 'new frame\n'); return result;
    } };
  } } });
  assert.equal((await changing.readEvidence(f.input)).processed, 'unknown');
});

test('missing or wrong session, completion before session and later foreign PID never borrow success', async t => {
  const f = await fixture(t);
  for (const text of [f.completion, f.session.replace('4242', '4243') + f.completion, f.completion + f.session,
    f.session + f.completion + '[nr-vulkan-session] pid=9999\n', '[nr-vulkan-session] pid=4242-extra\n' + f.completion]) {
    f.logs(text); const result = await f.service.readEvidence(f.input);
    assert.equal(result.loaded, true); assert.equal(result.processed, 'unknown'); assert.equal(result.frame, undefined);
  }
});

test('full-chain-r1 negative boundary: loaded plus lease-invalid/copied=0 is never NR completion', async t => {
  const f = await fixture(t);
  // These two actual messages are the retained-original failure in full-chain-r1.
  const negative = '05:39:01.051  [feed] Vulkan project Core retained original: lease-invalid (no private Feature1/SR fallback)\n' +
    '05:39:01.055  [feed] vk identity frame=1 stable=1 copied=0 in=1 out=1 waits=1 ordered=1\n';
  f.logs(negative); assert.equal((await f.service.readEvidence(f.input)).processed, 'unknown'); // historical build had no PID marker
  f.logs(f.session + negative); const current = await f.service.readEvidence(f.input);
  assert.equal(current.loaded, true); assert.equal(current.processed, false); assert.match(current.detail, /lease-invalid/);
  assert.equal(current.frame, undefined);
  f.logs(f.session + 'F8 counters processed=120 copied=1\n[nr-vulkan-completion] frame=74 nr_completed=0 output_recorded=1\n');
  assert.equal((await f.service.readEvidence(f.input)).processed, 'unknown');
  f.logs(f.session + '[nr-vulkan-completion] frame=74 nr_completed=1 output_recorded=0\n');
  assert.equal((await f.service.readEvidence(f.input)).processed, 'unknown');
});

test('large logs only read their 4KB head and 32KB tail, and retained reasons stay bounded', async t => {
  const counts = new Map();
  const f = await fixture(t, { async open(file, mode) {
    const handle = await fsp.open(file, mode); return { stat: () => handle.stat(), close: () => handle.close(), read(buffer, offset, length, position) {
      counts.set(file, (counts.get(file) || 0) + length); return handle.read(buffer, offset, length, position);
    } };
  } });
  const padding = ('diagnostic line without completion\n').repeat(70000);
  f.logs(f.session + padding + f.completion, f.loaded + padding);
  const result = await f.service.readEvidence(f.input); assert.equal(result.loaded, true); assert.equal(result.processed, true);
  assert.ok(counts.get(f.feeder) <= 36 * 1024); assert.ok(counts.get(f.reshade) <= 36 * 1024);
  f.logs(f.session + '[feed] Vulkan project Core retained original: ' + 'x'.repeat(12000) + '\n');
  const retained = await f.service.readEvidence(f.input); assert.equal(retained.processed, false); assert.ok(retained.detail.length < 300);
});

test('other add-on names, plain file existence and textual mentions do not prove a ReShade load', async t => {
  const f = await fixture(t);
  for (const text of ['', f.loaded.replaceAll('dlss5-feed-external-development.addon64', 'other.addon64'),
    `documentation: Loading add-on from '${f.feederFile}'\nInitialize ReShade\n`]) {
    f.logs(f.session, text); assert.equal((await f.service.readEvidence(f.input)).loaded, 'unknown');
  }
  f.logs(f.session, f.loaded + `05:38:56:489 [ 3344] | ERROR | Failed to load add-on '${f.feederFile}'\n`);
  assert.equal((await f.service.readEvidence(f.input)).loaded, false);
});

test('unowned paths, malformed receipts and hardlinked logs are rejected without adopting evidence', async t => {
  const f = await fixture(t); f.logs();
  assert.equal((await f.service.readEvidence({ ...f.input, basePath: f.root })).processed, 'unknown');
  assert.equal((await f.service.readEvidence({ ...f.input, pid: 0 })).processed, 'unknown');
  const copy = path.join(f.root, 'linked-log'); fs.linkSync(f.feeder, copy);
  assert.equal((await f.service.readEvidence(f.input)).processed, 'unknown'); fs.unlinkSync(copy);
  const receiptFile = path.join(f.basePath, '.xiaofeng-vulkan-runtime.json'), bytes = fs.readFileSync(receiptFile);
  const receipt = JSON.parse(bytes); receipt.recipe.files[0].sha256 = 'a'.repeat(64); fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  const tampered = await f.service.readEvidence(f.input); assert.equal(tampered.loaded, 'unknown'); assert.equal(tampered.processed, 'unknown');
  fs.writeFileSync(receiptFile, '{invalid'); assert.equal((await f.service.readEvidence(f.input)).processed, 'unknown');
});

test('legacy complete identity still validates logs, while a copied legacy receipt under a short folder does not', async t => {
  const f = await fixture(t); f.logs();
  const file = path.join(f.basePath, '.xiaofeng-vulkan-runtime.json'), receipt = JSON.parse(fs.readFileSync(file));
  receipt.packageId = `${receipt.recipe.id}-${receipt.recipe.fingerprint.slice(0, 16)}`;
  const legacy = path.join(f.userData, 'vulkan-runtime', receipt.exeId, receipt.packageId);
  fs.writeFileSync(file, JSON.stringify(receipt));
  assert.equal((await f.service.readEvidence(f.input)).processed, 'unknown');
  fs.mkdirSync(path.dirname(legacy), { recursive: true }); fs.renameSync(f.basePath, legacy);
  fs.writeFileSync(path.join(legacy, 'ReShade.log'), f.loaded.replaceAll(f.basePath, legacy));
  const result = await f.service.readEvidence({ ...f.input, basePath: legacy });
  assert.equal(result.loaded, true); assert.equal(result.processed, true);
  receipt.exeId = receipt.exeId.slice(0, 16) + '0'.repeat(48);
  fs.writeFileSync(path.join(legacy, '.xiaofeng-vulkan-runtime.json'), JSON.stringify(receipt));
  assert.equal((await f.service.readEvidence({ ...f.input, basePath: legacy })).processed, 'unknown');
});
