'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');
const { DEFAULT_RESHADE_KEY, DEFAULT_RESHADE_BINDING, ensureDefaultReShadeHotkey, parseKeyOverlay, updateKeyOverlay, writeReShadeHotkey, readReShadeHotkey } = require('../src/product/hotkeys');

test('missing panel binding defaults to unmodified Home and generated INI reads it back', () => {
  assert.equal(DEFAULT_RESHADE_KEY, 36);
  assert.deepEqual(DEFAULT_RESHADE_BINDING, { key: 36, ctrl: false, shift: false, alt: false });
  for (const original of ['', '\ufeff; 原配置\r\n[GENERAL]\r\nPresetPath=User.ini\r\n', '[INPUT]\nKeyEffects=145,0,0,0\n']) {
    assert.deepEqual(parseKeyOverlay(original), { ...DEFAULT_RESHADE_BINDING, present: false });
    const generated = ensureDefaultReShadeHotkey(original);
    assert.match(generated, /KeyOverlay=36,0,0,0/);
    assert.deepEqual(parseKeyOverlay(generated), { ...DEFAULT_RESHADE_BINDING, present: true });
    assert.equal(ensureDefaultReShadeHotkey(generated), generated, 'default preparation is idempotent');
    assert.ok(generated.includes(original.trimEnd()), 'existing text is retained');
  }
});

test('default preparation preserves explicit custom, equals, Home and disabled panel bindings byte for byte', () => {
  for (const binding of ['36,0,0,0', '187,0,0,0', '120,1,0,1', '187,1,1,0', '0,0,0,0', '36']) {
    const original = `\ufeff; user\r\n[input]\r\n  keyoverlay = ${binding}\r\nKeyEffects=145,0,0,0\r\n`;
    assert.equal(ensureDefaultReShadeHotkey(original), original);
  }
});

test('historical default generation can reproduce equals without changing the new Home default', () => {
  const original = '; original\r\n[GENERAL]\r\nPresetPath=User.ini\r\n';
  assert.match(ensureDefaultReShadeHotkey(original, 187), /KeyOverlay=187,0,0,0/);
  assert.match(ensureDefaultReShadeHotkey(original), /KeyOverlay=36,0,0,0/);
});

test('reads ReShade Home shortcut and modifier order', () => {
  assert.deepEqual(parseKeyOverlay('[INPUT]\nKeyOverlay=36,0,0,0\n'), {
    key: 36, ctrl: false, shift: false, alt: false, present: true
  });
  assert.deepEqual(parseKeyOverlay('[INPUT]\nKeyOverlay=113,0,1,0\n'), {
    key: 113, ctrl: false, shift: true, alt: false, present: true
  });
});

test('updates only ReShade INPUT KeyOverlay', () => {
  const input = '; keep\n[OTHER]\nKeyOverlay=1\n[INPUT]\n; note\nKeyOverlay=36,0,0,0\n';
  const output = updateKeyOverlay(input, { key: 36, ctrl: true, shift: true, alt: false });
  assert.match(output, /\[OTHER\]\nKeyOverlay=1/);
  assert.match(output, /; note\nKeyOverlay=36,1,1,0/);
});

test('atomically writes a ReShade shortcut', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-hotkey-'));
  const file = path.join(dir, 'ReShade.ini');
  await writeReShadeHotkey(file, { key: 35, ctrl: false, shift: true, alt: true });
  assert.deepEqual(readReShadeHotkey(file), {
    key: 35, ctrl: false, shift: true, alt: true, present: true
  });
});

const symbolKeys = [
  ['Equal', 0xBB, '=', '＝', '+'], ['Semicolon', 0xBA, ';', '；', ':'], ['Quote', 0xDE, "'", '＇', '"'],
  ['BracketLeft', 0xDB, '[', '【', '{'], ['BracketRight', 0xDD, ']', '】', '}'], ['Minus', 0xBD, '-', '－', '_'],
  ['Backslash', 0xDC, '\\', '、', '|'], ['Comma', 0xBC, ',', '，', '<'], ['Period', 0xBE, '.', '。', '>'],
  ['Slash', 0xBF, '/', '？', '?'], ['Backquote', 0xC0, '`', '·', '~']
];

function rendererHotkeys() {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  const elements = { modalBody: { textContent: '' }, modalConfirm: { disabled: true } };
  const context = { state: { pendingModal: null }, $: id => elements[id], document: {
    addEventListener(type, handler) { if (type === 'keydown') context.capture = handler; }
  } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('const KEY_NAMES'), source.indexOf('function toast(')), context);
  vm.runInContext(source.slice(source.indexOf("document.addEventListener('keydown', event => {"), source.indexOf("$('modalConfirm').onclick = async")), context);
  return { context, elements };
}

test('symbol codes map to ReShade OEM keys independently of English, Chinese punctuation or IME text', () => {
  const { context } = rendererHotkeys();
  for (const [code, vk, symbol, chinese, shifted] of symbolKeys) for (const key of [symbol, shifted, chinese, 'Process']) for (const shiftKey of [false, true]) {
    const binding = context.keyBindingFromEvent({ code, key, shiftKey, ctrlKey: true, altKey: false });
    assert.deepEqual(JSON.parse(JSON.stringify(binding)), { key: vk, ctrl: true, shift: shiftKey, alt: false });
    assert.equal(context.hotkeyLabel(binding), `Ctrl+${shiftKey ? 'Shift+' : ''}${symbol}`);
  }
  assert.equal(context.keyBindingFromEvent({ code: 'Digit7', key: '＆' }).key, 55);
  assert.equal(context.keyBindingFromEvent({ code: 'KeyA', key: '啊' }).key, 65);
});

test('the actual modal capture saves symbol and Shift combinations as exact ReShade INI bytes and reads them back', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reshade-oem-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'ReShade.ini'), { context, elements } = rendererHotkeys();
  const input = '\ufeff; 保留用户配置\r\n[INPUT]\r\nKeyOverlay=36,0,0,0\r\nKeyEffects=145,0,0,0\r\n[GENERAL]\r\nTextureSearchPaths=.\\textures\r\n';
  for (const [code, vk, symbol, chinese, shifted] of symbolKeys) for (const english of [false, true]) for (const shiftKey of [false, true]) {
    const key = english ? shiftKey ? shifted : symbol : chinese;
    fs.writeFileSync(file, input, 'utf8');
    context.state.pendingModal = { type: 'hotkey', id: 'fixture', target: 'reshade', binding: null };
    elements.modalConfirm.disabled = true;
    let prevented = 0, stopped = 0;
    context.capture({ code, key, ctrlKey: true, shiftKey, altKey: true,
      preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
    assert.equal(prevented, 1); assert.equal(stopped, 1); assert.equal(elements.modalConfirm.disabled, false);
    assert.ok(elements.modalBody.textContent.includes(`Ctrl+${shiftKey ? 'Shift+' : ''}Alt+${symbol}`));
    const returned = await writeReShadeHotkey(file, context.state.pendingModal.binding);
    const expected = input.replace('KeyOverlay=36,0,0,0', `KeyOverlay=${vk},1,${shiftKey ? 1 : 0},1`);
    assert.deepEqual(fs.readFileSync(file), Buffer.from(expected, 'utf8'), `${code}: only the numeric KeyOverlay tuple changes`);
    assert.deepEqual(returned, { key: vk, ctrl: true, shift: shiftKey, alt: true, present: true });
    assert.deepEqual(readReShadeHotkey(file), returned);
    assert.equal(context.hotkeyLabel(returned), `Ctrl+${shiftKey ? 'Shift+' : ''}Alt+${symbol}`);
  }
});

test('capture does not guess a physical symbol key from layout text or modifier-only events', () => {
  const { context, elements } = rendererHotkeys();
  for (const code of ['', 'Unidentified', 'ShiftLeft', 'AltRight', 'ControlLeft', 'toString']) {
    context.state.pendingModal = { type: 'hotkey', binding: null };
    elements.modalConfirm.disabled = true;
    context.capture({ code, key: '=', shiftKey: true, preventDefault() { throw new Error('unexpected capture'); }, stopPropagation() {} });
    assert.equal(context.state.pendingModal.binding, null); assert.equal(elements.modalConfirm.disabled, true);
  }
});
