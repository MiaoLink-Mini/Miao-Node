import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, symlink, rm, stat, utimes, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { Handles } from '../src/workspace/handles.mjs';
import { ProjectFiles, Uploads, FILE_LIMITS, sha256 } from '../src/workspace/files.mjs';
import { Workspace, operations } from '../src/workspace/service.mjs';
import { boundView, view, entry } from '../src/workspace/view.mjs';
import { permissionQuestion } from '../src/workspace/codex-permissions.mjs';
import { elicitationForm } from '../src/workspace/elicitation.mjs';
import { validateDecision } from '../src/plugins/base.mjs';
import { validate } from '../src/protocol.mjs';
import { ClaudePlugin } from '../src/plugins/claude.mjs';
import { CodexPlugin } from '../src/plugins/codex.mjs';
import { PiPlugin } from '../src/plugins/pi.mjs';
import { observeClaude } from '../src/workspace/claude.mjs';
import { observeCodex } from '../src/workspace/codex.mjs';
import { JsonLines, NativeRPC } from '../src/native-rpc.mjs';
import { observePi } from '../src/workspace/pi.mjs';
const require=createRequire(import.meta.url);
const mobile=require('../../WeAgent-Frontend/miniprogram/services/wire.js');
async function context(t,plugin=null){
 const root=await realpath(await mkdtemp(join(tmpdir(),'wa-workspace-')));const project=join(root,'project');await mkdir(project);
 const w=new Workspace({session:{sessionId:'s',turnId:'t',state:'completed',capabilities:{workspace:true,steer:true}},project:{path:project},projects:[{path:project,name:'test'}],plugin,stateDir:root,close:async()=>{},save:()=>{}});
 t.after(async()=>{await w.dispose().catch(()=>{});await rm(root,{recursive:true,force:true});});return {root,project,w};
}

test('Codex task detail preserves streaming output, completion and MCP results',async t=>{
 const p=new CodexPlugin({});const {w}=await context(t,p);p.threadId='owned';
 observeCodex(p,{method:'item/started',params:{threadId:'owned',item:{id:'cmd',type:'commandExecution',command:'echo hello'}}});
 observeCodex(p,{method:'item/commandExecution/outputDelta',params:{threadId:'foreign',itemId:'cmd',delta:'foreign'}});
 observeCodex(p,{method:'item/commandExecution/outputDelta',params:{threadId:'owned',itemId:'cmd',delta:'hello'}});
 assert.match(w.tasks.get('cmd').detail,/hello/);assert.doesNotMatch(w.tasks.get('cmd').detail,/foreign/);
 observeCodex(p,{method:'item/completed',params:{item:{id:'cmd',type:'commandExecution',command:'echo hello',exitCode:0,status:'completed'}}});
 const result=await w.execute({kind:'task',resourceId:w.tasks.get('cmd').resourceId},'t');assert.match(result.view.text,/hello/);assert.match(result.view.text,/Exit: 0/);assert.ok(result.view.controls.some(c=>c.request.kind==='task'));
 observeCodex(p,{method:'item/completed',params:{item:{id:'mcp',type:'mcpToolCall',server:'fixture',tool:'read',result:{content:'result'},status:'completed'}}});assert.match(w.tasks.get('mcp').detail,/result/);
});

test('Claude task detail retains tool inputs, results, streaming and deduplicates messages',async t=>{
 const p=new ClaudePlugin({});const {w}=await context(t,p);
 observeClaude(p,{type:'system',subtype:'task_started',task_id:'child',tool_use_id:'parent',description:'child'});
 observeClaude(p,{type:'stream_event',parent_tool_use_id:'parent',event:{type:'content_block_delta',delta:{type:'text_delta',text:'partial'}}});assert.equal(w.tasks.get('child').stream,'partial');
 const m={type:'assistant',uuid:'one',parent_tool_use_id:'parent',message:{content:[{type:'tool_use',id:'tool',name:'Read',input:{file_path:'fixture.txt'}}]}};
 observeClaude(p,m);observeClaude(p,m);assert.equal(w.tasks.get('child').items.length,1);assert.match(w.tasks.get('child').items[0].detail,/fixture.txt/);
 observeClaude(p,{type:'user',uuid:'two',parent_tool_use_id:'parent',message:{content:[{type:'tool_result',tool_use_id:'tool',content:'result'}]}});assert.match(w.tasks.get('child').items[1].detail,/result/);
});

test('Codex MCP OAuth prevents duplicate starts and expires the authorization link',async t=>{
 const p=new CodexPlugin({workspacePolicy:{allowNativeSettingsWrite:true}});const {w}=await context(t,p);let starts=0;
 p.rpc={call:async method=>method==='mcpServer/oauth/login'?(starts++,{authorizationUrl:'https://example.com/oauth'}):{data:[{name:'fixture',authStatus:'notLoggedIn',tools:{}}]}};
 const list=await w.execute({kind:'mcp'},'t'),resourceId=list.view.entries[0].request.resourceId;
 const auth=await w.execute({kind:'authorize_mcp',resourceId},'t');assert.ok(auth.view.controls.some(c=>c.request.kind==='mcp'));
 await assert.rejects(w.execute({kind:'authorize_mcp',resourceId},'t'),{code:'STALE_TURN'});assert.equal(starts,1);
 const external=auth.view.controls.find(c=>c.request.kind==='external');assert.ok(Date.parse(w.handles.expires(external.request.resourceId))-Date.now()<=120000);
 observeCodex(p,{method:'mcpServer/oauthLogin/completed',params:{name:'fixture',success:true}});assert.equal(w.native.mcpAuth.fixture.state,'native_completed');
});

test('large native catalogs remain bounded and plugin pages do not exhaust handles',async t=>{
 const bytes=Buffer.from(JSON.stringify({value:'x'.repeat(2*1024*1024)})+'\n');let parsed=false;
 assert.throws(()=>new JsonLines(()=>{}).push(bytes));new JsonLines(()=>{parsed=true},16*1024*1024).push(bytes);assert.equal(parsed,true);
 assert.throws(()=>new NativeRPC('unused',[],{maxFrameBytes:17*1024*1024}),RangeError);
 const p=new CodexPlugin({workspacePolicy:{allowNativeSettingsWrite:true}});const {w}=await context(t,p);
 p.rpc={call:async()=>({marketplaces:[{name:'fixture',path:'/fixture',plugins:Array.from({length:3000},(_,i)=>({id:String(i),name:'plugin-'+i,installed:false,enabled:false}))}]})};
 const first=await w.execute({kind:'extensions'},'t');assert.equal(first.view.entries.length,52);assert.ok(first.view.controls.some(c=>c.request.offset===50));
 for(let offset=50;offset<=250;offset+=50)await w.execute({kind:'extensions',offset},'t');assert.equal(w.native.pluginHandles.length,50);assert.equal(w.handles.records.size,50);
 const search=await w.execute({kind:'extensions',query:'plugin-2999'},'t');assert.equal(search.view.entries.length,3);
});
function checked(result){validate('NativeResult',result);mobile.validate('NativeResult',result);return result.view;}
async function file(t,bytes,name='test.txt'){const c=await context(t);await writeFile(join(c.project,name),bytes);const list=checked(await c.w.execute({kind:'files'}));return {...c,item:list.entries.find(x=>x.label===name)};}

test('workspace registry names are unique and reject arbitrary native methods',async t=>{
 const {w}=await context(t);assert.equal(operations.size,71);
 await assert.rejects(w.execute({kind:'command/exec',command:'id'}));
 await assert.rejects(w.execute({kind:'files',path:'/etc'}));
 checked(await w.execute({kind:'overview'}));
});
test('opaque resource handles enforce kind, session and expiry',()=>{
 let now=1;const a=new Handles({now:()=>now,ttl:10}),b=new Handles();const id=a.put('file',{value:7});
 assert.equal(a.get(id,'file').value,7);assert.throws(()=>a.get(id,'directory'));assert.throws(()=>b.get(id,'file'));now=11;assert.throws(()=>a.get(id,'file'));
});
test('directory browsing omits hidden secrets and refuses links outside the root',async t=>{
 const {root,project,w}=await context(t);await writeFile(join(root,'outside.txt'),'outside');await writeFile(join(project,'.env'),'secret');await writeFile(join(project,'visible.txt'),'hello');await symlink(join(root,'outside.txt'),join(project,'link.txt'));
 const v=checked(await w.execute({kind:'files'}));assert.deepEqual(v.entries.map(e=>e.label),['visible.txt']);await assert.rejects(w.files.check(join(root,'outside.txt')),e=>e.code==='FORBIDDEN');
});
test('file preview preserves exact SHA-256 and never mixes changed versions',async t=>{
 const {w,project,item}=await file(t,Buffer.from('original'));
 const before=checked(await w.execute(item.request));assert.equal(before.text,'original');assert.equal(before.transfer.version,sha256(Buffer.from('original')));
 await writeFile(join(project,'test.txt'),'different');
 const state=checked(await w.execute({kind:'file_status',resourceId:item.id,version:before.transfer.version}));assert.equal(state.entries[0].state,'changed');
 await assert.rejects(w.execute({...item.request,version:before.transfer.version}),e=>e.code==='SOURCE_CONFLICT');
});
test('binary download returns bounded exact chunks and rejects malformed UTF-8 preview',async t=>{
 const bytes=Buffer.alloc(70000,255),{w,item}=await file(t,bytes,'result.bin');
 const preview=checked(await w.execute(item.request));assert.equal(preview.text,undefined);assert.match(preview.notice,/Not UTF-8/);
 const chunks=[];let offset=0,version;
 while(offset<bytes.length){const v=checked(await w.execute({kind:'read_file',resourceId:item.id,format:'base64',offset,...(version?{version}:{})}));chunks.push(Buffer.from(v.transfer.content,'base64'));assert.ok(v.transfer.content.length<=32768);offset=v.transfer.nextOffset;version=v.transfer.version;}
 assert.deepEqual(Buffer.concat(chunks),bytes);
});
test('project root replacement invalidates old file handles',async t=>{
 const {w,project,root,item}=await file(t,Buffer.from('old'));await rename(project,join(root,'old-project'));await mkdir(project);await writeFile(join(project,'test.txt'),'new');await assert.rejects(w.execute(item.request),e=>e.code==='FORBIDDEN');
});

test('same-size replacement cannot reuse a listed file identity',async t=>{
 const {w,project,item}=await file(t,Buffer.from('old'));
 const name=join(project,'test.txt'),before=await stat(name);
 await rename(name,join(project,'original.txt'));await writeFile(name,'new');await utimes(name,before.atime,before.mtime);
 await assert.rejects(w.execute(item.request),e=>e.code==='SOURCE_CONFLICT');
});
test('uploads distinguish Node received from Agent accepted and deduplicate exact chunks',async t=>{
 const {w}=await context(t),bytes=Buffer.from('hello file');
 const begin=checked(await w.execute({kind:'begin_upload',name:'test.txt',size:bytes.length,mediaType:'text/plain',sha256:sha256(bytes)}));const resourceId=begin.transfer.id;
 assert.equal(begin.transfer.state,'uploading');const q={kind:'upload_chunk',resourceId,offset:0,content:bytes.toString('base64')};
 checked(await w.execute(q));checked(await w.execute(q));
 await assert.rejects(w.execute({...q,content:Buffer.from('jello file').toString('base64')}),e=>e.code==='IDEMPOTENCY_CONFLICT');
 const committed=checked(await w.execute({kind:'commit_upload',resourceId}));assert.equal(committed.transfer.state,'received');assert.deepEqual((await w.uploads.content(resourceId)).bytes,bytes);
 w.uploads.accept([resourceId]);assert.equal(w.uploads.get(resourceId).state,'accepted');
});
test('uploads reject incomplete, wrong checksum, invalid type and oversize before Agent input',async t=>{
 const {w}=await context(t),bytes=Buffer.from('not a PNG');
 const create=async hash=>checked(await w.execute({kind:'begin_upload',name:'img.png',size:bytes.length,mediaType:'image/png',sha256:hash})).transfer.id;
 let id=await create(sha256(bytes));await assert.rejects(w.execute({kind:'commit_upload',resourceId:id}),e=>e.code==='VALIDATION_FAILED');
 await w.execute({kind:'upload_chunk',resourceId:id,offset:0,content:bytes.toString('base64')});await assert.rejects(w.execute({kind:'commit_upload',resourceId:id}),e=>e.code==='VALIDATION_FAILED');
 id=await create('0'.repeat(64));await w.execute({kind:'upload_chunk',resourceId:id,offset:0,content:bytes.toString('base64')});await assert.rejects(w.execute({kind:'commit_upload',resourceId:id}),e=>e.code==='SOURCE_CONFLICT');
 await assert.rejects(w.execute({kind:'begin_upload',name:'big',size:FILE_LIMITS.attachmentBytes+1,mediaType:'text/plain',sha256:'0'.repeat(64)}));
});
test('queued attachments cannot be deleted and expired upload handles cannot be reused',async t=>{
 const {w,root}=await context(t);let now=1;const handles=new Handles({now:()=>now});const uploads=new Uploads(root,'expiry',handles,{now:()=>now});
 const v=await uploads.begin({name:'x',size:1,mediaType:'text/plain',sha256:sha256(Buffer.from('x'))}),id=v.transfer.id;
 uploads.pin([id]);await assert.rejects(uploads.discard(id),e=>e.code==='STALE_TURN');now+=FILE_LIMITS.ttl*2;assert.ok(uploads.get(id));uploads.unpin([id]);now+=FILE_LIMITS.ttl+1;await uploads.sweep();assert.throws(()=>uploads.get(id));await uploads.close();
});
test('staged-file cleanup will not follow a replaced storage directory',async t=>{
 const {w,root}=await context(t),v=await w.uploads.begin({name:'x',size:1,mediaType:'text/plain',sha256:sha256(Buffer.from('x'))}),id=v.transfer.id;
 const filename=basename(w.uploads.get(id).path),outside=join(root,'outside');await mkdir(outside);await writeFile(join(outside,filename),'keep');await rename(w.uploads.root,w.uploads.root+'-old');await symlink(outside,w.uploads.root,'junction');
 await assert.rejects(w.uploads.discard(id),e=>e.code==='FORBIDDEN');assert.equal(await readFile(join(outside,filename),'utf8'),'keep');
});
test('view byte budget trims entries transparently without slicing commands or binary content',()=>{
 const result=boundView(view('Large','',Array.from({length:100},()=>entry('item','\u4e2d'.repeat(4000)))));assert.ok(Buffer.byteLength(JSON.stringify(result))<=44000);assert.equal(result.truncated,true);assert.ok(result.entries.length<100);
});
test('permission subsets return only selected exact paths and requested lifetime',async t=>{
 const {w,project}=await context(t);const path=join(project,'x');await writeFile(path,'x');
 const q=await permissionQuestion({network:{enabled:true},fileSystem:{read:[path],write:[path]}},w);
 const d={kind:'question',answers:{action:undefined,q0:['o2'],q1:'o1'}};delete d.answers.action;validateDecision(q.definition,d);
 assert.deepEqual(await q.encode(d),{permissions:{fileSystem:{read:[path],write:[]}},scope:'session'});
 assert.deepEqual(await q.encode({kind:'question',answers:{q0:['o0','o1','o3'],q1:'o1'}}),{permissions:{},scope:'turn'});
});
test('permission subsets refuse foreign paths, new unknown native entries and late symlink changes',async t=>{
 const {w,project,root}=await context(t);const x=join(project,'x');await writeFile(x,'x');await writeFile(join(root,'secret'),'secret');
 await assert.rejects(permissionQuestion({network:null,fileSystem:{read:[join(root,'secret')],write:null}},w));
 await assert.rejects(permissionQuestion({network:null,fileSystem:{entries:[]}},w));
 const q=await permissionQuestion({network:null,fileSystem:{read:[x],write:null}},w);await rm(x);await symlink(join(root,'secret'),x);
 await assert.rejects(q.encode({kind:'question',answers:{q0:['o1'],q1:'o0'}}),e=>e.code==='FORBIDDEN');
});
test('MCP form schema preserves exact keys and native scalar types',()=>{
 const q=elicitationForm({serverName:'fixture',message:'test',requestedSchema:{type:'object',properties:{ExactKey:{type:'string',enum:['Yes','No']},count:{type:'integer',minimum:1,maximum:3},enabled:{type:'boolean'}},required:['ExactKey','count']}});
 const d={kind:'question',answers:{action:'submit',field0:'Yes',field1:'2',field2:'true'}};validateDecision(q.definition,d);assert.deepEqual(JSON.parse(JSON.stringify(q.encode(d))),{action:'accept',content:{ExactKey:'Yes',count:2,enabled:true}});
 assert.throws(()=>q.encode({...d,answers:{...d.answers,field1:'4'}}));assert.deepEqual(q.encode({...d,answers:{...d.answers,action:'decline'}}),{action:'decline'});
});
test('MCP forms fail closed for nested, secret-format, arbitrary-ref and regex schemas',()=>{
 for(const spec of [{type:'object',properties:{}},{type:'string',format:'password'},{type:'string',$ref:'https://example.test/schema'},{type:'string',pattern:'(a+)+'}])assert.throws(()=>elicitationForm({serverName:'x',requestedSchema:{type:'object',properties:{field:spec}}}));
});
test('Claude settings, output styles and agent presets use discovered values only',async t=>{
 const p=new ClaudePlugin({cwd:'',workspacePolicy:{}});const calls=[];p.selectedModel='model';p.query={supportedAgents:async()=>[{name:'exact-agent',description:'test',model:'model'}],supportedModels:async()=>[{value:'model',displayName:'Model',supportsEffort:true,supportedEffortLevels:['low','high']}],applyFlagSettings:async x=>{calls.push(x);},supportedCommands:async()=>[{name:'compact',description:'compact'}]};
 const {w,project}=await context(t,p);p.options.cwd=project;
 const agents=checked(await w.execute({kind:'agents'}));assert.ok(agents.entries[0].preset);assert.equal((await w.resolvePreset(agents.entries[0].preset.resourceId)).name,'exact-agent');
 const thinking=checked(await w.execute({kind:'thinking'}));assert.ok(thinking.entries.length);
 await w.execute({kind:'set_thinking',value:'high'});assert.deepEqual(calls.at(-1),{effortLevel:'high'});await assert.rejects(w.execute({kind:'set_thinking',value:'invented'}));const marked=checked(await w.execute({kind:'thinking'}));assert.equal(marked.entries.find(e=>e.label==='high').state,'current');assert.ok(!marked.entries.find(e=>e.label==='low').state);
 checked(await w.execute({kind:'config'}));
});
test('Claude task dependencies come from typed tool results, not message text',async t=>{
 const p=new ClaudePlugin({}),{w}=await context(t,p);
 observeClaude(p,{type:'assistant',message:{content:[{type:'tool_use',id:'call',name:'TaskGet',input:{taskId:'7'}}]}});
 observeClaude(p,{type:'user',message:{content:[{type:'tool_result',tool_use_id:'call',content:'Task complete (not authoritative)'}]},tool_use_result:{task:{id:'7',subject:'Review',description:'Details',status:'in_progress',blocks:['9'],blockedBy:['3']}}});
 const tasks=checked(await w.execute({kind:'tasks'}));assert.equal(tasks.entries[0].state,'in_progress');assert.match(tasks.entries[0].detail,/Blocked by: 3/);assert.equal(tasks.entries[0].controls.length,0);
});
test('Claude hooks, compaction, task replacement and errors remain separate observations',async t=>{
 const p=new ClaudePlugin({}),{w}=await context(t,p);
 observeClaude(p,{type:'system',subtype:'background_tasks_changed',tasks:[{task_id:'bg',task_type:'local_bash',description:'Background job'}]});
 observeClaude(p,{type:'system',subtype:'background_tasks_changed',tasks:[]});assert.equal(w.tasks.get('bg').state,'unknown');
 observeClaude(p,{type:'system',subtype:'hook_response',hook_id:'h',hook_name:'hook',output:'Done',outcome:'success'});
 checked(await w.execute({kind:'widgets'}));assert.equal(w.widgets.size,1);
});
test('Pi controls enforce host permission and preserve native setting scope',async t=>{
 const p=new PiPlugin({workspacePolicy:{allowNativeSettingsWrite:false}}),{w}=await context(t,p),calls=[];
 let thinking='low';p.rpc={call:async(method,params)=>{calls.push([method,params]);if(method==='get_available_thinking_levels')return {levels:['low','high']};if(method==='get_state')return {thinkingLevel:thinking,model:{id:'m',input:['text']},steeringMode:'all',followUpMode:'one-at-a-time',autoCompactionEnabled:true,isCompacting:false};if(method==='set_thinking_level'){thinking=params.level;return {};}if(method==='get_commands')return {commands:[]};if(method==='set_auto_retry')return {};throw Error('Unexpected RPC '+method);}};
 checked(await w.execute({kind:'thinking'}));await assert.rejects(w.execute({kind:'set_thinking',value:'high'}),e=>e.code==='FORBIDDEN');p.options.workspacePolicy.allowNativeSettingsWrite=true;
 checked(await w.execute({kind:'set_thinking',value:'high'}));assert.equal(thinking,'high');checked(await w.execute({kind:'set_auto_retry',enabled:false}));assert.ok(calls.some(([m])=>m==='set_auto_retry'));
});
test('Pi widget updates replace exact keys and retry reports retain native attempt counts',async t=>{
 const p=new PiPlugin({}),{w}=await context(t,p);
 observePi(p,{type:'extension_ui_request',method:'setStatus',statusKey:'ExactKey',statusText:'first'});observePi(p,{type:'extension_ui_request',method:'setStatus',statusKey:'ExactKey',statusText:'second'});
 assert.equal(w.widgets.size,1);assert.equal([...w.widgets.values()][0].detail,'second');
 observePi(p,{type:'auto_retry_start',attempt:2,maxAttempts:4,delayMs:500,errorMessage:'fixture error'});assert.equal(w.native.retry.attempt,2);
 observePi(p,{type:'compaction_end',result:{summary:'Native summary',tokensBefore:10},aborted:false,willRetry:false});assert.equal(w.native.compaction.summary,'Native summary');
});
test('Codex reasoning, skills and sandbox controls preserve exact native parameters',async t=>{
 const p=new CodexPlugin({workspacePolicy:{allowNativeSettingsWrite:true}}),{w,project}=await context(t,p);p.options.cwd=project;p.threadId='thread';p.selectedModel='model';const calls=[];
 p.rpc={call:async(method,params)=>{calls.push([method,params]);if(method==='model/list')return {data:[{model:'model',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'test'}]}]};if(method==='skills/list')return {data:[{cwd:project,skills:[{name:'ExactSkill',description:'native',path:join(project,'SKILL.md'),enabled:true}],errors:[]}]};if(method==='skills/config/write')return {};throw Error('Unexpected RPC '+method);}};
 checked(await w.execute({kind:'thinking'}));checked(await w.execute({kind:'set_thinking',value:'medium'}));assert.equal(p.nextEffort,'medium');const marked=checked(await w.execute({kind:'thinking'}));assert.equal(marked.entries.find(e=>e.label==='medium').state,'current');
 const skill=checked(await w.execute({kind:'skills'})).entries[0];assert.equal(w.handles.get(skill.referenceId,'command').name,'ExactSkill');checked(await w.execute({kind:'set_skill',resourceId:skill.id,enabled:false}));assert.deepEqual(calls.at(-1),['skills/config/write',{path:join(project,'SKILL.md'),enabled:false}]);
 checked(await w.execute({kind:'set_permission',value:'read-only'}));assert.equal(p.nextSandbox,'read-only');
});
test('workspace mutation gates reject active-turn settings and closed-session writes',async t=>{
 const {w}=await context(t);w.session.state='running';await assert.rejects(w.execute({kind:'set_queue_policy',value:'manual'}),e=>e.code==='STALE_TURN');
 w.session.state='closed';await assert.rejects(w.execute({kind:'begin_upload',name:'x',mediaType:'text/plain',size:1,sha256:'0'.repeat(64)}),e=>e.code==='READ_ONLY');checked(await w.execute({kind:'files'}));
});
test('origin and preset are mutually exclusive on both canonical and mobile validators',()=>{
 const input={nodeId:'n',projectId:'p',agentId:'a',prompt:'run',capabilityRevision:1,origin:{sessionId:'s',sourceSessionId:'source',resourceId:'h',mode:'resume'},preset:{sessionId:'s',resourceId:'agent'}};
 assert.throws(()=>validate('CreateSession',input));assert.throws(()=>mobile.validate('CreateSession',input));delete input.origin;validate('CreateSession',input);mobile.validate('CreateSession',input);
});

test('history origin separates the browser session from the actual native source and refuses tampering',async t=>{
 const p={options:{nativeSessionClosed:()=>true},resolveOrigin:async(h,mode)=>({native:h.sessionId,mode})};const {w}=await context(t,p);
 const resourceId=w.handles.put('history',{sessionId:'native-source',sourceSessionId:'platform-source'});
 assert.deepEqual(await w.origin(resourceId,'resume',undefined,'platform-source'),{native:'native-source',mode:'resume'});
 await assert.rejects(w.origin(resourceId,'resume',undefined,'browser-session'),e=>e.code==='FORBIDDEN');
 p.options.nativeSessionClosed=()=>false;await assert.rejects(w.origin(resourceId,'resume',undefined,'platform-source'),e=>e.code==='READ_ONLY');
});

test('Claude external native histories remain read-only without a verified source mapping',async t=>{
 const p=new ClaudePlugin({nativeSessionIdle:()=>false,sdk:{listSessions:async()=>[{sessionId:'foreign',lastModified:1,summary:'External'}],getSessionMessages:async()=>[{uuid:'message',type:'user',message:{content:'hello'}}]}});
 const {w,project}=await context(t,p);p.options.cwd=project;p.nativeSessionId='current';
 const h=checked(await w.execute({kind:'history'}));assert.equal(h.entries[0].origin,undefined);assert.equal(h.entries[0].state,'readonly');
 const messages=checked(await w.execute(h.entries[0].request));assert.equal(messages.entries[0].origin,undefined);
});

test('fork point labels must match native-issued identities and full clones cannot inherit a cutoff',async t=>{
 const p={options:{nativeSessionClosed:()=>true},resolveOrigin:async(h,mode,point)=>({mode,point:point?.nativePoint})};const {w}=await context(t,p);
 const h=w.handles.put('history',{sessionId:'native',sourceSessionId:'source'}),point=w.handles.put('history-point',{nativePoint:'native-exact'});
 assert.deepEqual(await w.origin(h,'fork',point,'source','native-exact'),{mode:'fork',point:'native-exact'});
 await assert.rejects(w.origin(h,'fork',point,'source','other'),e=>e.code==='VALIDATION_FAILED');
 await assert.rejects(w.origin(h,'clone',point,'source','native-exact'),e=>e.code==='VALIDATION_FAILED');
 assert.deepEqual(await w.origin(h,'clone',undefined,'source'),{mode:'clone',point:undefined});
});

test('native rewind result distinguishes link-safety skips from per-file success',async t=>{
 const p=new ClaudePlugin({}),{w,project}=await context(t,p);p.options.cwd=project;p.displayPath=x=>x;
 const calls=[];p.query={rewindFiles:async(uuid,options)=>{calls.push(options.dryRun);return options.dryRun?{canRewind:true,filesChanged:[]}:{canRewind:true,filesChanged:[],skippedLinks:2};}};
 const checkpoint=w.handles.put('checkpoint',{uuid:'u',label:'checkpoint',createdAt:new Date().toISOString()});
 const preview=checked(await w.execute({kind:'restore_preview',resourceId:checkpoint}));const result=checked(await w.execute(preview.controls[0].request));
 assert.equal(result.entries[0].label,'Link-safety skipped files');assert.equal(result.entries[0].detail,'2');assert.match(result.notice,/not a per-file success guarantee/);assert.deepEqual(calls,[true,true,false]);
 await assert.rejects(w.execute(preview.controls[0].request),e=>e.code==='SOURCE_CONFLICT');
});

test('Claude compaction is sent only through an advertised native command and retains acceptance semantics',async t=>{
 const {nativeFixture,until}=await import('./helpers.mjs');const p=nativeFixture('claude');t.after(()=>p.close());await p.open();
 const sent=[],push=p.input.push.bind(p.input);p.input.push=m=>{sent.push(m);return push(m);};
 p.query.supportedCommands=async()=>[{name:'compact',description:'Native advertised command',argumentHint:''}];
 const result=await p.control({action:'compact'},'compact-turn');assert.deepEqual(result,{action:'compact',status:'started'});assert.equal(sent[0].message.content,'/compact');await until(()=>!p.busy);
 p.query.supportedCommands=async()=>[];await assert.rejects(p.control({action:'compact'},'next'),e=>e.code==='CAPABILITY_UNSUPPORTED');assert.equal(sent.length,1);
});

test('history-only and external imports have disjoint strict wire shapes',()=>{
 const base={nodeId:'n',projectId:'p',agentId:'a',capabilityRevision:1};
 for(const check of [validate,mobile.validate]){
  check('CreateSession',{...base,historyOnly:true});
  const origin={sessionId:'browser',resourceId:'opaque',mode:'import'};
  check('CreateSession',{...base,prompt:'continue',origin});
  check('CreateSession',{...base,historyOnly:true,origin});
  for(const bad of [{...base},{...base,historyOnly:false},{...base,historyOnly:true,prompt:'oops'},{...base,prompt:'x',origin:{...origin,sourceSessionId:'forged'}},{...base,prompt:'x',origin:{...origin,mode:'resume'}}])
   assert.throws(()=>check('CreateSession',bad));
 }
});
test('Claude external import copies only exact-project unchanged history',async t=>{
 let info, forks=0, mutate=false;
 const p=new ClaudePlugin({sdk:{listSessions:async()=>[info],getSessionInfo:async()=>info,forkSession:async()=>{forks++;if(mutate)info={...info,lastModified:2};return {sessionId:'independent-copy'};}}});
 const {w,project,root}=await context(t,p);p.options.cwd=project;p.nativeSessionId='current';
 info={sessionId:'external',cwd:project,lastModified:1,summary:'History'};
 const row=checked(await w.execute({kind:'history'})).entries[0];
 assert.equal(row.origin.mode,'import');assert.equal(row.origin.sourceSessionId,undefined);
 assert.deepEqual(await w.origin(row.id,'import'),{type:'claude',resume:'independent-copy'});assert.equal(forks,1);
 await assert.rejects(w.origin(row.id,'import',undefined,'forged'),{code:'FORBIDDEN'});
 await assert.rejects(w.origin(row.id,'resume'),{code:'FORBIDDEN'});
 info={...info,cwd:root};await assert.rejects(w.origin(row.id,'import'),{code:'FORBIDDEN'});
 assert.equal(checked(await w.execute({kind:'history'})).entries.length,0);
 info={...info,cwd:project,lastModified:2};await assert.rejects(w.origin(row.id,'import'),{code:'SOURCE_CONFLICT'});assert.equal(forks,1);
 info={...info,lastModified:1};mutate=true;await assert.rejects(w.origin(row.id,'import'),{code:'SOURCE_CONFLICT'});assert.equal(forks,2);
});
test('Codex external import rejects active, changed and cross-project native threads',async t=>{
 const p=new CodexPlugin({}),{w,project,root}=await context(t,p);p.options.cwd=project;p.threadId='current';
 let thread={id:'external',cwd:project,updatedAt:1,cliVersion:'fixture',preview:'History',status:{type:'idle'}};
 p.rpc={call:async method=>method==='thread/list'?{data:[thread],nextCursor:null}:{thread}};
 const row=checked(await w.execute({kind:'history'})).entries[0];assert.equal(row.origin.mode,'import');
 assert.deepEqual(await w.origin(row.id,'import'),{threadId:'external',mode:'clone',cwd:project,importVersion:1});
 thread={...thread,status:{type:'active'}};await assert.rejects(w.origin(row.id,'import'),{code:'READ_ONLY'});
 thread={...thread,status:{type:'idle'},updatedAt:2};await assert.rejects(w.origin(row.id,'import'),{code:'SOURCE_CONFLICT'});
 thread={...thread,updatedAt:1,cwd:root};await assert.rejects(w.origin(row.id,'import'),{code:'FORBIDDEN'});
 assert.equal(checked(await w.execute({kind:'history'})).entries.length,0);
});

test('prompt-free history keeps owned origins separate from external imports',()=>{
 const base={nodeId:'n',projectId:'p',agentId:'a',capabilityRevision:1,historyOnly:true,origin:{sessionId:'b',sourceSessionId:'s',resourceId:'h',mode:'resume'}};
 for(const check of [validate,mobile.validate]){check('CreateSession',base);for(const mode of ['clone','fork'])check('CreateSession',{...base,origin:{...base.origin,mode}});assert.throws(()=>check('CreateSession',{...base,origin:{...base.origin,mode:'import'}}));assert.throws(()=>check('CreateSession',{...base,prompt:'oops'}));}
});

test('Codex managed resume uses rollout revision instead of stale list index',async t=>{
 const p=new CodexPlugin({nativeSessionOwner:()=> 'source',nativeSessionIdle:()=>true,nativeSessionClosed:()=>true}),{w,project}=await context(t,p);p.options.cwd=project;p.threadId='browser';
 let updatedAt=105;const thread={id:'old-native',cwd:project,updatedAt:100,preview:'History',status:{type:'notLoaded'}};
 p.rpc={call:async method=>method==='thread/list'?{data:[thread]}:{thread:{...thread,updatedAt}}};
 const row=checked(await w.execute({kind:'history'})).entries[0];assert.equal(w.handles.get(row.id,'history').updatedAt,105);
 assert.equal((await w.origin(row.id,'resume',undefined,'source')).threadId,'old-native');
 updatedAt=106;await assert.rejects(w.origin(row.id,'resume',undefined,'source'),{code:'SOURCE_CONFLICT'});
});
