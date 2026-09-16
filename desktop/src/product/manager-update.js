'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn:spawnDefault } = require('node:child_process');

const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^[0-9]+[.][0-9]+[.][0-9]+(?:-[a-z0-9.-]+)?$/i;
const MAX_ARCHIVE = 1024 * 1024 * 1024;
const REPOSITORY_RELEASE = 'https://github.com/smartLanny/DLSS5-Manager-ZJZ/releases/download/';

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function inside(root, target) { const rel = path.relative(path.resolve(root), path.resolve(target)); return rel === '' || rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); }
function safeVersion(value) { if (!VERSION.test(value || '')) fail('UPDATE_MANIFEST', '更新版本号无效。'); return value; }
function versionParts(value) { return String(value).split(/[.-]/).map(part => /^\d+$/.test(part) ? Number(part) : part.toLowerCase()); }
function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right), count = Math.max(a.length,b.length);
  for (let i=0;i<count;i++) {
    const x=a[i], y=b[i]; if (x === y) continue;
    if (x === undefined) return typeof y === 'number' ? -1 : 1;
    if (y === undefined) return typeof x === 'number' ? 1 : -1;
    if (typeof x === typeof y) return x < y ? -1 : 1;
    return typeof x === 'number' ? 1 : -1;
  }
  return 0;
}
function validateManifest(value) {
  if (!value || value.schema !== 'dlss5-manager-update-v1') fail('UPDATE_MANIFEST', '更新清单格式无效。');
  const version = safeVersion(value.version);
  const artifact = value.artifact;
  if (!artifact || artifact.format !== 'directory-portable-zip' || typeof artifact.url !== 'string' ||
      !artifact.url.startsWith(REPOSITORY_RELEASE) || !artifact.url.toLowerCase().endsWith('.zip') ||
      !HASH.test(artifact.sha256 || '') || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || artifact.bytes > MAX_ARCHIVE) {
    fail('UPDATE_MANIFEST', '更新包来源、大小或摘要无效。');
  }
  return { schema:value.schema, version, channel:value.channel === 'stable' ? 'stable' : 'preview',
    notes:typeof value.notes === 'string' ? value.notes.slice(0,4000) : '',
    releaseUrl:typeof value.releaseUrl === 'string' && value.releaseUrl.startsWith('https://github.com/smartLanny/DLSS5-Manager-ZJZ/releases/') ? value.releaseUrl : null,
    artifact:{ format:artifact.format, url:artifact.url, sha256:artifact.sha256, bytes:artifact.bytes,
      filename:path.basename(new URL(artifact.url).pathname) } };
}
async function sha256(file) { const hash=crypto.createHash('sha256'); await pipeline(fs.createReadStream(file),new Transform({ transform(chunk,_encoding,next){hash.update(chunk);next();} })); return hash.digest('hex'); }
async function atomicJson(file, value) {
  await fsp.mkdir(path.dirname(file),{recursive:true});
  const temp=`${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  try {
    // Windows cannot rename over an existing file. The pending record is
    // replaceable state; the verified staged tree remains the source of truth.
    await fsp.rm(file,{force:true});
    await fsp.rename(temp,file);
  } finally { await fsp.rm(temp,{force:true}); }
}

async function extractZip(archive, destination) {
  let yauzl; try { yauzl=require('yauzl'); } catch { fail('UPDATE_EXTRACTOR', '管理器缺少 ZIP 校验模块。'); }
  await fsp.mkdir(destination,{recursive:true});
  return new Promise((resolve,reject) => yauzl.open(archive,{lazyEntries:true,decodeStrings:true,validateEntrySizes:true,strictFileNames:true},(openError,zip)=>{
    if(openError)return reject(openError); let entries=0,total=0,settled=false;
    const done=error=>{if(settled)return;settled=true;try{zip.close();}catch{} error?reject(error):resolve();};
    zip.on('error',done); zip.on('end',()=>done()); zip.readEntry();
    zip.on('entry',entry=>{
      try {
        if(++entries>6000)fail('UPDATE_ARCHIVE','更新包文件过多。');
        const name=String(entry.fileName||'').replaceAll('\\','/');
        if(!name || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some(part=>part===''&&name.at(-1)!=='/' || part==='.' || part==='..')) fail('UPDATE_ARCHIVE','更新包包含不安全路径。');
        const unixMode=(entry.externalFileAttributes>>>16)&0xffff;
        if((unixMode&0xf000)===0xa000)fail('UPDATE_ARCHIVE','更新包不得包含符号链接。');
        total+=entry.uncompressedSize;if(total>MAX_ARCHIVE*2)fail('UPDATE_ARCHIVE','更新包展开大小超过限制。');
        const target=path.resolve(destination,...name.split('/').filter(Boolean));if(!inside(destination,target))fail('UPDATE_ARCHIVE','更新包路径越界。');
        if(name.endsWith('/')){fsp.mkdir(target,{recursive:true}).then(()=>zip.readEntry(),done);return;}
        zip.openReadStream(entry,(streamError,stream)=>{
          if(streamError)return done(streamError);
          fsp.mkdir(path.dirname(target),{recursive:true}).then(()=>pipeline(stream,fs.createWriteStream(target,{flags:'wx'}))).then(()=>zip.readEntry(),done);
        });
      } catch(error){done(error);}
    });
  }));
}

const APPLY_SCRIPT = String.raw`param(
  [Parameter(Mandatory=$true)][int]$ParentPid,
  [Parameter(Mandatory=$true)][string]$ApplicationDirectory,
  [Parameter(Mandatory=$true)][string]$StagedDirectory,
  [Parameter(Mandatory=$true)][string]$RollbackDirectory,
  [Parameter(Mandatory=$true)][string]$PendingFile,
  [Parameter(Mandatory=$true)][string]$ExecutableName
)
$ErrorActionPreference = 'Stop'
try { Wait-Process -Id $ParentPid -Timeout 90 -ErrorAction SilentlyContinue } catch {}
if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) { exit 21 }
$marker = 'DLSS5-Manager.portable.json'
if (-not (Test-Path -LiteralPath (Join-Path $ApplicationDirectory $marker) -PathType Leaf)) { exit 22 }
if (-not (Test-Path -LiteralPath (Join-Path $StagedDirectory $marker) -PathType Leaf)) { exit 23 }
if (-not (Test-Path -LiteralPath (Join-Path $StagedDirectory $ExecutableName) -PathType Leaf)) { exit 24 }
$dataDirectory = Join-Path $ApplicationDirectory 'data'
$rollbackRoot = Split-Path -Parent $RollbackDirectory
New-Item -ItemType Directory -Path $rollbackRoot -Force | Out-Null
Get-ChildItem -LiteralPath $rollbackRoot -Force | Remove-Item -Recurse -Force
New-Item -ItemType Directory -Path $RollbackDirectory -Force | Out-Null
try {
  Get-ChildItem -LiteralPath $ApplicationDirectory -Force | Where-Object { $_.FullName -ne $dataDirectory } | ForEach-Object {
    Move-Item -LiteralPath $_.FullName -Destination $RollbackDirectory -Force
  }
  Get-ChildItem -LiteralPath $StagedDirectory -Force | ForEach-Object {
    Move-Item -LiteralPath $_.FullName -Destination $ApplicationDirectory -Force
  }
  Remove-Item -LiteralPath $StagedDirectory -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PendingFile -Force -ErrorAction SilentlyContinue
} catch {
  Get-ChildItem -LiteralPath $ApplicationDirectory -Force | Where-Object { $_.FullName -ne $dataDirectory } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath $RollbackDirectory -Force | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination $ApplicationDirectory -Force }
  exit 25
}
Start-Process -FilePath (Join-Path $ApplicationDirectory $ExecutableName) -WorkingDirectory $ApplicationDirectory
exit 0
`;

function createManagerUpdate(options = {}) {
  const currentVersion=safeVersion(options.currentVersion);
  const manifestUrl=options.manifestUrl;
  const root=path.resolve(options.root);
  const applicationDirectory=options.applicationDirectory ? path.resolve(options.applicationDirectory) : null;
  const executable=options.executable ? path.resolve(options.executable) : null;
  const portable=options.portable === true;
  const fetcher=options.fetch || globalThis.fetch;
  const extract=options.extract || extractZip;
  const spawn=options.spawn || spawnDefault;
  const progress=typeof options.progress==='function'?options.progress:()=>{};
  let active=null;
  if(typeof manifestUrl!=='string' || !manifestUrl.startsWith('https://github.com/smartLanny/DLSS5-Manager-ZJZ/releases/')) fail('UPDATE_CONFIGURATION','管理器更新地址无效。');

  async function check() {
    progress({stage:'checking',percent:0,message:'正在检查管理器更新…'});
    const response=await fetcher(manifestUrl,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(15000)});
    if(!response.ok)fail('UPDATE_NETWORK',`检查更新失败：HTTP ${response.status}`);
    const text=await response.text();if(text.length>128*1024)fail('UPDATE_MANIFEST','更新清单过大。');
    const manifest=validateManifest(JSON.parse(text));
    const available=compareVersions(manifest.version,currentVersion)>0;
    progress({stage:'checked',percent:100,message:available?`发现 ${manifest.version}`:'当前已是最新版本'});
    return { currentVersion, available, manifest, portable };
  }
  async function prepare(input) {
    if(active)fail('UPDATE_BUSY','管理器更新正在进行。');
    if(!portable || !applicationDirectory || !executable)fail('UPDATE_PORTABLE_ONLY','自动替换仅适用于目录式便携版；请从发布页下载新版。');
    const manifest=validateManifest(input);if(compareVersions(manifest.version,currentVersion)<=0)fail('UPDATE_NOT_NEWER','所选版本不高于当前版本。');
    await fsp.mkdir(root,{recursive:true});
    const controller=new AbortController();active=controller;
    const temp=await fsp.mkdtemp(path.join(root,'.download-')), archive=path.join(temp,manifest.artifact.filename);
    const stageTemp=path.join(temp,'staged');
    try {
      progress({stage:'downloading',percent:0,message:`正在下载 ${manifest.version}…`});
      const response=await fetcher(manifest.artifact.url,{signal:controller.signal});if(!response.ok||!response.body)fail('UPDATE_NETWORK',`下载更新失败：HTTP ${response.status}`);
      let bytes=0;const meter=new Transform({transform(chunk,_encoding,next){bytes+=chunk.length;if(bytes>manifest.artifact.bytes)return next(Object.assign(new Error('更新包超过清单大小。'),{code:'UPDATE_SIZE'}));progress({stage:'downloading',percent:Math.min(99,Math.floor(bytes/manifest.artifact.bytes*100)),message:`正在下载 ${manifest.version}…`});next(null,chunk);}});
      await pipeline(response.body,meter,fs.createWriteStream(archive,{flags:'wx'}),{signal:controller.signal});
      if(bytes!==manifest.artifact.bytes || await sha256(archive)!==manifest.artifact.sha256)fail('UPDATE_DIGEST','更新包摘要或大小不符。');
      progress({stage:'extracting',percent:0,message:'正在校验并展开更新…'});await extract(archive,stageTemp);
      const marker=path.join(stageTemp,'DLSS5-Manager.portable.json'), nextExe=path.join(stageTemp,path.basename(executable));
      if(!fs.existsSync(marker)||!fs.existsSync(nextExe))fail('UPDATE_CONTENT','更新包不是完整的目录式便携版。');
      const staged=path.join(root,`staged-${manifest.version}`);
      for (const entry of await fsp.readdir(root,{withFileTypes:true})) {
        if (entry.isDirectory() && entry.name.startsWith('staged-')) await fsp.rm(path.join(root,entry.name),{recursive:true,force:true});
      }
      await fsp.rename(stageTemp,staged);
      const pending={schema:'dlss5-manager-pending-v1',currentVersion,targetVersion:manifest.version,artifactSha256:manifest.artifact.sha256,
        staged,applicationDirectory,executable,preparedAt:new Date().toISOString()};
      await atomicJson(path.join(root,'pending.json'),pending);progress({stage:'ready',percent:100,message:'更新已校验，重启后替换。'});return pending;
    } catch(error) { if(error?.name==='AbortError')error=Object.assign(new Error('更新下载已取消。'),{code:'UPDATE_CANCELLED'});throw error; }
    finally { active=null;if(inside(root,temp))await fsp.rm(temp,{recursive:true,force:true}); }
  }
  function cancel(){if(!active)return false;active.abort();return true;}
  async function launchApply() {
    if(!portable)fail('UPDATE_PORTABLE_ONLY','当前不是目录式便携版。');
    const pendingFile=path.join(root,'pending.json');
    let pending;try{pending=JSON.parse(await fsp.readFile(pendingFile,'utf8'));}catch{fail('UPDATE_PENDING','没有已准备的管理器更新。');}
    if(pending.schema!=='dlss5-manager-pending-v1'||pending.currentVersion!==currentVersion||!inside(root,pending.staged)||
        path.resolve(pending.applicationDirectory)!==applicationDirectory||path.resolve(pending.executable)!==executable)fail('UPDATE_PENDING','待应用更新记录无效。');
    if(!fs.existsSync(path.join(pending.staged,'DLSS5-Manager.portable.json'))||!fs.existsSync(path.join(pending.staged,path.basename(executable))))fail('UPDATE_PENDING','已准备的更新文件不完整。');
    const script=path.join(root,'apply-manager-update.ps1');await fsp.writeFile(script,APPLY_SCRIPT,'utf8');
    const rollback=path.join(root,'rollback',currentVersion);await fsp.mkdir(path.dirname(rollback),{recursive:true});
    const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const child=spawn(powershell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,
      '-ParentPid',String(process.pid),'-ApplicationDirectory',applicationDirectory,'-StagedDirectory',pending.staged,
      '-RollbackDirectory',rollback,'-PendingFile',pendingFile,'-ExecutableName',path.basename(executable)],{detached:true,windowsHide:true,stdio:'ignore'});
    child.unref?.();return { launched:true,targetVersion:pending.targetVersion };
  }
  return { check,prepare,cancel,launchApply,root };
}

module.exports={createManagerUpdate,validateManifest,compareVersions,extractZip,REPOSITORY_RELEASE};
