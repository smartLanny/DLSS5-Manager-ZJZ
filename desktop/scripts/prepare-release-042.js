'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yauzl = require('yauzl');
const { sha256 } = require('../src/product/payload');

const ROOT = path.resolve(__dirname, '..', 'payload', 'nr-before-sr');
const SOURCE = '15909ef10914fcdf151ee193460451667fbf31dc';
const BRIDGE_HASH = '46041a5ff91ae2fd907e310d132aabc3c4a1ecd48dace511b8672909d5d9c2fb';
const CORE_NAME = 'DLSS5-AI渲染超分版-beta0.4.2-@野生的装机宅-Bilibili.addon64';
const EXPERIMENTAL_CARRIER = 'dlss5-native-carrier-exp1.addon64';
const ARCHIVE_SHA256 = Object.freeze({
  'RTX30-40': 'ef3923940976b34ddc27c084fadb33958b87d6bd30566bf4277fa4ca26750fde',
  RTX50: 'bc9f9dda020d7f5a01e13f7fe46b35e2e70b239426f0adc4e52fe2fc2d091bc5'
});
const FILES = Object.freeze({
  addon: Object.freeze({
    zipName: CORE_NAME,
    targetName: 'nr-before-sr.zh-CN.addon64',
    hash: 'ccd7f1d8cd95a8559e5a629d3206bf586777173aa2309722202ec1a0a0b2d1e2',
    bytes: 1134592
  }),
  config: Object.freeze({
    zipName: 'nr_before_sr.ini',
    targetName: 'nr_before_sr.ini',
    hash: '6bf321c7d948d044907b8692bae74b85c43087d3eb3c0bbd97d2e1dcaf43743d',
    bytes: 2424
  }),
  bridge: Object.freeze({
    zipName: 'nrchain_nvngx.dll',
    targetName: null,
    hash: BRIDGE_HASH,
    bytes: 8192
  })
});
const ENTRY = Object.freeze({
  id: '0.4.2',
  label: '0.4.2（Beta · D3D12）',
  source: `beta0.4.2@${SOURCE}`,
  compatibility: null,
  ota: false,
  notes: '历史 Beta 中文核心；原生 D3D12 路线，使用固定 nrchain。普通完整包不含 DX11 carrier，不配旧 native-bridge-exp1 carrier；不支持 Vulkan，真实游戏效果仍需按当前版本实测。'
});

function bundleEntry() {
  return {
    label: ENTRY.label,
    notes: ENTRY.notes,
    source: ENTRY.source,
    compatibility: ENTRY.compatibility,
    ota: ENTRY.ota,
    files: {
      [FILES.addon.targetName]: FILES.addon.hash,
      [FILES.config.targetName]: FILES.config.hash
    }
  };
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readZipEntries(file, wanted) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) {
        reject(error);
        return;
      }
      const entries = new Map();
      let settled = false;
      const fail = err => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(err);
      };
      zip.on('error', fail);
      zip.on('entry', entry => {
        if (!wanted.has(entry.fileName)) {
          zip.readEntry();
          return;
        }
        if (entries.has(entry.fileName)) {
          fail(new Error(`duplicate source ZIP entry: ${entry.fileName}`));
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            fail(streamError);
            return;
          }
          const chunks = [];
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('error', fail);
          stream.on('end', () => {
            if (settled) return;
            entries.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(entries);
      });
      zip.readEntry();
    });
  });
}

function jsonEntry(entries, name) {
  const buffer = entries.get(name);
  assert.ok(buffer, `source ZIP missing ${name}`);
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`invalid ${name}: ${error.message}`);
  }
}

function manifestFile(manifest, name, hash, bytes) {
  const row = Array.isArray(manifest.files) && manifest.files.find(file => file.path === name);
  assert.ok(row, `manifest missing ${name}`);
  assert.equal(String(row.sha256).toLowerCase(), hash, `manifest hash ${name}`);
  assert.equal(Number(row.bytes), bytes, `manifest bytes ${name}`);
}

function releaseFile(manifest, name, hash, bytes) {
  const row = Array.isArray(manifest.files) && manifest.files.find(file => file.path === name);
  assert.ok(row, `release manifest missing ${name}`);
  assert.equal(String(row.sha256).toLowerCase(), hash, `release hash ${name}`);
  assert.equal(Number(row.bytes), bytes, `release bytes ${name}`);
}

async function loadSource(sourceZip) {
  const file = path.resolve(sourceZip);
  assert.ok(fs.existsSync(file) && fs.statSync(file).isFile(), `source ZIP missing: ${file}`);
  const archiveHash = sha256(file);
  const family = Object.keys(ARCHIVE_SHA256).find(key => ARCHIVE_SHA256[key] === archiveHash);
  assert.ok(family, `unreviewed beta0.4.2 source ZIP: ${archiveHash}`);

  const required = new Set([
    CORE_NAME, 'nr_before_sr.ini', 'nrchain_nvngx.dll',
    'manifest.json', 'RELEASE_MANIFEST.json'
  ]);
  const wanted = new Set([...required, EXPERIMENTAL_CARRIER]);
  const entries = await readZipEntries(file, wanted);
  for (const name of required) assert.ok(entries.has(name), `source ZIP missing ${name}`);
  assert.equal(entries.has(EXPERIMENTAL_CARRIER), false, 'ordinary beta0.4.2 must not contain the DX11 experiment carrier');

  const manifest = jsonEntry(entries, 'manifest.json');
  assert.equal(manifest.schema, 'dlss5-install-manifest/v4');
  assert.equal(manifest.build, 'beta0.4.2');
  assert.equal(manifest.payloadSourceCommit, SOURCE);
  assert.equal(String(manifest.gpuFamily), family);
  assert.equal(manifest.language, 'zh-CN');
  assert.equal(manifest.nativeD3D12, true);
  assert.equal(manifest.onlineAllowed, false);

  for (const item of Object.values(FILES)) manifestFile(manifest, item.zipName, item.hash, item.bytes);
  const release = jsonEntry(entries, 'RELEASE_MANIFEST.json');
  assert.equal(release.schema, 'dlss5-release-manifest-v1');
  assert.equal(release.version, 'beta0.4.2');
  assert.equal(release.channel, 'installer');
  for (const item of Object.values(FILES)) releaseFile(release, item.zipName, item.hash, item.bytes);

  const files = {};
  for (const [kind, item] of Object.entries(FILES)) {
    const buffer = entries.get(item.zipName);
    assert.equal(buffer.length, item.bytes, `source bytes ${kind}`);
    assert.equal(hashBuffer(buffer), item.hash, `source hash ${kind}`);
    files[kind] = buffer;
  }
  return { archiveHash, family, files };
}

function assertPlainDirectory(file, label) {
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false, `${label} must not be a symlink`);
  assert.equal(stat.isDirectory(), true, `${label} must be a directory`);
}

function assertPlainFile(file, label) {
  assert.ok(fs.existsSync(file), `${label} missing`);
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false, `${label} must not be a symlink`);
  assert.equal(stat.isFile(), true, `${label} must be a regular file`);
}

function verifyVersion(dir) {
  assertPlainDirectory(dir, '0.4.2 payload');
  const names = fs.readdirSync(dir).sort();
  assert.deepEqual(names, [FILES.addon.targetName, FILES.config.targetName].sort(), '0.4.2 must not carry a bridge or carrier');
  for (const item of [FILES.addon, FILES.config]) {
    const file = path.join(dir, item.targetName);
    assertPlainFile(file, `0.4.2 ${item.targetName}`);
    assert.equal(sha256(file), item.hash, `payload hash ${item.targetName}`);
  }
}

function validateBundle(bundle) {
  assert.equal(bundle.version, 4, 'compact payload bundle required');
  assert.equal(typeof bundle.defaultVersion, 'string', 'compact payload default missing');
  assert.ok(bundle.fixed && bundle.fixed.RTX40 && bundle.fixed.RTX50, 'fixed GPU payload missing');
  for (const family of ['RTX40', 'RTX50']) {
    assert.equal(String(bundle.fixed[family].files['nrchain_nvngx.dll']).toLowerCase(), BRIDGE_HASH, `${family} fixed bridge`);
  }
  assert.ok(bundle.versions && typeof bundle.versions === 'object', 'version map missing');
  assert.ok(bundle.versions[bundle.defaultVersion], 'compact payload default must remain available');
}

function verifyFixedBridge(root, bundle) {
  for (const family of ['RTX40', 'RTX50']) {
    const expected = String(bundle.fixed[family].files['nrchain_nvngx.dll']).toLowerCase();
    assert.equal(expected, BRIDGE_HASH, `${family} fixed bridge manifest`);
    const file = path.join(root, 'fixed', family, 'nrchain_nvngx.dll');
    assertPlainFile(file, `${family} fixed bridge`);
    assert.equal(sha256(file), BRIDGE_HASH, `${family} fixed bridge bytes`);
  }
}

async function prepare(sourceZip, options = {}) {
  const root = path.resolve(options.root || ROOT);
  // Load and validate every source byte before touching the target payload.
  const source = await loadSource(sourceZip);
  const bundleFile = path.join(root, 'bundle.json');
  assert.ok(fs.existsSync(bundleFile), 'payload bundle missing');
  const bundle = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
  validateBundle(bundle);
  const defaultVersion = bundle.defaultVersion;
  verifyFixedBridge(root, bundle);

  const versions = path.join(root, 'versions');
  assertPlainDirectory(root, 'payload root');
  assertPlainDirectory(versions, 'payload versions');
  const target = path.join(versions, ENTRY.id);
  if (fs.existsSync(target)) verifyVersion(target);

  const existing = bundle.versions[ENTRY.id];
  if (existing) assert.deepEqual(existing, bundleEntry(), 'existing 0.4.2 entry differs from the reviewed source');

  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  for (const item of [FILES.addon, FILES.config]) {
    fs.writeFileSync(path.join(target, item.targetName), source.files[item === FILES.addon ? 'addon' : 'config']);
  }
  verifyVersion(target);

  if (!existing) {
    bundle.versions[ENTRY.id] = bundleEntry();
  }
  fs.writeFileSync(bundleFile, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
  const written = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
  validateBundle(written);
  assert.equal(written.defaultVersion, defaultVersion, '0.4.2 preparation changed the default');
  assert.deepEqual(written.versions[ENTRY.id], bundleEntry());
  verifyVersion(target);
  return { archiveHash: source.archiveHash, family: source.family, target };
}

if (require.main === module) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/prepare-release-042.js <reviewed beta0.4.2 Chinese complete ZIP>');
  prepare(path.resolve(process.argv[2]))
    .then(result => console.log(JSON.stringify({ source: SOURCE, ...result })))
    .catch(error => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}

module.exports = { ARCHIVE_SHA256, ENTRY, FILES, SOURCE, loadSource, prepare, verifyVersion };
