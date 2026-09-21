'use strict';

// Public INI names and value contracts only. Core implementation is not bundled.
// Uniform model defaults were checked against the delivered 7a90660b manifest.
const UNIFORM_SOURCE = '7a90660bc468ca86a02abe2e145638b51489d549';
const unified5 = require('./unified5-core');
const COLOUR_KEYS = ['ColourLabMode', 'AllowUnverifiedHdrColor', 'ColourPriorityStrength', 'ColourConservativeStrength'];
const MODEL_DEFAULTS = Object.freeze({ Intensity: 1.5, LocalToneStrength: 1, LocalStructureStrength: 1,
  SkinStructureStrength: 0.4, AutoMask: 1, Style: 0, UICorrection: 1 });
const LEGACY_DEFAULTS = Object.freeze({ Enabled: 1, Mode: 2, Intensity: 1, WorkMode: 0, CustomWorkScale: 1,
  Style: 0, AutoMask: 0, ColorStrength: 0.75, SkinStructureStrength: -1, LocalToneStrength: 1,
  LocalStructureStrength: 1, TransferStrength: 1, PostTransferStrength: 1, UICorrection: 0 });
const LEGACY_KEYS = Object.freeze(Object.keys(LEGACY_DEFAULTS));
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
const FIELD_DEFINITIONS = Object.freeze(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, Object.freeze(value)])));
const PUBLIC_NR_KEYS = Object.freeze(Object.keys(FIELD_DEFINITIONS));

function resolveContract(input = '') {
  const descriptor = typeof input === 'string' ? { version: input } : input && typeof input === 'object' ? input : {};
  const version = String(descriptor.version || descriptor.id || '');
  const schema = descriptor.configContract || descriptor.contract || descriptor.schema || descriptor.id;
  const source = descriptor.sourceCommit || descriptor.source_commit || descriptor.commit || '';
  const explicitlyUnknown = schema === 'unknown' || descriptor.known === false;
  const colourMemory = !explicitlyUnknown && (schema === unified5.CONTRACT || source === unified5.SOURCE);
  const uniform = !explicitlyUnknown && (colourMemory || ['uniform3', 'unified3', 'nr-uniform-v1'].includes(schema) ||
    source === UNIFORM_SOURCE || /(?:^|[-_.+])(?:uniform|unified)3(?:$|[-_.+])/i.test(version));
  const dline = !explicitlyUnknown && (uniform || /(?:^|[-+])(?:beta)?0\.5(?:$|[-.+]|beta|d\d)/i.test(version));
  const beta = /^0\.4\.7(?:$|beta|[-.+])/i.test(version);
  const knownLegacy = !explicitlyUnknown && /^0\.[234](?:[.-]|$)/i.test(version);
  const known = uniform || dline || knownLegacy;
  const defaults = uniform ? Object.fromEntries(Object.entries(FIELD_DEFINITIONS).filter(([key]) => colourMemory || !COLOUR_KEYS.includes(key)).map(([key, row]) => [key, row.default])) :
    known ? { ...LEGACY_DEFAULTS, ...(dline || beta ? { Intensity: 1.2, ColorStrength: 1 } : {}) } : {};
  const keys = uniform ? PUBLIC_NR_KEYS.filter(key => colourMemory || !COLOUR_KEYS.includes(key)) : LEGACY_KEYS;
  return { id: colourMemory ? unified5.CONTRACT : uniform ? 'nr-uniform-v1' : dline ? 'nr-dline' : knownLegacy ? 'nr-legacy' : 'unknown',
    version, sourceCommit: source || null, known, uniform, colourMemory, dline, defaults, keys: [...keys],
    runtimeVerified: false, effectiveMeaning: 'configuration-at-startup' };
}

function definition(key, input = '') {
  const field = Object.hasOwn(FIELD_DEFINITIONS, key) ? FIELD_DEFINITIONS[key] : null; if (!field) return null;
  const contract = resolveContract(input);
  if (!contract.dline && ['TransferStrength', 'PostTransferStrength'].includes(key)) return { ...field, min: 0 };
  if (!contract.dline && key === 'CustomWorkScale') return { ...field, min: 0.25, special: [] };
  return field;
}

module.exports = { UNIFORM_SOURCE, MODEL_DEFAULTS, LEGACY_DEFAULTS, LEGACY_KEYS, FIELD_DEFINITIONS, PUBLIC_NR_KEYS, resolveContract, definition };
