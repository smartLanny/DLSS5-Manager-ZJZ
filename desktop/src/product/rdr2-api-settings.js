'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SUPPORTED_APIS = Object.freeze(['vulkan', 'dx12']);
const MAX_BYTES = 64 * 1024;
const ROOT_TAG = 'rage__fwuiSystemSettingsCollection';
const API_PATH = `${ROOT_TAG}/advancedGraphics/API`;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function localAbsolute(value) {
  return typeof value === 'string' && !value.includes('\0') && path.isAbsolute(value) &&
    (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(value));
}
function target(input) {
  return String(input?.steamAppId) === '1174180' && localAbsolute(input?.entryRoot) && localAbsolute(input?.exe) &&
    same(input.exe, path.join(input.entryRoot, 'RDR2.exe'));
}
function documentsFolder(options) {
  if (options.documentsDir !== undefined) return localAbsolute(options.documentsDir) ? options.documentsDir : null;
  // Electron resolves the Windows Documents Known Folder, including OneDrive
  // redirection. A stale USERPROFILE/Documents copy is not a fallback source.
  try { const folder = require('electron').app?.getPath('documents'); return localAbsolute(folder) ? folder : null; }
  catch { return null; }
}
function plainSettingsFile(file) {
  const full = path.resolve(file), parsed = path.parse(full); let current = parsed.root, stat;
  for (const part of full.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1) return null;
  }
  return stat?.isFile() && stat.size > 0 && stat.size <= MAX_BYTES ? stat : null;
}
function parseSettings(xml) {
  // Parse the bounded document structurally. Never resolve DTDs/entities or
  // infer a setting from comments, CDATA, duplicate nodes or an unrelated path.
  const stack = []; let offset = 0, roots = 0, advanced = 0, apis = 0, value = '', nodes = 0, declaration = false;
  let valueStart = -1, valueEnd = -1;
  while (offset < xml.length) {
    const next = xml.indexOf('<', offset), endText = next < 0 ? xml.length : next;
    const content = xml.slice(offset, endText);
    if (!stack.length && content.trim()) return null;
    if (stack.join('/') === API_PATH) value += content;
    if (next < 0) { offset = xml.length; break; }
    if (xml.startsWith('<!--', next)) {
      if (stack.join('/') === API_PATH) return null;
      const end = xml.indexOf('-->', next + 4); if (end < 0 || xml.slice(next + 4, end).includes('--')) return null;
      offset = end + 3; continue;
    }
    if (xml.startsWith('<?xml ', next)) {
      if (declaration || roots || xml.slice(0, next).trim()) return null;
      const end = xml.indexOf('?>', next + 6); if (end < 0) return null;
      if (!/^<\?xml\s+version\s*=\s*(['"])1\.0\1(?:\s+(?:encoding|standalone)\s*=\s*(?:"[^"<>]+"|'[^'<>]+'))*\s*\?>$/.test(xml.slice(next, end + 2))) return null;
      declaration = true; offset = end + 2; continue;
    }
    let end = next + 1, quote = null;
    for (; end < xml.length; end++) {
      const char = xml[end];
      if (quote) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      else if (char === '<') return null;
    }
    if (end === xml.length || ++nodes > 2048) return null;
    const token = xml.slice(next + 1, end);
    if (token.startsWith('/')) {
      const close = token.match(/^\/([a-zA-Z_][\w.-]*)\s*$/);
      if (stack.join('/') === API_PATH) valueEnd = next;
      if (!close || stack.pop() !== close[1]) return null;
    } else {
      const open = token.match(/^([a-zA-Z_][\w.-]*)((?:\s+[a-zA-Z_][\w.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*)(\/?)$/);
      if (!open || stack.length >= 16 || stack[stack.length - 1] === 'API') return null;
      const name = open[1], at = [...stack, name].join('/');
      if (!stack.length && (++roots !== 1 || name !== ROOT_TAG)) return null;
      const attributes = [...open[2].matchAll(/([a-zA-Z_][\w.-]*)\s*=/g)].map(match => match[1]);
      if (new Set(attributes).size !== attributes.length) return null;
      if (at === `${ROOT_TAG}/advancedGraphics` && ++advanced !== 1) return null;
      if (name === 'API') {
        if (at !== API_PATH || ++apis !== 1 || attributes.length || open[3]) return null;
        valueStart = end + 1;
      }
      if (!open[3]) stack.push(name);
    }
    offset = end + 1;
  }
  if (stack.length || roots !== 1 || advanced !== 1 || apis !== 1 || valueEnd < valueStart) return null;
  const api = ({ kSettingAPI_DX12: 'dx12', kSettingAPI_Vulkan: 'vulkan' })[value.trim()];
  return api ? { api, valueStart, valueEnd } : null;
}
function decode(bytes) {
  let xml, encoding = 'utf8', bom = Buffer.alloc(0);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf16le'; bom = bytes.subarray(0, 2); if (bytes.length % 2) return null; xml = bytes.subarray(2).toString('utf16le'); }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf16be'; bom = bytes.subarray(0, 2); if (bytes.length % 2) return null; xml = Buffer.from(bytes.subarray(2)).swap16().toString('utf16le'); }
  else { if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) bom = bytes.subarray(0, 3); xml = bytes.subarray(bom.length).toString('utf8'); }
  if (/[\u0000\ufffd]/.test(xml)) return null;
  return { xml, encoding, bom };
}
function encode(xml, document) {
  const body = Buffer.from(xml, document.encoding === 'utf8' ? 'utf8' : 'utf16le');
  if (document.encoding === 'utf16be') body.swap16();
  return Buffer.concat([document.bom, body]);
}

function createRdr2ApiSettings(options = {}) {
  function snapshot(input) {
    const matched = target(input), documents = matched ? documentsFolder(options) : null;
    const file = documents ? path.join(documents, 'Rockstar Games', 'Red Dead Redemption 2', 'Settings', 'system.xml') : null;
    const state = { matched, api: null, supportedApis: matched ? [...SUPPORTED_APIS] : [], file, sha256: null, canSync: false };
    if (!matched || !file) return { state };
    let fd;
    try {
      const before = plainSettingsFile(file); if (!before) return { state };
      fd = fs.openSync(file, 'r'); const stat = fs.fstatSync(fd);
      if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs) return { state };
      const bytes = Buffer.alloc(stat.size); let count = 0;
      while (count < bytes.length) { const read = fs.readSync(fd, bytes, count, bytes.length - count, count); if (!read) return { state }; count += read; }
      const after = plainSettingsFile(file), current = fs.fstatSync(fd);
      if (!after || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs ||
          current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) return { state };
      const document = decode(bytes), parsed = document && parseSettings(document.xml);
      if (!parsed || !encode(document.xml, document).equals(bytes)) return { state };
      return { state: { ...state, api: parsed.api, sha256: hash(bytes), canSync: true }, bytes, document, parsed };
    } catch { return { state }; }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  }
  function read(input) { return snapshot(input).state; }
  function prepareMutation(input) {
    if (!SUPPORTED_APIS.includes(input?.api)) fail('RDR2_API_UNSUPPORTED', 'RDR2 只支持 Vulkan 或 DirectX 12 图形 API。');
    const current = snapshot(input);
    if (!current.state.matched) fail('RDR2_SETTINGS_IDENTITY', '未匹配已发现的 Steam RDR2 游戏程序，未生成设置修改计划。');
    if (!current.state.canSync) fail('RDR2_SETTINGS_UNAVAILABLE', '当前文档目录的 RDR2 图形设置无法安全读取，未生成修改计划。');
    const { document, parsed } = current, value = document.xml.slice(parsed.valueStart, parsed.valueEnd);
    const replacement = value.replace(/kSettingAPI_(?:DX12|Vulkan)/, input.api === 'dx12' ? 'kSettingAPI_DX12' : 'kSettingAPI_Vulkan');
    const after = encode(document.xml.slice(0, parsed.valueStart) + replacement + document.xml.slice(parsed.valueEnd), document);
    return { file: current.state.file, api: input.api, supportedApis: [...SUPPORTED_APIS], changed: !after.equals(current.bytes),
      before: { bytes: current.bytes, sha256: current.state.sha256 }, after: { bytes: after, sha256: hash(after) },
      identity: { exe: path.resolve(input.exe), steamAppId: '1174180', entryRoot: path.resolve(input.entryRoot) } };
  }
  return Object.freeze({ read, inspect: read, prepareMutation });
}

module.exports = { createRdr2ApiSettings };
