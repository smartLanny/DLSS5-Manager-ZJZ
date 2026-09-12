'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createGameLaunchBroker } = require('../src/product/game-launch-broker');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runStartupSmoke({ electron, executable, logsDirectory, mainFile = path.resolve(__dirname, '../main.js') } = {}) {
  if (process.platform !== 'win32') throw new Error('The token-verified startup smoke runs on Windows.');
  if (executable) {
    if (electron) throw new Error('Choose --executable for branded startup or --electron for the source harness.');
    executable = fs.realpathSync(executable);
    mainFile = path.join(path.dirname(executable), 'resources/app.asar/main.js');
  }
  if (!electron) electron = require('electron');
  if (!path.isAbsolute(electron) || !fs.existsSync(electron)) throw new Error('Provide the absolute Electron runtime EXE path.');
  electron = fs.realpathSync(electron);
  const sourceArtifact = mainFile.match(/^(.+?\.asar)(?:[\\/]|$)/i)?.[1] || mainFile;
  const sourceSha256 = crypto.createHash('sha256').update(fs.readFileSync(sourceArtifact)).digest('hex');
  const executableSha256 = executable ? crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex') : null;
  if (logsDirectory) {
    logsDirectory = path.resolve(logsDirectory);
    const relative = executable ? path.relative(path.dirname(executable), logsDirectory) : '..';
    if (relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error('Keep startup logs outside the candidate directory.');
    fs.mkdirSync(logsDirectory, { recursive: true });
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-startup-runtime-'));
  const entry = path.resolve(__dirname, '../test/startup-runtime.electron.cjs');
  const broker = createGameLaunchBroker({ scriptPath: path.resolve(__dirname, '../src/product/game-launch-broker.ps1'), timeoutMs: 15000 });
  const rows = [];
  try {
    for (const mode of ['normal', 'compatibility']) {
      const directory = path.join(root, mode); fs.mkdirSync(directory);
      const args = [entry, `--startup-smoke-root=${directory}`, `--startup-smoke-main=${mainFile}`];
      if (mode === 'compatibility') args.push('--no-sandbox');
      // This proof holds even when the test runner itself is elevated. Neither
      // mode changes a manifest, userData, driver setting or an existing process.
      const started = executable
        ? await require('./startup-packaged-launch').startPackagedWithIsolation({ executable, mainFile, entry, directory, compatibility: mode === 'compatibility', broker })
        : await broker.launch({ exe: electron, args, cwd: path.dirname(sourceArtifact) });
      const report = path.join(directory, 'result.json'), deadline = Date.now() + 24000;
      while (!fs.existsSync(report) && Date.now() < deadline) await sleep(100);
      if (!fs.existsSync(report)) {
        try { process.kill(started.pid); } catch {}
        throw Object.assign(new Error(`${mode}: Electron did not produce a readiness report.`), { artifactRoot: root });
      }
      const result = JSON.parse(fs.readFileSync(report, 'utf8'));
      if (logsDirectory) {
        const destination = path.join(logsDirectory, mode); fs.mkdirSync(destination, { recursive: true });
        fs.copyFileSync(report, path.join(destination, 'result.json'));
        fs.cpSync(path.join(directory, 'startup'), path.join(destination, 'startup'), { recursive: true });
      }
      const stageNames = new Set(result.stages.map(row => row.stage));
      const ok = result.ok === true && started.elevated === false && result.mode === mode && result.visible === true &&
        result.configuredSandbox === true && result.contextIsolation === true && result.nodeIntegration === false &&
        result.document?.preloadConnected === true && result.document?.bodyVisible === true && result.document?.readyState === 'complete' &&
        result.document?.startupContext?.privilege === 'standard' && result.document?.startupContext?.mode === mode &&
        result.document?.startupPrivilege === '普通权限' &&
        ['window-visible', 'page-loaded', 'renderer-ready'].every(value => stageNames.has(value));
      rows.push({ ...result, ok, pid: started.pid, tokenElevated: started.elevated, packagedExecutable: started.packagedExecutable === true,
        userDataFlagHonoredBeforeInstrumentation: started.userDataFlagHonoredBeforeInstrumentation === true, instrumentation: started.instrumentation || null });
      if (!ok) throw Object.assign(new Error(`${mode}: ${result.message || 'Real startup readiness contract failed.'}`), { artifactRoot: root, rows });
      await sleep(200);
    }
    if (crypto.createHash('sha256').update(fs.readFileSync(sourceArtifact)).digest('hex') !== sourceSha256) throw new Error('The application entry changed during the startup smoke; rerun the frozen candidate.');
    if (executable && crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex') !== executableSha256) throw new Error('The packaged EXE changed during the startup smoke.');
    return { ok: true, sourceSha256, executableSha256, packagedExecutable: Boolean(executable), logsDirectory: logsDirectory || null,
      scope: 'Production main/preload/renderer with isolated userData and inert game services; no game or driver operations.', runs: rows };
  } finally {
    if (rows.length === 2 && rows.every(row => row.ok)) fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const option = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
  runStartupSmoke({ electron: option('--electron'), executable: option('--executable'), logsDirectory: option('--logs'), mainFile: option('--main') || undefined }).then(result => {
    const output = option('--output');
    if (output) fs.writeFileSync(path.resolve(output), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ok: true, packagedExecutable: result.packagedExecutable, runs: result.runs.map(row => ({ mode: row.mode, electron: row.electron,
      tokenElevated: row.tokenElevated, visible: row.visible, stages: row.stages.filter(value => ['window-visible', 'page-loaded', 'renderer-ready'].includes(value.stage)).map(value => value.stage) })) }, null, 2));
  }).catch(error => { console.error(JSON.stringify({ ok: false, message: error.message, artifactRoot: error.artifactRoot }, null, 2)); process.exitCode = 1; });
}

module.exports = { runStartupSmoke };
