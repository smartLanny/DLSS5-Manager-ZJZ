'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const yauzl = require('yauzl');
const { PAYLOAD_FILES } = require('../src/product/constants');

const ZIP_ENTRY_LIMIT = 64 * 1024 * 1024;
const ZIP_TOTAL_LIMIT = 128 * 1024 * 1024;
const METADATA_LIMIT = 1024 * 1024;
const CONFIG_PATH = 'config/nr_before_sr.ini';

const TARGETS = Object.freeze([
  Object.freeze({
    id: '0.5-dline13',
    arg: 'dline13Zip',
    label: '0.5 D13 · 测试',
    sourceZipName: 'DLSS5-0.5-D13-zh-CN-OTA.zip',
    sourceZipSha256: 'dbcda23e991712901c1427b7e3699a09e9a22b184e741239ca80d134932cfee7',
    sourceCommit: '7abd23569d0a64691caa8cd9adcff3596d6a04a9',
    packagingCommit: 'f1d463e5184460be37b965b75a5199dde3bbb22c',
    sourceAddonName: 'DLSS5-AI渲染超分版-beta0.5-dline13-@野生的装机宅-Bilibili.addon64',
    sourceAddonSha256: '3f67cc32536482dd51857df71bc8294f4af3d4e5974c453ca45a94fb9280e296',
    bridgeSha256: '46041a5ff91ae2fd907e310d132aabc3c4a1ecd48dace511b8672909d5d9c2fb',
    corePeVersion: '0.5.1.13',
    validationSha256: 'e3751f49f8fe37574ac40d73b45c7813714b0988d55e04fb654b38f98ce06b76',
    inputPackageSha256: '85a5e0c3e662a6e3bf0b01162c579ca15739f7bedbf8dabb97fd004eb10a673a',
    manifestKind: 'standard',
    api: 'D3D12-x64',
    configMarkers: Object.freeze(['[NRBeforeSR]', 'beta0.5-dline10', 'ConfigVersion=4', 'NRPasses=1', 'NRSecondScaleNumerator=1', 'NRSecondScaleDenominator=2']),
    configForbidden: Object.freeze(['0.4.7beta-ds1.1'])
  }),
  Object.freeze({
    id: '0.4.7beta-corefix.8',
    arg: 'corefix8Zip',
    label: '0.4.7 Corefix8 · 测试',
    sourceZipName: 'DLSS5-0.4.7beta-corefix.8-zh-CN-D3D12-Core-Acceptance.zip',
    sourceZipSha256: 'fa29593f56489493b589fc98ec710e63fe536a5fe692f24bcf615d742313533f',
    sourceCommit: '69490510345f5a34481e7a7600defc87e7df62f0',
    packagingCommit: 'd7a6def43a58ea6c4b26c553547429a8ef88b735',
    sourceAddonName: 'DLSS5-AI渲染超分版-0.4.7beta-corefix.8-@野生的装机宅-Bilibili.addon64',
    sourceAddonSha256: '504bb48b1137b02a9ab126fe10337f0331a93684c413f411f4fea4fa47eb1b8d',
    bridgeSha256: '46041a5ff91ae2fd907e310d132aabc3c4a1ecd48dace511b8672909d5d9c2fb',
    corePeVersion: '0.4.7.13',
    sourceManifestSha256: '57b6a5af7998a693a580254ec8c5d2aed8c9059e7a3b1f9d2fa51ed297524a48',
    validationSha256: '3a3b37993c132ead1c1a081ca48656a3c03a51976c4daedf2d985272ffcd131a',
    manifestKind: 'core-only',
    api: 'D3D12-x64',
    configMarkers: Object.freeze(['[NRBeforeSR]', '0.4.7beta-ds1.1', 'ConfigVersion=4', 'JitterPolicyVersion=1']),
    configForbidden: Object.freeze(['NRSecondScaleDenominator='])
  })
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fail(message, code = 'ERR_BETA_CORE_CATALOG') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function archiveName(value) {
  const name = String(value || '').replace(/\\/g, '/');
  const parts = name.split('/');
  if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || /[\0-\x1f\x7f]/.test(name) ||
      parts.some((part, index) => part === '..' || part === '.' || (!part && index !== parts.length - 1))) {
    fail(`ZIP 路径不安全：${name}`, 'ERR_BETA_CORE_ZIP_PATH');
  }
  return name;
}

// Keep the same bounded, path-safe ZIP read contract as the production OTA reader.
function readZipEntries(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError) return reject(openError);
      const entries = new Map();
      const names = new Set();
      let total = 0;
      let settled = false;
      const failRead = error => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch {}
        reject(error);
      };
      zip.on('error', failRead);
      zip.on('end', () => {
        if (!settled) { settled = true; resolve(entries); }
      });
      zip.on('entry', entry => {
        if (settled) return;
        let name;
        try { name = archiveName(entry.fileName); } catch (error) { return failRead(error); }
        const key = name.endsWith('/') ? name.slice(0, -1).toLowerCase() : name.toLowerCase();
        if (names.has(key)) return failRead(new Error(`ZIP entry 重复：${name}`));
        names.add(key);
        if (name.endsWith('/')) return zip.readEntry();
        if ((entry.generalPurposeBitFlag & 1) !== 0) return failRead(new Error(`ZIP entry 已加密：${name}`));
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 ||
            entry.uncompressedSize > ZIP_ENTRY_LIMIT || total + entry.uncompressedSize > ZIP_TOTAL_LIMIT) {
          return failRead(new Error(`ZIP 内容超限：${name}`));
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return failRead(streamError);
          const chunks = [];
          let size = 0;
          stream.on('data', chunk => {
            size += chunk.length;
            if (size > ZIP_ENTRY_LIMIT || total + size > ZIP_TOTAL_LIMIT) stream.destroy(new Error('ZIP 内容超限'));
            else chunks.push(chunk);
          });
          stream.on('error', failRead);
          stream.on('end', () => {
            if (settled) return;
            const data = Buffer.concat(chunks);
            if (data.length !== entry.uncompressedSize) return failRead(new Error(`ZIP entry 大小不匹配：${name}`));
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

function plainFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { fail(`${label} 不存在：${file}`, 'ERR_BETA_CORE_INPUT'); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} 必须是普通文件：${file}`, 'ERR_BETA_CORE_INPUT');
  return file;
}

function plainDirectory(dir, label) {
  let stat;
  try { stat = fs.lstatSync(dir); } catch { fail(`${label} 不存在：${dir}`, 'ERR_BETA_CORE_INPUT'); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} 必须是普通目录：${dir}`, 'ERR_BETA_CORE_INPUT');
  return dir;
}

function jsonEntry(entries, name) {
  const bytes = entries.get(name);
  if (!bytes || bytes.length > METADATA_LIMIT) fail(`缺少或过大的 ZIP 元数据：${name}`, 'ERR_BETA_CORE_ZIP_METADATA');
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail(`JSON 无效：${name}`, 'ERR_BETA_CORE_ZIP_METADATA'); }
}

function entryBytes(entries, name, expectedHash, expectedBytes = null) {
  const bytes = entries.get(name);
  if (!bytes) fail(`ZIP 缺少文件：${name}`, 'ERR_BETA_CORE_ZIP_CONTENT');
  if (expectedBytes !== null && bytes.length !== expectedBytes) fail(`ZIP 文件大小不匹配：${name}`, 'ERR_BETA_CORE_ZIP_CONTENT');
  const actual = sha256(bytes);
  if (expectedHash && actual !== expectedHash) fail(`ZIP 文件哈希不匹配：${name}`, 'ERR_BETA_CORE_ZIP_CONTENT');
  return bytes;
}

function exactEntrySet(entries, expectedNames) {
  const actual = [...entries.keys()].sort();
  const expected = [...expectedNames].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`ZIP 文件集合不匹配；实际=${actual.join(',')}；期望=${expected.join(',')}`, 'ERR_BETA_CORE_ZIP_CONTENT');
  }
}

function verifyManifestRows(entries, manifest) {
  if (!Array.isArray(manifest.files) || !manifest.files.length) fail('标准 OTA 缺少 files 清单', 'ERR_BETA_CORE_ZIP_METADATA');
  const declared = new Set();
  for (const row of manifest.files) {
    if (!row || typeof row.name !== 'string' || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(row.sha256)) {
      fail('标准 OTA files 清单无效', 'ERR_BETA_CORE_ZIP_METADATA');
    }
    if (declared.has(row.name.toLowerCase())) fail(`标准 OTA files 重复：${row.name}`, 'ERR_BETA_CORE_ZIP_METADATA');
    declared.add(row.name.toLowerCase());
    entryBytes(entries, row.name, row.sha256.toLowerCase(), row.bytes ?? null);
  }
  for (const name of entries.keys()) if (name !== 'ota-manifest.json' && !declared.has(name.toLowerCase())) {
    fail(`标准 OTA 存在未列入清单的文件：${name}`, 'ERR_BETA_CORE_ZIP_CONTENT');
  }
}

function runGit(repo, args, label, encoding = null) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) fail(`${label} 失败`, 'ERR_BETA_CORE_CONFIG_SOURCE');
  return result.stdout;
}

function readConfigBlob(repo, target) {
  plainDirectory(repo, 'Git 配置源码目录');
  runGit(repo, ['rev-parse', '--show-toplevel'], 'Git 仓库检查', 'utf8');
  const bytes = runGit(repo, ['cat-file', 'blob', `${target.sourceCommit}:${CONFIG_PATH}`], '配置 blob 读取');
  if (!Buffer.isBuffer(bytes) || !bytes.length) fail(`配置 blob 为空：${target.id}`, 'ERR_BETA_CORE_CONFIG_SOURCE');
  const actual = sha256(bytes);
  const expected = target.id === '0.5-dline13'
    ? 'e53c9aab059f5b31d83937206b04ae618cc4308b9d9189e45c21b21f5f164923'
    : 'f12d6665fe9186bac9a6893b728754cf04cebd9f02cfd7494bb672dbee2f7449';
  if (actual !== expected) fail(`配置 blob 哈希不匹配：${target.id}`, 'ERR_BETA_CORE_CONFIG_SOURCE');
  const text = bytes.toString('utf8');
  for (const marker of target.configMarkers) if (!text.includes(marker)) fail(`配置 blob 不符合版本标记：${target.id} / ${marker}`, 'ERR_BETA_CORE_CONFIG_SOURCE');
  for (const marker of target.configForbidden) if (text.includes(marker)) fail(`配置 blob 混入其它版本标记：${target.id} / ${marker}`, 'ERR_BETA_CORE_CONFIG_SOURCE');
  return { bytes, sha256: actual, bytesLength: bytes.length, markers: target.configMarkers };
}

async function verifyCandidate(zipFile, target) {
  plainFile(zipFile, `${target.id} ZIP`);
  const zipBytes = fs.readFileSync(zipFile);
  const zipSha256 = sha256(zipBytes);
  if (zipSha256 !== target.sourceZipSha256) fail(`ZIP 哈希不匹配：${target.id}`, 'ERR_BETA_CORE_ZIP_HASH');
  const entries = await readZipEntries(zipFile);
  let addon;
  let bridge;
  if (target.manifestKind === 'standard') {
    const manifest = jsonEntry(entries, 'ota-manifest.json');
    if (manifest.schema !== 'nr-branch-ota-v1' || manifest.version !== 'beta0.5-dline13' || manifest.display_version !== '0.5 D13' ||
        manifest.api !== target.api || manifest.includesDx11 !== false || manifest.sourceCommit !== target.sourceCommit ||
        manifest.packaging_commit !== target.packagingCommit || manifest.core_pe_version !== target.corePeVersion || manifest.sourceDirty !== false) {
      fail(`0.5 D13 manifest 身份不匹配`, 'ERR_BETA_CORE_ZIP_METADATA');
    }
    verifyManifestRows(entries, manifest);
    exactEntrySet(entries, [...manifest.files.map(row => row.name), 'ota-manifest.json']);
    addon = entryBytes(entries, target.sourceAddonName, target.sourceAddonSha256, 6869504);
    bridge = entryBytes(entries, 'nrchain_nvngx.dll', target.bridgeSha256, 8192);
  } else {
    const buildInfo = jsonEntry(entries, 'build-info.json');
    const hashes = jsonEntry(entries, 'SHA256.json');
    if (buildInfo.schema !== 'nr050-core-only-acceptance-v1' || buildInfo.version !== '0.4.7beta-corefix.8' ||
        buildInfo.source_commit !== target.sourceCommit || buildInfo.packaging_commit !== target.packagingCommit ||
        buildInfo.language !== 'zh-CN' || buildInfo.scope !== 'D3D12 Core-only manual acceptance; not Manager/multi-API OTA' ||
        buildInfo.carrier_included !== false || buildInfo.ini_included !== false || buildInfo.vendor_runtime_included !== false ||
        buildInfo.source_manifest_sha256 !== target.sourceManifestSha256 || buildInfo.validation_sha256 !== target.validationSha256) {
      fail('Corefix8 build-info 身份不匹配', 'ERR_BETA_CORE_ZIP_METADATA');
    }
    const expectedNames = [target.sourceAddonName, 'nrchain_nvngx.dll', 'README.zh-CN.md', 'README.en.md', 'LICENSES.txt', 'build-info.json', 'SHA256.json'];
    exactEntrySet(entries, expectedNames);
    const hashNames = Object.keys(hashes).sort();
    const expectedHashNames = expectedNames.filter(name => name !== 'SHA256.json').sort();
    if (JSON.stringify(hashNames) !== JSON.stringify(expectedHashNames)) fail('Corefix8 SHA256.json 文件集合不匹配', 'ERR_BETA_CORE_ZIP_METADATA');
    for (const name of expectedHashNames) entryBytes(entries, name, hashes[name]);
    addon = entryBytes(entries, target.sourceAddonName, target.sourceAddonSha256, 3241472);
    bridge = entryBytes(entries, 'nrchain_nvngx.dll', target.bridgeSha256, 8192);
    if ([...entries.keys()].some(name => /carrier|\.ini$/i.test(name))) fail('Corefix8 不得带 carrier 或 INI', 'ERR_BETA_CORE_ZIP_CONTENT');
  }
  if ([...entries.keys()].some(name => name.toLowerCase().includes('carrier'))) fail(`${target.id} 不得带 carrier`, 'ERR_BETA_CORE_ZIP_CONTENT');
  return { zipSha256, zipBytes: zipBytes.length, addon, bridge, addonSha256: sha256(addon), bridgeSha256: sha256(bridge), entries: [...entries.keys()] };
}

function expectedEntry(target, artifact, config) {
  const files = {
    [PAYLOAD_FILES.addon]: target.sourceAddonSha256,
    [PAYLOAD_FILES.bridge]: target.bridgeSha256,
    [PAYLOAD_FILES.config]: config.sha256
  };
  const provenance = {
    schema: 'beta-core-catalog-receipt-v1',
    sourceZip: target.sourceZipName,
    sourceZipSha256: target.sourceZipSha256,
    sourceCommit: target.sourceCommit,
    packagingCommit: target.packagingCommit,
    sourceAddonName: target.sourceAddonName,
    sourceZipBytes: artifact.zipBytes,
    sourceAddonSha256: target.sourceAddonSha256,
    sourceAddonBytes: artifact.addon.length,
    bridgeSha256: target.bridgeSha256,
    bridgeBytes: artifact.bridge.length,
    configSourceCommit: target.sourceCommit,
    configSourcePath: CONFIG_PATH,
    configBytes: config.bytesLength,
    configSha256: config.sha256,
    api: target.api,
    corePeVersion: target.corePeVersion,
    validationSha256: target.validationSha256,
    ...(target.inputPackageSha256 ? { inputPackageSha256: target.inputPackageSha256 } : {}),
    ...(target.sourceManifestSha256 ? { sourceManifestSha256: target.sourceManifestSha256 } : {})
  };
  return {
    label: target.label,
    notes: '仅供已安装的 D3D12 游戏更新 Core 与配套 chain；保留现有 INI；本候选未完成游戏实测，不用于新安装。',
    source: `${target.sourceCommit} / ${target.sourceZipSha256}`,
    compatibility: null,
    comparisonOnly: false,
    coreUpdateOnly: true,
    ota: true,
    api: target.api,
    corePeVersion: target.corePeVersion,
    carrierIncluded: false,
    files,
    provenance
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function inspectSlot(slot, expected) {
  if (!fs.existsSync(slot)) return 'missing';
  const stat = fs.lstatSync(slot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`目标槽位不是普通目录：${slot}`, 'ERR_BETA_CORE_SLOT_CONFLICT');
  const expectedFiles = new Set([...Object.keys(expected.files), 'core-import-receipt.json']);
  const names = fs.readdirSync(slot).sort();
  if (!sameJson(names, [...expectedFiles].sort())) fail(`目标槽位文件集合冲突：${slot}`, 'ERR_BETA_CORE_SLOT_CONFLICT');
  for (const name of expectedFiles) {
    const file = path.join(slot, name);
    const fileStat = fs.lstatSync(file);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) fail(`目标槽位文件不安全：${file}`, 'ERR_BETA_CORE_SLOT_CONFLICT');
  }
  const receipt = JSON.parse(fs.readFileSync(path.join(slot, 'core-import-receipt.json'), 'utf8'));
  if (!sameJson(receipt, { id: path.basename(slot), ...expected.provenance, files: expected.files })) fail(`目标槽位 receipt 冲突：${slot}`, 'ERR_BETA_CORE_SLOT_CONFLICT');
  for (const [name, digest] of Object.entries(expected.files)) {
    if (sha256(fs.readFileSync(path.join(slot, name))) !== digest) fail(`目标槽位字节冲突：${slot}/${name}`, 'ERR_BETA_CORE_SLOT_CONFLICT');
  }
  return 'same';
}

function validateExistingEntry(id, actual, expected) {
  if (!actual) return 'missing';
  if (!actual || typeof actual !== 'object' || !sameJson(actual, expected)) fail(`catalog entry 冲突：${id}`, 'ERR_BETA_CORE_SLOT_CONFLICT');
  return 'same';
}

function writeSlot(slot, target, artifact, config, expected) {
  fs.mkdirSync(path.dirname(slot), { recursive: true });
  const temp = path.join(path.dirname(slot), `.${target.id}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  fs.mkdirSync(temp);
  try {
    fs.writeFileSync(path.join(temp, PAYLOAD_FILES.addon), artifact.addon, { flag: 'wx' });
    fs.writeFileSync(path.join(temp, PAYLOAD_FILES.bridge), artifact.bridge, { flag: 'wx' });
    fs.writeFileSync(path.join(temp, PAYLOAD_FILES.config), config.bytes, { flag: 'wx' });
    fs.writeFileSync(path.join(temp, 'core-import-receipt.json'), `${JSON.stringify({ id: target.id, ...expected.provenance, files: expected.files }, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' });
    if (fs.existsSync(slot)) fail(`目标槽位在写入期间出现冲突：${slot}`, 'ERR_BETA_CORE_SLOT_CONFLICT');
    fs.renameSync(temp, slot);
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

function writeCatalog(bundlePath, originalRaw, bundle) {
  const temp = `${bundlePath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const nextRaw = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  try {
    fs.writeFileSync(temp, nextRaw, { flag: 'wx' });
    const currentRaw = fs.readFileSync(bundlePath);
    if (!currentRaw.equals(originalRaw)) fail('catalog 在发布前已改变，拒绝覆盖', 'ERR_BETA_CORE_CATALOG_CONFLICT');
    fs.renameSync(temp, bundlePath);
  } catch (error) {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
    throw error;
  }
}

async function prepareBeta7CoreCatalog({ dline13Zip, corefix8Zip, repoPath, payloadRoot = path.resolve(__dirname, '../payload/nr-before-sr') }) {
  const inputs = { dline13Zip, corefix8Zip, repoPath, payloadRoot };
  for (const target of TARGETS) if (typeof inputs[target.arg] !== 'string') fail(`缺少输入：${target.arg}`, 'ERR_BETA_CORE_INPUT');
  plainDirectory(payloadRoot, 'payload 根目录');
  plainDirectory(path.join(payloadRoot, 'versions'), 'payload versions 目录');
  const bundlePath = path.join(payloadRoot, 'bundle.json');
  plainFile(bundlePath, 'bundle.json');
  const originalRaw = fs.readFileSync(bundlePath);
  let bundle;
  try { bundle = JSON.parse(originalRaw.toString('utf8')); } catch { fail('bundle.json 不是有效 JSON', 'ERR_BETA_CORE_CATALOG'); }
  if (bundle.version !== 4 || !bundle.versions || Array.isArray(bundle.versions)) fail('需要已有 compact v4 bundle.json', 'ERR_BETA_CORE_CATALOG');
  const originalDefault = bundle.defaultVersion;

  const artifacts = [];
  const configs = [];
  const expectedEntries = [];
  for (const target of TARGETS) {
    const artifact = await verifyCandidate(path.resolve(inputs[target.arg]), target);
    const config = readConfigBlob(path.resolve(repoPath), target);
    const expected = expectedEntry(target, artifact, config);
    artifacts.push(artifact); configs.push(config); expectedEntries.push(expected);
  }

  const plans = TARGETS.map((target, index) => {
    const id = target.id;
    const existingEntry = Object.hasOwn(bundle.versions, id) ? bundle.versions[id] : null;
    const entryState = validateExistingEntry(id, existingEntry, expectedEntries[index]);
    const slot = path.join(payloadRoot, 'versions', id);
    const slotState = inspectSlot(slot, expectedEntries[index]);
    if ((entryState === 'same') !== (slotState === 'same')) fail(`catalog 与槽位状态不一致：${id}`, 'ERR_BETA_CORE_SLOT_CONFLICT');
    return { target, index, slot, entryState, slotState };
  });

  if (bundle.defaultVersion !== originalDefault) fail('defaultVersion 被意外改变', 'ERR_BETA_CORE_CATALOG');
  const newBundle = structuredClone(bundle);
  for (const plan of plans) if (plan.entryState === 'missing') newBundle.versions[plan.target.id] = expectedEntries[plan.index];
  if (newBundle.defaultVersion !== originalDefault) fail('不允许改变 defaultVersion', 'ERR_BETA_CORE_CATALOG');
  const createdSlots = [];
  try {
    for (const plan of plans) if (plan.slotState === 'missing') {
      writeSlot(plan.slot, plan.target, artifacts[plan.index], configs[plan.index], expectedEntries[plan.index]);
      createdSlots.push(plan.slot);
    }
    if (!Buffer.from(JSON.stringify(newBundle, null, 2) + '\n').equals(originalRaw)) writeCatalog(bundlePath, originalRaw, newBundle);
  } catch (error) {
    for (const slot of createdSlots) fs.rmSync(slot, { recursive: true, force: true });
    throw error;
  }
  return { bundle: newBundle, ids: TARGETS.map(target => target.id), defaultVersion: originalDefault, changed: createdSlots.length > 0 || !Buffer.from(JSON.stringify(newBundle, null, 2) + '\n').equals(originalRaw) };
}

function parseArgs(argv) {
  if (argv.length === 3) return { dline13Zip: argv[0], corefix8Zip: argv[1], repoPath: argv[2] };
  const values = {};
  const aliases = {
    '--dline13-zip': 'dline13Zip', '--dline13': 'dline13Zip',
    '--corefix8-zip': 'corefix8Zip', '--corefix8': 'corefix8Zip',
    '--repo': 'repoPath', '--git-repo': 'repoPath', '--payload': 'payloadRoot'
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!Object.hasOwn(aliases, key) || typeof value !== 'string') fail('用法：prepare-beta7-core-catalog.js <D13.zip> <Corefix8.zip> <gitrepo> 或 --dline13-zip ZIP --corefix8-zip ZIP --repo GITREPO [--payload PAYLOAD_ROOT]', 'ERR_BETA_CORE_INPUT');
    values[aliases[key]] = value;
  }
  return values;
}

async function main(argv = process.argv.slice(2)) {
  const result = await prepareBeta7CoreCatalog(parseArgs(argv));
  console.log(`已准备 ${result.ids.join('、')}；默认版本保持 ${result.defaultVersion}。`);
  return result;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { TARGETS, CONFIG_PATH, readZipEntries, prepareBeta7CoreCatalog, readConfigBlob, sha256 };
