'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getBitness } = require('../src/core/pe');
const OLD_BRIDGE = '73d438ee9427e73d9919d169a107c7f5d73f60b291ea2cd66bd33279a35d3e95';
const CURRENT_BRIDGE = '4656d9aac382a6f9b5c8488669aa5365283f03b5b94b2267f1c7f9b53927dc86';
const ID = '0.4.7beta-bg3-bridge1411';
const CARRIER = 'dlss5-native-carrier-045-dx11-compat.addon64';
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function prepare(source, payload = path.resolve(__dirname, '../payload/nr-before-sr')) {
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 513024 || digest(source) !== OLD_BRIDGE || getBitness(source) !== 64)
    throw new Error('BG3 comparison bridge must match the issue #224 fixed evidence identity.');
  const file = path.join(payload, 'bundle.json'), bundle = JSON.parse(fs.readFileSync(file, 'utf8')), base = bundle.versions['0.4.7beta'];
  if (bundle.version !== 4 || base?.files?.[CARRIER] !== CURRENT_BRIDGE) throw new Error('Comparison requires the pinned beta0.4.7 baseline.');
  const directory = path.join(payload, 'versions', ID); fs.mkdirSync(directory, { recursive: true });
  for (const [name, expected] of Object.entries(base.files)) {
    const sourceFile = name === CARRIER ? source : path.join(payload, 'versions/0.4.7beta', name);
    const wanted = name === CARRIER ? OLD_BRIDGE : expected;
    if (digest(sourceFile) !== wanted) throw new Error('Baseline changed: ' + name);
    const output = path.join(directory, name); fs.copyFileSync(sourceFile, output);
    if (digest(output) !== wanted) throw new Error('Comparison copy changed: ' + name);
  }
  bundle.versions[ID] = { ...base, label: 'beta0.4.7 · BG3 桥接 1.4.11 对照', comparisonOnly: true,
    notes: '固定 beta0.4.7 Core / nrchain / ReShade，仅把 DX11 Bridge 从 1.4.12 换为 #224 的 1.4.11。群友报告 BG3 DX11 可进入游戏；本管理器尚无实机 NR 持续成功验收。Core 可能提示桥版本不匹配。DX12 不安装此桥。',
    source: 'issue-224 fixed binary evidence; core ' + base.source,
    files: { ...base.files, [CARRIER]: OLD_BRIDGE },
    compatibilityEvidence: { game: 'Baldur’s Gate 3', steamAppId: '1086940', executable: 'bg3_dx11.exe', api: 'dx11',
      status: 'community-reported', issue: 'https://github.com/smartLanny/dlss5-nr-before-sr-lab/issues/224',
      bridgeVersion: '1.4.11.0', coreUnchanged: true, actualNrVerified: false, visualVerified: false } };
  fs.writeFileSync(file, JSON.stringify(bundle, null, 2) + '\n');
  return { id: ID, directory, defaultVersion: bundle.defaultVersion, bridgeSha256: OLD_BRIDGE, runtimeVerified: false };
}
if (require.main === module) console.log(JSON.stringify(prepare(path.resolve(process.argv[2])), null, 2));
module.exports = { prepare, ID, OLD_BRIDGE, CURRENT_BRIDGE };
