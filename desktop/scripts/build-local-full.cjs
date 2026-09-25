'use strict';

// Local-only convenience archive. It nests exactly four independently usable
// packages; the Microsoft VC++ runtime deliberately remains outside Full.zip.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROLES = Object.freeze([
  ['portable', '01-DLSS5-Manager-Portable.zip'],
  ['renodx', '02-RenoDX-Addon.zip'],
  ['rtx40', '03-RTX40-DLC.zip'],
  ['rtx50', '04-RTX50-DLC.zip']
]);
function fail(message, details = {}) { const error = new Error(message); error.details = details; throw error; }
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function inputFile(file, label) {
  const resolved = path.resolve(file); let stat;
  try { stat = fs.lstatSync(resolved); } catch { fail(`${label} 不存在。`, { file: resolved }); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !/\.zip$/i.test(resolved)) fail(`${label} 必须是普通 ZIP 文件。`, { file: resolved });
  if (/(?:vc[+_-]*redist|visual[ _-]*c[+]{2}|vcredist)/i.test(path.basename(resolved))) fail('Windows 运行库必须放在 Full.zip 外面。', { file: resolved });
  return { source: resolved, bytes: stat.size, sha256: sha256(resolved) };
}
function planFullBundle(options) {
  const result = { output: path.resolve(options.output || 'DLSS5-Manager-Full.zip'), entries: [] }, sources = new Set();
  if (!/\.zip$/i.test(result.output)) fail('Full 输出必须是 .zip。');
  for (const [role, name] of ROLES) {
    if (!options[role]) fail(`缺少 --${role}。`);
    const row = inputFile(options[role], role);
    const key = row.source.toLowerCase(); if (sources.has(key)) fail('四个独立包不能指向同一文件。', { file: row.source });
    sources.add(key); result.entries.push({ role, name, ...row });
  }
  if (sources.has(result.output.toLowerCase())) fail('Full 输出不能覆盖任一输入包。');
  return result;
}
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!/^--(?:portable|renodx|rtx40|rtx50|out)$/.test(argv[i] || '') || !argv[i + 1]) fail('用法：node scripts/build-local-full.cjs --portable <zip> --renodx <zip> --rtx40 <zip> --rtx50 <zip> --out <Full.zip>');
    out[argv[i].slice(2)] = argv[i + 1];
  }
  if (!out.out) fail('缺少 --out。');
  return { ...out, output: out.out };
}
function buildFullBundle(options) {
  const plan = planFullBundle(options);
  if (fs.existsSync(plan.output)) fail('Full 输出已存在，拒绝覆盖。', { output: plan.output });
  fs.mkdirSync(path.dirname(plan.output), { recursive: true });
  const temp = fs.mkdtempSync(path.join(path.dirname(plan.output), '.dlss5-full-'));
  try {
    for (const row of plan.entries) fs.copyFileSync(row.source, path.join(temp, row.name), fs.constants.COPYFILE_EXCL);
    let path7za; try { path7za = require('7zip-bin').path7za; } catch (error) { fail(`缺少 7zip-bin：${error.message}`); }
    const run = spawnSync(path7za, ['a', '-tzip', plan.output, '.', '-mx=0'], { cwd: temp, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (run.error || run.status !== 0) fail(`Full.zip 生成失败：${run.stderr || run.error?.message || run.status}`);
    const archive = { file: plan.output, bytes: fs.statSync(plan.output).size, sha256: sha256(plan.output), entries: plan.entries.map(({ role, name, bytes, sha256: hash }) => ({ role, name, bytes, sha256: hash })) };
    const report = `${plan.output}.json`;
    fs.writeFileSync(report, `${JSON.stringify({ schema: 'dlss5-local-full-v1', runtimeIncluded: false, ...archive }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return { ...archive, report };
  } catch (error) {
    if (fs.existsSync(plan.output)) fs.rmSync(plan.output, { force: true });
    throw error;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

if (require.main === module) {
  try { console.log(JSON.stringify(buildFullBundle(parseArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(JSON.stringify({ ok: false, error: error.message, details: error.details }, null, 2)); process.exitCode = 1; }
}
module.exports = { ROLES, inputFile, planFullBundle, buildFullBundle, parseArgs };
