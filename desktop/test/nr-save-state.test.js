'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');

function fixture() {
  const timers = new Map(), writes = [], notices = [], indicators = new Map();
  let timerId = 0;
  const context = {
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    toast(message, error) { notices.push({ message, error }); },
    window: { manager: { writeNr(id, patch) {
      return new Promise(resolve => writes.push({ id, patch: JSON.parse(JSON.stringify(patch)),
        succeed: () => resolve({ ok: true, value: patch }),
        fail: message => resolve({ ok: false, error: { code: 'ERR_NO_WRITE_ACCESS', message } }) }));
    } } }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('const state ='), source.indexOf('function escapeHtml(')), context);
  vm.runInContext(source.slice(source.indexOf('function queueSetting('), source.indexOf('function bindNrControls(')), context);
  const state = vm.runInContext('state', context);
  function indicator(id) {
    if (!indicators.has(id)) {
      const classes = new Set();
      indicators.set(id, { textContent: '', classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) } });
    }
    return indicators.get(id);
  }
  function queue(id, patch) { context.queueSetting(id, patch, { querySelector: () => indicator(id) }); }
  function dispatch(id) {
    const key = state.saveTimers.get(id), callback = timers.get(key);
    assert.ok(callback, `game ${id} has a pending debounce`);
    timers.delete(key);
    const done = callback();
    return { ...writes.at(-1), done };
  }
  return { queue, dispatch, indicator, state, notices, writes, timers };
}

test('an old successful save cannot claim a newer debounced edit has been saved', async () => {
  const f = fixture();
  f.queue('a', { Intensity: 1.2 }); const first = f.dispatch('a');
  f.queue('a', { Intensity: 1.8 });
  first.succeed(); await first.done;
  assert.equal(f.indicator('a').textContent, '正在保存…');
  assert.equal(f.state.pendingPatches.get('a').Intensity, 1.8);
  assert.equal(f.writes.length, 1);
  const latest = f.dispatch('a'); latest.succeed(); await latest.done;
  assert.equal(f.indicator('a').textContent, '已保存');
  assert.deepEqual(f.writes.map(row => row.patch), [{ Intensity: 1.2 }, { Intensity: 1.8 }]);
});

test('an old failed save leaves the new status pending and still reports its different-field failure', async () => {
  const f = fixture();
  f.queue('a', { Intensity: 1.2 }); const first = f.dispatch('a');
  f.queue('a', { Style: 2 });
  first.fail('模型强度保存失败：没有目录写入权限。'); await first.done;
  assert.equal(f.indicator('a').textContent, '正在保存…');
  assert.equal(f.indicator('a').classList.contains('error'), false);
  assert.deepEqual(f.notices, [{ message: '模型强度保存失败：没有目录写入权限。', error: true }]);
  const latest = f.dispatch('a'); latest.succeed(); await latest.done;
  assert.deepEqual(latest.patch, { Style: 2 });
  assert.equal(f.indicator('a').textContent, '已保存');
  assert.equal(f.notices.length, 1, 'a different-field success does not replace the failure notice');
});

test('latest failure remains visible and a successful retry clears the error appearance', async () => {
  const f = fixture();
  f.queue('a', { AutoMask: 1 }); const failed = f.dispatch('a');
  failed.fail('皮肤结构保护保存失败。'); await failed.done;
  assert.equal(f.indicator('a').textContent, '保存失败');
  assert.equal(f.indicator('a').classList.contains('error'), true);
  f.queue('a', { AutoMask: 1 });
  assert.equal(f.indicator('a').classList.contains('error'), false);
  const retry = f.dispatch('a');
  f.indicator('a').classList.add('error');
  retry.succeed(); await retry.done;
  assert.equal(f.indicator('a').textContent, '已保存');
  assert.equal(f.indicator('a').classList.contains('error'), false, 'success itself removes any retained error appearance');
});

test('late outcomes cannot overwrite the latest completed status, but late failures still notify', async () => {
  for (const failOld of [false, true]) {
    const f = fixture();
    f.queue('a', { Intensity: 1.2 }); const first = f.dispatch('a');
    f.queue('a', { Style: 2 }); const latest = f.dispatch('a');
    latest.succeed(); await latest.done;
    if (failOld) first.fail('较早的模型设置保存失败。'); else first.succeed();
    await first.done;
    assert.equal(f.indicator('a').textContent, '已保存');
    assert.equal(f.indicator('a').classList.contains('error'), false);
    assert.equal(f.notices.length, failOld ? 1 : 0);
  }
});

test('save revisions are scoped to each game instead of suppressing other games', async () => {
  const f = fixture();
  f.queue('a', { Intensity: 1.2 }); const a = f.dispatch('a');
  f.queue('b', { Style: 1 }); f.queue('b', { AutoMask: 0 }); const b = f.dispatch('b');
  a.succeed(); await a.done;
  assert.equal(f.indicator('a').textContent, '已保存');
  assert.equal(f.indicator('b').textContent, '正在保存…');
  b.fail('另一游戏的设置保存失败。'); await b.done;
  assert.equal(f.indicator('a').textContent, '已保存');
  assert.equal(f.indicator('a').classList.contains('error'), false);
  assert.equal(f.indicator('b').textContent, '保存失败');
  assert.equal(f.indicator('b').classList.contains('error'), true);
  assert.deepEqual(b.patch, { Style: 1, AutoMask: 0 });
});
