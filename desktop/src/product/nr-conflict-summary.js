'use strict';
const path = require('node:path');
const crypto = require('node:crypto');

function nrConflictSummary(deployment, { userData, exe, game }) {
  const compatibility = deployment?.addonCompatibility || deployment?.compatibility;
  const files = (compatibility?.decisions || []).filter(row => row.moduleMayLoad && ['isolate', 'retire-core'].includes(row.action) &&
    deployment.changes?.some(change => change.path && path.resolve(change.path).toLowerCase() === path.resolve(row.path).toLowerCase() &&
      change.beforeSha256 === row.sha256 && change.afterSha256 === null))
    .map(row => ({ name: row.name || path.basename(row.path), path: row.path, sha256: row.sha256,
      action: 'backup-isolate', classification: row.classification, confirmedConflict: row.mandatory === true }));
  const transfers = deployment?.isolatedAddonTransfers || [];
  for (const row of transfers) files.push({ name: path.basename(row.originPath), path: row.originPath, restorePath: row.restorePath,
    sha256: row.sha256, action: 'transfer-backup', classification: 'isolated-addon', confirmedConflict: true });
  const directories = [];
  if (files.length) {
    if (deployment.mode === 'external' || deployment.loadingBackend === 'hoyoshade') {
      const id = crypto.createHash('sha256').update(path.resolve(exe).toLowerCase()).digest('hex');
      directories.push(path.join(userData, 'external-runtime', id, 'history'));
    } else directories.push(path.join(game, '_DLSS5_Backup', 'conflicts'));
  }
  return { required: files.length > 0, files, backupDirectories: [...new Set(directories)] };
}

module.exports = { nrConflictSummary };
