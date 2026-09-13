'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { snapshotAddonLoadingLayout, assertAddonSnapshot, readRegisteredName, resolveAddonLoadState } = require('../src/product/addon-loading-layout');
const { planAddonCompatibility } = require('../src/product/addon-compatibility');
const { movePlannedConflicts, restoreConflicts } = require('../src/product/conflicts');

const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function peBytes(name, marker = '', architecture = 64) {
  const b = Buffer.alloc(0x800), p = 0x80, o = p + 24, wide = architecture === 64, optionalSize = wide ? 0xf0 : 0xe0;
  b.write('MZ'); b.writeUInt32LE(p, 0x3c); b.write('PE\0\0', p); b.writeUInt16LE(wide ? 0x8664 : 0x14c, p + 4);
  b.writeUInt16LE(1, p + 6); b.writeUInt16LE(optionalSize, p + 20); b.writeUInt16LE(wide ? 0x20b : 0x10b, o);
  if (wide) b.writeBigUInt64LE(0x180000000n, o + 24); else b.writeUInt32LE(0x400000, o + 28);
  b.writeUInt32LE(0x200, o + 60); const directory = o + (wide ? 112 : 96), section = o + optionalSize;
  b.writeUInt32LE(0x1000, directory); b.writeUInt32LE(0x90, directory + 4); b.write('.data', section);
  b.writeUInt32LE(0x600, section + 8); b.writeUInt32LE(0x1000, section + 12); b.writeUInt32LE(0x600, section + 16); b.writeUInt32LE(0x200, section + 20);
  b.writeUInt32LE(1, 0x214); b.writeUInt32LE(1, 0x218); b.writeUInt32LE(0x1040, 0x21c); b.writeUInt32LE(0x1044, 0x220); b.writeUInt32LE(0x1048, 0x224);
  b.writeUInt32LE(0x1100, 0x240); b.writeUInt32LE(0x1050, 0x244); b.write('NAME\0', 0x250);
  if (wide) b.writeBigUInt64LE(0x180001140n, 0x300); else b.writeUInt32LE(0x401140, 0x300);
  b.write(name + '\0', 0x340); b.write(marker, 0x500); return b;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-layout-beta3-')), game = path.join(root, 'game'), profile = path.join(root, 'profile'), addon = path.join(profile, 'Addons');
  fs.mkdirSync(game); fs.mkdirSync(addon, { recursive: true });
  const rootIni = path.join(game, 'ReShade.ini'), ini = path.join(profile, 'ReShade.ini');
  fs.writeFileSync(rootIni, '[INSTALL]\r\nBasePath=' + profile + '\r\n[Personal]\r\nKeep=1\r\n');
  fs.writeFileSync(ini, '[ADDON]\r\nAddonPath=.\\Addons\r\n');
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const put = (file, name = 'User Plugin', marker = '', architecture) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, peBytes(name, marker, architecture)); return file; };
  return { root, game, profile, addon, ini, rootIni, put, snapshot: () => snapshotAddonLoadingLayout({ exeDir: game, gameId: 'fixture-game', architecture: 64 }) };
}

test('actual BasePath and AddonPath drive top-level search and explicit paths; inactive roots and plain DLLs remain outside actions', async t => {
  const f = fixture(t), active = f.put(path.join(f.addon, 'unknown.addon64')), early = f.put(path.join(f.addon, 'Early.dll'));
  f.put(path.join(f.game, 'inactive.addon64')); f.put(path.join(f.addon, 'ordinary.dll')); f.put(path.join(f.addon, 'nested', 'hidden.addon64'));
  f.put(path.join(f.addon, 'wrong.addon32'), 'x86 plugin', '', 32); f.put(path.join(f.addon, 'case.ADDON64'));
  fs.appendFileSync(f.ini, 'LoadFromDllMain=.\\Early.dll\r\n');
  const snapshot = await f.snapshot(); assert.deepEqual(snapshot.blockers, []);
  assert.equal(snapshot.profile.activeConfigPath, f.ini); assert.equal(snapshot.files.find(row => row.path === early).explicit, true);
  assert.equal(snapshot.files.find(row => row.path === early).registeredName, 'User Plugin');
  const plan = planAddonCompatibility(snapshot);
  assert.deepEqual(plan.isolate.map(row => row.path).sort(), [active, early].sort());
  assert.deepEqual(plan.preserve.map(row => row.name).sort(), ['case.ADDON64', 'wrong.addon32']);
  assert.equal(snapshot.files.some(row => /ordinary|inactive|hidden/.test(row.name)), false);
});

test('first @ and exact filename preserve embedded @; name-only disabling differs from early module execution', async t => {
  const f = fixture(t), file = f.put(path.join(f.addon, 'core-@owner.addon64'), 'Registered Core');
  assert.equal(await readRegisteredName(file), 'Registered Core');
  fs.appendFileSync(f.ini, 'DisabledAddons=Registered Core@core-@owner.addon64\r\n');
  let snapshot = await f.snapshot(), row = snapshot.files[0]; assert.equal(row.filenameDisabled, true); assert.equal(row.moduleMayLoad, false);
  fs.appendFileSync(f.ini, 'LoadFromDllMain=core-@owner.addon64\r\n');
  snapshot = await f.snapshot(); row = snapshot.files[0]; assert.equal(row.explicit, true); assert.equal(row.moduleMayLoad, true); assert.equal(row.registrationDisabled, true);
  assert.equal(planAddonCompatibility(snapshot).isolate.length, 1);
  const nameOnly = resolveAddonLoadState({ name: 'core-@owner.addon64', registeredName: 'Registered Core', searched: true,
    architecture: 'x64', disabledValues: ['Registered Core'] });
  assert.equal(nameOnly.moduleMayLoad, true); assert.equal(nameOnly.registrationDisabled, true);
  assert.equal(resolveAddonLoadState({ name: 'Plugin.addon64', searched: true, disabledValues: ['@plugin.addon64'] }).moduleMayLoad, true);
});

test('explicit ordinary DLLs need a keep decision while native entry DLLs never become addon isolation targets', async t => {
  const f = fixture(t), ordinary = f.put(path.join(f.addon, 'vendor-helper.dll')), protectedFile = f.put(path.join(f.addon, 'dxgi.dll'));
  const bytes = fs.readFileSync(ordinary); bytes.writeUInt32LE(0, 0x98 + 112); bytes.writeUInt32LE(0, 0x98 + 116); fs.writeFileSync(ordinary, bytes);
  fs.appendFileSync(f.ini, 'LoadFromDllMain=vendor-helper.dll,dxgi.dll\r\n');
  const snapshot = await f.snapshot(), row = snapshot.files.find(value => value.path === ordinary);
  assert.equal(row.nameSource, 'filename'); assert.equal(row.registeredName, 'vendor-helper');
  const plan = planAddonCompatibility(snapshot);
  assert.equal(plan.blockers.find(value => value.path === ordinary).code, 'ADDON_EXPLICIT_DLL_UNVERIFIED');
  assert.deepEqual(plan.isolate, []); assert.deepEqual(plan.preserve.map(value => value.path).sort(), [ordinary, protectedFile].sort());
  const kept = planAddonCompatibility(snapshot, { keep: [{ path: ordinary, sha256: sha(ordinary), configFingerprint: snapshot.configFingerprint }] });
  assert.deepEqual(kept.blockers, []); assert.equal(kept.keep[0].path, ordinary);
});

test('compatible, unknown, other NR and known previous Core use distinct actions without claiming user file ownership', async t => {
  const f = fixture(t), hdr = f.put(path.join(f.addon, 'hdr.addon64'), 'HDR'), unknown = f.put(path.join(f.addon, 'user.addon64'));
  const nr = f.put(path.join(f.addon, 'neutral.addon64'), 'Independent Consumer', 'RenoDX Generic NR');
  const core = f.put(path.join(f.addon, 'previous.addon64'), 'NRBeforeSR', 'NRBeforeSR');
  const snapshot = await f.snapshot(), knownComponents = [{ path: hdr, sha256: sha(hdr), role: 'renodx-hdr', compatibility: 'compatible' }, { sha256: sha(core), role: 'core' }];
  const plan = planAddonCompatibility(snapshot, { knownComponents });
  assert.equal(plan.keep[0].path, hdr); assert.equal(plan.retire[0].path, core); assert.equal(plan.retire[0].owned, false);
  assert.equal(plan.isolate.find(row => row.path === nr).mandatory, true); assert.equal(plan.isolate.find(row => row.path === unknown).mandatory, false);
  const keep = [{ path: unknown, sha256: sha(unknown), configFingerprint: snapshot.configFingerprint }];
  assert.equal(planAddonCompatibility(snapshot, { knownComponents, keep }).keep.some(row => row.path === unknown), true);
  assert.equal(planAddonCompatibility(snapshot, { knownComponents, keep: [{ path: nr, sha256: sha(nr), configFingerprint: snapshot.configFingerprint }] }).blockers[0].code, 'ADDON_KEEP_FORBIDDEN');
});

test('snapshot invalidates after config edits, newly searched plugins and byte changes without touching files', async t => {
  const f = fixture(t), file = f.put(path.join(f.addon, 'one.addon64')); let snapshot = await f.snapshot();
  await assertAddonSnapshot(snapshot);
  fs.appendFileSync(f.ini, '[Personal]\nChange=1\n'); await assert.rejects(assertAddonSnapshot(snapshot), { code: 'ADDON_PLAN_CHANGED' });
  snapshot = await f.snapshot(); const added = f.put(path.join(f.addon, 'two.addon64')); await assert.rejects(assertAddonSnapshot(snapshot), { code: 'ADDON_PLAN_CHANGED' });
  fs.unlinkSync(added); snapshot = await f.snapshot(); fs.appendFileSync(file, 'changed'); await assert.rejects(assertAddonSnapshot(snapshot), { code: 'ADDON_PLAN_CHANGED' });
});

test('a lone legacy boolean load setting warns without inventing a missing module or changing its INI', async t => {
  const f = fixture(t), file = f.put(path.join(f.addon, 'Luma.addon64'), 'Luma');
  for (const value of ['0', '1']) {
    const original = '[ADDON]\r\nAddonPath=.\\Addons\r\nLoadFromDllMain=' + value + '\r\n';
    fs.writeFileSync(f.ini, original);
    const snapshot = await f.snapshot();
    assert.deepEqual(snapshot.blockers, []); assert.deepEqual(snapshot.profile.directLoads, []);
    assert.equal(snapshot.files.find(row => row.path === file).searched, true);
    assert.equal(snapshot.warnings.find(row => row.code === 'ADDON_LEGACY_BOOLEAN_LOAD').value, value);
    assert.equal(fs.readFileSync(f.ini, 'utf8'), original);
    assert.equal(typeof snapshot.environment.PATH, 'string');
    const numericTarget = f.put(path.join(f.addon, value + '.dll'));
    await assert.rejects(assertAddonSnapshot(snapshot), { code: 'ADDON_PLAN_CHANGED' });
    assert.match((await f.snapshot()).blockers[0].message, /实际目标/);
    fs.unlinkSync(numericTarget);
  }
});

test('real numeric targets, explicit numeric paths and missing ordinary DLLs cannot use the boolean exception', async t => {
  const f = fixture(t);
  for (const value of ['Early.dll', '.\\0', '0.dll', '0,Early.dll', '0,1', '2']) {
    fs.writeFileSync(f.ini, '[ADDON]\nAddonPath=.\\Addons\nLoadFromDllMain=' + value + '\n');
    const snapshot = await f.snapshot();
    assert.ok(snapshot.blockers.length, value); assert.equal(snapshot.profile.legacyDirectLoad, null);
    assert.match(snapshot.blockers[0].message, /文件缺失/);
  }
  for (const [directory, name] of [[f.addon, '0'], [f.addon, '0.dll'], [f.game, '0.dll']]) {
    const numericTarget = f.put(path.join(directory, name));
    fs.writeFileSync(f.ini, '[ADDON]\nAddonPath=.\\Addons\nLoadFromDllMain=0\n');
    assert.match((await f.snapshot()).blockers[0].message, /实际目标/);
    fs.unlinkSync(numericTarget);
  }
});

test('legacy boolean detection checks PATH and system DLL candidates and refuses unresolved search directories', async t => {
  const f = fixture(t), search = path.join(f.root, 'search'), windows = path.join(f.root, 'windows');
  fs.mkdirSync(search); fs.mkdirSync(path.join(windows, 'System32'), { recursive: true }); fs.mkdirSync(path.join(windows, 'SysWOW64'));
  fs.writeFileSync(f.ini, '[ADDON]\nAddonPath=.\\Addons\nLoadFromDllMain=0\n');
  const snapshot = environment => snapshotAddonLoadingLayout({ exeDir: f.game, gameId: 'fixture-game', architecture: 64, environment });
  const environment = { PATH: search, SystemRoot: windows };
  assert.deepEqual((await snapshot(environment)).blockers, []);
  for (const directory of [search, windows, path.join(windows, 'System32'), path.join(windows, 'SysWOW64')]) {
    const target = f.put(path.join(directory, '0.dll'));
    assert.match((await snapshot(environment)).blockers[0].message, /实际目标/); fs.unlinkSync(target);
  }
  for (const PATH of ['relative', '%UNRESOLVED%']) assert.match((await snapshot({ ...environment, PATH })).blockers[0].message, /搜索路径无法明确解析/);
});

test('planned native isolation backs up only selected active files and restore preserves a later user replacement', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.rootIni, '[ADDON]\nAddonPath=.\n'); const plugin = f.put(path.join(f.game, 'user.addon64'));
  const snapshot = await f.snapshot(), plan = planAddonCompatibility(snapshot), before = sha(plugin);
  const moved = await movePlannedConflicts(f.game, crypto.randomUUID(), plan, { snapshot });
  assert.equal(fs.existsSync(plugin), false); const backup = path.join(f.game, moved[0].backupRel); assert.equal(sha(backup), before);
  fs.writeFileSync(plugin, 'user replacement'); const warnings = await restoreConflicts(f.game, moved);
  assert.equal(warnings[0].code, 'ERR_FILE_CHANGED'); assert.equal(fs.readFileSync(plugin, 'utf8'), 'user replacement'); assert.equal(sha(backup), before);
  fs.unlinkSync(plugin); assert.deepEqual(await restoreConflicts(f.game, moved), []); assert.equal(sha(plugin), before);
});

module.exports = { peBytes };
