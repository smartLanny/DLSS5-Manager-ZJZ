'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { prepareCoreCatalog } = require('../scripts/prepare-core-catalog');
const { inspectManifest, buildPayload, prepareStageRoot } = require('../scripts/stage-manager-distribution.cjs');
const managerBuild = require('../scripts/build-manager.cjs');

test('build preparation retains visible update-only candidate labels and the existing default', () => {
  const candidates = {
    '0.5-dline13': { label: '0.5 D13 · 测试', coreUpdateOnly: true, comparisonOnly: false, compatibility: null },
    '0.4.7beta-corefix.8': { label: '0.4.7 Corefix8 · 测试', coreUpdateOnly: true, comparisonOnly: false, compatibility: null }
  };
  const { bundle } = prepareCoreCatalog({ version: 4, defaultVersion: '0.4.7beta', versions: { '0.4.7beta': {}, ...candidates } });
  assert.equal(bundle.defaultVersion, '0.4.7beta');
  for (const [id, entry] of Object.entries(candidates)) assert.deepEqual(bundle.versions[id], entry);
  assert.deepEqual(prepareCoreCatalog(bundle).bundle, bundle);
});
const { verifyExecutable, parseArguments } = require('../scripts/verify-execution-level');

function peFixture(level, is64 = false, encoding = 'utf8') {
  const xml = `<?xml version="1.0"?><assembly xmlns="urn:schemas-microsoft-com:asm.v1"><trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="${level}" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>`;
  const manifest = Buffer.from(xml, encoding), buffer = Buffer.alloc(0x1000);
  const pe = 0x80, optionalSize = is64 ? 0xf0 : 0xe0, optional = pe + 24, section = optional + optionalSize;
  buffer.writeUInt16LE(0x5a4d, 0); buffer.writeUInt32LE(pe, 0x3c); buffer.writeUInt32LE(0x4550, pe);
  buffer.writeUInt16LE(is64 ? 0x8664 : 0x14c, pe + 4); buffer.writeUInt16LE(1, pe + 6); buffer.writeUInt16LE(optionalSize, pe + 20);
  buffer.writeUInt16LE(is64 ? 0x20b : 0x10b, optional);
  const directories = optional + (is64 ? 112 : 96); buffer.writeUInt32LE(0x1000, directories + 16); buffer.writeUInt32LE(0xc00, directories + 20);
  buffer.write('.rsrc\0', section); buffer.writeUInt32LE(0xc00, section + 8); buffer.writeUInt32LE(0x1000, section + 12);
  buffer.writeUInt32LE(0xc00, section + 16); buffer.writeUInt32LE(0x200, section + 20);
  for (const [offset, id, target] of [[0, 24, 0x80000020], [0x20, 1, 0x80000040], [0x40, 1033, 0x60]]) {
    buffer.writeUInt16LE(1, 0x200 + offset + 14); buffer.writeUInt32LE(id, 0x200 + offset + 16); buffer.writeUInt32LE(target, 0x200 + offset + 20);
  }
  buffer.writeUInt32LE(0x1100, 0x260); buffer.writeUInt32LE(manifest.length, 0x264); manifest.copy(buffer, 0x300);
  return buffer;
}

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-release-test-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}

test('portable launcher and GUI run at ordinary privilege with a matching beta build version', () => {
  const pkg = require('../package.json'), lock = require('../package-lock.json');
  const schema = require('../node_modules/app-builder-lib/scheme.json');
  const portable = schema.definitions.PortableOptions.properties.requestExecutionLevel;
  assert.ok(portable.enum.includes(pkg.build.portable.requestExecutionLevel));
  assert.equal(pkg.build.portable.requestExecutionLevel, 'user');
  assert.equal(pkg.build.win.requestedExecutionLevel, 'asInvoker');
  const developmentVersion = pkg.version.match(/^(\d+\.\d+\.\d+)-beta\.(\d+)$/);
  assert.ok(developmentVersion); assert.equal(pkg.build.buildVersion, `${developmentVersion[1]}.${developmentVersion[2]}`);
  assert.equal(lock.version, pkg.version); assert.equal(lock.packages[''].version, pkg.version);
  const target = fs.readFileSync(require.resolve('app-builder-lib/out/targets/nsis/NsisTarget'), 'utf8');
  const template = fs.readFileSync(path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis/portable.nsi'), 'utf8');
  assert.match(target, /defines\.REQUEST_EXECUTION_LEVEL = requestExecutionLevel \|\| "user"/);
  assert.match(template, /RequestExecutionLevel \$\{REQUEST_EXECUTION_LEVEL\}/);
});

test('hotfix supersedes original release IDs without changing binary metadata or historical IDs', () => {
  const versions = Object.fromEntries(['0.2.0-beta.2', '0.3.3.5', '0.4.2', '0.4.2-dx11-native-bridge-exp1-r1', '0.4.5-ota', '0.4.6', '0.4.6-ota', '0.4.6-hotfix.1'].map(id => [id, { label: id, files: { 'core.addon64': id }, source: id }]));
  const original = { version: 4, defaultVersion: '0.4.6', fixed: { fixture: true }, versions };
  const result = prepareCoreCatalog(original);
  assert.deepEqual(result.removed, ['0.4.5-ota', '0.4.6', '0.4.6-ota']);
  assert.deepEqual(Object.keys(result.bundle.versions), ['0.2.0-beta.2', '0.3.3.5', '0.4.2', '0.4.2-dx11-native-bridge-exp1-r1', '0.4.6-hotfix.1']);
  assert.deepEqual(result.bundle.versions['0.4.2'].files, versions['0.4.2'].files);
  assert.equal(result.bundle.versions['0.4.2'].source, '0.4.2');
  assert.equal(result.bundle.versions['0.4.2-dx11-native-bridge-exp1-r1'].source, '0.4.2-dx11-native-bridge-exp1-r1');
  assert.equal(result.bundle.defaultVersion, '0.4.6-hotfix.1');
  assert.equal(result.bundle.supersededVersions['0.4.6'], '0.4.6-hotfix.1');
  assert.doesNotMatch(result.bundle.versions['0.2.0-beta.2'].label, /beta/i);
  assert.match(result.bundle.versions['0.3.3.5'].label, /稳定基线/);
  assert.match(result.bundle.versions['0.4.6-hotfix.1'].label, /Beta/);
  assert.deepEqual(result.bundle.versions['0.4.6-hotfix.1'].files, versions['0.4.6-hotfix.1'].files);
  assert.ok(original.versions['0.4.6'], 'input is not mutated');
  assert.deepEqual(prepareCoreCatalog(result.bundle).bundle, result.bundle, 'repeated builds retain migration notices');
});

test('catalog does not remove original 0.4.6 when no replacement hotfix exists', () => {
  const result = prepareCoreCatalog({ version: 4, defaultVersion: '0.4.6', versions: { '0.3.3.5': {}, '0.4.6': {} } });
  assert.ok(result.bundle.versions['0.4.6']); assert.deepEqual(result.removed, []);
});

test('verified r4 is the compatibility baseline without relabeling r5 bytes or dropping rollback', () => {
  const versions={'0.3.3-dev-r4':{files:{addon:'r4'},notes:'原始版本为 beta0.3.3-dev-r4，D3D12'},'0.3.3.5':{files:{addon:'r5'}},'0.4.6-hotfix.1':{}};
  const {bundle}=prepareCoreCatalog({version:4,defaultVersion:'0.4.6-hotfix.1',versions});
  assert.match(bundle.versions['0.3.3-dev-r4'].label,/0\.3\.3\.4.*稳定兼容/);
  assert.match(bundle.versions['0.3.3.5'].label,/历史对照/);
  assert.deepEqual(bundle.versions['0.3.3.5'].files,versions['0.3.3.5'].files);
  assert.equal(bundle.versions['0.3.3-dev-r4'].notes,versions['0.3.3-dev-r4'].notes);
  assert.equal(Object.hasOwn(bundle.versions,'0.3.3.4'),false,'display uses actual PE version but the historical internal ID is preserved');
});

test('beta0.4.7 full DX11 package replaces 0.4.6 while retaining the stable baseline and migration records', () => {
  const versions = { '0.3.3-dev-r4': {}, '0.4.5-ota': {}, '0.4.6': {}, '0.4.6-hotfix.1': {},
    '0.4.7beta': { compatibility: 'dx11', files: { carrier: 'paired', addon: 'unchanged' } } };
  const { bundle } = prepareCoreCatalog({ version: 4, defaultVersion: '0.4.6-hotfix.1', versions });
  assert.equal(bundle.defaultVersion, '0.4.7beta');
  assert.equal(bundle.versions['0.4.7beta'].label, 'beta0.4.7');
  assert.equal(bundle.supersededVersions['0.4.5-ota'], '0.4.7beta');
  assert.equal(bundle.supersededVersions['0.4.6'], '0.4.7beta');
  assert.ok(bundle.versions['0.3.3-dev-r4']); assert.equal(bundle.versions['0.4.6-hotfix.1'], undefined);
  assert.equal(bundle.supersededVersions['0.4.6-hotfix.1'], '0.4.7beta');
  assert.deepEqual(prepareCoreCatalog(bundle).bundle, bundle);
});

test('dynamic staging rejects explicit D13 and D14 Core selections before packaging', async t => {
  const root = temporary(t);
  for (const version of ['0.5-dline13', '0.5-dline14']) {
    const file = path.join(root, version + '.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, packageVersion: '0.5.0-beta.2', core: { version, payloadRoot: '.' } }));
    await assert.rejects(inspectManifest(file, 'base'), /D13\/D14/);
  }
  assert.deepEqual(require('../package.json').build.extraResources, []);
});

test('distribution staging retains every requested Core as an atomic Core plus chain while keeping 0.4.7 default', async t => {
  assert.equal(typeof buildPayload, 'function');
  const root = temporary(t), payloadRoot = path.join(root, 'payload'), stageRoot = path.join(root, 'stage');
  const hash = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
  const files = {
    reshade: Buffer.from('reshade'), chain: Buffer.from('shared chain'), runtime40: Buffer.from('runtime 40'),
    runtime50: Buffer.from('runtime 50'), initial: Buffer.from('initial core'), current: Buffer.from('current core'),
    d21: Buffer.from('d21 core'), ini: Buffer.from('[NRBeforeSR]\nEnabled=1\n')
  };
  for (const family of ['RTX40', 'RTX50']) {
    const fixed = path.join(payloadRoot, 'fixed', family); fs.mkdirSync(fixed, { recursive: true });
    fs.writeFileSync(path.join(fixed, 'ReShade64.dll'), files.reshade);
    fs.writeFileSync(path.join(fixed, 'nrchain_nvngx.dll'), files.chain);
    fs.writeFileSync(path.join(fixed, 'nvngx_dlssnr.dll'), family === 'RTX40' ? files.runtime40 : files.runtime50);
  }
  const versions = {
    '0.2.0-beta.2': { label: '0.2', files: { 'nr-before-sr.zh-CN.addon64': hash(files.initial), 'nr_before_sr.ini': hash(files.ini) } },
    '0.4.7beta': { label: '0.4.7', supportsPresent: true, inputInterfaces: ['NGX-D3D12-Feature1'], files: { 'nr-before-sr.zh-CN.addon64': hash(files.current), 'nr_before_sr.ini': hash(files.ini) } },
    '0.5-dline21': { label: 'D21', coreUpdateOnly: false, validation: 'candidate', supportsPresent: true, inputInterfaces: ['NGX-D3D12-Feature1'], files: { 'nr-before-sr.zh-CN.addon64': hash(files.d21), 'nr_before_sr.ini': hash(files.ini) } }
  };
  for (const [id, entry] of Object.entries(versions)) {
    const dir = path.join(payloadRoot, 'versions', id); fs.mkdirSync(dir, { recursive: true });
    const core = id === '0.2.0-beta.2' ? files.initial : id === '0.4.7beta' ? files.current : files.d21;
    fs.writeFileSync(path.join(dir, 'nr-before-sr.zh-CN.addon64'), core);
    fs.writeFileSync(path.join(dir, 'nr_before_sr.ini'), files.ini);
  }
  const fixedEntry = runtime => ({ files: {
    'ReShade64.dll': hash(files.reshade), 'nrchain_nvngx.dll': hash(files.chain), 'nvngx_dlssnr.dll': hash(runtime)
  } });
  fs.writeFileSync(path.join(payloadRoot, 'bundle.json'), JSON.stringify({ version: 4, defaultVersion: '0.4.7beta',
    fixed: { RTX40: fixedEntry(files.runtime40), RTX50: fixedEntry(files.runtime50) }, versions }));
  const runtimeRoot = path.join(root, 'runtime'); fs.mkdirSync(runtimeRoot);
  const manifestFile = path.join(root, 'staging.json');
  const manifest = { core: { payloadRoot, version: '0.4.7beta', versions: ['0.2.0-beta.2', '0.4.7beta', '0.5-dline21'] },
    runtime: { sourceRoot: runtimeRoot, families: {
      RTX40: { file: path.join(payloadRoot, 'fixed/RTX40/nvngx_dlssnr.dll'), bytes: files.runtime40.length, sha256: hash(files.runtime40) },
      RTX50: { file: path.join(payloadRoot, 'fixed/RTX50/nvngx_dlssnr.dll'), bytes: files.runtime50.length, sha256: hash(files.runtime50) }
    } } };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const result = await buildPayload({ stageRoot, manifest, manifestFile, flavor: 'offline' });
  assert.equal(result.version, '0.4.7beta');
  assert.deepEqual(result.versions, ['0.2.0-beta.2', '0.4.7beta', '0.5-dline21']);
  const staged = JSON.parse(fs.readFileSync(path.join(stageRoot, 'payload/nr-before-sr/bundle.json')));
  assert.equal(staged.defaultVersion, '0.4.7beta');
  assert.deepEqual(Object.keys(staged.versions), result.versions);
  for (const id of result.versions) {
    assert.equal(staged.versions[id].files['nrchain_nvngx.dll'], hash(files.chain));
    assert.deepEqual(fs.readFileSync(path.join(stageRoot, 'payload/nr-before-sr/versions', id, 'nrchain_nvngx.dll')), files.chain);
  }
  assert.equal(staged.versions['0.5-dline21'].coreUpdateOnly, false, 'assembled D21 is a complete user-selected candidate');
  assert.equal(staged.defaultVersion, '0.4.7beta', 'complete D21 must not replace the public default');
  assert.equal(staged.distribution.coreSource, 'verified-external-staging');
  assert.doesNotMatch(JSON.stringify(staged), /package-release-test-/i, 'public bundle must not disclose a local source path');
});

test('large staging and delivery roots can live on another drive without permitting arbitrary recursive cleanup', t => {
  const root = temporary(t), workRoot = path.join(root, 'manager-build-work');
  const stageRoot = path.join(workRoot, 'stage', 'offline');
  prepareStageRoot(stageRoot, workRoot);
  fs.writeFileSync(path.join(stageRoot, 'old.bin'), 'old');
  prepareStageRoot(stageRoot, workRoot);
  assert.equal(fs.existsSync(path.join(stageRoot, 'old.bin')), false);
  assert.equal(fs.existsSync(path.join(stageRoot, '.dlss5-manager-stage')), true);

  const unrelated = path.join(workRoot, 'unrelated');
  fs.mkdirSync(unrelated, { recursive: true });
  fs.writeFileSync(path.join(unrelated, 'keep.txt'), 'keep');
  assert.throws(() => prepareStageRoot(unrelated, workRoot), /不是 Manager 生成的 stage/);
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep.txt'), 'utf8'), 'keep');

  const parsed = managerBuild.parseArgs(['--work-root', workRoot, '--flavor', 'offline', '--portable']);
  const roots = managerBuild.resolveBuildRoots(parsed);
  assert.equal(roots.stageRoot, path.join(path.resolve(workRoot), 'stage', 'offline'));
  assert.equal(roots.outputRoot, path.join(path.resolve(workRoot), 'deliveries', 'DLSS5-Manager-0.5.0-beta.2-offline'));
  const config = managerBuild.buildConfig({ stageRoot, flavor:'offline', outputRoot:roots.outputRoot,
    portableOnly:true, electronDist:'D:/verified-electron-dist' });
  assert.equal(config.electronDist, path.resolve('D:/verified-electron-dist'));
  const zipArgs = managerBuild.parseArgs(['--work-root', workRoot, '--unpacked-zip']);
  assert.equal(zipArgs.unpackedZip, true);
  const zipConfig = managerBuild.buildConfig({ stageRoot, flavor:'offline', outputRoot:roots.outputRoot,
    unpackedZip:true, electronDist:'D:/verified-electron-dist' });
  assert.deepEqual(zipConfig.win.target, ['dir']);
  assert.equal(zipConfig.win.signAndEditExecutable, false);
  const explicit = managerBuild.explicitTargets({ unpackedZip:true });
  const { Platform, Arch } = require('electron-builder');
  assert.deepEqual(explicit.get(Platform.WINDOWS).get(Arch.x64), ['dir']);
});

test('PE manifest verification reads PE32 and PE32+ resources including UTF-16', t => {
  const root = temporary(t);
  for (const [is64, encoding] of [[false, 'utf8'], [true, 'utf16le']]) {
    const file = path.join(root, `${is64 ? 'inner' : 'portable'}.exe`); fs.writeFileSync(file, peFixture('requireAdministrator', is64, encoding));
    const result = verifyExecutable(file);
    assert.equal(result.ok, true); assert.deepEqual(result.manifests, [{ resourceId: 1, languageId: 1033, level: 'requireAdministrator' }]);
  }
});

test('manifest verifier rejects mismatched actual privilege and ignores overlay strings', t => {
  const root = temporary(t), file = path.join(root, 'old-portable.exe');
  const pe = peFixture('asInvoker');
  fs.writeFileSync(file, Buffer.concat([pe, Buffer.from('<requestedExecutionLevel level="requireAdministrator"/>')]));
  assert.equal(verifyExecutable(file).ok, false);
  assert.equal(verifyExecutable(file, 'asInvoker').ok, true);
  const malformed = peFixture('requireAdministrator'); malformed.writeUInt32LE(0xffffffff, 0x264); fs.writeFileSync(file, malformed);
  assert.throws(() => verifyExecutable(file), /大小无效/);
});

test('one verification command can check both installer and elevated application artifacts', () => {
  assert.deepEqual(parseArguments(['portable.exe', 'unpacked.exe', '--expect', 'asInvoker', 'Setup.exe']), [
    { file: 'portable.exe', expected: 'requireAdministrator' }, { file: 'unpacked.exe', expected: 'requireAdministrator' }, { file: 'Setup.exe', expected: 'asInvoker' }
  ]);
  assert.throws(() => parseArguments(['--expect', 'admin', 'a.exe']), /需要/);
});
