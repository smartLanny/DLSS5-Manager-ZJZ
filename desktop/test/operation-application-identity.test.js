'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const asar = require('@electron/asar');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('real Electron reads entry identity through ASAR and code identity from the physical archive', { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-asar-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), archive = path.join(root, 'app.asar');
  await fs.mkdir(path.join(source, 'src/product'), { recursive: true });
  const main = 'module.exports = "identity fixture";\n';
  await fs.writeFile(path.join(source, 'main.js'), main);
  for (const name of ['operation-elevation.js', 'launch-safety.js', 'streamed-file-digest.js'])
    await fs.copyFile(path.join(__dirname, '../src/product', name), path.join(source, 'src/product', name));
  await asar.createPackage(source, archive);
  const invoke = () => new Promise((resolve, reject) => execFile(require('electron'), ['-e',
    'const p=process.argv[1]; require(p+"/src/product/operation-elevation.js").applicationIdentity({execPath:process.execPath,appPath:p}).then(x=>process.stdout.write(JSON.stringify(x))).catch(e=>{process.stderr.write(e.stack);process.exitCode=1})', archive],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' }, windowsHide: true, timeout: 10000, encoding: 'utf8' },
  (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve(JSON.parse(stdout))));
  const first = await invoke();
  assert.equal(first.mainHash, sha(main));
  assert.equal(first.codeHash, sha(await fs.readFile(archive)));
  // Trailing physical bytes leave virtual main.js unchanged. Whole-package
  // identity must still change, so a worker cannot accept the old request.
  await fs.appendFile(archive, '\nchanged package bytes\n');
  const second = await invoke();
  assert.equal(second.mainHash, first.mainHash);
  assert.notEqual(second.codeHash, first.codeHash);
  assert.equal(second.codeHash, sha(await fs.readFile(archive)));

  // The virtual member must inherit the physical archive's link policy. A
  // member digest that trusted Electron's synthetic inode would accept this.
  await fs.link(archive, path.join(root, 'archive-alias.asar'));
  const digestEntry = () => new Promise((resolve, reject) => execFile(require('electron'), ['-e',
    'const p=process.argv[1]; require(p+"/src/product/launch-safety.js").digestFile(p+"/main.js").then(x=>process.stdout.write(x)).catch(e=>{process.stderr.write(e.code+":"+e.message);process.exitCode=1})', archive],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' }, windowsHide: true, timeout: 10000, encoding: 'utf8' },
  (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve(stdout)));
  await assert.rejects(digestEntry(), error => error.stderr.includes('SETTINGS_LINK_BLOCKED'));
});
