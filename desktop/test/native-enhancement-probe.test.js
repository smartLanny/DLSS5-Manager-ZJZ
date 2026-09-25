'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createNativeEnhancementProbe } = require('../src/product/native-enhancement-probe');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-enhancement-probe-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const exe = path.join(root, 'Game.exe'); fs.writeFileSync(exe, 'selected executable');
  const imports = new Map(), markers = new Map(), signatures = new Map(), versions = new Map(); let signatureReads = 0;
  const scan = { chosen: { path: exe, bitness: 64, apiResolution: { api: 'dx12' } }, dlssFiles: [], streamlineFiles: [] };
  function file(name, extra = '') {
    const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, name + extra);
    if (/^(?:nvngx|sl\.)/i.test(path.basename(name))) (path.basename(name).startsWith('sl.') ? scan.streamlineFiles : scan.dlssFiles).push({ path: target });
    signatures.set(target, true); versions.set(target, '310.8.0.0'); return target;
  }
  const options = { gameDirectory: () => root, gameExecutable: () => exe, scan: () => scan,
    pe: { getBitness: () => 64, getImports: file => imports.get(file) || [],
      findMarkers: (file, requested) => new Set((markers.get(file) || []).filter(value => requested.includes(value))),
      getFileVersion: file => versions.get(file) || '1.0.0.0' },
    verifySignature: async file => { signatureReads++; return { valid: signatures.get(file) === true, source: 'synthetic-signature' }; } };
  return { root, exe, file, scan, imports, markers, signatures, versions, options,
    probe: createNativeEnhancementProbe(options), signatureReads: () => signatureReads };
}

test('a signed loose DLSS DLL plus an untrusted Luma addon cannot create native SR support', async t => {
  const f = fixture(t); f.file('nvngx_dlss.dll'); const luma = f.file('Luma-Unreal Engine.addon');
  f.markers.set(luma, ['nvngx_dlss.dll', 'NVSDK_NGX_D3D11_Init']);
  f.imports.set(f.exe, ['d3d11.dll', 'dxgi.dll']); f.scan.chosen.apiResolution.api = 'dx11';
  const value = await f.probe.inspect('g', 'sr');
  assert.equal(value.support.status, 'unknown'); assert.equal(value.staticEvidence.nativeDlssAvailable, false);
  assert.match(value.support.message, /集成关系/); assert.equal(fs.existsSync(path.join(f.root, 'game-feature-confirmations.json')), false);
});

test('native SR needs both actual host association and a verified component identity', async t => {
  const f = fixture(t), dlss = f.file('nvngx_dlss.dll');
  f.markers.set(f.exe, ['nvngx_dlss.dll', 'NVSDK_NGX_D3D12_Init']);
  const supported = await f.probe.inspect('g', 'sr'); assert.equal(supported.support.status, 'supported');
  assert.equal(supported.support.source, 'native-integration'); assert.equal(supported.gameSetting.state, 'unknown');
  fs.writeFileSync(dlss, 'replacement without trusted signature'); f.signatures.set(dlss, false);
  assert.equal((await f.probe.inspect('g', 'sr')).support.status, 'unknown', 'digest change invalidates trust');
  assert.equal(f.signatureReads(), 2);
});

test('only a linked engine can supply integration evidence; loose engines and SDK proxies cannot', async t => {
  const f = fixture(t); f.file('nvngx_dlss.dll'); const engine = f.file('GameEngine.dll');
  f.markers.set(engine, ['nvngx_dlss.dll']);
  assert.equal((await f.probe.inspect('g', 'sr')).support.status, 'unknown');
  f.imports.set(f.exe, ['GameEngine.dll']); assert.equal((await f.probe.inspect('g', 'sr')).support.status, 'supported');
  f.imports.set(f.exe, ['dxgi.dll']); const proxy = f.file('dxgi.dll'); f.markers.set(proxy, ['nvngx_dlss.dll']);
  assert.equal((await f.probe.inspect('g', 'sr')).support.status, 'unknown');
});

test('Steam catalogue grants 50-series modes only after linked trusted FG and exact verified title identity', async t => {
  const f = fixture(t); for (const name of ['nvngx_dlssg.dll', 'sl.dlss_g.dll', 'sl.interposer.dll']) f.file(name);
  f.imports.set(f.exe, ['sl.interposer.dll']);
  const baseline = await f.probe.inspect('g', 'fg'); assert.equal(baseline.support.status, 'supported');
  assert.deepEqual(baseline.support.capabilities.multipliers, [2]); assert.equal(baseline.support.capabilities.mfgUnlock.available, true);
  let metadata = { verifiedSteamAppId: '10', steamIdentityVerified: false };
  const probe = createNativeEnhancementProbe({ ...f.options, gameMetadata: () => metadata,
    officialGames: [{ steamAppId: '10', exe: 'Game.exe', api: 'dx12', id: 'fixture', source: 'synthetic-official-source', checkedAt: '2026-09-10', fg: { multipliers: [2, 3, 4, 5, 6], dynamic: true } }] });
  assert.equal((await probe.inspect('g', 'fg')).support.official, false);
  metadata.steamIdentityVerified = true;
  const official = await probe.inspect('g', 'fg'); assert.equal(official.support.official, true); assert.equal(official.support.capabilities.dynamic, true);
  f.imports.set(f.exe, []); assert.equal((await probe.inspect('g', 'fg')).support.status, 'unknown');
});

test('007 First Light exposes its official 6X and Dynamic support only for the verified linked Steam installation', async t => {
  const f = fixture(t), exe = f.file('007FirstLight.exe');
  for (const name of ['nvngx_dlssg.dll', 'sl.dlss_g.dll', 'sl.interposer.dll']) f.file(name);
  f.scan.chosen.path = exe; f.imports.set(exe, ['sl.interposer.dll']);
  const metadata = { verifiedSteamAppId: '3768760', steamIdentityVerified: true };
  const probe = createNativeEnhancementProbe({ ...f.options, gameExecutable: () => exe, gameMetadata: () => metadata });
  const supported = await probe.inspect('007', 'fg');
  assert.equal(supported.support.catalogue.id, '007-first-light');
  assert.match(supported.support.catalogue.source, /nvidia\.com.*007-first-light/);
  assert.deepEqual(supported.support.capabilities.multipliers, [2, 3, 4, 5, 6]);
  assert.equal(supported.support.capabilities.dynamic, true);
  assert.equal(supported.support.staticOnly, true); assert.equal(supported.gameSetting.state, 'unknown');
  metadata.steamIdentityVerified = false;
  assert.deepEqual((await probe.inspect('007', 'fg')).support.capabilities.multipliers, [2]);
  metadata.steamIdentityVerified = true; metadata.verifiedSteamAppId = '1091500';
  assert.deepEqual((await probe.inspect('007', 'fg')).support.capabilities.multipliers, [2]);
  metadata.verifiedSteamAppId = '3768760'; f.imports.set(exe, []);
  assert.equal((await probe.inspect('007', 'fg')).support.status, 'unknown', 'the official title cannot authorize loose DLSS files');
});

test('ambiguity, outside-game assets and NR-only files cannot establish SR or FG', async t => {
  const f = fixture(t); f.file('nvngx_dlssnr.dll'); f.markers.set(f.exe, ['nvngx_dlss.dll']);
  assert.equal((await f.probe.inspect('g', 'sr')).support.status, 'unknown');
  f.file('nvngx_dlss.dll'); f.file('other/nvngx_dlss.dll');
  assert.equal((await f.probe.inspect('g', 'sr')).support.status, 'unknown', 'two potential providers remain ambiguous');
  const value = await f.probe.inspect('g', 'fg'); assert.equal(value.support.status, 'unknown');
});

test('trusted mod contracts require the exact EXE, addon hash, active layout and declared override support', async t => {
  const f = fixture(t); f.file('nvngx_dlss.dll'); const addon = f.file('TestMod.addon64');
  const contract = { id: 'reviewed-test-mod', domain: 'sr', api: 'dx12', exeSha256: hash(f.exe), addon: path.basename(addon),
    addonSha256: hash(addon), source: 'synthetic-reviewed-contract', driverOverrideSupported: true };
  const probe = createNativeEnhancementProbe({ ...f.options, trustedMods: [contract],
    getLayout: () => ({ verified: true, exe: f.exe, addonDirectory: f.root, blockers: [] }) });
  assert.equal((await probe.inspect('g', 'sr')).support.source, 'trusted-mod');
  fs.appendFileSync(addon, 'changed'); assert.equal((await probe.inspect('g', 'sr')).support.status, 'unknown');
});

test('SR and FG share a simultaneous read but later reads re-evaluate identity and API', async t => {
  const f = fixture(t); f.file('nvngx_dlss.dll'); f.markers.set(f.exe, ['nvngx_dlss.dll']);
  const values = await Promise.all([f.probe.inspect('g', 'sr'), f.probe.inspect('g', 'fg')]);
  assert.equal(values[0].support.status, 'supported'); assert.equal(f.signatureReads(), 1);
  f.scan.chosen.apiResolution.api = 'dx9'; assert.equal((await f.probe.inspect('g', 'sr')).support.status, 'unknown');
});

test('operation API overrides an unresolved scan without changing it or sharing a different API read', async t => {
  const f = fixture(t); f.file('nvngx_dlss.dll'); f.markers.set(f.exe, ['nvngx_dlss.dll']);
  f.scan.chosen.apiResolution.api = 'unknown';
  const [unresolved, dx11, dx12, dx9] = await Promise.all([
    f.probe.inspect('g', 'sr'), f.probe.inspect('g', 'sr', { api: 'dx11' }),
    f.probe.inspect('g', 'sr', { api: 'dx12' }), f.probe.inspect('g', 'sr', { api: 'dx9' })
  ]);
  assert.equal(unresolved.support.code, 'SETTINGS_GAME_API');
  assert.equal(dx11.support.status, 'supported'); assert.equal(dx11.staticEvidence.api, 'dx11');
  assert.equal(dx12.support.status, 'supported'); assert.equal(dx12.staticEvidence.api, 'dx12');
  assert.equal(dx9.support.code, 'SETTINGS_GAME_API'); assert.equal(dx9.staticEvidence.api, 'dx9');
  assert.equal(f.scan.chosen.apiResolution.api, 'unknown');
});

test('only a complete search without integration clues recommends the Feeder fallback', async t => {
  const f = fixture(t);
  assert.equal((await f.probe.inspect('g', 'sr')).support.code, 'SETTINGS_NATIVE_INTEGRATION_NOT_OBSERVED');
  const engine = f.file('GameAssembly.dll'); f.markers.set(f.exe, ['GameAssembly.dll']);
  const incomplete = createNativeEnhancementProbe({ ...f.options, pe: { ...f.options.pe, getBitness: file => file === engine ? 32 : 64 } });
  const skipped = await incomplete.inspect('g', 'sr');
  assert.equal(skipped.support.code, 'SETTINGS_GAME_SUPPORT_UNKNOWN');
  assert.equal(skipped.staticEvidence.coverage.complete, false);
  assert.equal(skipped.staticEvidence.coverage.skipped[0].path, engine);
  const dlss = f.file('nvngx_dlss.dll'); f.signatures.set(dlss, false);
  const candidate = await f.probe.inspect('g', 'sr');
  assert.equal(candidate.support.code, 'SETTINGS_GAME_SUPPORT_UNKNOWN');
});
