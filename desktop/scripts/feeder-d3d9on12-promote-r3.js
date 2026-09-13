'use strict';
// Replays this one source-pinned DX9 promotion. It does not launch a GPU task.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createLegacyRuntime, DIRECTORY, DEFAULTS } = require('../src/product/legacy-runtime');
const { fileDigest, fingerprint, resolveFile } = require('../src/product/feeder-runtime');
const catalog = require('../src/product/legacy-runtime-catalog');
const APP = path.resolve(__dirname, '..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const expected = Object.freeze({
  source: '40b8af455ad5d89823bb42ad854bec5d687658e5bd6cba30026f0434985da774',
  x86: '250e4a5523a20c54a0c59dc55f08f81cc38526efa1eb6c920a86e3602fd499f8',
  x64: '7743b2cb7d2bbc8ea42471a2787cc91e635d421162d14a862cba9d4670fa4a2a'
});
function recipes(runtime) {
  return catalog.list().flatMap(row => row.proxyEntries.map(proxyEntry => runtime.load({
    api: row.gameApi, architecture: row.architecture, hardwareFamily: row.hardwareFamily,
    loadingBackend: row.loadingBackend, proxyEntry
  })));
}
function config(text) {
  return Object.fromEntries(text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(Boolean).map(line => {
    const at = line.indexOf('='); assert.ok(at > 0, 'Fixture config has a plain key');
    return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }));
}
async function controlled(runtime, architecture, build) {
  const relativeFixture = architecture === 'x86' ? 'build/feeder-d3d9on12-depth-switch-run-x86-r3' : 'build/feeder-d3d9on12-depth-switch-run-x64-r3';
  const directory = path.join(APP, relativeFixture), run = read(path.join(directory, 'run-result.json'));
  assert.equal(run.exitCode, 0); assert.ok(Number.isSafeInteger(run.pid)); assert.equal(run.providerSha256, expected[architecture]);
  const renderer = read(path.join(directory, 'feeder-d3d9on12-probe.json'));
  assert.equal(renderer.architecture, architecture); assert.equal(renderer.frames, 600); assert.equal(renderer.reset, true); assert.equal(renderer.exit, 'clean');
  const probeBuildDirectory = path.join(APP, architecture === 'x86' ? 'build/feeder-d3d9on12-depth-switch-probe-x86-r3' : 'build/feeder-d3d9on12-depth-switch-probe-x64-r3');
  const probeBuild = read(path.join(probeBuildDirectory, 'validation.json'));
  assert.equal(probeBuild.compileLinkVerified, true); assert.equal(probeBuild.architecture, architecture);
  assert.equal(probeBuild.sourceSha256, await fileDigest(path.join(APP, 'build/feeder-d3d9on12-depth-switch-source-r1/probe.cpp')));
  assert.equal(probeBuild.sha256, await fileDigest(path.join(directory, 'feeder-legacy-present.exe')));
  const states = read(path.join(directory, 'nr-switch-report.json'));
  assert.equal(states.unbindBeforePresent, true); assert.equal(states.resetWithPendingDepth, true);
  const sample = frame => { const row = states.samples.find(value => value.frame === frame); assert.ok(row); return row; };
  assert.ok(sample(180).nrCompleted > 0 && sample(180).sceneDepthFrames > 0);
  const off = [211, 240, 270, 300].map(sample);
  assert.ok(off.every(row => row.enabled === 0 && row.submitted === off[0].submitted && row.copied === off[0].copied && row.nrCompleted === off[0].nrCompleted));
  assert.ok(off[3].disabledPresents > off[0].disabledPresents);
  assert.equal(sample(300).shaders, false); assert.equal(sample(390).shaders, false); assert.equal(sample(390).enabled, 1);
  assert.ok(sample(390).nrCompleted > sample(300).nrCompleted && sample(390).copied > sample(300).copied);
  assert.equal(sample(420).shaders, true); assert.ok(sample(600).nrCompleted > sample(420).nrCompleted);
  const depthReport = read(path.join(directory, 'depth-switch-report.json'));
  assert.equal(depthReport.deviceRemovedReason, 0); assert.equal(depthReport.debugErrors, 0);
  assert.deepEqual(depthReport.changes.map(row => row.frame), [61, 121, 361, 451, 481]);
  assert.deepEqual(depthReport.changes.map(row => row.nativeFormat), [55, 45, 55, 0, 45]);
  assert.ok(depthReport.changes.slice(0, 3).every(row => row.width === 640 && row.height === 360 && row.samples === 1 && row.quality === 0));
  assert.equal(depthReport.changes[3].samples, 2); assert.equal(depthReport.changes[4].samples, 1);
  assert.ok(sample(120).nrCompleted > sample(60).nrCompleted && sample(180).nrCompleted > sample(120).nrCompleted);
  for (const frame of [460, 480]) {
    assert.equal(sample(frame).enabled, 1);
    for (const key of ['submitted', 'copied', 'nrCompleted']) assert.equal(sample(frame)[key], sample(450)[key]);
  }
  assert.ok(sample(540).nrCompleted > sample(480).nrCompleted && sample(600).nrCompleted > sample(540).nrCompleted);
  const roots = { game: directory, runtime: path.join(directory, DIRECTORY), addon: path.join(directory, DIRECTORY, 'addons') };
  assert.deepEqual(config(fs.readFileSync(path.join(roots.addon, 'dlss5-feed.cfg'), 'utf8')), { ...config(DEFAULTS.feeder), fixture_preserve_key: 'unchanged' });
  const pkg = runtime.load({ api: 'dx9', architecture, hardwareFamily: 'RTX50', loadingBackend: 'local' }), components = [];
  for (const row of pkg.recipe.files) {
    const observed = await fileDigest(resolveFile(roots[row.base], row.target));
    const sha256 = row.role === 'provider' ? expected[architecture] : row.sha256;
    if (!row.mutable) assert.equal(observed, sha256, `Actual fixture asset ${architecture}/${row.id}`);
    components.push({ id: row.id, base: row.base, target: row.target, sha256, ...(row.mutable ? { observedMutableSha256: observed } : {}) });
  }
  const providerLogFile = path.join(roots.addon, 'dlss5-feed.log'), gameLog = fs.readFileSync(providerLogFile, 'utf8');
  const sessions = [...gameLog.matchAll(/\[nr-feeder-session\] pid=(\d+) source=0151-external-v1/g)];
  assert.ok(sessions.length === 2 && sessions.every(row => Number(row[1]) === run.pid));
  assert.match(gameLog, /source=current-frame-scene bound_hr=0x88760866 draws=3 vertices=18/);
  const descriptors = [...gameLog.matchAll(/resources epoch=(\d+) width=(\d+) height=(\d+) depth_format=(\d+) depth_samples=(\d+) depth_quality=(\d+)/g)];
  assert.ok(descriptors.some(row => Number(row[4]) === 55) && descriptors.some(row => Number(row[4]) === 45));
  assert.ok(descriptors.every(row => Number(row[5]) === 1 && Number(row[6]) === 0));
  assert.match(gameLog, /\[nr-feeder-dx9-depth-rejected\] dx9_format=75 samples=2 quality=0/);
  const groups = gameLog.split('[nr-feeder-dx9-session]').slice(1).map(text => ({ hostPid: Number(text.match(/host_pid=(\d+)/)?.[1]),
    dimensions: (text.match(/resources epoch=\d+ width=(\d+) height=(\d+)/) || []).slice(1).map(Number),
    receivedFrames: [...text.matchAll(/\[nr-feeder-client-completion\] frame=(\d+) output_ready=1 nr_completed=1/g)].map(row => Number(row[1])) }));
  assert.equal(groups.length, 2); assert.ok(groups.every(row => row.hostPid > 0 && row.receivedFrames.length > 0));
  assert.deepEqual(groups.map(row => row.dimensions), [[640, 360], [768, 432]]);
  const hostLogFile = path.join(roots.addon, 'host64/dlss5-feed-host.log'), hostLog = fs.readFileSync(hostLogFile, 'utf8');
  assert.ok(hostLog.includes(`pid=${groups[1].hostPid} game_pid=${run.pid}`));
  assert.match(hostLog, /\[nr-feeder-host-ack\].*output_ready=1 nr_completed=1/);
  const shaderLogFile = path.join(roots.addon, 'host64/ReShade.log'), shaderLog = fs.readFileSync(shaderLogFile, 'utf8');
  assert.doesNotMatch(shaderLog, /failed to compile|failed to create.*(?:shader|pipeline)/i);
  const acceptance = { schema: 1, candidate: false, providerSha256: expected[architecture], sourceSha256: expected.source,
    gamePid: run.pid, exitCode: run.exitCode, completedAt: run.completedAt, unboundDepthFixed: true,
    disabledSubmissionsStopped: true, disabledCopiesStopped: true, shaderSwitchIndependent: true,
    reenableVerified: true, resetWithPendingDepthVerified: true, configurationPreserved: true,
    sameSizeDepthFormatSwitchVerified: true, unsupportedMultisampleDepthBypassVerified: true, supportedDepthRecoveryVerified: true,
    d3d12DebugLayerVerified: depthReport.debugLayerEnabled, deviceRemovedReason: depthReport.deviceRemovedReason, depthDescriptors: depthReport.changes,
    realGameVerified: false, samples: states.samples, providerLogSha256: await fileDigest(providerLogFile) };
  const report = { api: 'dx9', architecture, loadingBackend: 'local', proxyEntry: 'd3d9', controlledRuntimeVerified: true,
    resizeVerified: true, rendererExitCode: run.exitCode, realGameVerified: false, frames: renderer.frames, gamePid: run.pid,
    proof: { beforeResize: { type: 'game-received-host-completion', ...groups[0] }, afterResize: { type: 'game-received-host-completion', ...groups[1] },
      currentFrameSceneDepthVerified: true, independentNrSwitchVerified: true, disabledSubmitAndCopyStopped: true,
      reenableHistoryVerified: true, resetWithPendingDepthVerified: true, configurationPreserved: true,
      sameSizeDepthFormatSwitchVerified: true, unsupportedMultisampleDepthBypassVerified: true, supportedDepthRecoveryVerified: true,
      d3d12DebugLayerVerified: depthReport.debugLayerEnabled, deviceRemovedReason: depthReport.deviceRemovedReason, depthDescriptors: depthReport.changes, samples: states.samples },
    components, evidence: { fixture: relativeFixture, completedAt: run.completedAt,
      rendererSha256: await fileDigest(path.join(directory, 'feeder-legacy-present.exe')),
      rendererReportSha256: await fileDigest(path.join(directory, 'feeder-d3d9on12-probe.json')),
      switchReportSha256: await fileDigest(path.join(directory, 'nr-switch-report.json')),
      depthSwitchReportSha256: await fileDigest(path.join(directory, 'depth-switch-report.json')),
      providerLogSha256: acceptance.providerLogSha256, hostLogSha256: await fileDigest(hostLogFile), shaderLogSha256: await fileDigest(shaderLogFile),
      buildReportAsset: 'dx9-r3-build' }, alpha: { readbackVerified: false, note: 'The full add-on switch/Reset fixture does not inspect NR alpha.' } };
  return { architecture, directory, acceptance, report, probeBuildDirectory, probeBuild, binary: build.assets.find(row => row.architecture === architecture).file };
}
async function promote() {
  const runtime = createLegacyRuntime({ appDir: APP }), pool = runtime.root;
  const manifestFile = path.join(pool, 'manifest.json'), lockFile = path.join(APP, 'src/product/legacy-runtime-lock.js');
  const manifest = read(manifestFile), oldRecipes = recipes(runtime), oldManifest = structuredClone(manifest);
  assert.equal(runtime.lock.manifestFingerprint, '43ae12f59bae7f77a96eada1aa193ad82e7c22693d25fe0c3f1792c9b1ab0807', 'Promote only the observed pre-R3 pool');
  const sourceDirectory = path.join(APP, 'build/feeder-d3d9on12-fix-source-r3');
  const buildDirectory = path.join(APP, 'build/feeder-d3d9on12-fix-provider-r3');
  const build = read(path.join(buildDirectory, 'validation.json')), defender = read(path.join(buildDirectory, 'defender.json'));
  assert.equal(build.compileLinkVerified, true); assert.equal(build.sourceSha256, expected.source); assert.equal(defender.ok, true);
  const sourceNames = ['nr_feeder_d3d9.cpp', 'nr_feeder_control.h', 'nr_feeder_query.h', 'nr_feeder_ipc_client.h', 'nr_feeder_depth_copy.h'];
  const sources = {};
  for (const name of sourceNames) sources[`scripts/feeder-beta3/${name}`] = await fileDigest(path.join(sourceDirectory, name));
  assert.equal(sources['scripts/feeder-beta3/nr_feeder_d3d9.cpp'], expected.source);
  // Existing transport headers must already be the exact compiled dependencies.
  for (const name of ['nr_feeder_ipc_client.h', 'nr_feeder_depth_copy.h']) assert.equal(await fileDigest(path.join(APP, 'scripts/feeder-beta3', name)), sources[`scripts/feeder-beta3/${name}`]);
  for (const architecture of ['x86', 'x64']) {
    const asset = build.assets.find(row => row.architecture === architecture); assert.ok(asset);
    assert.equal(asset.sha256, expected[architecture]); assert.equal(await fileDigest(asset.file), expected[architecture]);
    assert.ok(defender.results.some(row => row.ok && row.unchanged && !row.detected && row.files.some(file => file.sha256 === expected[architecture] && file.bytes === asset.bytes)));
  }
  const tested = [];
  for (const architecture of ['x86', 'x64']) tested.push(await controlled(runtime, architecture, build));
  const reportFile = path.join(pool, 'acceptance/controlled-rtx50.json'), acceptance = read(reportFile);
  const unchanged = acceptance.routes.filter(row => row.api !== 'dx9'); assert.equal(unchanged.length, 5);
  for (const report of unchanged) {
    const pkg = runtime.load({ api: report.api, architecture: report.architecture, hardwareFamily: 'RTX50', loadingBackend: 'local' });
    for (const row of pkg.recipe.files) assert.ok(report.components.some(proof => proof.id === row.id && proof.sha256 === row.sha256 && proof.base === row.base && proof.target === row.target));
  }
  // Complete all validation before updating the source or pool. Archive the old
  // 48 selections so every previously installed API/backend remains restorable.
  const archive = path.join(APP, 'build/feeder-d3d9on12-r3-promotion');
  assert.equal(fs.existsSync(archive), false, 'Use an untouched promotion archive'); fs.mkdirSync(archive);
  fs.copyFileSync(manifestFile, path.join(archive, 'previous-manifest.json'));
  fs.copyFileSync(lockFile, path.join(archive, 'previous-lock.js'));
  fs.copyFileSync(reportFile, path.join(archive, 'previous-controlled-rtx50.json'));
  write(path.join(archive, 'previous-recipes.json'), oldRecipes.map(row => ({ fingerprint: row.fingerprint, recipe: row.recipe })));
  fs.mkdirSync(path.join(archive, 'source'));
  for (const name of sourceNames) fs.copyFileSync(path.join(sourceDirectory, name), path.join(archive, 'source', name));
  fs.copyFileSync(path.join(APP, 'build/feeder-d3d9on12-depth-switch-source-r1/probe.cpp'), path.join(archive, 'source/probe.cpp'));
  fs.copyFileSync(path.join(buildDirectory, 'validation.json'), path.join(archive, 'build-validation.json'));
  fs.copyFileSync(path.join(buildDirectory, 'defender.json'), path.join(archive, 'defender.json'));
  for (const item of tested) {
    const dir = path.join(archive, item.architecture); fs.mkdirSync(dir);
    for (const file of ['run-result.json', 'feeder-d3d9on12-probe.json', 'nr-switch-report.json', 'depth-switch-report.json', 'feeder-d3d9on12-probe.log', 'ReShade.log']) fs.copyFileSync(path.join(item.directory, file), path.join(dir, file));
    for (const [file, target] of [['dlss5-feed.log', 'provider.log'], ['host64/dlss5-feed-host.log', 'host.log'], ['host64/ReShade.log', 'host-ReShade.log']])
      fs.copyFileSync(path.join(item.directory, DIRECTORY, 'addons', file), path.join(dir, target));
    fs.copyFileSync(path.join(buildDirectory, item.architecture, 'build.log'), path.join(dir, 'build.log'));
    fs.copyFileSync(path.join(buildDirectory, item.architecture, 'build.cmd'), path.join(dir, 'build.cmd'));
    for (const file of ['build.cmd', 'build.log', 'validation.json']) fs.copyFileSync(path.join(item.probeBuildDirectory, file), path.join(dir, `probe-${file}`));
    fs.copyFileSync(item.binary, path.join(dir, path.basename(item.binary)));
    write(path.join(dir, 'acceptance.json'), item.acceptance);
    write(path.join(item.directory, 'acceptance.json'), item.acceptance);
  }
  for (const name of ['nr_feeder_d3d9.cpp', 'nr_feeder_control.h', 'nr_feeder_query.h']) fs.copyFileSync(path.join(sourceDirectory, name), path.join(APP, 'scripts/feeder-beta3', name));
  for (const item of tested) {
    const asset = manifest.assets.find(row => row.id === `provider-dx9-${item.architecture}`);
    fs.copyFileSync(resolveFile(pool, asset.source), path.join(archive, `previous-${path.basename(asset.source)}`));
    fs.copyFileSync(item.binary, resolveFile(pool, asset.source));
    asset.sha256 = expected[item.architecture]; asset.bytes = fs.statSync(item.binary).size;
    asset.provenance = { ...asset.provenance, build: 'd3d9on12-provider-fix-r3', sourceSha256: expected.source, source: sources, buildReportAsset: 'dx9-r3-build' };
  }
  acceptance.routes = acceptance.routes.map(row => row.api === 'dx9' ? tested.find(item => item.architecture === row.architecture).report : row);
  assert.deepEqual(acceptance.routes.filter(row => row.api !== 'dx9'), unchanged);
  write(reportFile, acceptance);
  const buildReport = { schema: 1, revision: 'd3d9on12-provider-fix-r3', upstreamCommit: manifest.upstream.commit,
    source: sources, compiler: 'MSVC (Visual Studio 2022), /std:c++20 /O2 /MT /utf-8 /LD /Brepro; ReShade and ImGui headers from source-pinned Feeder stage',
    builder: { path: 'scripts/feeder-d3d9on12-build-provider.ps1', sha256: await fileDigest(path.join(APP, 'scripts/feeder-d3d9on12-build-provider.ps1')) },
    assets: build.assets.map(({ architecture, bytes, sha256 }) => ({ architecture, bytes, sha256 })),
    defender, controlled: tested.map(item => item.acceptance), probes: tested.map(item => item.probeBuild), realGameVerified: false,
    limitations: { d32GameSurface: 'This Windows D3D9On12 runtime rejected D3DFMT_D32 and D3DFMT_D32F_LOCKABLE creation with D3DERR_INVALIDCALL; real same-size format changes use D24S8 and D16.',
      debugLayer: 'D3D12 debug layer was unavailable; no debug-layer verification is claimed. Both runs returned S_OK from GetDeviceRemovedReason.' },
    archive: 'build/feeder-d3d9on12-r3-promotion', previousPoolFingerprint: runtime.lock.manifestFingerprint,
    previousRecipeCount: oldRecipes.length, previousRecipeArchiveSha256: await fileDigest(path.join(archive, 'previous-recipes.json')) };
  const buildReportSource = 'acceptance/dx9-r3-build.json'; write(resolveFile(pool, buildReportSource), buildReport);
  const priorReportAsset = manifest.assets.find(row => row.id === 'controlled-acceptance');
  priorReportAsset.sha256 = await fileDigest(reportFile); priorReportAsset.bytes = fs.statSync(reportFile).size;
  manifest.assets.push({ id: 'dx9-r3-build', source: buildReportSource, role: 'evidence', architecture: null, mutable: false,
    sha256: await fileDigest(resolveFile(pool, buildReportSource)), bytes: fs.statSync(resolveFile(pool, buildReportSource)).size });
  for (const row of oldManifest.assets.filter(row => !['provider-dx9-x86', 'provider-dx9-x64', 'controlled-acceptance'].includes(row.id))) assert.deepEqual(manifest.assets.find(item => item.id === row.id), row);
  write(manifestFile, manifest);
  const manifestFingerprint = fingerprint(manifest), pins = new Set([...runtime.lock.restorableRecipeFingerprints, ...oldRecipes.map(row => row.fingerprint)]);
  const candidateRuntime = createLegacyRuntime({ appDir: APP, lock: { manifestFingerprint } });
  for (const row of recipes(candidateRuntime)) pins.add(row.fingerprint);
  const lock = { manifestFingerprint, restorableRecipeFingerprints: [...pins].sort() };
  fs.writeFileSync(lockFile, "'use strict';\n\n// Source-pinned pool and historical receipts; never updated by an IPC request.\nmodule.exports = Object.freeze(" + JSON.stringify(lock, null, 2) + ');\n');
  const offline = createLegacyRuntime({ appDir: APP, root: path.join(archive, 'absent-pool'), lock });
  for (const row of oldRecipes) assert.equal(fingerprint(offline.validateStored(row.recipe)), row.fingerprint);
  const forged = structuredClone(oldRecipes[0].recipe); forged.files[0].sha256 = 'a'.repeat(64); assert.throws(() => offline.validateStored(forged));
  const result = { schema: 1, manifestFingerprint, assets: manifest.assets.length, changedProviders: 2, preservedNonDx9Routes: unchanged.length,
    previousRecipesRestorable: oldRecipes.length, sourceSha256: expected.source, realGameVerified: false };
  write(path.join(archive, 'promotion.json'), result); return result;
}
if (require.main === module) promote().then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { promote };
