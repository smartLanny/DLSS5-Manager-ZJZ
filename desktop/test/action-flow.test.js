'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { executeUiAction, resolveUiEnvelope } = require('../src/renderer/action-flow');

test('completed action stays successful when the follow-up refresh fails', async () => {
  const refreshError = new Error('temporary scan failure');
  const outcome = await executeUiAction(
    async () => 'installed',
    async () => { throw refreshError; }
  );

  assert.equal(outcome.completed, true);
  assert.equal(outcome.value, 'installed');
  assert.equal(outcome.refreshError, refreshError);
});

test('action errors are still surfaced as action failures', async () => {
  const actionError = new Error('write failed');
  const outcome = await executeUiAction(async () => { throw actionError; });

  assert.equal(outcome.completed, false);
  assert.equal(outcome.error, actionError);
});

test('confirmed actions keep successful IPC envelopes for the outer action flow', async () => {
  const envelope = { ok: true, value: { complete: true } };
  const resolved = await resolveUiEnvelope(async () => envelope, () => {
    throw new Error('successful IPC result was unwrapped twice');
  });

  assert.equal(resolved, envelope);
});

test('confirmed actions still unwrap failed IPC envelopes for confirmation handling', async () => {
  const error = Object.assign(new Error('anti-cheat warning'), { code: 'ERR_ANTI_CHEAT_CONFIRM' });
  await assert.rejects(
    () => resolveUiEnvelope(async () => ({ ok: false, error }), result => {
      throw Object.assign(new Error(result.error.message), result.error);
    }),
    caught => caught.code === 'ERR_ANTI_CHEAT_CONFIRM'
  );
});
