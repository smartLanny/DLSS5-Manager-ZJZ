'use strict';

// Assemble a reproducible, ignored staging tree from an external manifest.
// The repository keeps source and metadata only; this script is the only
// packaging entry allowed to copy runtime payloads into a build tree.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MANIFEST = process.env.DLSS5_MANAGER_STAGING ||
  path.resolve(REPO_ROOT, '..', 'manager-distribution-staging.json');
const FAMILIES = ['RTX40', 'RTX50'];
const FIXED_FILES = ['ReShade64.dll', 'nrchain_nvngx.dll', 'nvngx_dlssnr.dll'];
const CORE_FILES = new Set([
  'nr-before-sr.zh-CN.addon64',
  'nrchain_nvngx.dll',
  'nr_before_sr.ini',
  'dlss5-native-carrier-045-dx11-compat.addon64',
  'dlss5-native-carrier-exp1.addon64'
]);
const REQUIRED_CORE_FILES = ['nr-before-sr.zh-CN.addon64', 'nr_before_sr.ini'];
const SMALL_COMPONENT_KINDS = new Set(['bridge', 'feeder', 'host', 'vulkan']);
const COMPONENT_ID = /^[a-z0-9][a-z0-9._+-]{0,127}$/i;
const COMPONENT_MAX_FILE = 128 * 1024 * 1024;
const COMPONENT_MAX_TOTAL = 512 * 1024 * 1024;
const BUNDLED_RESOURCE_TARGETS = new Set([
  'core-notices/unified5/LICENSES.txt',
  'core-notices/unified5/NVIDIA-NGX-LICENSE.txt',
  'hoyoshade/component.json',
  'loading-helper/component.json',
  'loading-helper/dlss5-load-helper.exe',
  'reframework-01417/component.json',
  'reframework-01417/dinput8.dll',
  'reframework-01417/LICENSE',
  'vulkan-reshade/LICENSE.md',
  'vulkan-reshade/recipe.json',
  'vulkan-reshade/ReShade64.dll',
  'vulkan-reshade/ReShade64.json'
]);
const FORBIDDEN_CORE_VERSION = /(?:dline\s*13|dline\s*14|0\.5[-_.]?dline(?:13|14))/i;
const BINARY_SUFFIX = /\.(?:dll|exe|asi|addon32|addon64|pdb)$/i;
const HASH = /^[a-f0-9]{64}$/i;
const STAGE_MARKER = '.dlss5-manager-stage';

function fail(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function readJson(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { fail(`找不到清单：${file}`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) fail(`清单必须是小型普通 JSON 文件：${file}`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail(`清单 JSON 无效：${file}`, { cause: error.message }); }
}

function resolveInput(manifestFile, value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} 缺失。`);
  const normalized = value.trim();
  return path.resolve(path.isAbsolute(normalized) ? normalized : path.join(path.dirname(manifestFile), normalized));
}

function relativeComponentPath(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} 缺失。`);
  const normalized = value.trim().replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..' || /[\x00-\x1f:]/.test(part))) {
    fail(`${label} 必须是组件根目录内的相对路径。`, { value });
  }
  return normalized;
}

function ensurePlainFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { fail(`${label} 不存在：${file}`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail(`${label} 必须是普通文件：${file}`);
  return stat;
}

function ensurePlainDirectory(dir, label) {
  let stat;
  try { stat = fs.lstatSync(dir); } catch { fail(`${label} 不存在：${dir}`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} 必须是普通目录：${dir}`);
  return dir;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function verifyFile(file, spec, label) {
  const stat = ensurePlainFile(file, label);
  if (spec && spec.bytes !== undefined && Number(spec.bytes) !== stat.size) fail(`${label} 大小不符。`, { expected: spec.bytes, actual: stat.size, file });
  const actual = await sha256(file);
  if (spec && spec.sha256 && (!HASH.test(String(spec.sha256)) || actual !== String(spec.sha256).toLowerCase())) {
    fail(`${label} SHA-256 不符。`, { expected: spec.sha256, actual, file });
  }
  return { file, bytes: stat.size, sha256: actual };
}

function copyFile(source, target) {
  ensurePlainFile(source, '待复制文件');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function forbidBundledNrRuntime(relative, label) {
  const name = path.posix.basename(String(relative)).toLowerCase();
  if (name === 'nvngx_dlssnr.dll' || /^nvngx_dlssnr(?:[-_.].*)?\.dll$/i.test(name)) {
    fail(`${label} 不能把大型 NVIDIA NR runtime 放进小组件包；请使用 runtime.families / offline runtime 包。`, { file: relative });
  }
}

function prepareStageRoot(stageRoot, allowedRoot = path.join(REPO_ROOT, '.packaging-stage')) {
  const resolvedRoot = path.resolve(allowedRoot), resolvedStage = path.resolve(stageRoot);
  const relative = path.relative(resolvedRoot, resolvedStage);
  if (resolvedRoot === path.parse(resolvedRoot).root || !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('stage 输出必须严格位于已指定的 Manager 工作目录内。', { stageRoot: resolvedStage, allowedRoot: resolvedRoot });
  }
  if (fs.existsSync(resolvedStage)) {
    ensurePlainDirectory(resolvedStage, '既有 stage 输出');
    if (!fs.existsSync(path.join(resolvedStage, STAGE_MARKER))) {
      fail(`既有目录不是 Manager 生成的 stage，拒绝清理：${resolvedStage}`);
    }
    fs.rmSync(resolvedStage, { recursive: true, force: true });
  }
  fs.mkdirSync(resolvedStage, { recursive: true });
  fs.writeFileSync(path.join(resolvedStage, STAGE_MARKER), 'DLSS5 Manager generated staging directory\n', { encoding: 'utf8', flag: 'wx' });
}

function copyTextTree(sourceRoot, targetRoot) {
  ensurePlainDirectory(sourceRoot, '资源目录');
  const pending = [''];
  while (pending.length) {
    const relative = pending.pop();
    const current = path.join(sourceRoot, relative);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = relative ? path.join(relative, entry.name) : entry.name;
      const source = path.join(sourceRoot, child);
      const target = path.join(targetRoot, child);
      if (entry.isSymbolicLink()) fail(`资源目录不能包含链接：${child}`);
      if (entry.isDirectory()) { pending.push(child); continue; }
      if (!entry.isFile()) fail(`资源目录包含不支持的条目：${child}`);
      // The external manifest supplies the only binary explicitly allowed in
      // this stage. Existing resource text and notices are safe to copy.
      if (BINARY_SUFFIX.test(entry.name)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  }
}

function readPayloadBundle(payloadRoot) {
  const file = path.join(payloadRoot, 'bundle.json');
  const bundle = readJson(file);
  if (bundle.version !== 4 || !bundle.fixed || !bundle.versions || Array.isArray(bundle.versions)) {
    fail('Core payload 必须是带 fixed/versions 的 v4 bundle.json。', { file, version: bundle.version });
  }
  for (const family of FAMILIES) {
    if (!bundle.fixed[family]?.files || typeof bundle.fixed[family].files !== 'object') fail(`Core bundle 缺少 ${family} fixed 清单。`, { file });
    for (const name of FIXED_FILES) if (!HASH.test(String(bundle.fixed[family].files[name] || ''))) fail(`Core bundle 的 ${family}/${name} 哈希无效。`, { file });
  }
  return bundle;
}

function assertPackageCoreEntry(entry, version) {
  if (!entry || typeof entry !== 'object' || !entry.files || typeof entry.files !== 'object') fail(`Core 版本没有文件清单：${version}`);
  const names = Object.keys(entry.files);
  for (const name of names) {
    if (path.basename(name) !== name || !CORE_FILES.has(name)) {
      fail(`Core 版本含未登记的文件：${version}/${name}`, { version, file: name });
    }
    if (!HASH.test(String(entry.files[name]))) fail(`Core 版本文件哈希无效：${version}/${name}`);
  }
  for (const name of REQUIRED_CORE_FILES) if (!entry.files[name]) fail(`Core 版本缺少固定文件：${version}/${name}`);
}

function assertAllowedCoreEntry(entry, version) {
  assertPackageCoreEntry(entry, version);
  if (entry.coreUpdateOnly === true) fail(`选中的 Core 被标记为仅更新，不能作为首次安装默认 Core：${version}`);
  if (entry.supportsPresent !== true || !Array.isArray(entry.inputInterfaces) || !entry.inputInterfaces.includes('NGX-D3D12-Feature1')) {
    fail(`选中的 Core 不是当前 Manager 认可的 Present/输入接口：${version}`, { supportsPresent: entry.supportsPresent, inputInterfaces: entry.inputInterfaces });
  }
}

async function buildPayload({ stageRoot, manifest, manifestFile, flavor }) {
  const payloadSpec = manifest.core || {};
  const payloadRoot = resolveInput(manifestFile, payloadSpec.payloadRoot, 'core.payloadRoot');
  ensurePlainDirectory(payloadRoot, 'Core payload 根目录');
  const sourcePackage = payloadSpec.sourcePackage
    ? await verifyFile(resolveInput(manifestFile, payloadSpec.sourcePackage.file, 'core.sourcePackage.file'), payloadSpec.sourcePackage, 'D15 Core source package')
    : null;
  const sourceBundle = readPayloadBundle(payloadRoot);
  const version = payloadSpec.version || sourceBundle.defaultVersion;
  if (typeof version !== 'string' || !version || FORBIDDEN_CORE_VERSION.test(version)) {
    fail(`拒绝把 D13/D14 或未明确版本作为默认 Core：${version || '(empty)'}`);
  }
  const entry = sourceBundle.versions[version];
  assertAllowedCoreEntry(entry, version);
  const versions = payloadSpec.versions === undefined ? [version] : payloadSpec.versions;
  if (!Array.isArray(versions) || versions.length < 1 || versions.length > 16 || !versions.includes(version) ||
      new Set(versions).size !== versions.length || versions.some(id => typeof id !== 'string' || !COMPONENT_ID.test(id) || FORBIDDEN_CORE_VERSION.test(id))) {
    fail('core.versions 必须是包含默认版本且不含 D13/D14 的唯一 Core ID 数组。', { version, versions });
  }
  for (const id of versions) assertPackageCoreEntry(sourceBundle.versions[id], id);

  const runtime = manifest.runtime || {};
  const runtimeRoot = resolveInput(manifestFile, runtime.sourceRoot, 'runtime.sourceRoot');
  ensurePlainDirectory(runtimeRoot, '授权运行库来源');
  const sourceFixed = {};
  for (const family of FAMILIES) {
    sourceFixed[family] = {};
    for (const name of FIXED_FILES) {
      const source = path.join(payloadRoot, 'fixed', family, name);
      const expected = sourceBundle.fixed[family].files[name];
      const runtimeSpec = runtime.families?.[family];
      const runtimeSource = name === 'nvngx_dlssnr.dll'
        ? resolveInput(manifestFile, runtimeSpec?.file, `runtime.families.${family}.file`)
        : source;
      const spec = name === 'nvngx_dlssnr.dll' ? runtimeSpec : { sha256: expected };
      const checked = await verifyFile(runtimeSource, spec, `${family}/${name}`);
      if (checked.sha256 !== String(expected).toLowerCase()) fail(`${family}/${name} 与 Core bundle 记录不一致。`, { expected, actual: checked.sha256 });
      sourceFixed[family][name] = { source: runtimeSource, expected, bytes: checked.bytes };
    }
  }
  const chainHashes = new Set(FAMILIES.map(family => sourceFixed[family]['nrchain_nvngx.dll'].expected));
  if (chainHashes.size !== 1) fail('多 Core 原子包要求 RTX40/RTX50 共用同一份 nrchain；当前 fixed 清单不一致。');
  const sharedChain = sourceFixed.RTX40['nrchain_nvngx.dll'];

  const outputRoot = path.join(stageRoot, 'payload', 'nr-before-sr');
  fs.mkdirSync(outputRoot, { recursive: true });
  const stagedBundle = {
    version: 4,
    generatedAt: new Date().toISOString(),
    defaultVersion: version,
    fixed: Object.fromEntries(FAMILIES.map(family => [family, {
      files: Object.fromEntries(FIXED_FILES.map(name => [name, sourceFixed[family][name].expected])),
      ...(flavor === 'offline' ? { paths: { runtime: `fixed/${family}/nvngx_dlssnr.dll` } } : {})
    }])),
    versions: {},
    distribution: { flavor, sourceVersion: version, includedVersions: [...versions], runtimeSplit: true, coreSource: 'verified-external-staging' }
  };
  for (const id of versions) {
    const sourceEntry = sourceBundle.versions[id];
    const stagedEntry = { ...structuredClone(sourceEntry), files: {} };
    stagedBundle.versions[id] = stagedEntry;
    const targetVersion = path.join(outputRoot, 'versions', id);
    fs.mkdirSync(targetVersion, { recursive: true });
    for (const name of Object.keys(sourceEntry.files)) {
      const source = path.join(payloadRoot, 'versions', id, name);
      const checked = await verifyFile(source, { sha256: sourceEntry.files[name] }, `Core/${id}/${name}`);
      copyFile(source, path.join(targetVersion, name));
      stagedEntry.files[name] = checked.sha256;
    }
    if (!Object.hasOwn(stagedEntry.files, 'nrchain_nvngx.dll')) {
      copyFile(sharedChain.source, path.join(targetVersion, 'nrchain_nvngx.dll'));
      stagedEntry.files['nrchain_nvngx.dll'] = sharedChain.expected;
    }
    if (sourceEntry.companions) {
      const allowed = new Set(['LICENSE', 'onnxruntime_providers_shared.dll', 'onnxruntime.dll', 'ThirdPartyNotices.txt', 'yunet-dynamic.json', 'yunet-dynamic.onnx', 'YUNET-LICENSE'].map(name => 'nr_face/' + name));
      if (Object.keys(sourceEntry.companions).length !== allowed.size || Object.keys(sourceEntry.companions).some(name => !allowed.has(name))) fail('Core 人脸配套清单不完整或含未知文件。');
      for (const [name, expected] of Object.entries(sourceEntry.companions)) {
        if (!HASH.test(expected)) fail('Core 配套摘要无效。');
        const source = path.join(payloadRoot, 'versions', id, name);
        await verifyFile(source, { sha256: expected }, `Core/${id}/${name}`);
        copyFile(source, path.join(targetVersion, name));
      }
    }
  }
  for (const family of FAMILIES) {
    const targetFamily = path.join(outputRoot, 'fixed', family);
    fs.mkdirSync(targetFamily, { recursive: true });
    for (const name of ['ReShade64.dll', 'nrchain_nvngx.dll']) {
      copyFile(sourceFixed[family][name].source, path.join(targetFamily, name));
    }
    if (flavor === 'offline') copyFile(sourceFixed[family]['nvngx_dlssnr.dll'].source, path.join(targetFamily, 'nvngx_dlssnr.dll'));
  }
  const readme = path.join(payloadRoot, 'README.md');
  if (fs.existsSync(readme)) copyFile(readme, path.join(outputRoot, 'README.md'));
  fs.writeFileSync(path.join(outputRoot, 'bundle.json'), `${JSON.stringify(stagedBundle, null, 2)}\n`, 'utf8');
  return { payloadRoot: outputRoot, sourcePayloadRoot: payloadRoot, version, versions: [...versions], bundle: stagedBundle, sourcePackage };
}

async function buildMfg({ stageRoot, manifest, manifestFile }) {
  const spec = manifest.mfg;
  if (!spec || spec.defaultProvider !== 'mfgunlock-1.0' || !Array.isArray(spec.providers) || spec.providers.length !== 2)
    fail('清单必须包含 MFG 1.0 默认版与 0.9 回退版。');
  const pins = new Map([
    ['mfgunlock-1.0', { version:'1.0', bytes:710144, sha256:'f9f10c685e3e89077f751df2394a1629615a56b58d111dff26b39894e772d50e' }],
    ['mfgunlock-0.9', { version:'0.9', bytes:601088, sha256:'64184bb370f223c3cabb359010a9a64e114cdae6b62d8b014a731a602af0a0da' }]
  ]);
  const sourceResources = path.join(REPO_ROOT, 'resources', 'fg-mfgunlock');
  const targetResources = path.join(stageRoot, 'resources', 'fg-mfgunlock');
  copyTextTree(sourceResources, targetResources);
  const providers = [];
  for (const provider of spec.providers) {
    const pin = pins.get(provider.id);
    if (!pin || provider.version !== pin.version || provider.bytes !== pin.bytes || provider.sha256 !== pin.sha256)
      fail(`MFG ${provider.id || 'unknown'} 不符合固定发布身份。`, { provider });
    const source = resolveInput(manifestFile, provider.file, `mfg.providers.${provider.id}.file`);
    const checked = await verifyFile(source, pin, `MFG ${pin.version} addon`);
    const target = path.join(targetResources, 'versions', pin.version, 'renodx-mfgunlock.addon64');
    copyFile(source, target);
    const record = { id:provider.id, version:pin.version, file:`versions/${pin.version}/renodx-mfgunlock.addon64`, bytes:checked.bytes, sha256:checked.sha256,
      source:provider.url || null, recommended:provider.id === spec.defaultProvider, status:'staged-for-manager-catalog' };
    fs.writeFileSync(path.join(targetResources, `staging-mfg-${pin.version}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    providers.push(record);
  }
  return { defaultProvider:spec.defaultProvider, providers };
}

async function buildSm86({ stageRoot, manifest, manifestFile }) {
  if (!manifest.sm86 && manifest.packageVersion === '0.5.0-beta.2') return null;
  const { ID, PIN, SOURCE } = require('../src/product/fg-sm86-components');
  const sourceRoot = resolveInput(manifestFile, manifest.sm86?.sourceRoot, 'sm86.sourceRoot');
  ensurePlainDirectory(sourceRoot, 'SM86 来源');
  const target = path.join(stageRoot, 'resources', 'fg-sm86');
  const result = { schemaVersion: 1, id: ID, backend: 'dlssg-sm86', version: '0.3.5',
    source: { repository: 'sdli1995/dlssg_for_sm86', commit: SOURCE,
      url: `https://github.com/sdli1995/dlssg_for_sm86/tree/${SOURCE}` }, files: {} };
  for (const [role, pin] of Object.entries(PIN)) {
    const source = path.join(sourceRoot, pin.name);
    await verifyFile(source, pin, 'SM86/' + pin.name);
    copyFile(source, path.join(target, pin.name));
    result.files[role] = { ...pin, source: `https://github.com/sdli1995/dlssg_for_sm86/blob/${SOURCE}/${pin.name}` };
  }
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

async function buildSmallComponents({ stageRoot, manifest, manifestFile, flavor }) {
  const declared = manifest.components || [];
  if (!Array.isArray(declared)) fail('staging.components 必须是数组。');
  if (declared.length > 64) fail('staging.components 条目过多。');
  const targetRoot = path.join(stageRoot, 'resources', 'components');
  fs.mkdirSync(targetRoot, { recursive: true });
  const catalog = [];
  const ids = new Set();
  const targets = new Set();
  let totalBytes = 0;
  for (const component of declared) {
    if (!component || typeof component !== 'object' || !COMPONENT_ID.test(String(component.id || '')) || !SMALL_COMPONENT_KINDS.has(component.kind)) {
      fail('staging.components 含无效的小组件类型或 ID。', { component });
    }
    const id = String(component.id);
    if (ids.has(id)) fail(`小组件 ID 重复：${id}`);
    ids.add(id);
    const includeIn = component.includeIn === undefined ? ['base', 'offline'] : Array.isArray(component.includeIn) ? component.includeIn : [component.includeIn];
    if (!includeIn.every(value => ['base', 'offline'].includes(value))) fail(`小组件 ${id} 的 includeIn 无效。`, { includeIn });
    if (!includeIn.includes(flavor)) continue;
    if (typeof component.version !== 'string' || !component.version || component.version.length > 100 ||
        !['x86', 'x64', 'mixed'].includes(component.architecture) || typeof component.interface !== 'string' || !component.interface || component.interface.length > 100 ||
        !Array.isArray(component.files) || component.files.length < 1 || component.files.length > 128) {
      fail(`小组件 ${id} 的元数据或 files 不完整。`);
    }
    const sourceRoot = component.sourceRoot ? resolveInput(manifestFile, component.sourceRoot, `components.${id}.sourceRoot`) : null;
    if (sourceRoot) ensurePlainDirectory(sourceRoot, `小组件 ${id} 来源目录`);
    const componentRoot = path.join(targetRoot, id);
    const files = [];
    const importerManifestNames = new Set();
    for (const row of component.files) {
      if (!row || typeof row !== 'object') fail(`小组件 ${id} 含无效文件条目。`);
      const targetRelative = relativeComponentPath(row.path, `components.${id}.files.path`);
      if (targets.has(`${id}/${targetRelative}`.toLowerCase())) fail(`小组件 ${id} 的目标路径重复：${targetRelative}`);
      targets.add(`${id}/${targetRelative}`.toLowerCase());
      forbidBundledNrRuntime(targetRelative, `小组件 ${id}`);
      const source = sourceRoot
        ? path.resolve(sourceRoot, relativeComponentPath(row.source || targetRelative, `components.${id}.files.source`))
        : resolveInput(manifestFile, row.source, `components.${id}.files.source`);
      if (sourceRoot) {
        const sourceRelative = path.relative(sourceRoot, source);
        if (!sourceRelative || sourceRelative === '..' || sourceRelative.startsWith(`..${path.sep}`) || path.isAbsolute(sourceRelative)) {
          fail(`小组件 ${id} 的 source 越出 sourceRoot。`, { source: row.source });
        }
      }
      const expected = { bytes: row.bytes, sha256: row.sha256 };
      if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 0 || expected.bytes > COMPONENT_MAX_FILE || !HASH.test(String(expected.sha256 || ''))) {
        fail(`小组件 ${id} 的文件摘要或大小无效。`, { path: targetRelative });
      }
      const checked = await verifyFile(source, expected, `小组件 ${id}/${targetRelative}`);
      totalBytes += checked.bytes;
      if (totalBytes > COMPONENT_MAX_TOTAL) fail('staging 小组件总大小超过 512 MiB；大型 runtime 必须走独立运行包。');
      const target = path.join(componentRoot, ...targetRelative.split('/'));
      copyFile(source, target);
      if (targetRelative === 'component-manifest.json' || targetRelative === 'external-provider-package.json') importerManifestNames.add(targetRelative);
      files.push({ path: `components/${id}/${targetRelative}`, bytes: checked.bytes, sha256: checked.sha256 });
    }
    if (['bridge', 'feeder'].includes(component.kind) && !importerManifestNames.has('component-manifest.json')) {
      fail(`小组件 ${id} 必须随包提供根目录 component-manifest.json，供 Manager 首次启动导入。`);
    }
    catalog.push({
      schema: 'dlss5-component-v1', id, kind: component.kind, version: component.version,
      variant: typeof component.variant === 'string' ? component.variant : 'external',
      architecture: component.architecture, interface: component.interface,
      gameApis: Array.isArray(component.gameApis) ? component.gameApis : [],
      hardwareFamilies: Array.isArray(component.hardwareFamilies) ? component.hardwareFamilies : [],
      inputInterfaces: Array.isArray(component.inputInterfaces) ? component.inputInterfaces : [component.interface],
      compatibleCoreInterfaces: Array.isArray(component.compatibleCoreInterfaces) ? component.compatibleCoreInterfaces : [],
      capabilities: Array.isArray(component.capabilities) ? component.capabilities : [],
      supportsPresent: component.supportsPresent === true,
      validation: component.validation || 'candidate',
      ...(typeof component.defaultEligible === 'boolean' ? { defaultEligible: component.defaultEligible } : {}),
      ...(component.sourceType === 'official-release' ? { sourceType:'official-release' } : {}),
      ...(component.immutable === true ? { immutable:true } : {}),
      ...(typeof component.repository === 'string' ? { repository:component.repository } : {}),
      ...(typeof component.commit === 'string' ? { commit:component.commit } : {}),
      ...(typeof component.downloadUrl === 'string' ? { downloadUrl:component.downloadUrl } : {}),
      source: 'external-staging', files
    });
  }
  const result = { schemaVersion: 1, flavor, packages: catalog };
  fs.writeFileSync(path.join(targetRoot, 'catalog.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return { count: catalog.length, totalBytes, packages: catalog };
}

async function buildBundledResources({ stageRoot, manifest, manifestFile }) {
  const declared = manifest.resources || [];
  if (!Array.isArray(declared)) fail('staging.resources 必须是数组。');
  if (declared.length > BUNDLED_RESOURCE_TARGETS.size) fail('staging.resources 条目过多。');
  const targetRoot = path.join(stageRoot, 'resources');
  for (const target of BUNDLED_RESOURCE_TARGETS) fs.mkdirSync(path.dirname(path.join(targetRoot, target)), { recursive: true });
  const seen = new Set(), files = [];
  for (const row of declared) {
    if (!row || typeof row !== 'object') fail('staging.resources 含无效文件条目。');
    const targetRelative = relativeComponentPath(row.path, 'resources.path');
    if (!BUNDLED_RESOURCE_TARGETS.has(targetRelative)) fail(`resources.path 不在小资源 allow-list：${targetRelative}`);
    if (seen.has(targetRelative.toLowerCase())) fail(`resources.path 重复：${targetRelative}`);
    seen.add(targetRelative.toLowerCase());
    if (!Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > COMPONENT_MAX_FILE || !HASH.test(String(row.sha256 || ''))) {
      fail(`resources 摘要或大小无效：${targetRelative}`);
    }
    const source = resolveInput(manifestFile, row.source, `resources.${targetRelative}.source`);
    const checked = await verifyFile(source, { bytes: row.bytes, sha256: row.sha256 }, `resources/${targetRelative}`);
    const target=path.join(targetRoot, ...targetRelative.split('/'));
    if (targetRelative === 'vulkan-reshade/recipe.json') {
      const recipe=readJson(source);
      // The packaged recipe is relocated at runtime by vulkan-service. Never
      // leak the build machine's original absolute sourceRoot into a release.
      recipe.sourceRoot='.';
      fs.mkdirSync(path.dirname(target),{recursive:true});
      fs.writeFileSync(target,`${JSON.stringify(recipe,null,2)}\n`,{encoding:'utf8',flag:'wx'});
      const packaged=await verifyFile(target,null,'packaged Vulkan ReShade recipe');
      files.push({path:`resources/${targetRelative}`,bytes:packaged.bytes,sha256:packaged.sha256,sourceSha256:checked.sha256});
    } else {
      copyFile(source,target);
      files.push({ path: `resources/${targetRelative}`, bytes: checked.bytes, sha256: checked.sha256 });
    }
  }
  return { count: files.length, files };
}

function buildBridgeReservation({ stageRoot, manifest, components = null }) {
  const bridge = manifest.bridge || { status: 'reserved' };
  if (!['reserved', 'verified'].includes(bridge.status)) fail(`bridge.status 无效：${bridge.status}`);
  if (bridge.status === 'verified') fail('独立 Bridge 仍在兼容任务中；当前打包入口只允许登记 reserved，不会假称已兼容。');
  const target = path.join(stageRoot, 'resources', 'bridge-dlc');
  fs.mkdirSync(target, { recursive: true });
  const candidate = Array.isArray(components)
    ? components.find(row => row?.kind === 'bridge' && row?.validation === 'candidate')
    : null;
  const candidateAddon = candidate?.files?.find(row => /\.addon64$/i.test(String(row.path || '')));
  const record = {
    schemaVersion: 1,
    status: candidate ? 'candidate-staged' : 'reserved',
    id: candidate?.id || bridge.id || 'nigos-dlss5-bridge',
    version: candidate?.version || bridge.version || '1.4.12',
    source: bridge.url || 'https://github.com/NIGos/dlss5-bridge',
    compatible: false,
    note: candidate
      ? '已随 staging 复制候选包并保留 importer manifest；这不代表独立游戏兼容验收已完成。'
      : '仅登记候选资产；兼容性由 bridge-compat-integration-20260912 任务验证后再启用。',
    ...(candidate ? {
      candidateSha256: candidateAddon?.sha256 || null,
      candidateFiles: candidate.files.map(row => ({ path: row.path, bytes: row.bytes, sha256: row.sha256 })),
      defaultEligible: candidate.defaultEligible === true,
      validation: candidate.validation
    } : {})
  };
  fs.writeFileSync(path.join(target, 'manifest.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

async function inspectManifest(manifestFile, flavor = 'base') {
  const manifest = readJson(manifestFile);
  if (manifest.schemaVersion !== 1) fail('staging 清单 schemaVersion 必须为 1。');
  if (!manifest.packageVersion || !/^0\.5\.0-beta\.[234567]$/i.test(String(manifest.packageVersion))) fail('staging 清单 packageVersion 必须为已支持的 0.5.0-beta.2–7。');
  if (!['base', 'offline'].includes(flavor)) fail(`未知打包 flavor：${flavor}`);
  const payloadRoot = resolveInput(manifestFile, manifest.core?.payloadRoot, 'core.payloadRoot');
  const selectedCoreIds = [manifest.core?.version, ...(Array.isArray(manifest.core?.versions) ? manifest.core.versions : [])];
  if (selectedCoreIds.some(id => FORBIDDEN_CORE_VERSION.test(String(id || '')))) fail('清单显式选择了 D13/D14 Core。');
  return { manifest, manifestFile, flavor, payloadRoot };
}

async function stageDistribution({ manifestFile = DEFAULT_MANIFEST, flavor = 'base', outputRoot = path.join(REPO_ROOT, '.packaging-stage', flavor), allowedRoot = path.join(REPO_ROOT, '.packaging-stage'), checkOnly = false } = {}) {
  manifestFile = path.resolve(manifestFile);
  const input = await inspectManifest(manifestFile, flavor);
  if (checkOnly) {
    const resolvedAllowed = path.resolve(allowedRoot);
    if (resolvedAllowed === path.parse(resolvedAllowed).root) fail('校验工作目录不能是磁盘根目录。');
    fs.mkdirSync(resolvedAllowed, { recursive: true });
    const checkRoot = fs.mkdtempSync(path.join(resolvedAllowed, '.check-'));
    try {
      const payload = await buildPayload({ stageRoot: checkRoot, manifest: input.manifest, manifestFile, flavor });
      const mfg = await buildMfg({ stageRoot: checkRoot, manifest: input.manifest, manifestFile });
      const sm86 = await buildSm86({ stageRoot: checkRoot, manifest: input.manifest, manifestFile });
      const components = await buildSmallComponents({ stageRoot: checkRoot, manifest: input.manifest, manifestFile, flavor });
      const resources = await buildBundledResources({ stageRoot: checkRoot, manifest: input.manifest, manifestFile });
      return { ok: true, flavor, manifest: manifestFile, coreVersion: payload.version, coreVersions: payload.versions, sourcePackage: payload.sourcePackage, mfg, sm86, components, resources };
    } finally {
      fs.rmSync(checkRoot, { recursive: true, force: true });
    }
  }
  prepareStageRoot(outputRoot, allowedRoot);
  const payload = await buildPayload({ stageRoot: outputRoot, manifest: input.manifest, manifestFile, flavor });
  const mfg = await buildMfg({ stageRoot: outputRoot, manifest: input.manifest, manifestFile });
  const sm86 = await buildSm86({ stageRoot: outputRoot, manifest: input.manifest, manifestFile });
  const components = await buildSmallComponents({ stageRoot: outputRoot, manifest: input.manifest, manifestFile, flavor });
  const resources = await buildBundledResources({ stageRoot: outputRoot, manifest: input.manifest, manifestFile });
  const bridge = buildBridgeReservation({ stageRoot: outputRoot, manifest: input.manifest, components: components.packages });
  const report = { schemaVersion: 1, packageVersion: input.manifest.packageVersion, flavor, manifest: manifestFile,
    stageRoot: path.resolve(outputRoot), coreVersion: payload.version, coreVersions: payload.versions, sourcePackage: payload.sourcePackage, mfg, sm86, components, resources, bridge,
    runtimeFiles: FAMILIES.map(family => path.join('payload', 'nr-before-sr', 'fixed', family, 'nvngx_dlssnr.dll')) };
  fs.writeFileSync(path.join(outputRoot, 'staging-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

function parseArgs(args) {
  const result = { flavor: 'base', manifestFile: DEFAULT_MANIFEST, checkOnly: false, workRoot: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--manifest' && args[i + 1]) result.manifestFile = args[++i];
    else if (args[i] === '--flavor' && args[i + 1]) result.flavor = args[++i];
    else if (args[i] === '--out' && args[i + 1]) result.outputRoot = args[++i];
    else if (args[i] === '--work-root' && args[i + 1]) result.workRoot = args[++i];
    else if (args[i] === '--check') result.checkOnly = true;
    else if (args[i] === '--json') result.json = true;
    else throw new Error('用法：node scripts/stage-manager-distribution.cjs [--manifest <json>] [--flavor base|offline] [--work-root <目录>] [--out <stage>] [--check]');
  }
  if (result.workRoot) {
    result.allowedRoot = path.resolve(result.workRoot);
    if (!result.outputRoot) result.outputRoot = path.join(result.allowedRoot, 'stage', result.flavor);
  }
  return result;
}

if (require.main === module) {
  stageDistribution(parseArgs(process.argv.slice(2))).then(result => {
    console.log(JSON.stringify(result, null, 2));
  }).catch(error => {
    console.error(JSON.stringify({ ok: false, error: error.message, details: error.details }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = { stageDistribution, inspectManifest, parseArgs, prepareStageRoot, FAMILIES, FIXED_FILES, FORBIDDEN_CORE_VERSION, SMALL_COMPONENT_KINDS, buildPayload, buildSmallComponents, buildBundledResources };
