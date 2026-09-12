'use strict';

// Prepare the reviewed beta0.3.3-dev-r4 build under its release identity slot.
// The version owns only its addon and INI; the fixed bridge/runtime stay shared.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', 'payload', 'nr-before-sr');
const SOURCE = '9085a4d67e32b8a6c83bc184b80ebe26b59c207d';
const SOURCE_BUILD = 'beta0.3.3-dev-r4';
// Manager's stable slot keeps the release identity from the reviewed package;
// the PE metadata below remains the separate 0.3.3.4 beta-dev file version.
const VERSION = '0.3.3-dev-r4';
const BRIDGE_HASH = '46041a5ff91ae2fd907e310d132aabc3c4a1ecd48dace511b8672909d5d9c2fb';
const RTX40_RUNTIME_HASH = '6eb209e764f39872625debd6abaf45e2bb6322f6f270f781f70c059ae30b3927';
const RTX50_RUNTIME_HASH = 'e16bcf15e16e13f527491cdf7845b2fe6521a738d8f7c9c721866a8496e1fc8e';

const FILES = Object.freeze({
  addon: Object.freeze({
    sourceName: 'DLSS5-AI渲染超分版-beta0.3.3-dev-@野生的装机宅-Bilibili.addon64',
    targetName: 'nr-before-sr.zh-CN.addon64',
    bytes: 652288,
    hash: '2869d7ee12bcb73c4fadc4e2673a7bf3290fd2d90a294b2437e64b72c1bdd9e8'
  }),
  config: Object.freeze({
    sourceName: 'nr_before_sr.ini',
    targetName: 'nr_before_sr.ini',
    bytes: 1406,
    hash: '47e052cc67850c21270884355d96912e4ad4bc796b1f7098105b841967f10452'
  }),
  bridge: Object.freeze({
    sourceName: 'nrchain_nvngx.dll',
    targetName: null,
    bytes: 8192,
    hash: BRIDGE_HASH
  }),
  runtime: Object.freeze({
    sourceName: 'nvngx_dlssnr.dll',
    targetName: null,
    bytes: 165840496,
    hash: RTX50_RUNTIME_HASH
  }),
  readme: Object.freeze({
    sourceName: 'README.md',
    targetName: null,
    bytes: 5386,
    hash: '4d7f49dd4a688fd2ff787ffd2dc73129ba3b73d53c7102091b1cc1fd97f9801a'
  })
});

const ENTRY = Object.freeze({
  id: VERSION,
  label: '0.3.3-dev-r4（稳定兼容）',
  source: `${SOURCE_BUILD}@${SOURCE}`,
  compatibility: null,
  ota: false,
  notes: '真实 PE 版本 0.3.3.4 beta dev r4；中文 D3D12 核心。版本目录只保存 addon 与 INI，nrchain 和显卡对应 NR runtime 复用 fixed；不配 DX11 carrier，不支持 DX11/Vulkan，仍需按当前游戏实测。'
});

const SOURCE_NAMES = Object.freeze(Object.values(FILES).map(file => file.sourceName).sort());
const TARGET_NAMES = Object.freeze([FILES.addon.targetName, FILES.config.targetName].sort());

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function assertPlainDirectory(file, label) {
  assert.ok(fs.existsSync(file), `${label} missing: ${file}`);
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false, `${label} must not be a symlink: ${file}`);
  assert.equal(stat.isDirectory(), true, `${label} must be a directory: ${file}`);
}

function assertPlainFile(file, label) {
  assert.ok(fs.existsSync(file), `${label} missing: ${file}`);
  const stat = fs.lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false, `${label} must not be a symlink: ${file}`);
  assert.equal(stat.isFile(), true, `${label} must be a regular file: ${file}`);
}

function verifyFile(file, expected, label) {
  assertPlainFile(file, label);
  assert.equal(fs.statSync(file).size, expected.bytes, `${label} byte count`);
  assert.equal(sha256(file), expected.hash, `${label} SHA-256`);
}

function sourceDirectory(input) {
  const resolved = path.resolve(input);
  assert.ok(fs.existsSync(resolved), `reviewed r4 source missing: ${resolved}`);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) assert.fail(`reviewed r4 source must not be a symlink: ${resolved}`);
  if (stat.isDirectory()) return resolved;
  assert.ok(stat.isFile() && path.basename(resolved) === FILES.addon.sourceName,
    'source argument must be the reviewed r4 package directory or its exact Chinese addon');
  return path.dirname(resolved);
}

function verifyAddonIdentity(file) {
  const bytes = fs.readFileSync(file);
  const text = `${bytes.toString('utf8')}\n${bytes.toString('utf16le')}`;
  assert.match(text, /0\.3\.3\.4 beta dev r4/, 'addon PE version must identify 0.3.3.4 beta dev r4');
  assert.match(text, /beta0\.3\.3-dev-r4/, 'addon build identity must identify beta0.3.3-dev-r4');
}

function loadSource(input) {
  const dir = sourceDirectory(input);
  assertPlainDirectory(dir, 'reviewed r4 source directory');
  assert.deepEqual(fs.readdirSync(dir).sort(), SOURCE_NAMES, 'reviewed r4 package must contain exactly the five frozen files');
  const paths = Object.fromEntries(Object.entries(FILES).map(([kind, file]) => [kind, path.join(dir, file.sourceName)]));
  for (const [kind, file] of Object.entries(FILES)) verifyFile(paths[kind], file, `r4 ${kind}`);
  verifyAddonIdentity(paths.addon);
  return {
    dir,
    addon: fs.readFileSync(paths.addon),
    config: fs.readFileSync(paths.config),
    hashes: Object.fromEntries(Object.entries(paths).map(([kind, file]) => [kind, sha256(file)]))
  };
}

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

function validateBundle(bundle) {
  assert.equal(bundle && bundle.version, 4, 'compact payload bundle required');
  assert.equal(typeof bundle.defaultVersion, 'string', 'compact payload default missing');
  assert.ok(bundle.versions && typeof bundle.versions === 'object' && !Array.isArray(bundle.versions), 'version map missing');
  assert.ok(bundle.versions[bundle.defaultVersion], 'compact payload default must remain available');
  assert.ok(bundle.fixed?.RTX40?.files && bundle.fixed?.RTX50?.files, 'fixed GPU payload missing');
  return bundle;
}

function verifyFixed(root, bundle) {
  for (const family of ['RTX40', 'RTX50']) {
    const dir = path.join(root, 'fixed', family);
    assertPlainDirectory(dir, `${family} fixed payload`);
    assert.equal(String(bundle.fixed[family].files['nrchain_nvngx.dll']).toLowerCase(), BRIDGE_HASH, `${family} fixed bridge manifest`);
    verifyFile(path.join(dir, 'nrchain_nvngx.dll'), FILES.bridge, `${family} fixed bridge`);
  }
  const rtx40 = path.join(root, 'fixed', 'RTX40', 'nvngx_dlssnr.dll');
  const rtx50 = path.join(root, 'fixed', 'RTX50', 'nvngx_dlssnr.dll');
  assert.equal(String(bundle.fixed.RTX40.files['nvngx_dlssnr.dll']).toLowerCase(), RTX40_RUNTIME_HASH, 'RTX40 fixed runtime manifest');
  assert.equal(String(bundle.fixed.RTX50.files['nvngx_dlssnr.dll']).toLowerCase(), RTX50_RUNTIME_HASH, 'RTX50 fixed runtime manifest');
  verifyFile(rtx40, { ...FILES.runtime, hash: RTX40_RUNTIME_HASH, bytes: 165830144 }, 'RTX40 fixed runtime');
  verifyFile(rtx50, FILES.runtime, 'RTX50 fixed runtime');
}

function verifyVersion(dir) {
  assertPlainDirectory(dir, `${VERSION} payload`);
  assert.deepEqual(fs.readdirSync(dir).sort(), TARGET_NAMES, `${VERSION} must contain only addon and INI`);
  verifyFile(path.join(dir, FILES.addon.targetName), FILES.addon, `${VERSION} addon`);
  verifyFile(path.join(dir, FILES.config.targetName), FILES.config, `${VERSION} INI`);
}

function prepare(input, options = {}) {
  const root = path.resolve(options.root || ROOT);
  // Validate every source byte and the shared fixed pair before touching target files.
  const source = loadSource(input);
  const bundleFile = path.join(root, 'bundle.json');
  assertPlainDirectory(root, 'payload root');
  assertPlainFile(bundleFile, 'payload bundle');
  const bundle = validateBundle(JSON.parse(fs.readFileSync(bundleFile, 'utf8')));
  const defaultVersion = bundle.defaultVersion;
  verifyFixed(root, bundle);
  const versions = path.join(root, 'versions');
  assertPlainDirectory(versions, 'payload versions');
  const target = path.join(versions, ENTRY.id);
  if (fs.existsSync(target)) verifyVersion(target);
  const existing = bundle.versions[ENTRY.id];
  if (existing) assert.deepEqual(existing, bundleEntry(), `existing ${VERSION} entry differs from reviewed r4 source`);

  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, FILES.addon.targetName), source.addon);
  fs.writeFileSync(path.join(target, FILES.config.targetName), source.config);
  verifyVersion(target);

  if (!existing) bundle.versions[ENTRY.id] = bundleEntry();
  fs.writeFileSync(bundleFile, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
  const written = validateBundle(JSON.parse(fs.readFileSync(bundleFile, 'utf8')));
  assert.equal(written.defaultVersion, defaultVersion, 'r4 preparation changed the default version');
  assert.deepEqual(written.versions[ENTRY.id], bundleEntry());
  verifyVersion(target);
  return { source: SOURCE, sourceBuild: SOURCE_BUILD, target, defaultVersion };
}

if (require.main === module) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/prepare-release-033r4.js <reviewed r4 package directory or exact Chinese addon>');
  try { console.log(JSON.stringify(prepare(path.resolve(process.argv[2])))); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = {
  ENTRY, FILES, ROOT, SOURCE, SOURCE_BUILD, VERSION,
  bundleEntry, loadSource, prepare, verifyVersion, validateBundle
};
