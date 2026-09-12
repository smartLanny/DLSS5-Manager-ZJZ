'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createInstaller } = require('../src/product/installer');
const { compileNativeAddonPolicy } = require('../src/product/native-addon-policy');
const { createBundle, inspectPayload, sha256 } = require('../src/product/payload');
const { PAYLOAD_FILES, INSTALLED_NAMES } = require('../src/product/constants');
const { readManifest, manifestPath } = require('../src/product/manifest');
const journal = require('../src/core/file-journal');

// Minimal x64 data-only PE with a real NAME export. It is parsed as bytes;
// neither the fixture nor the installer loads an Add-on into a process.
function addonBytes(name, marker = '') {
  const b = Buffer.alloc(0x800), p = 0x80, o = p + 24, section = o + 0xf0;
  b.write('MZ'); b.writeUInt32LE(p, 0x3c); b.write('PE\0\0', p); b.writeUInt16LE(0x8664, p + 4);
  b.writeUInt16LE(1, p + 6); b.writeUInt16LE(0xf0, p + 20); b.writeUInt16LE(0x20b, o);
  b.writeBigUInt64LE(0x180000000n, o + 24); b.writeUInt32LE(0x200, o + 60);
  b.writeUInt32LE(0x1000, o + 112); b.writeUInt32LE(0x90, o + 116); b.write('.data', section);
  b.writeUInt32LE(0x600, section + 8); b.writeUInt32LE(0x1000, section + 12);
  b.writeUInt32LE(0x600, section + 16); b.writeUInt32LE(0x200, section + 20);
  b.writeUInt32LE(1, 0x214); b.writeUInt32LE(1, 0x218); b.writeUInt32LE(0x1040, 0x21c);
  b.writeUInt32LE(0x1044, 0x220); b.writeUInt32LE(0x1048, 0x224);
  b.writeUInt32LE(0x1100, 0x240); b.writeUInt32LE(0x1050, 0x244); b.write('NAME\0', 0x250);
  b.writeBigUInt64LE(0x180001140n, 0x300); b.write(name + '\0', 0x340); b.write(marker, 0x500);
  return b;
}
function fileState(root, includeTime = false) {
  const rows = {};
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else { const stat = fs.statSync(file); rows[path.relative(root, file)] = { sha256: sha256(file), size: stat.size,
        ...(includeTime ? { mtimeMs: stat.mtimeMs } : {}) }; }
    }
  }
  visit(root); return rows;
}
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-addon-integration-'));
  const gameDir = path.join(root, 'game'), exeDir = path.join(gameDir, 'Bin'), exe = path.join(exeDir, 'Game.exe');
  const payloadDir = path.join(root, 'payload'), ini = path.join(exeDir, 'ReShade.ini');
  fs.mkdirSync(exeDir, { recursive: true }); fs.mkdirSync(payloadDir);
  fs.writeFileSync(exe, addonBytes('Synthetic test executable'));
  fs.writeFileSync(path.join(exeDir, 'dxgi.dll'), addonBytes('ReShade', 'ReShade Searching for add-ons'));
  fs.writeFileSync(ini, '[ADDON]\r\nAddonPath=.\r\n[STYLE]\r\nFont=Original font\r\n[INPUT]\r\nKeyOverlay=120,1,0,0\r\n');
  for (const [kind, name] of Object.entries(PAYLOAD_FILES)) fs.writeFileSync(path.join(payloadDir, name),
    kind === 'addon' ? addonBytes('Selected NR Core', 'NRBeforeSR') : kind === 'reshade' ? addonBytes('ReShade', 'ReShade Searching for add-ons')
      : kind === 'config' ? '[NR]\nEnabled=1\n' : 'Synthetic payload ' + kind);
  fs.writeFileSync(path.join(payloadDir, 'bundle.json'), JSON.stringify(createBundle(payloadDir)));
  const payload = Object.fromEntries(inspectPayload(payloadDir).files.map(row => [row.kind, row]));
  const scan = { chosen: { path: exe, rel: path.relative(gameDir, exe), bitness: 64, api: 'dxgi', apiLabel: 'DirectX 12',
    apiResolution: { api: 'dx12', source: 'synthetic-fixture' }, emulator: null }, primaryDlss: { name: 'nvngx_dlss.dll' }, emulator: null };
  const game = { id: 'native-addon-policy-fixture', dir: gameDir, scan };
  let copyCount = 0;
  const installer = createInstaller({ journal, scan: { scanGame: async () => scan,
    inspectReShade: dir => ({ installed: fs.existsSync(path.join(dir, 'dxgi.dll')), addonSupport: true, file: 'dxgi.dll' }) },
    guards: { antiCheatPresent: () => false, assertGameClosed: async () => {} }, pe: { getBitness: () => 64 },
    copyFile: async (source, target) => { copyCount++; if (overrides.copyFile) return overrides.copyFile(source, target); return fsp.copyFile(source, target); } });
  const put = (rel, name = 'Unreviewed user Add-on') => {
    const file = path.join(exeDir, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, addonBytes(name)); return file;
  };
  const policy = extra => compileNativeAddonPolicy({ game, payloadDir, payload, manifest: readManifest(gameDir), ...extra });
  const install = addonPolicy => installer.install({ gameDir, payload, scan, addonPolicy });
  const restore = () => installer.uninstall({ gameDir, scan, mode: 'restore', removeSettings: true });
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, gameDir, exeDir, exe, ini, game, scan, payload, payloadDir, installer, put, policy, install, restore, copyCount: () => copyCount };
}
function assertNoPending(f) { assert.equal(fs.existsSync(journal.pendingPath(f.gameDir)), false); }

test('native install isolates only unknown active addons, preserves inactive subdirectories and ordinary DLLs, then restores originals', async t => {
  const f = fixture(t), active = f.put('neutral.addon64'), nested = f.put('inactive/hidden.addon64'), dll = f.put('ordinary.dll');
  const before = new Map([active, nested, dll, f.ini].map(file => [file, fs.readFileSync(file)]));
  const p = await f.policy();
  assert.deepEqual(p.plan.isolate.map(row => row.path), [active]);
  assert.equal(p.snapshot.files.some(row => row.path === nested || row.path === dll), false);
  assert.equal((await f.install(p)).complete, true);
  const manifest = readManifest(f.gameDir), conflict = manifest.conflicts.find(row => row.sourceRel === path.relative(f.gameDir, active));
  assert.ok(conflict); assert.equal(conflict.category, 'unverified-addon'); assert.equal(fs.existsSync(active), false);
  assert.deepEqual(fs.readFileSync(path.join(f.gameDir, conflict.backupRel)), before.get(active));
  for (const file of [nested, dll, f.ini]) assert.deepEqual(fs.readFileSync(file), before.get(file));
  assert.ok(fs.existsSync(path.join(f.exeDir, INSTALLED_NAMES.addon))); assertNoPending(f);
  await f.restore();
  for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.existsSync(path.join(f.exeDir, INSTALLED_NAMES.addon)), false); assertNoPending(f);
});

test('explicit LoadFromDllMain bypasses DisabledAddons, isolates only that plugin and restores the exact original INI', async t => {
  const f = fixture(t), early = f.put('disabled-@owner.addon64', 'Early Plugin'), retained = f.put('retained.addon64', 'Retained HDR');
  const original = '[ADDON]\r\nAddonPath=.\r\nDisabledAddons=Early Plugin@disabled-@owner.addon64\r\nLoadFromDllMain=disabled-@owner.addon64,retained.addon64,dxgi.dll\r\n[STYLE]\r\nFont=Personal font\r\n[INPUT]\r\nKeyOverlay=120,1,0,0\r\n';
  fs.writeFileSync(f.ini, original); const originalAddon = fs.readFileSync(early), retainedBytes = fs.readFileSync(retained);
  const p = await f.policy({ knownComponents: [{ path: retained, sha256: sha256(retained), role: 'renodx-hdr', compatibility: 'compatible' }] });
  const row = p.plan.decisions.find(value => value.path === early);
  assert.equal(row.explicit, true); assert.equal(row.moduleMayLoad, true); assert.equal(row.action, 'isolate');
  await f.install(p);
  assert.equal(fs.readFileSync(f.ini, 'utf8'), original.replace('LoadFromDllMain=disabled-@owner.addon64,', 'LoadFromDllMain='));
  assert.equal(fs.existsSync(early), false); assert.deepEqual(fs.readFileSync(retained), retainedBytes);
  const manifest = readManifest(f.gameDir), iniBackup = path.join(f.gameDir, manifest.addonConfigOriginal.backupRel);
  assert.equal(fs.readFileSync(iniBackup, 'utf8'), original);
  await f.restore(); assert.equal(fs.readFileSync(f.ini, 'utf8'), original); assert.deepEqual(fs.readFileSync(early), originalAddon);
  assert.deepEqual(fs.readFileSync(retained), retainedBytes); assertNoPending(f);
});

test('explicit keep binds the observed path, hash and config, while changed config or plugin refuses deployment without target writes', async t => {
  for (const mutation of ['none', 'config', 'plugin']) {
    const f = fixture(t), plugin = f.put('user.addon64'), observation = await f.policy();
    const keep = [{ path: plugin, sha256: sha256(plugin), configFingerprint: observation.snapshot.configFingerprint }];
    const p = await f.policy({ addonKeep: keep });
    assert.equal(p.plan.decisions.find(row => row.path === plugin).action, 'keep');
    if (mutation === 'config') fs.appendFileSync(f.ini, '\r\n[Personal]\r\nNew=1\r\n');
    if (mutation === 'plugin') fs.appendFileSync(plugin, Buffer.from('external change'));
    const before = fileState(f.gameDir, true);
    if (mutation === 'none') {
      await f.install(p); assert.equal(sha256(plugin), keep[0].sha256); assert.equal(readManifest(f.gameDir).conflicts.length, 0);
    } else {
      await assert.rejects(f.install(p), { code: 'ADDON_PLAN_CHANGED' });
      assert.equal(f.copyCount(), 0); assert.deepEqual(fileState(f.gameDir, true), before);
      assert.equal(fs.existsSync(manifestPath(f.gameDir)), false);
      const fresh = await f.policy({ addonKeep: keep }); assert.ok(fresh.plan.blockers.some(row => row.code === 'ADDON_KEEP_STALE'));
    }
    assertNoPending(f);
  }
});

test('known renamed previous Core and carrier must retire and cannot be retained beside the selected Core', async t => {
  const f = fixture(t), core = f.put('neutral-old.addon64', 'Prior project Core'), carrier = f.put('neutral-bridge.addon64', 'Prior project Bridge');
  const originals = new Map([core, carrier].map(file => [file, fs.readFileSync(file)]));
  const knownComponents = [{ sha256: sha256(core), role: 'core' }, { sha256: sha256(carrier), role: 'carrier' }];
  const initial = await f.policy({ knownComponents });
  assert.deepEqual(initial.plan.retire.map(row => row.path).sort(), [core, carrier].sort());
  const addonKeep = [core, carrier].map(file => ({ path: file, sha256: sha256(file), configFingerprint: initial.snapshot.configFingerprint }));
  const forbidden = await f.policy({ knownComponents, addonKeep }), before = fileState(f.gameDir, true);
  assert.equal(forbidden.plan.blockers.filter(row => row.code === 'ADDON_KEEP_FORBIDDEN').length, 2);
  await assert.rejects(f.install(forbidden), { code: 'ADDON_POLICY_BLOCKED' });
  assert.equal(f.copyCount(), 0); assert.deepEqual(fileState(f.gameDir, true), before);
  await f.install(await f.policy({ knownComponents }));
  assert.equal(fs.existsSync(core), false); assert.equal(fs.existsSync(carrier), false);
  assert.equal(readManifest(f.gameDir).conflicts.filter(row => row.category === 'own-core-upgrade').length, 2);
  assert.deepEqual(fs.readdirSync(f.exeDir).filter(name => name.endsWith('.addon64')), [INSTALLED_NAMES.addon]);
  await f.restore(); for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(file), bytes);
  assertNoPending(f);
});

test('late native payload failure rolls back real isolation, original INI and partial deployment in one file transaction', async t => {
  let f, reached = false;
  f = fixture(t, { copyFile: async (source, target) => {
    if (target === path.join(f.exeDir, INSTALLED_NAMES.runtime)) {
      reached = true;
      assert.equal(fs.existsSync(path.join(f.exeDir, 'early.addon64')), false);
      assert.equal(fs.readFileSync(f.ini, 'utf8').includes('LoadFromDllMain=early.addon64'), false);
      assert.equal(fs.existsSync(path.join(f.exeDir, INSTALLED_NAMES.addon)), true);
      throw Object.assign(new Error('Injected failure after isolation, INI edit and Core copy'), { code: 'LATE_COPY_FAILURE' });
    }
    return fsp.copyFile(source, target);
  } });
  f.put('early.addon64'); fs.writeFileSync(f.ini, '[ADDON]\nAddonPath=.\nLoadFromDllMain=early.addon64\n[STYLE]\nFont=Original\n');
  const before = fileState(f.gameDir);
  await assert.rejects(f.install(await f.policy()), { code: 'LATE_COPY_FAILURE' });
  assert.equal(reached, true); assert.deepEqual(fileState(f.gameDir), before); assertNoPending(f);
});

test('native restore preserves later user INI edits and the original INI backup while restoring isolated plugins', async t => {
  const f = fixture(t), plugin = f.put('early.addon64'), pluginBytes = fs.readFileSync(plugin);
  const original = '[ADDON]\r\nAddonPath=.\r\nLoadFromDllMain=early.addon64\r\n[STYLE]\r\nFont=Original\r\n';
  fs.writeFileSync(f.ini, original); await f.install(await f.policy());
  const manifest = readManifest(f.gameDir), backup = path.join(f.gameDir, manifest.addonConfigOriginal.backupRel);
  const external = fs.readFileSync(f.ini, 'utf8').replace('Font=Original', 'Font=Later personal font') + '\r\n[Personal]\r\nKeep=1\r\n';
  fs.writeFileSync(f.ini, external);
  const result = await f.restore();
  assert.ok(result.warnings.some(row => row.code === 'CONFIG_EDITED_RETAINED'));
  assert.equal(fs.readFileSync(f.ini, 'utf8'), external); assert.equal(fs.readFileSync(backup, 'utf8'), original);
  assert.deepEqual(fs.readFileSync(plugin), pluginBytes); assertNoPending(f);
});

for (const exists of [false, true]) test(`native install records and restores a ${exists ? 'missing-key existing' : 'new'} ReShade INI with the Home default`, async t => {
  const f = fixture(t), original = '[STYLE]\r\nFont=User font\r\n';
  if (exists) fs.writeFileSync(f.ini, original); else fs.unlinkSync(f.ini);
  const p = await f.policy();
  assert.equal(p.configEdit.beforeSha256, exists ? sha256(f.ini) : null);
  assert.match(p.configEdit.afterText, /KeyOverlay=36,0,0,0/);
  assert.equal(fs.existsSync(f.ini), exists, 'preview never creates the default config');
  await f.install(p); assert.equal(sha256(f.ini), p.configEdit.afterSha256);
  assert.equal(readManifest(f.gameDir).addonConfigOriginal.existed === false, !exists);
  await f.restore(); assert.equal(fs.existsSync(f.ini), exists);
  if (exists) assert.equal(fs.readFileSync(f.ini, 'utf8'), original);
});

test('native defaults retain subsequent personal edits to a newly created ReShade INI on restore', async t => {
  const f = fixture(t); fs.unlinkSync(f.ini); await f.install(await f.policy());
  const personal = fs.readFileSync(f.ini, 'utf8').replace('36,0,0,0', '121,1,0,1') + '[STYLE]\nFont=Personal\n';
  fs.writeFileSync(f.ini, personal);
  const result = await f.restore(); assert.ok(result.warnings.some(row => row.code === 'CONFIG_EDITED_RETAINED'));
  assert.equal(fs.readFileSync(f.ini, 'utf8'), personal);
});
