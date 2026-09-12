'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture: createOperationFixture, put, hashFile, INSTALLED_NAMES } = require('./helpers/operation-integration-fixture');
const { RECEIPT, PENDING } = require('../src/product/external-runtime');
const { readManifest } = require('../src/product/manifest');
const { pendingPath } = require('../src/core/file-journal');

const consent = plan => ({ confirm: true, fingerprint: plan.fingerprint });

function snapshotTree(root, relative = '') {
  const result = {};
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.join(relative, entry.name), file = path.join(root, name);
    assert.equal(entry.isSymbolicLink(), false, 'the temporary profile contains only ordinary test files');
    if (entry.isDirectory()) {
      result[name] = { directory: true };
      Object.assign(result, snapshotTree(root, name));
    } else {
      assert.equal(entry.isFile(), true);
      result[name] = { size: fs.statSync(file).size, sha256: hashFile(file) };
    }
  }
  return result;
}

async function inactiveLegacyProfile(t) {
  const f = await createOperationFixture(t);
  put(path.join(f.exeDir, 'ReShade.ini'), '[ADDON]\r\nAddonPath=.\r\n[GENERAL]\r\nEffectSearchPaths=.\\shaders\\**\r\n[User]\r\nKeep=legacy-setting\r\n');
  await f.apply({ api: 'dx12', version: 'fixture-core-1', deployment: 'local' });
  await f.apply({ deployment: 'external' });
  const oldProfile = f.layout().runtimeDir, receiptFile = path.join(f.gameRoot, RECEIPT);
  assert.notEqual(JSON.parse(fs.readFileSync(receiptFile)).origin, 'direct', 'the fixture starts with the beta1 ordinary-to-external owner');
  await f.apply({ deployment: 'local' });
  await f.apply({ uninstall: 'restore' });
  const receipt = JSON.parse(fs.readFileSync(receiptFile));
  assert.equal(receipt.mode, 'local'); assert.notEqual(receipt.removed, true);
  assert.equal(readManifest(f.gameRoot), null, 'ordinary uninstall has completed');
  assert.equal(fs.existsSync(path.join(oldProfile, 'ReShade.ini')), true, 'the legacy owner leaves an inactive profile');
  assert.equal((await f.plans.inspect(f.id)).pending, false);
  return { f, oldProfile, receiptFile };
}

test('a beta1 local-external-local-uninstall cycle explicitly reinstalls to a new external profile without changing any old file', async t => {
  const { f, oldProfile, receiptFile } = await inactiveLegacyProfile(t);
  const original = snapshotTree(oldProfile), receiptHash = hashFile(receiptFile);
  const defaults = f.service.installationDefaults(f.id);
  assert.equal(defaults.deployment, 'local'); assert.equal(defaults.loadingMode, 'proxy');
  const request = { api: 'dx12', deployment: 'external' };
  const first = await f.plans.preview(f.id, request), repeated = await f.plans.preview(f.id, request);
  assert.deepEqual(first.blockers, []); assert.deepEqual(repeated.blockers, []);
  assert.equal(first.fingerprint, repeated.fingerprint);
  const nextProfile = first.deployment.layout.runtimeDir;
  assert.notEqual(nextProfile, oldProfile);
  assert.equal(repeated.deployment.layout.runtimeDir, nextProfile);
  assert.deepEqual(first.changes.map(row => row.path), repeated.changes.map(row => row.path));
  assert.deepEqual(snapshotTree(oldProfile), original, 'both previews preserve every legacy file and directory');
  assert.equal(hashFile(receiptFile), receiptHash);
  assert.equal(fs.existsSync(nextProfile), false, 'preview does not create the replacement runtime directory');
  const result = await f.plans.apply(first.planId, consent(first));
  assert.equal(result.applied, true);
  assert.equal(f.layout().mode, 'external'); assert.equal(f.layout().runtimeDir, nextProfile);
  assert.equal(fs.existsSync(path.join(nextProfile, INSTALLED_NAMES.addon)), true);
  assert.equal((await f.service.inspectDeployment(f.id)).ready, true);
  assert.deepEqual(snapshotTree(oldProfile), original, 'the replacement keeps all legacy files at their original paths and hashes');
  assert.equal((await f.plans.inspect(f.id)).pending, false);
});

test('an unknown file in a beta1 inactive profile blocks explicit external reinstall while default local preview leaves it inactive', async t => {
  const { f, oldProfile, receiptFile } = await inactiveLegacyProfile(t);
  const extra = path.join(oldProfile, 'user-added-unknown.addon64'); put(extra, 'unknown user file must remain in place');
  const original = snapshotTree(oldProfile), receiptHash = hashFile(receiptFile);
  const local = await f.plans.preview(f.id, { api: 'dx12' });
  assert.deepEqual(local.blockers, []); assert.equal(local.resolved.deployment, 'local');
  assert.deepEqual(snapshotTree(oldProfile), original, 'default local preview does not touch the inactive external profile');
  await assert.rejects(f.plans.preview(f.id, { api: 'dx12', deployment: 'external' }), error => {
    assert.equal(error.code, 'DEPLOYMENT_PROFILE_EXISTS');
    assert.match(error.message, /未归属|额外文件/);
    return true;
  });
  assert.deepEqual(snapshotTree(oldProfile), original);
  assert.equal(hashFile(receiptFile), receiptHash);
  assert.equal(fs.existsSync(path.join(f.gameRoot, PENDING)), false);
  assert.equal(fs.existsSync(pendingPath(f.gameRoot)), false);
  assert.equal((await f.plans.inspect(f.id)).pending, false);
  assert.equal(readManifest(f.gameRoot), null);
});
