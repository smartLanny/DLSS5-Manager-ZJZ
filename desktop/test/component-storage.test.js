'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveComponentStorage, moveComponentStorage, finalizeComponentStorageMove } = require('../src/product/component-storage');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function temporary(t, name) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), name));
  t.after(() => fs.rmSync(root,{recursive:true,force:true})); return root;
}
function inventory(root) {
  const bytes = Buffer.from('large-component'), sha256 = hash(bytes), rel = `objects/${sha256}/component.dll`;
  fs.mkdirSync(path.join(root,path.dirname(rel)),{recursive:true}); fs.writeFileSync(path.join(root,rel),bytes);
  fs.writeFileSync(path.join(root,'inventory.json'),JSON.stringify({schemaVersion:1,selected:{},packages:[{id:'fixture',files:[{file:rel,name:'component.dll',sha256,bytes:bytes.length}]}]}));
}

test('fresh portable and custom installs keep the large component library beside the chosen program/data drive', t => {
  const root=temporary(t,'manager-storage-'), userData=path.join(root,'user'), program=path.join(root,'program'), portable=path.join(program,'Manager.exe');
  fs.mkdirSync(userData); fs.mkdirSync(program); fs.writeFileSync(portable,'');
  assert.deepEqual(resolveComponentStorage({userData,portableExecutable:portable}),
    {root:path.join(program,'DLSS5-Manager-Data','component-library'),mode:'portable',legacyRoot:path.join(userData,'component-library')});
  const custom=path.join(root,'other-drive','my-components');
  assert.equal(resolveComponentStorage({userData,portableExecutable:portable,configuredRoot:custom}).root,custom);
});

test('an existing legacy library is preserved until an explicit verified move', t => {
  const root=temporary(t,'manager-storage-legacy-'), userData=path.join(root,'user'), program=path.join(root,'program');
  fs.mkdirSync(program); inventory(path.join(userData,'component-library'));
  const resolved=resolveComponentStorage({userData,applicationDir:program});
  assert.equal(resolved.root,path.join(userData,'component-library')); assert.equal(resolved.mode,'legacy');
});

test('moving the legacy library verifies every referenced object before switching and removes C-drive data only on next startup', async t => {
  const root=temporary(t,'manager-storage-move-'), userData=path.join(root,'user'), source=path.join(userData,'component-library');
  const destination=path.join(root,'destination'); inventory(source); fs.mkdirSync(destination);
  const moved=await moveComponentStorage({userData,source,destinationBase:destination});
  assert.equal(moved.target,path.join(destination,'DLSS5-Manager-Data','component-library'));
  assert.equal(fs.existsSync(source),true); assert.equal(fs.existsSync(path.join(moved.target,'inventory.json')),true);
  const finalized=await finalizeComponentStorageMove({userData,configuredRoot:moved.target,allowedSources:[source]});
  assert.equal(finalized.removedSource,true); assert.equal(fs.existsSync(source),false);
});

test('a corrupted copied object never authorizes deletion of the old library', async t => {
  const root=temporary(t,'manager-storage-corrupt-'), userData=path.join(root,'user'), source=path.join(userData,'component-library');
  const destination=path.join(root,'destination'); inventory(source); fs.mkdirSync(destination);
  const moved=await moveComponentStorage({userData,source,destinationBase:destination});
  const data=JSON.parse(fs.readFileSync(path.join(moved.target,'inventory.json'),'utf8'));
  fs.appendFileSync(path.join(moved.target,data.packages[0].files[0].file),'changed');
  await assert.rejects(finalizeComponentStorageMove({userData,configuredRoot:moved.target,allowedSources:[source]}),/摘要/);
  assert.equal(fs.existsSync(source),true);
});

test('a source changed after copying is preserved instead of deleting later imports on restart', async t => {
  const root=temporary(t,'manager-storage-source-drift-'), userData=path.join(root,'user'), source=path.join(userData,'component-library');
  const destination=path.join(root,'destination'); inventory(source); fs.mkdirSync(destination);
  const moved=await moveComponentStorage({userData,source,destinationBase:destination});
  fs.writeFileSync(path.join(source,'imported-after-move.bin'),'later component');
  await assert.rejects(finalizeComponentStorageMove({userData,configuredRoot:moved.target,allowedSources:[source]}),/旧组件仓库.*变化/);
  assert.equal(fs.existsSync(source),true);
  assert.equal(fs.existsSync(path.join(source,'imported-after-move.bin')),true);
  assert.equal(fs.existsSync(path.join(userData,'component-library-move.json')),true);
});

test('finalization requires the source-local move authorization created during the copy', async t => {
  const root=temporary(t,'manager-storage-authorization-'), userData=path.join(root,'user'), source=path.join(userData,'component-library');
  const destination=path.join(root,'destination'); inventory(source); fs.mkdirSync(destination);
  const moved=await moveComponentStorage({userData,source,destinationBase:destination});
  const authorization=path.join(source,'.component-library-move-owner.json');
  assert.equal(fs.existsSync(authorization),true);
  fs.unlinkSync(authorization);
  await assert.rejects(finalizeComponentStorageMove({userData,configuredRoot:moved.target,allowedSources:[source]}),/清理授权/);
  assert.equal(fs.existsSync(source),true);
});
