'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { attach } = require('../src/renderer/startup-ui');
const ok = value => ({ ok: true, value });
const normal = { mode: 'normal', sandbox: true, privilege: 'standard', canRestartElevated: false, operation: { active: false, canRecover: false } };

function fixture(manager) {
  const ids = ['startupSettings', 'startupMode', 'startupPrivilege', 'startupModeNote', 'startupMessage', 'startupRefreshBtn', 'startupRestartAdminBtn'];
  const elements = Object.fromEntries(ids.map(id => [id, { textContent: '', hidden: false, disabled: false, attrs: {}, events: {},
    classList: { toggle() {} }, setAttribute(name, value) { this.attrs[name] = value; }, addEventListener(name, listener) { this.events[name] = listener; } }]));
  const document = { getElementById: id => elements[id] || null };
  return { elements, controller: attach(document, manager) };
}


test('startup explains one-shot permissions and never exposes a whole-app restart action', async()=>{
  let writes=0; const f=fixture({getStartupContext:async()=>ok(normal),restartElevated:async()=>writes++}); await f.controller.ready;
  assert.equal(f.elements.startupPrivilege.textContent,'普通权限'); assert.equal(f.elements.startupRestartAdminBtn.hidden,true);
  assert.match(f.elements.startupModeNote.textContent,/本次以管理员权限应用/); assert.equal(f.elements.startupModeNote.hidden,false);
  await f.elements.startupRestartAdminBtn.events.click(); assert.equal(writes,0);
});
test('temporary no-sandbox mode remains clearly visible independently from token privilege', async()=>{
  const f=fixture({getStartupContext:async()=>ok({...normal,mode:'compatibility',sandbox:false,privilege:'administrator'})}); await f.controller.ready;
  assert.equal(f.elements.startupMode.textContent,'临时兼容启动'); assert.match(f.elements.startupModeNote.textContent,/本次.*关闭.*沙箱/);
  assert.equal(f.elements.startupRestartAdminBtn.hidden,true);
});
test('only a recoverable ended worker exposes the explicit recovery action and a failed check keeps its lock visible', async()=>{
  const requests=[]; let complete;
  const f=fixture({getStartupContext:async()=>ok({...normal,operation:{active:true,canRecover:true,workerRunning:false}}),
    recoverOperationElevation:request=>{requests.push(request);return new Promise(resolve=>complete=resolve);}}); await f.controller.ready;
  assert.equal(f.elements.startupRestartAdminBtn.hidden,false);
  const pending=f.elements.startupRestartAdminBtn.events.click(); await f.elements.startupRestartAdminBtn.events.click();
  assert.deepEqual(requests,[{confirm:true}]); assert.equal(f.elements.startupRestartAdminBtn.disabled,true);
  complete({ok:false,error:{message:'worker still alive'}}); await pending;
  assert.match(f.elements.startupMessage.textContent,/未释放操作锁/); assert.equal(f.elements.startupMessage.attrs.role,'alert');
});
test('an active worker cannot be recovered and unavailable state points to independent diagnostics', async()=>{
  const f=fixture({getStartupContext:async()=>ok({...normal,operation:{active:true,workerRunning:true,canRecover:false}})});await f.controller.ready;
  assert.equal(f.elements.startupRestartAdminBtn.hidden,true); assert.match(f.elements.startupMessage.textContent,/仍在执行/);
  const missing=fixture({});await missing.controller.ready;assert.match(missing.elements.startupMessage.textContent,/启动诊断[.]cmd/);
});
test('settings include one independent startup panel and script without changing the existing scan controls', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../src/renderer/index.html'), 'utf8');
  assert.equal((html.match(/id="startupSettings"/g) || []).length, 1);
  assert.ok(html.indexOf('id="view-settings"') < html.indexOf('id="startupSettings"'));
  assert.match(html, /<script src="startup-ui\.js"><\/script>/); assert.match(html, /id="scanDrivesToggle"/);
  assert.equal((html.match(/id="animationsToggle"/g) || []).length, 1);
  assert.equal((html.match(/id="themeSelect"/g) || []).length, 1);
});
