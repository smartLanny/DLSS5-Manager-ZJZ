'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function read(root, name) {
  const file = path.join(root, name), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 4 * 1024 * 1024) throw new Error('Evidence must be an explicitly selected bounded fixture file');
  const bytes = fs.readFileSync(file); return { bytes, text: bytes.toString('utf8'), sha256: digest(bytes) };
}
function summarize(root, osExitCode = null) {
  const report = read(root, 'feeder-dx12-report.json'), feeder = read(root, 'dlss5-feed.log'), core = read(root, 'nr-before-sr.log'), reshade = read(root, 'ReShade.log');
  const value = JSON.parse(report.text);
  const exitFile = path.join(root, 'process-exit.json');
  if (fs.existsSync(exitFile)) {
    const observed = JSON.parse(read(root, 'process-exit.json').text.replace(/^\uFEFF/, ''));
    if (observed.pid !== value.pid || !Number.isInteger(observed.exitCode) || observed.timedOut === true) throw new Error('Observed process exit does not match this fixture session');
    osExitCode = observed.exitCode;
  }
  const session = [...feeder.text.matchAll(/\[nr-feeder-dx12-session\] pid=(\d+)/g)];
  if (value.schema !== 1 || value.api !== 'dx12' || session.length !== 1 || Number(session[0][1]) !== value.pid ||
      value.frames !== value.requestedFrames || !value.actualSrgbSwapchain || !value.feederLoaded || !Array.isArray(value.samples)) throw new Error('Fixture session/report identity mismatch');
  const transfers = [...feeder.text.matchAll(/^(\d\d:\d\d:\d\d\.\d+)\s+\[nr-feeder-dx12-completion\] frame=(\d+) nr_completed=1 output_recorded=1 provenance=Synthetic$/gm)]
    .map(match => ({ localTime: match[1], completedCount: Number(match[2]) }));
  const hazardous = /###\s*CRASH RECORDED|external NR completion unconfirmed|external NR GPU.*quarantined/i.test(feeder.text + core.text);
  const evaluations = [...core.text.matchAll(/^(\d\d:\d\d:\d\d\.\d+)\s+NR-after-SR evaluate succeeded: count=(\d+) extent=(\d+)x(\d+)/gm)]
    .map(match => ({ localTime: match[1], count: Number(match[2]), width: Number(match[3]), height: Number(match[4]) }));
  const resourceTimeline = [...core.text.split(/\r?\n/).filter(line => /Deferred Feature 18 retirement|GPU retirement fence completed|NR ReleaseFeature|post-SR signed feature 18 create/.test(line)),
    ...feeder.text.split(/\r?\n/).filter(line => /\[feed\] building:/.test(line))].sort();
  return { source: path.basename(root), pid: value.pid, gpu: value.gpu, frames: value.frames, drawCalls: value.drawCalls, samples: value.samples,
    actualSrgbSwapchain: true, sameSession: true, nrCompletionMarkers: transfers,
    actualCoreEvaluationObserved: /NR-after-SR evaluate succeeded/.test(core.text), hazardObserved: hazardous,
    evaluations, resourceTimeline, resize: value.resize, resizeAt: value.resizeAt || null, resizeStartedUtc: value.resizeStartedUtc || null, resizeCompletedUtc: value.resizeCompletedUtc || null,
    nrWritebacksBeforeResize: value.nrWritebacksBeforeResize ?? null,
    reportExit: value.exit, osExitCode, osExitObserved: Number.isInteger(osExitCode),
    files: Object.fromEntries(Object.entries({ report, feeder, core, reshade }).map(([name, file]) => [name, { sha256: file.sha256, bytes: file.bytes.length }])) };
}
function resizeEvidence(run) {
  const before = run.samples.filter(sample => sample.frame < run.resizeAt), after = run.samples.filter(sample => sample.frame >= run.resizeAt);
  const counterProgress = after.length > 1 && after.every((sample, index) => sample.coreQuery === true && sample.nrWritebacks > 0 && sample.lastBypass === 0 &&
    (index === 0 || sample.nrWritebacks - after[index - 1].nrWritebacks === sample.frame - after[index - 1].frame));
  const shape = before.length > 0 && before.every(sample => sample.width === 640 && sample.height === 360) && after.length > 1 && after.every(sample => sample.width === 768 && sample.height === 432);
  const processed = run.resize === true && shape && counterProgress && run.evaluations.some(row => row.width === 768 && row.height === 432) &&
    run.nrCompletionMarkers.length > 0 && !run.hazardObserved && run.osExitCode === 0 && run.reportExit === 'clean';
  return { processed, initialSize: { width: 640, height: 360 }, resizedSize: { width: 768, height: 432 }, resizeCount: 1,
    counterEpochs: { beforeResize: run.nrWritebacksBeforeResize, afterResizeFirstSample: after[0]?.nrWritebacks ?? null, afterResizeLastSample: after.at(-1)?.nrWritebacks ?? null,
      explanation: 'Core resource ownership is released at resize; writeback counters restart in a new epoch. These values are not a single cumulative total.' },
    sameFrameReadback: { beforeSamples: before.length, afterSamples: after.length,
      everySampleChangedRgb: run.samples.every(sample => sample.changedRgbPixels === sample.width * sample.height),
      everySamplePreservedAlpha: run.samples.every(sample => sample.changedAlphaPixels === 0),
      comparison: 'Each sample compares the scene readback before Present with the processed readback after that same Present. Samples are not compared across animation frames or across resize. Pixel changes alone are not attributed entirely to NR; the separate NR-off control and actual callback/Core counters establish NR execution.' } };
}
function compare(on, off) {
  const pairs = on.samples.map(sample => {
    const control = off.samples.find(other => other.frame === sample.frame);
    return { frame: sample.frame, sameInput: Boolean(control && control.inputHash === sample.inputHash),
      minimumExtraChangedPixels: control ? Math.max(0, sample.changedRgbPixels - control.changedRgbPixels) : null,
      alphaPreserved: sample.changedAlphaPixels === 0 && control?.changedAlphaPixels === 0 };
  });
  return { nrOnlyOn: on.actualCoreEvaluationObserved && on.nrCompletionMarkers.length > 0 && !off.actualCoreEvaluationObserved && off.nrCompletionMarkers.length === 0,
    allInputsMatched: pairs.every(pair => pair.sameInput), pairs,
    caveat: 'NR-off retains a fixed ReShade output difference. Pixel comparison measures the additional change, not an assertion that every NR-off pixel equals the raw scene.' };
}
if (require.main === module) {
  const [onRoot, offRoot, resizeRoot, output] = process.argv.slice(2);
  if (!output) throw new Error('Usage: node scripts/feeder-dx12-evidence.js <on-dir> <off-dir> <resize-dir> <new-summary.json>');
  const on = summarize(path.resolve(onRoot)), off = summarize(path.resolve(offRoot)), resize = summarize(path.resolve(resizeRoot));
  const resized = resizeEvidence(resize);
  const result = { schema: 2, route: 'feeder-dx12', core: '0.4.7beta', hardwareScope: 'RTX5090 Laptop; RGBA8 confirmed sRGB; controlled renderer',
    fixedSizeCallbackProcessed: on.nrCompletionMarkers.length > 0 && on.actualCoreEvaluationObserved && !on.hazardObserved,
    controlledResizeProcessed: resized.processed, completeAcceptance: false, realGameVerified: false, on, off, paired: compare(on, off), resize, resizeEvidence: resized,
    resizeBoundary: resized.processed ? 'One 640x360 to 768x432 resize recovered real callback/Core evaluation and writeback in a new counter epoch.' : 'This selected run does not establish post-resize recovery.',
    limits: ['no real-game acceptance', 'no HDR/BGRA/DX11/x86 acceptance', 'Synthetic guides; semantic depth/MV quality is not accepted', 'OS exit status unavailable for initial fixed-size on/off runs', 'ReShade shutdown reference-count warnings retained for later lifecycle validation'] };
  fs.writeFileSync(path.resolve(output), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ fixedSizeCallbackProcessed: result.fixedSizeCallbackProcessed, completeAcceptance: false,
    controlledResizeProcessed: result.controlledResizeProcessed, sameInputs: result.paired.allInputsMatched, nrOnlyOn: result.paired.nrOnlyOn, summarySha256: digest(fs.readFileSync(output)) }, null, 2));
}
module.exports = { summarize, compare, resizeEvidence };
