'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStartupPrerequisite, VC_REDIST_HELP } = require('../src/product/startup-prerequisite');

function fixture(result, response = 1) {
  const dialogs = [], opened = [];
  const check = createStartupPrerequisite({ executable:'C:\\Manager\\DLSS5 Manager.exe', platform:'win32',
    inspect:options => { assert.equal(options.applicationDirectory, 'C:\\Manager'); return result; },
    dialog:{ async showMessageBox(value) { dialogs.push(value); return { response }; } },
    shell:{ async openExternal(url) { opened.push(url); } } });
  return { check, dialogs, opened };
}

test('available or unknown runtime does not interrupt startup', async () => {
  for (const status of ['available', 'unknown']) {
    const row = fixture({ status, ready:status === 'available', missing:[] });
    assert.deepEqual(await row.check.ensureReady(), { proceed:true, prompted:false,
      result:{ status, ready:status === 'available', missing:[] } });
    assert.equal(row.dialogs.length, 0);
  }
});

test('missing system runtime links only to the fixed Microsoft page and stops this launch', async () => {
  const row = fixture({ status:'missing', ready:false, repair:'vc-redist', missing:['vcruntime140_1.dll'] }, 0);
  const result = await row.check.ensureReady();
  assert.equal(result.proceed, false); assert.equal(result.action, 'official-download');
  assert.deepEqual(row.opened, [VC_REDIST_HELP]);
  assert.match(row.dialogs[0].message, /Visual C\+\+ x64/);
  assert.match(row.dialogs[0].detail, /Core、Bridge、Feeder/);
  assert.doesNotMatch(row.dialogs[0].detail, /C:\\/);
});

test('invalid local runtime asks for a clean extraction instead of recommending VC redist', async () => {
  const row = fixture({ status:'missing', ready:false, repair:'game-files', missing:['msvcp140.dll'] }, 0);
  const result = await row.check.ensureReady();
  assert.equal(result.proceed, false); assert.equal(result.action, 'close'); assert.equal(row.opened.length, 0);
  assert.match(row.dialogs[0].detail, /重新解压完整管理器/);
  assert.equal(row.dialogs[0].buttons.includes('打开微软官方下载页'), false);
});

test('advanced continue choice is explicit and non-destructive', async () => {
  const row = fixture({ status:'missing', ready:false, repair:'vc-redist', missing:['msvcp140.dll'] }, 1);
  const result = await row.check.ensureReady();
  assert.equal(result.proceed, true); assert.equal(result.action, 'continue'); assert.equal(row.opened.length, 0);
});
