import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { parseCLI } from '../src/cli-options.mjs';
import { addProject,setAgents,removeProject,manage } from '../src/manage.mjs';
import { selectAgents } from '../src/agent-select.mjs';

test('management commands parse exact paths and explicit agent lists',()=>{
 assert.equal(parseCLI(['project-add','C:/my project','--config','a']).directory,'C:/my project');
 assert.equal(parseCLI(['agents','--agents','codex,pi']).agents,'codex,pi');
 assert.equal(parseCLI(['uninstall','--yes']).yes,true);
 for(const args of [['project-add'],['agents','--agents'],['uninstall','--purge']])assert.throws(()=>parseCLI(args));
});
test('agent selection preserves per-agent settings and disables unselected profiles',()=>{
 const raw={plugins:[{type:'codex',model:'custom'},{type:'claude',maxBudgetUsd:7}]};
 const next=setAgents(raw,['codex','pi']);assert.equal(next.plugins[0].model,'custom');assert.equal(next.plugins[1].enabled,false);assert.equal(next.plugins[2].type,'pi');assert.equal(raw.plugins[1].enabled,undefined);
 assert.throws(()=>setAgents(raw,[]));
});
test('remove project only revokes a selected authorization and retains at least one',()=>{
 const raw={projects:[{id:'a',path:'/keep'},{id:'b',path:'/unchanged'}]};
 assert.deepEqual(removeProject(raw,'b').projects,[raw.projects[0]]);assert.equal(raw.projects.length,2);
 assert.throws(()=>removeProject(raw,'missing'));assert.throws(()=>removeProject({projects:[raw.projects[0]]},'a'));
});
test('interactive selector uses Space and Enter, restores terminal state',async()=>{
 const input=new PassThrough(),output=new PassThrough();input.isTTY=true;input.isRaw=false;input.setRawMode=x=>input.isRaw=x;
 const result=selectAgents([],input,output);input.emit('keypress',' ',{name:'space'});input.emit('keypress','',{name:'down'});input.emit('keypress',' ',{name:'space'});input.emit('keypress','',{name:'return'});
 assert.deepEqual(await result,['codex','claude']);assert.equal(input.isRaw,false);assert.equal(input.listenerCount('keypress'),0);
});
test('project edits preserve identity, validate folders and refuse a live daemon',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'golink-manage-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const a=path.join(dir,'a'),b=path.join(dir,'b'),state=path.join(dir,'state');for(const p of [a,b,state])fs.mkdirSync(p);
 fs.writeFileSync(path.join(state,'identity'),'keep');
 const raw={gateway:'https://agent.000.moe',stateDir:state,projects:[{id:'old',name:'a',path:a}],plugins:[{type:'codex'}]};
 const file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify(raw));
 assert.throws(()=>addProject(raw,a,dir),/already/);assert.throws(()=>addProject(raw,os.homedir(),dir),/folder/);
 await manage('project-add',file,{directory:b});const saved=JSON.parse(fs.readFileSync(file));assert.equal(saved.projects[0].id,'old');assert.equal(saved.projects.length,2);assert.deepEqual(JSON.parse(fs.readFileSync(file+'.bak')),raw);
 fs.writeFileSync(path.join(state,'daemon.lock'),String(process.pid));await assert.rejects(manage('agents',file,{agents:'pi'}),/Stop/);assert.deepEqual(JSON.parse(fs.readFileSync(file)),saved);assert.equal(fs.readFileSync(path.join(state,'identity'),'utf8'),'keep');
});
