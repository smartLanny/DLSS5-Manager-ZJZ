'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateIsolationProof } = require('../scripts/startup-uninstrumented-smoke');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');

test('unmodified startup is gated on prior userData proof for the exact branded EXE and ASAR', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-isolation-proof-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const exe = path.join(root, 'manager.exe'), archive = path.join(root, 'app.asar');
  fs.writeFileSync(exe, 'fixture executable'); fs.writeFileSync(archive, 'fixture archive');
  const proof = { ok: true, packagedExecutable: true, executableSha256: hash('fixture executable'), sourceSha256: hash('fixture archive'),
    runs: [{ ok: true, mode: 'normal', packagedExecutable: true, userDataFlagHonoredBeforeInstrumentation: true, tokenElevated: false }] };
  assert.doesNotThrow(() => validateIsolationProof(proof, exe, archive));
  const withoutProfileProof = structuredClone(proof); withoutProfileProof.runs[0].userDataFlagHonoredBeforeInstrumentation = false;
  assert.throws(() => validateIsolationProof(withoutProfileProof, exe, archive), /proving/);
  assert.throws(() => validateIsolationProof({ ...proof, packagedExecutable: false }, exe, archive), /proving/);
  fs.writeFileSync(exe, 'new candidate');
  assert.throws(() => validateIsolationProof(proof, exe, archive), /exact EXE\/ASAR/);
  fs.writeFileSync(exe, 'fixture executable'); fs.writeFileSync(archive, 'new app code');
  assert.throws(() => validateIsolationProof(proof, exe, archive), /exact EXE\/ASAR/);
});
