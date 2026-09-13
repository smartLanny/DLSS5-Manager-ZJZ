'use strict';
// Records observed controlled runs only. It never launches a game or GPU task.
const fs = require('node:fs');
const path = require('node:path');
const { createLegacyRuntime, DIRECTORY } = require('../src/product/legacy-runtime');
const { fileDigest, fingerprint, resolveFile } = require('../src/product/feeder-runtime');
const catalog = require('../src/product/legacy-runtime-catalog');
const { noLinks } = require('../src/product/launch-safety');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const pairs = [['dx9', 'x86', 'r20'], ['dx9', 'x64', 'r20'], ['dx10', 'x86', 'r20b'], ['dx10', 'x64', 'r20'], ['dx11', 'x86', 'r20'], ['dx11', 'x64', 'r20'], ['dx12', 'x64', 'r20b']];
function currentPins(runtime) {
  return catalog.list().flatMap(row => row.proxyEntries.map(proxyEntry => runtime.load({ api: row.gameApi, architecture: row.architecture, hardwareFamily: row.hardwareFamily, loadingBackend: row.loadingBackend, proxyEntry }).fingerprint));
}
async function recordControlledAcceptance(appDir = path.resolve(__dirname, '..')) {
  const runtime = createLegacyRuntime({ appDir }), manifestFile = path.join(runtime.root, 'manifest.json');
  const manifest = readJson(manifestFile), pins = [...runtime.lock.restorableRecipeFingerprints, ...currentPins(runtime)], routes = [];
  for (const [api, architecture, suffix] of pairs) {
    const relativeFixture = `build/feeder-final-${api}-${architecture}-${suffix}`, dir = path.join(appDir, relativeFixture);
    const run = readJson(path.join(dir, 'run-result.json'));
    if (run.exitCode !== 0 || run.route !== `${api}-${architecture}` || !Number.isSafeInteger(run.pid)) throw new Error(`Fixture did not exit successfully: ${relativeFixture}`);
    const rendererFile = api === 'dx9' ? 'feeder-d3d9on12-probe.json' : api === 'dx12' ? 'feeder-dx12-report.json' : 'feeder-legacy-report.json';
    const renderer = readJson(path.join(dir, rendererFile));
    if (renderer.exit !== 'clean' || !(renderer.resize || renderer.reset)) throw new Error(`No resize/exit report: ${relativeFixture}`);
    const pkg = runtime.load({ api, architecture, hardwareFamily: 'RTX50', loadingBackend: 'local' });
    const roots = { game: dir, runtime: path.join(dir, DIRECTORY), addon: path.join(dir, DIRECTORY, 'addons') }, components = [];
    for (const row of pkg.recipe.files) {
      const file = resolveFile(roots[row.base], row.target); await noLinks(file); const observed = await fileDigest(file);
      if (!row.mutable && observed !== row.sha256) throw new Error(`Test used another immutable asset: ${api}/${architecture}/${row.id}`);
      components.push({ id: row.id, base: row.base, target: row.target, sha256: row.sha256, ...(row.mutable ? { observedMutableSha256: observed } : {}) });
    }
    const gameLogFile = path.join(roots.addon, 'dlss5-feed.log'), gameLog = fs.readFileSync(gameLogFile, 'utf8');
    const sessions = [...gameLog.matchAll(/\[nr-feeder-session\] pid=(\d+) source=0151-external-v1/g)];
    if (!sessions.length || sessions.some(row => Number(row[1]) !== run.pid)) throw new Error(`Wrong process log: ${relativeFixture}`);
    let beforeResize, afterResize, hostLogFile = null, hostLog = '';
    if (pkg.recipe.hostRequired) { hostLogFile = path.join(roots.addon, 'host64/dlss5-feed-host.log'); hostLog = fs.readFileSync(hostLogFile, 'utf8'); }
    if (api === 'dx9') {
      const groups = gameLog.split('[nr-feeder-dx9-session]').slice(1).map(text => ({ hostPid: Number(text.match(/host_pid=(\d+)/)?.[1]),
        dimensions: (text.match(/resources epoch=\d+ width=(\d+) height=(\d+)/) || []).slice(1).map(Number),
        receivedFrames: [...text.matchAll(/\[nr-feeder-client-completion\] frame=(\d+) output_ready=1 nr_completed=1/g)].map(row => Number(row[1])) }));
      if (groups.length !== 2 || groups.some(row => !row.hostPid || !row.receivedFrames.length || row.dimensions.length !== 2) || groups[0].dimensions.join() === groups[1].dimensions.join()) throw new Error(`DX9 did not resume NR through Reset: ${relativeFixture}`);
      beforeResize = { type: 'game-received-host-completion', ...groups[0] }; afterResize = { type: 'game-received-host-completion', ...groups[1] };
      if (!hostLog.includes(`pid=${groups[1].hostPid} game_pid=${run.pid}`) || !/\[nr-feeder-host-ack\].*output_ready=1 nr_completed=1/.test(hostLog)) throw new Error(`DX9 host completion absent: ${relativeFixture}`);
    } else {
      const matches = pkg.recipe.hostRequired ? [...hostLog.matchAll(/\[nr-feeder-host-ack\] pid=(\d+) game_pid=(\d+) frame=(\d+) epoch=(\d+) output_ready=1 nr_completed=1 luid=([A-F0-9:]+)/g)].filter(row => Number(row[2]) === run.pid)
        .map(row => ({ frame: Number(row[3]), epoch: Number(row[4]), luid: row[5] })) : [...gameLog.matchAll(/\[nr-feeder-completion\] frame=(\d+) epoch=(\d+) nr_completed=1 output_recorded=1 provenance=Synthetic/g)].map(row => ({ frame: Number(row[1]), epoch: Number(row[2]) }));
      const epochs = [...new Set(matches.map(row => row.epoch))];
      if (epochs.length < 2) throw new Error(`No NR after resize: ${relativeFixture}`);
      if (pkg.recipe.hostRequired) for (const row of matches) if (!gameLog.includes(`frame=${row.frame} output_ready=1 nr_completed=1`)) throw new Error(`Host output not acknowledged by game: ${relativeFixture}`);
      beforeResize = { epoch: epochs[0], completedFrames: matches.filter(row => row.epoch === epochs[0]).map(row => row.frame) };
      afterResize = { epoch: epochs.at(-1), completedFrames: matches.filter(row => row.epoch === epochs.at(-1)).map(row => row.frame) };
    }
    const shaderLogFile = path.join(pkg.recipe.hostRequired && api === 'dx9' ? path.join(roots.addon, 'host64') : dir, 'ReShade.log');
    const shaderLog = fs.readFileSync(shaderLogFile, 'utf8');
    if (/failed to compile|failed to create.*(?:shader|pipeline)/i.test(shaderLog)) throw new Error(`Shader runtime failure: ${relativeFixture}`);
    routes.push({ api, architecture, loadingBackend: 'local', proxyEntry: pkg.recipe.proxyEntry, controlledRuntimeVerified: true,
      resizeVerified: true, rendererExitCode: run.exitCode, realGameVerified: false, frames: renderer.frames, gamePid: run.pid,
      proof: { beforeResize, afterResize }, components,
      evidence: { fixture: relativeFixture, completedAt: run.completedAt, rendererSha256: await fileDigest(path.join(dir, 'feeder-legacy-present.exe')),
        rendererReportSha256: await fileDigest(path.join(dir, rendererFile)), providerLogSha256: await fileDigest(gameLogFile),
        ...(hostLogFile ? { hostLogSha256: await fileDigest(hostLogFile) } : {}), shaderLogSha256: await fileDigest(shaderLogFile) },
      alpha: api === 'dx12' ? { readbackVerified: renderer.samples.every(row => row.changedAlphaPixels === 0), changedPixels: 0 } :
        { readbackVerified: false, note: api === 'dx9' ? 'Host identity readback verified separately; this renderer does not inspect NR alpha.' : 'ReShade overlay changes alpha in its own region; NR alpha is not separately attributed by this fixture.' } });
  }
  const acceptance = { schema: 1, hardwareFamily: 'RTX50', hardware: 'NVIDIA GeForce RTX 5090 Laptop GPU', luid: '00000000:00014EC3',
    scope: 'Controlled same-frame SDR Synthetic post-process NR, VORT pixel guides, one resize/reset, exact final immutable components. No native SR/FG injection or game image-quality acceptance.',
    RTX40: { fileVerified: true, controlledRuntimeVerified: false, reason: 'No RTX40 hardware in this controlled environment.' }, realGameVerified: false, routes };
  const source = 'acceptance/controlled-rtx50.json', reportFile = resolveFile(runtime.root, source); fs.mkdirSync(path.dirname(reportFile), { recursive: true }); fs.writeFileSync(reportFile, JSON.stringify(acceptance, null, 2) + '\n');
  const reportAsset = { id: 'controlled-acceptance', source, role: 'evidence', architecture: null, mutable: false, sha256: await fileDigest(reportFile), bytes: fs.statSync(reportFile).size };
  manifest.assets = manifest.assets.filter(row => row.id !== reportAsset.id); manifest.assets.push(reportAsset); manifest.acceptance = {};
  for (const report of routes) manifest.acceptance[`${report.api}-${report.architecture}-RTX50-local-${report.proxyEntry}`] = { controlledRuntimeVerified: true, realGameVerified: false, reportAsset: reportAsset.id };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  const lockFile = path.join(appDir, 'src/product/legacy-runtime-lock.js');
  function save() { fs.writeFileSync(lockFile, "'use strict';\n\n// Source-pinned pool and historical receipts; never updated by an IPC request.\nmodule.exports = Object.freeze(" + JSON.stringify({ manifestFingerprint: fingerprint(manifest), restorableRecipeFingerprints: [...new Set(pins)].sort() }, null, 2) + ');\n'); }
  save(); delete require.cache[require.resolve(lockFile)];
  pins.push(...currentPins(createLegacyRuntime({ appDir }))); save();
  return { routes: routes.length, assets: manifest.assets.length, manifestFingerprint: fingerprint(manifest), acceptance: source };
}
if (require.main === module) recordControlledAcceptance().then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { recordControlledAcceptance };
