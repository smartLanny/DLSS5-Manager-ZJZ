'use strict';

// Public INI names and value contracts only. Core implementation is not bundled.
// Uniform model defaults were checked against the delivered 7a90660b manifest.
const UNIFORM_SOURCE = '7a90660bc468ca86a02abe2e145638b51489d549';
const catalog = require('../shared/core-catalog');
const COLOUR_CONTRACT = 'nr-uniform-colour-v2';
const COLOUR_KEYS = ['ColourLabMode', 'AllowUnverifiedHdrColor', 'ColourPriorityStrength', 'ColourConservativeStrength'];
const RECONSTRUCTION_KEYS = ['ReconstructionMode', 'NearBlackChromaGuard'];
const MODEL_DEFAULTS = Object.freeze({ Intensity: 1.5, LocalToneStrength: 1, LocalStructureStrength: 1,
  SkinStructureStrength: 0.4, AutoMask: 1, Style: 0, UICorrection: 1 });
const LEGACY_DEFAULTS = Object.freeze({ Enabled: 1, Mode: 2, Intensity: 1, WorkMode: 0, CustomWorkScale: 1,
  Style: 0, AutoMask: 0, ColorStrength: 0.75, SkinStructureStrength: -1, LocalToneStrength: 1,
  LocalStructureStrength: 1, TransferStrength: 1, PostTransferStrength: 1, UICorrection: 0 });
const LEGACY_KEYS = Object.freeze(Object.keys(LEGACY_DEFAULTS));
// Defaults/ranges checked against the exact 41288a8a and 7abd2356 INI/source.
const HISTORY_037_SOURCE = '41288a8a30f812361b0af09d827249be70adc512';
const D13_SOURCE = '7abd23569d0a64691caa8cd9adcff3596d6a04a9';
const DUAL_KEYS = ['NRPasses', 'NRSecondScaleNumerator', 'NRSecondScaleDenominator'];
const HISTORY_037_DEFAULTS = Object.freeze(Object.fromEntries(Object.entries({ ...LEGACY_DEFAULTS,
  TransferStrength: 1.2, PostTransferStrength: 1.2, ColorStrength: .5 }).filter(([key]) => !['WorkMode', 'CustomWorkScale'].includes(key))));
const D13_DEFAULTS = Object.freeze({ ...LEGACY_DEFAULTS, Intensity: 1.2, ColorStrength: 1,
  NRPasses: 1, NRSecondScaleNumerator: 1, NRSecondScaleDenominator: 2 });
const fields = {};
function number(key, value, min, max, type = 'float', extra = {}) { fields[key] = { type, default: value, min, max, ...extra }; }
function flag(key, value) { number(key, value, 0, 1, 'boolean'); }
flag('Enabled', 1); number('Mode', 2, 1, 2, 'integer');
for (const [key, value] of Object.entries(MODEL_DEFAULTS)) {
  if (['AutoMask', 'UICorrection'].includes(key)) flag(key, value);
  else number(key, value, key === 'SkinStructureStrength' ? -1 : 0, 2, key === 'Style' ? 'integer' : 'float');
}
number('WorkMode', 0, 0, 5, 'integer', { strict: true });
number('CustomWorkScale', 1, 0.5, 1, 'float', { strict: true, special: [0] });
number('TransferStrength', 1, 1, 4); number('PostTransferStrength', 1, 1, 4);
number('ColorStrength', 1, 0, 2);
number('ColourLabMode', 2, 0, 2, 'integer'); flag('AllowUnverifiedHdrColor', 0);
number('ColourPriorityStrength', .7, 0, 2); number('ColourConservativeStrength', 1, 0, 2);
// Output-only 0.5.1 options: 1 = balanced, 2 = fine; Core reads any other value as off.
number('ReconstructionMode', 0, 0, 2, 'integer'); flag('NearBlackChromaGuard', 0);
fields.ProcessingStart = { type: 'enum', values: ['Before', 'After', 'Present'], default: 'Before' };
number('CompatPostPercent', 100, 50, 100, 'integer');
number('PostWorkPercent', 100, 50, 100, 'integer', { special: [0] });
number('NRInputFilter', 0, 0, 1, 'integer');
for (const key of ['LightingLock', 'EdgeGuard', 'DetailStability']) number(key, 0, 0, 1);
for (const key of ['HighStrengthProtection', 'ColorProtection']) flag(key, 1);
number('LightControlMode', 1, 0, 1, 'integer');
for (const key of ['LightBroad', 'LightDark', 'LightReflection', 'LightStructure']) number(key, 1, 0, 2);
number('LightGlow', 0, 0, 1); number('LightPreset', 0, 0, 3, 'integer');
number('LightPresetColor', 1, 0, 2); number('LightStyleVersion', 1, 0, 1, 'integer');
for (let layer = 2; layer <= 5; layer++) {
  flag(`Layer${layer}Enabled`, 0); flag(`Layer${layer}Configured`, 0);
  for (const key of Object.keys(MODEL_DEFAULTS)) fields[`Layer${layer}${key}`] = { ...fields[key], layer };
}
number('UniformChainVersion', 1, 1, 1, 'integer'); flag('UniformChainMigrated', 0);
// Compatibility metadata published together with the concrete values it owns.
number('ConfigVersion', 4, 4, 4, 'integer'); number('StrengthConfigVersion', 1, 1, 1, 'integer');
number('ExtraStrengthPolicyVersion', 1, 1, 1, 'integer');
number('NRPasses', 1, 1, 2, 'integer');
number('NRSecondScaleNumerator', 1, 1, 10000, 'integer');
number('NRSecondScaleDenominator', 2, 1, 10000, 'integer');
const FIELD_DEFINITIONS = Object.freeze(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, Object.freeze(value)])));
const PUBLIC_NR_KEYS = Object.freeze(Object.keys(FIELD_DEFINITIONS));

function resolveContract(input = '') {
  const descriptor = typeof input === 'string' ? { version: input } : input && typeof input === 'object' ? input : {};
  const version = String(descriptor.version || descriptor.id || '');
  const schema = descriptor.configContract || descriptor.contract || descriptor.schema || descriptor.id;
  const source = descriptor.sourceCommit || descriptor.source_commit || descriptor.commit || '';
  const explicitlyUnknown = schema === 'unknown' || descriptor.known === false;
  const legacy037 = !explicitlyUnknown && (schema === 'nr-037' || source === HISTORY_037_SOURCE || /^(?:beta)?0\.3\.7$/.test(version));
  const dualLayer = !explicitlyUnknown && (schema === 'nr-dline13' || source === D13_SOURCE || /^(?:beta)?0\.5-dline13$/.test(version));
  const colourMemory = !explicitlyUnknown && (schema === COLOUR_CONTRACT || catalog.sourceCommits(COLOUR_CONTRACT).includes(source));
  // Only the pinned source (resolved from exact Core bytes) grants these keys.
  const reconstruction = !explicitlyUnknown && Boolean(source) && catalog.CORES.some(row => row.reconstruction === true && row.sourceCommit === source);
  const uniform = !explicitlyUnknown && (colourMemory || ['uniform3', 'unified3', 'nr-uniform-v1'].includes(schema) ||
    source === UNIFORM_SOURCE || /(?:^|[-_.+])(?:uniform|unified)3(?:$|[-_.+])/i.test(version));
  const dline = !explicitlyUnknown && (uniform || dualLayer || /(?:^|[-+])(?:beta)?0\.5(?:$|[-.+]|beta|d\d)/i.test(version));
  const beta = /^0\.4\.7(?:$|beta|[-.+])/i.test(version);
  const knownLegacy = !explicitlyUnknown && /^0\.[234](?:[.-]|$)/i.test(version);
  const known = uniform || dline || knownLegacy || legacy037;
  const uniformKeys = PUBLIC_NR_KEYS.filter(key => !DUAL_KEYS.includes(key) && (colourMemory || !COLOUR_KEYS.includes(key)) &&
    (reconstruction || !RECONSTRUCTION_KEYS.includes(key)));
  const defaults = uniform ? Object.fromEntries(uniformKeys.map(key => [key, FIELD_DEFINITIONS[key].default])) :
    dualLayer ? { ...D13_DEFAULTS } : legacy037 ? { ...HISTORY_037_DEFAULTS } :
    known ? { ...LEGACY_DEFAULTS, ...(dline || beta ? { Intensity: 1.2, ColorStrength: 1 } : {}) } : {};
  const keys = uniform ? uniformKeys : dualLayer ? Object.keys(D13_DEFAULTS) : legacy037 ? Object.keys(HISTORY_037_DEFAULTS) : LEGACY_KEYS;
  return { id: colourMemory ? COLOUR_CONTRACT : uniform ? 'nr-uniform-v1' : dualLayer ? 'nr-dline13' : legacy037 ? 'nr-037' : dline ? 'nr-dline' : knownLegacy ? 'nr-legacy' : 'unknown',
    version, sourceCommit: source || null, known, uniform, colourMemory, reconstruction: uniform && reconstruction, dline, dualLayer, legacy037, defaults, keys: [...keys],
    runtimeVerified: false, effectiveMeaning: 'configuration-at-startup' };
}

function definition(key, input = '') {
  const field = Object.hasOwn(FIELD_DEFINITIONS, key) ? FIELD_DEFINITIONS[key] : null; if (!field) return null;
  const contract = resolveContract(input);
  if (contract.legacy037 && ['TransferStrength', 'PostTransferStrength'].includes(key)) return { ...field, min: 0, max: 2 };
  if (contract.legacy037 && key === 'ColorStrength') return { ...field, min: 0, max: 1 };
  if (!contract.dline && ['TransferStrength', 'PostTransferStrength'].includes(key)) return { ...field, min: 0 };
  if (!contract.dline && key === 'CustomWorkScale') return { ...field, min: 0.25, special: [] };
  return field;
}

module.exports = { UNIFORM_SOURCE, MODEL_DEFAULTS, LEGACY_DEFAULTS, LEGACY_KEYS, FIELD_DEFINITIONS, PUBLIC_NR_KEYS, resolveContract, definition };
