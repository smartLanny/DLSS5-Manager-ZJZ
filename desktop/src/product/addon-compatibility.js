'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { resolveAddonLoadState } = require('./addon-loading-layout');
const { addonValues } = require('./reshade-layout');

const HASH = /^[a-f0-9]{64}$/i;
const key = file => path.resolve(file).toLowerCase();
const ownRoles = new Set(['addon', 'core', 'carrier', 'native-carrier', 'provider', 'feeder-provider']);
const conflictClasses = new Set(['renodx-generic-nr', 'renodx-dlss5']);
const PROTECTED = /^(?:dxgi|d3d9|d3d10(?:_1)?|d3d11|d3d12|opengl32|dinput8|version|winmm|dsound|nvngx_dlss(?:g|d|nr)?|nrchain_nvngx|_nvngx)\.dll$/i;
const addonDeclarations = new Set(['core', 'native-carrier', 'renodx-hdr', 'renodx-other', 'renodx-generic-nr', 'renodx-dlss5', 'mfgunlock']);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function planAddonCompatibility(snapshot, { knownComponents = [], keep = [], selectedCore = null, selectedComponents = [] } = {}) {
  if (!snapshot || snapshot.version !== 1 || !HASH.test(snapshot.fingerprint || '') || !Array.isArray(snapshot.files))
    throw Object.assign(new Error('需要完整插件加载预览。'), { code: 'ADDON_SNAPSHOT_INVALID' });
  const blockers = [...(snapshot.blockers || [])], decisions = [];
  if (!Array.isArray(knownComponents) || knownComponents.length > 512 || !Array.isArray(keep) || keep.length > 128)
    throw Object.assign(new Error('插件身份或例外清单超出范围。'), { code: 'ADDON_POLICY_INVALID' });
  const known = knownComponents.filter(row => row && HASH.test(row.sha256 || '') && (!row.path || path.isAbsolute(row.path)));
  if (!Array.isArray(selectedComponents) || selectedComponents.length > 128) throw Object.assign(new Error('选定组件清单超出范围。'), { code: 'ADDON_POLICY_INVALID' });
  const selected = [...selectedComponents, ...(selectedCore ? [selectedCore] : [])];
  if (known.length !== knownComponents.length) blockers.push({ code: 'ADDON_KNOWN_INVALID', message: '固定组件身份缺少有效摘要或路径。' });
  const exceptions = new Map();
  for (const row of keep) {
    if (!row || !path.isAbsolute(row.path || '') || !HASH.test(row.sha256 || '') || row.configFingerprint !== snapshot.configFingerprint || exceptions.has(key(row.path))) {
      blockers.push({ code: 'ADDON_KEEP_STALE', message: '插件保留选择未绑定当前文件和加载配置，请重新选择。', path: row?.path }); continue;
    }
    exceptions.set(key(row.path), row);
  }
  const disabledValues = addonValues(snapshot.profile?.config || '').get('DisabledAddons') || [];
  for (const observed of snapshot.files) {
    const identities = known.filter(row => row.sha256.toLowerCase() === observed.sha256 && (!row.path || key(row.path) === key(observed.path)));
    const roles = new Set(identities.map(row => row.role || row.kind));
    const own = identities.some(row => ownRoles.has(row.role || row.kind));
    const carrier = identities.some(row => ['carrier', 'native-carrier'].includes(row.role || row.kind));
    const provider = identities.some(row => ['provider', 'feeder-provider'].includes(row.role || row.kind));
    // File identity and ownership are separate: matching a curated hash never
    // makes an existing user file ours. Only a path-bound owner record may.
    const owned = identities.some(row => row.owned === true && row.path && key(row.path) === key(observed.path));
    const names = [...new Set(identities.map(row => row.registeredName).filter(value => typeof value === 'string'))];
    const row = names.length === 1 && observed.registeredName === null ? { ...observed,
      ...resolveAddonLoadState({ ...observed, registeredName: names[0], disabledValues, hostArchitecture: snapshot.architecture }), registeredName: names[0] } : observed;
    const decision = { path: row.path, name: row.name, sha256: row.sha256, bytes: row.bytes,
      configFingerprint: snapshot.configFingerprint, sourceFingerprint: snapshot.fingerprint, gameId: snapshot.gameId,
      loadState: row.loadState, searched: row.searched, explicit: row.explicit, moduleMayLoad: row.moduleMayLoad,
      classification: own ? carrier ? 'native-carrier' : provider ? 'feeder-provider' : 'core' : row.classification, confidence: identities.length ? 'verified' : row.confidence,
      owned, mandatory: false, action: 'preserve', reason: '该文件不在当前可加载范围，保留原位。' };
    const exception = exceptions.get(key(row.path));
    if (exception && exception.sha256.toLowerCase() !== row.sha256) blockers.push({ code: 'ADDON_KEEP_STALE', path: row.path, message: '保留文件摘要已变化。' });
    else if (row.moduleMayLoad) {
      const definiteConflict = !own && (identities.some(item => item.compatibility === 'conflict') ||
        conflictClasses.has(row.classification) && ['verified', 'declared'].includes(row.confidence));
      const compatible = !definiteConflict && identities.some(item => item.compatibility === 'compatible');
      const ordinaryDll = /\.dll$/i.test(row.path) && !identities.length && row.nameSource !== 'name-export' &&
        !(addonDeclarations.has(row.classification) && ['declared', 'verified'].includes(row.confidence));
      if (!row.sha256 || row.loadState === 'unavailable') {
        decision.reason = '无法核对实际可加载插件，未生成文件操作。';
      } else if (PROTECTED.test(row.name)) {
        Object.assign(decision, { action: 'preserve', reason: '原生运行库或图形加载入口由其组件所有者处理，不作为 Add-on 搬移。' });
      } else if (ordinaryDll && !exception) {
        decision.reason = '显式 DLL 尚未确认是 Add-on，保留原文件并核对其来源。';
        blockers.push({ code: 'ADDON_EXPLICIT_DLL_UNVERIFIED', path: row.path, message: '该显式 DLL 没有可确认的插件身份，未自动移动；请核对来源或明确保留当前加载。' });
      } else if (own) {
        const chosen = selected.some(item => item && path.isAbsolute(item.path || '') && key(item.path) === key(row.path) && item.sha256 === row.sha256);
        const label = carrier ? '配套桥接器' : provider ? 'Feeder 输入组件' : 'Core';
        Object.assign(decision, { action: chosen ? 'keep' : 'retire-core', mandatory: !chosen,
          reason: chosen ? `复用选定的本项目${label}；原有文件所有权保持不变。` : `本项目旧${label}按升级备份停用，只保留选定的活动配套。` });
      } else if (definiteConflict) Object.assign(decision, { action: 'isolate', mandatory: true, reason: '组件身份确认会占用另一 NR 路径，必须备份隔离。' });
      else if (compatible) Object.assign(decision, { action: 'keep',
        ...(identities.some(item => item.compatibilitySource === 'user-choice' || item.compatibilitySource === 'explicit-keep') ?
          { explicitKeep: true, reason: '沿用已应用配置中绑定同一插件摘要的明确保留选择。' } : { reason: '固定摘要已验证兼容，保留现有插件和配置。' }) });
      else if (exception && exception.sha256.toLowerCase() === row.sha256) Object.assign(decision, { action: 'keep', explicitKeep: true, reason: '用户明确保留当前游戏、路径、摘要及加载配置绑定的插件。' });
      else Object.assign(decision, { action: 'isolate', reason: '实际可加载插件的兼容性尚未确认，默认备份隔离；可明确选择保留。' });
      if (exception && decision.mandatory) blockers.push({ code: 'ADDON_KEEP_FORBIDDEN', path: row.path, message: '已确认冲突或待升级旧 Core 不能以保留例外重复启用。' });
      if (roles.size > 1 && own && identities.some(item => item.compatibility === 'conflict')) blockers.push({ code: 'ADDON_IDENTITY_CONFLICT', path: row.path, message: '固定身份记录对同一文件给出矛盾用途。' });
    }
    decisions.push(decision);
  }
  for (const [file, row] of exceptions) if (!snapshot.files.some(value => key(value.path) === file)) blockers.push({ code: 'ADDON_KEEP_STALE', path: row.path, message: '保留例外对应插件已不在当前加载清单。' });
  const result = { version: 1, gameId: snapshot.gameId, exeDir: snapshot.exeDir, configFingerprint: snapshot.configFingerprint,
    sourceFingerprint: snapshot.fingerprint, decisions, blockers,
    isolate: decisions.filter(row => row.action === 'isolate'), retire: decisions.filter(row => row.action === 'retire-core'),
    keep: decisions.filter(row => row.action === 'keep'), preserve: decisions.filter(row => row.action === 'preserve') };
  result.fingerprint = hash({ source: result.sourceFingerprint, decisions, blockers });
  return result;
}

module.exports = { planAddonCompatibility };
