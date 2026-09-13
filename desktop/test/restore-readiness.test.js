'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture } = require('./helpers/operation-integration-fixture');

async function prepareBase(t) {
  const f = await fixture(t);
  await f.apply({ api: 'dx12', version: 'fixture-core-1', deployment: 'local' });
  return f;
}

function requestRecord(f) {
  const value = JSON.parse(fs.readFileSync(f.settings.requestFile, 'utf8'));
  return value.games[require('node:path').resolve(f.gameRoot).toLowerCase()];
}

function receipt(f) {
  return JSON.parse(fs.readFileSync(f.settings.receiptFile(f.id), 'utf8'));
}

for (const [domain, request] of [
  ['sr', { backend: 'native', quality: 'preserve', preset: 'K' }],
  ['fg', { backend: 'nvidia', mode: 'fixed', multiplier: 2 }]
]) {
  test(`unified ${domain.toUpperCase()} restore delegates to its owner and clears readiness`, async t => {
    const f = await prepareBase(t);
    await f.apply({ [domain]: request });
    assert.ok((await f.settings.savedRequests(f.id))[domain], `${domain} request should be saved before restore`);
    assert.ok(receipt(f).applied[domain], `${domain} receipt should exist before restore`);

    await f.apply({ [domain]: domain === 'sr' ? { backend: 'native', quality: 'game' } : { backend: 'nvidia', mode: 'restore' } });
    const writesAfterRestore = f.events.filter(row => row === 'driver-write').length;

    const record = requestRecord(f), saved = await f.settings.savedRequests(f.id), after = receipt(f);
    assert.equal(saved[domain], undefined, `${domain} restore must remove its saved request`);
    assert.equal(after.applied[domain], undefined, `${domain} restore must remove its receipt ownership`);
    if (domain === 'sr') assert.equal(record._srManaged.exe, f.exe, 'SR restore retains the ownership marker');
    const readiness = await f.coordinator.inspectLaunchReadiness(f.id);
    assert.equal(readiness.state, 'ready');
    assert.deepEqual(readiness.blockers, []);

    const beforeLaunch = await f.settings.beforeLaunch(f.id);
    assert.deepEqual(beforeLaunch, []);
    assert.equal(f.events.filter(row => row === 'driver-write').length, writesAfterRestore,
      'beforeLaunch must not write the driver after owner restore');
  });
}

test('failed SR restore preserves the saved request and receipt baseline', async t => {
  const f = await prepareBase(t);
  const request = { backend: 'native', quality: 'preserve', preset: 'K' };
  await f.apply({ sr: request });
  const beforeRecord = requestRecord(f), beforeReceipt = receipt(f);
  f.driver.failOnce();

  await assert.rejects(f.apply({ sr: { backend: 'native', quality: 'game' } }));

  assert.deepEqual(requestRecord(f).sr.request, beforeRecord.sr.request);
  assert.deepEqual(receipt(f).applied.sr, beforeReceipt.applied.sr);
  assert.equal(requestRecord(f)._srManaged.exe, f.exe);
});
