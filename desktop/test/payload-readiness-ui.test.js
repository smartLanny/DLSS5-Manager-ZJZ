"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
function fixture(saved = '0.4.2-dx11-native-bridge-exp1-r1', family = 'RTX40', ready = true) {
  const variants = Object.fromEntries(['RTX40','RTX50'].map(f => [f,{ready,files:[],missing:ready?[]:['nrchain_nvngx.dll'],invalid:[]} ]));
  const payload={ready,selectedVersion:'0.3.3.5',versions:{'0.3.3.5':{label:'0.3.3.5',variants},'0.4.5-ota':{label:'0.4.5-DX11-兼容增强',variants}},missing:[],invalid:[]};
  const nodes={};
  const context={state:{settings:{addonVersion:saved},hardware:{family},payload},escapeHtml:String,$:id=>nodes[id]||(nodes[id]={textContent:'',classList:{hidden:true,add(){this.hidden=true;},remove(){this.hidden=false;},toggle(name,force){this.hidden=force;}}})};
  const source=fs.readFileSync(path.join(__dirname,'../src/renderer/renderer.js'),'utf8');
  const start=source.indexOf('function payloadReadyForHardware()');
  const end=source.indexOf('function versionOptionsMarkup(',start);
  assert.ok(start>=0 && end>start);
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  return {context,payload,nodes,render:()=>vm.runInContext('renderVersionSelector()',context),enabled:()=>vm.runInContext('payloadReadyForHardware()',context)};
}
test('upgrade with removed saved DX11 slot preserves verified RTX40 readiness',()=>{
 const f=fixture();f.render();assert.equal(f.payload.ready,true);assert.equal(f.enabled(),true);assert.equal(f.nodes.addonVersionSelect.value,'0.3.3.5');assert.match(f.nodes.payloadNotice.innerHTML,/默认 Core 已更新/);
});
test('existing explicit selection is retained',()=>{
 const f=fixture('0.4.5-ota');f.render();assert.equal(f.payload.selectedVersion,'0.4.5-ota');assert.equal(f.enabled(),true);
 assert.match(f.nodes.addonVersionSelect.innerHTML,/>0\.4\.5 · Beta<\/option>/);assert.doesNotMatch(f.nodes.addonVersionSelect.innerHTML,/DX11|兼容增强/);assert.match(f.nodes.addonVersionSelect.innerHTML,/0\.3\.3\.5 · 历史对照/);
});
test('invalid direct refresh never destroys a valid backend selection',()=>{
 const f=fixture();vm.runInContext("refreshSelectedPayload('removed-version')",f.context);assert.equal(f.payload.ready,true);assert.equal(f.payload.selectedVersion,'0.3.3.5');
});
test('missing components stay blocked and do not ask players to generate build files',()=>{
 const f=fixture('0.4.5-ota','RTX40',false);f.render();assert.equal(f.enabled(),false);assert.match(f.nodes.payloadNotice.innerHTML,/Core 配套连接组件/);assert.doesNotMatch(f.nodes.payloadNotice.innerHTML,/bundle\.json|payload\//);
});
test('unrecognized hardware stays blocked with a hardware explanation',()=>{
 const f=fixture('0.4.5-ota','unknown');f.render();assert.equal(f.enabled(),false);assert.match(f.nodes.payloadNotice.innerHTML,/显卡/);
});
test('choosing an available version clears stale warning',()=>{
 const f=fixture();f.render();f.context.state.settings.addonVersion='0.4.5-ota';f.render();assert.equal(f.enabled(),true);assert.equal(f.nodes.payloadNotice.classList.hidden,true);
});

test('invalid hash stays blocked even when the saved selection was removed',()=>{
 const f=fixture();
 f.payload.versions['0.3.3.5'].variants.RTX40={ready:false,files:[],missing:[],invalid:['Chinese.addon64']};
 f.render();assert.equal(f.enabled(),false);assert.match(f.nodes.payloadNotice.innerHTML,/增强 Core/);
});

test('missing bundle remains blocked with player-facing recovery instructions',()=>{
 const f=fixture();f.context.state.payload={ready:false,missing:['bundle.json'],invalid:[]};
 f.render();assert.equal(f.enabled(),false);assert.equal(f.nodes.addonVersionSelect.disabled,true);
 assert.match(f.nodes.payloadNotice.innerHTML,/组件管理/);assert.doesNotMatch(f.nodes.payloadNotice.innerHTML,/生成|README/);
});

test('slim manager explains the exact runtime DLC without exposing build paths',()=>{
 const f=fixture('0.4.5-ota','RTX40',false);
 f.payload.versions['0.4.5-ota'].variants.RTX40={ready:false,files:[],missing:['X:/Fixtures/build/fixed/RTX40/nvngx_dlssnr.dll'],invalid:[]};
 f.payload.source={runtimeDlcRequired:true,requiredHardwareFamily:'RTX40'};
 f.render();
 assert.match(f.nodes.payloadNotice.innerHTML,/NR-Runtime-RTX40\.zip/);
 assert.match(f.nodes.payloadNotice.innerHTML,/导入 DLSS5 模型/);
 assert.match(f.nodes.payloadNotice.innerHTML,/打开组件管理/);
 // The model file name is guidance; build locations must never leak.
 assert.doesNotMatch(f.nodes.payloadNotice.innerHTML,/CodexTemp|X:\/Fixtures|fixed\/RTX40/);
});

test('inherited object keys are not accepted as bundled version IDs',()=>{
 const f=fixture('constructor');f.render();assert.equal(f.payload.selectedVersion,'0.3.3.5');assert.equal(f.enabled(),true);
});
