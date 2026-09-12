'use strict';

const fs = require('fs');
const path = require('path');
const { createBundle, createVariantsBundle, createVersionedBundle, createCompactBundle, inspectPayload, sha256 } = require('../src/product/payload');
const { FAMILIES } = require('../src/product/gpu');
const { DX11_COMPAT_VERSION, DX11_COMPAT_LABEL, DX11_COMPAT_CARRIER, DX11_COMPAT_NOTES } = require('../src/product/constants');
const DEFAULT_DIR = path.join(__dirname, '..', 'payload', 'nr-before-sr');

function inspectionRows(result) {
  return result.versions
    ? Object.entries(result.versions).flatMap(([version, item]) => FAMILIES.flatMap(family => item.variants[family].files.map(row => ({ ...row, name: `${version}/${family}/${row.name}` }))))
    : result.variants
      ? FAMILIES.flatMap(family => result.variants[family].files.map(row => ({ ...row, name: `${family}/${row.name}` })))
      : result.files;
}

function verifiedExistingBundle(dir) {
  try { fs.lstatSync(path.join(dir, 'bundle.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const inspection = inspectPayload(dir), rows = inspectionRows(inspection);
  const invalid = rows.filter(row => !row.valid || !row.expected);
  if (!inspection.ready || invalid.length) throw new Error(`Existing payload failed verification; refusing to replace its manifest: ${invalid.map(row => row.name).join(', ')}`);
  const bundle = inspection.bundle, records = [];
  const record = (base, files) => records.push({ base, files });
  if (bundle.version === 1) record(dir, bundle.files);
  if (bundle.version === 2) for (const family of FAMILIES) record(path.join(dir, family), bundle.variants[family].files);
  if (bundle.version === 3 || bundle.version === 4) for (const [id, entry] of Object.entries(bundle.versions)) {
    const base = path.join(dir, 'versions', id);
    if (bundle.version === 3) for (const family of FAMILIES) record(path.join(base, family), entry.variants[family].files);
    else {
      if (entry.compatibility === 'dx11' && ['nr-before-sr.zh-CN.addon64', 'nr_before_sr.ini', 'nrchain_nvngx.dll', DX11_COMPAT_CARRIER].some(name => !Object.hasOwn(entry.files, name))) {
        throw new Error(`Existing DX11 version ${id} lacks its recorded addon, INI, bridge or carrier; refusing to restamp it`);
      }
      record(base, entry.files);
    }
  }
  if (bundle.version === 4) for (const family of FAMILIES) record(path.join(dir, 'fixed', family), bundle.fixed[family].files);
  // inspectPayload checks installation roles. Also check every additional
  // declared companion, including a fixed bridge hidden by per-version bridges.
  const key = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  const hashes = new Map(rows.filter(row => row.actual).map(row => [key(row.file), row.actual]));
  for (const { base, files } of records) for (const [name, expected] of Object.entries(files)) {
    const file = path.join(base, name), relative = path.relative(dir, file);
    if (/[\\/:]/.test(name) || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Unsafe recorded payload file: ${name}`);
    let current = dir;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Recorded payload file uses a link: ${relative}`);
    }
    if (!fs.statSync(file).isFile()) throw new Error(`Recorded payload file is missing or invalid: ${relative}`);
    if (!hashes.has(key(file))) hashes.set(key(file), sha256(file));
    if (hashes.get(key(file)) !== expected.toLowerCase()) throw new Error(`Recorded payload hash mismatch; refusing to restamp: ${relative}`);
  }
  return structuredClone(bundle);
}

function rebuildBundle(directory) {
  const dir = path.resolve(directory);
  // A directory name is not provenance. Carry historical/custom entries only
  // from a valid old manifest, preserving their metadata and hashes verbatim.
  let bundle = verifiedExistingBundle(dir);
  if (!bundle) {
    const versionIds = ['0.2.0-beta.2', '0.3.3.5', DX11_COMPAT_VERSION];
    const compatDir = path.join(dir, 'versions', DX11_COMPAT_VERSION);
    const compatFiles = ['nr-before-sr.zh-CN.addon64', 'nr_before_sr.ini', 'nrchain_nvngx.dll', DX11_COMPAT_CARRIER];
    if (fs.existsSync(compatDir) && !compatFiles.every(name => fs.existsSync(path.join(compatDir, name)))) {
      throw new Error('0.4.5 DX11 compatibility payload requires matched addon, nrchain, carrier and INI');
    }
    const hasCompactVersions = versionIds.every(id => fs.existsSync(path.join(dir, 'versions', id, 'nr-before-sr.zh-CN.addon64')) && fs.existsSync(path.join(dir, 'versions', id, 'nr_before_sr.ini')))
      && FAMILIES.every(family => ['ReShade64.dll', 'nrchain_nvngx.dll', 'nvngx_dlssnr.dll'].every(name => fs.existsSync(path.join(dir, 'fixed', family, name))));
    const hasVersions = versionIds.every(id => FAMILIES.every(family => fs.existsSync(path.join(dir, 'versions', id, family))));
    bundle = hasCompactVersions
      ? createCompactBundle(dir, [
          { id: '0.2.0-beta.2', label: '0.2.0-beta.2（2K27 兼容候选）', notes: '历史 beta0.2 addon；针对 2K27 等反馈优先用于兼容性对比。当前固定运行组件仍按显卡族共用。', source: 'local historical tag v0.2.0-beta.2' },
          { id: '0.3.3.5', label: '0.3.3.5（默认稳定版）', notes: '默认稳定槽；本地现有 beta0.3.3.5 addon，用于日常安装和兼容性基线。', source: 'beta0.3.3.5-080d' },
          { id: DX11_COMPAT_VERSION, label: DX11_COMPAT_LABEL, notes: DX11_COMPAT_NOTES, source: 'beta0.4.5-dx11-compat@dccb5b398ccc540723f84a6ef789dd70dbda5cd3', compatibility: 'dx11', ota: true }
        ], '0.3.3.5')
      : hasVersions
      ? createVersionedBundle(dir, [
          { id: '0.2.0-beta.2', label: '0.2.0-beta.2（2K27 兼容候选）', notes: '历史 beta0.2 addon；针对 2K27 等反馈优先用于兼容性对比。当前固定运行组件仍按显卡族共用。', source: 'local historical tag v0.2.0-beta.2' },
          { id: '0.3.3.5', label: '0.3.3.5（默认稳定版）', notes: '默认稳定槽；本地现有 beta0.3.3.5 addon，用于日常安装和兼容性基线。', source: 'beta0.3.3.5-080d' },
          { id: DX11_COMPAT_VERSION, label: DX11_COMPAT_LABEL, notes: DX11_COMPAT_NOTES, source: 'beta0.4.5-dx11-compat@dccb5b398ccc540723f84a6ef789dd70dbda5cd3', compatibility: 'dx11', ota: true }
        ], '0.3.3.5')
      : FAMILIES.every(family => fs.existsSync(path.join(dir, family)))
        ? createVariantsBundle(dir)
        : createBundle(dir);
  }
  for (const [id, moduleName] of [['0.4.6', './prepare-release-046'], ['0.4.6-hotfix.1', './prepare-release-046-hotfix1']]) {
    if (!fs.existsSync(path.join(dir, 'versions', id)) || Object.hasOwn(bundle.versions || {}, id) || Object.hasOwn(bundle.supersededVersions || {}, id)) continue;
    if (bundle.version !== 4) throw new Error(`${id} requires the compact paired payload`);
    const { ENTRY, verifyVersion } = require(moduleName);
    verifyVersion(path.join(dir, 'versions', id));
    const added = createCompactBundle(dir, [ENTRY], ENTRY.id);
    bundle.versions[ENTRY.id] = added.versions[ENTRY.id]; bundle.defaultVersion = ENTRY.id;
  }
  return bundle;
}

function main(args = process.argv.slice(2), log = console.log) {
  let dir = DEFAULT_DIR, write = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--write') write = true;
    else if (args[index] === '--dir' && args[index + 1] && !args[index + 1].startsWith('--')) dir = path.resolve(args[++index]);
    else throw new Error('Usage: verify-payload.js [--write] [--dir <payload-directory>]');
  }
  if (write) {
    const bundle = rebuildBundle(dir);
    fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify(bundle, null, 2) + '\n', 'utf8');
    log(`Wrote ${path.join(dir, 'bundle.json')}`);
  }
  const result = inspectPayload(dir);
  const rows = inspectionRows(result);
  for (const row of rows) log(`${row.valid ? 'OK  ' : 'FAIL'} ${row.name}`);
  if (!result.ready || rows.some(row => !row.valid || !row.expected)) throw new Error('Payload verification failed');
  return result;
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { rebuildBundle, main };
