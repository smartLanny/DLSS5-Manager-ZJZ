'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const os = require('node:os');
const { safeText } = require('./model.cjs');
const QUERY = '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @(' +
  'Get-CimInstance Win32_VideoController -ErrorAction Stop | Select-Object Name,PNPDeviceID,DriverVersion' +
  ') | ConvertTo-Json -Compress';
async function collectDrivers({ platform=process.platform, runner=promisify(execFile), now=()=>new Date() }={}) {
  const base = {gpus:[],renderAdapter:null,os:{platform,release:os.release(),build:null},capturedAt:now().toISOString()};
  if(platform !== 'win32') return {...base,warning:'当前环境不是 Windows；未查询真实显卡驱动。'};
  try {
    const exe=path.win32.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const {stdout}=await runner(exe,['-NoLogo','-NoProfile','-NonInteractive','-Command',QUERY],{timeout:5000,maxBuffer:65536,windowsHide:true});
    if(Buffer.byteLength(String(stdout))>65536) throw new Error('输出过大');
    const parsed=JSON.parse(String(stdout).replace(/^\uFEFF/,''));
    const rows=Array.isArray(parsed)?parsed:parsed?[parsed]:[];
    const gpus=rows.slice(0,8).map((r,i)=>({id:'inventory-'+i,name:safeText(r.Name),
      vendorId:/VEN_([a-f0-9]{4})/i.exec(r.PNPDeviceID || '')?.[1]?.toLowerCase() || null,
      deviceId:/DEV_([a-f0-9]{4})/i.exec(r.PNPDeviceID || '')?.[1]?.toLowerCase() || null,
      driverRaw:safeText(r.DriverVersion,80),driverDisplay:null,source:'Win32_VideoController'}));
    // Inventory IDs are session-local, not machine IDs. No PNP instance suffix is retained.
    return {...base,gpus,warning:'实际渲染显卡尚未绑定；不能把第一张显卡当作游戏显卡。'};
  } catch {return {...base,warning:'未能读取显卡驱动；仍可保存反馈，不填入猜测版本。'};}
}
module.exports={collectDrivers,QUERY};
