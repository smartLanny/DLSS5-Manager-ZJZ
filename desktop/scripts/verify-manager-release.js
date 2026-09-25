'use strict';

// Read-only candidate inspection. Candidate JavaScript and executables are never
// loaded or run; expected paths and hashes come from the trusted build source.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const minimatchModule = require('minimatch');
const minimatch = minimatchModule.minimatch || minimatchModule;
const { verifyExecutable } = require('./verify-execution-level');
const { verificationConfig } = require('./build-verification-config.cjs');

const STARTUP_FILES = [
  'main.js', 'preload.js', 'src/product/startup-diagnostics.js', 'src/product/startup-elevation.js',
  'src/product/startup-handoff.js', 'src/renderer/index.html', 'src/renderer/startup-ui.js',
  'src/renderer/renderer.js', 'src/renderer/style.css', 'src/renderer/game-page-ui.js', 'src/renderer/game-page.css',
  'src/product/operation-elevation.js', 'src/product/operation-worker.js', 'src/product/operation-plan.js', 'src/product/operation-api.js',
  'src/product/game-assessment.js', 'src/product/launch-session.js', 'src/product/loading-helper.js'
];
const RUNTIME_FILES = [
  'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll', 'ffmpeg.dll', 'icudtl.dat',
  'libEGL.dll', 'libGLESv2.dll', 'LICENSES.chromium.html', 'resources.pak', 'snapshot_blob.bin',
  'v8_context_snapshot.bin', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll'
];
const slash = value => value.replace(/\\/g, '/');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function relativePath(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error(`Unsafe package-relative path: ${String(value)}`);
  return value;
}
function readJson(file) {
  if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error(`JSON file is too large: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function walk(root, { rejectLinks = false } = {}) {
  const rows = [], pending = [''];
  while (pending.length) {
    const relative = pending.pop();
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = slash(path.join(relative, entry.name));
      if (entry.isSymbolicLink()) {
        if (rejectLinks) throw new Error(`Candidate contains a filesystem link: ${name}`);
        throw new Error(`Source contains an unsupported nested link: ${name}`);
      }
      if (entry.isDirectory()) pending.push(name);
      else if (entry.isFile()) rows.push(name);
      else throw new Error(`Unsupported package entry: ${name}`);
      if (rows.length + pending.length > 100000) throw new Error('Package contains too many entries.');
    }
  }
  return rows.sort();
}
function matches(file, filters) {
  if (!filters?.length) return true;
  const include = filters.filter(value => !value.startsWith('!'));
  return (!include.length || include.some(pattern => minimatch(file, pattern, { dot: true }))) &&
    !filters.filter(value => value.startsWith('!')).some(pattern => minimatch(file, pattern.slice(1), { dot: true }));
}
function sourceCopies(sourceRoot, specs, destinationPrefix = '', { allowAbsoluteSources = false } = {}) {
  const rows = [];
  for (const spec of specs || []) {
    if (!spec || typeof spec.from !== 'string' || typeof spec.to !== 'string') throw new Error('Expected explicit from/to build copy specifications.');
    const from = allowAbsoluteSources && path.isAbsolute(spec.from) ? path.resolve(spec.from) : relativePath(slash(spec.from));
    const to = relativePath(slash(spec.to));
    const source = path.resolve(sourceRoot, from), stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error(`Build source must not be a filesystem link: ${from}`);
    if (stat.isFile()) rows.push({ source: from, file: slash(path.join(destinationPrefix, to)) });
    else if (stat.isDirectory()) {
      const names = walk(source).filter(file => matches(file, spec.filter));
      if (!names.length) throw new Error(`Build copy has no source files: ${from}`);
      for (const file of names) rows.push({ source: slash(path.join(from, file)), file: slash(path.join(destinationPrefix, to, file)) });
    } else throw new Error(`Unsupported build copy source: ${from}`);
  }
  return rows;
}
function archiveSourceFiles(sourceRoot, filters) {
  const names = new Set(STARTUP_FILES);
  for (const pattern of filters || []) {
    if (typeof pattern !== 'string') throw new Error('Expected string build.files patterns.');
    if (pattern.startsWith('!')) continue;
    const wildcard = pattern.search(/[*?{[]/);
    if (wildcard < 0) {
      relativePath(pattern);
      const selected = path.join(sourceRoot, pattern);
      if (fs.statSync(selected).isDirectory()) for (const file of walk(selected)) names.add(slash(path.join(pattern, file)));
      else names.add(pattern);
    } else {
      const prefix = pattern.slice(0, wildcard), directory = prefix.slice(0, prefix.lastIndexOf('/'));
      relativePath(directory);
      for (const file of walk(path.join(sourceRoot, directory))) {
        const relative = slash(path.join(directory, file));
        if (matches(relative, filters)) names.add(relative);
      }
    }
  }
  names.delete('package.json');
  return [...names].sort();
}
async function hashFile(file) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size === 0) throw new Error('Required file is missing, empty or is a link.');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  const after = fs.lstatSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('File changed during verification.');
  return { sha256: hash.digest('hex'), bytes: before.size };
}
function startupContract(read) {
  const main = read('main.js'), preload = read('preload.js'), html = read('src/renderer/index.html');
  return [
    { name: 'sandbox-default', ok: /sandbox\s*:\s*true/.test(main) && !/appendSwitch\s*\(\s*['"]no-sandbox['"]/.test(main) },
    { name: 'context-isolation', ok: /contextIsolation\s*:\s*true/.test(main) && /nodeIntegration\s*:\s*false/.test(main) },
    { name: 'startup-ipc', ok: ['startup-context', 'game-operation-apply-elevated', 'startup-renderer-ready'].every(name => main.includes(name) && preload.includes(name)) },
    { name: 'explicit-operation-elevation', ok: main.includes('game-operation-apply-elevated') && main.includes('operation-worker') && main.includes('createOperationElevation') },
    { name: 'startup-ui', ok: /<script\s+src=["']startup-ui\.js["']/.test(html) && /startupReady/.test(preload) }
  ];
}
async function verifyManagerRelease({ directory, sourceRoot = path.resolve(__dirname, '..'), electronDist, nsisDir, buildConfig, buildConfigFile } = {}) {
  if (!directory) throw new Error('Provide the full win-unpacked directory.');
  directory = path.resolve(directory); sourceRoot = path.resolve(sourceRoot);
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Candidate root must be a real directory.');
  const inventory = walk(directory, { rejectLinks: true });
  const sourcePackage = readJson(path.join(sourceRoot, 'package.json'));
  const resolved = verificationConfig(sourceRoot, sourcePackage, { buildConfig, buildConfigFile, directory });
  const config = resolved.config;
  if (!config.files?.length) throw new Error('Trusted release build configuration must include files.');
  if (sourcePackage.main !== 'main.js' || !sourcePackage.build?.productName) throw new Error('Unexpected trusted manager package identity.');
  electronDist = path.resolve(electronDist || path.dirname(require('electron')));
  const archive = path.join(directory, 'resources/app.asar');
  const archiveBefore = await hashFile(archive);
  asar.uncache(archive);
  const read = file => {
    const normalized = path.normalize(relativePath(file)), info = asar.statFile(archive, normalized, false);
    if (info.unpacked || info.link || info.files || info.size > 2 * 1024 * 1024) throw new Error(`Expected a bounded regular archived startup file: ${file}`);
    return asar.extractFile(archive, normalized).toString('utf8');
  };
  const candidatePackage = JSON.parse(read('package.json'));
  const contracts = startupContract(read);
  contracts.unshift({ name: 'package-identity', ok: candidatePackage.name === sourcePackage.name && candidatePackage.version === sourcePackage.version && candidatePackage.main === 'main.js' });
  const rows = [];
  async function compareFile(kind, file, source) {
    try {
      const [actual, expected] = await Promise.all([hashFile(path.join(directory, file)), hashFile(source)]);
      rows.push({ kind, file, ...actual, expectedSha256: expected.sha256, ok: actual.sha256 === expected.sha256 && actual.bytes === expected.bytes });
    } catch (error) { rows.push({ kind, file, ok: false, error: error.message }); }
  }
  for (const file of archiveSourceFiles(sourceRoot, config.files)) {
    try {
      const info = asar.statFile(archive, path.normalize(file), false);
      if (info.unpacked || info.link || info.files) throw new Error('Expected a regular archived source file.');
      const bytes = asar.extractFile(archive, path.normalize(file)), expected = await hashFile(path.join(sourceRoot, file));
      const sha256 = digest(bytes);
      rows.push({ kind: 'app-source', file, bytes: bytes.length, sha256, expectedSha256: expected.sha256, ok: sha256 === expected.sha256 && bytes.length === expected.bytes });
    } catch (error) { rows.push({ kind: 'app-source', file, ok: false, error: error.message }); }
  }
  const major = Number(fs.readFileSync(path.join(electronDist, 'version'), 'utf8').trim().split('.')[0]);
  // Electron 44's official Windows archive embeds ANGLE and ships the DXC
  // compiler pair. Compare the exact trusted runtime family, including DXC.
  const runtimeFiles = major === 44 ? [...RUNTIME_FILES.filter(file => !['libEGL.dll', 'libGLESv2.dll'].includes(file)), 'dxcompiler.dll', 'dxil.dll'] : RUNTIME_FILES;
  const runtime = [...runtimeFiles, ...walk(path.join(electronDist, 'locales')).map(file => `locales/${file}`)];
  for (const file of runtime) await compareFile('electron-runtime', file, path.join(electronDist, file));
  await compareFile('electron-runtime', 'LICENSE.electron.txt', path.join(electronDist, 'LICENSE'));
  for (const row of sourceCopies(sourceRoot, config.extraResources, 'resources', { allowAbsoluteSources: resolved.explicit }))
    await compareFile('extra-resource', row.file, path.resolve(sourceRoot, row.source));
  for (const row of sourceCopies(sourceRoot, config.extraFiles, '', { allowAbsoluteSources: resolved.explicit }))
    await compareFile('root-helper', row.file, path.resolve(sourceRoot, row.source));
  if (inventory.includes('resources/elevate.exe')) {
    if (!nsisDir) rows.push({ kind: 'builder-helper', file: 'resources/elevate.exe', ok: false, error: 'Provide --nsis-dir for the trusted NSIS build binary directory containing elevate.exe.' });
    else await compareFile('builder-helper', 'resources/elevate.exe', path.join(path.resolve(nsisDir), 'elevate.exe'));
  }
  const executable = path.join(directory, `${sourcePackage.build.productName}.exe`);
  let executionLevel, executableHash;
  try { executionLevel = verifyExecutable(executable, 'asInvoker'); executableHash = await hashFile(executable); }
  catch (error) { executionLevel = { ok: false, error: error.message }; }
  const archiveAfter = await hashFile(archive);
  contracts.push({ name: 'archive-unchanged-during-inspection', ok: archiveBefore.sha256 === archiveAfter.sha256 });
  const expectedFiles = new Set([...rows.filter(row => row.kind !== 'app-source').map(row => row.file), 'resources/app.asar', path.basename(executable)]);
  const unexpectedFiles = inventory.filter(file => !expectedFiles.has(file));
  contracts.push({ name: 'no-unaccounted-package-files', ok: unexpectedFiles.length === 0, unexpectedFiles });
  const privatePaths=[];
  for (const file of inventory.filter(name=>/\.(?:json|txt|md|ini|cfg|ps1|cmd)$/i.test(name))) {
    const absolute=path.join(directory,file), stat=fs.lstatSync(absolute);
    if (!stat.isFile() || stat.size > 2*1024*1024) continue;
    const content=fs.readFileSync(absolute,'utf8');
    if (/[A-Za-z]:\\(?:Users|CodexTemp|ChatGPT)\\/i.test(content) || /(?:^|["'\s])\/(?:home|Users)\/[^/\s"']+/m.test(content)) privatePaths.push(file);
  }
  contracts.push({name:'no-build-machine-private-paths',ok:privatePaths.length===0,files:privatePaths});
  const failed = [...contracts.filter(row => !row.ok), ...rows.filter(row => !row.ok)];
  return { ok: executionLevel.ok && !failed.length, staticOnly: true, launched: false,
    scope: 'Files and hashes versus trusted build source and Electron runtime; actual EXE RT_MANIFEST; no startup or NSIS success claim.',
    version: candidatePackage.version, electronVersion: fs.readFileSync(path.join(electronDist, 'version'), 'utf8').trim(),
    directory, sourceRoot, electronDist, nsisDir: nsisDir ? path.resolve(nsisDir) : null, buildConfigFile: resolved.file, explicitBuildConfig: resolved.explicit, candidateFiles: inventory.length, verifiedFiles: rows.length,
    executable: { file: path.basename(executable), ...executableHash, executionLevel }, archive: archiveBefore, contracts, failed, files: rows };
}
function parseArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const key = { '--dir': 'directory', '--source': 'sourceRoot', '--electron-dist': 'electronDist', '--nsis-dir': 'nsisDir', '--output': 'output', '--build-config': 'buildConfigFile' }[args[index]];
    if (!key || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Usage: verify-manager-release.js --dir <win-unpacked> [--source <trusted-source>] [--build-config <trusted JSON>] [--electron-dist <electron-dist>] [--nsis-dir <nsis-bin>] [--output <report.json>]');
    result[key] = args[++index];
  }
  if (!result.directory) throw new Error('Provide --dir <win-unpacked>.');
  if (result.output) {
    const target = path.resolve(result.output), candidate = path.resolve(result.directory), relative = path.relative(candidate, target);
    if (relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error('Write the report outside the read-only candidate directory.');
  }
  return result;
}
if (require.main === module) {
  (async () => {
    const options = parseArguments(process.argv.slice(2));
    const result = await verifyManagerRelease(options);
    if (options.output) fs.writeFileSync(path.resolve(options.output), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  })().catch(error => { console.error(JSON.stringify({ ok: false, staticOnly: true, launched: false, error: error.message }, null, 2)); process.exitCode = 1; });
}
module.exports = { STARTUP_FILES, RUNTIME_FILES, sourceCopies, archiveSourceFiles, startupContract, verifyManagerRelease, parseArguments, hashFile, walk };
