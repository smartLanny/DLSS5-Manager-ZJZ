'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MARKER, resolvePortableData, configurePortableData } = require('../src/product/portable-data');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-data-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const exe = path.join(root, 'DLSS 5 AI 超分管理器.exe'); fs.writeFileSync(exe, 'exe');
  return { root, exe };
}

test('only a packaged directory with the portable marker redirects data beside the executable', t => {
  const f = fixture(t);
  assert.equal(resolvePortableData({ executable:f.exe, packaged:true }), null);
  fs.writeFileSync(path.join(f.root, MARKER), JSON.stringify({schemaVersion:1,mode:'directory-portable'}));
  assert.equal(resolvePortableData({ executable:f.exe, packaged:false }), null);
  const value = resolvePortableData({ executable:f.exe, packaged:true });
  assert.equal(value.root, path.join(f.root,'data'));
  assert.equal(value.cache, path.join(f.root,'data','cache'));
});

test('portable setup redirects user data, Chromium session and cache before startup', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, MARKER), JSON.stringify({schemaVersion:1,mode:'directory-portable'}));
  const paths = {}, switches = [];
  const app = { isPackaged:true, setPath:(name,value) => paths[name]=value,
    commandLine:{appendSwitch:(name,value)=>switches.push([name,value])} };
  const value = configurePortableData(app, { executable:f.exe, packaged:true });
  assert.deepEqual(paths, { userData:value.root, sessionData:path.join(value.root,'chromium'), cache:path.join(value.root,'cache') });
  assert.deepEqual(switches, [['disk-cache-dir', path.join(value.root,'cache')]]);
  for (const name of ['logs','component-library','updates','chromium','cache']) assert.equal(fs.statSync(path.join(value.root,name)).isDirectory(), true);
});
