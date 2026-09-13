'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classifyAddon, scanConflicts, moveConflicts } = require('../src/product/conflicts');

test('ordinary addon names and DLSS/NGX mentions do not prove a competing NR implementation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-coexist-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['sunrise.addon64', 'frame-monitor.addon64', 'renodx-hdr.addon64']) {
    const file = path.join(root, name); fs.writeFileSync(file, 'DLSS NVNGX nvngx_dlss.dll');
    assert.equal(classifyAddon(name, file), null);
  }
  const identified = path.join(root, 'neutral.addon64');
  fs.writeFileSync(identified, Buffer.concat([Buffer.alloc(65532), Buffer.from('NRBeforeSR')]));
  assert.equal(classifyAddon('neutral.addon64', identified).category, 'other-dlss-nr-ngx');
  assert.deepEqual(scanConflicts(root).map(row => row.name), ['neutral.addon64']);
});

test('content inspection has an 8 MiB read budget and ignores case-varied backup directories', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-coexist-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'neutral.addon64');
  fs.writeFileSync(file, ''); fs.truncateSync(file, 20 * 1024 * 1024);
  let bytesRead = 0; const read = fs.readSync;
  fs.readSync = (...args) => { const count = read(...args); bytesRead += count; return count; };
  try { assert.equal(classifyAddon('neutral.addon64', file), null); }
  finally { fs.readSync = read; }
  assert.equal(bytesRead, 8 * 1024 * 1024);
  fs.mkdirSync(path.join(root, '_dlss5_backup'));
  fs.writeFileSync(path.join(root, '_dlss5_backup', 'old-nr-before-sr.addon64'), 'old');
  assert.deepEqual(scanConflicts(root), []);
});

test('known native carrier names are conflicts while nrchain remains outside addon cleanup', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-conflicts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'dlss5-native-carrier-old.addon64'), 'carrier one');
  fs.writeFileSync(path.join(root, 'r3-nr-native-neutral.addon64'), 'carrier two');
  fs.writeFileSync(path.join(root, 'nrchain_nvngx.dll'), 'bridge');

  assert.equal(classifyAddon('r3-nr-native-neutral.addon64').category, 'native-carrier');
  assert.deepEqual(scanConflicts(root).map(row => row.name).sort(), [
    'dlss5-native-carrier-old.addon64',
    'r3-nr-native-neutral.addon64'
  ]);
});

test('standalone conflict move restores earlier renames when a later rename fails', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-conflicts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const names = ['dlss5-native-carrier-old.addon64', 'r3-nr-native-neutral.addon64'];
  for (const name of names) fs.writeFileSync(path.join(root, name), name);

  const realRename = fs.promises.rename.bind(fs.promises);
  let forwardMoves = 0;
  const rename = async (source, destination) => {
    if (!String(source).includes(`${path.sep}_DLSS5_Backup${path.sep}`)) {
      forwardMoves += 1;
      if (forwardMoves === 2) throw new Error('injected second rename failure');
    }
    return realRename(source, destination);
  };
  await assert.rejects(moveConflicts(root, 'test-install', { rename }), /injected second rename failure/);
  for (const name of names) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), name);
  const backupRoot = path.join(root, '_DLSS5_Backup');
  const remainingFiles = fs.existsSync(backupRoot)
    ? fs.readdirSync(backupRoot, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    : [];
  assert.equal(remainingFiles.length, 0);
});
