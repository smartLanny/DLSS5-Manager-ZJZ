'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {createManagerUpdate,validateManifest,compareVersions}=require('../src/product/manager-update');

function fixture(t, overrides={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'manager-update-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const app=path.join(root,'app'),updates=path.join(app,'data','updates'),exe=path.join(app,'DLSS 5 AI 超分管理器.exe');
  fs.mkdirSync(app,{recursive:true});fs.writeFileSync(exe,'old');fs.writeFileSync(path.join(app,'DLSS5-Manager.portable.json'),'{}');
  const bytes=Buffer.from('verified update archive'),sha256=crypto.createHash('sha256').update(bytes).digest('hex');
  const manifest={schema:'dlss5-manager-update-v1',version:'0.5.1',channel:'preview',notes:'修复启动问题',releaseUrl:'https://github.com/smartLanny/DLSS5-Manager-ZJZ/releases/tag/v0.5.1',artifact:{format:'directory-portable-zip',url:'https://github.com/smartLanny/DLSS5-Manager-ZJZ/releases/download/v0.5.1/DLSS5-Manager-0.5.1-Portable.zip',bytes:bytes.length,sha256}};
  const responses=[];const fetch=async url=>{responses.push(url);return url.endsWith('update-manifest.json')?{ok:true,text:async()=>JSON.stringify(manifest)}:{ok:true,body:Readable.from(bytes)};};
  const extract=async(_archive,dest)=>{fs.mkdirSync(dest,{recursive:true});fs.writeFileSync(path.join(dest,path.basename(exe)),'new');fs.writeFileSync(path.join(dest,'DLSS5-Manager.portable.json'),'{}');};
  const calls=[];const update=createManagerUpdate({currentVersion:'0.5.0-beta.2',manifestUrl:'https://github.com/smartLanny/DLSS5-Manager-ZJZ/releases/latest/download/update-manifest.json',root:updates,applicationDirectory:app,executable:exe,portable:true,fetch,extract,spawn:(file,args,options)=>{calls.push({file,args,options});return{unref(){}};},...overrides});
  return {root,app,updates,exe,bytes,manifest,responses,calls,update};
}

test('version comparison understands preview versions and releases',()=>{
  assert.equal(compareVersions('0.5.0-beta.2','0.5.0-beta.1'),1);
  assert.equal(compareVersions('0.5.0','0.5.0-beta.2'),1);
  assert.equal(compareVersions('0.5.1','0.5.0'),1);
  assert.equal(compareVersions('0.5.0','0.5.0'),0);
});
test('manifest permits only the fixed repository, portable ZIP, exact size and SHA-256',()=>{
  const f={schema:'dlss5-manager-update-v1',version:'0.5.1',artifact:{format:'directory-portable-zip',url:'https://github.com/smartLanny/DLSS5-Manager-ZJZ/releases/download/v0.5.1/a.zip',bytes:10,sha256:'a'.repeat(64)}};
  assert.equal(validateManifest(f).version,'0.5.1');
  assert.throws(()=>validateManifest({...f,artifact:{...f.artifact,url:'https://example.com/a.zip'}}),/来源/);
  assert.throws(()=>validateManifest({...f,artifact:{...f.artifact,sha256:'renamed'}}),/摘要/);
});
test('check, download, digest, stage and detached replacement handoff share one verified record',async t=>{
  const f=fixture(t),checked=await f.update.check();assert.equal(checked.available,true);
  const pending=await f.update.prepare(checked.manifest);assert.equal(pending.targetVersion,'0.5.1');
  assert.equal(fs.existsSync(path.join(pending.staged,path.basename(f.exe))),true);
  const launched=await f.update.launchApply();assert.deepEqual(launched,{launched:true,targetVersion:'0.5.1'});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.detached,true);assert.ok(f.calls[0].args.includes(f.app));
  assert.ok(f.calls[0].args.includes('-PendingFile'));assert.ok(f.calls[0].args.includes(path.join(f.updates,'pending.json')));
  const script=fs.readFileSync(path.join(f.updates,'apply-manager-update.ps1'),'utf8');
  assert.match(script,/Get-ChildItem -LiteralPath \$rollbackRoot/);assert.match(script,/Remove-Item -LiteralPath \$PendingFile/);
});
test('a newly verified update replaces stale staged versions and the pending record',async t=>{
  const f=fixture(t),stale=path.join(f.updates,'staged-0.5.0');fs.mkdirSync(stale,{recursive:true});fs.writeFileSync(path.join(stale,'old'),'old');
  fs.writeFileSync(path.join(f.updates,'pending.json'),'{}');
  const pending=await f.update.prepare(f.manifest);
  assert.equal(fs.existsSync(stale),false);assert.equal(fs.existsSync(pending.staged),true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.updates,'pending.json'),'utf8')).targetVersion,'0.5.1');
});
test('digest mismatch is rejected and temporary download directories are removed',async t=>{
  const f=fixture(t);f.manifest.artifact.sha256='0'.repeat(64);
  await assert.rejects(f.update.prepare(f.manifest),error=>error.code==='UPDATE_DIGEST');
  assert.equal(fs.readdirSync(f.updates).some(name=>name.startsWith('.download-')),false);
});
test('automatic replacement is restricted to marked directory-portable mode',async t=>{
  const f=fixture(t,{portable:false});
  await assert.rejects(f.update.prepare(f.manifest),error=>error.code==='UPDATE_PORTABLE_ONLY');
});
