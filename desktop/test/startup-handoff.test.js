'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStartupHandoff } = require('../src/product/startup-handoff');
const parentSession = '11111111-1111-1111-1111-111111111111';
const childSession = '22222222-2222-2222-2222-222222222222';

function fixture(t, timeoutMs = 25) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-elevation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const parent = createStartupHandoff({ directory, sessionId: parentSession, pid: 101, timeoutMs, pollMs: 2 });
  const child = createStartupHandoff({ directory, sessionId: childSession, pid: 202, timeoutMs, pollMs: 2 });
  return { parent, child, ticket: parent.begin() };
}

test('a new administrator session acknowledges all readiness stages before the parent handoff completes', async t => {
  const f = fixture(t);
  assert.equal(f.child.readyChild(f.ticket.nonce, { administrator: true, instanceLockOwned: true }), true);
  const reply = await f.parent.wait(f.ticket);
  assert.equal(reply.childSession, childSession); assert.equal(reply.childPid, 202);
  for (const key of ['windowVisible', 'pageLoaded', 'rendererReady', 'administrator', 'instanceLockOwned']) assert.equal(reply[key], true, key);
  f.parent.finish(f.ticket); assert.equal(fs.existsSync(f.ticket.names.request), false);
});

test('old-session, wrong-nonce and partial-ready receipts cannot pass a handoff', async t => {
  for (const override of [{ childSession: parentSession }, { nonce: '33333333-3333-3333-3333-333333333333' }, { rendererReady: false }, { childPid: 101 }]) {
    const f = fixture(t);
    fs.writeFileSync(f.ticket.names.response, JSON.stringify({ version: 1, nonce: f.ticket.nonce, parentSession,
      requestCreatedAt: f.ticket.createdAt, childSession, childPid: 202, status: 'ready',
      administrator: true, instanceLockOwned: true, windowVisible: true, pageLoaded: true, rendererReady: true, ...override }));
    await assert.rejects(f.parent.wait(f.ticket), { code: 'STARTUP_CHILD_NOT_READY' });
  }
});

test('a parent cannot acknowledge its own startup and an unprivileged child reports failure', async t => {
  const f = fixture(t);
  assert.equal(f.parent.readyChild(f.ticket.nonce, { administrator: true, instanceLockOwned: true }), false);
  assert.equal(f.child.readyChild(f.ticket.nonce, { administrator: false, instanceLockOwned: true }), false);
  await assert.rejects(f.parent.wait(f.ticket), { code: 'STARTUP_CHILD_FAILED' });
});

test('timeout sends an observable cancellation, and a late child cannot revive the old request', async t => {
  const f = fixture(t);
  await assert.rejects(f.parent.wait(f.ticket), { code: 'STARTUP_CHILD_NOT_READY' });
  f.parent.cancel(f.ticket);
  let cancelled = false;
  const stop = f.child.listen(f.ticket.nonce, () => { cancelled = true; });
  t.after(stop);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(cancelled, true);
  assert.equal(f.child.readyChild(f.ticket.nonce, { administrator: true, instanceLockOwned: true }), false);
});
