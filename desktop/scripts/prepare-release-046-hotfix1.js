'use strict';
const path = require('path');
const { prepare, verifyVersion: verifyFiles } = require('./prepare-release-046');
const SOURCE = '35ef9a826642e0eabcecd46d012167dd52b98105';
const FILES = {
  'nr-before-sr.zh-CN.addon64': ['DLSS5-AI渲染超分版-beta0.4.6-hotfix.1-@野生的装机宅-Bilibili.addon64', '0727be26ceddcf60354535cee7c12a3138eef3075d7f90110b3693508fb633a5'],
  'nrchain_nvngx.dll': ['nrchain_nvngx.dll', '46041a5ff91ae2fd907e310d132aabc3c4a1ecd48dace511b8672909d5d9c2fb'],
  'dlss5-native-carrier-045-dx11-compat.addon64': ['dlss5-native-carrier-045-dx11-compat.addon64', '4656d9aac382a6f9b5c8488669aa5365283f03b5b94b2267f1c7f9b53927dc86'],
  'nr_before_sr.ini': [null, '469f47219e170443a5887c4614f20452469df8e7ad954fb80f10d4fb4c1e6f01']
};
const ENTRY = {
  id: '0.4.6-hotfix.1', label: '0.4.6-hotfix.1（最新）', source: `beta0.4.6-hotfix.1@${SOURCE}`,
  compatibility: 'dx11', ota: true,
  notes: '恢复主面板 F8/F7 入口，合并反馈与诊断，移除多余反馈窗口；新装与恢复默认的最终效果倍率为 1.0，升级保留明确旧设置。DX12 不部署 carrier，DX11 仅使用配套桥接。不是人脸独立遮罩修复；游戏验收待确认。'
};
const verifyVersion = dir => verifyFiles(dir, FILES);
if (require.main === module) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/prepare-release-046-hotfix1.js <reviewed OTA directory> <reviewed INI>');
  prepare(path.resolve(process.argv[2]), path.resolve(process.argv[3]), { ENTRY, FILES, SOURCE, peVersion: '0.4.6.1' });
}
module.exports = { ENTRY, FILES, SOURCE, verifyVersion };
