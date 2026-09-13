'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { addonValues } = require('./reshade-layout');
const { ensureDefaultReShadeHotkey, PREVIOUS_RESHADE_DEFAULT_KEY } = require('./hotkeys');

// Exact path-key contract shipped in 0.4.8-beta.1. This is used only to
// validate an inactive profile against its already committed restore snapshot.
const BETA1_PATH_KEYS = new Set([
  'GENERAL/EffectSearchPaths', 'GENERAL/TextureSearchPaths', 'GENERAL/PresetPath',
  'GENERAL/StartupPresetPath', 'GENERAL/IntermediateCachePath', 'GENERAL/ScreenshotPath',
  'SCREENSHOT/SavePath', 'SCREENSHOT/PostSaveCommand'
]);
const PATH_KEYS = new Set([
  ...BETA1_PATH_KEYS, 'SCREENSHOT/PostSaveCommandWorkingDirectory',
  'SCREENSHOT/SoundPath', 'STYLE/Font', 'STYLE/LatinFont', 'STYLE/EditorFont'
]);
const scalar = value => String(value).replace(/,/g, ',,');
function lines(text) { return String(text || '').split(/(?<=\n)/); }
function entries(text) {
  let section = '', counts = new Map();
  return lines(text).map((line, index) => {
    const header = line.replace(/^\uFEFF/, '').match(/^[ \t]*\[([^\]]+)\]/);
    if (header) section = header[1].trim();
    const match = line.match(/^([ \t]*([^=;\s][^=]*?)[ \t]*=[ \t]*)(.*?)(\r?\n|$)$/);
    if (!match || /^[;#\/]/.test(line.trim())) return { line, index, section };
    const key = match[2].trim(), identity = section + '/' + key;
    const occurrence = counts.get(identity) || 0; counts.set(identity, occurrence + 1);
    return { line, index, section, key, identity, occurrence, prefix: match[1], value: match[3], end: match[4] };
  });
}
function setScalar(text, section, key, value) {
  const rows = entries(text), wanted = rows.filter(row => row.section === section && row.key === key);
  if (wanted.length) {
    const first = wanted[0].index;
    return rows.map(row => row.section === section && row.key === key
      ? row.index === first && value !== null ? row.prefix + scalar(value) + row.end : ''
      : row.line).join('');
  }
  if (value === null) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const header = rows.find(row => row.section === section && /^\s*\[/.test(row.line.replace(/^\uFEFF/, '')));
  if (header) {
    rows[header.index].line = rows[header.index].line.replace(/(?:\r?\n)?$/, eol) + key + '=' + scalar(value) + eol;
    return rows.map(row => row.line).join('');
  }
  return text + (text && !text.endsWith('\n') ? eol : '') + '[' + section + ']' + eol + key + '=' + scalar(value) + eol;
}
function expandEnvironment(value, environment = process.env) {
  return value.replace(/%([^%]+)%/g, (whole, key) => environment[key] || whole);
}
function externalConfig(original, oldBase, environment = process.env, options = {}) {
  const pathKeys = options.pathVersion === 'beta1' ? BETA1_PATH_KEYS : PATH_KEYS;
  const rewritten = entries(original).map(row => {
    if (!pathKeys.has(row.identity) || row.identity === 'SCREENSHOT/PostSaveCommand') return row.line;
    const values = addonValues('[' + row.section + ']\n' + row.key + '=' + row.value, row.section).get(row.key);
    if (!values) return row.line;
    const mapped = values.map(value => {
      if (!value || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return value;
      const expanded = expandEnvironment(value, environment);
      return path.isAbsolute(expanded) ? expanded : path.resolve(oldBase, expanded);
    });
    return row.prefix + mapped.map(scalar).join(',') + row.end;
  }).join('');
  let result = setScalar(setScalar(rewritten, 'INSTALL', 'BasePath', null), 'ADDON', 'AddonPath', '.');
  if (options.directLoads) {
    result = setScalar(result, 'ADDON', 'LoadFromDllMain', null);
    if (options.directLoads.length) {
      const eol = result.includes('\r\n') ? '\r\n' : '\n';
      result = result.replace(/\[ADDON\][^\r\n]*(?:\r?\n|$)/, header => header + 'LoadFromDllMain=' + options.directLoads.map(scalar).join(',') + eol);
    }
  }
  return result;
}
function localConfig(current, original, oldBase, environment = process.env,
  { panelDefaultAdded = false, panelDefaultKey = PREVIOUS_RESHADE_DEFAULT_KEY } = {}) {
  // Restore the original spelling only for path fields the user did not edit.
  // Other settings and comments from the active external INI survive migration.
  const prepared = externalConfig(original, oldBase, environment);
  if (panelDefaultAdded && current === ensureDefaultReShadeHotkey(prepared, panelDefaultKey)) return original;
  const expected = entries(prepared);
  const before = new Map(entries(original).filter(row => row.key).map(row => [row.identity + ':' + row.occurrence, row]));
  const rebased = new Map(expected.filter(row => row.key).map(row => [row.identity + ':' + row.occurrence, row]));
  let restored = entries(current).map(row => {
    if (!row.key) return row.line;
    const id = row.identity + ':' + row.occurrence, a = before.get(id), b = rebased.get(id);
    return a && b && row.line === b.line && PATH_KEYS.has(row.identity) ? a.line : row.line;
  }).join('');
  const originalAddon = addonValues(original).get('AddonPath')?.[0];
  restored = setScalar(restored, 'ADDON', 'AddonPath', originalAddon || '.');
  restored = setScalar(restored, 'INSTALL', 'BasePath', null);
  // Avoid adding a synthetic ADDON section when the original and active file
  // have no other changes: a complete migration round trip keeps exact bytes.
  if (current === externalConfig(original, oldBase, environment)) return original;
  return restored;
}
function loaderConfig(original, runtimeDir) {
  return setScalar(original, 'INSTALL', 'BasePath', runtimeDir);
}

// ReShade 6.8 reads this setting as paths, while Luma's AddonInit reads a
// bool. Accept only a lone legacy 0/1 with no possible numeric module. Never
// teach the shared INI parser that numbers generally mean disabled loading.
function inspectLegacyDirectLoad(values, exeDir, addonDir, environment) {
  if (values.length !== 1 || !/^[01]$/.test(values[0])) return null;
  const getEnvironment = name => {
    const matches = Object.entries(environment).filter(([key]) => key.toLowerCase() === name.toLowerCase());
    if (new Set(matches.map(([, value]) => value)).size > 1) throw new Error('数字早期加载项的环境路径存在歧义。');
    return matches[0]?.[1] || '';
  };
  const systemRoot = getEnvironment('SystemRoot') || getEnvironment('windir') || process.env.SystemRoot || process.env.windir || '';
  const searchPath = getEnvironment('PATH');
  if (typeof searchPath !== 'string' || searchPath.length > 32768) throw new Error('数字早期加载项的搜索路径无法完整核对。');
  const directories = [addonDir, exeDir];
  if (systemRoot) directories.push(systemRoot, path.join(systemRoot, 'System32'), path.join(systemRoot, 'SysWOW64'));
  // The fixed ReShade call uses an absolute target and SEARCH_DEFAULT_DIRS,
  // which does not search PATH. Check these wider candidates conservatively
  // as well, so a real numeric DLL is never waived as a boolean convention.
  for (const entry of searchPath.split(path.delimiter)) {
    if (!entry) continue;
    const directory = entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
    if (!path.isAbsolute(directory) || /[%\x00-\x1f"]/.test(directory)) throw new Error('数字早期加载项的搜索路径无法明确解析。');
    directories.push(directory);
  }
  if (directories.length > 256) throw new Error('数字早期加载项的搜索目录过多。');
  const checkedPaths = [];
  if (directories.some(directory => typeof directory !== 'string' || !path.isAbsolute(directory) || /^\\\\/.test(directory) || /[%\x00-\x1f"]/.test(directory)))
    throw new Error('数字早期加载项的搜索路径无法明确解析。');
  for (const directory of new Set(directories.map(value => path.resolve(value)))) {
    for (const name of [values[0], values[0] + '.dll']) {
      // This is an absence check, not permission to own/load a PATH file.
      // lstat resolves directory links and also detects a dangling target
      // link. Anything except a definite missing target remains a blocker.
      const file = path.join(directory, name);
      try {
        fs.lstatSync(file);
        throw new Error('数字早期加载项存在实际目标，不能按旧布尔配置忽略：' + file);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      checkedPaths.push(file);
    }
  }
  return { value: values[0], checkedPaths, environment: { PATH: searchPath, SystemRoot: systemRoot } };
}

// Describe the configuration actually selected by ReShade without creating any
// directories, receipts or caches. Missing user content is distinct from an
// ambiguous or unsafe loading path.
function inspectProfile(exeDir, environment = process.env) {
  const rootConfigPath = path.join(exeDir, 'ReShade.ini'), blockers = [], warnings = [], identities = new Map();
  const check = file => {
    if (!path.isAbsolute(file) || /^\\\\/.test(file)) throw new Error('不支持网络或不确定的 ReShade 路径。');
    for (let current = path.resolve(file);;) {
      try { const stat = fs.lstatSync(current); if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1) throw new Error('ReShade 路径含链接。'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const parent = path.dirname(current); if (parent === current) break; current = parent;
    }
    return file;
  };
  const read = file => {
    check(file);
    try { const stat = fs.statSync(file); if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('ReShade 配置不是可检查的文件。');
      const bytes = fs.readFileSync(file), after = fs.statSync(file);
      if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ino !== after.ino) throw new Error('ReShade 配置在读取时变化。');
      identities.set(file, { file, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch (error) { if (error.code === 'ENOENT') { identities.set(file, { file, sha256: null }); return ''; } throw error; }
  };
  const resolve = (base, value) => {
    const expanded = expandEnvironment(value, environment);
    if (/%[^%]+%/.test(expanded) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(expanded)) throw new Error('ReShade 配置路径无法明确解析。');
    return check(path.resolve(base, expanded));
  };
  let rootConfig = '', config = '', baseDir = exeDir, addonDir = exeDir, activeConfigPath = rootConfigPath, directLoads = [], legacyDirectLoad = null;
  try {
    rootConfig = read(rootConfigPath);
    const bases = addonValues(rootConfig, 'INSTALL').get('BasePath') || [];
    if (bases.length > 1 && new Set(bases).size > 1) throw new Error('ReShade 指定了多个运行根目录。');
    const candidates = [bases[0], environment.RESHADE_BASE_PATH_OVERRIDE].filter(Boolean).map(value => resolve(exeDir, value));
    const existing = candidates.filter(file => fs.existsSync(file) && fs.statSync(file).isDirectory());
    if (new Set(existing.map(file => file.toLowerCase())).size > 1) throw new Error('ReShade 运行根目录与环境覆盖不一致。');
    if (existing.length) baseDir = existing[0];
    else if (candidates.length) warnings.push({ code: 'RESHade_BASE_MISSING', path: candidates[0], message: '原 ReShade 运行目录缺失，当前使用游戏目录配置。' });
    activeConfigPath = path.join(baseDir, 'ReShade.ini'); config = baseDir === exeDir ? rootConfig : read(activeConfigPath);
    const values = addonValues(config), dirs = values.get('AddonPath') || ['.'];
    if (dirs.length > 1 && new Set(dirs).size > 1) throw new Error('ReShade 指定了多个插件搜索目录，未猜测活动目录。');
    addonDir = resolve(baseDir, dirs[0]);
    if (fs.existsSync(addonDir) && !fs.statSync(addonDir).isDirectory()) throw new Error('插件搜索路径不是目录。');
    if (!fs.existsSync(addonDir)) warnings.push({ code: 'ADDON_DIRECTORY_MISSING', path: addonDir, message: '原插件目录不存在，未发现可迁移的旧插件。' });
    const directValues = values.get('LoadFromDllMain') || [];
    legacyDirectLoad = inspectLegacyDirectLoad(directValues, exeDir, addonDir, environment);
    if (legacyDirectLoad) warnings.push({ code: 'ADDON_LEGACY_BOOLEAN_LOAD', value: legacyDirectLoad.value,
      message: '原 LoadFromDllMain=' + legacyDirectLoad.value + ' 使用旧插件布尔约定，未发现对应模块；迁移时不保留此早期加载项。' });
    directLoads = (legacyDirectLoad ? [] : directValues).map(value => ({ value, path: resolve(addonDir, value) }));
    for (const row of directLoads) if (!fs.existsSync(row.path)) throw new Error('原配置显式加载的插件文件缺失：' + row.value);
    for (const [key, values] of addonValues(config, 'GENERAL')) if (['EffectSearchPaths', 'TextureSearchPaths'].includes(key)) {
      for (const value of values) {
        const file = resolve(baseDir, value.replace(/[\\/][*].*$/, ''));
        if (!fs.existsSync(file)) warnings.push({ code: 'FILTER_DIRECTORY_MISSING', path: file, message: '原滤镜或纹理目录缺失；仅保留配置路径，不声称恢复其内容。' });
      }
    }
  } catch (error) { blockers.push({ code: 'DEPLOYMENT_SOURCE_LAYOUT', message: error.message }); }
  return { rootConfigPath, rootConfig, activeConfigPath, config, baseDir, addonDir, directLoads, legacyDirectLoad, identities: [...identities.values()],
    configured: { loaderDir: exeDir, baseDir, addonDir, activeConfigPath }, warnings, blockers, ok: blockers.length === 0 };
}
module.exports = { externalConfig, localConfig, loaderConfig, setScalar, PATH_KEYS, inspectProfile };
