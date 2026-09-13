'use strict';

/**
 * Attach the compatibility-feedback surface to the existing renderer fixture.
 * Every method crosses an actual renderer -> main IPC boundary so the Electron
 * regression exercises the same async and context lifetime behavior as the
 * production preload bridge.
 */
function installCompatibilityFeedbackMock() {
  const { ipcRenderer } = require('electron');
  const clone = value => structuredClone(value);
  const mock = window.__compatMock = {
    calls: [],
    openCount: 0,
    previewCount: 0,
    saveCount: 0,
    closeCount: 0,
    discardCount: 0
  };
  const invoke = (action, ...args) => {
    mock.calls.push([action, ...clone(args)]);
    if (action === 'open') mock.openCount++;
    if (action === 'preview') mock.previewCount++;
    if (action === 'save') mock.saveCount++;
    if (action === 'close') mock.closeCount++;
    if (action === 'discard') mock.discardCount++;
    return ipcRenderer.invoke('compatibility-feedback-fixture', action, ...args);
  };
  window.manager.openCompatibilityFeedback = id => invoke('open', id);
  window.manager.previewCompatibilityFeedback = (token, request) => invoke('preview', token, request);
  window.manager.saveCompatibilityFeedback = (token, request) => invoke('save', token, request);
  window.manager.discardCompatibilityFeedback = (token, previewId) => invoke('discard', token, previewId);
  window.manager.closeCompatibilityFeedback = token => invoke('close', token);
}

module.exports = { installCompatibilityFeedbackMock };

async function smokeCompatibilityNormal({ leaveSurveyOpen = true } = {}) {
  const mock = window.__gpMock, feedback = window.__compatMock;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let assertions = 0;
  const assert = (value, message) => { assertions++; if (!value) throw Error(message); };
  const until = async (predicate, label, timeout = 7000) => {
    const start = performance.now();
    while (performance.now() - start < timeout) { if (predicate()) return; await delay(20); }
    throw Error('compatibility normal UI timeout: ' + label);
  };
  const card = id => document.querySelector(`.game-card[data-id="${id}"]`);
  const host = () => document.querySelector('.game-card.expanded .game-detail.gp-inline');
  const controller = () => host()?.__gpController;
  const openCard = async id => {
    const button = card(id)?.querySelector('.open-game-page-btn');
    assert(button, 'normal card can open: ' + id); button.click();
    await delay(30);
    if (!card(id)?.classList.contains('expanded')) card(id)?.querySelector('.open-game-page-btn')?.click();
    try { await until(() => host()?.dataset.gameDetail === id && host()?.querySelector('.cx-panel'), 'normal card ' + id); }
    catch (error) { throw Error(error.message + ' [cards=' + [...document.querySelectorAll('.game-card')].map(row => `${row.dataset.id}:${row.classList.contains('expanded')}:${Boolean(row.querySelector('.cx-panel'))}`).join(',') + ']'); }
    await until(() => controller()?.getState().loaded.includes('installation'), 'normal installation ' + id);
  };
  const feedbackButton = () => host()?.querySelector('.cx-panel .cx-actions button:last-child');
  const dialog = () => document.querySelector('.cx-dialog[open]') || document.querySelector('.cx-dialog');
  const choose = (name, value) => {
    const input = dialog()?.querySelector(`[name="${name}"][value="${value}"]`);
    assert(input, 'feedback choice exists: ' + name + '=' + value); input.click();
  };
  const fillSurvey = () => {
    choose('playability', 'normal'); choose('image', 'artifacts'); choose('fluidity', 'acceptable');
    const tag = dialog().querySelector('[name="tags"][value="flicker"]'); assert(tag, 'artifact tag exists'); tag.click();
    const note = dialog().querySelector('.cx-note'); note.value = '后台核对期间保留了这段反馈草稿。';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    const logs = dialog().querySelector('[name="includeLogs"]'); assert(logs && !logs.checked, 'diagnostic logs are off by default');
  };
  const preview = async () => {
    const button = dialog()?.querySelector('.cx-footer .cx-primary'); assert(button, 'feedback preview button exists'); button.click();
    await until(() => dialog()?.querySelector('.cx-summary'), 'feedback preview');
    return dialog();
  };
  const save = async () => {
    const button = dialog()?.querySelector('.cx-footer .cx-primary'); assert(button, 'feedback save button exists'); button.click();
    await until(() => !dialog()?.open && host()?.querySelector('.cx-notice')?.textContent.includes('已保存'), 'feedback save');
  };

  await until(() => card('fixture')?.querySelector('.open-game-page-btn'), 'normal library');
  await openCard('fixture');
  assert(host().querySelectorAll('.cx-panel .cx-actions .cx-button').length === 1, 'normal page has one feedback operation');

  const enhance = host().querySelector('[data-gp-tab="enhance"]'); assert(enhance, 'normal enhancement tab exists'); enhance.click();
  await until(() => controller().getState().loaded.includes('enhancements'), 'normal enhancements');
  controller().selectTab('overview'); await until(() => host().querySelector('[data-gp-field="Intensity"]'), 'normal NR overview');
  const intensity = host().querySelector('[data-gp-field="Intensity"]'); assert(intensity, 'NR intensity exists: ' + host().textContent.slice(0, 500));
  intensity.focus(); intensity.value = '0.75'; intensity.dispatchEvent(new Event('input', { bubbles: true }));
  await until(() => controller().getState().draft.nr?.Intensity === .75, 'NR draft');
  assert(host().querySelector('.gp-nr-primary [data-gp-field="Style"]'), 'style control moved into the primary NR controls');
  assert(host().querySelector('.gp-nr-details .gp-controls [data-gp-field="LocalToneStrength"]') &&
    host().querySelector('.gp-nr-details .gp-controls [data-gp-field="LocalStructureStrength"]'), 'secondary NR controls moved into details: primary=' + host().querySelector('.gp-nr-primary')?.textContent + ' details=' + host().querySelector('.gp-nr-details')?.textContent);
  const movedStrength = host().querySelector('[data-gp-field="LocalToneStrength"]'); movedStrength.value = '1.2'; movedStrength.dispatchEvent(new Event('input', { bubbles: true }));
  assert(controller().getState().draft.nr?.LocalToneStrength === 1.2, 'moved NR control keeps its delegated input event');
  assert(host().closest('.game-card').querySelectorAll('.button.primary').length === 1, 'dirty normal card exposes one primary operation');
  mock.delays['fixture:installation'] = 100;
  const focusedKey = intensity.dataset.gpField, refresh = controller().refresh(true);
  await delay(20); await refresh;
  await until(() => controller().getState().draft.nr?.Intensity === .75, 'draft after background refresh');
  assert(host().querySelector(`[data-gp-field="${focusedKey}"]`)?.value === '0.75' && document.activeElement?.dataset.gpField === focusedKey,
    'moved NR control keeps its value and focus after async refresh');

  // Exercise the feedback dialog while the real GamePageUi is rendering the
  // same host, including a background assessment refresh.
  feedbackButton().click(); await until(() => dialog()?.open, 'normal feedback dialog');
  assert(document.activeElement?.tagName === 'H2', 'feedback dialog puts focus on its heading'); fillSurvey();
  const note = dialog().querySelector('.cx-note'); mock.delays['fixture:installation'] = 90;
  const feedbackRefresh = controller().refresh(true); await delay(20); assert(dialog().querySelector('.cx-note').value === note.value, 'background refresh does not replace feedback draft');
  await feedbackRefresh; assert(dialog().querySelector('.cx-note').value === note.value, 'feedback draft survives completed background refresh');
  const firstPreview = await preview();
  const call = feedback.calls.at(-1); assert(call?.[0] === 'preview' && call[2]?.ratings?.playability === 'normal' && call[2]?.ratings?.image === 'artifacts' && call[2]?.ratings?.fluidity === 'acceptable' && call[2]?.includeLogs === false,
    'three ratings and default log choice cross the feedback IPC boundary');
  assert(firstPreview.textContent.includes('normal-package'), 'normal preview is bound to the normal package context');
  const oldToken = call[1]; await save(); assert(feedback.saveCount === 1, 'feedback save stub runs once after preview');

  // A second dialog is cancelled without a preview; it must not mutate the
  // main process and its opener remains usable.
  const beforeCancel = feedback.previewCount; feedbackButton().click(); await until(() => dialog()?.open, 'normal cancel dialog');
  dialog().querySelector('.cx-footer .cx-quiet').click(); await until(() => !dialog()?.open, 'normal feedback cancel');
  assert(feedback.previewCount === beforeCancel, 'feedback cancel does not create a preview');

  // Changing the selected EXE makes renderer.js dispose the cached controller.
  feedbackButton().click(); await until(() => dialog()?.open, 'normal EXE dialog'); fillSurvey(); await preview();
  const exeToken = feedback.calls.at(-1)[1]; mock.assessment.game.chosen.path = 'C:\\UI-fixture\\Baldurs Gate 3\\bin\\bg3_dx12.exe';
  document.getElementById('refreshBtn').click();
  await until(() => card('fixture')?.querySelector('.game-exe-path')?.textContent.includes('bg3_dx12.exe'), 'normal EXE refresh');
  await until(() => !dialog()?.open, 'normal EXE closes feedback');
  assert(feedback.calls.some(row => row[0] === 'close' && row[1] === exeToken), 'EXE identity change closes the old feedback context');
  mock.assessment.game.chosen.path = 'C:\\UI-fixture\\Baldurs Gate 3\\bin\\bg3_dx11.exe';
  document.getElementById('refreshBtn').click(); await until(() => card('fixture')?.querySelector('.game-exe-path')?.textContent.includes('bg3_dx11.exe'), 'normal EXE restore'); await delay(120);
  await openCard('fixture');

  // Explicit disposal is used by the real renderer when a cached editor is
  // permanently replaced. A live preview must close before the host goes
  // away, with no chance to save into a later game package.
  const doomedHost = document.createElement('div'); doomedHost.className = 'compatibility-dispose-fixture'; document.body.append(doomedHost);
  const doomedController = window.GamePageUi.mount(doomedHost, window.manager);
  await doomedController.open('fixture-two', 'overview');
  await until(() => doomedHost.querySelector('.cx-panel'), 'disposed controller panel');
  const doomedButton = doomedHost.querySelector('.cx-panel .cx-actions button:last-child'); assert(doomedButton && !doomedButton.disabled, 'disposed controller feedback button exists and is enabled: ' + doomedHost.textContent); doomedButton.click();
  try { await until(() => dialog()?.open, 'disposed controller dialog'); }
  catch (error) { throw Error(error.message + ' [doomed=' + doomedHost.innerHTML.slice(0, 1000) + ' dialogs=' + [...document.querySelectorAll('.cx-dialog')].map(row => row.open).join(',') + ']'); }
  fillSurvey(); await preview();
  const doomedToken = feedback.calls.at(-1)[1]; doomedController.dispose(); await until(() => !dialog()?.open, 'disposed controller closes feedback');
  assert(feedback.calls.some(row => row[0] === 'close' && row[1] === doomedToken), 'disposing a controller closes its feedback context');
  doomedHost.remove();

  const idleCalls = mock.calls.length + feedback.calls.length; await delay(1200);
  assert(mock.calls.length + feedback.calls.length === idleCalls, 'idle normal page does not poll or mutate');
  assert(document.querySelectorAll('.cx-dialog').length === 1 && host().querySelectorAll('.cx-panel').length === 1, 'normal page owns one feedback panel and one dialog');

  if (leaveSurveyOpen) {
    feedbackButton().click(); await until(() => dialog()?.open, 'normal final survey');
    const primary = dialog().querySelector('.cx-footer .cx-primary'), rect = primary?.getBoundingClientRect();
    assert(primary && rect.top >= 0 && rect.bottom <= innerHeight + 1, 'narrow feedback dialog keeps its primary button reachable');
  }
  return { scope: 'production renderer + GamePageUi + feedback IPC', assertions, feedbackCalls: feedback.calls.length, previews: feedback.previewCount, saves: feedback.saveCount };
}

async function smokeCompatibilityHoyo({ leaveSurveyOpen = true } = {}) {
  const mock = window.__hoyoMock, feedback = window.__compatMock;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let assertions = 0;
  const assert = (value, message) => { assertions++; if (!value) throw Error(message); };
  const until = async (predicate, label, timeout = 7000) => {
    const start = performance.now();
    while (performance.now() - start < timeout) { if (predicate()) return; await delay(20); }
    throw Error('compatibility HoYo UI timeout: ' + label);
  };
  const workspace = () => document.getElementById('hoyoWorkspace');
  const card = id => workspace()?.querySelector(`[data-hoyo-card="${id}"]`);
  const settings = () => workspace()?.querySelector('.hoyo-settings-host');
  const feedbackHost = () => workspace()?.querySelector('.hoyo-current');
  const feedbackButton = () => feedbackHost()?.querySelector('.cx-panel .cx-actions button:last-child');
  const dialog = () => document.querySelector('.cx-dialog[open]') || document.querySelector('.cx-dialog');
  const choose = (name, value) => { const input = dialog()?.querySelector(`[name="${name}"][value="${value}"]`); assert(input, 'HoYo feedback choice exists'); input.click(); };
  const fill = () => {
    choose('playability', 'normal'); choose('image', 'improved'); choose('fluidity', 'smooth');
    const note = dialog().querySelector('.cx-note'); note.value = 'HoYo 客户端反馈草稿'; note.dispatchEvent(new Event('input', { bubbles: true }));
    assert(!dialog().querySelector('[name="includeLogs"]').checked, 'HoYo diagnostic logs are off by default');
  };
  const openCard = async id => { const toggle = card(id)?.querySelector(`[data-hoyo-toggle="${id}"]`); assert(toggle, 'HoYo client toggle exists'); toggle.click(); await until(() => card(id)?.classList.contains('expanded'), 'HoYo client ' + id); };
  const controller = () => settings()?.__gpController;
  await until(() => card('client-one')?.classList.contains('expanded') && feedbackHost()?.querySelector('.cx-panel') && settings(), 'HoYo production settings');
  assert(settings().querySelectorAll('[role="tab"]').length === 2 && !settings().querySelector('[data-gp-action="launch"]'), 'HoYo reuses the two-tab GamePageUi editor without a second launch action');
  assert(!settings().querySelector('.cx-panel') && feedbackHost()?.querySelectorAll('.cx-panel').length === 1 && feedbackHost()?.querySelectorAll('.cx-panel .cx-actions .cx-button').length === 1, 'HoYo outer workflow owns one feedback operation');
  const intensity = settings().querySelector('[data-gp-field="Intensity"]'); assert(intensity, 'HoYo NR intensity exists'); intensity.focus();
  intensity.value = '0.8'; intensity.dispatchEvent(new Event('input', { bubbles: true }));
  await until(() => controller().getState().draft.nr?.Intensity === .8, 'HoYo NR draft');
  controller().refresh(true); await delay(80);
  assert(settings().querySelector('[data-gp-field="Intensity"]')?.value === '0.8' && document.activeElement?.dataset.gpField === 'Intensity', 'HoYo control value and focus survive async refresh');
  feedbackButton().click(); await until(() => dialog()?.open, 'HoYo feedback dialog'); fill();
  const note = dialog().querySelector('.cx-note').value; controller().refresh(true); await delay(30);
  assert(dialog().querySelector('.cx-note').value === note, 'HoYo background refresh does not replace feedback draft');
  await delay(100); const previewButton = dialog().querySelector('.cx-footer .cx-primary'); assert(previewButton, 'HoYo feedback preview button exists'); previewButton.click();
  await until(() => dialog()?.querySelector('.cx-summary'), 'HoYo feedback preview');
  const previewCall = feedback.calls.at(-1); assert(previewCall?.[0] === 'preview' && previewCall[2]?.ratings?.image === 'improved' && previewCall[2]?.includeLogs === false, 'HoYo feedback crosses the IPC boundary with all ratings');
  assert(dialog().textContent.includes('hoyo-package'), 'HoYo preview is bound to the independent package context');
  const token = previewCall[1];
  dialog().querySelector('.cx-footer .cx-primary').click(); await until(() => !dialog()?.open, 'HoYo feedback save');
  assert(feedback.saveCount >= 1, 'HoYo feedback save stub runs');

  // Switching the independent client tears down the old editor host. Its
  // cached controller remains reusable, but its feedback token cannot live on.
  feedbackButton().click(); await until(() => dialog()?.open, 'HoYo switch dialog'); fill();
  dialog().querySelector('.cx-footer .cx-primary').click(); await until(() => dialog()?.querySelector('.cx-summary'), 'HoYo switch preview');
  const switchToken = feedback.calls.at(-1)[1];
  await openCard('client-two'); await until(() => !dialog()?.open, 'HoYo switch closes feedback');
  assert(feedback.calls.some(row => row[0] === 'close' && row[1] === switchToken), 'HoYo client switch closes the old feedback context');
  const stale = await window.manager.previewCompatibilityFeedback(switchToken, { ratings: {}, includeLogs: false });
  assert(stale?.ok === false, 'HoYo old token cannot cross clients');
  await openCard('client-one'); await until(() => feedbackHost()?.querySelector('.cx-panel') && settings(), 'HoYo first client reattach');
  const idle = mock.calls.length + feedback.calls.length; await delay(1200); assert(mock.calls.length + feedback.calls.length === idle, 'idle HoYo ready page does not poll');
  assert(workspace().querySelectorAll('.game-card.expanded').length === 1 && workspace().querySelectorAll('.cx-panel').length === 1, 'HoYo keeps one selected card and one feedback panel');
  if (leaveSurveyOpen) {
    feedbackButton().click(); await until(() => dialog()?.open, 'HoYo final survey');
    const primary = dialog().querySelector('.cx-footer .cx-primary'), rect = primary?.getBoundingClientRect();
    assert(primary && rect.top >= 0 && rect.bottom <= innerHeight + 1, 'narrow HoYo feedback dialog keeps its primary button reachable');
  }
  return { scope: 'production renderer + HoYoPageUi + shared GamePageUi + feedback IPC', assertions, feedbackCalls: feedback.calls.length, previews: feedback.previewCount, saves: feedback.saveCount };
}

async function smokeCompatibilityHoyoUnready() {
  const mock = window.__hoyoMock;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let assertions = 0;
  const assert = (value, message) => { assertions++; if (!value) throw Error(message); };
  const until = async (predicate, label, timeout = 7000) => {
    const start = performance.now();
    while (performance.now() - start < timeout) { if (predicate()) return; await delay(20); }
    throw Error('compatibility HoYo unready UI timeout: ' + label);
  };
  const workspace = () => document.getElementById('hoyoWorkspace');
  const current = () => workspace()?.querySelector('.hoyo-current');
  const panel = () => current()?.querySelector('.cx-panel');
  const report = () => panel()?.querySelector('.cx-actions button:last-child');
  await until(() => document.querySelector('[data-view="hoyo"]'), 'HoYo navigation');
  document.querySelector('[data-view="hoyo"]').click();
  await until(() => panel() && report(), 'uninstalled HoYo feedback entry');
  assert(!workspace().querySelector('.hoyo-settings-host') && !report().disabled, 'uninstalled HoYo client exposes feedback before installation');
  report().click(); await until(() => document.querySelector('.cx-dialog[open]'), 'uninstalled HoYo feedback dialog');
  document.querySelector('.cx-dialog[open] .cx-footer .cx-quiet').click(); await until(() => !document.querySelector('.cx-dialog[open]'), 'uninstalled HoYo feedback cancel');
  mock.flow.phase = 'failed'; mock.flow.nextAction = 'inspect'; mock.flow.error = { code: 'FIXTURE_FAILED', message: '受控失败状态' };
  const inspect = current()?.querySelector('[data-hoyo-action="inspect"]'); assert(inspect && !inspect.disabled, 'failed HoYo client exposes recheck'); inspect.click();
  await until(() => current()?.querySelector('.cx-panel') && current()?.querySelector('.cx-panel .cx-status')?.textContent.includes('遇到问题'), 'failed HoYo feedback entry');
  assert(!current().querySelector('.hoyo-settings-host') && !current().querySelector('.cx-panel .cx-actions button:last-child').disabled, 'failed HoYo client keeps feedback reachable');
  mock.flow.phase = 'binding'; mock.flow.nextAction = 'bind'; mock.flow.error = null;
  current()?.querySelector('[data-hoyo-action="inspect"]')?.click();
  await until(() => current()?.querySelector('[data-hoyo-action="bind"]'), 'reset HoYo binding state');
  return { scope: 'production HoYo outer feedback before install and during failure', assertions };
}

module.exports.smokeCompatibilityNormal = smokeCompatibilityNormal;
module.exports.smokeCompatibilityHoyo = smokeCompatibilityHoyo;
module.exports.smokeCompatibilityHoyoUnready = smokeCompatibilityHoyoUnready;
