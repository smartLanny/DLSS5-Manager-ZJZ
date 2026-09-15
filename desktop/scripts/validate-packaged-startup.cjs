'use strict';

// CI orchestration only. Never relax the production broker or report an
// unperformed ordinary-token startup as a pass.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

async function checkEnvironment(inspect, env = process.env) {
  try {
    const token = await inspect();
    if (token?.elevated !== false || token.launchable !== true) throw new Error('Invalid ordinary-desktop inspection result.');
    return { status: 'available', ordinaryDesktop: true };
  } catch (error) {
    const hosted = env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted';
    if (!hosted || !['GAME_LAUNCH_SHELL_ELEVATED', 'GAME_LAUNCH_SHELL_MISSING'].includes(error.code)) throw error;
    return { status: 'not-run', ok: null, ordinaryDesktop: false, code: error.code,
      message: 'Hosted runner lacks a non-elevated interactive shell. Packaged startup requires manual verification on an ordinary Windows desktop.',
      safetyGuardsChanged: false, packagedStartupVerified: false };
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows is required.');
  const desktop = path.resolve(__dirname, '..'), product = require('../package.json');
  const executable = fs.realpathSync(path.join(desktop, 'dist-external/win-unpacked', product.build.productName + '.exe'));
  const output = path.join(desktop, 'build/validation'); fs.mkdirSync(output, { recursive: true });
  const reportFile = path.join(output, 'packaged-startup-status.json');
  const broker = require('../src/product/game-launch-broker').createGameLaunchBroker({
    scriptPath: path.join(desktop, 'src/product/game-launch-broker.ps1'), timeoutMs: 15000
  });
  const status = await checkEnvironment(() => broker.inspect({ exe: executable }));
  if (status.status === 'not-run') {
    fs.writeFileSync(reportFile, JSON.stringify(status, null, 2) + '\n');
    console.log('::warning::' + status.message);
    console.log(JSON.stringify(status));
    return;
  }
  function run(script, args) {
    const result = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { cwd: desktop, stdio: 'inherit', timeout: 180000 });
    if (result.error || result.status !== 0) throw new Error(script + ' failed; packaged startup is not verified.');
  }
  try {
    const proof = path.join(output, 'startup.json');
    run('startup-runtime-smoke.js', ['--executable', executable, '--logs', path.join(output, 'startup'), '--output', proof]);
    run('startup-uninstrumented-smoke.js', ['--executable', executable, '--isolation-proof', proof,
      '--logs', path.join(output, 'uninstrumented'), '--output', path.join(output, 'uninstrumented.json')]);
    fs.writeFileSync(reportFile, JSON.stringify({ status: 'passed', ok: true, packagedStartupVerified: true,
      ordinaryDesktop: true, safetyGuardsChanged: false, realGameValidation: 'pending' }, null, 2) + '\n');
  } catch (error) {
    fs.writeFileSync(reportFile, JSON.stringify({ status: 'failed', ok: false, packagedStartupVerified: false,
      message: error.message, safetyGuardsChanged: false }, null, 2) + '\n');
    throw error;
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { checkEnvironment };
