'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectCandidate } = require('../scripts/audit-public-changes.cjs');

test('public audit rejects private evidence, release binaries and concrete local paths', () => {
  assert.match(inspectCandidate('bug-inbox/report.txt', Buffer.from('safe')).join(' '), /私有证据/);
  assert.match(inspectCandidate('desktop/resources/new.dll', Buffer.from('MZ')).join(' '), /二进制/);
  assert.match(inspectCandidate('docs/note.md', Buffer.from('source D:\\ChatGPT\\DLSS5\\private')).join(' '), /本机用户路径/);
  assert.match(inspectCandidate('docs/note.md', Buffer.from('game E:\\Installed Games\\Game.exe')).join(' '), /具体盘符路径/);
});
test('public audit accepts ordinary source and placeholder paths', () => {
  assert.deepEqual(inspectCandidate('desktop/src/product/example.js', Buffer.from("const example = 'C:/path/to/file';\n")), []);
  assert.deepEqual(inspectCandidate('docs/build.md', Buffer.from('node build --work-root D:\\DLSS5-Build\n')), []);
});
