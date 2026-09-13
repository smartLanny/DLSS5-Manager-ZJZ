'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createCompatibilityFeedback, verificationObservations } = require('../../src/product/compatibility-feedback');
const { readPackage } = require('../../src/compatibility/feedback-service.cjs');
const { exactGroup } = require('../../src/compatibility/model.cjs');
const SESSION = '11111111-1111-4111-8111-111111111111';
const requestedAt = '2026-09-10T20:00:00.000Z';
function fixture() {
  let tick = Date.parse(requestedAt) + 1000, inventoryReads = 0, saved = [], logs = 0;
  const native = { sessionId: SESSION, gameId: 'game-1', targetExe: '/games/test/game.exe', requestedAt,
    process: { exe: '/games/test/game.exe', pid: 123, startedAt: requestedAt } };
  const data = { gameId: 'game-1', game: { name: '测试游戏', version: '1', exeSha256: 'b'.repeat(64), installed: true },
    api: { effectiveApi: 'dx12' }, layout: { exe: native.targetExe, version: '0.4.7beta', inputRoute: 'native', generation: 1 },
    nr: { Intensity: 1.2, Mode: 2, WorkMode: 0 }, enhancements: { current: { fg: { valid: true, request: { backend: 'nvidia', mode: 'fixed', multiplier: 4 } } } },
    verification: { core: { status: 'passed', evidence: [{ pid: 123 }] }, nr: { status: 'passed', evidence: [{ success: 1 }, { success: 2 }] } } };
  const service = createCompatibilityFeedback({ assessment: { assess: async () => structuredClone(data) }, sessions: { inspect: async () => structuredClone(native) },
    modules: async () => [{ role: 'core', path: '/games/test/core.addon64', sha256: 'a'.repeat(64), version: '0.4.7beta' }],
    collectReport: async () => { logs++; return { text: 'history C:\\Users\\private\\game.txt\nold-success=1' }; },
    drivers: async () => { inventoryReads++; return { gpus: [{ id: 'one', name: 'RTX test', driverRaw: '32.0.15.6107' }], renderAdapter: null }; },
    writePackage: async value => { saved.push(value); return { saved: true }; }, managerVersion: '0.4.8-beta.5', now: () => new Date(tick) });
  return { service, native, data, saved, advance: () => tick += 1000, inventoryReads: () => inventoryReads, logs: () => logs };
}
const request = { includeLogs: false, ratings: { playability: 'normal', image: 'improved', fluidity: 'smooth' } };
test('048 adapter captures actual launch session, reads driver and exports an independent subjective/technical report', async () => {
  const f = fixture(); await f.service.captureLaunch('game-1', f.native); f.advance();
  const c = await f.service.open('game-1'); assert.equal(c.contextSource, 'launch-snapshot'); assert.equal(f.inventoryReads(), 1);
  const p = await f.service.preview(c.token, request); assert.equal(p.report.outcome.stages.nr.state, 'observed');
  assert.equal(p.report.outcome.stages.presented.state, 'unknown'); assert.equal(p.report.session.environment.renderAdapter, null);
  assert.equal(p.report.session.environment.gpus[0].driverRaw, '32.0.15.6107'); assert.equal(f.logs(), 0);
  await f.service.save(c.token, { previewId: p.previewId, confirmed: true }); assert.equal(f.saved.length, 1);
  assert.equal(readPackage(f.saved[0].bytes).report.reportId, p.reportId); assert.equal(exactGroup(p.report).complete, false);
});
test('without launch snapshot current configuration is not relabelled as the prior tested combination', async () => {
  const f=fixture(),c=await f.service.open('game-1'),p=await f.service.preview(c.token,request);
  assert.equal(c.contextSource,'manual-snapshot'); assert.equal(p.report.session.parentSessionId,SESSION);
  assert.equal(p.report.outcome.stages.nr.state,'unknown'); assert.equal(exactGroup(p.report).complete,false);
});
test('configuration changed since launch falls back to explicit manual snapshot',async()=>{
  const f=fixture();await f.service.captureLaunch('game-1',f.native); f.data.nr.Intensity=1.7;
  assert.equal((await f.service.open('game-1')).contextSource,'manual-snapshot');
});
test('volatile inspection timestamps do not invalidate identical SR/FG settings',async()=>{
  const f=fixture();await f.service.captureLaunch('game-1',f.native);f.data.enhancements.current.fg.checkedAt='new-time';
  assert.equal((await f.service.open('game-1')).contextSource,'launch-snapshot');
});
test('actual changed FG request invalidates feedback context before save',async()=>{
  const f=fixture(),c=await f.service.open('game-1'),p=await f.service.preview(c.token,request);
  f.data.enhancements.current.fg.request.multiplier=2;
  await assert.rejects(f.service.save(c.token,{previewId:p.previewId,confirmed:true}),{code:'SESSION_CHANGED'});assert.equal(f.saved.length,0);
});
test('historical launch cannot promote old module or NR success',async()=>{
  const f=fixture();await f.service.captureLaunch('game-1',f.native);f.native.historical=true;
  const c=await f.service.open('game-1'),p=await f.service.preview(c.token,request);
  assert.equal(c.contextSource,'manual-snapshot');assert.equal(p.report.outcome.stages.loaded.state,'unknown');
});
test('native target EXE change invalidates launch snapshot and runtime evidence',async()=>{
  const f=fixture();await f.service.captureLaunch('game-1',f.native);f.native.targetExe='/games/test/other.exe';
  const c=await f.service.open('game-1'),p=await f.service.preview(c.token,request);
  assert.equal(c.contextSource,'manual-snapshot');assert.equal(p.report.outcome.stages.loaded.state,'unknown');assert.equal(p.report.outcome.stages.nr.state,'unknown');
});
test('cancelled launch capture cannot publish a late snapshot',async()=>{
  const f=fixture();let checks=0;
  await f.service.captureLaunch('game-1',f.native,{cancelled:()=>++checks>1});
  assert.equal((await f.service.open('game-1')).contextSource,'manual-snapshot');
});
test('component metadata failure keeps manual feedback available',async()=>{
  const data={gameId:'game-1',game:{name:'测试游戏',version:'1',exeSha256:'b'.repeat(64)},api:{effectiveApi:'dx12'},layout:{exe:'/games/test/game.exe',version:'1',inputRoute:'native',generation:1}};
  const service=createCompatibilityFeedback({assessment:{assess:async()=>structuredClone(data)},sessions:{inspect:async()=>null},modules:async()=>{throw Object.assign(new Error('receipt unavailable'),{code:'SETTINGS_FG_EXTERNAL_CHANGE'});},drivers:async()=>({gpus:[],renderAdapter:null}),writePackage:async()=>({saved:true}),now:()=>new Date('2026-09-11T01:01:00Z')});
  const c=await service.open('game-1'),p=await service.preview(c.token,{includeLogs:false,ratings:{}});
  assert.equal(c.contextSource,'manual-snapshot');assert.equal(p.report.outcome.stages.nr.state,'unknown');assert.equal(p.report.session.components.length,0);
});
test('failed component capture cannot publish or reuse a launch snapshot',async()=>{
  const f=fixture();let available=true;
  const service=createCompatibilityFeedback({assessment:{assess:async()=>structuredClone(f.data)},sessions:{inspect:async()=>structuredClone(f.native)},modules:async()=>{if(!available)throw new Error('receipt unavailable');return [];},drivers:async()=>({gpus:[],renderAdapter:null}),writePackage:async()=>({saved:true}),now:()=>new Date(Date.parse(requestedAt)+1000)});
  await service.captureLaunch('game-1',f.native);available=false;await service.captureLaunch('game-1',f.native);const c=await service.open('game-1');
  assert.equal(c.contextSource,'manual-snapshot');
  const p=await service.preview(c.token,request);assert.equal(p.report.outcome.stages.loaded.state,'unknown');assert.equal(p.report.outcome.stages.nr.state,'unknown');
});
test('existing feedback text remains historical attachment, never current process evidence',async()=>{
  const f=fixture(),c=await f.service.open('game-1'),p=await f.service.preview(c.token,{...request,includeLogs:true});
  assert.equal(f.logs(),1);assert.equal(p.report.attachments.find(r=>r.path.startsWith('logs/')).scope,'historical');
  assert.equal(p.logPreview[0].text.includes('C:\\Users'),false);
});
test('changed bound target and reused token cannot export a different game',async()=>{
  const f=fixture(),c=await f.service.open('game-1');f.data.gameId='game-2';
  await assert.rejects(f.service.preview(c.token,request),{code:'COMPATIBILITY_TARGET'});
});
test('manual feedback remains available when process observation is absent',async()=>{
  const f=fixture();f.native.process=null;const c=await f.service.open('game-1');
  const p=await f.service.preview(c.token,{...request,ratings:{playability:'cannot-start'}});
  assert.equal(p.report.ratings.playability,'cannot-start');assert.equal(p.report.outcome.exitKind,'unknown');
});
test('context limits, close, expiry and dispose are bounded',async()=>{
  const f=fixture(),all=[];for(let i=0;i<8;i++)all.push(await f.service.open('game-1'));
  await assert.rejects(f.service.open('game-1'),{code:'COMPATIBILITY_LIMIT'});
  f.service.close(all[0].token);const c=await f.service.open('game-1');f.service.dispose();
  await assert.rejects(f.service.preview(c.token,request),{code:'COMPATIBILITY_EXPIRED'});
});
test('invalid runtime process identity never becomes loaded',()=>{
  const f=fixture();assert.deepEqual(verificationObservations(f.data.verification,{sessionId:SESSION},{...f.native,process:{exe:'/different/game.exe'}},requestedAt),[]);
});
test('new preload exposes narrow IPC arguments rather than an arbitrary file/channel interface',()=>{
  let bridge;const calls=[];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../preload.js'),'utf8'),{require:()=>({contextBridge:{exposeInMainWorld:(n,o)=>{assert.equal(n,'manager');bridge=o;}},ipcRenderer:{invoke:(...a)=>{calls.push(a);}},webUtils:{}})});
  bridge.openCompatibilityFeedback('g');bridge.previewCompatibilityFeedback('t',request);bridge.saveCompatibilityFeedback('t',{previewId:'p',confirmed:true});
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['compatibility-open','g'],['compatibility-preview','t',request],['compatibility-save','t',{previewId:'p',confirmed:true}]]);
  assert.equal('invoke' in bridge,false);
});
test('real main registration retains sender checks and uses the existing guarded dispatcher',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../../main.js'),'utf8');
  const part=source.slice(source.indexOf('function registerIpc() {'),source.indexOf('\nasync function initializeServices'));
  const handlers=new Map(),sender={},seen=[];
  const sandbox={ipcMain:{on(){},handle:(n,f)=>handlers.set(n,f)},win:{webContents:sender},withPermissionRecovery:x=>x,
    service:{withError:async(fn)=>{try{return{ok:true,value:await fn()};}catch(e){return{ok:false,error:{code:e.code}};}}},
    compatibilityFeedback:{open:async id=>{seen.push(id);return{token:'one'};}},exportStartupReport(){},
    operationElevation:null,operationPlans:null,environment:null,preparation:null,launchCoordinator:{},
    gameAssessment:{},hoyoWorkflow:{},launchSessions:{},verificationRecords:{},startup:{},
    Set,Error};
  // Registration only: handlers unrelated to the feature are not invoked.
  vm.runInNewContext(part+'\nregisterIpc();',sandbox);
  const denied=await handlers.get('compatibility-open')({sender:{}},'g');assert.equal(denied.error.code,'IPC_SENDER');assert.equal(seen.length,0);
  const allowed=await handlers.get('compatibility-open')({sender},'g');assert.equal(allowed.ok,true);assert.deepEqual(seen,['g']);
});
test('HTML loads the composition adapter before both original clients; no CSP relaxation',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../../src/renderer/index.html'),'utf8');
  assert.ok(html.indexOf('game-page-ui.js')<html.indexOf('compatibility-integration.js'));
  assert.ok(html.indexOf('compatibility-integration.js')<html.indexOf('hoyo-page-ui.js'));
  assert.equal(html.includes('unsafe-eval'),false);assert.equal(html.includes('unsafe-inline'),false);
});
