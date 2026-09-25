'use strict';
// A read-only proposal. Only the existing installation WAL may publish it.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspectExistingInstallation } = require('./existing-installation');
const { noLinks, digestFile } = require('./launch-safety');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const fail = message => { throw Object.assign(new Error(message), { code: 'ADOPTION_CHANGED' }); };
const HOSTS = ['dxgi.dll', 'd3d12.dll', 'd3d11.dll'];

function validateAdoptionChoice(value) {
  if (value === undefined) return;
  const row = value?.replaceProxy;
  if (!value || Array.isArray(value) || Object.keys(value).some(key => key !== 'replaceProxy') || !row ||
      Object.keys(row).some(key => !['path', 'sha256', 'configFingerprint'].includes(key)) ||
      !path.isAbsolute(row.path || '') || row.path.includes('\0') ||
      !/^[a-f0-9]{64}$/.test(row.sha256 || '') || !/^[a-f0-9]{64}$/.test(row.configFingerprint || ''))
    throw Object.assign(new Error('替换加载入口必须绑定具体文件及当前配置摘要。'), { code: 'ADOPTION_INPUT' });
}

async function inspectAdoption({ executable, managed = false, choice, pe = require('../core/pe'), inspectReShade } = {}) {
  validateAdoptionChoice(choice);
  if (managed) { if (choice) fail('已有受管安装不能使用旧安装接管授权。'); return null; }
  const footprint = inspectExistingInstallation({ executable, managed });
  if (!footprint) { if (choice) fail('指定的旧加载入口已不存在，请重新检查。'); return null; }
  const files = [];
  for (const row of footprint.files) {
    await noLinks(row.path);
    if (row.entryType !== 'file') fail('接管目标不是普通文件，请先核对：' + row.name);
    files.push({ ...row, sha256: await digestFile(row.path) });
  }
  files.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
  const directory = path.dirname(executable), configPath = path.join(directory, 'ReShade.ini');
  await noLinks(configPath);
  const configFingerprint = hash({ path: configPath.toLowerCase(), sha256: await digestFile(configPath) });
  const reported = inspectReShade?.(directory), hosts = [];
  for (const name of HOSTS) {
    const row = files.find(row => row.name.toLowerCase() === name); if (!row) continue;
    const recognized = pe.versionMentions?.(row.path, 'ReShade') === true ||
      reported?.installed && path.basename(reported.file || '').toLowerCase() === name;
    const data = await fs.readFile(row.path);
    const addon = data.includes(Buffer.from('Searching for add-ons')) || data.includes(Buffer.from('Searching for add-ons', 'utf16le'));
    const kind = recognized ? addon ? 'addon-compatible' : 'reshade-standard' : 'unknown-proxy';
    hosts.push({ path: row.path, name, sha256: row.sha256, kind, bitness: pe.getBitness?.(row.path) ?? null });
  }
  const blockers = [];
  if (hosts.length > 1) blockers.push({ code: 'ADOPTION_MULTIPLE_PROXIES', message: '存在多个加载入口，请先保留一个实际入口后重新检查；本次未自动移除其他代理。' });
  if (reported?.installed && !hosts.some(row => path.basename(reported.file || '').toLowerCase() === row.name))
    blockers.push({ code: 'ADOPTION_OTHER_HOST', message: '现有 ReShade 使用其他加载方式，请先核对该入口；未同时安装第二个主机。' });
  let replaceProxy = null;
  if (choice) {
    const selected = hosts.find(row => same(row.path, choice.replaceProxy.path));
    if (!selected || selected.sha256 !== choice.replaceProxy.sha256 || configFingerprint !== choice.replaceProxy.configFingerprint)
      fail('加载入口或配置已在预览后改变，请重新检查并选择。');
    replaceProxy = { ...selected, configFingerprint, explicitlySelected: true };
  }
  for (const row of hosts) {
    if (row.bitness !== 64) blockers.push({ code: 'ADOPTION_HOST_ARCHITECTURE', message: `${row.name} 不是可确认的 x64 加载入口，未覆盖。` });
    if (row.kind === 'unknown-proxy' && !replaceProxy)
      blockers.push({ code: 'ADOPTION_PROXY_CHOICE_REQUIRED', message: `${row.name} 来源未确认；需要明确选择这个文件后，才能预览备份替换。`, path: row.path });
    if (row.kind === 'reshade-standard' && !replaceProxy) replaceProxy = { ...row, configFingerprint, explicitlySelected: false };
  }
  const result = { required: true, status: 'confirmation-required', directory, files, hosts,
    hostState: hosts.length > 1 ? 'multiple' : hosts[0]?.kind || 'missing', configFingerprint,
    replaceProxy, blockers, preservesNrConfig: true, restoresOriginalFiles: true };
  result.fingerprint = hash(result);
  return result;
}

async function assertAdoption(plan) {
  if (!plan) return;
  for (const row of plan.files) { await noLinks(row.path); if (await digestFile(row.path) !== row.sha256) fail('旧安装文件已经改变，请重新预览。'); }
  const footprint = inspectExistingInstallation({ executable: path.join(plan.directory, 'adoption-target.exe') });
  const current = (footprint?.files || []).map(row => row.path.toLowerCase()).sort();
  if (JSON.stringify(current) !== JSON.stringify(plan.files.map(row => row.path.toLowerCase()).sort())) fail('旧安装文件集合已经改变，请重新预览。');
  const config = path.join(plan.directory, 'ReShade.ini'); await noLinks(config);
  if (hash({ path: config.toLowerCase(), sha256: await digestFile(config) }) !== plan.configFingerprint) fail('ReShade 配置已经改变，请重新预览。');
  if (plan.blockers.length) fail(plan.blockers.map(row => row.message).join('；'));
}
module.exports = { inspectAdoption, assertAdoption, validateAdoptionChoice };
