'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const script = path.resolve(__dirname, '../scripts/prepare-versioned-payload.ps1');

test('payload preparation rejects mismatched compatibility files before replacing old slots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-payload-preflight-'));
  try {
    const payload = path.join(root, 'payload', 'nr-before-sr');
    const current = path.join(payload, 'versions', '0.4.5-ota');
    const oldDx11 = path.join(payload, 'versions', '0.4.2-dx11-native-bridge-exp1-r1');
    fs.mkdirSync(current, { recursive: true });
    fs.mkdirSync(oldDx11, { recursive: true });
    fs.writeFileSync(path.join(current, 'keep.txt'), 'current-slot-must-survive');
    fs.writeFileSync(path.join(oldDx11, 'keep.txt'), 'old-slot-must-survive');
    const fake = path.join(root, 'renamed-English-or-old.bin');
    fs.writeFileSync(fake, 'wrong compatibility bytes');

    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Legacy40', root, '-Legacy50', root, '-Stable40', root, '-Stable50', root,
      '-CompatAddon', fake, '-CompatBridge', fake, '-CompatCarrier', fake, '-CompatConfig', fake,
      '-ReShade64', fake, '-Legacy02', root, '-PayloadRoot', payload
    ];
    // This production script supports the inbox Windows PowerShell too; do
    // not require a separately installed PowerShell 7 merely to test its gate.
    const executable = process.env.DLSS5_TEST_POWERSHELL || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
    // Node otherwise passes PowerShell 7's module search path verbatim to
    // Windows PowerShell 5, where its Utility module cannot be loaded.
    const env = { ...process.env };
    if (process.platform === 'win32' && /^powershell(?:\.exe)?$/i.test(path.basename(executable))) delete env.PSModulePath;
    const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 30000, env });
    assert.ifError(result.error);
    assert.equal(typeof result.status, 'number', 'the production preflight must actually execute');
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Reviewed compatibility input hash mismatch for Chinese core/);
    assert.equal(fs.readFileSync(path.join(current, 'keep.txt'), 'utf8'), 'current-slot-must-survive');
    assert.equal(fs.readFileSync(path.join(oldDx11, 'keep.txt'), 'utf8'), 'old-slot-must-survive');
    assert.equal(fs.readdirSync(current).length, 1);
    assert.equal(fs.readdirSync(oldDx11).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recursive replacement is scoped and rejects reparse-point directories', () => {
  const source = fs.readFileSync(script, 'utf8');
  assert.match(source, /StartsWith\(\$prefix, \[StringComparison\]::OrdinalIgnoreCase\)/);
  assert.match(source, /\[IO\.FileAttributes\]::ReparsePoint/);
  assert.match(source, /Assert-PlainDirectory \(Join-Path \$versions '0\.4\.5-ota'\) \$versions/);
  assert.doesNotMatch(source, /0\.4\.2-dx11-native-bridge-exp1-r1|\$oldDx11/);
  assert.match(source, /verify-payload\.js'\) --write --dir \$payload/);
});
