import { readdir, realpath, lstat, open, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { failure, cut, textContent } from '../common.mjs';
import { entry, view, control } from './view.mjs';

// Pi v3 JSONL: discovery is strictly read-only; no SessionManager.open migration.
export function piHistoryDir(p) {
  const args=p.options.args??[],custom=args.indexOf('--session-dir');
  if(custom>=0&&args[custom+1])return resolve(p.options.cwd,args[custom+1]);
  const agent=p.options.piAgentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(),'.pi','agent');
  const root=agent.startsWith('~/')||agent.startsWith('~\\')?join(homedir(),agent.slice(2)):resolve(agent);
  return join(root,'sessions',`--${resolve(p.options.cwd).replace(/^[/\\]/,'').replace(/[/\\:]/g,'-')}--`);
}
export async function readPiHistory(p,path,expected) {
  const dir=piHistoryDir(p);
  if(resolve(path)!==join(dir,path.split(/[/\\]/).at(-1)) || (await lstat(dir)).isSymbolicLink() || (await lstat(path)).isSymbolicLink()) throw failure('FORBIDDEN','History path is not authorized');
  const file=await open(path,'r'); let bytes,stat;
  try { stat=await file.stat();if(!stat.isFile()||stat.size>16*1024*1024)throw failure('PAYLOAD_TOO_LARGE','Pi history exceeds read limit');bytes=Buffer.alloc(stat.size);const read=await file.read(bytes,0,bytes.length,0);if(read.bytesRead!==bytes.length)throw failure('SOURCE_CONFLICT','History changed');if((await file.stat()).mtimeMs!==stat.mtimeMs)throw failure('SOURCE_CONFLICT','History changed'); } finally {await file.close();}
  let rows;try{rows=bytes.toString('utf8').split('\n').filter(x=>x.trim()).map(x=>JSON.parse(x));}catch{throw failure('SOURCE_CONFLICT','Incomplete Pi history; retry after the native process is idle');}
  const header=rows[0],version=createHash('sha256').update(bytes).digest('hex');
  if(header?.type!=='session'||header.version!==3||typeof header.id!=='string')throw failure('PROTOCOL_UNSUPPORTED','Pi history version must be 3');
  if(await realpath(header.cwd).catch(()=>null)!==await realpath(p.options.cwd))throw failure('FORBIDDEN','History belongs to another project');
  if(expected&&(header.id!==expected.sessionId||version!==expected.version))throw failure('SOURCE_CONFLICT','History changed; refresh the list');
  return {rows,header,version,lastModified:stat.mtimeMs,path,sessionId:header.id};
}
export async function listPiHistory(p) {
  let names;try{names=await readdir(piHistoryDir(p));}catch(e){if(e.code==='ENOENT')return [];throw e;}
  const items=[];
  for(const name of names.filter(n=>n.endsWith('.jsonl')).slice(0,1000)) {
    try{items.push(await readPiHistory(p,join(piHistoryDir(p),name)));}catch(e){if(!['FORBIDDEN','PROTOCOL_UNSUPPORTED','SOURCE_CONFLICT','ENOENT','PAYLOAD_TOO_LARGE'].includes(e.code))throw e;}
  }
  return items.sort((a,b)=>b.lastModified-a.lastModified);
}
export async function piHistoryView(r,w) {
  const p=this;
  if(r.kind==='history') {
    const all=await listPiHistory(p),items=[];
    for(const h of all.slice(0,100)) {
      const sourceSessionId=p.options.nativeSessionOwner?.(h.sessionId);
      const handle={path:h.path,sessionId:h.sessionId,version:h.version,lastModified:h.lastModified,sourceSessionId,external:!sourceSessionId};
      const resourceId=w.handles.put('history',handle);
      const owned=sourceSessionId&&p.options.nativeSessionIdle?.(h.sessionId)&&h.sessionId!==p.nativeSessionId;
      const title=h.rows.filter(x=>x.type==='session_info'&&x.name).at(-1)?.name || textContent(h.rows.find(x=>x.type==='message'&&x.message?.role==='user')?.message?.content) || 'Pi session';
      items.push(entry(cut(title,200),new Date(h.lastModified).toISOString(),{id:resourceId,request:{kind:'history_messages',resourceId},...(owned?{origin:{sessionId:w.session.sessionId,sourceSessionId,resourceId,mode:'resume'}}:!sourceSessionId?{origin:{sessionId:w.session.sessionId,resourceId,mode:'import'}}:{state:'readonly'})}));
    }
    return view('Pi 本地历史','仅显示当前项目的已保存历史。导入前请停止原终端任务。',items,[],{truncated:all.length>100});
  }
  const h=w.handles.get(r.resourceId,'history'),snapshot=await readPiHistory(p,h.path,h);
  const messages=snapshot.rows.filter(x=>x.type==='message'),offset=r.offset??0;
  return view('Pi 历史消息','',messages.slice(offset,offset+100).map(x=>{
    const pointId=w.handles.put('history-point',{sessionId:h.sessionId,nativePoint:x.id});
    return entry(x.message.role,cut(textContent(x.message.content),4000),{...(h.sourceSessionId&&p.options.nativeSessionIdle?.(h.sessionId)&&h.sessionId!==p.nativeSessionId?{origin:{sessionId:w.session.sessionId,sourceSessionId:h.sourceSessionId,resourceId:r.resourceId,mode:'fork',pointId,pointLabel:x.id}}:{})});
  }),messages.length>offset+100?[control('下一页',{kind:'history_messages',resourceId:r.resourceId,offset:offset+100})]:[],{truncated:messages.length>offset+100});
}
export async function piOrigin(h,mode,point) {
  await readPiHistory(this,h.path,h);
  if(mode==='resume'&&!this.options.nativeSessionClosed?.(h.sessionId))throw failure('READ_ONLY','Close the original process first');
  if(point&&(point.sessionId!==h.sessionId||mode!=='fork'))throw failure('FORBIDDEN','Invalid history point');
  return {...h,mode,point:point?.nativePoint};
}
export async function preparePiOrigin(p,h) {
  const snapshot=await readPiHistory(p,h.path,h);
  if(h.mode==='resume')return h.path;
  if(!['fork','clone','import'].includes(h.mode))throw failure('CAPABILITY_UNSUPPORTED','Unsupported Pi origin');
  let rows=snapshot.rows.slice(1);
  if(h.point) {
    const map=new Map(rows.map(x=>[x.id,x])),branch=[],seen=new Set();let id=h.point;
    while(id){const row=map.get(id);if(!row||seen.has(id))throw failure('SOURCE_CONFLICT','Invalid history branch');seen.add(id);branch.unshift(row);id=row.parentId;}
    rows=branch;
    if(rows.some(x=>x.type==='compaction'&&!seen.has(x.firstKeptEntryId)))throw failure('SOURCE_CONFLICT','Compaction boundary is outside this branch');
  }
  const timestamp=new Date().toISOString(),id=randomUUID(),dir=piHistoryDir(p);
  await mkdir(dir,{recursive:true});
  const path=join(dir,`${timestamp.replace(/[:.]/g,'-')}_${id}.jsonl`);
  const header={...snapshot.header,id,timestamp,cwd:p.options.cwd,parentSession:h.path};
  await writeFile(path,[header,...rows].map(x=>JSON.stringify(x)).join('\n')+'\n',{flag:'wx',mode:0o600});
  return path;
}
