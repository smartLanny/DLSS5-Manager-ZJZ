'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const mainFile = path.resolve(__dirname, '../main.js');
const source = fs.readFileSync(mainFile, 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('writePackage: async (');
const end = source.indexOf('\n      }\n    });', start);
assert.ok(start > 0 && end > start, 'The actual main-process feedback save adapter is present');
const adapterSource = source.slice(start + 'writePackage: '.length, end) + '\n      }';

function host(t, select, fileSystem = fs) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-host-save-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const revealed = [];
  const save = vm.runInNewContext('(' + adapterSource + ')', {
    dialog: { showSaveDialog: select }, win: {}, app: { getPath: () => directory },
    path, fs: fileSystem, require: createRequire(mainFile), shell: { showItemInFolder: file => revealed.push(file) }, Error, Object
  });
  return { save, directory, revealed };
}

test('actual host save revalidates after the dialog and preserves the selected bytes', async t => {
  let file, selected = false, validations = 0;
  const h = host(t, async () => { selected = true; return { filePath: file }; });
  file = path.join(h.directory, 'feedback.zip'); const bytes = Buffer.from('fixture package bytes');
  const result = await h.save({ filename: 'feedback.zip', bytes, validateBeforeWrite: async () => { assert.equal(selected, true); validations++; } });
  assert.equal(result.saved, true); assert.equal(validations, 1);
  assert.deepEqual(fs.readFileSync(file), bytes); assert.deepEqual(h.revealed, [file]);
});

test('actual host save cannot write when identity changes while selecting the destination', async t => {
  let file, changed = false;
  const h = host(t, async () => { changed = true; return { filePath: file }; });
  file = path.join(h.directory, 'stale.zip');
  await assert.rejects(h.save({ filename: 'stale.zip', bytes: Buffer.from('stale'), validateBeforeWrite: async () => {
    if (changed) throw Object.assign(new Error('session changed'), { code: 'SESSION_CHANGED' });
  } }), { code: 'SESSION_CHANGED' });
  assert.equal(fs.existsSync(file), false); assert.equal(h.revealed.length, 0);
});

test('actual host cancellation performs no validation or write', async t => {
  const h = host(t, async () => ({ canceled: true }));
  const result = await h.save({ filename: 'cancelled.zip', bytes: Buffer.from('none'), validateBeforeWrite: async () => assert.fail('Cancelled save') });
  assert.equal(result.cancelled, true); assert.deepEqual(fs.readdirSync(h.directory), []);
});

test('actual host refuses an existing file with a useful message and never overwrites it', async t => {
  let file;
  const h = host(t, async () => ({ filePath: file }));
  file = path.join(h.directory, 'existing.zip'); fs.writeFileSync(file, 'original');
  await assert.rejects(h.save({ filename: 'existing.zip', bytes: Buffer.from('replacement'), validateBeforeWrite: async () => {} }), {
    code: 'COMPATIBILITY_FILE_EXISTS', message: '保存位置已有同名文件，请选择新的文件名。'
  });
  assert.equal(fs.readFileSync(file, 'utf8'), 'original'); assert.equal(h.revealed.length, 0);
});

for (const stage of ['writeFile', 'sync']) test(`actual host ${stage} failure removes only its partial file and permits retry`, async t => {
  let file, failOnce = true;
  const fileSystem = { promises: { ...fs.promises, open: async (...args) => {
    const handle = await fs.promises.open(...args);
    return { stat: () => handle.stat(), close: () => handle.close(),
      writeFile: async bytes => {
        if (stage === 'writeFile' && failOnce) { failOnce = false; await handle.writeFile(bytes.subarray(0, 3)); throw Object.assign(new Error('fixture partial write'), { code: 'EIO' }); }
        await handle.writeFile(bytes);
      },
      sync: async () => { if (stage === 'sync' && failOnce) { failOnce = false; throw Object.assign(new Error('fixture sync failure'), { code: 'EIO' }); } await handle.sync(); }
    };
  } } };
  const h = host(t, async () => ({ filePath: file }), fileSystem);
  file = path.join(h.directory, 'retry.zip'); const bytes = Buffer.from('complete feedback package');
  const request = { filename: 'retry.zip', bytes, validateBeforeWrite: async () => {} };
  await assert.rejects(h.save(request), { code: 'EIO' });
  assert.equal(fs.existsSync(file), false); assert.equal(h.revealed.length, 0);
  assert.equal((await h.save(request)).saved, true);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('actual host write failure preserves a different file that replaced its path', async t => {
  let file, displaced;
  const fileSystem = { promises: { ...fs.promises, open: async (...args) => {
    const handle = await fs.promises.open(...args);
    return { stat: () => handle.stat(), close: () => handle.close(), sync: () => handle.sync(), writeFile: async bytes => {
      await handle.writeFile(bytes.subarray(0, 3)); await handle.close();
      await fs.promises.rename(file, displaced); await fs.promises.writeFile(file, 'external replacement', { flag: 'wx' });
      throw Object.assign(new Error('fixture file replacement'), { code: 'EIO' });
    } };
  } } };
  const h = host(t, async () => ({ filePath: file }), fileSystem);
  file = path.join(h.directory, 'selected.zip'); displaced = path.join(h.directory, 'old-partial.zip');
  await assert.rejects(h.save({ filename: 'selected.zip', bytes: Buffer.from('package'), validateBeforeWrite: async () => {} }), { code: 'EIO' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'external replacement'); assert.equal(h.revealed.length, 0);
});
