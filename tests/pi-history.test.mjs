import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiPlugin } from '../src/plugins/pi.mjs';
import { Handles } from '../src/workspace/handles.mjs';
import { piHistoryDir, listPiHistory, readPiHistory, piHistoryView, piOrigin, preparePiOrigin } from '../src/workspace/pi-history.mjs';

async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'golink-pi-history-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const p=new PiPlugin({cwd:root,piAgentDir:join(root,'agent'),nativeSessionOwner:()=> 'source',nativeSessionIdle:()=>true,nativeSessionClosed:()=>true});
 const dir=piHistoryDir(p);await mkdir(dir,{recursive:true});const path=join(dir,'source.jsonl');
 const rows=[{type:'session',version:3,id:'native-source',cwd:root,timestamp:new Date().toISOString()},
 {type:'message',id:'a',parentId:null,message:{role:'user',content:[{type:'text',text:'hello'}]}},
 {type:'message',id:'b',parentId:'a',message:{role:'assistant',content:[{type:'text',text:'world'}]}}];
 await writeFile(path,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');return {p,path,dir,rows};
}
test('Pi closed history reads create no files, processes or sessions; handles enable branch and resume',async t=>{
 const {p,path,dir}=await fixture(t),before=await readFile(path,'utf8');await p.openHistory();assert.equal(p.rpc,undefined);
 const w={session:{sessionId:'source'},handles:new Handles()};
 const v=await piHistoryView.call(p,{kind:'history'},w);assert.equal(v.entries.length,1);assert.equal(v.entries[0].origin.mode,'resume');
 const h=w.handles.get(v.entries[0].id,'history');const m=await piHistoryView.call(p,v.entries[0].request,w);assert.equal(m.entries.length,2);
 const point=w.handles.get(m.entries[0].origin.pointId,'history-point');const origin=await piOrigin.call(p,h,'fork',point);
 const branch=await preparePiOrigin(p,origin),child=await readPiHistory(p,branch);assert.notEqual(child.sessionId,h.sessionId);assert.equal(child.rows.length,2);
 assert.equal(await readFile(path,'utf8'),before);
 assert.equal(await preparePiOrigin(p,await piOrigin.call(p,h,'resume')),path);
 assert.equal((await readdir(dir)).length,2);
 const clone=await readPiHistory(p,await preparePiOrigin(p,await piOrigin.call(p,h,'clone')));assert.equal(clone.rows.length,3);
 assert.equal((await p.resumeOrigin('native-source')).sessionId,'native-source');
 await assert.rejects(p.resumeOrigin('missing'),{code:'NOT_FOUND'});
});
test('Pi imports are independent and reject changed sources, wrong projects and branch points',async t=>{
 const {p,path,rows}=await fixture(t);const h=(await listPiHistory(p))[0];
 const imported=await readPiHistory(p,await preparePiOrigin(p,{...h,mode:'import'}));assert.notEqual(imported.sessionId,h.sessionId);
 await assert.rejects(piOrigin.call(p,h,'fork',{sessionId:'other',nativePoint:'a'}),{code:'FORBIDDEN'});
 p.options.nativeSessionClosed=()=>false;await assert.rejects(piOrigin.call(p,h,'resume'),{code:'READ_ONLY'});
 await writeFile(path,JSON.stringify({...rows[0],cwd:tmpdir()})+'\n');await assert.rejects(readPiHistory(p,path,h),{code:'FORBIDDEN'});
 await writeFile(path,rows.map(x=>JSON.stringify(x)).join('\n')+'\n\n');await assert.rejects(preparePiOrigin(p,{...h,mode:'import'}),{code:'SOURCE_CONFLICT'});
});
