'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { snapshotAddonLoadingLayout, assertAddonSnapshot } = require('./addon-loading-layout');
const { planAddonCompatibility } = require('./addon-compatibility');
const { knownPayloadComponents } = require('./component-registry');
const { addonValues } = require('./reshade-layout');
const { INSTALLED_NAMES } = require('./constants');
const { noLinks, digestFile, inside } = require('./launch-safety');
const { manifestPath } = require('./manifest');
const { ensureDefaultReShadeHotkey } = require('./hotkeys');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function removeExplicitReferences(text, addonDir, removed) {
  let section = '';
  return String(text).split('\n').map(line => {
    const header = line.match(/^(?:\uFEFF)?\s*\[([^\]]+)\]/);
    if (header) { section = header[1].trim(); return line; }
    const match = section === 'ADDON' && line.match(/^([ \t]*LoadFromDllMain[ \t]*=[ \t]*)(.*?)(\r?)$/);
    if (!match) return line;
    const original = addonValues(`[ADDON]\nLoadFromDllMain=${match[2]}`).get('LoadFromDllMain') || [];
    const retained = original.filter(value => !removed.some(file => same(path.resolve(addonDir, value), file)));
    return retained.length === original.length ? line : `${match[1]}${retained.map(value => value.replaceAll(',', ',,')).join(',')}${match[3]}`;
  }).join('\n');
}
async function compileNativeAddonPolicy({ game, payloadDir, payload, manifest, addonKeep = [], knownComponents = [], preserveOwned = false }) {
  const exeDir = path.dirname(game.scan.chosen.path), snapshot = await snapshotAddonLoadingLayout({ exeDir, gameId: game.id, architecture: 64 });
  const roles = { addon: 'core', carrier: 'carrier' };
  const owned = (manifest?.files || []).filter(row => roles[row.kind]).map(row => ({ path: path.resolve(game.dir, row.rel),
    sha256: row.installedSha256, role: roles[row.kind], owned: true, owner: 'native-nr' }));
  const api = require('./operation-api').resolveOperationApi(game).effectiveApi;
  const selectedPaths = [path.join(exeDir, INSTALLED_NAMES.addon), ...(api === 'dx11' ? [path.join(exeDir, INSTALLED_NAMES.carrier)] : [])];
  if (preserveOwned) selectedPaths.push(...owned.map(row => row.path));
  const selectedComponents = snapshot.files.filter(row => selectedPaths.some(file => same(file, row.path))).map(row => ({ path: row.path, sha256: row.sha256 }));
  let catalog = [];
  try { catalog = knownPayloadComponents(payloadDir); } catch { /* Exact installed receipts remain authoritative when the source is disconnected. */ }
  const plan = planAddonCompatibility(snapshot, { knownComponents: [...catalog, ...knownComponents, ...owned], keep: addonKeep, selectedComponents });
  if (!same(snapshot.profile.baseDir, exeDir) || !same(snapshot.profile.addonDir, exeDir))
    plan.blockers.push({ code: 'NATIVE_ADDON_LAYOUT', message: '当前插件位于自定义目录。请选择外置部署，以保留并迁移实际加载集合。' });
  for (const row of plan.decisions) if (row.explicitKeep && selectedPaths.some(file => same(file, row.path)))
    plan.blockers.push({ code: 'ADDON_KEEP_TARGET', message: `${row.name} 占用本次 Core／桥接器目标，无法同时保留和替换。`, path: row.path });
  // Older owned carrier names are retired by their original installer owner.
  // The original file restored by that retirement is then quarantined too,
  // with its exact backup identity visible in the same preview.
  const anticipated = [];
  for (const row of preserveOwned ? [] : manifest?.files || []) {
    if (row.kind !== 'carrier' || selectedPaths.some(file => same(file, path.resolve(game.dir, row.rel)))) continue;
    const file = path.resolve(game.dir, row.rel), decision = plan.decisions.find(item => same(item.path, file));
    if (decision) { decision.action = 'owner-retirement'; decision.mandatory = true; }
    if (row.original?.existed) {
      const backup = path.resolve(game.dir, row.original.backupRel || '');
      await noLinks(backup);
      if (!inside(game.dir, backup) || await digestFile(backup) !== row.original.sha256)
        plan.blockers.push({ code: 'ADDON_BASELINE_CHANGED', message: '旧桥接器原始备份无法验证。', path: file });
      anticipated.push({ ...(decision || {}), path: file, name: path.basename(file), sha256: row.original.sha256,
        action: 'retire-core', phase: 'after-owner-retirement', mandatory: true, owned: false, moduleMayLoad: true,
        sourceFingerprint: snapshot.fingerprint, configFingerprint: snapshot.configFingerprint,
        reason: '旧桥退役时保留安装前原件，继续隔离，避免重新加入加载链。' });
    }
  }
  plan.decisions.push(...anticipated);
  const removed = plan.decisions.filter(row => ['isolate', 'retire-core', 'owner-retirement'].includes(row.action)).map(row => row.path);
  const afterText = ensureDefaultReShadeHotkey(removeExplicitReferences(snapshot.profile.config, snapshot.profile.addonDir, removed));
  const configEdit = afterText !== snapshot.profile.config ? { path: snapshot.profile.activeConfigPath,
    beforeSha256: await digestFile(snapshot.profile.activeConfigPath), afterSha256: hash(afterText), afterText } : null;
  const changes = plan.decisions.filter(row => row.moduleMayLoad).map(row => ({ path: row.path, name: row.name,
    role: 'addon-compatibility', action: row.action, mandatory: row.mandatory, beforeSha256: row.sha256,
    afterSha256: ['isolate', 'retire-core', 'owner-retirement'].includes(row.action) ? null : row.sha256,
    description: row.reason, phase: row.phase || 'compatibility' }));
  if (configEdit) changes.push({ path: configEdit.path, name: 'ReShade.ini', role: 'addon-load-config', action: 'update-addon-references',
    beforeSha256: configEdit.beforeSha256, afterSha256: configEdit.afterSha256, description: '移除本次隔离插件的显式加载项；未设置面板快捷键时默认为 Home，保留已有键位。' });
  return { snapshot, plan, configEdit, changes, manifestHash: await digestFile(manifestPath(game.dir)) };
}
async function assertNativeAddonPolicy(gameDir, policy) {
  if (policy.plan.blockers.length) throw Object.assign(new Error(policy.plan.blockers.map(row => row.message).join('；')), { code: 'ADDON_POLICY_BLOCKED' });
  if (await digestFile(manifestPath(gameDir)) !== policy.manifestHash) throw Object.assign(new Error('安装记录在插件预览后改变。'), { code: 'ADDON_PLAN_CHANGED' });
  await assertAddonSnapshot(policy.snapshot);
}
module.exports = { compileNativeAddonPolicy, assertNativeAddonPolicy, removeExplicitReferences };
