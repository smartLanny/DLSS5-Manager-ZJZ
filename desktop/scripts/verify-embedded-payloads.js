'use strict';

// Opens release EXEs as archive data. Only the trusted 7za tool is executed;
// neither an installer nor an extracted application is ever started.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { hashFile, walk } = require('./verify-manager-release');
const { verifyExecutable } = require('./verify-execution-level');
const execute = promisify(execFile);
const slash = value => value.replace(/\\/g, '/');

function validateOutputPath(unpacked, output, inputs = []) {
  if (!output) return;
  const destination = path.resolve(output), relative = path.relative(path.resolve(unpacked), destination);
  if (relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ||
      inputs.some(file => file && path.resolve(file).toLowerCase() === destination.toLowerCase())) throw new Error('Write the report outside win-unpacked without overwriting any release or tool input.');
}

function safeArchivePath(value) {
  const relative = slash(String(value || ''));
  if (!relative || path.isAbsolute(relative) || relative.includes(':') || /[\0\r\n<>"|?*]/.test(relative) ||
      relative.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
    throw new Error(`Unsafe embedded archive path: ${relative}`);
  return relative;
}
function properties(text) {
  return Object.fromEntries(text.split(/\r?\n/).flatMap(line => {
    const at = line.indexOf(' = '); return at < 0 ? [] : [[line.slice(0, at), line.slice(at + 3)]];
  }));
}
function parseArchiveListing(text, executableBytes) {
  const marker = text.match(/\r?\n----------\r?\n/);
  if (!marker) throw new Error('7za did not return an embedded archive listing.');
  const header = properties(text.slice(0, marker.index));
  const offset = Number(header.Offset || 0), bytes = Number(header['Physical Size']), tail = Number(header['Tail Size'] || 0);
  if (header.Type !== '7z' || !Number.isSafeInteger(offset) || offset <= 0 || !Number.isSafeInteger(bytes) || bytes <= 32 ||
      !Number.isSafeInteger(tail) || tail < 0 || offset + bytes + tail !== executableBytes) throw new Error('Embedded 7z boundaries do not match the release EXE.');
  const entries = text.slice(marker.index + marker[0].length).trim().split(/\r?\n\r?\n/).filter(block => block.trim() && !/^Warnings:\s*\d+$/.test(block.trim())).map(block => {
    const row = properties(block), file = safeArchivePath(row.Path), size = Number(row.Size);
    if (!Number.isSafeInteger(size) || size < 0 || row.Encrypted !== '-' || row['Symbolic Link'] || row['Hard Link'] || /L/.test(row.Attributes || ''))
      throw new Error(`Unsupported embedded entry: ${file}`);
    return { file, bytes: size, directory: /^D/.test(row.Attributes || '') };
  });
  if (!entries.length || entries.length > 100000) throw new Error('Embedded archive entry count is outside the verification limit.');
  const names = new Set();
  for (const row of entries) {
    const key = row.file.toLowerCase();
    if (names.has(key)) throw new Error(`Duplicate embedded Windows path: ${row.file}`);
    names.add(key);
  }
  return { offset, bytes, tailBytes: tail, entries };
}
function compareInventory(entries, reference) {
  const files = entries.filter(row => !row.directory), byName = new Map(files.map(row => [row.file, row]));
  const expected = new Map(reference.map(row => [row.file, row]));
  const missing = reference.filter(row => !byName.has(row.file)).map(row => row.file);
  const extra = files.filter(row => !expected.has(row.file)).map(row => row.file);
  const sizes = files.filter(row => expected.has(row.file) && row.bytes !== expected.get(row.file).bytes).map(row => row.file);
  if (missing.length || extra.length || sizes.length) throw Object.assign(new Error('Embedded payload inventory differs from win-unpacked.'), { details: { missing, extra, sizes } });
}
async function rangeHash(file, offset, bytes) {
  let read = 0; const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { start: offset, end: offset + bytes - 1 })) { read += chunk.length; hash.update(chunk); }
  if (read !== bytes) throw new Error('Embedded payload range could not be read completely.');
  return hash.digest('hex');
}
async function tool(archiver, args) {
  const result = await execute(archiver, args, { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr };
}
async function verifyEmbeddedPayloads({ unpacked, setup, portable, archiver, logsDirectory } = {}) {
  if (!unpacked || !setup || !portable || !logsDirectory) throw new Error('Provide --unpacked, --setup, --portable and --logs.');
  unpacked = path.resolve(unpacked); setup = path.resolve(setup); portable = path.resolve(portable);
  archiver = fs.realpathSync(archiver || require('7zip-bin').path7za); logsDirectory = path.resolve(logsDirectory);
  if (path.basename(archiver).toLowerCase() !== '7za.exe') throw new Error('Select the known 7za.exe archive tool, never a release executable.');
  const logRelative = path.relative(unpacked, logsDirectory);
  if (logRelative === '' || logRelative !== '..' && !logRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(logRelative)) throw new Error('Keep verification output outside win-unpacked.');
  const reference = [];
  for (const file of walk(unpacked, { rejectLinks: true })) reference.push({ file, ...await hashFile(path.join(unpacked, file)) });
  if (!reference.some(row => row.file === 'resources/app.asar')) throw new Error('Reference win-unpacked has no app.asar.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-embedded-verification-'));
  const distributions = [], payloads = new Map(); let complete = false;
  fs.mkdirSync(logsDirectory, { recursive: true });
  try {
    for (const [name, executable] of [['setup', setup], ['portable', portable]]) {
      const before = await hashFile(executable), executionLevel = verifyExecutable(executable, 'asInvoker');
      if (!executionLevel.ok) throw new Error(`${name} must retain its asInvoker manifest.`);
      const listingResult = await tool(archiver, ['l', '-slt', '-sccUTF-8', executable]);
      fs.writeFileSync(path.join(logsDirectory, `${name}-listing.txt`), listingResult.stdout + listingResult.stderr);
      const listing = parseArchiveListing(listingResult.stdout, before.bytes);
      compareInventory(listing.entries, reference);
      const payloadSha256 = await rangeHash(executable, listing.offset, listing.bytes);
      let payload = payloads.get(payloadSha256);
      if (!payload) {
        const destination = path.join(root, name); fs.mkdirSync(destination);
        const extraction = await tool(archiver, ['x', '-y', '-sccUTF-8', `-o${destination}`, executable]);
        fs.writeFileSync(path.join(logsDirectory, `${name}-extraction.txt`), extraction.stdout + extraction.stderr);
        const extractedNames = walk(destination, { rejectLinks: true });
        if (extractedNames.length !== reference.length || extractedNames.some(file => !reference.some(row => row.file === file))) throw new Error('Extracted paths differ from the previously checked archive inventory.');
        const files = [];
        for (const expected of reference) {
          const actual = await hashFile(path.join(destination, expected.file));
          files.push({ file: expected.file, ...actual, expectedSha256: expected.sha256,
            ok: actual.sha256 === expected.sha256 && actual.bytes === expected.bytes });
        }
        payload = { sha256: payloadSha256, bytes: listing.bytes, extractedFrom: name, verifiedFiles: files.length,
          ok: files.every(row => row.ok), failed: files.filter(row => !row.ok), files };
        payloads.set(payloadSha256, payload);
      }
      const after = await hashFile(executable);
      if (after.sha256 !== before.sha256) throw new Error(`${name} changed during verification.`);
      distributions.push({ name, file: path.basename(executable), ...before, executionLevel,
        embedded: { offset: listing.offset, bytes: listing.bytes, tailBytes: listing.tailBytes, sha256: payloadSha256 },
        payloadMatchesUnpacked: payload.ok, hashProof: payload.extractedFrom === name ? 'Extracted and hashed every payload file.' : `Identical embedded archive bytes to ${payload.extractedFrom}; reuse its complete per-file hash proof.` });
    }
    for (const expected of reference) {
      const after = await hashFile(path.join(unpacked, expected.file));
      if (after.sha256 !== expected.sha256) throw new Error('Reference win-unpacked changed during embedded verification.');
    }
    complete = distributions.every(row => row.payloadMatchesUnpacked);
    return { ok: complete, staticOnly: true, installerExecuted: false, applicationExecuted: false,
      scope: 'Open Setup and portable as archive data; compare their embedded 7z bytes and all extracted files against the frozen win-unpacked directory.',
      archiver: { file: path.basename(archiver), ...await hashFile(archiver) }, unpacked,
      sameEmbeddedArchive: distributions[0].embedded.sha256 === distributions[1].embedded.sha256,
      referenceFiles: reference.length, distributions, payloads: [...payloads.values()] };
  } catch (error) { error.artifactRoot = root; throw error; }
  finally {
    if (complete && path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && !fs.lstatSync(root).isSymbolicLink()) fs.rmSync(root, { recursive: true, force: true });
  }
}
if (require.main === module) {
  const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  Promise.resolve().then(() => {
    validateOutputPath(option('--unpacked') || '.', option('--output'), [option('--setup'), option('--portable'), option('--7za') || require('7zip-bin').path7za]);
    return verifyEmbeddedPayloads({ unpacked: option('--unpacked'), setup: option('--setup'), portable: option('--portable'), archiver: option('--7za'), logsDirectory: option('--logs') });
  }).then(result => {
    const output = option('--output'); if (output) fs.writeFileSync(path.resolve(output), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ ok: result.ok, staticOnly: result.staticOnly, installerExecuted: result.installerExecuted,
      sameEmbeddedArchive: result.sameEmbeddedArchive, referenceFiles: result.referenceFiles,
      distributions: result.distributions.map(row => ({ name: row.name, sha256: row.sha256, embedded: row.embedded, payloadMatchesUnpacked: row.payloadMatchesUnpacked })) }, null, 2));
    if (!result.ok) process.exitCode = 1;
  }).catch(error => { console.error(JSON.stringify({ ok: false, installerExecuted: false, error: error.message, details: error.details, artifactRoot: error.artifactRoot }, null, 2)); process.exitCode = 1; });
}
module.exports = { safeArchivePath, parseArchiveListing, compareInventory, validateOutputPath, verifyEmbeddedPayloads };
