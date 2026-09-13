'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { createLaunchContext } = require('../src/product/launch-evidence');
const { createStore } = require('../src/product/state-store');

test('reads only the selected Steam app launch options from bounded local profiles', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'userdata', '123', 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'localconfig.vdf'), '"UserLocalConfigStore" { "Software" { "Valve" { "Steam" { "apps" { "42" { "LaunchOptions" "-dx12" } "99" { "LaunchOptions" "private unrelated option" } } } } } }');
  const context = createLaunchContext()({ launcher: 'Steam', steamRoot: root, id: '42' });
  assert.deepEqual(context.launchArguments, ['-dx12']);
  assert.equal(JSON.stringify(context).includes('private'), false);
});

test('API override survives store reload, remains bound to an EXE and can return to auto', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-api-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  const key = root.toLowerCase();
  const exe = path.join(root, 'game.exe');
  await createStore(file).write({ gameOverrides: { [key]: { api: 'dx12', apiExecutable: exe } } });
  assert.equal(createStore(file).read().gameOverrides[key].api, 'dx12');
  assert.equal(createStore(file).read().gameOverrides[key].apiExecutable, exe);
  await createStore(file).write({ gameOverrides: { [key]: { api: 'auto', apiExecutable: exe } } });
  assert.equal(createStore(file).read().gameOverrides[key], undefined);
});
