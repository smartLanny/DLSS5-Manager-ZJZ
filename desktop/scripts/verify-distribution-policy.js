'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sourceCopies, hashFile } = require('./verify-manager-release');
const { verificationConfig } = require('./build-verification-config.cjs');
const BLOCKED = new Set([
  '74aeb464d829db80e3f4aa8fae235e6e3b38fc01188776c5c2376bb0dea0956e',
  'ad9af729a4db354347375faae9a8f46a79f7508e005cf81030ad5cfb7b3654a6'
]);
async function verifyDistributionPolicy(root = path.resolve(__dirname, '..'), options = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const resolved = verificationConfig(root, pkg, options);
  const copyOptions = { allowAbsoluteSources: resolved.explicit };
  const files = [...sourceCopies(root, resolved.config.extraResources || [], 'resources', copyOptions),
    ...sourceCopies(root, resolved.config.extraFiles || [], '', copyOptions)], blocked = [];
  for (const row of files) {
    if (/dgvoodoo/i.test(row.source) && /\.(?:zip|exe|dll)$/i.test(row.source)) blocked.push({ ...row, reason: 'Third-party general-purpose bundling is not authorized; security review is unresolved.' });
    if (/\.(?:zip|exe|dll|addon(?:32|64)?)$/i.test(row.source) && BLOCKED.has((await hashFile(path.resolve(root, row.source))).sha256))
      blocked.push({ ...row, reason: 'Blocked upstream asset digest.' });
  }
  return { ok: blocked.length === 0, checkedFiles: files.length, blocked, antivirusScanRequired: true };
}
function parseArguments(args) {
  const options = {}; let root = path.resolve(__dirname, '..');
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Expected --source <directory> or --build-config <trusted JSON>.');
    if (args[i] === '--source') root = path.resolve(args[i + 1]);
    else if (args[i] === '--build-config') options.buildConfigFile = path.resolve(args[i + 1]);
    else throw new Error('Expected --source <directory> or --build-config <trusted JSON>.');
  }
  return { root, options };
}
if (require.main === module) Promise.resolve().then(() => { const args = parseArguments(process.argv.slice(2)); return verifyDistributionPolicy(args.root, args.options); }).then(result => { console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1; })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { verifyDistributionPolicy, BLOCKED, parseArguments };
