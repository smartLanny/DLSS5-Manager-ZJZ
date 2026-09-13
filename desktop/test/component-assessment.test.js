'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createComponentAssessment, COMPONENT_ASSESSMENT_LIMITS: LIMITS } = require('../src/product/component-assessment');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function peBytes(text = '', { bitness = 64, metadata = null } = {}) {
  const buffer = Buffer.alloc(metadata ? 0x600 : 0x400), at = 0x80, optional = at + 24;
  buffer.write('MZ'); buffer.writeUInt32LE(at, 0x3c); buffer.write('PE\0\0', at); buffer.writeUInt16LE(bitness === 64 ? 0x8664 : 0x14c, at + 4);
  buffer.writeUInt16LE(0xf0, at + 20); buffer.writeUInt16LE(bitness === 64 ? 0x20b : 0x10b, optional);
  if (metadata) {
    buffer.writeUInt16LE(1, at + 6); const directory = optional + (bitness === 64 ? 112 : 96) + 16, section = optional + 0xf0;
    buffer.writeUInt32LE(0x1000, directory); buffer.writeUInt32LE(0x400, directory + 4);
    buffer.write('.rsrc', section); buffer.writeUInt32LE(0x400, section + 8); buffer.writeUInt32LE(0x1000, section + 12);
    buffer.writeUInt32LE(0x400, section + 16); buffer.writeUInt32LE(0x200, section + 20);
    for (const offset of [0, 0x20, 0x40]) buffer.writeUInt16LE(1, 0x200 + offset + 14);
    buffer.writeUInt32LE(16, 0x210); buffer.writeUInt32LE(0x80000020, 0x214);
    buffer.writeUInt32LE(1, 0x230); buffer.writeUInt32LE(0x80000040, 0x234);
    buffer.writeUInt32LE(1033, 0x250); buffer.writeUInt32LE(0x60, 0x254);
    const blob = Buffer.from('ProductName\0' + metadata + '\0', 'utf16le');
    buffer.writeUInt32LE(0x1080, 0x260); buffer.writeUInt32LE(blob.length, 0x264); blob.copy(buffer, 0x280);
  }
  return Buffer.concat([buffer, Buffer.from(text)]);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'component-assessment-')), game = path.join(root, 'game'), active = path.join(root, 'profile');
  fs.mkdirSync(game); fs.mkdirSync(active);
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const exe = path.join(game, 'game.exe'), config = path.join(active, 'ReShade.ini'); fs.writeFileSync(exe, peBytes('fixture game')); fs.writeFileSync(config, '[ADDON]\nAddonPath=.\n');
  const expected = [], catalog = [], layout = { exe, gameRoot: game, loaderDir: game, runtimeDir: active, addonDirectory: active,
    activeConfigPath: config, verified: true, mode: 'external', loadingMode: 'helper' };
  const service = createComponentAssessment({ layout: async () => layout, getExpectedModules: async (_id, current) => { assert.equal(current, layout); return expected; }, knownPayloads: async () => catalog });
  const put = (name, text, options = {}) => { const file = path.join(options.directory || active, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, peBytes(text, options)); return file; };
  const own = (file, role = 'core', extra = {}) => { const row = { path: file, name: path.basename(file), role, sha256: sha(file), architecture: 64, ...extra }; expected.push(row); return row; };
  return { root, game, active, exe, config, expected, catalog, layout, service, put, own, inspect: () => service.inspect('fixture') };
}
test('managed hashes identify reusable files while version, architecture and owner conflicts remain read-only', async t => {
  const f = fixture(t), core = f.put('nr-before-sr.zh-CN.addon64', 'NRBeforeSR current'), bridge = f.put('nrchain_nvngx.dll', 'bridge');
  f.own(core); const bridgeRecord = f.own(bridge, 'chain');
  let result = await f.inspect(), byName = Object.fromEntries(result.files.map(row => [row.name, row]));
  assert.equal(byName[path.basename(core)].status, 'reusable'); assert.equal(byName[path.basename(core)].confidence, 'verified'); assert.equal(result.conflicts.length, 0);
  fs.writeFileSync(bridge, peBytes('foreign replacement')); result = await f.inspect();
  assert.equal(result.files.find(row => row.path === bridge).status, 'version-conflict'); assert.equal(result.conflicts[0].code, 'COMPONENT_VERSION_CONFLICT');
  assert.equal(bridgeRecord.sha256, f.expected[1].sha256); assert.equal(fs.readFileSync(bridge).subarray(-19).toString(), 'foreign replacement');
  const x86 = f.put('owned.addon32', 'fixture x86', { bitness: 32 }); f.own(x86, 'mfgunlock');
  f.expected.push({ ...f.expected[0], owner: 'other-owner', sha256: '0'.repeat(64) }); result = await f.inspect();
  assert.ok(result.conflicts.some(row => row.code === 'COMPONENT_OWNER_CONFLICT'));
  assert.equal(result.files.find(row => row.path === x86).status, 'version-conflict'); assert.equal(result.files.find(row => row.path === x86).architecture, 'x86');
  assert.equal(fs.existsSync(path.join(f.active, '_DLSS5_Backup')), false); assert.equal(result.runtimeVerified, false);
});
test('validated owner may supply one fixed external DLL without scanning its directory', async t => {
  const f = fixture(t), directory = path.join(f.root, 'fixed-layer');
  const loader = f.put('ReShade64.dll', 'ReShade fixed layer', { directory });
  f.put('unrelated.addon64', 'unknown sibling', { directory }); f.own(loader, 'reshade');
  const restricted = await f.inspect(); assert.ok(!restricted.files.some(row => row.path === loader));
  const service = createComponentAssessment({ layout: () => f.layout, getExpectedModules: () => f.expected, allowExplicitExpectedPaths: true });
  const result = await service.inspect('fixture');
  assert.equal(result.files.find(row => row.path === loader).status, 'reusable');
  assert.ok(!result.files.some(row => row.name === 'unrelated.addon64'));
  assert.equal(result.runtimeVerified, false);
});
test('RenoDX HDR, Generic NR, DLSS5 Tool, project Core and MFG declarations stay distinct without promoting filenames', async t => {
  const f = fixture(t);
  f.put('renodx-hdr.addon64', 'ordinary binary references DLSS NVNGX nvngx_dlss.dll');
  f.put('neutral-hdr.addon64', '', { metadata: 'RenoDX HDR Color Grading' });
  f.put('neutral-generic.addon64', 'RenoDX Generic NR'); f.put('neutral-dlss5.addon64', 'renodx-dlss5');
  f.put('neutral-core.addon64', 'NRBeforeSR'); f.put('neutral-fg.addon64', 'MFG Unlock');
  f.put('neutral-unknown.addon64', 'DLSS NVNGX HDR success=800');
  const result = await f.inspect(), row = name => result.files.find(value => value.name === name);
  assert.equal(row('renodx-hdr.addon64').classification, 'renodx-hdr'); assert.equal(row('renodx-hdr.addon64').source, 'filename'); assert.equal(row('renodx-hdr.addon64').confidence, 'hint');
  assert.equal(row('neutral-hdr.addon64').source, 'pe-metadata'); assert.equal(row('neutral-hdr.addon64').confidence, 'declared');
  assert.equal(row('neutral-generic.addon64').classification, 'renodx-generic-nr'); assert.equal(row('neutral-dlss5.addon64').classification, 'renodx-dlss5');
  assert.equal(row('neutral-core.addon64').classification, 'core'); assert.equal(row('neutral-core.addon64').source, 'content-declaration');
  assert.equal(row('neutral-fg.addon64').classification, 'mfgunlock'); assert.equal(row('neutral-unknown.addon64').classification, 'unknown');
  assert.equal(result.conflicts.length, 0); assert.ok(result.files.every(value => value.runtimeVerified === false));
  const coexistence = result.warnings.find(value => value.code === 'COMPONENT_NR_COEXISTENCE_UNVERIFIED'); assert.ok(coexistence);
  assert.equal(coexistence.paths.some(file => /hdr/i.test(file)), false); assert.equal(coexistence.paths.some(file => /fg\.addon64/.test(file)), false);
});
test('known hashes identify renamed Core while a generic owner receipt does not upgrade self-declared purpose', async t => {
  const f = fixture(t), renamed = f.put('renodx-hdr.addon64', 'NRBeforeSR fixed core'), declared = f.put('personal.addon64', 'NRBeforeSR self declaration');
  f.catalog.push({ id: 'project-core', version: 'fixed-version', role: 'core', sha256: sha(renamed), architecture: 64 });
  f.own(declared, 'user-addon');
  const result = await f.inspect(), fixed = result.files.find(row => row.path === renamed), personal = result.files.find(row => row.path === declared);
  assert.equal(fixed.classification, 'core'); assert.equal(fixed.source, 'known-sha256'); assert.equal(fixed.confidence, 'verified'); assert.equal(fixed.identity.version, 'fixed-version');
  assert.equal(personal.status, 'duplicate-load'); assert.equal(personal.identityVerified, true); assert.equal(personal.confidence, 'declared'); assert.equal(personal.source, 'content-declaration');
});
test('same-hash copies and different Core versions report duplicate risk only in configured loadable locations', async t => {
  const f = fixture(t), current = f.put('nr-before-sr.zh-CN.addon64', 'NRBeforeSR current'); f.own(current);
  const old = f.put('old-version.addon64', 'NRBeforeSR old'); f.catalog.push({ role: 'core', version: 'old', sha256: sha(old) });
  const duplicate = path.join(f.active, 'neutral-copy.addon64'); fs.copyFileSync(current, duplicate);
  const result = await f.inspect(); assert.ok(result.conflicts.some(row => row.code === 'COMPONENT_DUPLICATE_LOAD' && row.source === 'sha256-comparison'));
  assert.ok(result.conflicts.some(row => row.code === 'COMPONENT_DUPLICATE_LOAD' && row.paths.length === 3));
  fs.appendFileSync(f.config, 'DisabledAddons=Old Core@old-version.addon64,Copy@neutral-copy.addon64\n');
  fs.copyFileSync(current, path.join(f.game, 'inactive-core.addon64'));
  const disabled = await f.inspect(); assert.equal(disabled.conflicts.length, 0); assert.equal(disabled.files.find(row => row.path === duplicate).loadState, 'disabled');
  assert.equal(disabled.files.find(row => row.name === 'inactive-core.addon64').loadState, 'inactive-or-unverified');
});
test('inspection stays at declared top-level paths and rejects links, oversized files and out-of-scope records', async t => {
  const f = fixture(t); f.put('_DLSS5_Backup/old-core.addon64', 'NRBeforeSR'); f.put('nested/old-core.addon64', 'NRBeforeSR');
  f.put('nvngx_dlss.dll', 'native game DLSS', { directory: f.game }); f.put('unknown.dll.bak', 'backup');
  const peer = f.put('link-target.addon64', 'unknown module'), link = path.join(f.active, 'linked.addon64'); fs.linkSync(peer, link);
  const large = path.join(f.active, 'large.addon64'); fs.writeFileSync(large, ''); fs.truncateSync(large, LIMITS.fileBytes + 1);
  const outside = f.put('outside.addon64', 'NRBeforeSR', { directory: path.join(f.root, 'other') }); f.own(outside);
  const result = await f.inspect(); assert.deepEqual(result.files.map(row => row.name).sort(), ['large.addon64', 'link-target.addon64', 'linked.addon64']);
  assert.ok(result.files.every(row => row.status === 'unavailable' && row.sha256 === null));
  assert.ok(result.warnings.some(row => row.code === 'COMPONENT_EXPECTED_SCOPE')); assert.equal(fs.existsSync(outside), true);
});
test('content probes and total candidate enumeration are bounded and never infer a marker beyond the probe', async t => {
  const f = fixture(t), file = path.join(f.active, 'neutral.addon64'); fs.writeFileSync(file, peBytes(''));
  const fd = fs.openSync(file, 'r+'); try { fs.writeSync(fd, Buffer.from('NRBeforeSR'), 0, 10, LIMITS.probeBytes + 64); } finally { fs.closeSync(fd); }
  let result = await f.inspect(); assert.equal(result.files[0].classification, 'unknown'); assert.equal(result.files[0].confidence, 'unknown');
  for (let i = 0; i < LIMITS.files + 1; i++) f.put('module-' + i + '.addon64', 'unique bytes ' + i);
  result = await f.inspect(); assert.equal(result.files.length, LIMITS.files); assert.ok(result.warnings.some(row => row.code === 'COMPONENT_FILE_LIMIT'));
});
