'use strict';
const {randomUUID}=require('node:crypto');
const {createReport,validateSession,validateReport,summary,redact,digest,frozen,fail}=require('./model.cjs');
const {zip,unzip}=require('./zip.cjs');
const PREVIEW_TTL_MS=5*60*1000;
function capUtf8(value,max){const b=Buffer.from(value,'utf8');return b.length<=max?value:b.subarray(0,max).toString('utf8').replace(/\ufffd$/,'')+'\n[日志已按大小限制截断]';}
function packageReport(report,logs=[]) {
  const copy=JSON.parse(JSON.stringify(report)),summaryBytes=Buffer.from(summary(copy));
  const entries=[{name:'summary.txt',bytes:summaryBytes}];
  copy.attachments=[{path:'summary.txt',sha256:digest(summaryBytes),bytes:summaryBytes.length,scope:'summary',source:'compatibility-ux'}];
  let total=0;
  for(const [i,row]of logs.slice(0,12).entries()){
    if(!row||typeof row.text!=='string')continue;
    // The caller selects relevant logs in the trusted main process. No renderer file path is accepted.
    const content=capUtf8(redact(row.text,128*1024),128*1024),bytes=Buffer.from(content);
    total+=bytes.length;if(total>1536*1024)break;
    const name=`logs/log-${i+1}.txt`;
    entries.push({name,bytes});copy.attachments.push({path:name,sha256:digest(bytes),bytes:bytes.length,
      scope:row.sessionId===copy.session.sessionId?'session-associated':'historical',source:redact(String(row.source||'unclassified'),80)});
  }
  copy.privacy.logsIncluded=entries.length>1;
  validateReport(copy);
  const json=Buffer.from(JSON.stringify(copy,null,2));
  return {report:frozen(copy),bytes:zip([{name:'report.json',bytes:json},...entries]),
    logPreview:entries.filter(r=>r.name.startsWith('logs/')).map(r=>({name:r.name,text:r.bytes.toString('utf8')}))};
}
function readPackage(bytes) {
  const files=unzip(bytes);
  if(!files.has('report.json')||!files.has('summary.txt')||files.get('report.json').length>256*1024)fail('兼容包缺少报告或超限');
  let report;try{report=JSON.parse(files.get('report.json').toString('utf8'));}catch{fail('报告 JSON 无效');}
  validateReport(report);
  const seen=new Set(['report.json']);
  for(const a of report.attachments){
    if(seen.has(a.path)||!files.has(a.path))fail('附件缺失或重复');seen.add(a.path);
    const data=files.get(a.path);if(data.length!==a.bytes||digest(data)!==a.sha256)fail('附件哈希不匹配','ATTACHMENT_HASH');
  }
  if(seen.size!==files.size||!seen.has('summary.txt'))fail('兼容包包含未声明附件');
  // Summary cannot claim something different from report.json.
  if(files.get('summary.txt').toString('utf8')!==summary(report))fail('摘要与报告不一致');
  return {report,files};
}
function createFeedbackService({getSession,getEvidence=async()=>({}),collectLogs=async()=>[],writePackage,now=()=>new Date()}={}){
  if(typeof getSession!=='function'||typeof writePackage!=='function')throw new TypeError('需要当前会话读取器和本地保存适配器');
  const previews=new Map();let preparing=false;
  const same=(a,b)=>a&&b&&a.sessionId===b.sessionId&&a.recipeFingerprint===b.recipeFingerprint&&a.configuration.generation===b.configuration.generation;
  function prune(){for(const[id,p]of previews)if(p.state!=='saving'&&now().getTime()-p.created>PREVIEW_TTL_MS)previews.delete(id);}
  return {
    async preview(request={}){
      if(preparing)fail('正在生成反馈，请勿重复点击','BUSY');preparing=true;
      try{
        if(!request||Object.keys(request).some(k=>!['ratings','includeLogs'].includes(k))||typeof request.includeLogs!=='boolean')fail('反馈请求字段无效');
        prune();if(previews.size>=8)fail('已有过多反馈预览，请关闭旧预览','PREVIEW_LIMIT');
        const session=JSON.parse(JSON.stringify(await getSession()));validateSession(session);
        const evidence=await getEvidence(session),logs=request.includeLogs?await collectLogs(session):[];
        if(!same(session,await getSession()))fail('当前游戏或配置已变化，请重新生成反馈','SESSION_CHANGED');
        const report=createReport(session,request.ratings,evidence,{now});
        const pack=packageReport(report,logs),id=randomUUID();
        previews.set(id,{...pack,session,created:now().getTime(),state:'ready'});
        return {previewId:id,reportId:report.reportId,contextKey:session.sessionId,summary:summary(pack.report),
          report:JSON.parse(JSON.stringify(pack.report)),files:pack.report.attachments.map(a=>({path:a.path,bytes:a.bytes,scope:a.scope})),
          logPreview:pack.logPreview,expiresAt:new Date(now().getTime()+PREVIEW_TTL_MS).toISOString(),
          privacyWarning:pack.report.privacy.warning};
      }finally{preparing=false;}
    },
    async save(request={}){
      if(!request||Object.keys(request).some(k=>!['previewId','confirmed'].includes(k))||request.confirmed!==true)fail('请先确认预览内容','CONSENT_REQUIRED');
      prune();const p=previews.get(request.previewId);if(!p)fail('预览已过期，请重新生成','PREVIEW_EXPIRED');
      if(p.state!=='ready')fail('该反馈正在保存或已保存','BUSY');
      p.state='saving';
      try{
        if(!same(p.session,await getSession()))fail('当前游戏或配置已变化，请重新生成反馈','SESSION_CHANGED');
        // Only the host's save dialog chooses a destination. Renderer cannot supply a path.
        // The host invokes this again after the dialog closes and before opening
        // its wx handle, so a long-lived dialog cannot export stale preview data.
        const validateBeforeWrite=async()=>{
          prune();
          if(previews.get(request.previewId)!==p||p.state!=='saving')fail('预览已过期，请重新生成','PREVIEW_EXPIRED');
          if(!same(p.session,await getSession()))fail('当前游戏或配置已变化，请重新生成反馈','SESSION_CHANGED');
          return true;
        };
        const result=await writePackage({filename:`compat-${p.report.reportId}.zip`,bytes:Buffer.from(p.bytes),reportId:p.report.reportId,validateBeforeWrite});
        if(result?.cancelled===true){p.state='ready';return {cancelled:true};}
        if(result?.saved!==true)fail('没有取得本地保存回执','SAVE_NOT_CONFIRMED');
        p.state='saved';previews.delete(request.previewId);
        return {saved:true,uploaded:false,filename:`compat-${p.report.reportId}.zip`,reportId:p.report.reportId};
      }catch(e){p.state='ready';throw e;}
    },
    discard(id){const p=previews.get(id);if(p?.state==='saving')return false;return previews.delete(id);},
    dispose(){previews.clear();}
  };
}
module.exports={createFeedbackService,packageReport,readPackage,PREVIEW_TTL_MS};
