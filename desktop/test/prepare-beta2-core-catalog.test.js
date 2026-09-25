'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const catalog = require('../scripts/prepare-beta2-core-catalog');

test('D21 is a complete explicit test choice but never a comparison-only or default Core', () => {
  assert.equal(catalog.D21_POLICY.coreUpdateOnly, false);
  assert.equal(catalog.D21_POLICY.comparisonOnly, false);
  assert.equal(catalog.D21_POLICY.stableRelease, false);
});

test('0.4.7 catalog keeps its exact automatic DX11 Bridge 1.4.12 companion', () => {
  assert.equal(catalog.FILES047['dlss5-native-carrier-045-dx11-compat.addon64'],
    '4656d9aac382a6f9b5c8488669aa5365283f03b5b94b2267f1c7f9b53927dc86');
});

test('beta2 catalog accepts explicitly supplied external NR runtimes when the thin base omits them', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beta2-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, 'base');
  const runtime = path.join(root, 'rtx40-runtime.dll');
  fs.mkdirSync(path.join(base, 'fixed', 'RTX40'), { recursive: true });
  fs.writeFileSync(path.join(base, 'fixed', 'RTX40', 'ReShade64.dll'), 'loader');
  fs.writeFileSync(runtime, 'runtime');

  assert.equal(catalog.resolveFixedSource(base, 'RTX40', 'ReShade64.dll', {}),
    path.join(base, 'fixed', 'RTX40', 'ReShade64.dll'));
  assert.equal(catalog.resolveFixedSource(base, 'RTX40', 'nvngx_dlssnr.dll', { RTX40: runtime }), runtime);
  assert.throws(() => catalog.resolveFixedSource(base, 'RTX40', 'nvngx_dlssnr.dll', {}),
    /--runtime40/);
});
