'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createNrCoreIdentity, UNIFORM_CORE_HASHES } = require('../src/product/nr-core-identity');
const { resolveContract, UNIFORM_SOURCE } = require('../src/product/nr-config-contract');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-nr-core-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'synthetic.addon64'); fs.writeFileSync(file, 'synthetic Core identity fixture');
  return file;
}
test('both reviewed identities resolve unified3 independently of installed display label', async t => {
  const file = fixture(t);
  for (const hash of UNIFORM_CORE_HASHES) {
    const identify = createNrCoreIdentity({ digest: async () => hash });
    const result = await identify({ version: 'imported-opaque', files: [{ path: file, sha256: hash }] });
    assert.equal(result.sourceCommit, UNIFORM_SOURCE); assert.equal(resolveContract(result).uniform, true);
    assert.equal(result.identityStatus, 'verified');
  }
});
test('menu and receipt labels cannot promote unknown installed bytes to unified3', async t => {
  const file = fixture(t), identify = createNrCoreIdentity();
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const unknown = await identify({ version: '0.5-unified3', files: [{ path: file, sha256: hash }] });
  assert.equal(unknown.identityStatus, 'unrecognized'); assert.equal(resolveContract(unknown).known, false);
  const old = await identify({ version: '0.3.3.5', files: [{ path: file, sha256: hash }] });
  assert.equal(resolveContract(old).id, 'nr-legacy');
  const changed = await identify({ version: '0.3.3.5', files: [{ path: file, sha256: '0'.repeat(64) }] });
  assert.equal(changed.identityStatus, 'changed'); assert.equal(resolveContract(changed).known, false);
});
test('identity cache avoids repeated large reads and fresh writes rehash unchanged files', async t => {
  const file = fixture(t); let calls = 0;
  const identify = createNrCoreIdentity({ digest: async () => { calls++; return UNIFORM_CORE_HASHES[0]; } });
  const input = { files: [{ path: file, sha256: UNIFORM_CORE_HASHES[0] }] };
  await identify(input); await identify(input); assert.equal(calls, 1);
  await identify({ ...input, fresh: true }); assert.equal(calls, 2);
  fs.appendFileSync(file, 'changed'); await identify(input); assert.equal(calls, 3);
});
test('ambiguous, missing and changing files leave capability unknown', async t => {
  const file = fixture(t), identify = createNrCoreIdentity();
  assert.equal((await identify()).identityStatus, 'missing');
  assert.equal((await identify({ files: [{ path: file }, { path: file + '.other' }] })).identityStatus, 'ambiguous');
  const changing = createNrCoreIdentity({ digest: async () => { fs.appendFileSync(file, 'mutation'); return UNIFORM_CORE_HASHES[0]; } });
  assert.equal((await changing({ files: [{ path: file }] })).identityStatus, 'unreadable');
});
