'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');
const { STARTUP_FILES, RUNTIME_FILES, verifyManagerRelease, parseArguments } = require('../scripts/verify-manager-release');

function manifestExe(level) {
  const manifest = Buffer.from(`<assembly><trustInfo><security><requestedPrivileges><requestedExecutionLevel level="${level}" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>`);
  const bytes = Buffer.alloc(0x1000), pe = 0x80, optional = pe + 24, section = optional + 0xf0;
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(pe, 0x3c); bytes.writeUInt32LE(0x4550, pe);
  bytes.writeUInt16LE(0x8664, pe + 4); bytes.writeUInt16LE(1, pe + 6); bytes.writeUInt16LE(0xf0, pe + 20);
  bytes.writeUInt16LE(0x20b, optional); bytes.writeUInt32LE(0x1000, optional + 128); bytes.writeUInt32LE(0xc00, optional + 132);
  bytes.write('.rsrc\0', section); bytes.writeUInt32LE(0xc00, section + 8); bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(0xc00, section + 16); bytes.writeUInt32LE(0x200, section + 20);
  for (const [offset, id, target] of [[0, 24, 0x80000020], [0x20, 1, 0x80000040], [0x40, 1033, 0x60]]) {
    bytes.writeUInt16LE(1, 0x200 + offset + 14); bytes.writeUInt32LE(id, 0x200 + offset + 16); bytes.writeUInt32LE(target, 0x200 + offset + 20);
  }
  bytes.writeUInt32LE(0x1100, 0x260); bytes.writeUInt32LE(manifest.length, 0x264); manifest.copy(bytes, 0x300);
  return bytes;
}
function put(root, file, value) { const full = path.join(root, file); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, value); }
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-release-static-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const sourceRoot = path.join(root, 'trusted'), directory = path.join(root, 'candidate'), electronDist = path.join(root, 'electron');
  for (const file of STARTUP_FILES) put(sourceRoot, file, fs.readFileSync(path.join(__dirname, '..', file)));
  put(sourceRoot, 'resources/runtime/active.bin', 'pinned runtime');
  put(sourceRoot, 'resources/runtime/old/omitted.bin', 'excluded by build filter');
  put(sourceRoot, 'scripts/helper.cmd', 'read-only helper');
  put(sourceRoot, 'package.json', JSON.stringify({ name: 'static-fixture', version: '1.0.0', main: 'main.js', build: {
    productName: 'Static Fixture', files: [...STARTUP_FILES, 'package.json'],
    extraResources: [{ from: 'resources/runtime', to: 'runtime', filter: ['**/*', '!old/**/*'] }],
    extraFiles: [{ from: 'scripts/helper.cmd', to: 'helper.cmd' }]
  } }));
  fs.mkdirSync(path.join(directory, 'resources'), { recursive: true });
  await asar.createPackage(sourceRoot, path.join(directory, 'resources/app.asar'));
  for (const file of [...RUNTIME_FILES, 'locales/en-US.pak', 'locales/zh-CN.pak']) {
    put(electronDist, file, `trusted ${file}`); put(directory, file, `trusted ${file}`);
  }
  put(electronDist, 'version', '33.4.11'); put(electronDist, 'LICENSE', 'runtime license'); put(directory, 'LICENSE.electron.txt', 'runtime license');
  put(directory, 'resources/runtime/active.bin', 'pinned runtime'); put(directory, 'helper.cmd', 'read-only helper');
  put(directory, 'Static Fixture.exe', manifestExe('asInvoker'));
  return { sourceRoot, directory, electronDist };
}
test('real ASAR and PE fixture passes without loading app code or invoking an executable', async t => {
  const input = await fixture(t), report = await verifyManagerRelease(input);
  assert.equal(report.ok, true); assert.equal(report.staticOnly, true); assert.equal(report.launched, false);
  assert.equal(report.executable.executionLevel.manifests[0].level, 'asInvoker');
  assert.ok(report.files.some(row => row.file === 'resources/runtime/active.bin'));
  assert.ok(!report.files.some(row => row.file.includes('omitted.bin')));
});
test('runtime substitution, absent companion, and a stale ASAR are independently reported', async t => {
  const input = await fixture(t);
  put(input.directory, 'libEGL.dll', 'foreign runtime');
  fs.unlinkSync(path.join(input.directory, 'resources/runtime/active.bin'));
  fs.appendFileSync(path.join(input.sourceRoot, 'src/renderer/startup-ui.js'), '\n// trusted revision changed\n');
  const report = await verifyManagerRelease(input);
  assert.equal(report.ok, false);
  assert.deepEqual(report.failed.map(row => row.file).sort(), ['libEGL.dll', 'resources/runtime/active.bin', 'src/renderer/startup-ui.js'].sort());
});
test('requireAdministrator in the actual RT_MANIFEST rejects an otherwise matching package', async t => {
  const input = await fixture(t); put(input.directory, 'Static Fixture.exe', manifestExe('requireAdministrator'));
  const report = await verifyManagerRelease(input);
  assert.equal(report.ok, false); assert.equal(report.failed.length, 0);
  assert.equal(report.executable.executionLevel.ok, false);
});
test('builder elevation helper needs an explicit trusted binary and unaccounted extras fail', async t => {
  const input = await fixture(t);
  put(input.directory, 'resources/elevate.exe', 'NSIS helper');
  const missingSource = await verifyManagerRelease(input);
  assert.equal(missingSource.ok, false);
  assert.ok(missingSource.failed.some(row => row.file === 'resources/elevate.exe'));
  const nsisDir = path.join(input.sourceRoot, 'nsis'); put(nsisDir, 'elevate.exe', 'NSIS helper');
  assert.equal((await verifyManagerRelease({ ...input, nsisDir })).ok, true);
  put(input.directory, 'unaccounted.dll', 'unexpected DLL');
  const unexpected = await verifyManagerRelease({ ...input, nsisDir });
  assert.equal(unexpected.ok, false);
  assert.deepEqual(unexpected.failed.find(row => row.name === 'no-unaccounted-package-files').unexpectedFiles, ['unaccounted.dll']);
});
test('report output must be outside the read-only candidate tree', () => {
  assert.throws(() => parseArguments(['--dir', 'candidate', '--output', 'candidate/report.json']), /outside/);
  assert.throws(() => parseArguments(['--dir', 'candidate', '--output', 'candidate/../candidate/report.json']), /outside/);
  assert.equal(parseArguments(['--dir', 'candidate', '--output', 'report.json']).output, 'report.json');
});
