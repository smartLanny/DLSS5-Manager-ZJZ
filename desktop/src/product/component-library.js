'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { noLinks, inside, atomicJson } = require('./launch-safety');
const { hashRegularFile } = require('./streamed-file-digest');
const pe = require('../core/pe');
const CATALOG = require('./component-catalog.json');
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9._+-]{0,127}$/i;
const validId = value => typeof value === 'string' && ID.test(value);
const MAX_FILE = 1024 * 1024 * 1024, MAX_ARCHIVE = 2 * MAX_FILE;
const fail = message => { throw Object.assign(new Error(message), { code: 'COMPONENT_LIBRARY' }); };
function relativeName(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') || /[\x00-\x1f]/.test(name) || name.startsWith('/') ||
      name.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail('组件包包含无效路径。');
  return name;
}
async function digest(file) { return hashRegularFile(file, { assertPath: noLinks, maxBytes: MAX_FILE }); }
async function json(file) {
  await noLinks(file); const stat = await fsp.stat(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) fail('组件清单过大或不是普通文件。');
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}
async function unpack(file, target) {
  await noLinks(file);
  if ((await fsp.stat(file)).size > MAX_ARCHIVE) fail('组件压缩包过大。');
  const yauzl = require('yauzl');
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: true }, (error, zip) => {
    if (error) return reject(error);
    let total = 0, count = 0, stopped = false; const names = new Set();
    const stop = err => { if (stopped) return; stopped = true; zip.close(); reject(err); };
    zip.on('error', stop); zip.on('end', () => { if (!stopped) resolve(); });
    zip.on('entry', entry => { (async () => {
      const directory = entry.fileName.endsWith('/'), name = relativeName(directory ? entry.fileName.slice(0, -1) : entry.fileName);
      if (++count > 4096 || names.has(name.toLowerCase())) fail('组件压缩包包含重复路径或过多文件。');
      names.add(name.toLowerCase());
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if ((entry.generalPurposeBitFlag & 1) || (mode && mode !== 0x8000 && mode !== 0x4000)) fail('不支持加密或链接形式的组件。');
      if (entry.uncompressedSize > MAX_FILE || (total += entry.uncompressedSize) > MAX_ARCHIVE) fail('组件展开大小超过限制。');
      const dest = path.join(target, name); if (!inside(target, dest)) fail('组件路径越界。');
      if (directory) await fsp.mkdir(dest, { recursive: true });
      else {
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        const stream = await new Promise((ok, bad) => zip.openReadStream(entry, (err, value) => err ? bad(err) : ok(value)));
        let bytes = 0;
        const limit = new Transform({ transform(chunk, encoding, done) { bytes += chunk.length; done(bytes > entry.uncompressedSize ? new Error('组件解包长度不符。') : null, chunk); } });
        await pipeline(stream, limit, fs.createWriteStream(dest, { flags: 'wx' }));
        if (bytes !== entry.uncompressedSize) fail('组件解包长度不符。');
      }
      if (!stopped) zip.readEntry();
    })().catch(stop); }); zip.readEntry();
  }));
}
function createComponentLibrary({ userData, catalog = CATALOG }) {
  const root = path.join(userData, 'component-library'), inventoryFile = path.join(root, 'inventory.json');
  const releaseFile = path.join(root, 'release-catalog.json');
  function availableCatalog() {
    let remote = [];
    try { const stat = fs.lstatSync(releaseFile); if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 1024 * 1024) remote = JSON.parse(fs.readFileSync(releaseFile,'utf8')).packages || []; } catch {}
    if (!Array.isArray(remote)) remote = [];
    remote = remote.filter(p => p && validId(p.id) && HASH.test(p.sha256) && Number.isSafeInteger(p.bytes) && p.bytes > 0 && p.bytes <= MAX_FILE &&
      ['bridge','mfg','feeder'].includes(p.kind) && p.downloadUrl?.startsWith(`https://github.com/${p.repository}/releases/download/`) &&
      ['NIGos/dlss5-bridge','mavismmg/MFGAdaUnlock-RenoDx','jlrouzies-fr/DLSS5-Feeder'].includes(p.repository));
    return { ...catalog, packages: [...catalog.packages, ...remote.filter(p => !catalog.packages.some(k => k.sha256 === p.sha256))] };
  }
  let queue = Promise.resolve();
  const serialize = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  async function inventory() {
    try { const data = await json(inventoryFile); if (data.schemaVersion !== 1 || !Array.isArray(data.packages) || data.packages.length > 256) fail('组件库存损坏。'); return data; }
    catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, packages: [], selected: {} }; throw error; }
  }
  async function storeFile(source, expected, name) {
    relativeName(name); if (path.basename(name) !== name || !HASH.test(expected)) fail('组件文件身份无效。');
    if (await digest(source) !== expected) fail('组件文件与清单摘要不一致。');
    const rel = `objects/${expected}/${name}`, target = path.join(root, rel);
    await noLinks(target); await fsp.mkdir(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) { if (await digest(target) !== expected) fail('缓存组件已被改写，请重新导入到干净库存。'); return rel; }
    const tmp = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await fsp.copyFile(source, tmp, fs.constants.COPYFILE_EXCL);
      if (await digest(tmp) !== expected) fail('复制时组件发生变化。');
      await noLinks(target); await fsp.rename(tmp, target);
    } finally { await fsp.unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return rel;
  }
  async function importPlain(file) {
    const hash = await digest(file), known = availableCatalog().packages.find(p => p.sha256 === hash);
    if (!known) fail('尚未识别这个单文件组件，请先检查更新，或导入带 component-manifest.json 的组件包。');
    const stat = await fsp.stat(file);
    if (stat.size !== known.bytes || pe.getBitness(file) !== (known.architecture === 'x86' ? 32 : 64)) fail('组件大小或位数不符。');
    return { ...known, files: [{ file: await storeFile(file, hash, known.filename), name: known.filename, sha256: hash, bytes: stat.size }], source: 'catalog', importedAt: new Date().toISOString() };
  }
  async function importDirectory(directory) {
    await noLinks(directory);
    const manifest = path.join(directory, 'component-manifest.json');
    let adapted;
    if (!fs.existsSync(manifest) && fs.existsSync(path.join(directory,'build-info.json')) && fs.existsSync(path.join(directory,'SHA256.json'))) {
      const info = await json(path.join(directory,'build-info.json')), hashes = await json(path.join(directory,'SHA256.json'));
      if (info.schema === 'nr050-core-only-acceptance-v1' && typeof info.version === 'string' && validId(info.version) &&
          info.binaries && typeof info.binaries === 'object') {
        const binaryNames = Object.keys(info.binaries), addons = binaryNames.filter(name => /\.addon64$/i.test(name));
        if (addons.length !== 1 || binaryNames.length !== 2 || !binaryNames.includes('nrchain_nvngx.dll')) fail('Core 上游包二进制集合不明确。');
        const files = [];
        for (const [name, hash] of Object.entries(hashes)) {
          relativeName(name); if (!HASH.test(hash) || await digest(path.join(directory,name)) !== hash) fail('Core 上游包摘要不符。');
          const bytes = (await fsp.stat(path.join(directory,name))).size;
          if (info.binaries[name] && (info.binaries[name].sha256 !== hash || info.binaries[name].bytes !== bytes)) fail('Core 构建清单与文件不一致。');
          files.push({path:name,sha256:hash,bytes});
        }
        if (binaryNames.some(name => !files.some(file => file.path === name))) fail('Core 上游包缺少二进制摘要。');
        adapted = {schema:'dlss5-component-v1',id:`core-${info.version}-${hashes[addons[0]].slice(0,12)}`,kind:'core',version:info.version,
          variant:info.language || 'external',architecture:'x64',interface:'NGX-D3D12-Feature1',inputInterfaces:['NGX-D3D12-Feature1'],
          supportsPresent:Array.isArray(info.processing_starts) && info.processing_starts.includes('Present'),gameApis:['dx12'],files};
      }
    }
    if (!fs.existsSync(manifest) && !adapted) {
      const all = [];
      async function walk(dir, depth = 0) { if (depth > 8) fail('组件目录过深。'); for (const row of await fsp.readdir(dir, { withFileTypes: true })) {
        if (row.isSymbolicLink()) fail('组件目录不能含链接。');
        const full = path.join(dir, row.name);
        if (row.isDirectory()) await walk(full, depth + 1); else if (row.isFile()) all.push(full);
        if (all.length > 4096) fail('组件目录文件过多。');
      } }
      await walk(directory);
      const manifests = all.filter(file => path.basename(file) === 'component-manifest.json');
      if (manifests.length) {
        if (manifests.length > 32) fail('组件集合包含过多清单。');
        const packages = [];
        for (const file of manifests) packages.push(...await importDirectory(path.dirname(file)));
        return packages;
      }
      const recognized = [];
      for (const file of all.filter(p => /\.(dll|addon64|addon32)$/i.test(p))) {
        const hash = await digest(file);
        if (availableCatalog().packages.some(p => p.sha256 === hash && !p.archive)) recognized.push(await importPlain(file));
      }
      if (!recognized.length) fail('目录中没有已识别组件；自定义组件须提供 component-manifest.json。');
      return recognized;
    }
    let m = adapted || await json(manifest);
    if (m.schemaVersion === 1 && m.kind && m.files && !Array.isArray(m.files)) {
      m = { ...m, schema: 'dlss5-component-v1', files: Object.values(m.files).map(row => ({ path: row.file, sha256: row.sha256, bytes: row.bytes })) };
    }
    if (m.schema !== 'dlss5-component-v1' || !validId(m.id) || !['core','bridge','feeder','mfg','nr-runtime','host'].includes(m.kind) ||
        typeof m.version !== 'string' || m.version.length > 100 || !['x86','x64','mixed'].includes(m.architecture) ||
        typeof m.interface !== 'string' || m.interface.length > 100 || !Array.isArray(m.files) || !m.files.length || m.files.length > 128) fail('组件清单格式不完整。');
    const files = [], seen = new Set();
    for (const row of m.files) {
      const name = relativeName(row.path); if (seen.has(name.toLowerCase()) || !HASH.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > MAX_FILE) fail('组件文件条目无效。');
      seen.add(name.toLowerCase()); const source = path.join(directory, name); await noLinks(source);
      if ((await fsp.stat(source)).size !== row.bytes) fail('组件文件长度不符。');
      if (/\.(dll|exe|addon64|addon32)$/i.test(name)) {
        const bits = pe.getBitness(source), expected = m.architecture === 'mixed' ? row.architecture : m.architecture;
        if (![32,64].includes(bits) || expected === 'x64' && bits !== 64 || expected === 'x86' && bits !== 32) fail('组件位数与清单不匹配。');
      }
      files.push({ file: await storeFile(source, row.sha256, path.basename(name)), name, sha256: row.sha256, bytes: row.bytes });
    }
    // Declared metadata is retained as an imported candidate, never elevated to a tested catalog entry.
    return [{ id: m.id, kind: m.kind, version: m.version, variant: m.variant || 'external', architecture: m.architecture,
      interface: m.interface, gameApis: m.gameApis || [], hardwareFamilies: m.hardwareFamilies || [],
      compatibleCoreInterfaces: m.compatibleCoreInterfaces || [], inputInterfaces: Array.isArray(m.inputInterfaces) ? m.inputInterfaces : [m.interface], supportsPresent: m.supportsPresent === true,
      capabilities: Array.isArray(m.capabilities) ? m.capabilities.filter(value => typeof value === 'string') : [],
      validation: m.validation === 'blocked' || m.validation?.status === 'blocked' ? 'blocked' : 'candidate', blockers: m.validation?.blockers || [], source: 'user-imported', files,
      importedAt: new Date().toISOString() }];
  }
  async function importComponent(selected) { return serialize(async () => {
    if (typeof selected !== 'string' || !path.isAbsolute(selected)) fail('请选择本机组件文件或目录。');
    await noLinks(selected); await fsp.mkdir(root, { recursive: true });
    const stat = await fsp.stat(selected); let rows, temp;
    try {
      if (stat.isDirectory()) rows = await importDirectory(selected);
      else if (/\.zip$/i.test(selected)) {
        const hash = await digest(selected), known = availableCatalog().packages.find(row => row.archive && row.sha256 === hash);
        if (known) {
          if (stat.size !== known.bytes) fail('上游压缩包长度不符。');
          rows = [{ ...known, files:[{file:await storeFile(selected,hash,known.filename),name:known.filename,sha256:hash,bytes:stat.size}],
            source:'catalog',validation:'candidate',requiresAdapter:true,importedAt:new Date().toISOString() }];
        } else { temp = await fsp.mkdtemp(path.join(root, '.import-')); await unpack(selected, temp); rows = await importDirectory(temp); }
      }
      else if (path.basename(selected) === 'component-manifest.json') rows = await importDirectory(path.dirname(selected));
      else rows = [await importPlain(selected)];
      const data = await inventory();
      for (const row of rows) {
        const existing = data.packages.find(p => p.id === row.id);
        if (existing && JSON.stringify(existing.files) !== JSON.stringify(row.files)) fail('同一组件 ID 对应不同文件，请为新变体使用独立 ID。');
        if (!existing) data.packages.push(row);
      }
      await atomicJson(inventoryFile, data); return { packages: rows, changedGames: false };
    } finally { if (temp && inside(root, temp) && path.basename(temp).startsWith('.import-')) await fsp.rm(temp, { recursive: true, force: true }); }
  }); }
  async function materializePayload(data, bundledPayloadDir) {
    const base = await json(path.join(bundledPayloadDir, 'bundle.json'));
    if (base.version !== 4) fail('基础包需要 v4 组件清单。');
    // The overlay has one copy of each runtime object; no links into mutable game directories.
    for (const family of ['RTX40','RTX50']) {
      for (const [name, hash] of Object.entries(base.fixed[family].files)) {
        if (name === 'nvngx_dlssnr.dll') continue;
        const source = path.join(bundledPayloadDir, 'fixed', family, relativeName(name));
        const object = await storeFile(source, hash, name), dest = path.join(root, 'fixed', family, name);
        await noLinks(dest); await fsp.mkdir(path.dirname(dest), { recursive: true }); await fsp.copyFile(path.join(root, object), dest);
      }
    }
    for (const [version, entry] of Object.entries(base.versions)) {
      if (!validId(version)) fail('基础包版本 ID 无效。');
      for (const [name, hash] of Object.entries(entry.files)) {
        relativeName(name); const source = path.join(bundledPayloadDir, 'versions', version, name);
        const object = await storeFile(source, hash, name), dest = path.join(root, 'versions', version, name);
        await noLinks(dest); await fsp.mkdir(path.dirname(dest), { recursive: true }); await fsp.copyFile(path.join(root, object), dest);
      }
    }
    for (const family of ['RTX40','RTX50']) {
      const selected = data.packages.find(p => p.id === data.selected[family]);
      if (!selected) {
        const runtime = path.join(bundledPayloadDir,'fixed',family,'nvngx_dlssnr.dll');
        if (fs.existsSync(runtime)) base.fixed[family].paths = { runtime: await storeFile(runtime,base.fixed[family].files['nvngx_dlssnr.dll'],'nvngx_dlssnr.dll') };
        continue;
      }
      const file = selected.files.find(row => path.basename(row.name) === 'nvngx_dlssnr.dll');
      if (!file) fail('运行包缺少唯一 NR DLL。');
      if (await digest(path.join(root, relativeName(file.file))) !== file.sha256) fail('运行 DLL 缓存被修改。');
      base.fixed[family].paths = { runtime: file.file };
      base.fixed[family].files['nvngx_dlssnr.dll'] = file.sha256;
    }
    const coreIds = new Set([...(data.selected.coreVersions || []), data.selected.core].filter(Boolean));
    const inheritedVersion = base.defaultVersion;
    for (const core of data.packages.filter(p => coreIds.has(p.id))) {
      if (core.validation === 'blocked' || core.kind !== 'core' || core.architecture !== 'x64') fail('这个 Core 尚不能用于安装。');
      const addons = core.files.filter(f => /\.addon64$/i.test(f.name));
      if (addons.length !== 1) fail('请选择只含一种语言 Core 的组件包。');
      const versionId = `component-${core.id}`;
      if (!validId(versionId)) fail('Core 组件 ID 过长。');
      const entry = { ...base.versions[inheritedVersion], label: `${core.version} · ${core.variant}`, source: 'component-library',
        files: { ...base.versions[inheritedVersion].files }, inputInterfaces: core.inputInterfaces || [core.interface], supportsPresent: core.supportsPresent === true,
        capabilities: core.capabilities || [], coreUpdateOnly: false, comparisonOnly: false, ota: false, compatibility: null };
      const sources = { 'nr-before-sr.zh-CN.addon64': addons[0] };
      for (const name of ['nrchain_nvngx.dll','nr_before_sr.ini']) { const file = core.files.find(f => path.basename(f.name) === name); if (file) sources[name] = file; }
      for (const [name, file] of Object.entries(sources)) entry.files[name] = file.sha256;
      for (const [name, hash] of Object.entries(entry.files)) {
        // A new independent Core never inherits an old private carrier.
        if (/\.addon64$/i.test(name) && name !== 'nr-before-sr.zh-CN.addon64') { delete entry.files[name]; continue; }
        const src = sources[name], source = src ? path.join(root, relativeName(src.file)) : path.join(root,'versions',inheritedVersion,name);
        const expected = src ? src.sha256 : hash;
        if (await digest(source) !== expected) fail('Core 配套文件校验失败。');
        const dest = path.join(root,'versions',versionId,relativeName(name)); await noLinks(dest); await fsp.mkdir(path.dirname(dest),{recursive:true});
        await fsp.copyFile(source,dest); entry.files[name] = expected;
      }
      base.versions[versionId] = entry;
      if (core.id === data.selected.core) base.defaultVersion = versionId;
    }
    await atomicJson(path.join(root, 'bundle.json'), base); await atomicJson(inventoryFile, data);
    return { payloadDir: root, changedGames: false };
  }
  async function activateRuntime(id, bundledPayloadDir) { return serialize(async () => {
    const data = await inventory(), row = data.packages.find(p => p.id === id);
    const approved = catalog.packages.find(p => p.id === id && p.kind === 'nr-runtime');
    const binaries = (row?.files || []).filter(file => /\.(dll|addon64|exe)$/i.test(file.name));
    if (!row || row.kind !== 'nr-runtime' || row.validation === 'blocked' || row.architecture !== 'x64' || row.interface !== 'NGX-Feature18' ||
        binaries.length !== 1 || path.basename(binaries[0].name) !== 'nvngx_dlssnr.dll' ||
        !Array.isArray(row.hardwareFamilies) || row.hardwareFamilies.length !== 1 || !['RTX40','RTX50'].includes(row.hardwareFamilies[0]) ||
        (approved ? binaries[0].sha256 !== approved.sha256 : row.source !== 'user-imported')) fail('请选择接口和显卡族明确的 NR 运行包。未知裸 DLL 需要组件清单。');
    for (const family of row.hardwareFamilies) data.selected[family] = id;
    return { ...(await materializePayload(data,bundledPayloadDir)), hardwareFamilies: row.hardwareFamilies, runtimeVerified:false };
  }); }
  async function activateCore(id, bundledPayloadDir) { return serialize(async () => {
    const data = await inventory(); if (!data.packages.some(p => p.id === id && p.kind === 'core')) fail('未找到所选 Core。');
    data.selected.core = id; data.selected.coreVersions = [...new Set([...(data.selected.coreVersions || []),id])];
    if (data.selected.coreVersions.length > 32) fail('Core 候选数量已达到上限。');
    return materializePayload(data,bundledPayloadDir);
  }); }
  async function registerPayloadContext(payloadDir, version, family) { return serialize(async () => {
    const { readBundle, safePayloadPath } = require('./payload');
    const bundle = readBundle(payloadDir), entry = bundle.versions?.[version];
    if (bundle.version !== 4 || !entry || !['RTX40','RTX50'].includes(family)) fail('当前 Core 或显卡运行包尚未确定。');
    const data = await inventory();
    const files = [
      { kind:'core', name:'nr-before-sr.zh-CN.addon64', sha256:entry.files['nr-before-sr.zh-CN.addon64'], file:path.join(payloadDir,'versions',version,'nr-before-sr.zh-CN.addon64') },
      { kind:'core-config', name:'nr_before_sr.ini', sha256:entry.files['nr_before_sr.ini'], file:path.join(payloadDir,'versions',version,'nr_before_sr.ini') },
      { kind:'core-companion', name:'nrchain_nvngx.dll', sha256:entry.files['nrchain_nvngx.dll'] || bundle.fixed[family].files['nrchain_nvngx.dll'],
        file:entry.files['nrchain_nvngx.dll'] ? path.join(payloadDir,'versions',version,'nrchain_nvngx.dll') : path.join(payloadDir,'fixed',family,'nrchain_nvngx.dll') },
      { kind:'nr-runtime', name:'nvngx_dlssnr.dll', sha256:bundle.fixed[family].files['nvngx_dlssnr.dll'],
        file:bundle.fixed[family].paths?.runtime ? path.join(payloadDir,relativeName(bundle.fixed[family].paths.runtime)) : path.join(payloadDir,'fixed',family,'nvngx_dlssnr.dll') }
    ];
    for (const item of files) {
      const source = safePayloadPath(payloadDir,item.file), object = await storeFile(source,item.sha256,item.name);
      if (!data.packages.some(row => row.files?.some(file => file.file === object && file.sha256 === item.sha256))) {
        data.packages.push({ id:`payload-${item.kind}-${item.sha256.slice(0,24)}`, kind:item.kind, version, architecture:'x64', internal:true,
          source:'catalog', validation:'candidate', files:[{file:object,name:item.name,sha256:item.sha256,bytes:(await fsp.stat(source)).size}] });
      }
    }
    await atomicJson(inventoryFile,data);
    return { changedGames:false };
  }); }
  async function checkUpdates() {
    const repos = { bridge: 'NIGos/dlss5-bridge', feeder: 'jlrouzies-fr/DLSS5-Feeder', mfg: 'mavismmg/MFGAdaUnlock-RenoDx' };
    const results = await Promise.all(Object.entries(repos).map(async ([kind, repo]) => {
      try {
        const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=3`, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.text(); if (body.length > 1024 * 1024) fail('更新目录过大。');
        const releases = JSON.parse(body); if (!Array.isArray(releases)) fail('更新目录格式无效。');
        return { kind, releases: releases.filter(r => !r.draft).slice(0,3).map(r => ({ version: String(r.tag_name).slice(0,100), preview: r.prerelease === true,
          notes: String(r.body || '').slice(0,3000), url: `https://github.com/${repo}/releases`, validation: 'not-tested-with-this-core',
          assets: (Array.isArray(r.assets) ? r.assets : []).filter(a => (['dlss5-bridge.addon64','renodx-mfgunlock.addon64'].includes(a.name) || kind === 'feeder' && /^DLSS5-Feeder-[a-z0-9.+-]+\.zip$/i.test(a.name)) && /^sha256:[a-f0-9]{64}$/.test(a.digest || '') &&
            Number.isSafeInteger(a.size) && a.size > 0 && a.size <= MAX_FILE && String(a.browser_download_url).startsWith(`https://github.com/${repo}/releases/download/`)).map(a => ({
              id: `${kind}-${String(r.tag_name).replace(/^v/,'')}-${a.digest.slice(7,19)}`, kind, repository: repo, version: String(r.tag_name).replace(/^v/,''), variant: 'official',
              filename: a.name, bytes: a.size, sha256: a.digest.slice(7), downloadUrl: a.browser_download_url,
              architecture: kind === 'feeder' ? 'mixed' : 'x64', interface: kind === 'mfg' ? 'Streamline-DLSSG' : 'NGX-D3D12-Feature1',
              ...(kind === 'bridge' ? { gameApis:['dx11','vulkan'] } : kind === 'mfg' ? { hardwareFamilies:['RTX40'] } : {archive:true,requiresAdapter:true}), validation:'candidate' })) })) };
      } catch (error) { return { kind, releases: [], error: error.message }; }
    }));
    await atomicJson(releaseFile, { schemaVersion:1, checkedAt:new Date().toISOString(), packages:results.flatMap(r => r.releases.flatMap(v => v.assets || [])) });
    return results;
  }
  async function downloadComponent(id) {
    const row = availableCatalog().packages.find(p => p.id === id);
    if (!row?.downloadUrl || new URL(row.downloadUrl).hostname !== 'github.com' || !row.downloadUrl.startsWith('https://')) fail('该组件需要从下载说明获取并手动导入。');
    await noLinks(root); await fsp.mkdir(root, { recursive: true });
    const temp = await fsp.mkdtemp(path.join(root, '.download-')), file = path.join(temp, relativeName(row.filename));
    try {
      const response = await fetch(row.downloadUrl, { signal: AbortSignal.timeout(60000) });
      if (!response.ok || !response.body) fail(`组件下载失败：HTTP ${response.status}`);
      let bytes = 0;
      const limit = new Transform({ transform(chunk, encoding, next) { bytes += chunk.length; next(bytes > row.bytes ? new Error('下载组件超过已登记长度。') : null, chunk); } });
      await pipeline(response.body, limit, fs.createWriteStream(file, { flags:'wx' }));
      if (bytes !== row.bytes || await digest(file) !== row.sha256) fail('下载组件与已登记摘要不一致。');
      return await importComponent(file);
    } finally { if (inside(root,temp) && path.basename(temp).startsWith('.download-')) await fsp.rm(temp,{recursive:true,force:true}); }
  }
  return { root, importComponent, activateRuntime, activateCore, registerPayloadContext, inventory, checkUpdates, downloadComponent, catalog: availableCatalog };
}
function readCachedComponents(root) {
  const file = path.join(root, 'inventory.json');
  if (!fs.existsSync(file)) return [];
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) fail('组件库存损坏。');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.schemaVersion !== 1 || !Array.isArray(data.packages) || data.packages.length > 256) fail('组件库存损坏。');
  return data.packages;
}
module.exports = { createComponentLibrary, readCachedComponents, relativeName, unpack };
