'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { noLinks, inside } = require('./launch-safety');
const { hashRegularFile, deploymentHashLimit } = require('./streamed-file-digest');
const packageLock = require('./feeder-package-lock');
const peDefault = require('../core/pe');

const DIRECTORY = '_DLSS5_Feeder';
const RECEIPT = '_DLSS5_Backup/xiaofeng-feeder.json';
const HASH = /^[a-f0-9]{64}$/;
const PE = /\.(?:dll|exe|asi|addon64|addon32)$/i;
const fail = (code, message, details) => { throw Object.assign(new Error(message), { code, details }); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function relative(value) {
  if (typeof value !== 'string' || !value || value.length > 220 || path.isAbsolute(value) || /[\0<>:"|?*]/.test(value)) return null;
  const parts = value.split(/[\\/]/);
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return null;
  return parts.join('/');
}
function regularJson(file, max = 256 * 1024) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > max) fail('FEEDER_RECORD_INVALID', 'Feeder 清单或收据不是安全的普通文件。');
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { fail('FEEDER_RECORD_INVALID', 'Feeder 清单或收据无法读取，请保留文件后恢复。'); }
}
function validateRecipe(recipe, lock = packageLock) {
  if (!recipe || recipe.version !== 1 || recipe.id !== lock.id || recipe.route !== 'feeder-dx12' || recipe.architecture !== 64 ||
      recipe.api !== 'dx12' || recipe.hardwareFamily !== 'RTX50' || recipe.provenance !== 'Synthetic' || recipe.scope !== 'post-process' ||
      recipe.colorContract !== 'rgba8-srgb-confirmed' || recipe.coreVersion !== '0.4.7beta' || !HASH.test(lock.recipeFingerprint || '') ||
      fingerprint(recipe) !== lock.recipeFingerprint || !Array.isArray(recipe.files) || recipe.files.length < 6 || recipe.files.length > 64)
    fail('FEEDER_PACKAGE_UNTRUSTED', 'Feeder 配套身份未锁定或与管理器固定清单不符。');
  const targets = new Set(), roles = new Map(); let total = 0;
  for (const file of recipe.files) {
    const source = relative(file?.source), target = relative(file?.target);
    if (!source || !target || source !== target || !HASH.test(file.sha256 || '') || typeof file.mutable !== 'boolean' ||
        !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > 512 * 1024 * 1024 || typeof file.role !== 'string' ||
        !['dxgi.dll', 'ReShade.ini'].includes(target) && !target.startsWith(DIRECTORY + '/') ||
        targets.has(target.toLowerCase()) || file.mutable && PE.test(target))
      fail('FEEDER_RECIPE_INVALID', 'Feeder 配套的路径、角色、大小或摘要无效。');
    targets.add(target.toLowerCase()); roles.set(file.role, (roles.get(file.role) || 0) + 1); total += file.bytes;
  }
  if (total > 768 * 1024 * 1024 || ['loader', 'core', 'provider', 'chain', 'nr-runtime', 'core-config', 'feeder-config', 'reshade-config', 'preset'].some(role => roles.get(role) !== 1))
    fail('FEEDER_RECIPE_INVALID', 'Feeder 固定配套缺少唯一的必要组件。');
  return recipe;
}
async function fileDigest(file) {
  // Game identities and component payloads have different size budgets.
  // Recipe per-file/total limits below remain unchanged.
  return hashRegularFile(file, { assertPath: noLinks, maxBytes: deploymentHashLimit(file),
    fail: (code, message, details) => fail(code === 'FILE_TOO_LARGE' ? 'FEEDER_FILE_TOO_LARGE' : 'FEEDER_FILE_CHANGED',
      message, { ...details, file: path.basename(file) }) });
}
function resolveFile(root, target) {
  if (!relative(target)) fail('FEEDER_PATH_INVALID', 'Feeder 文件路径无效。');
  const file = path.resolve(root, target);
  if (!inside(root, file)) fail('FEEDER_PATH_INVALID', 'Feeder 文件超出所选目录。');
  return file;
}
function createFeederRuntime(options = {}) {
  const lock = options.lock || packageLock, pe = options.pe || peDefault;
  const folder = options.resourcesPath && fs.existsSync(path.join(options.resourcesPath, 'feeder-runtime', 'recipe.json'))
    ? path.join(options.resourcesPath, 'feeder-runtime') : path.join(options.appDir, 'resources', 'feeder-runtime');
  function load() {
    const recipe = regularJson(path.join(folder, 'recipe.json'));
    if (!recipe) fail('FEEDER_PACKAGE_MISSING', '无 DLSS 的 DX12 Feeder 固定配套尚未准备。');
    validateRecipe(recipe, lock);
    return { recipe, root: folder, fingerprint: lock.recipeFingerprint };
  }
  async function verify(input = load()) {
    await noLinks(input.root);
    for (const spec of input.recipe.files) {
      const file = resolveFile(input.root, spec.source);
      if (await fileDigest(file) !== spec.sha256 || (await fsp.stat(file)).size !== spec.bytes)
        fail('FEEDER_PACKAGE_HASH', 'Feeder 配套文件缺失或校验不符。', { file: spec.source });
      if (PE.test(spec.source) && pe.getBitness(file) !== 64) fail('FEEDER_PACKAGE_ARCH', 'Feeder 首批配套必须全部为 x64。', { file: spec.source });
    }
    return input;
  }
  function validate(receiptRecipe) {
    const observed = fingerprint(receiptRecipe);
    // Historical, code-pinned receipts remain restorable. Package loading and
    // new installation still require the current fingerprint above.
    const previous = lock.restorableRecipeFingerprints?.includes(observed) === true;
    return validateRecipe(receiptRecipe, previous ? { ...lock, recipeFingerprint: observed } : lock);
  }
  return { load, verify, validate, lock };
}

module.exports = { DIRECTORY, RECEIPT, HASH, PE, relative, regularJson, fingerprint, resolveFile, fileDigest, same, sha, fail, validateRecipe, createFeederRuntime };
