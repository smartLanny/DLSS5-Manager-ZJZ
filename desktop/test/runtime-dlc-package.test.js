'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createRuntimeDlcPackages } = require('../scripts/build-runtime-dlc.cjs');
const { createComponentLibrary } = require('../src/product/component-library');

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function pe64(marker) {
  const bytes = Buffer.alloc(160); bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(2, 84); bytes.writeUInt16LE(0x20b, 88); bytes[120] = marker; return bytes;
}

test('runtime DLC builder emits separately and jointly importable RTX40/RTX50 packages', async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'manager-runtime-dlc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sources = path.join(root, 'sources'); fs.mkdirSync(sources);
  const families = {};
  for (const [family, marker] of [['RTX40', 40], ['RTX50', 50]]) {
    const file = path.join(sources, `${family}.dll`); fs.writeFileSync(file, pe64(marker));
    families[family] = { file, bytes: fs.statSync(file).size, sha256: hash(file) };
  }
  const manifestFile = path.join(root, 'staging.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ schemaVersion: 1, runtime: { families } }));
  const outputRoot = path.join(root, 'delivery');
  const report = await createRuntimeDlcPackages({ manifestFile, workRoot: path.join(root, 'work'), outputRoot });
  assert.deepEqual(report.packages.map(row => row.family), ['RTX40', 'RTX50', 'RTX40+RTX50']);
  for (const row of report.packages) {
    assert.ok(fs.statSync(row.file).size > 0); assert.equal(hash(row.file), row.sha256);
  }
  for (const family of ['RTX40', 'RTX50']) {
    const library = createComponentLibrary({ userData: path.join(root, `library-${family}`), catalog: { packages: [] } });
    const imported = await library.importComponent(report.packages.find(row => row.family === family).file);
    assert.deepEqual(imported.packages[0].hardwareFamilies, [family]);
    assert.equal(imported.packages[0].kind, 'nr-runtime');
  }
  const both = createComponentLibrary({ userData: path.join(root, 'library-both'), catalog: { packages: [] } });
  const imported = await both.importComponent(report.packages.find(row => row.family === 'RTX40+RTX50').file);
  assert.deepEqual(imported.packages.map(row => row.hardwareFamilies[0]).sort(), ['RTX40', 'RTX50']);
});
