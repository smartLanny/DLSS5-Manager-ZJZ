#!/usr/bin/env node
'use strict';
const fs=require('node:fs/promises');const path=require('node:path');const {randomUUID}=require('node:crypto');
const {importPackage,aggregate,noLinks}=require('../src/compatibility/inbox.cjs');
async function main(){
  const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--input'||args[2]!=='--out')throw new Error('用法：node scripts/import-compatibility.cjs --input <收包目录> --out <私有数据库目录>');
  const input=path.resolve(args[1]),out=path.resolve(args[3]);await noLinks(input);await noLinks(out);
  await fs.mkdir(out,{recursive:true});const lock=path.join(out,'.import-lock');await fs.mkdir(lock).catch(()=>{throw new Error('导入器已运行，或上次中断留下锁；确认没有运行后再移除 .import-lock。');});
  try{
    const results=[];const items=(await fs.readdir(input,{withFileTypes:true})).filter(r=>r.isFile()&&r.name.toLowerCase().endsWith('.zip'));
    if(items.length>1000)throw new Error('每批最多1000个包。');
    for(const f of items){try{const file=path.join(input,f.name);await noLinks(file);const st=await fs.stat(file);if(st.size>2*1024*1024+65536)throw new Error('包过大');
      results.push({file:f.name,...await importPackage(await fs.readFile(file),path.join(out,'reports'))});}catch(e){results.push({file:f.name,status:'rejected',reason:e.code||e.message});}}
    const rows=[];const names=await fs.readdir(path.join(out,'reports')).catch(()=>[]);if(names.length>10000)throw new Error('当前轻量导入器限制10000份报告；原件已保存。');
    for(const name of names){if(!/^[a-f0-9-]{36}\.json$/.test(name))continue;const file=path.join(out,'reports',name);await noLinks(file);if((await fs.stat(file)).size>256*1024)throw new Error('记录过大');rows.push(JSON.parse(await fs.readFile(file,'utf8')));}
    const summary=aggregate(rows);const final=path.join(out,'summary.json'),temp=path.join(out,randomUUID()+'.tmp');await noLinks(final);
    await fs.writeFile(temp,JSON.stringify(summary,null,2),{flag:'wx',mode:0o600});await fs.rename(temp,final);
    console.log(JSON.stringify({results,groups:summary.groups.length,summary:final},null,2));
  }finally{await fs.rmdir(lock);}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
