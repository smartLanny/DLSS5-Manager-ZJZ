'use strict';

const { execFileSync, execFile } = require('child_process');

// RTX 20/30/40 use the same fixed runtime family in this product. Keep the
// payload family names compact while exposing the actual detected series to
// the UI, so users are not told that a 20/30 card is unsupported.
const FAMILIES = Object.freeze(['RTX40', 'RTX50']);

function classifySeries(name) {
  const text = String(name || '');
  const match = text.match(/RTX\s*(20|30|40|50)\d{2}(?:\s|$|[^0-9])/i);
  return match ? `RTX${match[1]}` : null;
}

function classifyGpu(name) {
  const series = classifySeries(name);
  if (series === 'RTX50') return 'RTX50';
  if (['RTX20', 'RTX30', 'RTX40'].includes(series)) return 'RTX40';
  return null;
}

function payloadFamily(series) {
  if (series === 'RTX50') return 'RTX50';
  if (['RTX20', 'RTX30', 'RTX40'].includes(series)) return 'RTX40';
  return null;
}

// FG selection uses the physical generation, never the shared NR payload family.
function fgBackend(hardware) {
  const series = [...new Set(Array.isArray(hardware?.series) ? hardware.series : [])];
  if (hardware?.source === 'unavailable' || hardware?.family === 'mixed' || series.length !== 1) return null;
  return ['RTX20', 'RTX30'].includes(series[0]) ? 'dlssg-sm86' : series[0] === 'RTX40' ? 'mfgunlock' : series[0] === 'RTX50' ? 'nvidia' : null;
}

function detectGpu(options = {}) {
  const run = options.run || (() => execFileSync('powershell', [
    '-NoProfile', '-Command',
    'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }'
  ], { encoding: 'utf8', timeout: 8000, windowsHide: true }));
  let names = [];
  try {
    names = String(run()).split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  } catch {}
  const series = [...new Set(names.map(classifySeries).filter(Boolean))];
  const families = [...new Set(series.map(payloadFamily).filter(Boolean))];
  return {
    family: families.length === 1 ? families[0] : families.length > 1 ? 'mixed' : 'unknown',
    families,
    series,
    names,
    source: names.length ? 'Win32_VideoController' : 'unavailable',
    supported: families.length === 1
  };
}

let gpuInFlight = null;
function detectGpuAsync(options = {}) {
  if (!options.run && gpuInFlight) return gpuInFlight;
  const run = options.run || (() => new Promise((resolve, reject) => execFile('powershell', [
    '-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }'
  ], { encoding: 'utf8', timeout: 8000, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout))));
  const result = Promise.resolve().then(run).then(output => detectGpu({ run: () => output }), () => detectGpu({ run: () => '' }));
  if (!options.run) {
    gpuInFlight = result;
    void result.finally(() => { if (gpuInFlight === result) gpuInFlight = null; });
  }
  return result;
}

module.exports = { FAMILIES, classifyGpu, classifySeries, detectGpu, detectGpuAsync, fgBackend };
