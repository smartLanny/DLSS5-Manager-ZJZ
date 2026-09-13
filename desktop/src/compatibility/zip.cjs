'use strict';
// Deliberately small STORE-only ZIP contract. No extraction, shell, ZIP64, encrypted data or symlinks.
const { fail } = require('./model.cjs');
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 20;
const table = Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(b) { let c=0xffffffff;for(const v of b)c=table[(c^v)&255]^(c>>>8);return(c^0xffffffff)>>>0; }
function allowed(name) {return name==='report.json'||name==='summary.txt'||/^logs\/[a-z0-9_-]{1,64}\.txt$/.test(name);}
function zip(entries) {
  if(!Array.isArray(entries)||entries.length>MAX_ENTRIES)fail('ZIP 文件数量超限','ZIP_LIMIT');
  const parts=[],central=[],seen=new Set();let offset=0,total=0;
  for(const row of entries){
    if(!row||!allowed(row.name)||seen.has(row.name.toLowerCase()))fail('ZIP 文件名无效或重复','ZIP_PATH');
    seen.add(row.name.toLowerCase());const name=Buffer.from(row.name),data=Buffer.from(row.bytes),crc=crc32(data);
    total+=data.length;if(total>MAX_BYTES)fail('ZIP 内容过大','ZIP_LIMIT');
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);
    local.writeUInt16LE(33,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(33,14);
    c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);
    parts.push(local,name,data);central.push(c,name);offset+=local.length+name.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...parts,directory,end]);
}
function unzip(input) {
  const b=Buffer.from(input);
  if(b.length<22||b.length>MAX_BYTES+65536)fail('ZIP 大小无效','ZIP_LIMIT');
  const end=b.length-22;
  if(b.readUInt32LE(end)!==0x06054b50||b.readUInt16LE(end+4)||b.readUInt16LE(end+6)||b.readUInt16LE(end+20))fail('不支持多卷或附加内容的 ZIP','ZIP_FORMAT');
  const n=b.readUInt16LE(end+10),size=b.readUInt32LE(end+12),start=b.readUInt32LE(end+16);
  if(n>MAX_ENTRIES||n!==b.readUInt16LE(end+8)||start+size!==end)fail('ZIP 索引无效','ZIP_FORMAT');
  const out=new Map();let cursor=start,total=0,expectedLocal=0;
  for(let i=0;i<n;i++){
    if(cursor+46>end||b.readUInt32LE(cursor)!==0x02014b50)fail('ZIP 索引截断','ZIP_FORMAT');
    const flags=b.readUInt16LE(cursor+8),method=b.readUInt16LE(cursor+10),crc=b.readUInt32LE(cursor+16),packed=b.readUInt32LE(cursor+20),length=b.readUInt32LE(cursor+24),
      nl=b.readUInt16LE(cursor+28),extra=b.readUInt16LE(cursor+30),comment=b.readUInt16LE(cursor+32),disk=b.readUInt16LE(cursor+34),local=b.readUInt32LE(cursor+42);
    if(flags!==0x800||method!==0||packed!==length||extra||comment||disk||b.readUInt32LE(cursor+38))fail('仅接受兼容包的 STORE 格式与普通文件','ZIP_FORMAT');
    if(cursor+46+nl>end||local!==expectedLocal||local+30>start)fail('ZIP 偏移无效','ZIP_FORMAT');
    const name=b.subarray(cursor+46,cursor+46+nl).toString('utf8');
    if(!allowed(name)||out.has(name.toLowerCase()))fail('ZIP 文件路径无效','ZIP_PATH');
    if(b.readUInt32LE(local)!==0x04034b50||b.readUInt16LE(local+6)!==flags||b.readUInt16LE(local+8)!==method||
      b.readUInt32LE(local+14)!==crc||b.readUInt32LE(local+18)!==length||b.readUInt32LE(local+22)!==length||b.readUInt16LE(local+26)!==nl||b.readUInt16LE(local+28))fail('ZIP 头不一致','ZIP_FORMAT');
    const dataStart=local+30+nl,dataEnd=dataStart+length;
    if(dataEnd>start||!b.subarray(local+30,dataStart).equals(Buffer.from(name)))fail('ZIP 本地路径或长度无效','ZIP_FORMAT');
    total+=length;if(total>MAX_BYTES)fail('ZIP 内容超限','ZIP_LIMIT');
    const data=Buffer.from(b.subarray(dataStart,dataEnd));if(crc32(data)!==crc)fail('ZIP CRC 不匹配','ZIP_CRC');
    out.set(name,data);expectedLocal=dataEnd;cursor+=46+nl;
  }
  if(cursor!==end||expectedLocal!==start)fail('ZIP 含未声明数据','ZIP_FORMAT');
  return out;
}
module.exports={zip,unzip,crc32,MAX_BYTES,MAX_ENTRIES};
