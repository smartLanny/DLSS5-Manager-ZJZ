'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getBitness } = require('../src/core/pe');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const EXPECTED = {
  'nr-before-sr.zh-CN.addon64': 'b7bef0c7ad637ef35d2f0d327201636cb80f808a6af62cb6221f980343376dbf',
  'nrchain_nvngx.dll': '46041a5ff91ae2fd907e310d132aabc3c4a1ecd48dace511b8672909d5d9c2fb',
  'nr_before_sr.ini': '7ed62ef6f3f565a00e9cb6a92195e7c1bfaa3714f6f4fc28dfcbd1644a41ff80'
};
function prepare(handoffFile, payload = path.resolve(__dirname, '../payload/nr-before-sr')) {
  const handoff = JSON.parse(fs.readFileSync(handoffFile, 'utf8'));
  if (handoff.version !== '0.4.7beta' || handoff.source_commit !== '6a0ad7684683993328a7a98a9bea83ac76b01a64' || handoff.installation_contract?.native_d3d12_only !== true)
    throw Error('Unexpected 0.4.7beta source identity.');
  const rows = Object.values(handoff.files);
  const sources = {
    'nr-before-sr.zh-CN.addon64': rows.find(row => row.role === 'core' && row.language === 'zh-CN'),
    'nrchain_nvngx.dll': rows.find(row => row.role === 'companion'),
    'nr_before_sr.ini': rows.find(row => row.role === 'fresh-install-template-only')
  };
  const ready = Object.entries(sources).map(([name, row]) => {
    if (!row || !path.isAbsolute(row.absolute_path)) throw Error('Missing fixed source: ' + name);
    const stat = fs.lstatSync(row.absolute_path), bytes = fs.readFileSync(row.absolute_path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || hash(bytes) !== EXPECTED[name] || row.sha256 !== EXPECTED[name]) throw Error('Fixed source hash differs: ' + name);
    if (!name.endsWith('.ini') && getBitness(row.absolute_path) !== 64) throw Error('Expected x64: ' + name);
    return { name, bytes };
  });
  const directory = path.join(payload, 'versions/0.4.7beta'); fs.mkdirSync(directory, { recursive: true });
  for (const { name, bytes } of ready) {
    const target = path.join(directory, name);
    if (fs.existsSync(target) && !fs.readFileSync(target).equals(bytes)) throw Error('Existing slot differs: ' + name);
    if (!fs.existsSync(target)) fs.writeFileSync(target, bytes, { flag: 'wx' });
  }
  const file = path.join(payload, 'bundle.json'), bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (bundle.version !== 4) throw Error('Expected current v4 payload catalog.');
  bundle.versions['0.4.7beta'] = {
    label: '0.4.7beta', notes: '原生 DX12 核心，双路线菜单和更新默认值。升级保留个人配置；REFramework 按具体游戏准备。死亡搁浅1本轮仍在修复，未标记为兼容通过。',
    source: '0.4.7beta@' + handoff.source_commit, compatibility: null, ota: true, files: EXPECTED,
    trustedUpgradeFrom: ['49fea7d7922d4f91dcd6f2b69652147434cfda9c5c28523839c58ab117ef2a0a', 'd38400472424cc52883a154e0995a4ddd552ab3d90afa4aa5ccf19693c34e8af']
  };
  bundle.defaultVersion = '0.4.7beta';
  fs.writeFileSync(file, JSON.stringify(bundle, null, 2) + '\n');
  return { version: bundle.defaultVersion, directory, files: EXPECTED };
}
if (require.main === module) console.log(JSON.stringify(prepare(path.resolve(process.argv[2])), null, 2));
module.exports = { prepare, EXPECTED };
