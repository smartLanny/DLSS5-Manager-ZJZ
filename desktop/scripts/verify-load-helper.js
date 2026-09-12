'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { getBitness } = require('../src/core/pe');
const root = path.resolve(__dirname, '..');
const manifestFile = path.join(root, 'resources/loading-helper/component.json');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
const testFiles = ['test/loading-helper-native.test.js', 'test/loading-helper.test.js', 'test/launch-session.test.js', 'test/runtime-verification.test.js', 'test/fg-components-mfgunlock.test.js'];
const sourceFiles = ['src/native/load-helper.cpp', 'src/product/loading-helper.js', 'src/product/launch-session.js', 'src/product/runtime-verification.js', 'src/product/game-processes.js', 'src/product/fg-mfgunlock-components.js'];
const binaryFiles = ['build/load-helper/dlss5-load-helper.exe', 'build/load-helper/fixture-target.exe', 'build/load-helper/fixture-module.dll',
  'build/load-helper/fixture-reshade.dll', 'build/load-helper/fixture-neutral.dll',
  'build/load-helper/fixture-preloaded-neutral.exe', 'build/load-helper/fixture-preloaded-reshade.exe', 'resources/loading-helper/dlss5-load-helper.exe'];
const elevatedTest = 'test/loading-helper-elevated-native.test.js', elevatedReportFile = 'build/load-helper/elevated-native-fixture-verification.json';
const elevatedInputs = ['src/native/load-helper.cpp', elevatedTest, 'build/load-helper/dlss5-load-helper.exe',
  'resources/loading-helper/dlss5-load-helper.exe', 'build/load-helper/fixture-target.exe', 'build/load-helper/fixture-module.dll'];
if (process.platform !== 'win32') throw new Error('Native fixture verification requires Windows.');
for (const file of binaryFiles) if (getBitness(path.join(root, file)) !== 64) throw new Error(`Missing x64 fixture or helper: ${file}`);
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
if (manifest.sha256 !== sha(binaryFiles[0]) || manifest.sha256 !== sha(binaryFiles[binaryFiles.length - 1]) || manifest.sourceSha256 !== sha(sourceFiles[0])) throw new Error('Helper source, build, and resource identities do not match. Rebuild and prepare the helper first.');
const identities = Object.fromEntries([...sourceFiles, ...testFiles, ...binaryFiles, elevatedTest].map(file => [file, sha(file)]));
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...testFiles], { cwd: root, windowsHide: true, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error('Loading helper verification failed; no successful fixture claim recorded.');
for (const [file, expected] of Object.entries(identities)) if (sha(file) !== expected) throw new Error(`Fixture input changed during verification: ${file}`);
let elevated = null;
try {
  const previous = JSON.parse(fs.readFileSync(path.join(root, elevatedReportFile), 'utf8'));
  if (previous.version === 1 && previous.scope === 'explicit-same-user-high-integrity-fixtures-only' && previous.passed === true && previous.realGame === false &&
      previous.ordinaryModeRejected === true && previous.elevatedTargetAttached === true && Number.isFinite(Date.parse(previous.checkedAt)) &&
      Object.keys(previous.identities || {}).length === elevatedInputs.length && elevatedInputs.every(file => previous.identities[file] === identities[file]))
    elevated = { checkedAt: previous.checkedAt, reportSha256: sha(elevatedReportFile) };
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const report = { version: 1, checkedAt: new Date().toISOString(), scope: 'ordinary-user-owned-fixtures-only', passed: true, realGame: false,
  elevatedNativeFixture: Boolean(elevated), ...(elevated ? { elevated } : {}), identities };
fs.writeFileSync(path.join(root, 'build/load-helper/native-fixture-verification.json'), JSON.stringify(report, null, 2) + '\n');
manifest.verification = { compiled: true, nativeFixture: true, elevatedNativeFixture: Boolean(elevated), ...(elevated ? { elevated } : {}), realGame: false, scope: report.scope, checkedAt: report.checkedAt,
  reportSha256: sha('build/load-helper/native-fixture-verification.json'), testFiles: Object.fromEntries(testFiles.map(file => [file, identities[file]])) };
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
console.log('Loading helper fixture verification recorded. Real-game compatibility remains unverified.');
