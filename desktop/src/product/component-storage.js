'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { noLinks, inside, atomicJson } = require('./launch-safety');
const { hashRegularFile } = require('./streamed-file-digest');

const MARKER = 'component-library-move.json';
const OWNER_MARKER = '.component-library-move-owner.json';
const MAX_FILES = 32768;
const MAX_FILE = 1024 * 1024 * 1024;
const fail = message => { throw Object.assign(new Error(message), { code:'COMPONENT_STORAGE' }); };
const absolute = value => typeof value === 'string' && !value.includes('\0') && path.isAbsolute(value);
const same = (left,right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

function writableDirectory(directory) {
  try { return fs.statSync(directory).isDirectory() && (fs.accessSync(directory,fs.constants.W_OK),true); }
  catch { return false; }
}

function resolveComponentStorage({ userData, configuredRoot = null, portableExecutable = null, applicationDir = null }) {
  if (!absolute(userData)) fail('组件仓库缺少有效的用户数据目录。');
  const legacyRoot = path.join(path.resolve(userData),'component-library');
  if (absolute(configuredRoot)) return { root:path.resolve(configuredRoot), mode:'custom', legacyRoot };
  if (fs.existsSync(legacyRoot)) return { root:legacyRoot, mode:'legacy', legacyRoot };
  if (absolute(portableExecutable)) {
    const directory = path.dirname(path.resolve(portableExecutable));
    if (writableDirectory(directory)) return { root:path.join(directory,'DLSS5-Manager-Data','component-library'), mode:'portable', legacyRoot };
  }
  if (absolute(applicationDir) && writableDirectory(path.resolve(applicationDir)))
    return { root:path.join(path.resolve(applicationDir),'DLSS5-Manager-Data','component-library'), mode:'application', legacyRoot };
  return { root:legacyRoot, mode:'user-data-fallback', legacyRoot };
}

function safeRelative(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') || name.startsWith('/') ||
      name.split('/').some(part => !part || part === '.' || part === '..')) fail('组件仓库包含无效路径。');
  return name;
}

async function snapshot(root) {
  await noLinks(root);
  const rows=[];
  async function walk(directory) {
    for (const entry of await fsp.readdir(directory,{withFileTypes:true})) {
      if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) fail('组件仓库不能包含链接或特殊文件。');
      const file=path.join(directory,entry.name), rel=safeRelative(path.relative(root,file).replace(/\\/g,'/'));
      if (entry.isDirectory()) await walk(file);
      else {
        if (++rows.length > MAX_FILES) fail('组件仓库文件过多，未开始移动。');
        const stat=await fsp.stat(file); if (stat.size > MAX_FILE) fail('组件仓库含超出校验上限的文件。');
        rows[rows.length-1]={file:rel,bytes:stat.size,sha256:await hashRegularFile(file,{assertPath:noLinks,maxBytes:MAX_FILE})};
      }
    }
  }
  await walk(root);
  return rows.sort((a,b)=>a.file.localeCompare(b.file));
}

async function moveComponentStorage({ userData, source, destinationBase }) {
  if (!absolute(userData) || !absolute(source) || !absolute(destinationBase)) fail('请选择有效的组件仓库目标目录。');
  source=path.resolve(source); destinationBase=path.resolve(destinationBase);
  await noLinks(source); await noLinks(destinationBase);
  const baseStat=await fsp.stat(destinationBase); if (!baseStat.isDirectory()) fail('组件仓库目标不是目录。');
  const target=path.join(destinationBase,'DLSS5-Manager-Data','component-library');
  if (same(source,target) || inside(source,target) || inside(target,source)) fail('新旧组件仓库不能互相包含。');
  if (fs.existsSync(target)) fail('目标位置已有组件仓库，请选择空位置。');
  const moveId=crypto.randomUUID(), authorization={schemaVersion:1,moveId,source,target};
  await atomicJson(path.join(source,OWNER_MARKER),authorization);
  const before=await snapshot(source), parent=path.dirname(target);
  await fsp.mkdir(parent,{recursive:true}); await noLinks(parent);
  const stage=path.join(parent,`.component-library-move-${crypto.randomUUID()}`);
  try {
    await fsp.cp(source,stage,{recursive:true,errorOnExist:true,force:false});
    const copied=await snapshot(stage);
    if (JSON.stringify(copied)!==JSON.stringify(before)) fail('组件仓库复制校验失败，旧仓库保持不变。');
    await fsp.rename(stage,target);
    await atomicJson(path.join(path.resolve(userData),MARKER),{schemaVersion:1,moveId,source,target,files:before,createdAt:new Date().toISOString()});
    return {source,target,restartRequired:true};
  } finally { if (fs.existsSync(stage) && inside(parent,stage) && path.basename(stage).startsWith('.component-library-move-')) await fsp.rm(stage,{recursive:true,force:true}); }
}

async function readAuthorization(root) {
  const file=path.join(root,OWNER_MARKER);
  try {
    await noLinks(file); const stat=await fsp.stat(file);
    if (!stat.isFile() || stat.size>64*1024) fail('组件仓库清理授权无效，旧仓库未删除。');
    return JSON.parse(await fsp.readFile(file,'utf8'));
  } catch (error) {
    if (error?.code==='COMPONENT_STORAGE') throw error;
    fail('组件仓库清理授权缺失，旧仓库未删除。');
  }
}

async function finalizeComponentStorageMove({ userData, configuredRoot, allowedSources = [] }) {
  if (!absolute(userData)) fail('组件仓库迁移状态目录无效。');
  const marker=path.join(path.resolve(userData),MARKER);
  if (!fs.existsSync(marker)) return {removedSource:false};
  await noLinks(marker); const stat=await fsp.stat(marker);
  if (!stat.isFile() || stat.size > 4*1024*1024) fail('组件仓库迁移记录无效。');
  const data=JSON.parse(await fsp.readFile(marker,'utf8'));
  if (data.schemaVersion!==1 || !/^[a-f0-9-]{36}$/i.test(data.moveId || '') || !absolute(data.source) || !absolute(data.target) || !Array.isArray(data.files) || data.files.length>MAX_FILES ||
      !absolute(configuredRoot) || !same(data.target,configuredRoot) || !allowedSources.some(source=>absolute(source)&&same(source,data.source)))
    fail('组件仓库迁移记录与当前位置不一致，旧仓库未删除。');
  const authorized = value => value?.schemaVersion===1 && value.moveId===data.moveId && absolute(value.source) && absolute(value.target) &&
    same(value.source,data.source) && same(value.target,data.target);
  if (!authorized(await readAuthorization(path.resolve(data.target)))) fail('新组件仓库清理授权不一致，旧仓库未删除。');
  const current=await snapshot(path.resolve(data.target));
  if (JSON.stringify(current)!==JSON.stringify(data.files)) fail('新组件仓库摘要不一致，旧仓库未删除。');
  const source=path.resolve(data.source);
  if (same(source,path.parse(source).root) || inside(source,path.resolve(data.target)) || inside(path.resolve(data.target),source)) fail('组件仓库清理范围无效。');
  if (!fs.existsSync(source)) { await fsp.unlink(marker); return {removedSource:true,source,target:path.resolve(data.target),alreadyRemoved:true}; }
  if (!authorized(await readAuthorization(source))) fail('旧组件仓库清理授权不一致，旧仓库未删除。');
  const oldCurrent=await snapshot(source);
  if (JSON.stringify(oldCurrent)!==JSON.stringify(data.files)) fail('旧组件仓库在复制后发生变化，已保留旧仓库；请核对后来导入的组件。');
  await fsp.rm(source,{recursive:true,force:false}); await fsp.unlink(marker);
  return {removedSource:true,source,target:path.resolve(data.target)};
}

module.exports={resolveComponentStorage,moveComponentStorage,finalizeComponentStorageMove,MARKER,OWNER_MARKER};
