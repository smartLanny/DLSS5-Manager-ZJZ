'use strict';

const fs = require('fs');
const path = require('path');
const { inspectPayload } = require('./payload');

function sourceError(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}

function checkedDirectory(dir) {
  let stat;
  try { stat = fs.lstatSync(dir); } catch (error) {
    if (error.code === 'ENOENT') sourceError('ERR_PAYLOAD_SOURCE_MISSING', '找不到所选组件目录。', { path: dir });
    sourceError('ERR_PAYLOAD_SOURCE_INVALID', '无法安全读取所选组件目录。', { path: dir, reason: error.code || 'read-error' });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) sourceError('ERR_PAYLOAD_SOURCE_INVALID', '组件目录不能是文件、符号链接或目录联接。', { path: dir });
  try { return fs.realpathSync(dir); }
  catch (error) { sourceError('ERR_PAYLOAD_SOURCE_INVALID', '无法解析所选组件目录。', { path: dir, reason: error.code || 'realpath-error' }); }
}

function resolvePayloadDirectory(selectedPath) {
  if (typeof selectedPath !== 'string' || !path.isAbsolute(selectedPath)) sourceError('ERR_PAYLOAD_SOURCE_INVALID', '请选择绝对路径下的组件目录或 bundle.json。', { path: selectedPath });
  const selected = path.resolve(selectedPath); let stat;
  try { stat = fs.lstatSync(selected); } catch (error) {
    if (error.code === 'ENOENT') sourceError('ERR_PAYLOAD_SOURCE_MISSING', '找不到所选组件目录或 bundle.json。', { path: selected });
    sourceError('ERR_PAYLOAD_SOURCE_INVALID', '无法安全读取所选组件来源。', { path: selected, reason: error.code || 'read-error' });
  }
  if (stat.isSymbolicLink()) sourceError('ERR_PAYLOAD_SOURCE_INVALID', '组件来源不能是符号链接或目录联接。', { path: selected });
  if (stat.isFile()) {
    if (path.basename(selected).toLowerCase() !== 'bundle.json') sourceError('ERR_PAYLOAD_SOURCE_INVALID', '所选文件必须是 bundle.json。', { path: selected });
    return checkedDirectory(path.dirname(selected));
  }
  if (!stat.isDirectory()) sourceError('ERR_PAYLOAD_SOURCE_INVALID', '所选路径不是组件目录。', { path: selected });
  const base = checkedDirectory(selected);
  for (const candidate of [base, path.join(base, 'nr-before-sr'), path.join(base, 'payload', 'nr-before-sr')]) {
    let candidateStat;
    try { candidateStat = fs.lstatSync(candidate); } catch { continue; }
    if (candidateStat.isSymbolicLink()) sourceError('ERR_PAYLOAD_SOURCE_INVALID', '组件来源不能包含符号链接或目录联接。', { path: candidate });
    if (!candidateStat.isDirectory()) continue;
    const bundle = path.join(candidate, 'bundle.json');
    try {
      const bundleStat = fs.lstatSync(bundle);
      if (bundleStat.isFile() && !bundleStat.isSymbolicLink()) return checkedDirectory(candidate);
    } catch {}
  }
  sourceError('ERR_PAYLOAD_SOURCE_MISSING', '所选目录中没有找到可用的 bundle.json。', { path: base });
}

function inspectSource(selectedPath, options = {}) {
  const dir = resolvePayloadDirectory(selectedPath); let inspection;
  try { inspection = inspectPayload(dir, { hardwareFamily: options.hardwareFamily, version: options.version }); }
  catch (error) {
    const details = { path: dir, ...(error.details || {}) };
    if (error.code === 'ERR_PAYLOAD_MISSING') sourceError('ERR_PAYLOAD_SOURCE_MISSING', '外部组件目录缺少清单声明的文件。', details);
    if (error.code === 'ERR_PAYLOAD_HASH') sourceError('ERR_PAYLOAD_SOURCE_HASH', '外部组件目录的清单、路径或文件校验失败。', details);
    sourceError('ERR_PAYLOAD_SOURCE_INVALID', '无法安全读取外部组件目录。', { ...details, reason: error.code || 'read-error' });
  }
  if (options.version && inspection.selectedVersion !== options.version) sourceError('ERR_PAYLOAD_SOURCE_MISSING', '外部组件目录不包含所选版本。', { path: dir, version: options.version });
  if (inspection.missing.length) sourceError('ERR_PAYLOAD_SOURCE_MISSING', '外部组件目录缺少所需文件。', { path: dir, files: inspection.missing });
  if (!inspection.ready || inspection.invalid.length) sourceError('ERR_PAYLOAD_SOURCE_HASH', '外部组件目录文件与清单哈希不一致。', { path: dir, files: inspection.invalid });
  return { ...inspection, dir };
}

module.exports = { resolvePayloadDirectory, inspectSource };
