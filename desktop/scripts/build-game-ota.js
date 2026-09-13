'use strict';
// Produce manual game-plugin update materials. Never invokes an installer,
// writes a game/user-data directory, edits receipts, or claims OTA-import support.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { createLegacyRuntime, DIRECTORY } = require('../src/product/legacy-runtime');
const { UPSTREAM } = require('../src/product/legacy-runtime-catalog');
const { inspectPayload } = require('../src/product/payload');
const { BRIDGES } = require('../src/product/component-registry');
const { PAYLOAD_FILES, INSTALLED_NAMES } = require('../src/product/constants');
const { noLinks, inside } = require('../src/product/launch-safety');
const { getBitness } = require('../src/core/pe');
const { verify: verifyArchive } = require('./verify-release-archive');
const readme = require('./game-ota-readme');
const { ensureDefaultReShadeHotkey } = require('../src/product/hotkeys');

const CORE_VERSION = '0.4.7beta';
const HASH = /^[a-f0-9]{64}$/;
const BINARY = /\.(?:dll|exe|addon(?:32|64)?)$/i;
const FAMILIES = ['RTX40', 'RTX50'];
const ARCHIVE_NAME = `DLSS5-Game-OTA-Core-${CORE_VERSION}-Feeder-${UPSTREAM.version}.zip`;
const fail = message => { throw new Error(message); };
const slash = value => value.replaceAll('\\', '/');
const json = value => JSON.stringify(value, null, 2) + '\n';
const hashBuffer = value => crypto.createHash('sha256').update(value).digest('hex');
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function relative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || /[\x00-\x1f<>:"|?*]/.test(value) ||
      value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)) ||
      path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) fail(`不安全的包内路径：${String(value)}`);
  return value;
}
async function safeSource(root, file) {
  file = path.resolve(file);
  if (!inside(root, file)) fail(`来源路径越出工作区：${file}`);
  await noLinks(file);
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.nlink !== 1) fail(`来源不是独立普通文件：${file}`);
  return stat;
}
async function validateOutput(root, output) {
  const build = path.join(root, 'build'), resolved = path.resolve(root, output);
  if (!inside(build, resolved) || resolved === build) fail('输出必须是此工作区 build 内全新的子目录。');
  await noLinks(resolved);
  if (fs.existsSync(resolved)) fail(`拒绝覆盖已有交付目录：${resolved}`);
  return resolved;
}
function expectedRoutes() {
  const result = [];
  for (const loadingBackend of ['local', 'hoyoshade']) for (const api of ['dx11', 'dx12'])
    for (const hardwareFamily of FAMILIES) result.push({ route: 'native', loadingBackend, api, architecture: 'x64', hardwareFamily });
  for (const loadingBackend of ['local', 'hoyoshade']) for (const api of ['dx9', 'dx10', 'dx11', 'dx12'])
    for (const architecture of ['x86', 'x64']) for (const hardwareFamily of FAMILIES) {
      if (api === 'dx12' && architecture === 'x86') continue;
      if (loadingBackend === 'hoyoshade' && (architecture !== 'x64' || !['dx11', 'dx12'].includes(api))) continue;
      result.push({ route: 'feeder', loadingBackend, api, architecture, hardwareFamily });
    }
  return result;
}
function routeId(route) { return `${route.loadingBackend}-${route.route}-${route.api}-${route.architecture}-${route.hardwareFamily}`; }
function routeBases(route) {
  if (route.loadingBackend === 'hoyoshade') return { active: '管理器此游戏当前显示并核验的活动运行目录；不得使用游戏根目录' };
  if (route.route === 'native') return { addon: '当前 ReShade.ini 实际生效的 Addon 目录；未设置 AddonPath 时按当前已验证加载布局定位',
    config: '当前实际活动 ReShade.ini 所在目录；按管理器显示的活动配置路径定位，可能与 Addon 目录不同' };
  return { game: '实际游戏 EXE 所在目录', runtime: `game/${DIRECTORY}`, addon: `game/${DIRECTORY}/addons` };
}
function targetFor(route, base, target) {
  relative(target);
  if (route.loadingBackend === 'hoyoshade') {
    if (base === 'game') fail(`HoYo 路线不得携带游戏根目录写入：${route.id}/${target}`);
    return { base: 'active', path: target };
  }
  return { base, path: target };
}
function validatePlan(plan) {
  const expected = new Set(expectedRoutes().map(routeId)), ids = new Set(), packageKeys = new Map();
  for (const route of plan.routes) {
    if (!expected.has(route.id) || ids.has(route.id) || route.id !== routeId(route)) fail(`缺失范围以外或重复的路线：${route.id}`);
    ids.add(route.id);
    const targets = new Set();
    for (const row of route.files) {
      relative(row.packagePath); relative(row.target.path);
      if (!Object.hasOwn(route.bases, row.target.base) || !HASH.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 1)
        fail(`组件目标／摘要无效：${route.id}/${row.packagePath}`);
      const key = `${row.target.base}/${row.target.path}`.toLowerCase();
      if (targets.has(key)) fail(`路线目标重复：${route.id}/${key}`); targets.add(key);
      if (row.referenceOnly && !row.packagePath.endsWith('.example')) fail('配置参考必须使用 .example 后缀。');
      if (/\.(ini|cfg)$/i.test(row.target.path) && !row.referenceOnly) fail('禁止把个人配置放入可直接替换的文件组。');
      if (row.role === 'nr-runtime' && !row.packagePath.startsWith(`共享NR运行库/${route.hardwareFamily}/`)) fail('NR 运行库必须按显卡族共用。');
      if (route.route === 'native' && route.api !== 'dx11' && row.role === 'carrier') fail('DX12 不应安装 DX11 桥接器。');
      if (route.loadingBackend === 'hoyoshade' && row.target.base !== 'active') fail('HoYo 目标必须是当前活动运行目录。');
    }
    if (route.files.filter(row => row.role === 'core').length !== 1 || route.files.filter(row => row.role === 'nr-runtime').length !== 1)
      fail(`路线必须包含且仅包含一个 Core 和匹配 NR 运行库：${route.id}`);
    const requiredRoles = ['chain', 'core-config', ...(route.route === 'native' ? [
      ...(route.api === 'dx11' ? ['carrier'] : []), ...(route.loadingBackend === 'hoyoshade' ? ['loader'] : [])
    ] : ['provider', 'preset', ...(route.loadingBackend === 'local' ? ['game-loader'] : []),
      ...(route.api === 'dx9' ? ['api-wrapper'] : []), ...(route.hostRequired ? ['host', 'host-loader'] : [])])];
    for (const role of requiredRoles) if (route.files.filter(row => row.role === role).length !== 1) fail(`路线组件缺失或重复：${route.id}/${role}`);
    if (route.route === 'feeder' && route.hostRequired) {
      for (const row of route.files.filter(row => ['core', 'chain', 'nr-runtime'].includes(row.role)))
        if (row.target.base !== 'addon' || !row.target.path.startsWith('host64/addons/')) fail('宿主消费者组件目录与正式 recipe 不一致。');
    }
  }
  if (ids.size !== expected.size) fail(`要求 ${expected.size} 套完整路线，实际 ${ids.size} 套。`);
  for (const file of plan.files) {
    relative(file.packagePath);
    const key = file.packagePath.toLowerCase();
    if (packageKeys.has(key)) fail(`包内路径重复或大小写冲突：${file.packagePath}`);
    if (!HASH.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 1) fail('包内文件摘要／长度无效。');
    packageKeys.set(key, file);
  }
  for (const route of plan.routes) for (const row of route.files) {
    const file = packageKeys.get(row.packagePath.toLowerCase());
    if (!file || file.packagePath !== row.packagePath || file.sha256 !== row.sha256 || file.bytes !== row.bytes) fail('路径清单引用的文件缺失或身份不符。');
  }
  const runtimes = plan.files.filter(file => file.packagePath.startsWith('共享NR运行库/'));
  if (runtimes.length !== 2 || new Set(runtimes.map(file => file.sha256)).size !== 2) fail('共享运行库必须恰好是 RTX 40 / 50 两个不同文件。');
  return plan;
}

async function collectPlan({ root, mfg }) {
  root = path.resolve(root);
  const plan = { schema: 'game-plugin-manual-update-v1', coreVersion: CORE_VERSION, feederVersion: UPSTREAM.version,
    managerOtaImportSupported: false, createdAt: new Date().toISOString(), routes: [], files: [], sourceSnapshots: [],
    acceptance: { filesVerified: false, finalDefenderScan: 'pending-release-owner', realRtx40Verified: false } };
  const outputPaths = new Map(), validated = new Map();
  async function addFile(source, packagePath, expected, architecture = null, provenance = null) {
    relative(packagePath);
    if (!HASH.test(expected || '')) fail(`来源缺少固定摘要：${source}`);
    const absolute = path.resolve(source), stat = await safeSource(root, absolute), key = absolute.toLowerCase();
    let checked = validated.get(key);
    if (!checked) {
      const sha256 = await digest(absolute);
      checked = { sha256, bytes: stat.size, architecture: BINARY.test(absolute) ? (getBitness(absolute) === 32 ? 'x86' : getBitness(absolute) === 64 ? 'x64' : 'unknown') : null };
      validated.set(key, checked);
    }
    if (checked.sha256 !== expected || architecture && checked.architecture !== architecture) fail(`来源摘要或位数不符：${slash(path.relative(root, absolute))}`);
    const old = outputPaths.get(packagePath.toLowerCase());
    if (old) {
      if (old.packagePath !== packagePath || old.sha256 !== expected || old.bytes !== checked.bytes) fail(`包内目标发生碰撞：${packagePath}`);
      return old;
    }
    const row = { packagePath, source: slash(path.relative(root, absolute)), sha256: expected, bytes: checked.bytes, architecture, provenance };
    plan.files.push(row); outputPaths.set(packagePath.toLowerCase(), row); return row;
  }
  function addText(content, packagePath) {
    relative(packagePath); if (outputPaths.has(packagePath.toLowerCase())) fail(`生成文件路径重复：${packagePath}`);
    const row = { packagePath, content, sha256: hashBuffer(Buffer.from(content)), bytes: Buffer.byteLength(content), architecture: null, provenance: { type: 'generated-explanation-or-reference' } };
    plan.files.push(row); outputPaths.set(packagePath.toLowerCase(), row); return row;
  }
  async function snapshot(source, packagePath) {
    await safeSource(root, path.join(root, source));
    const expected = await digest(path.join(root, source));
    plan.sourceSnapshots.push({ source, sha256: expected });
    return addFile(path.join(root, source), packagePath, expected);
  }
  const nativeRoot = path.join(root, 'payload/nr-before-sr');
  const native = inspectPayload(nativeRoot, { version: CORE_VERSION });
  const version = native.versions?.[CORE_VERSION];
  if (native.selectedVersion !== CORE_VERSION || !version?.ready) fail('原生 Core 0.4.7beta 配套不完整或摘要错误。');
  const pool = createLegacyRuntime({ appDir: root });
  const poolManifest = JSON.parse(await fsp.readFile(path.join(pool.root, 'manifest.json'), 'utf8'));
  if (poolManifest.coreVersion !== CORE_VERSION || poolManifest.upstream?.version !== UPSTREAM.version || poolManifest.coreInterface !== 'NRExternalProviderV1')
    fail('Feeder 的真实 Core／版本／接口与本次交付范围不符。');
  if (version.variants.RTX40.files.find(row => row.kind === 'addon').actual === poolManifest.assets.find(row => row.id === 'core')?.sha256)
    fail('Feeder ExternalProvider Core 不能与原生 Core 混用。');
  await snapshot('payload/nr-before-sr/bundle.json', '许可证与来源/native-bundle.json');
  await snapshot('resources/legacy-runtime/manifest.json', '许可证与来源/feeder-manifest.json');
  await snapshot('src/product/legacy-runtime-lock.js', '许可证与来源/feeder-runtime-lock.js.txt');
  for (const source of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'UPSTREAM.md', 'resources/vulkan-reshade/LICENSE.md'])
    await snapshot(source, `许可证与来源/${source.includes('vulkan-reshade') ? 'ReShade-LICENSE.md' : path.basename(source)}`);
  // Validate every expected route; a blocked or missing recipe aborts the whole build.
  for (const wanted of expectedRoutes()) {
    const route = { ...wanted, id: routeId(wanted), coreVersion: CORE_VERSION, feederVersion: wanted.route === 'feeder' ? UPSTREAM.version : null,
      coreInterface: wanted.route === 'feeder' ? 'NRExternalProviderV1' : 'native-NR-before-SR', files: [] };
    route.bases = routeBases(route);
    route.label = `${route.loadingBackend === 'local' ? '本地' : 'HoYo'}-${route.route === 'native' ? `原生-Core-${CORE_VERSION}` : `Feeder-${UPSTREAM.version}-Core-${CORE_VERSION}`}-${route.api.toUpperCase()}-${route.architecture}-${route.hardwareFamily}`;
    route.directory = `分路线更新材料/${route.label}`;
    const push = (file, base, target, role, referenceOnly = false) => {
      route.files.push({ packagePath: file.packagePath, target: targetFor(route, base, target), role, referenceOnly,
        sha256: file.sha256, bytes: file.bytes, architecture: file.architecture, provenance: file.provenance });
    };
    if (route.route === 'native') {
      const files = version.variants[route.hardwareFamily].files;
      for (const kind of ['addon', 'bridge', 'runtime', 'config', ...(route.api === 'dx11' ? ['carrier'] : []), ...(route.loadingBackend === 'hoyoshade' ? ['reshade'] : [])]) {
        const item = files.find(row => row.kind === kind);
        if (!item?.valid || !item.expected) fail(`原生组件缺失：${route.id}/${kind}`);
        if (kind === 'carrier' && item.actual !== BRIDGES.find(row => row.default)?.sha256) fail('原生 DX11 默认桥接器不是固定 NIGos 1.4.12 NR 适配版。');
        const target = kind === 'reshade' ? PAYLOAD_FILES.reshade : INSTALLED_NAMES[kind];
        const reference = kind === 'config', shared = kind === 'runtime';
        const relativePath = shared ? `共享NR运行库/${route.hardwareFamily}/${target}` : `${route.directory}/${reference ? '配置参考（勿覆盖）' : '替换文件'}/${route.loadingBackend === 'hoyoshade' ? 'active' : 'addon'}/${target}${reference ? '.example' : ''}`;
        const file = await addFile(item.file, relativePath, item.expected, reference ? null : 'x64', { version: CORE_VERSION, source: version.source,
          ...(kind === 'carrier' ? { component: BRIDGES.find(row => row.default).id } : {}) });
        push(file, 'addon', target, ({ addon: 'core', bridge: 'chain', runtime: 'nr-runtime', config: 'core-config', reshade: 'loader' })[kind] || kind, reference);
      }
      const nativeConfig = addText(ensureDefaultReShadeHotkey(''), `${route.directory}/配置参考（勿覆盖）/${route.loadingBackend === 'hoyoshade' ? 'active' : 'config'}/ReShade.ini.example`);
      push(nativeConfig, 'config', 'ReShade.ini', 'configuration-reference', true);
      route.acceptance = { filesVerified: true, realGameVerified: false };
    } else {
      const { route: ignored, ...selection } = wanted;
      const pkg = pool.load(selection), recipe = pkg.recipe;
      if (recipe.deliveryBlocked || recipe.loadingBackend !== route.loadingBackend || recipe.coreVersion !== CORE_VERSION) fail(`配套被阻止或身份不符：${route.id}`);
      route.hostRequired = recipe.hostRequired; route.transport = recipe.transport; route.recipeFingerprint = pkg.fingerprint;
      route.poolFingerprint = recipe.poolFingerprint; route.acceptance = { ...recipe.acceptance, filesVerified: true };
      route.recipe = recipe;
      for (const item of recipe.files) {
        const reference = item.mutable || ['core-config', 'preset'].includes(item.role) || /\.(ini|cfg)$/i.test(item.target);
        const shared = item.role === 'nr-runtime', base = route.loadingBackend === 'hoyoshade' ? 'active' : item.base;
        const packagePath = shared ? `共享NR运行库/${route.hardwareFamily}/nvngx_dlssnr.dll` : `${route.directory}/${reference ? '配置参考（勿覆盖）' : '替换文件'}/${base}/${item.target}${reference ? '.example' : ''}`;
        const file = await addFile(path.join(pkg.root, item.source), packagePath, item.sha256, item.architecture, item.provenance || { source: 'fixed-feeder-manifest', role: item.role });
        if (file.bytes !== item.bytes) fail(`配套文件长度不符：${item.source}`);
        push(file, item.base, item.target, item.role, reference);
      }
      const configs = [{ base: 'addon', target: 'dlss5-feed.cfg', text: recipe.defaults.feeder },
        { base: route.loadingBackend === 'hoyoshade' ? 'runtime' : 'game', target: 'ReShade.ini', text: route.loadingBackend === 'hoyoshade' ? readme.hoyoFeederConfig(recipe.defaults) : readme.localFeederConfig(recipe.defaults) }];
      if (recipe.hostRequired) configs.push({ base: 'addon', target: 'host64/ReShade.ini', text: ensureDefaultReShadeHotkey('[ADDON]\r\nAddonPath=.\\addons\r\n') });
      if (recipe.gameApi === 'dx9') configs.push({ base: 'addon', target: 'host64/NRGuides.ini', text: recipe.defaults.hostGuides });
      for (const config of configs) {
        const target = targetFor(route, config.base, config.target);
        const file = addText(config.text, `${route.directory}/配置参考（勿覆盖）/${target.base}/${target.path}.example`);
        push(file, config.base, config.target, 'configuration-reference', true);
      }
    }
    addText(json(route), `${route.directory}/目标路径清单.json`);
    addText(readme.routeReadme(route), `${route.directory}/更新说明.txt`);
    plan.routes.push(route);
  }
  const fallback = BRIDGES.find(row => row.id === 'nigos-1.4.11-nr');
  if (!fallback) fail('缺少明确的 1.4.11 桥接器回退目录。');
  await addFile(path.join(nativeRoot, 'versions', fallback.sourceVersion, INSTALLED_NAMES.carrier),
    `独立组件/桥接器回退/${INSTALLED_NAMES.carrier}`, fallback.sha256, 'x64', fallback);
  addText('仅供原生 DX11 Core 0.4.7beta 配套明确回退。退出游戏，备份并移出活动目录中的 1.4.12 桥接器后，以本文件替换同名文件；不要同时加载两版，不替换 Core／nrchain，不用于 Feeder 或 DX12。\n来源：https://github.com/smartLanny/dlss5-nr-before-sr-lab/issues/224\n实际游戏 NR 状态仍需验证。\n', '独立组件/桥接器回退/说明.txt');
  // The independent MFG archive has its own payload verifier and provider hashes.
  const mfgFile = path.resolve(root, mfg), mfgReportFile = path.join(path.dirname(mfgFile), 'staging-report.json');
  await safeSource(root, mfgReportFile);
  const mfgReport = JSON.parse(await fsp.readFile(mfgReportFile, 'utf8'));
  if (!HASH.test(mfgReport.sha256 || '') || typeof mfgReport.file !== 'string' || path.resolve(mfgReport.file) !== mfgFile || mfgReport.providers?.length !== 3) fail('独立 MFG ZIP 缺少配套 staging-report.json。');
  const mfgRow = await addFile(mfgFile, '独立组件/RTX40-MFGUnlock-0.7-zh-CN.zip', mfgReport.sha256, null, { version: '0.7-zh-CN', providers: mfgReport.providers });
  if (mfgRow.bytes !== mfgReport.bytes) fail('独立 MFG ZIP 长度不符。');
  addText(json({ ...mfgReport, file: mfgRow.packagePath }), '独立组件/MFG-来源与校验.json');
  addText(readme.overview(plan), '请先阅读-更新与回退说明.txt');
  addText(json({ schema: plan.schema, coreVersion: plan.coreVersion, feederVersion: plan.feederVersion,
    managerOtaImportSupported: false, routeCount: plan.routes.length,
    routes: plan.routes.map(({ id, label, directory, coreInterface, hostRequired, acceptance }) => ({ id, label, directory, coreInterface, hostRequired, acceptance })) }), '路线索引.json');
  plan.acceptance.filesVerified = true;
  return validatePlan(plan);
}

async function writePackage({ root, output, plan, zipExecutable }) {
  root = path.resolve(root); output = await validateOutput(root, output); validatePlan(plan);
  // Preflight all unique sources before creating the delivery directory.
  const preflight = new Map();
  for (const file of plan.files) {
    if (Object.hasOwn(file, 'content')) {
      if (hashBuffer(Buffer.from(file.content)) !== file.sha256 || Buffer.byteLength(file.content) !== file.bytes) fail('生成内容在预览后发生改变。');
    } else {
      relative(file.source);
      const source = path.join(root, file.source); await safeSource(root, source);
      const key = source.toLowerCase();
      if (!preflight.has(key)) preflight.set(key, { sha256: await digest(source), bytes: (await fsp.stat(source)).size });
      const current = preflight.get(key);
      if (current.sha256 !== file.sha256 || current.bytes !== file.bytes) fail(`来源在预览后改变：${file.source}`);
    }
  }
  for (const snapshot of plan.sourceSnapshots || []) if (await digest(path.join(root, snapshot.source)) !== snapshot.sha256) fail(`来源目录清单在预览后改变：${snapshot.source}`);
  const archiveTool = zipExecutable || require('7zip-bin').path7za;
  await safeSource(root, archiveTool);
  await fsp.mkdir(output); // Deliberately no recursive overwrite or cleanup on failure.
  const directory = path.join(output, 'unpacked'); await fsp.mkdir(directory);
  const manifest = [];
  for (const file of plan.files) {
    const target = path.join(directory, file.packagePath); await fsp.mkdir(path.dirname(target), { recursive: true });
    if (Object.hasOwn(file, 'content')) await fsp.writeFile(target, file.content, { flag: 'wx' });
    else {
      const source = path.join(root, file.source); await safeSource(root, source);
      await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    }
    if ((await fsp.stat(target)).size !== file.bytes || await digest(target) !== file.sha256) fail(`写入校验失败：${file.packagePath}`);
    manifest.push({ file: file.packagePath, bytes: file.bytes, sha256: file.sha256 });
  }
  for (const snapshot of plan.sourceSnapshots || []) if (await digest(path.join(root, snapshot.source)) !== snapshot.sha256) fail(`构建期间来源目录清单改变：${snapshot.source}`);
  await fsp.writeFile(path.join(directory, '文件校验.json'), json({ schema: 1, excludedSelf: '文件校验.json', files: manifest }), { flag: 'wx' });
  const archive = path.join(output, ARCHIVE_NAME);
  await execFile(archiveTool, ['a', '-tzip', '-mx=5', '-mmt=2', '-bd', '-y', archive, '.'], { cwd: directory, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const verified = await verifyArchive(archive, directory);
  const report = { schema: 1, coreVersion: plan.coreVersion, feederVersion: plan.feederVersion, routeCount: plan.routes.length,
    sharedNrRuntimeCount: 2, managerOtaImportSupported: false, acceptance: plan.acceptance, ...verified };
  await fsp.writeFile(path.join(output, 'build-report.json'), json(report), { flag: 'wx' });
  return report;
}
function parseArgs(args) {
  const options = { root: path.resolve(__dirname, '..'), mfg: 'build/beta3-manual-mfg/RTX40-MFGUnlock-0.7-zh-CN.zip' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') options.check = true;
    else if (['--output', '--mfg'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const name = args[i].slice(2); options[name] = args[++i];
    }
    else fail(`未知或不完整参数：${args[i]}`);
  }
  if (!options.check && !options.output) fail('用法：node scripts/build-game-ota.js --check | --output build/全新目录 [--mfg build/目录/独立MFG.zip]');
  return options;
}
if (require.main === module) (async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.output) await validateOutput(options.root, options.output);
  const plan = await collectPlan(options);
  if (options.check) console.log(json({ ok: true, routes: plan.routes.length, files: plan.files.length, sharedNrRuntimes: 2, coreVersion: plan.coreVersion, feederVersion: plan.feederVersion, wroteFiles: false }));
  else console.log(json(await writePackage({ ...options, plan })));
})().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { CORE_VERSION, ARCHIVE_NAME, relative, validateOutput, expectedRoutes, routeId, routeBases, targetFor,
  validatePlan, collectPlan, writePackage, parseArgs };
