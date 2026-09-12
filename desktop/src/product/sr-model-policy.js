'use strict';

const CHOICES = Object.freeze(['auto', 'm', 'l', 'k', 'default']);
const PRESET_VALUES = Object.freeze({ k: 11, l: 12, m: 13 });

function normalizeChoice(value) {
  const choice = String(value || '').trim().toLowerCase();
  return CHOICES.includes(choice) ? choice : 'auto';
}

function hardwareSeries(hardware) {
  return [...new Set((hardware && Array.isArray(hardware.series) ? hardware.series : [])
    .filter(value => ['RTX20', 'RTX30', 'RTX40', 'RTX50'].includes(value)))];
}

function recommendSrPreset(hardware) {
  const series = hardwareSeries(hardware);
  if (!hardware || hardware.family === 'mixed' || series.length !== 1) return 'default';
  if (series[0] === 'RTX40' || series[0] === 'RTX50') return 'm';
  if (series[0] === 'RTX20' || series[0] === 'RTX30') return 'k';
  return 'default';
}

function effectiveSrPreset(choice, hardware) {
  const normalized = normalizeChoice(choice);
  return normalized === 'auto' ? recommendSrPreset(hardware) : normalized;
}

function hasFp8Penalty(hardware, preset) {
  const series = hardwareSeries(hardware);
  return (preset === 'm' || preset === 'l') &&
    series.length === 1 && (series[0] === 'RTX20' || series[0] === 'RTX30');
}

function presetValue(preset) {
  return PRESET_VALUES[String(preset || '').toLowerCase()] ?? null;
}

module.exports = {
  CHOICES,
  PRESET_VALUES,
  normalizeChoice,
  hardwareSeries,
  recommendSrPreset,
  effectiveSrPreset,
  hasFp8Penalty,
  presetValue
};
