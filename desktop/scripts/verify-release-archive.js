'use strict';
// Compare every file in a generated ZIP with its verified unpacked directory.
// No archive entry is extracted or executed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yauzl = require('yauzl');
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function verify(archive, directory) {
  const expected = new Map();
  async function walk(root) {
    for (const item of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, item.name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) throw Error('Reference directory contains a link.');
      if (stat.isDirectory()) await walk(file);
      else if (stat.isFile()) expected.set(path.relative(directory, file).replaceAll('\\', '/'), { bytes: stat.size, sha256: await digest(file) });
      else throw Error('Unsupported reference entry.');
    }
  }
  await walk(directory);
  const before = fs.statSync(archive), archiveSha256 = await digest(archive), rows = [], seen = new Set();
  await new Promise((resolve, reject) => yauzl.open(archive, { lazyEntries: true, strictFileNames: true }, (error, zip) => {
    if (error) return reject(error);
    const fail = error => { zip.close(); reject(error); };
    zip.on('error', fail);
    zip.on('end', resolve);
    zip.on('entry', entry => {
      if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
      const key = entry.fileName.toLowerCase(), source = expected.get(entry.fileName);
      if (!source || seen.has(key) || source.bytes !== entry.uncompressedSize) return fail(Error(`Unexpected, duplicate or mismatched file: ${entry.fileName}`));
      seen.add(key);
      zip.openReadStream(entry, async (error, stream) => {
        if (error) return fail(error);
        try {
          const hash = crypto.createHash('sha256'); let bytes = 0;
          // yauzl's stored entries use an older fd-slicer stream whose async
          // iterator may never reach end on newer Node versions. Its event
          // interface supports both stored and deflated ZIP entries.
          await new Promise((resolve, reject) => {
            stream.on('data', chunk => { bytes += chunk.length; hash.update(chunk); });
            stream.once('end', resolve);
            stream.once('error', reject);
          });
          const actual = hash.digest('hex');
          if (actual !== source.sha256 || bytes !== source.bytes) throw Error(`Archive content changed: ${entry.fileName}`);
          rows.push({ file: entry.fileName, bytes, sha256: actual }); zip.readEntry();
        } catch (error) { fail(error); }
      });
    });
    zip.readEntry();
  }));
  const after = fs.statSync(archive);
  if (seen.size !== expected.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || await digest(archive) !== archiveSha256)
    throw Error('Archive is incomplete or changed during verification.');
  return { ok: true, archive, directory, archiveSha256, bytes: after.size, files: rows, verifiedFiles: rows.length, extracted: false, executed: false };
}
if (require.main === module) {
  const [archive, directory, output] = process.argv.slice(2);
  if (!archive || !directory) throw Error('Usage: verify-release-archive.js archive.zip verified-directory [output.json]');
  verify(path.resolve(archive), path.resolve(directory)).then(result => {
    if (output) fs.writeFileSync(path.resolve(output), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ ok: true, archiveSha256: result.archiveSha256, bytes: result.bytes, verifiedFiles: result.verifiedFiles }));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { verify };
