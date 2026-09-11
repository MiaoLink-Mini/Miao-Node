import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { Daemon } from '../src/daemon.mjs';
import { plugins } from '../src/config.mjs';
import { validate, frame } from '../src/protocol.mjs';
import { id, failure } from '../src/common.mjs';
import { Plugin, approval } from '../src/plugins/base.mjs';
import { nativeFixture, until } from './helpers.mjs';

async function setup(t, type) {
  const dir = mkdtempSync(join(tmpdir(), 'weagent-daemon-')), reports = [], messages = []; let calls = 0;
  const config = { gateway: 'http://127.0.0.1:18080', stateDir: dir, name: 'test', maxSessions: 8, projects: [{ id: 'project', name: 'fixture', path: process.cwd(), description: '' }], profiles: [{ type, id: `agent_${type}`, name: type }] };
  const options = { report: r => reports.push(r), discoverProfile: async p => ({ ...p, state: 'ready', version: 'fixture', adapterVersion: '0.1.0', capabilities: plugins[p.type].capabilities }), pluginFactory: (p, ctx) => { calls++; return nativeFixture(p.type, ctx); } };
  const daemon = new Daemon(config, options); await daemon.initialize(); daemon.epoch = 1; daemon.identity.nodeId = 'node1'; daemon.state.set('identity', daemon.identity);
  daemon.send = async (type, data) => { messages.push(validate('NodeToGatewayFrame', frame(type, { ...data, epoch: daemon.epoch }))); };
  t.after(async () => { await daemon.close(); daemon.state.close(); rmSync(dir, { recursive: true, force: true }); });
  const create = prompt => ({ operationId: id('op'), nodeEpoch: daemon.epoch, deadlineAt: new Date(Date.now() + 10000).toISOString(), kind: 'create', sessionId: id('s'), turnId: id('t'), payload: { nodeId: 'node1', projectId: daemon.projects[0].id, agentId: daemon.profiles[0].id, prompt, capabilityRevision: 1 } });
  return { daemon, messages, reports, create, calls: () => calls };
}

for(const type of ['codex','claude','pi'])test(type+' project history never creates managed sessions or starts a native session',async t=>{
 const {daemon:d}=await setup(t,type);let opens=0,starts=0;
 const factory=d.pluginFactory;
 d.pluginFactory=(profile,context)=>{
  const p=factory(profile,{...context,piAgentDir:join(d.config.stateDir,'pi'),sdk:{listSessions:async()=>[],getSessionMessages:async()=>[]}});
  p.open=async()=>{opens++;throw Error('Browser must not open a native session');};p.start=async()=>{starts++;throw Error('Browser must not send a prompt');};return p;
 };
 const payload={nodeId:'node1',projectId:d.projects[0].id,agentId:d.profiles[0].id,capabilityRevision:1,request:{kind:'history'}};
 const issue=async body=>{const c={operationId:id('op'),nodeEpoch:1,deadlineAt:new Date(Date.now()+10000).toISOString(),kind:'history',payload:body};await d.command(validate('NodeCommand',c));return d.state.operation(c.operationId);};
 const first=await issue(payload);assert.equal(first.state,'confirmed');assert.equal(first.result.sessionId,null);assert.equal(first.result.turnId,null);validate('OperationResult',first.result);
 assert.equal((await issue(payload)).state,'confirmed');assert.equal(d.state.sessions().length,0);assert.equal(d.active.size,0);assert.equal(d.liveSessions.size,0);assert.equal(opens,0);assert.equal(starts,0);
 assert.equal((await issue({...payload,projectId:'foreign'})).error.code,'FORBIDDEN');
 assert.throws(()=>validate('ProjectHistory',{...payload,request:{kind:'close'}}));
 if(type==='codex')assert.equal(first.result.native.view.entries[0].origin.projectHistory,true);
});

test('first project browser can import only its issued history after explicit create',async t=>{
 const {daemon:d,create}=await setup(t,'codex');
 const request={operationId:id('op'),nodeEpoch:1,deadlineAt:new Date(Date.now()+10000).toISOString(),kind:'history',payload:{nodeId:'node1',projectId:d.projects[0].id,agentId:d.profiles[0].id,capabilityRevision:1,request:{kind:'history'}}};
 await d.command(request);const origin=d.state.operation(request.operationId).result.native.view.entries[0].origin;
 assert.equal(d.state.sessions().length,0);
 const cmd=create('');delete cmd.payload.prompt;cmd.payload.historyOnly=true;cmd.payload.origin=origin;
 await d.command(validate('NodeCommand',cmd));assert.equal(d.state.operation(cmd.operationId).state,'confirmed');assert.equal(d.state.sessions().length,1);assert.equal(d.state.session(cmd.sessionId).native.nativeSessionId,'imported_thread');
});

test('HTTP responses are bounded during streaming and cancelled on overflow', async t => {
  const { daemon: d } = await setup(t, 'codex');
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  let chunks=0,cancelled=false;
  globalThis.fetch=async()=>new Response(new ReadableStream({
    pull(controller){chunks++;controller.enqueue(new Uint8Array(65536));},
    cancel(){cancelled=true;}
  },{highWaterMark:0}));
  await assert.rejects(d.api('GET','/fixture'),{code:'PROTOCOL_UNSUPPORTED'});
  assert.equal(chunks,5);assert.equal(cancelled,true);
  chunks=0;cancelled=false;
  globalThis.fetch=async()=>new Response(new ReadableStream({
    pull(){chunks++;},cancel(){cancelled=true;}
  },{highWaterMark:0}),{headers:{'Content-Length':String(256*1024+1)}});
  await assert.rejects(d.api('GET','/fixture'),{code:'PROTOCOL_UNSUPPORTED'});
  assert.equal(chunks,0);assert.equal(cancelled,true);
  globalThis.fetch=async()=>new Response('{"ok":true}');
  assert.deepEqual(await d.api('GET','/fixture'),{ok:true});
  globalThis.fetch=async()=>new Response('private upstream html', {status:503});
  await assert.rejects(d.api('GET','/fixture'),{code:'SERVICE_UNAVAILABLE'});
  globalThis.fetch=async()=>new Response('private malformed response');
  await assert.rejects(d.api('GET','/fixture'),e=>e.code==='PROTOCOL_UNSUPPORTED'&&!e.message.includes('private'));
});

test('an upgraded socket without node.ready times out instead of hanging forever', {timeout:15000}, async t => {
  const { daemon: d } = await setup(t, 'codex');
  const server=new WebSocketServer({port:0,host:'127.0.0.1'});
  await once(server,'listening');
  t.after(async()=>{for(const client of server.clients)client.terminate();await new Promise(resolve=>server.close(resolve));});
  d.config.gateway='http://127.0.0.1:'+server.address().port;
  d.api=async(_method,path)=>path.endsWith('challenges')?{id:'challenge',signingInput:'fixture'}:{accessToken:'fixture'};
  await assert.rejects(d.connect(),{code:'SERVICE_UNAVAILABLE'});
  assert.equal(d.ready,false);assert.equal(d.poisoned,false);
});

test('a superseded synchronization cannot send inventory or emit session state', async t => {
  const {daemon:d,messages,reports}=await setup(t,'codex');
  const oldSocket={};d.socket={terminate(){}};d.ready=true;
  await d.synchronize(oldSocket);
  assert.equal(messages.length,0);
  assert.equal(reports.filter(r=>r.event==='connected').length,0);
});

test('short-lived connections retain increasing reconnect backoff', {timeout:8000}, async t => {
  const {daemon:d}=await setup(t,'codex');const attempts=[];
  d.connect=async()=>{attempts.push(Date.now());if(attempts.length===3)await d.close();return false;};
  await d.run();
  assert.equal(attempts.length,3);
  assert.ok(attempts[1]-attempts[0]>=900);
  assert.ok(attempts[2]-attempts[1]>=1900);
});

for (const type of ['codex', 'pi', 'claude']) test(`Daemon ${type}: strict source frames, requests, next turn, cancel, persistent duplicate`, async t => {
  const { daemon: d, create, calls, messages, reports } = await setup(t, type);
  const c = create('approval'); await d.command(c);
  const request = await until(() => d.state.pending().find(f => f.type === 'node.request')?.data.request);
  assert.equal(d.state.session(c.sessionId).state, 'waiting_approval');
  const answer = { operationId: id('op'), nodeEpoch: 1, deadlineAt: c.deadlineAt, kind: 'respond', sessionId: c.sessionId, requestId: request.id, payload: { expectedTurnId: c.turnId, capabilityRevision: 1, requestRevision: 1, decision: { kind: 'approval', choiceId: 'deny' } } };
  await d.command(answer); assert.equal(d.state.operation(answer.operationId).state, 'confirmed');
  await until(() => d.state.session(c.sessionId).state === 'completed');
  await d.command(c); assert.equal(calls(), 1);
  const send = { operationId: id('op'), nodeEpoch: 1, deadlineAt: c.deadlineAt, kind: 'send', sessionId: c.sessionId, nextTurnId: id('t'), payload: { expectedTurnId: c.turnId, text: 'hold', mode: 'send', capabilityRevision: 1 } };
  await d.command(send); assert.equal(d.state.operation(send.operationId).state, 'confirmed');
  const cancel = { operationId: id('op'), nodeEpoch: 1, deadlineAt: c.deadlineAt, kind: 'cancel', sessionId: c.sessionId, payload: { expectedTurnId: send.nextTurnId, capabilityRevision: 1 } };
  await d.command(cancel); await until(() => d.state.session(c.sessionId).state === 'cancelled');
  assert.equal(d.state.operation(cancel.operationId).state, 'confirmed');
  assert.equal(reports.filter(r => r.event === 'halted').length, 0);
  assert.ok(messages.some(m => m.type === 'command.ack' && m.data.state === 'delivered'));
  const sources = d.state.pending();
  for (const f of sources) validate('NodeToGatewayFrame', { ...f, data: { ...f.data, epoch: 1 } });
  const sequences = sources.map(f => f.data.events?.[0].sourceSequence ?? f.data.sourceSequence);
  assert.deepEqual(sequences, Array.from({ length: sequences.length }, (_, i) => i + 1));
  const next = sources.filter(f => f.data.session?.turnId === send.nextTurnId || f.data.events?.[0].turnId === send.nextTurnId);
  assert.equal(next[0].type, 'node.session');
  d.epoch = 2; d.receipt(d.state.operation(c.operationId)); assert.equal(messages.at(-1).type, 'command.status');
});

test('Daemon rejects deadline, changed capability, unreserved project and unsupported queue before native execution', async t => {
  const { daemon: d, create, calls } = await setup(t, 'codex');
  for (const mutate of [c => { c.deadlineAt = '2000-01-01T00:00:00Z'; }, c => { c.payload.capabilityRevision = 99; }, c => { c.payload.projectId = 'outside'; }]) {
    const c = create('complete'); mutate(c); await d.command(c); assert.equal(d.state.operation(c.operationId).state, 'rejected');
    assert.equal(d.state.session(c.sessionId).state, 'closed');
  }
  assert.equal(calls(), 0);
  const c = create('complete'); await d.command(c); await until(() => d.state.session(c.sessionId).state === 'completed');
  const q = { operationId: id('op'), nodeEpoch: 1, deadlineAt: c.deadlineAt, kind: 'send', sessionId: c.sessionId, nextTurnId: id('t'), payload: { expectedTurnId: c.turnId, text: 'must not run', mode: 'queue', capabilityRevision: 1 } };
  d.liveSessions.get(c.sessionId).capabilities={...d.liveSessions.get(c.sessionId).capabilities,queue:false};
  await d.command(q); assert.equal(d.state.operation(q.operationId).error.code, 'CAPABILITY_UNSUPPORTED'); assert.equal(d.state.session(c.sessionId).turnId, c.turnId);
});

for (const type of ['codex', 'pi', 'claude']) test(`Daemon ${type}: durable native control receipts, dedupe and compact turn reservation`, async t => {
  const { daemon: d, create } = await setup(t, type);
  const c = create('complete'); await d.command(c); await until(() => d.state.session(c.sessionId).state === 'completed');
  const control = action => ({ operationId: id('op'), nodeEpoch: 1, deadlineAt: c.deadlineAt, kind: 'native', sessionId: c.sessionId, nextTurnId: action.action === 'compact' ? id('t') : null, payload: { expectedTurnId: d.state.session(c.sessionId).turnId, capabilityRevision: 1, control: action } });
  const models = control({ action: 'models' }); await d.command(validate('NodeCommand', models));
  const first = d.state.operation(models.operationId); assert.equal(first.state, 'confirmed'); assert.equal(first.result.native.models.length, 2);
  const plugin = d.active.get(c.sessionId); const original = plugin.listModels.bind(plugin); let calls = 0;
  plugin.listModels = () => { calls++; return original(); };
  await d.command(models); assert.equal(calls, 0, 'duplicate returns journal, never re-queries');
  const select = control({ action: 'set_model', modelId: first.result.native.models[1].id }); await d.command(select);
  assert.equal(d.state.operation(select.operationId).state, 'confirmed');
  const stale = control({ action: 'models' }); stale.payload.capabilityRevision = 2; await d.command(stale);
  assert.equal(d.state.operation(stale.operationId).error.code, 'CAPABILITY_CHANGED');
  const compact = control({ action: 'compact' }); await d.command(compact);
  if (type === 'claude') { assert.equal(d.state.operation(compact.operationId).error.code, 'CAPABILITY_UNSUPPORTED'); return; }
  assert.equal(d.state.operation(compact.operationId).state, 'confirmed');
  await until(() => d.state.session(c.sessionId).state === 'completed');
  assert.equal(d.state.session(c.sessionId).turnId, compact.nextTurnId);
  assert.equal(d.state.operation(compact.operationId).result.turnId, compact.nextTurnId);
  const seq = d.state.pending().length; await d.command(compact); assert.equal(d.state.pending().length, seq);
});

test('Daemon separates confirmed acceptance from later native process failure and never retries the prompt', async t => {
  const { daemon: d, create, calls } = await setup(t, 'codex');
  // Fixture accepts start then exits. Acceptance was proven, so the operation is confirmed;
  // the task itself becomes closed, not a successful completed turn.
  const c = create('crash'); await d.command(c); await until(() => d.state.session(c.sessionId).state === 'closed');
  assert.equal(d.state.operation(c.operationId).state, 'confirmed');
  await d.command(c); assert.equal(calls(), 1);
});

test('unknown native model change is journaled, closes only its managed session and never replays', async t => {
  const { daemon: d, create } = await setup(t, 'pi');
  const c = create('complete'); await d.command(c); await until(() => d.state.session(c.sessionId).state === 'completed');
  const plugin = d.active.get(c.sessionId), catalog = await plugin.listModels(); let calls = 0;
  plugin.selectModel = async () => { calls++; throw failure('OPERATION_UNKNOWN', 'fixture timed out after native write', false); };
  const op = { operationId: id('op'), nodeEpoch: 1, deadlineAt: c.deadlineAt, kind: 'native', sessionId: c.sessionId, nextTurnId: null, payload: { expectedTurnId: c.turnId, capabilityRevision: 1, control: { action: 'set_model', modelId: catalog.models[0].id } } };
  await d.command(op); assert.equal(d.state.operation(op.operationId).state, 'unknown');
  assert.equal(d.state.session(c.sessionId).state, 'closed');
  await d.command(op); assert.equal(calls, 1); assert.equal(d.state.operation(op.operationId).state, 'unknown');
});

test('Daemon refuses native slash commands without reserving a new turn or closing an existing session', async t => {
  const { daemon: d, create } = await setup(t, 'pi');
  const c = create('complete'); await d.command(c); await until(() => d.state.session(c.sessionId).state === 'completed');
  const operation = { operationId: id('op'), nodeEpoch: 1, deadlineAt: c.deadlineAt, kind: 'send', sessionId: c.sessionId, nextTurnId: id('t'), payload: { expectedTurnId: c.turnId, text: '/bash delete', mode: 'send', capabilityRevision: 1 } };
  const count = d.state.pending().length; await d.command(operation);
  assert.equal(d.state.operation(operation.operationId).error.code, 'CAPABILITY_UNSUPPORTED');
  assert.equal(d.state.session(c.sessionId).turnId, c.turnId); assert.equal(d.state.session(c.sessionId).state, 'completed'); assert.equal(d.state.pending().length, count);
});

test('all shutdown callers await the same pending native drain', async t => {
  const { daemon: d } = await setup(t, 'pi'); let release;
  d.active.set('closing', { close: () => new Promise(resolve => { release = resolve; }) });
  const first = d.close(), second = d.close(); assert.equal(first, second);
  let done = false; second.then(() => { done = true; }); await Promise.resolve(); assert.equal(done, false);
  release(); await first; assert.equal(done, true);
});

test('late native answer consumption settles unknown journal without repeating the native answer', async t => {
  const { daemon: d, create } = await setup(t, 'codex');
  const plugin = new Plugin({ responseTimeout: 20 }); let writes = 0;
  plugin.open = async () => ({ nativeSessionId: 'late' });
  plugin.start = async (_, turnId) => { plugin.begin(turnId); plugin.ask('late', approval('允许？', 'test'), () => { writes++; }); };
  d.pluginFactory = () => plugin;
  const c = create('late'); await d.command(c);
  const request = d.state.pending().find(f => f.type === 'node.request').data.request;
  const answer = { operationId: id('op'), nodeEpoch: 1, deadlineAt: c.deadlineAt, kind: 'respond', sessionId: c.sessionId, requestId: request.id, payload: { expectedTurnId: c.turnId, capabilityRevision: 1, requestRevision: 1, decision: { kind: 'approval', choiceId: 'allow' } } };
  await d.command(answer); assert.equal(d.state.operation(answer.operationId).state, 'unknown');
  plugin.consumed('late'); assert.equal(d.state.operation(answer.operationId).state, 'confirmed');
  await d.command(answer); assert.equal(writes, 1);
});

test('Workspace queue accepts once, dispatches FIFO after completion and keeps the original receipt', async t => {
  const {daemon:d,create}=await setup(t,'codex');const c=create('hold');await d.command(c);
  const q={operationId:id('op'),nodeEpoch:1,deadlineAt:c.deadlineAt,kind:'send',sessionId:c.sessionId,nextTurnId:id('t'),payload:{expectedTurnId:c.turnId,text:'complete',mode:'queue',capabilityRevision:1}};
  await d.command(validate('NodeCommand',q));const receipt=d.state.operation(q.operationId);
  assert.equal(receipt.state,'confirmed');assert.equal(receipt.result.turnId,c.turnId);assert.equal(d.state.session(c.sessionId).turnId,c.turnId);assert.equal(d.state.session(c.sessionId).queue.length,1);
  await d.command(q);assert.equal(d.state.session(c.sessionId).queue.length,1);
  const plugin=d.active.get(c.sessionId);plugin.onMessage({method:'turn/completed',params:{threadId:plugin.threadId,turn:{id:plugin.nativeTurnId,status:'completed'}}});
  await d.dispatchQueue(c.sessionId);await until(()=>d.state.session(c.sessionId).state==='completed');
  assert.equal(d.state.session(c.sessionId).turnId,q.nextTurnId);assert.equal(d.state.session(c.sessionId).queue.length,0);assert.equal(d.state.operation(q.operationId).dispatchState,'accepted');
  await d.command(q);assert.equal(d.state.operation(q.operationId).result.turnId,c.turnId);assert.equal(d.state.session(c.sessionId).turnId,q.nextTurnId);
});

test('Workspace queued work survives restart as manual with its receipt and never starts again',async t=>{
  const {daemon:d,create}=await setup(t,'codex');const c=create('hold');await d.command(c);
  const q={operationId:id('op'),nodeEpoch:1,deadlineAt:c.deadlineAt,kind:'send',sessionId:c.sessionId,nextTurnId:id('t'),payload:{expectedTurnId:c.turnId,text:'complete',mode:'queue',capabilityRevision:1}};
  await d.command(q);await d.closeSession(c.sessionId);d.state.recover();
  const restored=d.state.session(c.sessionId);assert.equal(restored.state,'closed');assert.equal(restored.queuePolicy,'manual');assert.equal(restored.queue.length,1);assert.equal(d.state.operation(q.operationId).state,'confirmed');
  await d.dispatchQueue(c.sessionId);assert.equal(d.state.session(c.sessionId).turnId,c.turnId);
});

test('Workspace uploads and close use durable commands; closed sessions retain only authorized reads',async t=>{
  const {daemon:d,create}=await setup(t,'codex');const c=create('complete');await d.command(c);await until(()=>d.state.session(c.sessionId).state==='completed');
  const issue=async request=>{const cmd={operationId:id('op'),nodeEpoch:1,deadlineAt:c.deadlineAt,kind:'native',sessionId:c.sessionId,nextTurnId:null,payload:{expectedTurnId:c.turnId,capabilityRevision:1,control:{action:'workspace',request}}};await d.command(validate('NodeCommand',cmd));return {cmd,entry:d.state.operation(cmd.operationId)};};
  const x=await issue({kind:'overview'});assert.equal(x.entry.state,'confirmed');validate('NativeResult',x.entry.result.native);await d.command(x.cmd);assert.equal(d.state.operation(x.cmd.operationId).state,'confirmed');
  const closed=await issue({kind:'close'});assert.equal(closed.entry.state,'confirmed');assert.equal(d.state.session(c.sessionId).state,'closed');
  const files=await issue({kind:'files'});assert.equal(files.entry.state,'confirmed');assert.equal(d.active.has(c.sessionId),false);
  const before=d.state.sessions().length;
  const history=await issue({kind:'history'});assert.equal(history.entry.state,'confirmed');
  assert.ok(history.entry.result.native.view.entries.length);
  const reader=d.workspaces.get(c.sessionId).plugin;
  assert.equal(reader.threadId,undefined);assert.equal(d.active.has(c.sessionId),false);
  assert.equal(d.state.session(c.sessionId).state,'closed');assert.equal(d.state.sessions().length,before);
  const again=await issue({kind:'history'});assert.equal(again.entry.state,'confirmed');assert.equal(d.workspaces.get(c.sessionId).plugin,reader);
  const refused=await issue({kind:'set_queue_policy',value:'automatic'});assert.equal(refused.entry.state,'rejected');assert.equal(refused.entry.error.code,'READ_ONLY');
});

for(const type of ['codex','claude','pi'])test(type+' empty session opens without sending a native prompt',async t=>{
 const {daemon:d,create}=await setup(t,type);let starts=0;
 const factory=d.pluginFactory;d.pluginFactory=(...args)=>{const p=factory(...args);p.start=async()=>{starts++;};return p;};
 const c=create('unused');delete c.payload.prompt;c.payload.historyOnly=true;
 validate('NodeCommand',c);
 await d.command(c);assert.equal(starts,0);assert.equal(d.liveSessions.get(c.sessionId).state,'completed');
 await d.command(c);assert.equal(starts,0);
});

test('owned closed native history resumes without starting a model turn',async t=>{
 const {daemon:d,create}=await setup(t,'codex');let starts=0,opened;
 d.pluginFactory=(_profile,ctx)=>{const p=nativeFixture('codex',ctx);p.open=async()=>{opened=p.options.origin;return {nativeSessionId:opened?'original-native':'browser-native'};};p.start=async()=>{starts++;};return p;};
 const browser=create('');delete browser.payload.prompt;browser.payload.historyOnly=true;await d.command(browser);
 const source={...d.liveSessions.get(browser.sessionId),sessionId:'old',state:'closed',native:{nativeSessionId:'original-native'}};d.state.saveSession(source);
 const w=d.workspaces.get(browser.sessionId),resourceId=w.handles.put('history',{threadId:'original-native',sourceSessionId:'old'});
 w.plugin.resolveOrigin=async()=>({threadId:'original-native',mode:'resume'});
 const resume=create('');delete resume.payload.prompt;resume.payload.historyOnly=true;resume.payload.origin={sessionId:browser.sessionId,sourceSessionId:'old',resourceId,mode:'resume'};
 await d.command(validate('NodeCommand',resume));assert.equal(d.state.operation(resume.operationId).state,'confirmed');assert.deepEqual(opened,{threadId:'original-native',mode:'resume'});assert.equal(starts,0);assert.equal(d.liveSessions.get(resume.sessionId).state,'completed');
 await d.command(resume);assert.equal(starts,0);
});

for(const type of ['codex','pi'])test(type+' in-place resume keeps session and native IDs with no new prompt or session',async t=>{
 const {daemon:d,create}=await setup(t,type);
 if(type==='pi') {
   const {piHistoryDir}=await import('../src/workspace/pi-history.mjs');
   const {mkdir,writeFile}=await import('node:fs/promises');const factory=d.pluginFactory;
   d.pluginFactory=(profile,context)=>factory(profile,{...context,piAgentDir:join(d.config.stateDir,'pi')});
   const p=d.pluginFactory(d.profiles[0],{cwd:d.projects[0].path});const dir=piHistoryDir(p);await mkdir(dir,{recursive:true});
   await writeFile(join(dir,'fixture.jsonl'),JSON.stringify({type:'session',version:3,id:'native_pi',cwd:d.projects[0].path,timestamp:new Date().toISOString()})+'\n');
 }
 const c=create('complete');await d.command(c);await until(()=>d.state.session(c.sessionId).state==='completed');
 await d.closeSession(c.sessionId);
 const before=d.state.sessions().length,source=d.state.session(c.sessionId),native=source.native.nativeSessionId;
 const cmd={operationId:id('op'),nodeEpoch:1,deadlineAt:new Date(Date.now()+10000).toISOString(),kind:'native',sessionId:c.sessionId,nextTurnId:null,payload:{expectedTurnId:source.turnId,capabilityRevision:source.capabilityRevision,control:{action:'workspace',request:{kind:'resume'}}}};
 await d.command(validate('NodeCommand',cmd));assert.equal(d.state.operation(cmd.operationId).state,'confirmed');assert.equal(d.state.sessions().length,before);assert.equal(d.state.session(c.sessionId).native.nativeSessionId,native);assert.equal(d.state.session(c.sessionId).state,'completed');await d.command(cmd);assert.equal(d.state.sessions().length,before);
});
