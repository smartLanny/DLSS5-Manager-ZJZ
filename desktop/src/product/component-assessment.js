'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const pe = require('../core/pe');
const { noLinks } = require('./launch-safety');
const { addonValues } = require('./reshade-layout');
const { resolveAddonLoadState, readRegisteredName } = require('./addon-loading-layout');

const HASH = /^[a-f0-9]{64}$/i;
const ADDON = /\.addon(?:32|64)?$/i;
const MODULE = /\.(?:dll|asi|addon(?:32|64)?)$/i;
const PROXY = /^(?:dxgi|d3d9|d3d10|d3d11|d3d12|opengl32|dinput8|version|winmm|dsound|ReShade64)\.dll$/i;
const LIMITS = Object.freeze({ directories: 4, entries: 4096, files: 64, expected: 256, catalog: 512,
  fileBytes: 256 * 1024 * 1024, hashBytes: 512 * 1024 * 1024, probeBytes: 8 * 1024 * 1024, totalProbeBytes: 32 * 1024 * 1024 });
const LABELS = Object.freeze({ core: '本项目 NR-before-SR Core', 'native-carrier': 'DX11 Native Carrier',
  'renodx-hdr': 'RenoDX HDR / 颜色模块', 'renodx-generic-nr': 'RenoDX Generic NR', 'renodx-dlss5': 'RenoDX DLSS5 Tool',
  'renodx-other': 'RenoDX 模块（具体用途待确认）', mfgunlock: 'MFG Unlock 补帧组件', reshade: 'ReShade 加载器',
  chain: 'NR 桥接库', 'nr-runtime': 'DLSS5 模型', 'other-mod': '其他模组', unknown: '来源未知组件' });
const key = value => path.resolve(value).toLowerCase();
const error = (code, message) => Object.assign(new Error(message), { code: 'COMPONENT_' + code });
const issue = (code, detail, paths = [], source = 'inspection', confidence = 'unknown') => ({ code: 'COMPONENT_' + code, detail, paths, source, confidence, runtimeVerified: false });
const roleClass = role => ({ addon: 'core', carrier: 'native-carrier', loader: 'reshade', 'profile-loader': 'reshade', bridge: 'chain', runtime: 'nr-runtime',
  'user-addon': 'other-mod', 'user-dependency': 'other-mod' })[role] || (Object.hasOwn(LABELS, role) ? role : 'unknown');
function declaration(text) {
  if (/\b(?:NRBeforeSR|NR[-_ ]before[-_ ]SR)\b/i.test(text)) return 'core';
  if (/\b(?:dlss5-native-carrier|r3-nr-native-neutral)\b/i.test(text)) return 'native-carrier';
  if (/\b(?:renodx-dlss5|DLSS5 Tool)\b/i.test(text)) return 'renodx-dlss5';
  if (/\b(?:RenoDX[-_ ]Generic(?:[-_ ]NR)?|Generic[-_ ]NR|RenoDX[-_ ]NR|renodx[-_ ]dlssnr)\b/i.test(text)) return 'renodx-generic-nr';
  if (/\b(?:MFG[-_ ]?Unlock|MFGAdaUnlock|RTX40MFG)\b/i.test(text)) return 'mfgunlock';
  if (/\bRenoDX\b/i.test(text)) return /\b(?:HDR(?:10)?|tone[-_ ]?mapping|color[-_ ]grading)\b/i.test(text) ? 'renodx-hdr' : 'renodx-other';
  if (/\b(?:OptiScaler|REFramework|Special K|RTSS|RivaTuner|Display Depth|Frame Monitor)\b/i.test(text)) return 'other-mod';
  if (/\bReShade\b/i.test(text)) return 'reshade';
  return null;
}
function filenameClue(name) {
  const declared = declaration(name.replace(/\.addon(?:32|64)?$/i, ''));
  if (declared) return declared;
  if (/renodx/i.test(name)) return /(?:hdr|color|tonemap)/i.test(name) ? 'renodx-hdr' : /(?:generic|\bnr\b)/i.test(name) ? 'renodx-generic-nr' : 'renodx-other';
  if (/(?:dlss5|nr[-_ ]?before[-_ ]?sr|(?:^|[-_.])(?:old|legacy)[-_ ]?nr(?:[-_.]|$))/i.test(name)) return 'core';
  if (/(?:overlay|hud|reframework|rtss|special[-_ ]?k|frame[-_ ]?monitor)/i.test(name)) return 'other-mod';
  return null;
}
const METADATA_MARKERS = ['NRBeforeSR', 'NR-before-SR', 'dlss5-native-carrier', 'renodx-dlss5', 'DLSS5 Tool', 'RenoDX NR', 'renodx-dlssnr', 'RenoDX', 'Generic NR',
  'MFG Unlock', 'MFGUnlock', 'RTX40MFG', 'HDR', 'Color Grading', 'OptiScaler', 'REFramework', 'Special K', 'RTSS', 'ReShade'];
function clues(name, probe, metadata) {
  const evidence = [], metadataClass = declaration(metadata.join(' '));
  const contentClass = declaration(probe.toString('latin1') + '\n' + probe.toString('utf16le'));
  const nameClass = filenameClue(name);
  if (metadataClass) evidence.push({ source: 'pe-metadata', confidence: 'declared', classification: metadataClass, detail: 'PE 版本资源自声明组件用途；尚未匹配固定身份。' });
  if (contentClass) evidence.push({ source: 'content-declaration', confidence: 'declared', classification: contentClass, detail: '有界内容检查发现组件自声明；普通 DLSS / NGX 引用不算 NR 身份。' });
  if (nameClass) evidence.push({ source: 'filename', confidence: 'hint', classification: nameClass, detail: '仅文件名线索，不能证明组件来源或运行效果。' });
  const specificity = classification => ['core', 'native-carrier', 'renodx-dlss5', 'renodx-generic-nr', 'mfgunlock'].includes(classification) ? 3 : classification === 'renodx-hdr' ? 2 : 1;
  const declarations = evidence.filter(row => row.confidence === 'declared').sort((a, b) => specificity(b.classification) - specificity(a.classification));
  const chosen = declarations[0] || evidence[0];
  return { classification: chosen?.classification || 'unknown', label: LABELS[chosen?.classification || 'unknown'],
    source: chosen?.source || 'unidentified', confidence: chosen?.confidence || 'unknown', evidence };
}
function sameStat(a, b) { return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && b.nlink === 1; }
async function observeFile(file, budget, hash = true) {
  await noLinks(file); let handle;
  try {
    handle = await fs.open(file, 'r'); const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) throw error('FILE_INVALID', '组件不是普通单链接文件。');
    if (before.size > LIMITS.fileBytes || hash && before.size > budget.hashBytes) throw error('READ_LIMIT', '组件超出本次有界读取预算，未推测身份。');
    if (hash) budget.hashBytes -= before.size;
    const probeSize = Math.min(before.size, LIMITS.probeBytes, budget.probeBytes), chunks = [], digest = hash ? crypto.createHash('sha256') : null;
    budget.probeBytes -= probeSize;
    const bytes = hash ? before.size : probeSize, buffer = Buffer.alloc(64 * 1024);
    for (let position = 0; position < bytes;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, bytes - position), position);
      if (!bytesRead) throw error('FILE_CHANGED', '组件在读取时改变，未采用部分内容。');
      digest?.update(buffer.subarray(0, bytesRead));
      if (position < probeSize) chunks.push(Buffer.from(buffer.subarray(0, Math.min(bytesRead, probeSize - position))));
      position += bytesRead;
    }
    // The PE reader limits its version resource to 64 KiB and never loads code.
    const bitness = pe.getBitness(file), version = pe.getFileVersion(file);
    const metadata = METADATA_MARKERS.filter(marker => pe.versionMentions(file, marker));
    await noLinks(file); const after = await handle.stat(), atPath = await fs.stat(file);
    if (!sameStat(before, after) || !sameStat(before, atPath)) throw error('FILE_CHANGED', '组件在检查期间改变，未采用旧摘要。');
    return { bytes: before.size, sha256: digest?.digest('hex') || null, architecture: bitness === 64 ? 'x64' : bitness === 32 ? 'x86' : 'unknown',
      version, ...clues(path.basename(file), Buffer.concat(chunks), metadata) };
  } finally { await handle?.close(); }
}
// Cleanup uses the same bounded declaration checks, without treating the
// declaration as a fixed identity or modifying the file.
async function inspectComponentClues(file) {
  return observeFile(file, { hashBytes: 0, probeBytes: LIMITS.probeBytes }, false);
}

function createComponentAssessment({ layout, getExpectedModules = (_id, current) => current.moduleManifest || [], knownPayloads = [], allowExplicitExpectedPaths = false }) {
  async function inspect(id) {
    const current = await layout(id), files = [], conflicts = [], warnings = [];
    const directories = new Map();
    for (const value of [current.addonDirectory || current.addonDir, current.runtimeDir, current.loaderDir,
      path.isAbsolute(current.exe || '') ? path.dirname(current.exe) : null]) {
      if (typeof value === 'string' && path.isAbsolute(value)) directories.set(key(value), path.resolve(value));
    }
    if (!directories.size || directories.size > LIMITS.directories) return { files, conflicts, warnings: [issue('LAYOUT', '活动组件目录未确认；没有扩大扫描范围。')], runtimeVerified: false };
    const inScope = file => typeof file === 'string' && path.isAbsolute(file) && directories.has(key(path.dirname(file))) && MODULE.test(file);
    let expectedInput = [], catalogInput = [];
    try { expectedInput = await getExpectedModules(id, current); }
    catch (cause) { warnings.push(issue('EXPECTED_UNAVAILABLE', cause.message || '组件所有者记录不可读取。')); }
    try { catalogInput = typeof knownPayloads === 'function' ? await knownPayloads(id, current) : knownPayloads; }
    catch (cause) { warnings.push(issue('CATALOG_UNAVAILABLE', cause.message || '固定组件清单不可读取。')); }
    const bounded = (rows, maximum, type) => {
      if (!Array.isArray(rows)) { warnings.push(issue(type + '_INVALID', '组件记录格式无效，未当作固定身份。')); return []; }
      if (rows.length > maximum) warnings.push(issue(type + '_LIMIT', '组件记录超出本次条数限制，未完整检查。'));
      return rows.slice(0, maximum);
    };
    const expected = new Map(), known = new Map();
    const remember = (row, source) => {
      if (!HASH.test(row?.sha256 || '')) return false;
      const fingerprint = row.sha256.toLowerCase(), rows = known.get(fingerprint) || [];
      rows.push({ ...row, sha256: fingerprint, classification: roleClass(row.role || row.kind), source }); known.set(fingerprint, rows); return true;
    };
    for (const row of bounded(expectedInput, LIMITS.expected, 'EXPECTED')) {
      // The application may supply additional paths from validated deployment
      // owners (for example the fixed Vulkan layer DLL). Read only those files;
      // never add their parent directories to enumeration or INI resolution.
      const explicit = allowExplicitExpectedPaths === true && typeof row?.path === 'string' && path.isAbsolute(row.path) && MODULE.test(row.path);
      if (!(inScope(row?.path) || explicit) || !HASH.test(row?.sha256 || '')) { warnings.push(issue('EXPECTED_SCOPE', '受管组件记录的路径或摘要不在当前顶层检查范围。')); continue; }
      const normalized = { ...row, path: path.resolve(row.path), sha256: row.sha256.toLowerCase() }, rows = expected.get(key(row.path)) || [];
      rows.push(normalized); expected.set(key(row.path), rows); remember(normalized, 'managed-sha256');
    }
    for (const row of bounded(catalogInput, LIMITS.catalog, 'CATALOG')) if (!remember(row, 'known-sha256')) warnings.push(issue('CATALOG_INVALID', '固定组件条目缺少有效摘要，未推测来源。'));
    const candidates = new Map([...expected].map(([file, rows]) => [file, rows[0].path]));
    let entriesRead = 0;
    for (const directory of directories.values()) {
      let handle;
      try {
        await noLinks(directory); handle = await fs.opendir(directory);
        for await (const entry of handle) {
          if (++entriesRead > LIMITS.entries) { warnings.push(issue('DIRECTORY_LIMIT', '活动目录条目过多，仅检查本次有界范围。', [directory])); break; }
          if (ADDON.test(entry.name) || PROXY.test(entry.name)) { const file = path.join(directory, entry.name); candidates.set(key(file), file); }
        }
      } catch (cause) { if (cause.code !== 'ENOENT') warnings.push(issue('DIRECTORY_UNAVAILABLE', '活动目录不可安全读取，未扫描替代目录。', [directory])); }
      if (entriesRead > LIMITS.entries) break;
    }
    const addonDirectory = current.addonDirectory || current.addonDir, direct = new Set();
    let disabledValues = [];
    let addonBinding = current.verified === true && path.isAbsolute(addonDirectory || '');
    if (current.activeConfigPath) {
      try {
        if (!path.isAbsolute(current.activeConfigPath) || !directories.has(key(path.dirname(current.activeConfigPath)))) throw error('CONFIG_SCOPE', '配置不在当前组件范围。');
        await noLinks(current.activeConfigPath); const stat = await fs.stat(current.activeConfigPath);
        if (!stat.isFile() || stat.size > 1024 * 1024) throw error('CONFIG_LIMIT', '配置超出读取限制。');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(current.activeConfigPath)), values = addonValues(text);
        addonBinding = addonBinding && key(path.resolve(path.dirname(current.activeConfigPath), values.get('AddonPath')?.[0] || '.')) === key(addonDirectory);
        disabledValues = values.get('DisabledAddons') || [];
        const early = values.get('LoadFromDllMain') || [];
        if (early.length > LIMITS.files) throw error('EXPLICIT_LIMIT', '显式加载插件过多。');
        if (addonBinding) for (const name of early) {
          const file = path.resolve(addonDirectory, name);
          if (/^\\\\/.test(file) || /%[^%]+%/.test(name) || !MODULE.test(file)) throw error('EXPLICIT_SCOPE', '显式加载路径无法安全解析。');
          await noLinks(file); direct.add(key(file)); candidates.set(key(file), file);
        }
      } catch (cause) {
        if (cause.code !== 'ENOENT') { addonBinding = false; warnings.push(issue('CONFIG_UNAVAILABLE', '活跃插件配置无法核对，未把磁盘文件当作正在加载。')); }
      }
    }
    if (current.verified !== true || !addonBinding) warnings.push(issue('LOAD_PATH_UNVERIFIED', '布局或 AddonPath 未与活动目录一致确认；组件身份与运行效果分别记录。'));
    if (candidates.size > LIMITS.files) warnings.push(issue('FILE_LIMIT', '组件数量超出本次检查限制，结果并不完整。'));
    const budget = { hashBytes: LIMITS.hashBytes, probeBytes: LIMITS.totalProbeBytes };
    for (const file of [...candidates.values()].slice(0, LIMITS.files)) {
      const records = expected.get(key(file)) || [], hashes = [...new Set(records.map(row => row.sha256))];
      const row = { name: path.basename(file), path: file, kind: ADDON.test(file) ? 'addon' : PROXY.test(path.basename(file)) ? 'proxy' : 'managed-pe',
        status: 'unknown', classification: 'unknown', label: LABELS.unknown, source: 'unidentified', confidence: 'unknown', sha256: null, architecture: 'unknown',
        expectedSha256: hashes.length === 1 ? hashes[0] : null, expectedIdentities: records.map(value => ({ role: value.role, sha256: value.sha256, owner: value.owner || null })),
        loadState: ADDON.test(file) ? addonBinding && key(path.dirname(file)) === key(addonDirectory) ? 'enabled' : 'inactive-or-unverified' :
          direct.has(key(file)) ? 'enabled' : PROXY.test(path.basename(file)) ? 'candidate' : 'dependency', evidence: [], issues: [], runtimeVerified: false };
      if (hashes.length > 1) { row.issues.push('owner-conflict'); conflicts.push(issue('OWNER_CONFLICT', '多个所有者对同一路径记录了不同摘要。', [file], 'managed-sha256', 'verified')); }
      try {
        Object.assign(row, await observeFile(file, budget));
        const configuredSearch = addonBinding && key(path.dirname(file)) === key(addonDirectory) &&
          ['.addon', row.architecture === 'x86' ? '.addon32' : '.addon64'].includes(path.extname(file));
        const registeredName = await readRegisteredName(file);
        if (ADDON.test(file) || direct.has(key(file))) {
          const loading = resolveAddonLoadState({ name: row.name, registeredName, searched: configuredSearch,
            explicit: direct.has(key(file)), architecture: row.architecture, hostArchitecture: 64, disabledValues });
          Object.assign(row, loading, { registeredName, loadState: loading.loadState === 'explicit' ? 'enabled' :
            loading.loadState === 'inactive' ? 'inactive-or-unverified' : loading.loadState });
        }
        const exact = records.find(value => value.sha256 === row.sha256), matches = known.get(row.sha256) || [];
        const identities = [...new Set(matches.map(value => value.classification).filter(value => value !== 'unknown' && value !== 'other-mod'))];
        const fixed = exact || (identities.length === 1 ? matches.find(value => value.classification === identities[0]) : null);
        if (fixed) {
          const classification = roleClass(fixed.role || fixed.kind);
          row.identitySource = exact ? 'managed-sha256' : 'known-sha256'; row.identityVerified = true;
          if (classification !== 'unknown' && classification !== 'other-mod') {
            row.classification = classification; row.label = LABELS[classification]; row.source = row.identitySource; row.confidence = 'verified';
          }
          row.identity = { id: fixed.id || classification, version: fixed.version || null, owner: fixed.owner || null };
          row.evidence.unshift({ source: row.identitySource, confidence: 'verified', detail: '文件摘要与固定组件记录一致；这只确认磁盘身份。' });
        }
        if (identities.length > 1 && !exact) warnings.push(issue('IDENTITY_AMBIGUOUS', '同一摘要在固定清单中有不同组件角色，未猜测唯一身份。', [file], 'known-sha256'));
        const architectureMismatch = records.some(value => value.architecture != null && (['x64', 64].includes(value.architecture) ? row.architecture !== 'x64' : ['x86', 32].includes(value.architecture) ? row.architecture !== 'x86' : true));
        const nameMismatch = records.some(value => value.name && (typeof value.name !== 'string' || value.name.toLowerCase() !== row.name.toLowerCase()));
        if (hashes.length && (hashes.length !== 1 || hashes[0] !== row.sha256 || architectureMismatch || nameMismatch)) {
          row.status = 'version-conflict'; row.issues.push('version-conflict');
          conflicts.push(issue('VERSION_CONFLICT', nameMismatch ? '组件名称与受管路径记录不一致。' : architectureMismatch ? '组件位数与受管记录不一致。' : '组件当前摘要与受管期望版本不一致。', [file], 'managed-sha256', 'verified'));
        } else row.status = exact ? 'reusable' : row.classification === 'unknown' ? 'unknown' : 'other-mod';
      } catch (cause) {
        row.status = cause.code === 'ENOENT' ? 'missing' : 'unavailable'; row.source = 'unavailable'; row.detail = cause.message;
        warnings.push(issue(cause.code === 'ENOENT' ? 'MISSING' : 'FILE_UNAVAILABLE', '组件无法安全完成身份检查；已保留文件。', [file]));
      }
      files.push(row);
    }
    const loadable = files.filter(row => row.sha256 && (row.moduleMayLoad === true || row.loadState === 'candidate')), hashGroups = new Map();
    for (const row of loadable) { const rows = hashGroups.get(row.sha256) || []; rows.push(row); hashGroups.set(row.sha256, rows); }
    const duplicates = new Set();
    const markDuplicate = (rows, confidence, source, detail) => {
      const paths = rows.map(row => row.path), signature = paths.map(key).sort().join('|'); if (duplicates.has(signature)) return;
      duplicates.add(signature);
      for (const row of rows) { row.issues.push('duplicate-load'); if (!['version-conflict', 'unavailable'].includes(row.status)) row.status = 'duplicate-load'; }
      conflicts.push(issue('DUPLICATE_LOAD', detail, paths, source, confidence));
    };
    for (const rows of hashGroups.values()) if (rows.length > 1) markDuplicate(rows, 'verified', 'sha256-comparison', '多个可加载位置存在相同模块字节，有重复加载风险；尚未确认本次进程实际加载情况。');
    const cores = loadable.filter(row => row.classification === 'core' && ['verified', 'declared'].includes(row.confidence));
    if (cores.length > 1) markDuplicate(cores, cores.every(row => row.confidence === 'verified') ? 'verified' : 'declared', 'component-identity', '活动目录存在多个本项目 Core 身份或自声明，需核对重复加载；不代表 NR 已成功运行。');
    const nrPeers = loadable.filter(row => ['renodx-generic-nr', 'renodx-dlss5'].includes(row.classification) && ['verified', 'declared'].includes(row.confidence));
    if (cores.length && nrPeers.length) warnings.push(issue('NR_COEXISTENCE_UNVERIFIED', '本项目 Core 与独立 Generic NR / DLSS5 Tool 同处可加载范围，需要分别核对兼容性；HDR / 颜色模块不计入此判断。', [...cores, ...nrPeers].map(row => row.path), 'component-identity', 'declared'));
    return { files: files.sort((a, b) => key(a.path).localeCompare(key(b.path))), conflicts, warnings, runtimeVerified: false };
  }
  return { inspect };
}
module.exports = { createComponentAssessment, inspectComponentClues, COMPONENT_ASSESSMENT_LIMITS: LIMITS };
