'use strict';
// Presentation of verified inventory, not an installation authority. Installers
// still revalidate their complete contracts and bytes immediately before writes.
const fs = require('node:fs/promises');
const path = require('node:path');
const { hashRegularFile } = require('./streamed-file-digest');
const { noLinks } = require('./launch-safety');
const mfg = require('./fg-mfgunlock-providers.json');
const { PIN: sm86, ID: sm86Id } = require('./fg-sm86-components');
const KINDS = ['bridge', 'feeder', 'mfg', 'dlssg-sm86'];
const HASH = /^[a-f0-9]{64}$/;
function versionParts(value) {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-.]([a-z][a-z0-9.-]*))?$/i.exec(String(value || ''));
  return match && { numbers: match.slice(1, 4).map(x => Number(x || 0)), suffix: match[4]?.toLowerCase() || '' };
}
function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) if (left.numbers[i] !== right.numbers[i]) return Math.sign(left.numbers[i] - right.numbers[i]);
  if (left.suffix === right.suffix) return 0;
  if (!left.suffix || !right.suffix) return left.suffix ? -1 : 1;
  return Math.sign(left.suffix.localeCompare(right.suffix, 'en', { numeric: true }));
}
const modules = row => (row.files || []).filter(file => /\.(?:addon64|dll)$/i.test(file.name || file.path || file.file || ''));
const identity = row => [row.kind, ...(modules(row).length ? modules(row).map(x => x.sha256).sort() : [row.sha256 || row.id])].join('|');
const available = row => row.filesReady !== false && row.validation !== 'blocked';
function compatible(row, currentCore = {}) {
  if (row.requiresAdapter || row.validation === 'blocked') return false;
  if (row.kind === 'mfg' || row.kind === 'dlssg-sm86') return true;
  const names = (currentCore.inputInterfaces || []).map(x => typeof x === 'string' ? x : x?.name);
  const required = row.requiredCoreCapabilities || [];
  const accepted = row.compatibleCoreInterfaces?.length ? row.compatibleCoreInterfaces : [row.interface];
  return accepted.some(name => names.includes(name)) && required.every(name => currentCore.capabilities?.includes(name));
}
function buildOverview({ packages = [], catalog = {}, currentCore = {}, checkedAt = null } = {}) {
  const unique = new Map();
  for (const row of packages.filter(x => KINDS.includes(x.kind))) {
    const key = identity(row), previous = unique.get(key);
    if (!previous || !available(previous) && available(row) || row.source === 'bundled' && previous.source !== 'bundled' && available(row)) unique.set(key, row);
  }
  const rows = [...unique.values()];
  const hashes = new Set(rows.filter(available).flatMap(row => [row.sha256, ...modules(row).map(x => x.sha256)]).filter(Boolean));
  const groups = KINDS.map(kind => {
    const entries = rows.filter(x => x.kind === kind).sort((a, b) => Number(b.recommended === true) - Number(a.recommended === true) || (compareVersions(b.version, a.version) || 0));
    const valid = entries.filter(available), match = valid.filter(row => compatible(row, currentCore));
    return { kind, entries, versions: [...new Set(valid.map(row => row.version))], filesReady: valid.length > 0,
      bundled: valid.some(row => row.source === 'bundled'), compatible: match.length > 0,
      state: !valid.length ? entries.length ? 'invalid' : 'missing' : match.length ? 'prepared' : 'needs-adapter',
      message: !valid.length ? entries.some(row => row.fileError) ? '组件文件需要重新检查' : '尚未准备'
        : match.length ? '按游戏条件自动搭配' : '文件已准备，当前 Core 配套待适配' };
  });
  const updates = [];
  for (const kind of KINDS) {
    const installed = rows.filter(x => x.kind === kind && available(x));
    const newest = installed.reduce((best, row) => !best || compareVersions(row.version, best.version) > 0 ? row : best, null);
    const seen = new Set();
    const candidates = (catalog.packages || []).filter(row => {
      if (row.kind !== kind || !row.downloadUrl || !HASH.test(row.sha256 || '') || row.maturity === 'fallback' || hashes.has(row.sha256) || seen.has(row.sha256)) return false;
      seen.add(row.sha256);
      // Same-version rebuilds and incomparable variants are not silent upgrades.
      return !newest || compareVersions(row.version, newest.version) > 0;
    }).sort((a, b) => compareVersions(b.version, a.version) || 0);
    if (!candidates.length) continue;
    const reviewed = row => compatible(row, currentCore) && (row.compatibilityVerified === true || row.immutable === true && ['stable', 'candidate'].includes(row.validation));
    const candidate = candidates.find(reviewed) || candidates[0];
    updates.push({ ...candidate, downloadable: reviewed(candidate),
      message: reviewed(candidate) ? '下载到组件库，游戏内版本需另行应用' : candidate.requiresAdapter ? '上游新版尚缺配套，保留当前组件' : '新版兼容性待确认，保留当前组件' });
  }
  return { groups, updates, checkedAt: checkedAt || catalog.checkedAt || null, currentCore: currentCore.version || null };
}
function createComponentOverview({ appDir, resourcesPath, libraryRoot }) {
  const root = resourcesPath || path.join(appDir, 'resources');
  const cache = new Map();
  async function verify(file, expected) {
    if (!HASH.test(expected.sha256 || '') || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0) throw Error('组件身份无效');
    await noLinks(file); const stat = await fs.stat(file, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(expected.bytes)) throw Error('组件缺失或大小不符');
    const key = [file, expected.sha256, stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino].join('|');
    if (!cache.has(key)) {
      if (cache.size > 1024) cache.clear();
      const promise = hashRegularFile(file, { assertPath: noLinks, maxBytes: 1024 * 1024 * 1024 }).then(hash => {
        if (hash !== expected.sha256) throw Error('组件摘要不符');
      });
      cache.set(key, promise); promise.catch(() => cache.delete(key));
    }
    await cache.get(key);
  }
  async function inspect(row, directory) {
    try {
      for (const entry of row.files || []) {
        const rel = entry.file || entry.name;
        if (typeof rel !== 'string' || path.isAbsolute(rel) || /(^|[\\/])\.\.([\\/]|$)/.test(rel)) throw Error('组件路径无效');
        await verify(path.join(directory, rel), entry);
      }
      return { ...row, filesReady: Boolean(row.files?.length) };
    } catch (error) { return { ...row, filesReady: false, fileError: error.message }; }
  }
  async function bundled() {
    const rows = [];
    async function manifest(directory, check) {
      const file = path.join(root, directory, 'manifest.json');
      await noLinks(file);
      if ((await fs.stat(file)).size > 65536 || !check(JSON.parse(await fs.readFile(file, 'utf8')))) throw Error('随包清单缺失或与固定配套不符');
    }
    let mfgError, sm86Error;
    try { await manifest('fg-mfgunlock', data => data.version === 3 && data.backend === mfg.backend && data.defaultProvider === mfg.defaultProvider &&
      data.providers?.length === mfg.providers.length && mfg.providers.every(pin => {
        const entry = data.providers.find(x => x.id === pin.id);
        return entry?.releaseVersion === pin.version && entry.directory === pin.directory && entry.license === 'MIT' &&
          entry.source?.tag === pin.source.tag && entry.source?.origin === pin.origin && entry.source?.commit === pin.source.commit &&
          entry.source?.repository === pin.source.repository && entry.source?.url === pin.source.url &&
          Object.keys(entry.files || {}).length === Object.keys(pin.files).length && Object.entries(pin.files).every(([key, file]) =>
            entry.files[key]?.file === file.file && entry.files[key]?.sha256 === file.sha256);
      })); } catch (error) { mfgError = error.message; }
    try { await manifest('fg-sm86', data => data.schemaVersion === 1 && data.id === sm86Id && data.backend === 'dlssg-sm86' &&
      data.version === '0.3.5' && data.source?.repository === 'sdli1995/dlssg_for_sm86' && data.source?.commit === '9621db573e07ed54f50c15bbb585ed9a7bdfac28' &&
      Object.entries(sm86).every(([key, file]) => data.files?.[key]?.name === file.name && data.files[key].bytes === file.bytes && data.files[key].sha256 === file.sha256));
    } catch (error) { sm86Error = error.message; }
    for (const row of mfg.providers) {
      const inspected = await inspect({ id: row.id, kind: 'mfg', version: row.version, recommended: row.recommended,
      interface: 'Streamline-DLSSG', source: 'bundled', validation: 'candidate',
      files: Object.values(row.files).map(x => ({ ...x, name: x.file })) }, path.join(root, 'fg-mfgunlock', row.directory));
      rows.push(mfgError ? { ...inspected, filesReady: false, fileError: mfgError } : inspected);
    }
    const inspected = await inspect({ id: sm86Id, kind: 'dlssg-sm86', version: '0.3.5', recommended: true, source: 'bundled', validation: 'candidate',
      files: Object.values(sm86).map(x => ({ ...x, file: x.name })) }, path.join(root, 'fg-sm86'));
    rows.push(sm86Error ? { ...inspected, filesReady: false, fileError: sm86Error } : inspected);
    return rows;
  }
  async function read({ inventory = {}, catalog = {}, currentCore = {} } = {}) {
    const rows = [];
    for (const entry of (inventory.packages || []).filter(row => KINDS.includes(row.kind))) {
      let row = await inspect(entry, libraryRoot);
      if (row.kind === 'feeder' && row.filesReady) {
        const descriptor = row.files.find(x => x.name === 'external-provider-package.json');
        if (descriptor) {
          try {
            if (descriptor.bytes > 1024 * 1024) throw Error('配套清单过大');
            const definition = JSON.parse(await fs.readFile(path.join(libraryRoot, descriptor.file), 'utf8'));
            row = { ...row, interface: definition.interface?.name, requiredCoreCapabilities: definition.interface?.requiredCoreCapabilities || [],
              requiresAdapter: !definition.interface?.name || !Array.isArray(definition.interface?.requiredCoreCapabilities) };
          } catch { row = { ...row, requiresAdapter: true }; }
        } else row = { ...row, requiresAdapter: true };
      }
      rows.push(row);
    }
    return buildOverview({ packages: [...rows, ...await bundled()], catalog, currentCore });
  }
  return { read };
}
module.exports = { createComponentOverview, buildOverview, compareVersions, compatible };
