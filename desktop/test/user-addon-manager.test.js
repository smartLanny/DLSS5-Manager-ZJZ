'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createUserAddonManager, RECEIPT } = require('../src/product/user-addon-manager');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'manager-user-addon-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const componentRoot = path.join(root, 'components'), gameDir = path.join(root, 'game'), exe = path.join(gameDir, 'game.exe');
  const bytes = Buffer.from('MZ user addon fixture');
  const digest = hash(bytes), name = 'renodx-dlss-26091112-zh.addon64';
  const object = path.join(componentRoot, 'objects', digest, name);
  fs.mkdirSync(path.dirname(object), { recursive: true }); fs.writeFileSync(object, bytes);
  fs.mkdirSync(gameDir, { recursive: true }); fs.writeFileSync(exe, 'game');
  const item = { id:`user-addon-${digest.slice(0,24)}`, kind:'user-addon', architecture:'x64', variant:'RenoDX 用户模块',
    files:[{file:`objects/${digest}/${name}`,name,sha256:digest,bytes:bytes.length}] };
  const game = { id:'game-one', dir:gameDir, scan:{chosen:{path:exe}} };
  let closed = 0;
  const manager = createUserAddonManager({ componentRoot, assertGameClosed:async () => { closed++; }, environment:{} });
  return { root, componentRoot, gameDir, exe, bytes, digest, name, item, game, manager, get closed(){return closed;} };
}

test('user Add-on install and removal are receipt-owned and hash checked', async t => {
  const f = fixture(t), target = path.join(f.gameDir, f.name);
  const installed = await f.manager.setEnabled(f.game, f.item, true);
  assert.equal(installed.installed, true); assert.deepEqual(fs.readFileSync(target), f.bytes); assert.equal(f.closed, 1);
  const rows = await f.manager.inspect(f.game, [f.item], true);
  assert.equal(rows[0].installed, true); assert.equal(rows[0].managed, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.gameDir, RECEIPT))).items[0].sha256, f.digest);
  const removed = await f.manager.setEnabled(f.game, f.item, false);
  assert.equal(removed.installed, false); assert.equal(fs.existsSync(target), false); assert.equal(f.closed, 2);
});

test('user Add-on never overwrites or deletes an unmanaged same-name file', async t => {
  const f = fixture(t), target = path.join(f.gameDir, f.name);
  fs.writeFileSync(target, 'someone else');
  await assert.rejects(f.manager.setEnabled(f.game, f.item, true), { code:'USER_ADDON_COLLISION' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'someone else');
  const result = await f.manager.setEnabled(f.game, f.item, false);
  assert.equal(result.changed, false); assert.equal(fs.readFileSync(target, 'utf8'), 'someone else');
});

test('a forged receipt cannot make bulk removal escape the active Add-on directory', async t => {
  const f = fixture(t), outside = path.join(f.root, 'outside', f.name);
  fs.mkdirSync(path.dirname(outside), { recursive: true }); fs.writeFileSync(outside, f.bytes);
  const receipt = path.join(f.gameDir, RECEIPT); fs.mkdirSync(path.dirname(receipt), { recursive: true });
  fs.writeFileSync(receipt, JSON.stringify({ schema:1, gameId:f.game.id,
    items:[{componentId:f.item.id,name:f.name,target:outside,sha256:f.digest}] }));
  await assert.rejects(f.manager.removeAll(f.game), { code:'USER_ADDON_CHANGED' });
  assert.deepEqual(fs.readFileSync(outside), f.bytes);
});

