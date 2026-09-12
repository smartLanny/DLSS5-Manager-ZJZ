'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLegacyService } = require('../src/product/legacy-service');
const { createLegacyRuntime } = require('../src/product/legacy-runtime');
const { getBitness } = require('../src/core/pe');
const appDir = path.resolve(__dirname, '..'), enabled = process.env.DLSS5_VERIFY_LEGACY_OWNER_ASSETS === '1';
const results = [], digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function targetPe(architecture) {
  const bytes = Buffer.alloc(0x500); bytes.write('MZ'); bytes.writeUInt32LE(0x80, 0x3c); bytes.write('PE\0\0', 0x80);
  bytes.writeUInt16LE(architecture === 'x86' ? 0x14c : 0x8664, 0x84); bytes.writeUInt16LE(architecture === 'x86' ? 0xe0 : 0xf0, 0x94);
  bytes.writeUInt16LE(architecture === 'x86' ? 0x10b : 0x20b, 0x98); return bytes;
}
for (const [api, architecture] of [['dx11', 'x64'], ['dx9', 'x86']]) test(`real ${api}/${architecture} package performs a verified owner install and exact restore in a temporary fixture`, { skip: !enabled }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-assets-')), dir = path.join(root, 'g', 'bin'); fs.mkdirSync(dir, { recursive: true });
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const exe = path.join(dir, 'OwnerFixture.exe'); fs.writeFileSync(exe, targetPe(architecture)); assert.equal(getBitness(exe), architecture === 'x86' ? 32 : 64);
  const original = '\uFEFF; retained user configuration\r\n[STYLE]\r\nHdrOverlayBrightness=172\r\n'; fs.writeFileSync(path.join(dir, 'ReShade.ini'), original);
  const game = { id: `real-owner-${api}-${architecture}`, dir: path.dirname(dir), scan: { chosen: { path: exe, bitness: architecture === 'x86' ? 32 : 64, apiResolution: { api } } } };
  const runtime = createLegacyRuntime({ appDir }), selection = { api, architecture, hardwareFamily: 'RTX50', loadingBackend: 'local' };
  const pkg = await runtime.verify(selection), sourceIdentities = pkg.recipe.files.map(row => ({ source: row.source, role: row.role, architecture: row.architecture, sha256: row.sha256 }));
  const service = createLegacyService({ appDir, runtime, hardware: { family: 'RTX50' },
    guards: { assertGameClosed: async () => {}, antiCheatPresent: () => false }, broker: { inspect: async () => ({ launchable: true, elevated: false }) } });
  const preview = await service.previewInstall(game), installed = await service.install(game, { expectedPlanId: preview.planId });
  assert.equal(installed.packageId, pkg.recipe.id); const inspect = await service.inspect(game); assert.equal(inspect.ready, true, inspect.reason);
  const receipt = service.receipt(game); assert.equal(receipt.recipeFingerprint, pkg.fingerprint);
  const modules = await service.ownedModuleManifest(game);
  if (pkg.recipe.hostRequired) assert.equal(modules.some(row => row.role === 'core'), false);
  const mutable = receipt.files.find(row => row.role === 'core-config'); fs.appendFileSync(mutable.path, '\n; user change retained in restore archive\n');
  const restored = await service.restore(game); assert.equal(restored.restored, true); assert.equal(fs.readFileSync(path.join(dir, 'ReShade.ini'), 'utf8'), original);
  for (const row of receipt.files.filter(row => row.owned)) assert.equal(fs.existsSync(row.path), false, row.path);
  assert.equal(fs.existsSync(service.receiptFile(game)), false);
  for (const row of pkg.recipe.files) assert.equal(digest(path.join(pkg.root, row.source)), row.sha256);
  results.push({ api, architecture, hardwareFamily: 'RTX50', recipeId: pkg.recipe.id, recipeFingerprint: pkg.fingerprint,
    filesVerified: receipt.files.length, restored: true, originalIniExact: true, sourceFilesUnchanged: true, sourceIdentities,
    gameModuleRoles: modules.map(row => row.role), targetKind: 'synthetic-PE-identity-fixture', gameLaunched: false, runtimeVerified: false });
  fs.writeFileSync(path.join(appDir, 'build/beta3-legacy-real-assets.json'), JSON.stringify({ schema: 1, checkedAt: new Date().toISOString(),
    scope: 'temporary-file-owner-transactions-with-real-pinned-assets', passed: results.length === 2, realGame: false, cases: results }, null, 2) + '\n');
});
