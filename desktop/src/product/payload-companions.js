'use strict';
const { appError } = require('./errors');

// Full face backend shipped by the unified3 package. No arbitrary subdirectories
// or additional executable resources can enter an installation through this map.
const NAMES = Object.freeze(['nr_face/LICENSE', 'nr_face/onnxruntime_providers_shared.dll',
  'nr_face/onnxruntime.dll', 'nr_face/ThirdPartyNotices.txt', 'nr_face/yunet-dynamic.json',
  'nr_face/yunet-dynamic.onnx', 'nr_face/YUNET-LICENSE']);
const HASH = /^[a-f0-9]{64}$/i;
const isCompanionName = name => NAMES.includes(name);
const required = version => ['0.5-dline21-unified3', require('./unified5-core').ID].includes(version);
function validateMap(value, version) {
  if (value === undefined && !required(version)) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== NAMES.length ||
      NAMES.some(name => !HASH.test(value[name] || '')) || Object.keys(value).some(name => !isCompanionName(name)))
    throw appError('ERR_PAYLOAD_HASH', { file: 'companions', reason: 'incomplete-or-unknown-resource' });
  return value;
}
function validateRows(rows, version) {
  if (rows === undefined && !required(version)) return [];
  if (!Array.isArray(rows) || rows.length !== NAMES.length || new Set(rows.map(row => row?.name)).size !== NAMES.length ||
      rows.some(row => !row || !isCompanionName(row.name) || typeof row.file !== 'string' || !HASH.test(row.actual || '')))
    throw appError('ERR_PAYLOAD_HASH', { file: 'companions', reason: 'incomplete-or-unknown-resource' });
  return rows;
}
module.exports = { NAMES, isCompanionName, required, validateMap, validateRows };
