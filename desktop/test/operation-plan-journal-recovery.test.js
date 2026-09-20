'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, put } = require('./helpers/operation-integration-fixture');
const { PENDING } = require('../src/product/external-runtime');

test('production external WAL without a unified ledger recovers from the unified maintenance action', async t => {
  const f = await fixture(t, { external: { afterWrite: ({ row }) => {
    if (row.role === 'game-proxy') throw Object.assign(new Error('interrupted legacy deployment'), { preservePending: true });
  } } });
  const config = path.join(f.exeDir, 'ReShade.ini'), original = '[ADDON]\nAddonPath=.\n[User]\nKeep=42\n'; put(config, original);
  const preview = await f.service.previewDeployment(f.id, { mode: 'external', api: 'dx12', version: 'fixture-core-1' });
  await assert.rejects(f.service.applyDeployment(preview.planId), error => error.preservePending === true);
  assert.equal((await f.service.inspectDeployment(f.id)).pending, true);
  assert.equal((await f.plans.inspect(f.id)).pending, false);
  const result = await f.plans.recover(f.id);
  assert.equal(result.recovered, true); assert.equal((await f.service.inspectDeployment(f.id)).pending, false);
  assert.equal(fs.existsSync(path.join(f.gameRoot, PENDING)), false);
  assert.equal(fs.existsSync(path.join(f.userData, 'operation-plans')), false);
  assert.equal(fs.readFileSync(config, 'utf8'), original);
});
