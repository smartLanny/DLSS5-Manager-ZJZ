'use strict';

const { performance } = require('node:perf_hooks');

const SCHEMA_VERSION = 1;
const PHASES = Object.freeze(['identityPreflight', 'backupWrite', 'commit']);
const finiteMs = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Number(value.toFixed(3)) : null;

function createDeploymentTiming(operation = 'install', clock = performance) {
  const started = clock.now();
  const open = new Map();
  const values = new Map();
  const begin = phase => {
    if (!PHASES.includes(phase) || open.has(phase) || values.has(phase)) return;
    open.set(phase, clock.now());
  };
  const end = phase => {
    if (!open.has(phase) || values.has(phase)) return;
    values.set(phase, finiteMs(clock.now() - open.get(phase)));
    open.delete(phase);
  };
  const snapshot = () => {
    const now = clock.now();
    const phases = Object.fromEntries(PHASES.map(phase => [phase, values.has(phase)
      ? values.get(phase)
      : open.has(phase) ? finiteMs(now - open.get(phase)) : null]));
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      operation: typeof operation === 'string' && operation ? operation.slice(0, 32) : 'install',
      phases,
      totalMs: finiteMs(now - started)
    });
  };
  return Object.freeze({ begin, end, snapshot });
}

function validTiming(value) {
  return Boolean(value && value.schemaVersion === SCHEMA_VERSION && typeof value.operation === 'string' && value.operation.length <= 32 &&
    value.phases && typeof value.phases === 'object' && !Array.isArray(value.phases) &&
    PHASES.every(phase => value.phases[phase] === null || finiteMs(value.phases[phase]) !== null) &&
    finiteMs(value.totalMs) !== null);
}

function readDeploymentTiming(value) {
  if (!validTiming(value)) return null;
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, operation: value.operation,
    phases: Object.fromEntries(PHASES.map(phase => [phase, finiteMs(value.phases[phase])])), totalMs: finiteMs(value.totalMs) });
}

function attachDeploymentTiming(error, timing) {
  if (!error || typeof error !== 'object') return error;
  const current = error.details && typeof error.details === 'object' && !Array.isArray(error.details) ? error.details : {};
  error.details = { ...current, timings: timing.snapshot() };
  return error;
}

module.exports = { SCHEMA_VERSION, PHASES, createDeploymentTiming, readDeploymentTiming, attachDeploymentTiming };
