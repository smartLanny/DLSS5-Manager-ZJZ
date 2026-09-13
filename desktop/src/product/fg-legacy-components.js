'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const journalDefault = require('../core/file-journal');
const peDefault = require('../core/pe');
const { createInstallGuards } = require('../core/install-guards');
const { detectGpuAsync: detectGpu } = require('./gpu');
const { readManifest } = require('./manifest');
const { planRtx40Mfg } = require('./launch-profile-plan');
const { appError } = require('./errors');
const { noLinks, atomicJson } = require('./launch-safety');
const { inspectVcRuntime } = require('./windows-runtime');

const HASH = /^[a-f0-9]{64}$/;
const CONTROL = 'RTX40MFG-Universal.json';
const LEGACY = ['RTX40MFG-Universal.asi', 'RTX40MFG-Bridge.asi'];
const LEGACY_PATHS = [path.join('plugins', 'cyber_engine_tweaks', 'mods', 'RTX40MFG', 'init.lua'),
  path.join('plugins', 'RTX40MFG.asi'), path.join('plugins', 'RTX40MFG-Universal.asi'), path.join('plugins', 'RTX40MFG-Bridge.asi')];
const DEFAULT_CONTROL = `${JSON.stringify({ version: 11, followGame: true, mode: 'follow', multiplier: 2,
  dynamicTargetFrameRate: 0, dynamicExperimental56: false }, null, 2)}\n`;
const REQUIRED_UAL = Object.freeze({ LoadPlugins: '1', LoadFromScriptsOnly: '1', DontLoadFromDllMain: '0', ForceEntryPointHook: '0' });
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = file => { try { return sha256(fs.readFileSync(file)); } catch { return null; } };
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function fail(code, message, details) { throw Object.assign(new Error(message), { code, details }); }

function mergeUalConfig(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 64 * 1024 || /\0|\uFFFD/.test(text)) fail('SETTINGS_FG_UAL_CONFIG', 'UAL 配置不是可安全合并的 UTF-8 文本。');
  const newline = text.includes('\r\n') ? '\r\n' : '\n', bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/); let section = '', globalCount = 0, globalStart = -1, globalEnd = lines.length; const keys = new Map();
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^\s*\[([^\]]+)\]\s*(?:[;#].*)?$/);
    if (header) { const next = header[1].trim().toLowerCase(); if (section === 'globalsets' && globalEnd === lines.length) globalEnd = i; section = next; if (section === 'globalsets') { globalCount++; globalStart = i; } continue; }
    const entry = lines[i].match(/^\s*([^;#][^=]*?)\s*=\s*(.*?)\s*$/);
    if (section === 'globalsets' && entry) {
      const key = entry[1].trim().toLowerCase(); if (keys.has(key)) fail('SETTINGS_FG_UAL_CONFIG', 'UAL GlobalSets 存在重复键，未覆盖。');
      keys.set(key, { index: i, value: entry[2] });
    }
  }
  if (globalCount > 1) fail('SETTINGS_FG_UAL_CONFIG', 'UAL 配置含重复 GlobalSets 节，未覆盖。');
  if (!globalCount) { if (lines.length && lines.at(-1) !== '') lines.push(''); lines.push('[GlobalSets]'); globalStart = lines.length - 1; globalEnd = lines.length; }
  const additions = [];
  for (const [key, value] of Object.entries(REQUIRED_UAL)) {
    const row = keys.get(key.toLowerCase());
    if (row) { if (key !== 'LoadFromScriptsOnly') lines[row.index] = `${key}=${value}`; }
    else additions.push(`${key}=${value}`);
  }
  const extra = keys.get('loadextraplugins');
  if (extra) {
    const plugins = extra.value.split('|').map(value => value.trim()).filter(Boolean);
    if (!plugins.some(value => value.replace(/^"|"$/g, '').replace(/\\/g, '/').toLowerCase() === 'rtx40mfg.asi')) plugins.push('RTX40MFG.asi');
    lines[extra.index] = `LoadExtraPlugins=${plugins.join(' | ')}`;
  } else additions.push('LoadExtraPlugins=RTX40MFG.asi');
  lines.splice(globalEnd, 0, ...additions);
  const result = bom + lines.join(newline); return result.endsWith(newline) ? result : result + newline;
}

function validControl(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 4096) return false;
  try { planRtx40Mfg(text, { mode: 'follow' }); return true; } catch { return false; }
}

function createFgComponents(options = {}) {
  if (typeof options.gameDirectory !== 'function' || typeof options.gameExecutable !== 'function') fail('SETTINGS_FG_INIT', 'FG 组件服务缺少游戏路径依赖。');
  const resources = fs.existsSync(path.join(options.resourcesPath || '', 'fg-components', 'manifest.json'))
    ? path.join(options.resourcesPath, 'fg-components') : path.join(options.appDir || '', 'resources', 'fg-components');
  const journal = options.journal || journalDefault, pe = options.pe || peDefault, guards = options.guards || createInstallGuards();
  const detectHardware = options.detectHardware || detectGpu, scan = options.scan || (async () => ({ api: 'unknown', streamlineFg: false, reshadeAddon: false }));
  const assertGameClosed = options.assertGameClosed || guards.assertGameClosed;
  const antiCheatPresent = options.antiCheatPresent || guards.antiCheatPresent;
  const getReShadeSource = options.getReShadeSource || (() => null);
  const inspectRuntime = options.inspectRuntime || inspectVcRuntime;
  function target(id) {
    const game = options.gameDirectory(id), exe = options.gameExecutable(id);
    if (typeof game !== 'string' || typeof exe !== 'string' || !path.isAbsolute(game) || !path.isAbsolute(exe) || path.extname(exe).toLowerCase() !== '.exe') fail('SETTINGS_FG_TARGET', '游戏 EXE 无效。');
    const rel = path.relative(path.resolve(game), path.resolve(exe)); if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) fail('SETTINGS_FG_TARGET', '游戏 EXE 不在所选目录内。');
    return { id, game: path.resolve(game), exe: path.resolve(exe), dir: path.dirname(path.resolve(exe)) };
  }
  function readResourceManifest(verifyFiles = true) {
    const file = path.join(resources, 'manifest.json'); let value;
    try { if (fs.statSync(file).size > 128 * 1024) throw new Error('large'); } catch { fail('SETTINGS_FG_RESOURCES', 'RTX40 FG 组件清单缺失或过大。'); }
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('SETTINGS_FG_RESOURCES', 'RTX40 FG 组件清单缺失或损坏。'); }
    const roles = ['core', 'asi', 'overlay', 'ual', 'ualConfig'];
    if (value.version !== 1 || value.protocol !== 11 || typeof value.id !== 'string' || !value.files ||
        roles.some(role => !value.files[role] || path.basename(value.files[role].file || '') !== value.files[role].file || !HASH.test(value.files[role].sha256 || '')) ||
        !Array.isArray(value.ualProxyNames) || value.ualProxyNames.some(name => !['dinput8.dll', 'version.dll', 'winmm.dll'].includes(String(name).toLowerCase()))) fail('SETTINGS_FG_RESOURCES', 'RTX40 FG 组件清单格式无效。');
    for (const role of roles) { const row = value.files[role], source = path.join(resources, row.file); if (verifyFiles && fileHash(source) !== row.sha256) fail('SETTINGS_FG_RESOURCES', `RTX40 FG 资源校验失败：${row.file}`); row.source = source; }
    return value;
  }
  function receiptFile(t) { return path.join(t.game, '_DLSS5_Backup', 'xiaofeng-fg-components.json'); }
  function readReceipt(t, reshadeHash = null) {
    const file = receiptFile(t); journal.safePath(t.game, path.relative(t.game, file)); if (!fs.existsSync(file)) return null;
    let value; try { if (fs.statSync(file).size > 512 * 1024) throw new Error('large'); value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('SETTINGS_FG_RECEIPT', 'FG 组件恢复记录损坏。'); }
    const manifest = readResourceManifest(false);
    if (!value || value.version !== 1 || value.id !== manifest.id || value.protocol !== 11 || !samePath(value.exe, t.exe) ||
        !manifest.ualProxyNames.map(name => name.toLowerCase()).includes(String(value.proxy).toLowerCase()) || !Array.isArray(value.files) || !value.files.length || value.files.length > 8) fail('SETTINGS_FG_RECEIPT', 'FG 组件恢复记录无效。');
    const proxy = String(value.proxy).toLowerCase(), expected = {
      core: manifest.files.core.file, asi: manifest.files.asi.file, overlay: manifest.files.overlay.file, ual: proxy,
      ualConfig: `${path.basename(proxy, '.dll')}.ini`, control: CONTROL, reshade: 'dxgi.dll'
    };
    const seen = new Set();
    for (const row of value.files) {
      const name = path.basename(row.rel || '').toLowerCase();
      const expectedName = expected[row.role], expectedRel = expectedName && path.relative(t.game, path.join(t.dir, expectedName));
      if (!expectedName || path.normalize(row.rel || '').toLowerCase() !== path.normalize(expectedRel).toLowerCase() || seen.has(row.role) ||
          !['created', 'modified', 'adopted'].includes(row.mode) || row.mode === 'modified' && row.role !== 'ualConfig' || !HASH.test(row.after || '') ||
          row.mode === 'modified' && (typeof row.beforeText !== 'string' || Buffer.byteLength(row.beforeText) > 64 * 1024 || !HASH.test(row.before || '') || sha256(Buffer.from(row.beforeText, 'utf8')) !== row.before)) fail('SETTINGS_FG_RECEIPT', 'FG 组件文件记录无效。');
      if (row.mode === 'created' && row.role === 'control' && row.after !== sha256(Buffer.from(DEFAULT_CONTROL, 'utf8'))) fail('SETTINGS_FG_RECEIPT', 'FG control 恢复记录无效。');
      const fixedHash = { core: manifest.files.core.sha256, asi: manifest.files.asi.sha256, overlay: manifest.files.overlay.sha256, ual: manifest.files.ual.sha256 }[row.role];
      if (fixedHash && row.after !== fixedHash || row.role === 'reshade' && (!HASH.test(reshadeHash || '') || row.after !== reshadeHash)) fail('SETTINGS_FG_RECEIPT', 'FG 组件哈希记录无效。');
      journal.safePath(t.game, row.rel); seen.add(row.role);
    }
    if (['core', 'asi', 'overlay', 'ual', 'ualConfig', 'control'].some(role => !seen.has(role))) fail('SETTINGS_FG_RECEIPT', 'FG 组件恢复记录不完整。');
    return value;
  }
  function nrOwnsReShade(t, rel) {
    try { const manifest = readManifest(t.game); return Boolean(manifest?.files?.some(row => path.normalize(row.rel || '').toLowerCase() === path.normalize(rel).toLowerCase() && row.kind === 'reshade')); }
    catch { fail('SETTINGS_FG_RECEIPT', '现有安装记录损坏，无法判断共用 ReShade 归属。'); }
  }
  async function facts(id) {
    const t = target(id); await noLinks(t.exe); const hardware = await detectHardware(), series = [...new Set(Array.isArray(hardware?.series) ? hardware.series : [])], observed = await scan(id);
    if (series.length === 1 && series[0] === 'RTX50') return { t, hardware, observed, route: 'native' };
    if (!(series.length === 1 && series[0] === 'RTX40')) return { t, hardware, observed, route: 'unsupported' };
    return { t, hardware, observed, route: 'compatibility' };
  }
  async function inspect(id) {
    const f = await facts(id), { t, observed, route } = f;
    await noLinks(receiptFile(t));
    if (route === 'native') {
      let owned = null; try { const reshade = fs.existsSync(receiptFile(t)) ? await getReShadeSource(id) : null; owned = readReceipt(t, reshade?.sha256); } catch (error) { return { route, ready: false, needsCleanup: false, managed: false, missing: [], blockers: [error.message], canPrepare: false, components: [], api: observed?.api || 'unknown', exe: t.exe }; }
      if (owned) return { route, ready: false, needsCleanup: true, managed: true, missing: [], blockers: [], canPrepare: false,
        components: owned.files.map(row => ({ role: row.role, name: path.basename(row.rel), status: 'installed', owned: row.mode !== 'adopted' })), api: observed?.api || 'unknown', exe: t.exe };
      let manifest = null; try { manifest = readResourceManifest(); } catch {}
      const names = [manifest?.files.core.file || 'RTX40MFGCore.dll', manifest?.files.asi.file || 'RTX40MFG.asi',
        manifest?.files.overlay.file || 'RTX40MFG-UI.addon64', ...LEGACY, ...LEGACY_PATHS];
      const leftovers = names.filter(name => fs.existsSync(path.join(t.dir, name)));
      return { route, ready: leftovers.length === 0, needsCleanup: false, managed: false, missing: [],
        blockers: leftovers.length ? [`检测到非本工具收据管理的 RTX40 组件：${leftovers.join('、')}。请人工核对，不会自动删除。`] : [], canPrepare: false,
        components: leftovers.map(name => ({ role: 'compatibility', name, status: 'external', owned: false })), api: observed?.api || 'unknown', exe: t.exe };
    }
    if (route === 'unsupported') return { route, ready: false, missing: [], blockers: ['仅 RTX 40 使用社区兼容组件；RTX 50 使用原生 FG。'], canPrepare: false, components: [], api: observed?.api || 'unknown', exe: t.exe };
    const blockers = [], missing = [], components = []; let manifest = null;
    let runtime;
    try { runtime = await inspectRuntime({ applicationDirectory: t.dir }); }
    catch { runtime = { status: 'unknown', ready: false, missing: [], message: '无法读取或验证 Windows x64 VC++ 运行库文件。' }; }
    if (!runtime || runtime.ready !== true || runtime.status !== 'available') {
      if (!runtime || !['missing', 'unknown'].includes(runtime.status)) runtime = { status: 'unknown', ready: false, missing: [], message: '无法读取或验证 Windows x64 VC++ 运行库文件。' };
      blockers.push(runtime.message || 'RTX40 FG 需要 Windows x64 VC++ 运行库。');
    }
    try { manifest = readResourceManifest(); } catch (error) { blockers.push(error.message); }
    if (pe.getBitness(t.exe) !== 64) blockers.push('所选程序不是 Windows x64 游戏 EXE。');
    if (observed?.api !== 'dx12') blockers.push(observed?.api === 'unknown' ? '请先确认游戏实际使用 DirectX 12。' : '当前只为 DirectX 12 准备 RTX40 FG 兼容组件。');
    if (observed?.streamlineFg !== true) blockers.push('未确认游戏已有可用的 Streamline DLSS Frame Generation。');
    for (const name of LEGACY) if (fs.existsSync(path.join(t.dir, name))) blockers.push(`检测到旧组件 ${name}，请先人工核对，不会自动删除。`);
    for (const rel of LEGACY_PATHS) if (fs.existsSync(path.join(t.dir, rel))) blockers.push(`检测到旧 RTX40 MFG 路径 ${rel}；不会同时安装两套前端，请先人工迁移。`);
    const imports = new Set((pe.getImports(t.exe) || []).map(name => String(name).toLowerCase()));
    const proxyCandidates = manifest ? manifest.ualProxyNames.map(name => name.toLowerCase()).filter(name => imports.has(name)) : [];
    const existingProxies = proxyCandidates.map(name => ({ name, hash: fileHash(path.join(t.dir, name)) })).filter(row => row.hash);
    const foreignProxies = existingProxies.filter(row => row.hash !== manifest?.files.ual.sha256), verifiedProxies = existingProxies.filter(row => row.hash === manifest?.files.ual.sha256);
    if (verifiedProxies.length > 1) blockers.push('检测到多个 UAL 代理副本，未继续叠加加载器。');
    const proxy = verifiedProxies[0]?.name || proxyCandidates.find(name => !fileHash(path.join(t.dir, name))) || null;
    if (!proxy && foreignProxies.length) blockers.push(`所有可用代理名均被其他文件占用：${foreignProxies.map(row => row.name).join('、')}，不会覆盖。`);
    if (!proxy) blockers.push('EXE 没有静态导入可用的早期 UAL 代理（dinput8/version/winmm）。');
    const rows = manifest ? [['core', manifest.files.core.file, manifest.files.core.sha256], ['asi', manifest.files.asi.file, manifest.files.asi.sha256],
      ['overlay', manifest.files.overlay.file, manifest.files.overlay.sha256], ['ual', proxy, manifest.files.ual.sha256]] : [];
    for (const [role, name, hash] of rows) {
      if (!name) continue; const file = path.join(t.dir, name), actual = fileHash(file), status = !actual ? 'missing' : actual === hash ? 'ready' : 'external';
      if (status === 'missing') missing.push(name); if (status === 'external') blockers.push(`${name} 已存在且不是已验证组件，不会覆盖。`);
      components.push({ role, name, status, owned: false });
    }
    let configStatus = 'missing';
    if (proxy) {
      const ini = `${path.basename(proxy, '.dll')}.ini`, file = path.join(t.dir, ini);
      if (fs.existsSync(file)) { try { configStatus = mergeUalConfig(fs.readFileSync(file, 'utf8')) === fs.readFileSync(file, 'utf8') ? 'ready' : 'needs-update'; } catch (error) { configStatus = 'external'; blockers.push(error.message); } }
      else missing.push(ini);
      components.push({ role: 'ualConfig', name: ini, status: configStatus, owned: false });
    }
    const controlFile = path.join(t.dir, CONTROL), controlStatus = !fs.existsSync(controlFile) ? 'missing' : validControl(fs.readFileSync(controlFile, 'utf8')) ? 'ready' : 'external';
    if (controlStatus === 'missing') missing.push(CONTROL); if (controlStatus === 'external') blockers.push('现有 RTX40MFG-Universal.json 不是合法 control v11，未覆盖。');
    components.push({ role: 'control', name: CONTROL, status: controlStatus, owned: false });
    let reshadeStatus = observed?.reshadeAddon === true ? 'ready' : 'missing', reshadeSource = null;
    if (reshadeStatus === 'missing') {
      reshadeSource = await getReShadeSource(id);
      if (!reshadeSource || typeof reshadeSource.file !== 'string' || !HASH.test(reshadeSource.sha256 || '') || fileHash(reshadeSource.file) !== reshadeSource.sha256) blockers.push('没有可验证且支持 Add-on 的 ReShade 组件。');
      else { const dxgi = path.join(t.dir, 'dxgi.dll'), actual = fileHash(dxgi); if (actual && actual !== reshadeSource.sha256) { reshadeStatus = 'external'; blockers.push('dxgi.dll 已被其他加载器占用，不会覆盖。'); } else if (!actual) missing.push('dxgi.dll'); else reshadeStatus = 'ready'; }
    }
    components.push({ role: 'reshade', name: observed?.reshadeAddon ? '现有 ReShade' : 'dxgi.dll', status: reshadeStatus, owned: false });
    if (!reshadeSource) { try { reshadeSource = await getReShadeSource(id); } catch {} }
    let receipt = null; try { receipt = readReceipt(t, reshadeSource?.sha256); } catch (error) { blockers.push(error.message); }
    // The control file is editable through the settings service and game menu.
    // Its schema is checked above; owned keys are guarded by settings receipts.
    // Keep the original component baseline for destructive restore below.
    if (receipt) for (const row of receipt.files) if (row.mode !== 'adopted' && row.role !== 'control') { const actual = fileHash(journal.safePath(t.game, row.rel)); if (actual && actual !== row.after) blockers.push(`${path.basename(row.rel)} 已在准备后被外部修改。`); }
    if (receipt) for (const component of components) { const row = receipt.files.find(item => path.basename(item.rel).toLowerCase() === component.name.toLowerCase()); if (row) component.owned = row.mode !== 'adopted'; }
    const ready = blockers.length === 0 && missing.length === 0 && !components.some(row => ['needs-update', 'external'].includes(row.status));
    return { route, ready, needsCleanup: false, managed: Boolean(receipt), missing: [...new Set(missing)], blockers, canPrepare: blockers.length === 0 && !ready, components, api: observed?.api || 'unknown', exe: t.exe, proxy, receipt: Boolean(receipt), runtime };
  }
  async function prepare(id, { allowAntiCheat = false } = {}) {
    const status = await inspect(id); if (status.route !== 'compatibility') fail('SETTINGS_FG_UNSUPPORTED', status.blockers[0] || '当前无需 RTX40 兼容组件。');
    if (status.blockers.length) fail('SETTINGS_FG_BLOCKED', status.blockers.join('\n')); if (status.ready) return { prepared: false, unchanged: true, ...status };
    const f = await facts(id), t = f.t, manifest = readResourceManifest(), proxy = status.proxy, iniName = `${path.basename(proxy, '.dll')}.ini`;
    if (antiCheatPresent(t.game) && allowAntiCheat !== true) throw appError('ERR_ANTI_CHEAT_CONFIRM', { operation: 'prepare-fg-components' });
    await assertGameClosed(t.game, t.exe);
    const reshadeSource = await getReShadeSource(id);
    const oldReceipt = readReceipt(t, reshadeSource?.sha256), oldByRole = new Map((oldReceipt?.files || []).map(row => [row.role, row]));
    if (oldReceipt && oldReceipt.proxy.toLowerCase() !== proxy.toLowerCase()) fail('SETTINGS_FG_CONFLICT', '现有 FG 组件收据绑定了不同的 UAL 代理，未迁移或覆盖。');
    const specs = [
      { role: 'core', name: manifest.files.core.file, source: manifest.files.core.source, hash: manifest.files.core.sha256 },
      { role: 'asi', name: manifest.files.asi.file, source: manifest.files.asi.source, hash: manifest.files.asi.sha256 },
      { role: 'overlay', name: manifest.files.overlay.file, source: manifest.files.overlay.source, hash: manifest.files.overlay.sha256 },
      { role: 'ual', name: proxy, source: manifest.files.ual.source, hash: manifest.files.ual.sha256 },
      ...(!f.observed?.reshadeAddon || oldByRole.has('reshade') ? [{ role: 'reshade', name: 'dxgi.dll', source: reshadeSource?.file, hash: reshadeSource?.sha256 }] : [])
    ];
    if (specs.some(spec => typeof spec.source !== 'string' || !HASH.test(spec.hash || '') || fileHash(spec.source) !== spec.hash)) fail('SETTINGS_FG_RESOURCES', 'FG 组件来源缺失或校验失败。');
    const result = await journal.transaction(t.game, async () => {
      const files = [];
      for (const spec of specs) {
        const targetFile = journal.safePath(t.game, path.relative(t.game, path.join(t.dir, spec.name))); await noLinks(targetFile); const actual = fileHash(targetFile), old = oldByRole.get(spec.role);
        if (actual && actual !== spec.hash) fail('SETTINGS_FG_CONFLICT', `${spec.name} 已被其他组件占用。`);
        if (!actual) { await journal.capture(t.game, targetFile); await fsp.copyFile(spec.source, targetFile); if (fileHash(targetFile) !== spec.hash) fail('SETTINGS_FG_WRITE', `${spec.name} 写入校验失败。`); }
        files.push(old?.mode === 'created' ? { ...old, after: spec.hash } : { role: spec.role, rel: path.relative(t.game, targetFile), mode: actual ? 'adopted' : 'created', after: spec.hash });
      }
      const iniFile = journal.safePath(t.game, path.relative(t.game, path.join(t.dir, iniName))); await noLinks(iniFile);
      const beforeIni = fs.existsSync(iniFile) ? fs.readFileSync(iniFile, 'utf8') : null, oldIni = oldByRole.get('ualConfig');
      const mergeBase = beforeIni === null && oldIni?.mode === 'modified' ? oldIni.beforeText : beforeIni === null ? '' : beforeIni;
      const afterIni = mergeUalConfig(mergeBase); await journal.capture(t.game, iniFile);
      if (beforeIni !== afterIni) await fsp.writeFile(iniFile, afterIni, 'utf8');
      const afterIniHash = sha256(Buffer.from(afterIni, 'utf8')); if (fileHash(iniFile) !== afterIniHash) fail('SETTINGS_FG_WRITE', `${iniName} 写入校验失败。`);
      files.push(oldIni && oldIni.mode !== 'adopted' ? { ...oldIni, after: afterIniHash } : { role: 'ualConfig', rel: path.relative(t.game, iniFile), mode: beforeIni === null ? 'created' : beforeIni === afterIni ? 'adopted' : 'modified',
        ...(beforeIni !== null && beforeIni !== afterIni ? { beforeText: beforeIni, before: sha256(Buffer.from(beforeIni, 'utf8')) } : {}), after: afterIniHash });
      const controlFile = journal.safePath(t.game, path.relative(t.game, path.join(t.dir, CONTROL))); await noLinks(controlFile);
      const controlBefore = fs.existsSync(controlFile) ? fs.readFileSync(controlFile, 'utf8') : null, oldControl = oldByRole.get('control');
      if (controlBefore !== null && !validControl(controlBefore)) fail('SETTINGS_FG_CONFLICT', '现有 control 配置无效。');
      if (controlBefore === null) { await journal.capture(t.game, controlFile); await fsp.writeFile(controlFile, DEFAULT_CONTROL, 'utf8'); }
      const controlHash = sha256(Buffer.from(controlBefore === null ? DEFAULT_CONTROL : controlBefore, 'utf8')); if (fileHash(controlFile) !== controlHash) fail('SETTINGS_FG_WRITE', `${CONTROL} 写入校验失败。`);
      files.push(oldControl?.mode === 'created' ? { ...oldControl } : { role: 'control', rel: path.relative(t.game, controlFile), mode: controlBefore === null ? 'created' : 'adopted', after: controlHash });
      const receipt = { version: 1, id: manifest.id, protocol: 11, exe: t.exe, proxy, preparedAt: new Date().toISOString(), files };
      const receiptTarget = receiptFile(t); await noLinks(receiptTarget); await journal.capture(t.game, receiptTarget); await atomicJson(receiptTarget, receipt);
      return { prepared: true, route: 'compatibility', proxy, components: files, runtimeVerified: false };
    });
    return result;
  }
  async function inspectRestore(id, { retainSharedLoaders = false } = {}) {
    const t = target(id); await noLinks(receiptFile(t));
    if (!fs.existsSync(receiptFile(t))) return { t, receipt: null, retained: [] };
    const reshade = await getReShadeSource(id), receipt = readReceipt(t, reshade?.sha256);
    const retained = new Map();
    if (retainSharedLoaders) {
      // A loader originally created for MFG may have acquired other clients.
      // Retain both it and its settings rather than disabling those clients.
      const managed = new Set(receipt.files.filter(row => ['asi', 'overlay', 'core'].includes(row.role)).map(row => row.rel.toLowerCase()));
      const pending = [{ dir: t.dir, depth: 0 }]; let shared = false, count = 0;
      while (pending.length && !shared) {
        const next = pending.pop(); await noLinks(next.dir);
        for (const entry of fs.readdirSync(next.dir, { withFileTypes: true })) {
          if (++count > 20000) { shared = true; break; }
          const file = path.join(next.dir, entry.name);
          if (entry.isSymbolicLink()) { shared = true; break; }
          if (entry.isFile() && /\.asi$/i.test(entry.name) && !managed.has(path.relative(t.game, file).toLowerCase())) { shared = true; break; }
          if (entry.isDirectory() && next.depth < 6 && (next.depth > 0 || /^(scripts|plugins|asi|reframework)$/i.test(entry.name))) pending.push({ dir: file, depth: next.depth + 1 });
        }
      }
      if (shared) for (const row of receipt.files.filter(row => ['ual', 'ualConfig'].includes(row.role))) retained.set(row.rel.toLowerCase(), row.rel);
    }
    for (const row of receipt.files) {
      if (row.mode === 'adopted') continue;
      if (row.role === 'reshade' && row.mode === 'created' && nrOwnsReShade(t, row.rel)) { retained.set(row.rel.toLowerCase(), row.rel); continue; }
      const file = journal.safePath(t.game, row.rel); await noLinks(file); const actual = fileHash(file);
      if (retained.has(row.rel.toLowerCase())) continue;
      if (actual !== row.after && !(actual === null && row.mode === 'created' && !fs.existsSync(file))) fail('SETTINGS_FG_EXTERNAL_CHANGE', `${path.basename(row.rel)} 已被外部修改，未自动恢复。`);
    }
    return { t, receipt, retained: [...retained.values()] };
  }
  async function restore(id, restoreOptions = {}) {
    const plan = await inspectRestore(id, restoreOptions), { t, receipt } = plan;
    if (!receipt) return { restored: false, unchanged: true };
    await assertGameClosed(t.game, t.exe);
    const retained = new Set(plan.retained.map(rel => rel.toLowerCase()));
    return journal.transaction(t.game, async () => {
      // Recheck after acquiring the file journal, before any peer is changed.
      const fresh = await inspectRestore(id, restoreOptions);
      if (JSON.stringify(fresh.receipt) !== JSON.stringify(receipt) || JSON.stringify(fresh.retained) !== JSON.stringify(plan.retained)) fail('SETTINGS_FG_CONFLICT', '旧 FG 文件在恢复前发生变化。');
      await restoreOptions.beforeMutation?.(plan);
      for (const row of [...receipt.files].reverse()) {
        if (row.mode === 'adopted' || retained.has(row.rel.toLowerCase())) continue;
        const file = journal.safePath(t.game, row.rel); await noLinks(file); await journal.capture(t.game, file);
        if (row.mode === 'created') { if (fs.existsSync(file)) await fsp.unlink(file); }
        else { await fsp.writeFile(file, row.beforeText, 'utf8'); if (fileHash(file) !== row.before) fail('SETTINGS_FG_WRITE', `${path.basename(row.rel)} 恢复校验失败。`); }
      }
      await noLinks(receiptFile(t)); await journal.capture(t.game, receiptFile(t)); await fsp.unlink(receiptFile(t));
      await restoreOptions.afterMutation?.(plan);
      return { restored: true, retained: plan.retained, runtimeVerified: false };
    });
  }
  return Object.freeze({ inspect, prepare, restore, inspectRestore, receiptFile: id => receiptFile(target(id)) });
}

module.exports = { createFgComponents, mergeUalConfig, validControl, DEFAULT_CONTROL };
