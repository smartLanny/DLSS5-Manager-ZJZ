'use strict';
const {createSession,createReport}=require('../../src/compatibility/model.cjs');
const start='2026-09-11T01:00:00.000Z';
function session(patch={}){return createSession({game:{name:'测试游戏',version:'1.0',exeName:'game.exe',exeSha256:'a'.repeat(64),api:'dx12',client:'test'},
  manager:{version:'0.4.8',build:'unverified-demo'},recipe:{id:'own-native',version:'1',name:'装机宅 NR→SR',providerQuality:'native',nrOwner:'own-core'},
  components:[{role:'nr',id:'own-core',version:'0.4.8',sha256:'b'.repeat(64),identity:'installed'}],configuration:{generation:1,requested:{nrPlacement:'before-sr',nrScale:1}},
  environment:{gpus:[{id:'gpu0',name:'Test GPU',vendorId:'10de',deviceId:'0001',driverRaw:'32.0.0.1',source:'fixture'}],renderAdapter:{id:'gpu0',source:'runtime-dxgi'},os:{platform:'win32'}},
  scope:'demo',contextSource:'launch-snapshot',...patch},{now:()=>new Date(start)});}
function report(s=session(),ratings={}){return createReport(s,ratings,{}, {now:()=>new Date('2026-09-11T01:01:00Z')});}
function decision(s=session()){return {contextKey:s.sessionId,sessionId:s.sessionId,recipeFingerprint:s.recipeFingerprint,configurationGeneration:1,recommendedId:'own-native',installed:true,
  candidates:[{id:'own-native',name:'装机宅 NR→SR',available:true,reasons:['沿用当前原生输入','不额外安装另一套 NR'],action:{kind:'launch',planId:'demo-only'},verificationLabel:'演示数据，不代表任何游戏已通过',layers:[{label:'画质处理',name:'装机宅 Core',version:'演示'},{label:'输入来源',name:'游戏原生输入'}]}]};}
module.exports={session,report,decision,start};
