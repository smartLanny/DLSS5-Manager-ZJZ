'use strict';

// Local-only RenoDX Add-on package. It deliberately contains no ReShade
// installer, proxy DLL or NVIDIA runtime. Users extract it and import the
// .addon64 file so the Manager can fingerprint it as a user Add-on.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const pe = require('../src/core/pe');

function fail(message) { throw new Error(message); }
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--addon', '--out', '--work-root'].includes(argv[index]) || !argv[index + 1]) {
      fail('用法：node scripts/build-renodx-addon-package.cjs --addon <addon64> --work-root <临时目录> --out <zip>');
    }
    options[argv[index].slice(2).replace('-', '')] = path.resolve(argv[index + 1]);
  }
  if (!options.addon || !options.out || !options.workroot) fail('缺少 --addon、--work-root 或 --out。');
  return options;
}
function plainAddon(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { fail(`RenoDX Add-on 不存在：${file}`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !/\.addon64$/i.test(file)) fail('RenoDX 输入必须是普通 .addon64 文件。');
  if (pe.getBitness(file) !== 64) fail('RenoDX Add-on 必须是 x64 PE。');
  return stat;
}
function buildRenoDxAddonPackage(options) {
  const addon = path.resolve(options.addon), output = path.resolve(options.out), workRoot = path.resolve(options.workroot);
  const stat = plainAddon(addon);
  if (!/\.zip$/i.test(output) || output === path.parse(output).root || workRoot === path.parse(workRoot).root) fail('输出必须是安全的 ZIP 路径。');
  if (fs.existsSync(output)) fail(`输出已存在，拒绝覆盖：${output}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(workRoot, { recursive: true });
  const temp = fs.mkdtempSync(path.join(workRoot, 'renodx-addon-'));
  try {
    const filename = path.basename(addon), hash = sha256(addon);
    fs.copyFileSync(addon, path.join(temp, filename), fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(path.join(temp, '导入说明.txt'), [
      'RenoDX NR Add-on（用户提供）',
      '',
      '1. 解压本 ZIP。',
      `2. 在 DLSS5 Manager 的“组件管理 → 导入组件”中选择 ${filename}。`,
      '3. Manager 会把它识别为用户 Add-on；同一游戏只启用一个 RenoDX Add-on，切换时旧版本留在组件库。',
      '4. 本包不含 ReShade、RTX40/50 NR DLL，也不代表该 Add-on 已通过所有游戏兼容验证。',
      '',
      `SHA-256: ${hash}`,
      ''
    ].join('\r\n'), 'utf8');
    fs.writeFileSync(path.join(temp, 'addon-package.json'), `${JSON.stringify({
      schema: 'dlss5-user-addon-package-v1', name: filename.replace(/\.addon64$/i, ''),
      architecture: 'x64', importMode: 'extract-and-select-addon64',
      file: { name: filename, bytes: stat.size, sha256: hash }
    }, null, 2)}\n`, 'utf8');
    let path7za;
    try { path7za = require('7zip-bin').path7za; } catch (error) { fail(`缺少 7zip-bin：${error.message}`); }
    const run = spawnSync(path7za, ['a', '-tzip', output, '.', '-mx=1'], { cwd: temp, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (run.error || run.status !== 0) fail(`RenoDX Add-on ZIP 生成失败：${run.stderr || run.error?.message || run.status}`);
    return { file: output, bytes: fs.statSync(output).size, sha256: sha256(output), addon: { name: filename, bytes: stat.size, sha256: hash } };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try { console.log(JSON.stringify(buildRenoDxAddonPackage(parseArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(JSON.stringify({ ok: false, error: error.message }, null, 2)); process.exitCode = 1; }
}
module.exports = { parseArgs, plainAddon, buildRenoDxAddonPackage };
