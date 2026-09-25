'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planFullBundle } = require('../scripts/build-local-full.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-local-full-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = name => { const value = path.join(root, name); fs.writeFileSync(value, name); return value; };
  return { root, portable: file('portable.zip'), renodx: file('renodx.zip'), rtx40: file('rtx40.zip'), rtx50: file('rtx50.zip') };
}
test('local Full.zip contains exactly four independently named packages and excludes the VC runtime', t => {
  const f = fixture(t), plan = planFullBundle({ ...f, output: path.join(f.root, 'Full.zip') });
  assert.deepEqual(plan.entries.map(row => row.name), ['01-DLSS5-Manager-Portable.zip', '02-RenoDX-Addon.zip', '03-RTX40-DLC.zip', '04-RTX50-DLC.zip']);
  assert.equal(plan.entries.length, 4);
});
test('local Full.zip refuses duplicate inputs and a VC runtime masquerading as a package', t => {
  const f = fixture(t);
  assert.throws(() => planFullBundle({ ...f, rtx50: f.rtx40, output: path.join(f.root, 'Full.zip') }), /不能指向同一文件/);
  const runtime = path.join(f.root, 'VC_redist.x64.zip'); fs.writeFileSync(runtime, 'runtime');
  assert.throws(() => planFullBundle({ ...f, renodx: runtime, output: path.join(f.root, 'Full.zip') }), /运行库必须放在 Full\.zip 外面/);
});
