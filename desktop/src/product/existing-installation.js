'use strict';

const fs = require('fs');
const path = require('path');
const { INSTALLED_NAMES } = require('./constants');

const PRIMARY_KINDS = new Set(['addon', 'bridge', 'runtime', 'carrier', 'reshade', 'config', 'unverified-addon']);
const LABELS = Object.freeze({
  reshade: 'ReShade 入口',
  addon: 'NR Core',
  bridge: 'DLSS5 Bridge',
  runtime: 'NR 运行库',
  config: '个人配置',
  carrier: 'DX11 兼容组件'
});

// This is deliberately a cheap, exact-name footprint check. It does not hash,
// execute or assign a version to files that are not covered by our receipt.
// The operation preview performs the authoritative classification and backup.
function inspectExistingInstallation({ executable, managed = false } = {}) {
  if (managed || typeof executable !== 'string' || !path.isAbsolute(executable)) return null;
  const directory = path.dirname(executable), files = [];
  let names = [];
  try { names = fs.readdirSync(directory).filter(name => /\.addon(?:32|64)$/i.test(name)); } catch {}
  const candidates = [...Object.entries(INSTALLED_NAMES), ['reshade', 'd3d12.dll'], ['reshade', 'd3d11.dll'],
    ['config', 'ReShade.ini'], ...names.filter(name => !Object.values(INSTALLED_NAMES).includes(name)).map(name => ['unverified-addon', name])];
  for (const [kind, name] of candidates) {
    const file = path.join(directory, name);
    let stat;
    try { stat = fs.lstatSync(file); } catch { continue; }
    files.push({
      kind,
      label: LABELS[kind] || kind,
      name,
      path: file,
      bytes: stat.isFile() ? stat.size : null,
      entryType: stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : 'other'
    });
  }
  if (!files.some(row => PRIMARY_KINDS.has(row.kind))) return null;
  const present = new Set(files.filter(row => row.entryType === 'file').map(row => row.kind));
  return {
    detected: true,
    managed: false,
    source: 'selected-executable-directory',
    directory,
    corePresent: present.has('addon'),
    complete: ['addon', 'bridge', 'runtime', 'config'].every(kind => present.has(kind)),
    version: null,
    versionStatus: 'unverified',
    files
  };
}

module.exports = { inspectExistingInstallation };
