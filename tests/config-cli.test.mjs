import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { loadConfig, discover } from '../src/config.mjs';
import { parseCLI, requireRuntime } from '../src/cli-options.mjs';
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
function fixture(t) {
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'weagent-config-test-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const raw={gateway:'https://gateway.example',projects:[{id:'project',name:'Project',path:'.'}],plugins:[{type:'claude',enabled:true}]};
 const file=path.join(dir,'config.json');return {raw,dir,file,load(){fs.writeFileSync(file,JSON.stringify(raw));return loadConfig(file);}};
}
test('built-in registry rejects inherited object keys before discovery',t=>{const f=fixture(t);for(const type of ['constructor','__proto__','toString']){f.raw.plugins=[{type}];assert.throws(()=>f.load(),/plugin/);}});
test('project identifiers must be explicit strings instead of coerced undefined',t=>{const f=fixture(t);delete f.raw.projects[0].id;assert.throws(()=>f.load());f.raw.projects[0].id=123;assert.throws(()=>f.load());});
test('invalid plugin values and disabled flag types are not treated as enabled',t=>{const f=fixture(t);for(const plugins of [{},[null],[{type:'claude',enabled:'false'}],[{type:'claude',command:5}]]){f.raw.plugins=plugins;assert.throws(()=>f.load());}});
test('config-relative project and state paths remain based on the original config',t=>{const f=fixture(t);f.raw.stateDir='private-state';const c=f.load();assert.equal(c.stateDir,path.join(f.dir,'private-state'));assert.equal(c.projects[0].path,f.dir);});
test('CLI rejects unknown commands and duplicate/missing configuration arguments',()=>{for(const args of [['restart'],['start','--config'],['start','--config','a','--config','b'],['doctor','--Config','x'],['doctor','--config','--help']])assert.throws(()=>parseCLI(args));});
test('CLI keeps exact path strings and help does not require model dependencies',()=>{assert.equal(parseCLI(['doctor','--config','/a b/config.json']).configPath,'/a b/config.json');assert.equal(parseCLI(['start']).configPath,'config.local.json');assert.equal(parseCLI(['--help']).command,'help');});
test('CLI enforces the unchanged Node runtime floor',()=>{assert.throws(()=>requireRuntime('22.16.0'),/>=24.1/);requireRuntime('24.1.0');});

test('stop accepts the documented argument shape',()=>{assert.equal(parseCLI(['stop']).command,'stop');assert.equal(parseCLI(['stop','--config','/a b/config.json']).configPath,'/a b/config.json');});
test('stop reports a clean state when no daemon lock exists',t=>{
 const f=fixture(t);f.load();
 const result=spawnSync(process.execPath,[cli,'stop','--config',f.file],{encoding:'utf8',windowsHide:true,timeout:15000});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/未在运行/);
});
test('stop terminates the daemon that owns the state lock and tolerates a dead owner',async t=>{
 const f=fixture(t);f.load();
 const stateDir=path.join(f.dir,'.runtime','state');fs.mkdirSync(stateDir,{recursive:true});
 const lock=path.join(stateDir,'daemon.lock');
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 t.after(()=>{try{child.kill('SIGKILL');}catch{}});
 await once(child,'spawn');
 fs.writeFileSync(lock,String(child.pid));
 const stopped=spawnSync(process.execPath,[cli,'stop','--config',f.file],{encoding:'utf8',windowsHide:true,timeout:15000});
 assert.equal(stopped.status,0,stopped.stderr);assert.match(stopped.stdout,/已停止守护进程/);
 await once(child,'exit');
 fs.writeFileSync(lock,'999999');
 const stale=spawnSync(process.execPath,[cli,'stop','--config',f.file],{encoding:'utf8',windowsHide:true,timeout:15000});
 assert.equal(stale.status,0,stale.stderr);assert.match(stale.stdout,/未在运行/);
});

test('explicit invalid args are rejected before discovery', t => {
 const f=fixture(t);
 for(const args of [null, false, 0, '', ['bad\0argument']]) {
  f.raw.plugins=[{type:'codex',args}];assert.throws(()=>f.load(),/args/);
 }
});

test('discovery reports bounded reasons and never claims version checks prove native authentication', async () => {
 const profile=output=>({type:'codex',command:process.execPath,args:['-e',`process.stdout.write(${JSON.stringify(output)})`,'--']});
 const ready=await discover(profile('codex 0.153.4'));
 assert.equal(ready.state,'ready');assert.equal(ready.diagnostic,null);
 assert.deepEqual(ready.checks,{version:'passed',authentication:'not_checked',protocol:'not_checked'});
 const old=await discover(profile('codex 0.100.0'));
 assert.equal(old.state,'error');assert.equal(old.version,'0.100.0');assert.equal(old.diagnostic.code,'VERSION_UNSUPPORTED');
 assert.ok(Object.values(old.capabilities).every(v=>v===false));
 const invalid=await discover(profile('token=never-relay-this-value'));
 assert.deepEqual(invalid.diagnostic,{code:'VERSION_UNRECOGNIZED',phase:'version'});
 assert.doesNotMatch(JSON.stringify(invalid.diagnostic),/never-relay/);
 const missing=await discover({type:'codex',command:path.join(os.tmpdir(),'golink-missing-executable-'+process.pid)});
 assert.equal(missing.diagnostic.code,'EXECUTABLE_NOT_FOUND');
 const failed=await discover({type:'codex',command:process.execPath,args:['-e','process.exit(1)','--']});
 assert.equal(failed.diagnostic.code,'EXECUTABLE_START_FAILED');
});
