'use strict';
const fs=require('node:fs/promises');const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {readPackage}=require('./feedback-service.cjs');
const {validateReport,exactGroup,digest,stable,fail}=require('./model.cjs');
async function noLinks(p){let current=path.resolve(p);for(;;){const s=await fs.lstat(current).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(s?.isSymbolicLink())fail('目录含链接，拒绝写入','UNSAFE_PATH');const next=path.dirname(current);if(next===current)break;current=next;}}
async function importPackage(bytes,directory){
  const {report}=readPackage(bytes),root=path.resolve(directory);await noLinks(root);await fs.mkdir(root,{recursive:true});await noLinks(root);
  // Immutable records only. Rebuilding summaries does not edit original facts; there is no auto recommendation.
  const filename=path.join(root,report.reportId+'.json'),data=JSON.stringify(report,null,2)+'\n';
  let temporary=null;
  try{
    const candidate=path.join(root,'.'+report.reportId+'.'+randomUUID()+'.tmp');
    const handle=await fs.open(candidate,'wx',0o600);temporary=candidate;
    try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}
    try{await fs.link(temporary,filename);}
    catch(e){
      if(e.code!=='EEXIST'){
        if(['EPERM','EXDEV','ENOSYS','EOPNOTSUPP','ENOTSUP'].includes(e.code))
          throw Object.assign(new Error('当前目录不支持原子硬链接发布，未导入；请换用支持硬链接的私有目录后重试。'),{code:'ATOMIC_PUBLISH_UNSUPPORTED',cause:e});
        throw e;
      }
      await noLinks(filename);const st=await fs.stat(filename);if(st.size>256*1024)fail('已有报告异常');
      const previous=JSON.parse(await fs.readFile(filename,'utf8'));if(stable(previous)!==stable(report))fail('同一报告编号有不同内容，未覆盖','REPORT_ID_CONFLICT');
      return {status:'duplicate',reportId:report.reportId};
    }
    return {status:'imported',reportId:report.reportId};
  }finally{if(temporary)await fs.rm(temporary,{force:true}).catch(()=>{});}
}
function aggregate(reports){
  if(!Array.isArray(reports)||reports.length>10000)fail('批次报告过多');
  const grouped=new Map();const reportIds=new Map();const sessionKeys=new Map();
  for(const r of reports){validateReport(r);const fingerprint=digest(r);if(reportIds.has(r.reportId)){if(reportIds.get(r.reportId)!==fingerprint)fail('同一报告编号冲突','REPORT_ID_CONFLICT');continue;}reportIds.set(r.reportId,fingerprint);
    const key=exactGroup(r);if(!sessionKeys.has(r.session.sessionId))sessionKeys.set(r.session.sessionId,new Set());sessionKeys.get(r.session.sessionId).add(key.key);if(!grouped.has(key.key))grouped.set(key.key,{...key,rows:[]});grouped.get(key.key).rows.push(r);}
  return {schemaVersion:1,automaticRecommendations:false,groups:[...grouped.values()].map(group=>{
    const sessions=new Map();for(const r of group.rows){if(!sessions.has(r.session.sessionId))sessions.set(r.session.sessionId,[]);sessions.get(r.session.sessionId).push(r);}
    const counts={normal:0,'cannot-start':0,'crash-or-freeze':0,unknown:0};const image={improved:0,unchanged:0,artifacts:0,unknown:0};
    const fluidity={smooth:0,acceptable:0,unacceptable:0,unknown:0};let conflictingSessions=0;
    const testers=new Set();let anonymousSessions=0;
    for(const rows of sessions.values()){
      const choices=new Set(rows.map(r=>stable(r.ratings)));
      if(choices.size>1||sessionKeys.get(rows[0].session.sessionId).size>1){conflictingSessions++;continue;}
      const r=rows[0];counts[r.ratings.playability]++;image[r.ratings.image]++;fluidity[r.ratings.fluidity]++;
      if(r.session.testerId)testers.add(r.session.testerId);else anonymousSessions++;
    }
    return {key:group.key,conditions:group.conditions,complete:group.complete,reportCount:group.rows.length,sessionCount:sessions.size,
      knownTesterCount:testers.size,anonymousSessions,conflictingSessions,playability:counts,image,fluidity,
      note:'仅为未审阅反馈统计；匿名会话不能换算独立用户。未知/冲突不计成功或失败，不用于自动改默认路线。'};
  }).sort((a,b)=>a.key.localeCompare(b.key))};
}
module.exports={importPackage,aggregate,noLinks};
