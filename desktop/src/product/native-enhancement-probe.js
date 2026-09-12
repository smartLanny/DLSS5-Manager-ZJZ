'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { noLinks, digestFile, inside } = require('./launch-safety');
const peDefault = require('../core/pe');
const { resolveOperationApi } = require('./operation-api');
const { OFFICIAL_GAMES, TRUSTED_MODS } = require('./native-enhancement-catalog');

const HASH = /^[a-f0-9]{64}$/;
const EXCLUDED_DIR = /(?:^|[\\/])(?:_DLSS5_Backup|_DLSS5_Feeder|feeder-runtime|vulkan-runtime|xiaofeng-external|mods?|plugins[\\/]cyber_engine_tweaks)(?:[\\/]|$)/i;
const NOT_HOST = /^(?:nvngx|_nvngx|sl\.|dxgi\.|d3d\d|dinput|version\.|winmm\.|winhttp\.|opengl|vulkan|reshade|renodx|luma|optiscaler|steam_api|nvapi|gfsdk|physx|apex|px|nvcloth|vcruntime|msvcp|ucrt|libcef)/i;
const COMPONENTS = Object.freeze(['nvngx_dlss.dll', 'nvngx_dlssg.dll', 'sl.interposer.dll', 'sl.common.dll', 'sl.dlss.dll', 'sl.dlss_g.dll']);
const MARKERS = Object.freeze([...COMPONENTS, 'NVSDK_NGX_D3D11_Init', 'NVSDK_NGX_D3D12_Init', 'NVSDK_NGX_VULKAN_Init',
  'NVSDK_NGX_D3D11_CreateFeature', 'NVSDK_NGX_D3D12_CreateFeature', 'NVSDK_NGX_VULKAN_CreateFeature',
  'DLSS.Feature.Create.Flags', 'DLSS.Hint.Render.Preset', 'slInit', 'slGetFeatureFunction', 'slDLSSSetOptions', 'slDLSSGSetOptions']);
const MAX_HOST_BYTES = 256 * 1024 * 1024, MAX_TOTAL_HOST_BYTES = 512 * 1024 * 1024, MAX_HOSTS = 20;
const key = file => path.resolve(file).toLowerCase();
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && key(a) === key(b);
const unavailable = (code, message, evidence = []) => ({ status: 'unknown', source: null, staticOnly: true, official: false,
  code, message, evidence, capabilities: {} });

// WinTrust verifies the signature without loading the DLL. Its result is bound
// to the file digest checked before and after the helper, so file metadata alone
// cannot turn a replaced DLL into a trusted cached component.
async function verifyNvidiaSignature(file) {
  if (process.platform !== 'win32') return { valid: false, reason: 'windows-signature-unavailable' };
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  // Explicitly load the bundled Windows PowerShell module. A parent pwsh 7
  // process can otherwise put incompatible modules first in PSModulePath.
  const script = '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $ErrorActionPreference="Stop"; '
    + 'Import-Module (Join-Path $PSHOME "Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1") -Force; '
    + '$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:DLSS5_COMPONENT_SIGNATURE_PATH)); '
    + '$s=Get-AuthenticodeSignature -LiteralPath $p; [pscustomobject]@{status=[string]$s.Status;subject=[string]$s.SignerCertificate.Subject;thumbprint=[string]$s.SignerCertificate.Thumbprint}|ConvertTo-Json -Compress';
  return new Promise(resolve => {
    const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DLSS5_COMPONENT_SIGNATURE_PATH: Buffer.from(file, 'utf8').toString('base64') } });
    let output = '', done = false;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish({ valid: false, reason: 'signature-timeout' }); }, 15000);
    child.once('error', () => finish({ valid: false, reason: 'signature-helper-unavailable' }));
    child.stdout.on('data', chunk => { output += chunk.toString('utf8'); if (output.length > 16384) child.kill(); });
    child.stderr.resume();
    child.once('close', code => {
      try {
        const row = JSON.parse(output.replace(/^\uFEFF/, '').trim());
        const nvidia = /(?:^|,\s*)(?:CN|O)=NVIDIA Corporation(?:,|$)/i.test(row.subject || '');
        finish({ valid: code === 0 && row.status === 'Valid' && nvidia, source: 'windows-authenticode',
          status: row.status, publisher: row.subject, thumbprint: row.thumbprint });
      } catch { finish({ valid: false, reason: 'signature-result-unavailable' }); }
    });
  });
}

function createNativeEnhancementProbe(options = {}) {
  const pe = options.pe || peDefault, signature = options.verifySignature || verifyNvidiaSignature;
  const officialGames = options.officialGames || OFFICIAL_GAMES, trustedMods = options.trustedMods || TRUSTED_MODS;
  const trustCache = new Map(), scans = new Map();
  if (typeof options.gameDirectory !== 'function' || typeof options.gameExecutable !== 'function')
    throw new TypeError('Native enhancement probe requires executable-bound game paths.');

  async function identity(file, limit = MAX_HOST_BYTES) {
    await noLinks(file); const before = await fs.stat(file);
    if (!before.isFile() || before.size > limit || before.nlink !== 1) throw new Error('组件不是可验证的普通文件。');
    const sha256 = await digestFile(file), after = await fs.stat(file);
    if (!sha256 || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino)
      throw new Error('检查期间文件已改变。');
    return { path: file, sha256, size: after.size, mtimeMs: after.mtimeMs };
  }
  async function trustedComponent(file, root) {
    if (!path.isAbsolute(file || '') || !inside(root, file) || EXCLUDED_DIR.test(file)) return null;
    const name = path.basename(file).toLowerCase(); if (!COMPONENTS.includes(name)) return null;
    const row = await identity(file);
    if (pe.getBitness(file) !== 64) return { ...row, name, trusted: false, reason: 'architecture-unverified' };
    let trust = trustCache.get(row.sha256);
    if (!trust) {
      trust = await signature(file, row);
      if (await digestFile(file) !== row.sha256) throw new Error('签名检查期间组件已改变。');
      if (trustCache.size >= 128) trustCache.delete(trustCache.keys().next().value);
      trustCache.set(row.sha256, trust);
    }
    return { ...row, name, version: pe.getFileVersion?.(file) || null, trusted: trust?.valid === true, signature: trust };
  }
  async function findLocal(dir, name) {
    if (path.basename(name) !== name || !/\.dll$/i.test(name)) return null;
    try { const rows = await fs.readdir(dir); const found = rows.find(row => row.toLowerCase() === name.toLowerCase()); return found ? path.join(dir, found) : null; }
    catch { return null; }
  }
  async function hostEvidence(exe, root) {
    const pending = [{ file: exe, via: 'selected-executable' }], hosts = [], visited = new Set(); let bytes = 0;
    while (pending.length && hosts.length < MAX_HOSTS) {
      const next = pending.shift(), file = next.file;
      if (visited.has(key(file)) || !inside(root, file) || EXCLUDED_DIR.test(file) || file !== exe && NOT_HOST.test(path.basename(file))) continue;
      visited.add(key(file));
      let row; try { row = await identity(file); } catch { continue; }
      if (bytes + row.size > MAX_TOTAL_HOST_BYTES || pe.getBitness(file) !== 64) continue;
      bytes += row.size;
      const imports = [...new Set((pe.getImports(file) || []).map(name => String(name).toLowerCase()))];
      const markers = [...(pe.findMarkers?.(file, MARKERS) || [])];
      const host = { ...row, via: next.via, imports, markers }; hosts.push(host);
      for (const name of imports) {
        if (NOT_HOST.test(name)) continue;
        const local = await findLocal(path.dirname(file), name);
        if (local) pending.push({ file: local, via: `import:${file}` });
      }
      // Unity loads these two engine modules dynamically. The executable must
      // actually name the module; a loose engine DLL in the folder is ignored.
      for (const name of ['UnityPlayer.dll', 'GameAssembly.dll']) {
        if (!new Set(pe.findMarkers?.(file, [name]) || []).has(name)) continue;
        const local = await findLocal(path.dirname(file), name);
        if (local) pending.push({ file: local, via: `loader-reference:${file}` });
      }
    }
    return { hosts, complete: pending.length === 0, bytes };
  }
  async function verifiedMod(id, domain, exeIdentity, root, components, api) {
    if (!trustedMods.length || typeof options.getLayout !== 'function') return null;
    const layout = await options.getLayout(id);
    if (layout?.verified !== true || layout.needsRecovery || layout.blockers?.length || !same(layout.exe, exeIdentity.path)) return null;
    for (const row of trustedMods) {
      if (row.domain !== domain || row.api !== api || row.exeSha256 !== exeIdentity.sha256 || !HASH.test(row.addonSha256 || '') ||
          !row.source || row.driverOverrideSupported !== true || path.basename(row.addon || '') !== row.addon || !row.addon) continue;
      const addon = path.join(layout.addonDirectory, row.addon);
      try {
        const file = await identity(addon); if (file.sha256 !== row.addonSha256 || pe.getBitness(addon) !== 64) continue;
        if (!components.some(component => component.name === 'nvngx_dlss.dll' && component.trusted)) continue;
        return { status: 'supported', source: 'trusted-mod', staticOnly: true, official: false, evidence: [row.source],
          integration: { id: row.id, addon: file, exeSha256: exeIdentity.sha256 }, capabilities: structuredClone(row.capabilities || {}) };
      } catch { /* A reviewed mod contract cannot authorize changed files. */ }
    }
    return null;
  }
  async function inspectAll(id) {
    const root = path.resolve(options.gameDirectory(id)), exe = path.resolve(options.gameExecutable(id));
    const scan = typeof options.scan === 'function' ? await options.scan(id) : {};
    if (!inside(root, exe) || path.extname(exe).toLowerCase() !== '.exe' || scan.chosen?.path && !same(scan.chosen.path, exe))
      throw new Error('扫描结果与所选游戏程序不一致。');
    const game = { scan, apiOverride: scan.apiOverride }, selectedApi = resolveOperationApi(game).effectiveApi;
    const exeIdentity = await identity(exe), bits = pe.getBitness(exe);
    if (bits !== 64 || !['dx11', 'dx12', 'vulkan'].includes(selectedApi)) return { exeIdentity, api: selectedApi, components: [],
      sr: unavailable('SETTINGS_GAME_API', '所选程序的 x64 图形 API 尚未确认。'), fg: unavailable('SETTINGS_GAME_API', '所选程序的 x64 图形 API 尚未确认。') };
    const candidates = new Map();
    for (const row of [...(scan.dlssFiles || []), ...(scan.streamlineFiles || []), scan.primaryDlss].filter(Boolean)) {
      const file = row.path || row.file; if (typeof file === 'string' && path.isAbsolute(file)) candidates.set(key(file), file);
    }
    for (const name of COMPONENTS) { const file = await findLocal(path.dirname(exe), name); if (file) candidates.set(key(file), file); }
    const components = [];
    for (const file of candidates.values()) {
      if (components.length >= 32) break;
      try { const row = await trustedComponent(file, root); if (row) components.push(row); } catch { /* Changed/unreadable evidence remains absent. */ }
    }
    const graph = await hostEvidence(exe, root);
    const has = (name, trusted = true) => components.filter(row => row.name === name && (!trusted || row.trusted));
    const sourceRows = graph.hosts.filter(host => {
      const seen = new Set([...host.imports, ...host.markers.map(value => value.toLowerCase())]);
      return seen.has('sl.interposer.dll') && (seen.has('slinit') || seen.has('slgetfeaturefunction') || host.imports.includes('sl.interposer.dll'));
    });
    const srRows = graph.hosts.filter(host => {
      const markers = new Set(host.markers), names = new Set([...host.imports, ...host.markers.map(value => value.toLowerCase())]);
      return names.has('nvngx_dlss.dll') || markers.has('slDLSSSetOptions') ||
        markers.has('DLSS.Feature.Create.Flags') && [...markers].some(value => /^NVSDK_NGX_(?:D3D11|D3D12|VULKAN)_(?:Init|CreateFeature)/.test(value));
    });
    const wrapper = has('sl.interposer.dll').length === 1 && has('sl.interposer.dll', false).length === 1 &&
      has('sl.common.dll').length === has('sl.common.dll', false).length && has('sl.common.dll').length <= 1;
    const srLinked = srRows.length > 0 || sourceRows.length > 0 && wrapper && has('sl.dlss.dll').length === 1;
    const fgLinked = graph.hosts.some(host => host.markers.includes('slDLSSGSetOptions') || host.markers.includes('sl.dlss_g.dll')) || sourceRows.length > 0;
    const srOk = has('nvngx_dlss.dll').length === 1 && has('nvngx_dlss.dll', false).length === 1 && srLinked;
    const fgOk = has('nvngx_dlssg.dll').length === 1 && has('nvngx_dlssg.dll', false).length === 1 &&
      has('sl.dlss_g.dll').length === 1 && has('sl.dlss_g.dll', false).length === 1 && wrapper && fgLinked && ['dx12', 'vulkan'].includes(selectedApi);
    const evidence = { exe: exeIdentity, api: selectedApi, hosts: graph.hosts, components, complete: graph.complete };
    const positive = domain => ({ status: 'supported', source: 'native-integration', staticOnly: true, official: false,
      evidence: ['executable-linked-integration', 'verified-nvidia-components'], integration: evidence,
      capabilities: domain === 'fg' ? { multipliers: [2], dynamic: false,
        mfgUnlock: { available: selectedApi === 'dx12' && /^\d+\./.test(has('nvngx_dlssg.dll')[0]?.version || '') && Number.parseInt(has('nvngx_dlssg.dll')[0]?.version, 10) >= 310,
          multipliers: [2, 3, 4], api: selectedApi, runtimeVersion: has('nvngx_dlssg.dll')[0]?.version || null } } : {} });
    const sr = srOk ? positive('sr') : await verifiedMod(id, 'sr', exeIdentity, root, components, selectedApi)
      || unavailable('SETTINGS_GAME_SUPPORT_UNKNOWN', has('nvngx_dlss.dll', false).length
        ? '发现 DLSS 文件，但尚未确认它与所选游戏或受信任模组的集成关系。' : '尚未找到所选游戏的可信 DLSS 超分集成。', ['static-files-do-not-prove-integration']);
    let fg = fgOk ? positive('fg') : unavailable('SETTINGS_GAME_SUPPORT_UNKNOWN', '尚未确认所选游戏已集成可信的 Streamline 帧生成。');
    if (fgOk && options.gameMetadata) {
      const metadata = await options.gameMetadata(id);
      const row = officialGames.find(item => item.steamAppId === String(metadata?.verifiedSteamAppId || '') && metadata.steamIdentityVerified === true &&
        item.exe.toLowerCase() === path.basename(exe).toLowerCase() && item.api === selectedApi);
      if (row) fg = { ...fg, source: 'catalog', official: true, capabilities: { ...fg.capabilities, ...structuredClone(row.fg) },
        evidence: [...fg.evidence, row.source], catalogue: { id: row.id, checkedAt: row.checkedAt, source: row.source } };
    }
    return { exeIdentity, api: selectedApi, components, graph, sr, fg };
  }
  async function inspect(id, domain) {
    if (!['sr', 'fg'].includes(domain)) throw new TypeError('Unknown enhancement domain.');
    // Coalesce only simultaneous SR/FG reads. No on-disk cache and no persistent
    // eligibility survives an EXE, DLL, API or driver change.
    let task = scans.get(id);
    if (!task) { task = inspectAll(id); scans.set(id, task); task.finally(() => { if (scans.get(id) === task) scans.delete(id); }).catch(() => {}); }
    try {
      const value = await task;
      return { support: value[domain], staticEvidence: { nativeDlssAvailable: value.sr.source === 'native-integration' || value.sr.source === 'catalog',
        nativeFgAvailable: value.fg.status === 'supported', staticOnly: true, api: value.api, components: value.components },
        gameSetting: { state: 'unknown', source: null }, exeIdentity: value.exeIdentity.sha256 };
    } catch (error) { return { support: unavailable('SETTINGS_EVIDENCE_UNAVAILABLE', error.message), staticEvidence: null,
      gameSetting: { state: 'unknown', source: null } }; }
  }
  return Object.freeze({ inspect });
}
module.exports = { createNativeEnhancementProbe, verifyNvidiaSignature, COMPONENTS, MARKERS };
