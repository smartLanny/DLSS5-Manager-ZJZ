'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { createComponentLibrary, relativeName } = require('../src/product/component-library');
const { createCompactBundle, requirePayload } = require('../src/product/payload');
const { PAYLOAD_FILES } = require('../src/product/constants');
const { resolveOperationApi } = require('../src/product/operation-api');
const { assess } = require('../src/product/game-support');
const { zip } = require('./helpers/ota-fixture');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function setup(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'manager-components-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(128); bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550,64); bytes.writeUInt16LE(2,84); bytes.writeUInt16LE(0x20b,88);
  const dll = path.join(root, 'input.dll'); fs.writeFileSync(dll, bytes);
  const catalog = { packages: [{ id:'runtime-a',kind:'nr-runtime',version:'1.0',variant:'RTX20-40',hardwareFamilies:['RTX40'],architecture:'x64',interface:'NGX-Feature18',filename:'nvngx_dlssnr.dll',bytes:bytes.length,sha256:hash(bytes) }] };
  return { root, dll, bytes, lib:createComponentLibrary({ userData:root, catalog }) };
}
test('known runtime import verifies PE/hash and deduplicates without changing games', async t => {
  const f = setup(t); const first = await f.lib.importComponent(f.dll); await f.lib.importComponent(f.dll);
  assert.equal(first.changedGames, false); assert.equal((await f.lib.inventory()).packages.length, 1);
  assert.equal((await f.lib.inventory()).packages[0].hardwareFamilies[0], 'RTX40');
  fs.appendFileSync(f.dll, 'changed'); const changed=await f.lib.importComponent(f.dll);
  assert.equal(changed.packages[0].kind,'custom-candidate');assert.equal(changed.packages[0].validation,'blocked');
  assert.equal((await f.lib.inventory()).packages.length, 2);
});
test('an unknown x64 addon64 is cached as a user Add-on instead of masquerading as a Core', async t => {
  const f = setup(t), addon = path.join(f.root, 'renodx-dlss-26091112-zh.addon64');
  const bytes = Buffer.from(f.bytes); bytes[110] = 7; fs.writeFileSync(addon, bytes);
  const result = await f.lib.importComponent(addon), item = result.packages[0];
  assert.equal(item.kind, 'user-addon');
  assert.equal(item.architecture, 'x64');
  assert.equal(item.files[0].name, path.basename(addon));
  assert.match(item.id, /^user-addon-[a-f0-9]{24}$/);
  assert.equal((await f.lib.inventory()).packages[0].kind, 'user-addon');
});
test('unknown DLL and structurally valid ZIP remain visibly blocked custom candidates', async t => {
  const f=setup(t),unknownDll=path.join(f.root,'nvngx_dlssnr.dll');
  const bytes=Buffer.from(f.bytes);bytes[111]=9;fs.writeFileSync(unknownDll,bytes);
  const dll=await f.lib.importComponent(unknownDll);assert.equal(dll.packages[0].kind,'custom-candidate');
  assert.equal(dll.packages[0].validation,'blocked');assert.match(dll.packages[0].blockers[0],/不会自动用于/);
  const archive=zip(path.join(f.root,'unknown-full-package.zip'),[{name:'readme.txt',data:'not a component identity'}]);
  const packed=await f.lib.importComponent(archive);assert.equal(packed.packages[0].kind,'custom-candidate');
  assert.equal(packed.packages[0].media,'archive');
});
test('a selected component-library root keeps large objects out of userData', async t => {
  const userData = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'manager-small-state-'));
  const dataRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'manager-large-data-'));
  t.after(() => { fs.rmSync(userData,{recursive:true,force:true}); fs.rmSync(dataRoot,{recursive:true,force:true}); });
  const lib = createComponentLibrary({ userData, root: path.join(dataRoot, 'component-library'), catalog:{packages:[]} });
  assert.equal(lib.root, path.join(dataRoot, 'component-library'));
  assert.equal(fs.existsSync(path.join(userData, 'component-library')), false);
});
test('a verified Core package commits addon and chain together or not at all', async t => {
  const f = setup(t), addon = Buffer.from(f.bytes), chain = Buffer.from(f.bytes);
  addon[100] = 1; chain[100] = 2;
  const input = { id:'0.5-dline21', version:'0.5 D21', variant:'zh-CN', architecture:'x64', interface:'NGX-D3D12-Feature1',
    inputInterfaces:['NGX-D3D12-Feature1'], supportsPresent:true, validation:'candidate', stableRelease:false, coreUpdateOnly:true,
    files:[{name:'nr-before-sr.zh-CN.addon64',bytes:addon,sha256:hash(addon)},{name:'nrchain_nvngx.dll',bytes:chain,sha256:hash(chain)}] };
  await f.lib.importVerifiedCore(input);
  const inventory = await f.lib.inventory(), row = inventory.packages.find(item => item.id === input.id);
  assert.deepEqual(row.files.map(file => file.name).sort(), ['nr-before-sr.zh-CN.addon64','nrchain_nvngx.dll']);
  assert.equal(row.coreUpdateOnly, true);
  const before = fs.readFileSync(path.join(f.lib.root,'inventory.json'));
  await assert.rejects(f.lib.importVerifiedCore({ ...input, id:'0.5-dline21-bad', files:[input.files[0],{...input.files[1],sha256:'0'.repeat(64)}] }), /摘要/);
  assert.deepEqual(fs.readFileSync(path.join(f.lib.root,'inventory.json')), before);
});
test('runtime overlay supports a base missing NVIDIA DLL and does not duplicate by route', async t => {
  const f = setup(t), base = path.join(f.root, 'base');
  for (const family of ['RTX40','RTX50']) {
    const dir = path.join(base,'fixed',family); fs.mkdirSync(dir,{recursive:true});
    for (const name of ['ReShade64.dll','nrchain_nvngx.dll','nvngx_dlssnr.dll']) fs.writeFileSync(path.join(dir,name),f.bytes);
  }
  const v = path.join(base,'versions','core-a'); fs.mkdirSync(v,{recursive:true});
  fs.writeFileSync(path.join(v,PAYLOAD_FILES.addon),f.bytes); fs.writeFileSync(path.join(v,PAYLOAD_FILES.config),'[NR]\n');
  const bundle=createCompactBundle(base,[{id:'core-a'}],'core-a'); bundle.versions['core-a'].supportsPresent=true;
  fs.writeFileSync(path.join(base,'bundle.json'),JSON.stringify(bundle));
  for (const family of ['RTX40','RTX50']) fs.unlinkSync(path.join(base,'fixed',family,'nvngx_dlssnr.dll'));
  await f.lib.importComponent(f.dll); await f.lib.activateRuntime('runtime-a',base);
  const payload=requirePayload(f.lib.root,'RTX40','core-a');
  assert.equal(payload.runtime.valid,true); assert.equal(payload.versionInfo.supportsPresent,true);
  assert.match(payload.runtime.file,/objects/);
  assert.equal(fs.existsSync(path.join(f.lib.root,'fixed','RTX40','nvngx_dlssnr.dll')),false);
  fs.writeFileSync(payload.runtime.file,'tampered'); await assert.rejects(f.lib.activateRuntime('runtime-a',base),/缓存.*改/);
});
test('component manifests cannot escape the cache or masquerade as tested packages', async t => {
  const f=setup(t), dir=path.join(f.root,'custom');fs.mkdirSync(dir);
  const m={schema:'dlss5-component-v1',id:'external',kind:'bridge',version:'1.2.3',architecture:'x64',interface:'NGX-D3D12-Feature1',files:[{path:'../input.dll',sha256:hash(f.bytes),bytes:f.bytes.length}]};
  fs.writeFileSync(path.join(dir,'component-manifest.json'),JSON.stringify(m));
  await assert.rejects(f.lib.importComponent(dir),/无效路径/);
  m.files[0].path='bridge.addon64';fs.writeFileSync(path.join(dir,m.files[0].path),f.bytes);
  fs.writeFileSync(path.join(dir,'component-manifest.json'),JSON.stringify(m));
  await f.lib.importComponent(dir);assert.equal((await f.lib.inventory()).packages[0].validation,'candidate');
  for(const name of ['../x','C:/x','x:stream','NUL.dll','a/../b','a\\b'])assert.throws(()=>relativeName(name));
});
test('only an exact packaged catalog identity can promote a bundled component', async t => {
  const f=setup(t), dir=path.join(f.root,'official-bridge'); fs.mkdirSync(dir);
  const addon=path.join(dir,'dlss5-bridge.addon64'); fs.writeFileSync(addon,f.bytes);
  const manifest={schema:'dlss5-component-v1',id:'bridge-test-official',kind:'bridge',version:'1.2.3',variant:'official',architecture:'x64',
    interface:'NGX-D3D12-Feature1',inputInterfaces:['NGX-D3D12-Feature1'],compatibleCoreInterfaces:['NGX-D3D12-Feature1'],
    gameApis:['dx11','vulkan'],capabilities:['vulkan-requires-reshade-layer'],files:[{path:'dlss5-bridge.addon64',sha256:hash(f.bytes),bytes:f.bytes.length}]};
  const manifestFile=path.join(dir,'component-manifest.json'); fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  const identity={...manifest,validation:'candidate',defaultEligible:true,sourceType:'official-release',immutable:true,
    repository:'NIGos/dlss5-bridge',downloadUrl:'https://github.com/NIGos/dlss5-bridge/releases/download/v1.2.3/dlss5-bridge.addon64',
    files:[
      {path:`components/${manifest.id}/dlss5-bridge.addon64`,sha256:hash(f.bytes),bytes:f.bytes.length},
      {path:`components/${manifest.id}/component-manifest.json`,sha256:hash(fs.readFileSync(manifestFile)),bytes:fs.statSync(manifestFile).size}
    ]};
  await f.lib.importComponent(dir);
  assert.equal((await f.lib.inventory()).packages[0].verifiedSource,false);
  await assert.rejects(f.lib.adoptBundledComponent(dir,{...identity,gameApis:['dx11']}),/gameApis/);
  const adopted=await f.lib.adoptBundledComponent(dir,identity), row=adopted.packages[0];
  assert.equal(row.source,'bundled'); assert.equal(row.sourceType,'official-release');
  assert.equal(row.verifiedSource,true); assert.equal(row.immutable,true); assert.equal(row.defaultEligible,true);
  assert.deepEqual(row.gameApis,['dx11','vulkan']);
  assert.equal((await f.lib.inventory()).packages.length,1);
});
test('one API result handles assessment evidence, manual override and auto reset', () => {
  const game={chosen:{apiAssessment:{effectiveApi:'dx12',source:'imports'}}};
  assert.equal(resolveOperationApi(game).effectiveApi,'dx12');
  assert.equal(resolveOperationApi(game).requiresManualSelection,false);
  game.apiOverride='dx11';assert.equal(resolveOperationApi(game).effectiveApi,'dx11');
  assert.equal(resolveOperationApi(game,{api:'auto'}).effectiveApi,'unknown');
  game.chosen.detectedApi='dx12';assert.equal(resolveOperationApi(game,{api:'auto'}).effectiveApi,'dx12');
  game.chosen.detectedApi='mixed';assert.equal(resolveOperationApi(game,{api:'auto'}).requiresManualSelection,true);
});
test('only a declared Present-capable Core admits non-DLSS x64 DX12', () => {
  const scan={chosen:{api:'dx12',bitness:64}};
  assert.equal(assess(scan).code,'ERR_NO_DLSS');assert.equal(assess(scan,{supportsPresent:true}).supported,true);
  scan.chosen.bitness=32;assert.equal(assess(scan,{supportsPresent:true}).supported,false);
  scan.chosen.bitness=64;scan.chosen.api='dx11';assert.equal(assess(scan,{supportsPresent:true,allowDx11:true}).code,'ERR_NO_DLSS');
});
