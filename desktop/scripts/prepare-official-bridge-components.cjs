'use strict';

// Converts immutable upstream NIGos release assets into the Manager's small
// component-package format. It never downloads or guesses assets: the caller
// supplies official files and this script checks the registered identities.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pe = require('../src/core/pe');

const RELEASES = Object.freeze([
  Object.freeze({ id:'bridge-1.4.13-pre8-official', version:'1.4.13-pre8', tag:'v1.4.13-pre8', validation:'candidate', maturity:'experimental',
    bytes:546304, sha256:'c4c8b5bc4b26b2b3f3bf2767cdb708546d62f7d0bbb63d24e940c736da9efe26',
    commit:'ecd1b00674020a1e8c76a9cb653a1a21d11676a0', extras:['BUILD-INFO.txt','SHA256SUMS.txt','THIRD-PARTY-NOTICES.txt'] }),
  Object.freeze({ id:'bridge-1.4.12-official', version:'1.4.12', tag:'v1.4.12', validation:'stable', maturity:'fallback',
    bytes:508928, sha256:'4f2acecc1026ae89ac0b92767be66ceea2662ad0ef88710b89c7da7840d548d4',
    commit:'28aed4099b0fe1c207b20b5fee5364c0773c25c2', extras:[] })
]);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fail(message) { throw new Error(message); }
function parse(argv) {
  const result = {};
  for (let index=2; index<argv.length; index+=2) {
    const key=argv[index], value=argv[index+1];
    if (!/^--(?:pre8-root|stable-addon|license|output)$/.test(key || '') || !value) fail('参数不完整。');
    result[key.slice(2)] = path.resolve(value);
  }
  for (const key of ['pre8-root','stable-addon','license','output']) if (!result[key]) fail(`缺少 --${key}。`);
  return result;
}
function checked(file, expected = {}) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail(`不是普通文件：${file}`);
  const sha256 = hash(file);
  if (expected.bytes !== undefined && stat.size !== expected.bytes || expected.sha256 && sha256 !== expected.sha256)
    fail(`官方发布资产身份不符：${path.basename(file)}`);
  return { bytes:stat.size, sha256 };
}
function copy(source, target, expected) {
  const identity=checked(source, expected); fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL); return identity;
}
function component(release, input, license, output) {
  const root=path.join(output,release.id); fs.mkdirSync(root,{recursive:false});
  const files=[];
  const addonSource=release.tag === 'v1.4.13-pre8' ? path.join(input,'dlss5-bridge.addon64') : input;
  const addon=copy(addonSource,path.join(root,'dlss5-bridge.addon64'),release);
  if (pe.getBitness(path.join(root,'dlss5-bridge.addon64')) !== 64) fail(`${release.tag} 不是 x64 Add-on。`);
  files.push({path:'dlss5-bridge.addon64',...addon});
  for (const name of release.extras) files.push({path:name,...copy(path.join(input,name),path.join(root,name))});
  files.push({path:'LICENSE',...copy(license,path.join(root,'LICENSE'))});
  const downloadUrl=`https://github.com/NIGos/dlss5-bridge/releases/download/${release.tag}/dlss5-bridge.addon64`;
  const manifest={schema:'dlss5-component-v1',id:release.id,kind:'bridge',version:release.version,
    variant:release.validation === 'stable' ? 'official-stable' : 'official-prerelease',architecture:'x64',
    interface:'NGX-D3D12-Feature1',inputInterfaces:['NGX-D3D12-Feature1'],compatibleCoreInterfaces:['NGX-D3D12-Feature1'],
    gameApis:['dx11','vulkan'],capabilities:['dx11-local-reshade','vulkan-addon-capable','vulkan-requires-reshade-layer','release-asset-identity-verified'],
    validation:release.validation,defaultEligible:true,sourceType:'official-release',immutable:true,
    repository:'NIGos/dlss5-bridge',downloadUrl,...(release.commit ? {commit:release.commit} : {}),files};
  const manifestFile=path.join(root,'component-manifest.json');
  fs.writeFileSync(manifestFile,`${JSON.stringify(manifest,null,2)}\n`,{encoding:'utf8',flag:'wx'});
  const stagedFiles=[...files,{path:'component-manifest.json',...checked(manifestFile)}]
    .sort((left,right)=>left.path.localeCompare(right.path));
  return {...manifest,sourceRoot:root,includeIn:['base','offline'],files:stagedFiles.map(row=>({...row,source:row.path}))};
}
function prepare(options) {
  if (fs.existsSync(options.output)) fail('输出目录已存在；请选择新的空目录。');
  checked(options.license); fs.mkdirSync(options.output,{recursive:true});
  const components=RELEASES.map(release=>component(release,
    release.tag === 'v1.4.13-pre8' ? options['pre8-root'] : options['stable-addon'],options.license,options.output));
  const fragment=path.join(options.output,'staging-components.json');
  fs.writeFileSync(fragment,`${JSON.stringify({schemaVersion:1,components},null,2)}\n`,{encoding:'utf8',flag:'wx'});
  return {output:options.output,fragment,components:components.map(row=>({id:row.id,version:row.version,sha256:row.files.find(file=>file.path==='dlss5-bridge.addon64').sha256}))};
}
if (require.main === module) {
  try { console.log(JSON.stringify(prepare(parse(process.argv)),null,2)); }
  catch (error) { console.error(error.stack || error.message); process.exitCode=1; }
}
module.exports={RELEASES,prepare};
