'use strict';
async function smokeVersionContract() {
  const mock = window.__gpMock, delay = ms => new Promise(resolve => setTimeout(resolve, ms)); let assertions = 0;
  const assert = (value, message) => { assertions++; if (!value) throw Error(message); };
  const until = async (condition, message) => { for (let n = 0; n < 250; n++) { if (condition()) return; await delay(20); } throw Error(message); };
  const host = () => document.querySelector('.game-card.expanded .game-detail'), button = action => host().querySelector(`[data-gp-action="${action}"]`);
  const field = (group, key) => host().querySelector(`[data-gp-group="${group}"][data-gp-field="${key}"]`);
  const click = action => { const node = button(action); assert(node && !node.disabled, `action available: ${action}`); node.click(); };
  const set = (group, key, value) => { const node = field(group, key); assert(node && !node.disabled, `field available: ${group}.${key}`); node.value = value; node.dispatchEvent(new Event(['range', 'number'].includes(node.type) ? 'input' : 'change', { bubbles: true })); };
  const preview = async (action = 'preview') => { click(button(action) ? action : 'prepare'); await until(() => button('modal-apply'), 'preview did not open'); return mock.plan.request; };
  const reset = async (name, change) => {
    if (button('modal-cancel')) click('modal-cancel'); if (button('discard')) click('discard');
    mock.assessment = structuredClone(mock.baseline); mock.assessment.game.name = name; change(mock.assessment);
    host().querySelector('[data-gp-tab="overview"]').click(); click('refresh');
    await until(() => host().__gpController.getState().data.game.name === name && !host().__gpController.getState().busy, 'scenario refresh did not complete');
  };
  await until(() => document.querySelector('.game-card[data-id="fixture"] .open-game-page-btn'), 'library missing');
  document.querySelector('.game-card[data-id="fixture"] .open-game-page-btn').click();
  await until(() => host()?.__gpController.getState().loaded.includes('installation'), 'installation assessment missing');
  for (const id of ['0.5-dline13', '0.4.7beta-corefix.8']) {
    const candidate = host().querySelector('[data-gp-detail="rollback"] option[value="' + id + '"]');
    assert(candidate && !candidate.disabled, id + ' core-update candidate is visible and selectable in the advanced rollback selector');
  }
  const fresh = value => { value.game.installed = false; value.defaults.version = 'fixture-core-alternative'; };
  await reset('first install with a legal old global default', fresh);
  assert(field('route', 'version').value === '0.4.7beta' && mock.assessment.defaults.version === 'fixture-core-alternative', 'new installation displays current Core despite a legal older default');
  assert((await preview('prepare')).version === '0.4.7beta', 'first Prepare submits exactly the displayed Core');
  await reset('first API selection with old global default', fresh); set('route', 'api', 'dx12');
  assert((await preview()).version === field('route', 'version').value && mock.plan.request.version === '0.4.7beta', 'first API change submits the same displayed Core');
  await reset('first loading route with old global default', fresh); set('route', 'deployment', 'external');
  assert((await preview()).version === '0.4.7beta' && mock.plan.request.deployment === 'external', 'first loading route change also binds the displayed Core');
  await reset('explicit user version takes priority', fresh); const rollback = host().querySelector('[data-gp-detail="rollback"] select'); rollback.value = 'fixture-core-alternative'; rollback.dispatchEvent(new Event('change', { bubbles: true }));
  assert((await preview()).version === 'fixture-core-alternative', 'explicit user Core takes precedence over the recommendation');
  const pinned = value => { value.game.addonVersion = value.deployment.version = 'fixture-core-alternative'; value.defaults.version = '0.4.7beta'; };
  await reset('existing pinned Core', pinned); assert(field('route', 'version').value === 'fixture-core-alternative', 'installed pin remains displayed'); set('route', 'api', 'dx12');
  assert((await preview()).version === 'fixture-core-alternative', 'installation-related edits preserve an installed pin');
  await reset('pure NR edit', pinned); host().querySelector('[data-gp-tab="nr"]').click(); set('nr', 'Intensity', '0.75');
  assert(JSON.stringify(await preview()) === JSON.stringify({ nr: { Intensity: .75 } }), 'pure NR edit contains no version or install request');
  await reset('pure hotkey edit', pinned); click('capture-hotkey');
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Insert', code: 'Insert', keyCode: 45, bubbles: true, cancelable: true }));
  assert(JSON.stringify(await preview()) === JSON.stringify({ hotkeys: { reshade: { key: 45, ctrl: false, shift: false, alt: false } } }), 'pure hotkey edit contains no version or install request');
  for (const route of ['feeder', 'vulkan']) {
    const packageId = `fixed-${route}-package`;
    await reset(`${route} package identity`, value => { fresh(value); const api = route === 'feeder' ? 'dx12' : 'vulkan'; value.game.chosen.apiResolution.api = value.api.effectiveApi = api;
      value.game.nativeDlssAvailable = route !== 'feeder'; value.layout.source = route; value.game[route] = { installed: false, available: true, packageId, coreVersion: '0.4.7beta' }; });
    assert(field('route', 'version').value === packageId && field('route', 'version').disabled, 'fixed route displays its package identity');
    const request = await preview('prepare'); assert(request.route === route && request.version === packageId && request.version !== '0.4.7beta', 'fixed route submits its package, never a native Core identity');
  }
  click('modal-cancel');
  assert(!mock.calls.some(row => row[0] === 'apply'), 'all version contract checks remain previews without mutations');
  return { scope: 'production renderer plus deterministic IPC; focused Core display/request contract', assertions, previews: mock.calls.filter(row => row[0] === 'preview').length, applies: 0 };
}
module.exports = { smokeVersionContract };
