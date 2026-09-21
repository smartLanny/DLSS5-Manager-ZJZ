'use strict';

const fs = require('fs');
const crypto = require('crypto');
const yauzl = require('yauzl');
const { hashRegularFile } = require('./streamed-file-digest');
const { noLinks } = require('./launch-safety');

const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const DX11_CARRIER = 'dlss5-native-carrier-045-dx11-compat.addon64';
const D21_ARCHIVE_SHA256 = 'cf6d486a4525c75c5279446bd596b6008fc1eb5e3a8b1863a2ee15f249148107';
const D21_ADDON_SHA256 = '5fb873dab6f03f27c0b37380dff7ab5ad4ebc0ca295feadba06d00a28a1c9c78';
const D21_BRIDGE_SHA256 = '1acf3cbe509a031be1763a8231cd81e6019aa3532368cd0b08a6c17bc94b70a2';
const UNIFIED3_ARCHIVE = '1b51ab5646a10bb3f17db04de52c26f62dc8a40435e24ea145af1bebfcd8be46';
const PAIRED_OTA_PROFILES = Object.freeze({
  'beta0.4.5-dx11-compat': Object.freeze({
    coreName: 'dlss5-ai渲染超分版-beta0.4.5-dx11-compat-@野生的装机宅-bilibili.addon64',
    metadata: Object.freeze({
      display_version: '0.4.5-DX11-兼容增强',
      core_pe_version: '0.4.5.104'
    })
  }),
  'beta0.4.6': Object.freeze({
    coreName: 'dlss5-ai渲染超分版-beta0.4.6-@野生的装机宅-bilibili.addon64',
    metadata: Object.freeze({
      display_version: '0.4.6',
      source_commit: '9087a9efbc7bb53a3c79e7766a174534f49c412c',
      packaging_commit: '9087a9efbc7bb53a3c79e7766a174534f49c412c',
      core_pe_version: '0.4.6.0',
      core_file_version: '0.4.6 beta',
      carrier_upstream_file_version: '1.4.12.0',
      bridge_upstream_commit: '28aed4099b0fe1c207b20b5fee5364c0773c25c2',
      source_manifest_sha256: '7bb174529eb077e5b3e619c06e53209e778c3a3795dffc8d8a02ef31f84cfb71',
      validation_sha256: '394bcb44a8f5c921508d8103cb9c597f28c61003731f16bb62b083114e931daa',
      local_windows_verified: true,
      local_warp_verified: true,
      game_runtime_verified: false,
      stable_release: false
    }),
    hashes: Object.freeze({
      addon: 'b68f2709a131c9ce0513b6366dbcc2e7d551bef5bcd41934075407378a48c090',
      carrier: '8268ba3a9d7614ca0e0efad22f7c477780547224dfd0847a1d67188fc05f13c0',
      bridge: '46041a5ff91ae2fd907e310d132aabc3c4a1ecd48dace511b8672909d5d9c2fb'
    })
  }),
  'beta0.4.6-hotfix.1': Object.freeze({
    coreName: 'dlss5-ai渲染超分版-beta0.4.6-hotfix.1-@野生的装机宅-bilibili.addon64',
    metadata: Object.freeze({
      display_version: '0.4.6-hotfix.1',
      source_commit: '35ef9a826642e0eabcecd46d012167dd52b98105',
      packaging_commit: '35ef9a826642e0eabcecd46d012167dd52b98105',
      core_pe_version: '0.4.6.1',
      core_file_version: '0.4.6 hotfix.1 beta',
      carrier_upstream_file_version: '1.4.12.0',
      bridge_upstream_commit: '28aed4099b0fe1c207b20b5fee5364c0773c25c2',
      source_manifest_sha256: 'bf69c537c4c20b75b68940463d4990742f95d17ddffbdd5a7bbe19688c51f90d',
      validation_sha256: '62dfd5ac613c3d14575d3f9a6de4e13a7fe9f929608baba8fd133d80e0224da2',
      local_windows_verified: true,
      local_warp_verified: true,
      game_runtime_verified: false,
      stable_release: false
    }),
    hashes: Object.freeze({
      addon: '0727be26ceddcf60354535cee7c12a3138eef3075d7f90110b3693508fb633a5',
      carrier: '4656d9aac382a6f9b5c8488669aa5365283f03b5b94b2267f1c7f9b53927dc86',
      bridge: '46041a5ff91ae2fd907e310d132aabc3c4a1ecd48dace511b8672909d5d9c2fb'
    })
  })
});

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function archiveName(value) {
  const name = String(value || '').replace(/\\/g, '/');
  const parts = name.split('/');
  if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || /[\0-\x1f\x7f]/.test(name) ||
      parts.some((part, index) => part === '..' || part === '.' || (!part && index !== parts.length - 1))) {
    throw new Error('unsafe zip path');
  }
  return name;
}

function parseJson(bytes, label) {
  if (!bytes || bytes.length > MAX_METADATA_BYTES) throw new Error(`${label} missing or too large`);
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`invalid ${label}`); }
}

function readZipEntries(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = new Map();
      let total = 0;
      let settled = false;
      const names = new Set();
      const fail = reason => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch {}
        reject(reason);
      };
      zip.on('error', fail);
      zip.on('end', () => {
        if (!settled) { settled = true; resolve(entries); }
      });
      zip.on('entry', entry => {
        if (settled) return;
        let name;
        try { name = archiveName(entry.fileName); } catch (error) { return fail(error); }
        const key = (name.endsWith('/') ? name.slice(0, -1) : name).toLowerCase();
        if (names.has(key)) return fail(new Error(`duplicate zip path: ${name}`));
        names.add(key);
        if (name.endsWith('/')) return zip.readEntry();
        if ((entry.generalPurposeBitFlag & 1) !== 0) return fail(new Error('encrypted zip entry'));
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 ||
            entry.uncompressedSize > MAX_ENTRY_BYTES || total + entry.uncompressedSize > MAX_TOTAL_BYTES) {
          return fail(new Error('zip payload too large'));
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return fail(streamError);
          const chunks = [];
          let size = 0;
          stream.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_ENTRY_BYTES || total + size > MAX_TOTAL_BYTES) {
              stream.destroy(new Error('zip payload too large'));
              return;
            }
            chunks.push(chunk);
          });
          stream.on('error', fail);
          stream.on('end', () => {
            if (settled) return;
            const data = Buffer.concat(chunks);
            if (data.length !== entry.uncompressedSize) return fail(new Error(`zip entry size mismatch: ${name}`));
            total += data.length;
            entries.set(name, data);
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

function verifyRows(entries, rows, field, metadataName, allowedUnlisted = []) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('OTA hash list missing');
  const declared = new Map();
  for (const row of rows) {
    if (!row || typeof row[field] !== 'string') throw new Error('invalid OTA file record');
    const name = archiveName(row[field]);
    if (name.endsWith('/')) throw new Error(`invalid OTA file record: ${name}`);
    const key = name.toLowerCase();
    if (declared.has(key)) throw new Error(`duplicate OTA file record: ${name}`);
    const expected = typeof row.sha256 === 'string' ? row.sha256.toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(`invalid OTA file hash: ${name}`);
    const data = entries.get(name);
    if (!data) throw new Error(`OTA file missing: ${name}`);
    if (Object.prototype.hasOwnProperty.call(row, 'bytes') &&
        (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes !== data.length)) {
      throw new Error(`OTA file size mismatch: ${name}`);
    }
    if (sha256Buffer(data) !== expected) throw new Error(`OTA file hash mismatch: ${name}`);
    declared.set(key, { row, name, data, sha256: expected });
  }
  const allowed = new Set(allowedUnlisted);
  for (const name of entries.keys()) {
    if (name === metadataName) continue;
    if (!declared.has(name.toLowerCase()) && !allowed.has(name)) throw new Error(`unlisted OTA file: ${name}`);
  }
  return [...declared.values()];
}

function exactlyOne(rows, predicate, label) {
  const matches = rows.filter(predicate);
  if (matches.length !== 1) throw new Error(`OTA package must contain one ${label}`);
  return matches[0];
}

function matchesMetadata(actual, expected) {
  return Object.entries(expected).every(([field, value]) => actual[field] === value);
}

function instructionText(entries, names) {
  const matches = names.filter(name => entries.has(name));
  if (matches.length > 1) throw new Error('OTA package contains ambiguous instructions');
  if (!matches.length) return '';
  const bytes = entries.get(matches[0]);
  if (bytes.length > MAX_METADATA_BYTES) throw new Error('OTA instructions too large');
  return bytes.toString('utf8');
}

function result(manifest, addon, bridge, carrier, compatibility, instructions, extra = {}) {
  return {
    manifest,
    addonName: addon.name,
    addon: addon.data,
    addonSha256: addon.sha256,
    bridgeName: bridge.name,
    bridge: bridge.data,
    bridgeSha256: bridge.sha256,
    carrierName: carrier ? carrier.name : null,
    carrier: carrier ? carrier.data : null,
    carrierSha256: carrier ? carrier.sha256 : null,
    compatibility,
    instructions,
    ...extra
  };
}

function standardPackage(entries, archiveSha256) {
  const manifest = parseJson(entries.get('ota-manifest.json'), 'OTA manifest');
  if (!manifest || manifest.schema !== 'nr-branch-ota-v1' || !Array.isArray(manifest.files)) {
    throw new Error('unsupported OTA manifest');
  }
  if (manifest.includesDx11 === true || !/^D3D12-x64$/i.test(String(manifest.api || ''))) {
    throw new Error('this OTA package is not a standard DX12 OTA');
  }
  // Beta0.3.8 predates hashing its optional human-readable instructions.
  // Preserve that published package without extending the exception to any
  // executable/installable payload.
  const legacyText = manifest.version === 'Beta0.3.8' ? ['Instructions.txt'] : [];
  const rows = verifyRows(entries, manifest.files, 'name', 'ota-manifest.json', legacyText);
  const addonRows = rows.filter(item => /\.addon64$/i.test(item.name));
  const addon = exactlyOne(addonRows, item => !/^dlss5-native-carrier(?:-|_)/i.test(item.name), 'core addon64');
  if (addonRows.length !== 1) throw new Error('OTA package contains an unexpected carrier or addon64');
  const bridge = exactlyOne(rows, item => /^nrchain_nvngx\.dll$/i.test(item.name), 'nrchain_nvngx.dll');
  const instructions = instructionText(entries, ['Instructions.txt']);
  const exactD21 = archiveSha256 === D21_ARCHIVE_SHA256 && manifest.version === 'beta0.5-dline21-223fix2' &&
    manifest.display_version === '0.5 D21 累计常规版' && manifest.sourceCommit === '3a119c364a75aa5f52d81193fe35ccaf4bf6eddd' &&
    manifest.core_pe_version === '0.5.1.23' && manifest.channel === 'd21-cumulative-upgrade' &&
    addon.sha256 === D21_ADDON_SHA256 && bridge.sha256 === D21_BRIDGE_SHA256;
  return result(manifest, addon, bridge, null, null, instructions, { archiveSha256,
    ...(exactD21 ? { canonicalCore: { id:'0.5-dline21', version:'0.5 D21 累计常规版', variant:'zh-CN',
      architecture:'x64', interface:'NGX-D3D12-Feature1', inputInterfaces:['NGX-D3D12-Feature1'],
      supportsPresent:true, capabilities:['same-frame-output'], validation:'candidate', stableRelease:false,
      coreUpdateOnly:true,
      blockers:['新游戏、RTX40 与具体游戏仍需实机验收'] } } : {}) });
}

function dx11Package(entries, archiveSha256) {
  const buildInfo = parseJson(entries.get('build-info.json'), 'build-info.json');
  const u5 = require('./unified5-core');
  const isUnified5 = archiveSha256 === '55d044a6739ba89b8411f33fe0a336fc5de1477c216db3c6672ebaab572c4162';
  const unifiedId = isUnified5 ? u5.ID : '0.5-dline21-unified3';
  if ((isUnified5 || archiveSha256 === UNIFIED3_ARCHIVE) && buildInfo.version === `beta${unifiedId}` &&
      buildInfo.source_commit === (isUnified5 ? u5.SOURCE : '7a90660bc468ca86a02abe2e145638b51489d549') && buildInfo.language === 'zh-CN' &&
      buildInfo.full_face_backend === true && buildInfo.game_runtime_verified === false && buildInfo.stable_release === false) {
    const rows = verifyRows(entries, parseJson(entries.get('SHA256.json'), 'SHA256.json'), 'file', 'SHA256.json');
    const addon = exactlyOne(rows, row => row.sha256 === (isUnified5 ? u5.HASHES['zh-CN'] : '01b4155dcca346f6b3485f210191baaaf4af6faa9dfb9b29302c8f7e36ae3c93') && /\.addon64$/i.test(row.name), `${unifiedId} Core`);
    const bridge = exactlyOne(rows, row => row.name === 'nrchain_nvngx.dll' && row.sha256 === D21_BRIDGE_SHA256, 'unified3 NR chain');
    const carrier = exactlyOne(rows, row => row.name === DX11_CARRIER && row.sha256 === (isUnified5 ? u5.CARRIER : 'eb604bc1149da67492660a6d9e6dc622ca8fbcd247f67f8592aabc7cee633900'), `${unifiedId} DX11 carrier`);
    const policy = require('./payload-companions'), companions = rows.filter(row => policy.isCompanionName(row.name));
    policy.validateMap(Object.fromEntries(companions.map(row => [row.name, row.sha256])), unifiedId);
    return result(buildInfo, addon, bridge, carrier, 'dx11', instructionText(entries, ['安装说明.txt']), {
      archiveSha256, companions,
      canonicalCore: { id: unifiedId, version: isUnified5 ? '0.5 Unified5' : '0.5 D21 unified3', variant: 'zh-CN', architecture: 'x64',
        interface: 'NGX-D3D12-Feature1', inputInterfaces: ['NGX-D3D12-Feature1'], supportsPresent: true,
        capabilities: ['same-frame-output'], validation: 'candidate', stableRelease: false, coreUpdateOnly: false,
        blockers: [isUnified5 ? 'Provider V1 已实现；与 Feeder 成品及实际游戏的配套验收未完成，不自动启用外部路线。' : '具体游戏和 NVIDIA 实机尚未验证；此 Core 未声明外部 Provider V1 接口。'] }
    });
  }
  // Core acceptance archives share the metadata filenames, but are not a
  // matched Manager update. Explain that distinction without widening admission.
  if (buildInfo && buildInfo.scope === 'D3D12 Core-only manual acceptance; not Manager/multi-API OTA') {
    throw Object.assign(new Error('这是仅供 D3D12 验收的核心测试包，不能作为 Manager OTA 导入。请使用配套的管理器更新包。'), { code: 'ERR_OTA_CORE_ONLY' });
  }
  const hashes = parseJson(entries.get('SHA256.json'), 'SHA256.json');
  const profile = buildInfo && typeof buildInfo.version === 'string' &&
    Object.prototype.hasOwnProperty.call(PAIRED_OTA_PROFILES, buildInfo.version)
    ? PAIRED_OTA_PROFILES[buildInfo.version] : null;
  if (!buildInfo || !profile || !matchesMetadata(buildInfo, profile.metadata) ||
      buildInfo.language !== 'zh-CN' ||
      typeof buildInfo.carrier_upstream_file_version !== 'string' || !buildInfo.carrier_upstream_file_version ||
      typeof buildInfo.source_commit !== 'string' || !/^[0-9a-f]{40}$/i.test(buildInfo.source_commit) ||
      typeof buildInfo.packaging_commit !== 'string' || !/^[0-9a-f]{40}$/i.test(buildInfo.packaging_commit)) {
    throw new Error('unsupported DX11 OTA metadata');
  }
  const rows = verifyRows(entries, hashes, 'file', 'SHA256.json');
  const addonRows = rows.filter(item => /\.addon64$/i.test(item.name));
  const carrier = exactlyOne(addonRows, item => item.name.toLowerCase() === DX11_CARRIER, 'matched DX11 carrier');
  const addon = exactlyOne(addonRows, item => item.name.toLowerCase() === profile.coreName, 'published core addon64');
  if (addonRows.length !== 2) throw new Error('OTA package contains an ambiguous addon64 role');
  const bridge = exactlyOne(rows, item => /^nrchain_nvngx\.dll$/i.test(item.name), 'nrchain_nvngx.dll');
  if (profile.hashes && (addon.sha256 !== profile.hashes.addon ||
      carrier.sha256 !== profile.hashes.carrier || bridge.sha256 !== profile.hashes.bridge)) {
    throw new Error(`${buildInfo.version} OTA component identity mismatch`);
  }
  const instructions = instructionText(entries, ['安装说明.txt', 'Instructions.txt']);
  return result(buildInfo, addon, bridge, carrier, 'dx11', instructions);
}

async function readOtaPackage(file) {
  if (typeof file !== 'string' || !/\.zip$/i.test(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error('invalid OTA package');
  }
  const stat = fs.statSync(file);
  if (stat.size > MAX_TOTAL_BYTES) throw new Error('OTA archive too large');
  const archiveSha256 = await hashRegularFile(file, { assertPath:noLinks, maxBytes:MAX_TOTAL_BYTES });
  const entries = await readZipEntries(file);
  const standard = entries.has('ota-manifest.json');
  const dx11 = entries.has('build-info.json') || entries.has('SHA256.json');
  if (standard && dx11) throw new Error('ambiguous OTA metadata');
  if (standard) return standardPackage(entries, archiveSha256);
  if (dx11) {
    if (!entries.has('build-info.json') || !entries.has('SHA256.json')) throw new Error('DX11 OTA metadata missing');
    return dx11Package(entries, archiveSha256);
  }
  throw new Error('OTA manifest missing');
}

module.exports = { readOtaPackage, sha256Buffer };
