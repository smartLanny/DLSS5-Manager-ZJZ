'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createVulkanRuntimeProfile } = require('../src/product/vulkan-runtime-profile');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-vulkan-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = path.join(root, 'user'), packageRoot = path.join(root, 'package'), game = path.join(root, 'game');
  fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true }); fs.mkdirSync(game);
  const exe = path.join(game, 'Game.exe'); fs.writeFileSync(exe, 'pe64-game');
  const contents = { 'bin/ReShade64.dll': 'pe64-runtime', 'ReShade.ini': '[INSTALL]\nBasePath=.\n', 'Addons/provider.addon64': 'pe64-addon' };
  for (const [rel, body] of Object.entries(contents)) { const file = path.join(packageRoot, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); }
  const recipe = {
    version: 1, id: 'nr-vulkan-external-e7df0fc', coreVersion: '0.4.6-hotfix.1-vulkan-provider', sourceRevision: 'e7df0fc', architecture: 64,
    files: [
      { source: 'bin/ReShade64.dll', target: 'ReShade64.dll', sha256: hash(contents['bin/ReShade64.dll']), mutable: false },
      { source: 'ReShade.ini', target: 'ReShade.ini', sha256: hash(contents['ReShade.ini']), mutable: true },
      { source: 'Addons/provider.addon64', target: 'Addons/provider.addon64', sha256: hash(contents['Addons/provider.addon64']), mutable: false }
    ]
  };
  const pe = { getBitness(file) { return fs.readFileSync(file, 'utf8').startsWith('pe64') ? 64 : 32; } };
  const service = createVulkanRuntimeProfile({ userData, pe, ...options });
  return { root, userData, packageRoot, game, exe, recipe, service, contents };
}

test('prepare atomically publishes an EXE/package-bound external profile and mutable config may change', async t => {
  const f = fixture(t);
  const predicted = f.service.location({ exe: f.exe, recipe: f.recipe });
  assert.equal(fs.existsSync(f.service.runtimeRoot), false, 'location is synchronous calculation only');
  const absent = await f.service.inspect({ exe: f.exe, recipe: f.recipe });
  assert.deepEqual({ ready: absent.ready, basePath: absent.basePath, coreVersion: absent.coreVersion, packageId: absent.packageId, blockers: absent.blockers },
    { ready: false, basePath: predicted.basePath, coreVersion: f.recipe.coreVersion, packageId: f.recipe.id, blockers: ['运行资产目录尚未准备。'] });
  const prepared = await f.service.prepare({ exe: f.exe, packageRoot: f.packageRoot, recipe: f.recipe });
  assert.deepEqual({ basePath: prepared.basePath, coreVersion: prepared.coreVersion, packageId: prepared.packageId,
    exeId: prepared.exeId, fingerprint: prepared.fingerprint }, predicted);
  assert.match(path.basename(path.dirname(prepared.basePath)), /^[a-f0-9]{16}$/);
  assert.match(path.basename(prepared.basePath), /^[a-f0-9]{16}$/);
  const receipt = JSON.parse(fs.readFileSync(path.join(prepared.basePath, '.xiaofeng-vulkan-runtime.json')));
  assert.equal(receipt.exeId, hash(path.resolve(f.exe).toLowerCase())); assert.equal(receipt.exeId.length, 64);
  assert.equal(receipt.recipe.fingerprint, predicted.fingerprint); assert.equal(receipt.recipe.fingerprint.length, 64);
  assert.equal(prepared.coreVersion, f.recipe.coreVersion);
  assert.equal(prepared.packageId, f.recipe.id);
  assert.equal(prepared.reused, false);
  assert.equal(path.dirname(path.dirname(prepared.basePath)), f.service.runtimeRoot);
  assert.equal(fs.existsSync(path.join(prepared.basePath, 'ReShade64.dll')), true);
  assert.equal(fs.existsSync(path.join(f.game, 'ReShade64.dll')), false);
  assert.match(fs.readFileSync(path.join(prepared.basePath, 'ReShade.ini'), 'utf8'), /KeyOverlay=36,0,0,0/);
  assert.equal(fs.readFileSync(path.join(f.packageRoot, 'ReShade.ini'), 'utf8'), f.contents['ReShade.ini'], 'the pinned source template stays unchanged');

  fs.writeFileSync(path.join(prepared.basePath, 'ReShade.ini'), '[INSTALL]\nBasePath=user-choice\n');
  const inspected = await f.service.inspect({ exe: f.exe, basePath: prepared.basePath });
  assert.equal(inspected.ready, true);
  assert.equal(inspected.files.find(row => row.target === 'ReShade.ini').valid, true);

  const reused = await f.service.prepare({ exe: f.exe, packageRoot: f.packageRoot, recipe: f.recipe });
  assert.equal(reused.reused, true);
  assert.match(fs.readFileSync(path.join(prepared.basePath, 'ReShade.ini'), 'utf8'), /user-choice/);
});

test('Vulkan first-install preview hashes the Home default and respects an explicit source key or existing user key', async t => {
  for (const custom of [false, true]) {
    const f = fixture(t);
    if (custom) {
      const text = f.contents['ReShade.ini'] + '[INPUT]\nKeyOverlay=120,1,0,1\n';
      fs.writeFileSync(path.join(f.packageRoot, 'ReShade.ini'), text);
      f.recipe.files.find(row => row.target === 'ReShade.ini').sha256 = hash(text);
    }
    const preview = await f.service.previewPrepare({ exe: f.exe, packageRoot: f.packageRoot, recipe: f.recipe });
    const proposed = preview.changes.find(row => row.name === 'ReShade.ini');
    assert.equal(fs.existsSync(proposed.path), false);
    const installed = await f.service.prepare({ exe: f.exe, packageRoot: f.packageRoot, recipe: f.recipe });
    const ini = path.join(installed.basePath, 'ReShade.ini'), bytes = fs.readFileSync(ini);
    assert.equal(hash(bytes), proposed.afterSha256);
    assert.match(bytes.toString(), custom ? /KeyOverlay=120,1,0,1/ : /KeyOverlay=36,0,0,0/);
    const personal = '[INPUT]\nKeyOverlay=36,0,1,0\n'; fs.writeFileSync(ini, personal);
    const reused = await f.service.previewPrepare({ exe: f.exe, packageRoot: f.packageRoot, recipe: f.recipe });
    assert.equal(reused.changes.find(row => row.name === 'ReShade.ini').afterSha256, hash(personal));
    await f.service.prepare({ exe: f.exe, packageRoot: f.packageRoot, recipe: f.recipe });
    assert.equal(fs.readFileSync(ini, 'utf8'), personal);
  }
});

test('inspect rejects immutable drift and prepare does not overwrite the changed installed file', async t => {
  const f = fixture(t), prepared = await f.service.prepare({ exe: f.exe, packageRoot: f.packageRoot, recipe: f.recipe });
  const runtime = path.join(prepared.basePath, 'ReShade64.dll'); fs.writeFileSync(runtime, 'pe64-external-change');
  const inspected = await f.service.inspect({ exe: f.exe, recipe: f.recipe });
  assert.equal(inspected.ready, false); assert.match(inspected.blockers.join(' '), /摘要/);
  await assert.rejects(f.service.prepare({ exe: f.exe, packageRoot: f.packageRoot, recipe: f.recipe }), { code: 'VULKAN_RUNTIME_CHANGED' });
  assert.equal(fs.readFileSync(runtime, 'utf8'), 'pe64-external-change');
});

test('archive moves the complete bound profile without deleting mutable user config', async t => {
  const f = fixture(t), prepared = await f.service.prepare({ exe: f.exe, packageRoot: f.packageRoot, recipe: f.recipe });
  const config = path.join(prepared.basePath, 'ReShade.ini'); fs.writeFileSync(config, 'user runtime state');
  const result = await f.service.archive({ exe: f.exe, basePath: prepared.basePath });
  assert.equal(result.archived, true); assert.equal(fs.existsSync(prepared.basePath), false);
  assert.equal(fs.readFileSync(path.join(result.archivePath, 'ReShade.ini'), 'utf8'), 'user runtime state');
  assert.equal(fs.existsSync(path.join(result.archivePath, 'Addons/provider.addon64')), true);
});

test('EXE and package identity prevent cross-game inspection or archive', async t => {
  const f = fixture(t), prepared = await f.service.prepare({ exe: f.exe, packageRoot: f.packageRoot, recipe: f.recipe });
  const other = path.join(f.game, 'Other.exe'); fs.writeFileSync(other, 'pe64-other');
  await assert.rejects(f.service.inspect({ exe: other, basePath: prepared.basePath }), { code: 'VULKAN_RUNTIME_PATH_INVALID' });
  await assert.rejects(f.service.archive({ exe: other, basePath: prepared.basePath }), { code: 'VULKAN_RUNTIME_PATH_INVALID' });
  assert.equal(fs.existsSync(prepared.basePath), true);
  const changedRecipe = { ...f.recipe, coreVersion: '0.4.6-hotfix.2' };
  await assert.rejects(f.service.inspect({ exe: f.exe, basePath: prepared.basePath, recipe: changedRecipe }), { code: 'VULKAN_RUNTIME_PACKAGE_CHANGED' });
});

test('recipe traversal, source links, bad hashes and x86 binaries fail before publication', async t => {
  const f = fixture(t);
  assert.throws(() => f.service.location({ exe: f.exe, recipe: { ...f.recipe, sourceRevision: 'unknown' } }), { code: 'VULKAN_RUNTIME_RECIPE_INVALID' });
  await assert.rejects(f.service.prepare({ exe: f.exe, packageRoot: f.packageRoot, recipe: { ...f.recipe, files: [{ ...f.recipe.files[0], target: '../escape.dll' }] } }), { code: 'VULKAN_RUNTIME_RECIPE_INVALID' });
  await assert.rejects(f.service.prepare({ exe: f.exe, packageRoot: f.packageRoot, recipe: { ...f.recipe, files: [{ ...f.recipe.files[0], sha256: '0'.repeat(64) }] } }), { code: 'VULKAN_RUNTIME_SOURCE_HASH' });
  fs.writeFileSync(path.join(f.packageRoot, 'bin/ReShade64.dll'), 'pe32-runtime');
  const x86Recipe = { ...f.recipe, files: f.recipe.files.map(row => row.source === 'bin/ReShade64.dll' ? { ...row, sha256: hash('pe32-runtime') } : row) };
  await assert.rejects(f.service.prepare({ exe: f.exe, packageRoot: f.packageRoot, recipe: x86Recipe }), { code: 'VULKAN_RUNTIME_ARCH' });
  assert.equal(fs.existsSync(f.service.runtimeRoot) && fs.readdirSync(f.service.runtimeRoot).some(name => !name.startsWith('.')), false);

  fs.writeFileSync(path.join(f.packageRoot, 'hard-source.ini'), 'hard-linked');
  fs.linkSync(path.join(f.packageRoot, 'hard-source.ini'), path.join(f.packageRoot, 'hard.ini'));
  const hardLinked = { ...f.recipe, files: [{ source: 'hard.ini', target: 'hard.ini', sha256: hash('hard-linked'), mutable: true }] };
  await assert.rejects(f.service.prepare({ exe: f.exe, packageRoot: f.packageRoot, recipe: hardLinked }), { code: 'SETTINGS_LINK_BLOCKED' });

  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(f.packageRoot, 'real.ini'), 'linked');
    try {
      fs.symlinkSync(path.join(f.packageRoot, 'real.ini'), path.join(f.packageRoot, 'linked.ini'), 'file');
      const linked = { ...f.recipe, files: [{ source: 'linked.ini', target: 'linked.ini', sha256: hash('linked'), mutable: true }] };
      await assert.rejects(f.service.prepare({ exe: f.exe, packageRoot: f.packageRoot, recipe: linked }), { code: 'SETTINGS_LINK_BLOCKED' });
    } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
  }
});

test('source drift during copy is detected, staged files are removed, and game directory stays untouched', async t => {
  let copied = false;
  const f = fixture(t, { copyFile: async (source, target, flags) => {
    await fsp.copyFile(source, target, flags);
    if (!copied) { copied = true; await fsp.writeFile(source, 'pe64-drifted-source'); }
  } });
  await assert.rejects(f.service.prepare({ exe: f.exe, packageRoot: f.packageRoot, recipe: f.recipe }), { code: 'VULKAN_RUNTIME_SOURCE_CHANGED' });
  const exeRoots = fs.existsSync(f.service.runtimeRoot) ? fs.readdirSync(f.service.runtimeRoot) : [];
  for (const exeRoot of exeRoots) assert.deepEqual(fs.readdirSync(path.join(f.service.runtimeRoot, exeRoot)), []);
  assert.deepEqual(fs.readdirSync(f.game).sort(), ['Game.exe']);
});

function moveToLegacy(f, prepared) {
  const receiptFile = path.join(prepared.basePath, '.xiaofeng-vulkan-runtime.json');
  const receipt = JSON.parse(fs.readFileSync(receiptFile));
  receipt.packageId = `${receipt.recipe.id}-${receipt.recipe.fingerprint.slice(0, 16)}`;
  const basePath = path.join(f.service.runtimeRoot, receipt.exeId, receipt.packageId);
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  fs.mkdirSync(path.dirname(basePath), { recursive: true }); fs.renameSync(prepared.basePath, basePath);
  return { basePath, receipt };
}

test('legacy full IDs remain inspectable and archive keeps edited configs; an overlong legacy profile is restore-only', async t => {
  const f = fixture(t); f.recipe.id = 'legacy-' + 'r'.repeat(63);
  const prepared = await f.service.prepare({ exe: f.exe, packageRoot: f.packageRoot, recipe: f.recipe });
  const { basePath, receipt } = moveToLegacy(f, prepared);
  fs.writeFileSync(path.join(basePath, 'ReShade.ini'), 'legacy user config');
  const inspected = await f.service.inspect({ exe: f.exe, basePath });
  assert.equal(inspected.layout, 'legacy'); assert.equal(inspected.ready, false); assert.equal(inspected.restoreOnly, true);
  assert.ok(inspected.pathBudget.longestChars > 259); assert.match(inspected.blockers.join(' '), /卸载插件.*重新安装/);
  const archive = await f.service.archive({ exe: f.exe, basePath });
  assert.equal(fs.readFileSync(path.join(archive.archivePath, 'ReShade.ini'), 'utf8'), 'legacy user config');
  assert.equal(JSON.parse(fs.readFileSync(path.join(archive.archivePath, '.xiaofeng-vulkan-runtime.json'))).recipe.fingerprint, receipt.recipe.fingerprint);
  assert.equal(fs.existsSync(basePath), false);
});

test('long logical or canonical AppData paths are rejected before publishing any runtime assets', async t => {
  const f = fixture(t); let copied = 0;
  const pe = { getBitness: () => 64 }, copyFile = async () => { copied++; };
  const tooLong = path.join(f.root, 'user-' + 'x'.repeat(170));
  const logical = createVulkanRuntimeProfile({ userData: tooLong, pe, copyFile });
  await assert.rejects(logical.prepare({ exe: f.exe, recipe: f.recipe, packageRoot: f.packageRoot }), { code: 'VULKAN_RUNTIME_PATH_TOO_LONG' });
  assert.equal(fs.existsSync(logical.runtimeRoot), false); assert.equal(copied, 0);
  fs.mkdirSync(f.userData);
  const mapped = path.join(f.root, 'physical-AppData-' + 'x'.repeat(165));
  const virtualized = createVulkanRuntimeProfile({ userData: f.userData, pe, copyFile,
    realpath(file) { return path.resolve(file) === f.userData ? mapped : fs.realpathSync.native(file); } });
  const place = virtualized.location({ exe: f.exe, recipe: f.recipe });
  assert.ok(place.basePath.length < 180);
  await assert.rejects(virtualized.prepare({ exe: f.exe, recipe: f.recipe, packageRoot: f.packageRoot }), error =>
    error.code === 'VULKAN_RUNTIME_PATH_TOO_LONG' && error.details.pathBudget.canonicalBasePath.startsWith(mapped));
  assert.equal(fs.existsSync(virtualized.runtimeRoot), false); assert.equal(copied, 0);
});

test('the exact Windows WCHAR budget includes Core binary names and the longer rotated log with its NUL', t => {
  const f = fixture(t);
  const relative = path.join('addons', 'nr-before-sr.previous.log');
  const baseLength = 259 - relative.length - 1;
  const base = path.join(f.root, 'x'.repeat(baseLength - f.root.length - 1));
  const recipe = { ...f.recipe, files: [{ ...f.recipe.files[2], target: 'addons/c.dll' }] };
  const atLimit = f.service.pathBudget({ basePath: base, recipe });
  assert.equal(atLimit.longestChars, 259); assert.equal(atLimit.safe, true);
  assert.equal(f.service.pathBudget({ basePath: base + 'x', recipe }).safe, false);
  const longBinary = { ...recipe, files: [{ ...recipe.files[0], target: `addons/${'b'.repeat(50)}.addon64` }] };
  const binary = f.service.pathBudget({ basePath: base, recipe: longBinary });
  assert.equal(binary.safe, false); assert.ok(binary.longestPath.endsWith('.addon64'));
});

test('short EXE and package prefix collisions still require complete identities and never overwrite existing assets', async t => {
  const f = fixture(t), prepared = await f.service.prepare({ exe: f.exe, packageRoot: f.packageRoot, recipe: f.recipe });
  const other = path.join(f.game, 'Other.exe'); fs.writeFileSync(other, 'pe64-other');
  const originalHash = crypto.createHash;
  const fullExe = prepared.exeId, originalFingerprint = prepared.fingerprint;
  // Simulate real prefix collisions without weakening production hashing.
  t.mock.method(crypto, 'createHash', (...args) => {
    const inner = originalHash(...args), chunks = [];
    return { update(data, encoding) { chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data, encoding)); inner.update(data, encoding); return this; },
      digest(encoding) { const text = Buffer.concat(chunks).toString('utf8'), actual = inner.digest('hex');
        const forced = text === path.resolve(other).toLowerCase() ? fullExe.slice(0, 16) + actual.slice(16) :
          text.startsWith('{') && text.includes('0.4.6-collision') ? originalFingerprint.slice(0, 16) + actual.slice(16) : actual;
        return encoding === 'hex' ? forced : Buffer.from(forced, 'hex'); }
    };
  });
  await assert.rejects(f.service.prepare({ exe: other, packageRoot: f.packageRoot, recipe: f.recipe }), { code: 'VULKAN_RUNTIME_IDENTITY_COLLISION' });
  await assert.rejects(f.service.prepare({ exe: f.exe, packageRoot: f.packageRoot, recipe: { ...f.recipe, coreVersion: '0.4.6-collision' } }), { code: 'VULKAN_RUNTIME_PACKAGE_CHANGED' });
  assert.equal(fs.readFileSync(path.join(prepared.basePath, 'ReShade64.dll'), 'utf8'), 'pe64-runtime');
  const receipt = JSON.parse(fs.readFileSync(path.join(prepared.basePath, '.xiaofeng-vulkan-runtime.json')));
  assert.equal(receipt.exeId, fullExe); assert.equal(receipt.recipe.fingerprint, originalFingerprint);
});
