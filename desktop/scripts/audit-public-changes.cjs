'use strict';

// Read-only audit of files added or changed relative to the selected public
// base. Existing historical tracked assets are outside this change audit.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PRIVATE_PATH = /(?:^|\/)(?:bug-inbox|feedback-archives?|raw-logs?|captures?|dumps?|deliveries?|private|secrets?|test-saves?)(?:\/|$)/i;
const PRIVATE_SUFFIX = /\.(?:log|dmp|mdmp|zip|7z|rar|pfx|p12|pem|key|cer|crt|dll|exe|asi|addon32|addon64)$/i;
const TEXT_SUFFIX = /\.(?:c|cc|cpp|cxx|h|hpp|js|cjs|mjs|ts|tsx|json|md|txt|css|html|xml|yml|yaml|ps1|cmd|py|toml|ini)$/i;
const CONTENT_PATTERNS = Object.freeze([
  ['本机用户路径', /[A-Z]:[\\/](?:Users[\\/][^\\/\s]+|ChatGPT|Downloads|CodexTemp)[\\/]/i],
  ['私钥内容', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['疑似 GitHub Token', /\bgh[ps]_[A-Za-z0-9]{30,}\b/],
  ['疑似云密钥', /\bAKIA[0-9A-Z]{16}\b/]
]);
function normalize(value) { return String(value).replaceAll('\\', '/').replace(/^\.\//, ''); }
function inspectCandidate(relative, bytes) {
  const file = normalize(relative), issues = [];
  if (PRIVATE_PATH.test(file)) issues.push('路径属于私有证据/交付目录');
  if (PRIVATE_SUFFIX.test(file)) issues.push('新增或修改的二进制、归档、日志或密钥文件不能直接公开');
  if (TEXT_SUFFIX.test(file) && bytes.length <= 4 * 1024 * 1024) {
    const text = bytes.toString('utf8');
    const fixtureSlash = ['C:', 'Users', 'Alice'].join('/') + '/';
    const fixtureBackslash = ['C:', 'Users', 'Alice'].join('\\') + '\\';
    const inspectedText = file.startsWith('desktop/test/')
      ? text.replaceAll(fixtureSlash, '<fixture>/').replaceAll(fixtureBackslash, '<fixture>\\') : text;
    for (const [label, pattern] of CONTENT_PATTERNS) if (pattern.test(inspectedText)) issues.push(label);
    if ((file.startsWith('docs/') || file.startsWith('desktop/docs/')) && /\b[A-Z]:\\/.test(text
      .replaceAll('C:\\path\\', '<path>\\')
      .replaceAll('D:\\DLSS5-Build', '<build-root>')
      .replaceAll('D:\\Packages\\', '<packages>\\'))) issues.push('文档含具体盘符路径，请改成占位符');
  }
  return [...new Set(issues)];
}
function git(root, args, allowFailure = false) {
  const run = spawnSync('git', args, { cwd: root, encoding: null, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (!allowFailure && (run.error || run.status !== 0)) throw new Error(`git ${args.join(' ')} 失败：${run.stderr?.toString('utf8') || run.error?.message || run.status}`);
  return run;
}
function nulList(buffer) { return buffer.toString('utf8').split('\0').filter(Boolean).map(normalize); }
function audit(root, base = 'origin/main') {
  const repo = path.resolve(root), changed = nulList(git(repo, ['diff', '--name-only', '--diff-filter=ACMR', '-z', base, '--']).stdout);
  const untracked = nulList(git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).stdout);
  const files = [...new Set([...changed, ...untracked])].sort(), findings = [];
  for (const relative of files) {
    const file = path.join(repo, ...relative.split('/')); let stat;
    try { stat = fs.lstatSync(file); } catch { continue; }
    if (!stat.isFile() || stat.isSymbolicLink()) { findings.push({ file: relative, issues: ['必须是普通文件且不能是链接'] }); continue; }
    const issues = inspectCandidate(relative, fs.readFileSync(file));
    if (issues.length) findings.push({ file: relative, issues });
  }
  const whitespace = git(repo, ['diff', '--check', base, '--'], true);
  if (whitespace.status !== 0) findings.push({ file: '(git diff --check)', issues: [whitespace.stdout.toString('utf8') || whitespace.stderr.toString('utf8')] });
  return { ok: findings.length === 0, base, filesChecked: files.length, findings };
}
if (require.main === module) {
  try {
    const baseIndex = process.argv.indexOf('--base'), base = baseIndex >= 0 ? process.argv[baseIndex + 1] : 'origin/main';
    if (baseIndex >= 0 && !base) throw new Error('缺少 --base 值。');
    const root = path.resolve(__dirname, '..', '..'), result = audit(root, base);
    console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message }, null, 2)); process.exitCode = 1; }
}
module.exports = { PRIVATE_PATH, PRIVATE_SUFFIX, CONTENT_PATTERNS, inspectCandidate, audit };
