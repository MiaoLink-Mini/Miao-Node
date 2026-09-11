// Independent deterministic native wire fixture. It never invokes a model or a shell.
import { readFileSync, realpathSync } from 'node:fs';
import { JsonLines } from '../../src/native-rpc.mjs';
const mode = process.argv[2];
if (process.argv.includes('--version')) { console.log(mode === 'codex' ? '0.153.4' : '0.85.0'); process.exit(0); }
// Model only the explicitly selected fixture session. Never inspect user history.
let piSessionId = 'native_pi';
const sessionArgument = process.argv.indexOf('--session');
if (mode === 'pi' && sessionArgument !== -1) {
  const sessionPath = process.argv[sessionArgument + 1];
  if (!sessionPath) throw new Error('Missing fixture --session path');
  const header = JSON.parse(readFileSync(sessionPath, 'utf8').split('\n')[0]);
  if (header.type !== 'session' || header.version !== 3 || typeof header.id !== 'string' ||
      realpathSync(header.cwd) !== realpathSync(process.cwd())) {
    throw new Error('Invalid or foreign Pi fixture session');
  }
  piSessionId = header.id;
}
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
let threadId = 'native_thread';
let turn = 0, current, pending, selectedModel = 'fixture-model';
const notify = (method, params) => send({ method, params: { threadId, ...params } });
function complete() {
  if (mode === 'codex') {
    notify('item/agentMessage/delta', { itemId: 'a' + turn, delta: 'hello\u2028世界', turnId: current });
    notify('item/completed', { item: { type: 'agentMessage', id: 'a' + turn, text: 'hello\u2028世界' }, turnId: current });
    notify('turn/plan/updated', { plan: [{ step: '检查实现', status: 'completed' }], turnId: current });
    notify('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 12, outputTokens: 8 } }, turnId: current });
    notify('item/completed', { item: { id: 'file' + turn, type: 'fileChange', status: 'completed', changes: [{ path: 'src/test.js', diff: '@@ -1 +1 @@\n-old\n+new' }, { path: '../secret', diff: 'must not publish' }] }, turnId: current });
    notify('turn/completed', { turn: { id: current, status: 'completed' } });
  } else {
    send({ type: 'message_start', message: { role: 'assistant' } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello\u2028世界' } });
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hello\u2028世界' }], stopReason: 'stop', usage: { input: 10, output: 5, cost: { total: 0.001 } } } });
    send({ type: 'agent_end', messages: [], willRetry: false });
    setTimeout(() => send({ type: 'agent_settled' }), 20);
  }
}
function start(text) {
  if (text === 'crash') { process.exit(17); }
  if (text === 'hold') return;
  if (['approval', 'question'].includes(text)) {
    pending = { id: 'native_request', item: 'tool' + turn, nonce: 'nonce' + turn, kind: text };
    if (mode === 'codex') send({ id: pending.id, method: text === 'approval' ? 'item/commandExecution/requestApproval' : 'item/tool/requestUserInput', params: { itemId: pending.item, threadId, turnId: current, command: 'echo fixture', isBlocking: true, questions: [{ id: 'native-q', header: '策略', question: '保留哪些内容？', options: [{ label: '保留历史', description: '保留历史和草稿' }, { label: '只留草稿', description: '' }] }] } });
    else send({ type: 'extension_ui_request', method: 'select', id: pending.id, title: JSON.stringify({ weagent: 1, nonce: pending.nonce, kind: text, title: '测试请求', summary: 'echo fixture' }), options: text === 'approval' ? ['仅允许本次', '拒绝'] : ['保留历史', '只留草稿'] });
  } else complete();
}
const parser = new JsonLines(m => {
  if (mode === 'codex') {
    const ok = result => send({ id: m.id, result });
    if (m.method === 'initialize') ok({ userAgent: 'fixture' });
    if (m.method === 'thread/list') ok({data:m.params.archived?[]:[{id:'external_thread',cwd:process.cwd(),updatedAt:1,cliVersion:'fixture',preview:'Local history',status:{type:'idle'}}],nextCursor:null});
    if (m.method === 'thread/read') ok({thread:{id:m.params.threadId,cwd:process.cwd(),updatedAt:1,status:{type:'idle'},turns:[]}});
    if (m.method === 'thread/resume') {threadId=m.params.threadId;ok({thread:{id:threadId},model:selectedModel});}
    if (m.method === 'thread/fork') {threadId='imported_thread';ok({thread:{id:threadId},model:selectedModel});}
    if (m.method === 'thread/start') ok({ thread: { id: 'native_thread' }, model: selectedModel });
    if (m.method === 'model/list') ok({ data: [{ model: 'fixture-model', displayName: 'Fixture model', hidden: false, apiKey: 'NEVER_PUBLISH' }, { model: 'fixture-next', displayName: 'Fixture next', hidden: false }], nextCursor: null });
    if (m.method === 'thread/compact/start') { current = 'native_turn_' + ++turn; notify('turn/started', { turn: { id: current } }); ok({}); setTimeout(() => notify('turn/completed', { turn: { id: current, status: 'completed' } }), 80); }
    if (m.method === 'turn/start') { current = 'native_turn_' + ++turn; ok({ turn: { id: current, status: 'inProgress' } }); notify('turn/started', { turn: { id: current } }); start(m.params.input[0].text); }
    if (m.method === 'turn/interrupt') { ok({}); notify('turn/completed', { turn: { id: current, status: 'interrupted' } }); }
    if (!m.method && m.id === pending?.id) {
      const p = pending; pending = null;
      notify('serverRequest/resolved', { requestId: p.id });
      notify('item/completed', { item: { id: p.item, type: 'commandExecution', command: 'echo fixture', status: 'completed', aggregatedOutput: 'fixture tool done' } });
      complete();
    }
  } else {
    const ok = data => send({ id: m.id, type: 'response', command: m.type, success: true, ...(data ? { data } : {}) });
    if (m.type === 'get_available_models') ok({ models: [{ id: 'fixture-model', name: 'Fixture model', provider: 'fixture', apiKey: 'NEVER_PUBLISH' }, { id: 'fixture-next', name: 'Fixture next', provider: 'fixture' }] });
    if (m.type === 'set_model') { selectedModel = m.modelId; ok({ id: selectedModel, provider: m.provider }); }
    if (m.type === 'compact') setTimeout(() => ok({ summary: 'fixture compaction', tokensBefore: 100 }), 80);
    if (m.type === 'get_state') ok({ sessionId: piSessionId, isStreaming: false, pendingMessageCount: 0 });
    if (m.type === 'prompt') { turn++; ok(); start(m.message); }
    if (m.type === 'abort') { send({ type: 'agent_settled' }); ok(); }
    if (m.type === 'extension_ui_response' && m.id === pending?.id) {
      const p = pending; pending = null;
      send({ type: 'extension_ui_request', id: 'receipt', method: 'notify', message: JSON.stringify({ weagent: 1, event: 'decision', nonce: p.nonce, received: !m.cancelled }) });
      send({ type: 'tool_execution_end', toolCallId: p.item, toolName: 'fixture', result: { content: [{ type: 'text', text: 'answered' }] }, isError: false }); complete();
    }
  }
});
if (mode === 'pi') send({ type: 'extension_ui_request', id: 'ready', method: 'notify', message: JSON.stringify({ weagent: 1, event: 'ready', version: 1 }) });
process.stdin.on('data', chunk => parser.push(chunk));
process.stdin.on('end', () => process.exit(0));
