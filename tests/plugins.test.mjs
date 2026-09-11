import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFixture, until } from './helpers.mjs';
import { validate } from '../src/protocol.mjs';
import { Plugin, approval, questions } from '../src/plugins/base.mjs';
import { deferred } from '../src/common.mjs';
import piExtension from '../plugins/pi/weagent-extension.mjs';
test('Codex context occupancy uses the last request, not cumulative usage',async()=>{
 const {CodexPlugin}=await import('../src/plugins/codex.mjs');
 const plugin=new CodexPlugin({cwd:process.cwd()});plugin.busy=true;let args;plugin.usage=(...value)=>args=value;
 plugin.onMessage({method:'thread/tokenUsage/updated',params:{tokenUsage:{last:{inputTokens:20,outputTokens:5,totalTokens:25},total:{totalTokens:99999},modelContextWindow:100}}});
 assert.deepEqual(args.slice(1),[20,5,undefined,{used:25,limit:100}]);
});

for (const type of ['codex', 'pi', 'claude']) {
  test(`${type}: handshake, streaming, timeline, next turn and cancel`, async t => {
    const plugin = nativeFixture(type), events = [];
    t.after(() => plugin.close()); plugin.on('event', e => events.push(e));
    const init = await plugin.open(); assert.ok(init.nativeSessionId);
    await plugin.start('complete', 't1'); await until(() => events.some(e => e.kind === 'state' && e.state === 'completed'));
    assert.ok(events.some(e => e.type === 'message.delta'));
    assert.ok(events.some(e => e.type === 'message.completed'));
    assert.ok(events.some(e => e.data?.type === 'usage'));
    for (const event of events.filter(e => e.kind === 'event')) validate('NodeEvent', { sourceEventId: 'source', sourceSequence: 1, sessionId: 's1', turnId: 't1', type: event.type, data: event.data });
    assert.ok(!JSON.stringify(events).includes('../secret'));
    events.length = 0; await plugin.start('hold', 't2'); await plugin.cancel();
    await until(() => events.some(e => e.state === 'cancelled'));
  });
  for (const kind of ['approval', 'question']) test(`${type}: ${kind} waits for a real consumption signal`, async t => {
    const plugin = nativeFixture(type), events = []; t.after(() => plugin.close());
    plugin.on('event', e => events.push(e)); await plugin.open(); await plugin.start(kind, 't1');
    const request = await until(() => events.find(e => e.kind === 'request'));
    validate('NodeRequest', { ...request.definition, id: request.requestId, sessionId: 's1', turnId: 't1', createdAt: new Date().toISOString(), expiresAt: request.expiresAt });
    const decision = kind === 'approval' ? { kind, choiceId: 'deny' } : { kind, answers: { q0: type === 'claude' ? ['o0', 'o1'] : 'o1' } };
    await plugin.respond(request.requestId, decision);
    assert.ok(events.some(e => e.kind === 'request-consumed' && e.requestId === request.requestId));
    await until(() => events.some(e => e.state === 'completed'));
    await assert.rejects(plugin.respond(request.requestId, decision), { code: 'REQUEST_EXPIRED' });
  });
}

test('response is unknown after a write without native consumption, and cannot be replayed', async () => {
  const plugin = new Plugin({ responseTimeout: 25 }); plugin.begin('t1'); let writes = 0;
  const entry = plugin.ask('native', approval('允许？', 'test'), () => { writes++; });
  await assert.rejects(plugin.respond(entry.requestId, { kind: 'approval', choiceId: 'allow' }), { code: 'OPERATION_UNKNOWN' });
  await assert.rejects(plugin.respond(entry.requestId, { kind: 'approval', choiceId: 'allow' }), { code: 'REQUEST_ALREADY_DECIDED' });
  assert.equal(writes, 1); await plugin.close();
});

test('cancelled native request must not count as a submitted answer receipt', async () => {
  const plugin = new Plugin({ responseTimeout: 40 }); plugin.begin('t1');
  const entry = plugin.ask('native', approval('允许？', 'test'), () => {});
  const reply = plugin.respond(entry.requestId, { kind: 'approval', choiceId: 'allow' });
  plugin.cancelling = true; plugin.consumed('native'); plugin.withdraw('native', '取消');
  await assert.rejects(reply, { code: 'OPERATION_UNKNOWN' }); await plugin.close();
});

test('question mapping preserves native labels; private/oversized questions fail closed', () => {
  const q = questions([{ id: 'native id with spaces', question: '选择', options: [{ label: 'A / B' }, { label: '中文' }] }]);
  assert.equal(q.decode({ answers: { q0: 'o1' } })[0].values[0], '中文');
  assert.throws(() => questions([{ question: 'password', isSecret: true }]), { code: 'CAPABILITY_UNSUPPORTED' });
  assert.throws(() => questions([{ question: 'many', options: Array(21).fill('x') }]), { code: 'CAPABILITY_UNSUPPORTED' });
});

test('Pi extension is fail-closed on denial, timeout and oversized commands; registers question tool', async () => {
  const hooks = {}, tools = [], notices = []; let value = '拒绝';
  piExtension({ on: (name, fn) => { hooks[name] = fn; }, registerTool: tool => tools.push(tool) });
  const ctx = { ui: { select: async () => value, input: async () => value, notify: message => notices.push(JSON.parse(message)) } };
  assert.equal((await hooks.tool_call({ toolName: 'bash', toolCallId: 't', input: { command: 'echo fixture' } }, ctx)).block, true);
  value = undefined;
  assert.equal((await hooks.tool_call({ toolName: 'write', input: { path: 'x', content: 'y' } }, ctx)).block, true);
  value = '仅允许本次';
  assert.equal(await hooks.tool_call({ toolName: 'bash', input: { command: 'echo fixture' } }, ctx), undefined);
  assert.equal((await hooks.tool_call({ toolName: 'bash', input: { command: 'x'.repeat(4001) } }, ctx)).block, true);
  const q = tools.find(t => t.name === 'weagent_question'); assert.ok(q);
  value = '保留历史'; const result = await q.execute('q', { question: '恢复策略？' }, new AbortController().signal, null, ctx);
  assert.equal(result.content[0].text, value); assert.ok(notices.some(n => n.received === false));
});

test('Pi does not complete at agent_end while native retries may still run', () => {
  const plugin = nativeFixture('pi'); const events = []; plugin.on('event', e => events.push(e));
  plugin.begin('t'); plugin.finalState = 'completed'; plugin.onMessage({ type: 'agent_end', willRetry: false });
  assert.equal(events.length, 0); plugin.onMessage({ type: 'agent_settled' }); assert.equal(events[0].state, 'completed');
});

test('Codex ignores delayed output and completion belonging to the previous native turn', () => {
  const plugin = nativeFixture('codex'), events = [];
  plugin.on('event', e => events.push(e)); plugin.threadId = 'thread'; plugin.nativeTurnId = 'new'; plugin.begin('public_new');
  plugin.onMessage({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'old', itemId: 'i', delta: 'late output' } });
  plugin.onMessage({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'old', status: 'completed' } } });
  assert.equal(events.length, 0); assert.equal(plugin.busy, true);
  plugin.onMessage({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'new', itemId: 'i', delta: 'current output' } });
  assert.equal(events.length, 1);
});

test('Codex raw new/deleted files become counted patches; updates count header-like content',async()=>{
 const {CodexPlugin}=await import('../src/plugins/codex.mjs');
 for(const [kind,diff,added,removed] of [['add','<html>\r\n\r\n</html>\r\n',3,0],['add','',0,0],['delete','old\nline',0,2],['update','--- a/x\n+++ b/x\n@@ -1 +1 @@\n---old\n+++new',1,1],['add','x\n'.repeat(25000),25000,0]]){
  const p=new CodexPlugin({cwd:process.cwd(),sessionId:'s'}),events=[];let item;
  p.publish=e=>events.push(e);p.item=(_,v)=>item=v;
  p.diff({id:'change',changes:[{path:'index.html',kind:{type:kind},diff}]});
  assert.equal(item.files[0].added,added);assert.equal(item.files[0].removed,removed);
  if(kind==='add')assert.ok(events[0].data.patch.startsWith('@@ -0,0 +'));
  if(added===25000)assert.equal(events[0].data.truncated,true);
 }
});

test('Codex usage accumulates all model calls without historical tokens or duplicate billing',async()=>{
 const {CodexPlugin}=await import('../src/plugins/codex.mjs');const p=new CodexPlugin({});p.selectedModel='gpt-5.6-sol';const values=[];p.usage=(...v)=>values.push(v);p.begin('one');
 const send=(input,output,lastInput,lastOutput)=>p.reportUsage({total:{inputTokens:input,outputTokens:output},last:{inputTokens:lastInput,outputTokens:lastOutput,totalTokens:lastInput+lastOutput},modelContextWindow:10000});
 send(1100,110,100,10);send(1300,130,200,20);const cost=values.at(-1)[3];send(1300,130,200,20);
 assert.deepEqual(values.at(-1).slice(1,3),[300,30]);assert.equal(values.at(-1)[3],cost);assert.equal(values.at(-1)[4].used,220);
 p.busy=false;p.begin('two');send(1350,135,50,5);assert.deepEqual(values.at(-1).slice(1,3),[50,5]);
 send(1300,130,200,20);assert.deepEqual(values.at(-1).slice(1,3),[50,5]);
});
