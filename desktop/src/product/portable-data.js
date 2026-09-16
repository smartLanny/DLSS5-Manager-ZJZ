'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MARKER = 'DLSS5-Manager.portable.json';

function readMarker(directory) {
  const file = path.join(directory, MARKER);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value?.schemaVersion === 1 && value.mode === 'directory-portable' ? { file, value } : null;
  } catch { return null; }
}

function writable(directory) {
  try {
    fs.mkdirSync(directory, { recursive:true });
    const probe = path.join(directory, `.write-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok', { flag:'wx' }); fs.unlinkSync(probe); return true;
  } catch { return false; }
}

function resolvePortableData({ executable = process.execPath, packaged = false } = {}) {
  if (!packaged || typeof executable !== 'string' || !path.isAbsolute(executable)) return null;
  const applicationDir = path.dirname(path.resolve(executable)), marker = readMarker(applicationDir);
  if (!marker) return null;
  const root = path.join(applicationDir, 'data');
  if (!writable(root)) throw Object.assign(new Error('便携包所在目录不可写，请把完整目录解压到有写入权限的位置后再启动。'), { code:'PORTABLE_DATA_UNWRITABLE' });
  return Object.freeze({ applicationDir, root, userData:root, sessionData:path.join(root,'chromium'), cache:path.join(root,'cache'),
    logs:path.join(root,'logs'), components:path.join(root,'component-library'), updates:path.join(root,'updates'), marker:marker.file });
}

function configurePortableData(app, options = {}) {
  const value = resolvePortableData({ executable:options.executable || process.execPath,
    packaged:options.packaged === undefined ? app?.isPackaged === true : options.packaged });
  if (!value) return null;
  for (const directory of [value.userData, value.sessionData, value.cache, value.logs, value.components, value.updates]) fs.mkdirSync(directory, { recursive:true });
  app.setPath('userData', value.userData);
  app.setPath('sessionData', value.sessionData);
  app.setPath('cache', value.cache);
  app.commandLine?.appendSwitch?.('disk-cache-dir', value.cache);
  process.env.DLSS5_PORTABLE_DATA_DIR = value.root;
  return value;
}

module.exports = { MARKER, readMarker, resolvePortableData, configurePortableData };
