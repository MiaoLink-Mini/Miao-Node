import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { id } from '../src/common.mjs';
import { until } from '../tests/helpers.mjs';

const base = process.env.WEAGENT_TEST_GATEWAY;
if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Run scripts/test-integration.ps1 with an isolated fixture database');
const directory = mkdtempSync(join(tmpdir(), 'weagent-integration-')), children = [];
let token;
async function api(method, path, body, key, expected = 200, retried = false) {
  const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  if (response.status === 429 && !retried) {
    console.log('Gateway rate limit reached; respecting Retry-After (fixture does not disable production limits).');
    await sleep(Math.min(60000, Math.max(1000, Number(response.headers.get('Retry-After') ?? 60) * 1000)));
    return api(method, path, body, key, expected, true);
  }
  assert.equal(response.status, expected, `${method} ${path}: ${result.error?.code ?? 'unexpected status'}`); return result;
}
function child(dir, fault) {
  const events = [];
  const process = fork(fileURLToPath(new URL('../tests/fixtures/daemon-child.mjs', import.meta.url)), [base, dir, fault ?? ''], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  process.stderr.resume(); process.on('message', m => events.push(m));
  const item = {
    process, events,
    async wait(event) { return until(() => { const index = events.findIndex(e => e.event === event); return index < 0 ? null : events.splice(index, 1)[0]; }, 18000); },
    async stats() { process.send({ type: 'stats' }); return this.wait('stats'); },
    async stop() {
      if (process.exitCode !== null || process.signalCode) return;
      if (process.connected) process.send({ type: 'stop' }); else process.kill();
      try { await until(() => process.exitCode !== null || process.signalCode, 5000); } catch { process.kill(); await until(() => process.exitCode !== null || process.signalCode, 3000); }
    },
  };
  children.push(item); return item;
}
async function pair(node) {
  const pairing = await node.wait('pairing');
  const preview = await api('POST', '/v1/pairings/preview', { code: pairing.code });
  await api('POST', '/v1/pairings/confirm', { ticketId: preview.ticketId }, id('op'));
  const connected = await node.wait('connected');
  await online(connected.nodeId); return connected.nodeId;
}
async function online(nodeId) { await until(async () => (await api('GET', `/v1/nodes/${nodeId}`)).online, 12000); }
async function operation(op, state = 'confirmed') { return until(async () => { const current = await api('GET', `/v1/operations/${op.id}`); if (current.state === 'failed' && state !== 'failed') throw new Error(`operation ${op.kind}: ${current.error.code}`); return current.state === state && current; }, 12000); }
async function sessionState(sessionId, state) { return until(async () => { const s = await api('GET', `/v1/sessions/${sessionId}`); return s.state === state && s; }, 12000); }
async function requestFor(sessionId) { return until(async () => (await api('GET', `/v1/requests?sessionId=${sessionId}`)).items.find(r => r.sessionId === sessionId && r.state === 'pending'), 12000); }

try {
  token = (await api('POST', '/v1/auth/wechat', { code: 'dev:' + id('owner') })).accessToken;
  const dir = join(directory, 'normal'); let node = child(dir); const nodeId = await pair(node);
  const agents = (await api('GET', `/v1/agents?nodeId=${nodeId}`)).items;
  const project = (await api('GET', `/v1/projects?nodeId=${nodeId}`)).items[0];
  assert.equal(agents.length, 3); const completed = [];
  for (const agent of agents) {
    assert.equal(agent.capabilities.queue, true, 'Current adapters expose the durable Node queue');
    const body = { nodeId, projectId: project.id, agentId: agent.id, prompt: 'approval', capabilityRevision: agent.capabilityRevision }, key = id('op');
    const create = await api('POST', '/v1/sessions', body, key, 202);
    const accepted = await operation(create), sessionId = accepted.result.sessionId;
    await sessionState(sessionId, 'waiting_approval'); const approval = await requestFor(sessionId);
    const answer = await api('POST', `/v1/requests/${approval.id}/respond`, { expectedTurnId: approval.turnId, requestRevision: approval.revision, capabilityRevision: agent.capabilityRevision, decision: { kind: 'approval', choiceId: 'deny' } }, id('op'), 202);
    await operation(answer); let session = await sessionState(sessionId, 'completed');
    assert.equal((await api('GET', `/v1/requests/${approval.id}`)).state, 'resolved');
    const duplicate = await api('POST', '/v1/sessions', body, key, 202); assert.equal(duplicate.id, create.id);
    const questionOp = await api('POST', `/v1/sessions/${sessionId}/messages`, { expectedTurnId: session.turnId, capabilityRevision: session.capabilityRevision, text: 'question', mode: 'send' }, id('op'), 202);
    await operation(questionOp); await sessionState(sessionId, 'waiting_input'); const question = await requestFor(sessionId);
    const answers = Object.fromEntries(question.questions.map(q => [q.id, q.type === 'multiple' ? q.options.map(o => o.id) : q.type === 'single' ? q.options[0].id : 'fixture answer']));
    const reply = await api('POST', `/v1/requests/${question.id}/respond`, { expectedTurnId: question.turnId, requestRevision: question.revision, capabilityRevision: session.capabilityRevision, decision: { kind: 'question', answers } }, id('op'), 202);
    await operation(reply); session = await sessionState(sessionId, 'completed');
    const hold = await api('POST', `/v1/sessions/${sessionId}/messages`, { expectedTurnId: session.turnId, capabilityRevision: session.capabilityRevision, text: 'hold', mode: 'send' }, id('op'), 202);
    await operation(hold); session = await sessionState(sessionId, 'running');
    const cancel = await api('POST', `/v1/sessions/${sessionId}/cancel`, { expectedTurnId: session.turnId, capabilityRevision: session.capabilityRevision }, id('op'), 202);
    await operation(cancel); await sessionState(sessionId, 'cancelled');
    const history = await api('GET', `/v1/sessions/${sessionId}/events?after=0&limit=200`);
    assert.ok(history.events.some(e => e.type === 'message.completed'));
    assert.ok(history.events.some(e => e.type === 'request.upsert'));
    completed.push({ sessionId, key, body, operation: create });
    console.log(`PASS Gateway → Node → ${agent.name} native fixture: approval, question, send, cancel, history, idempotency`);
  }
  const before = await node.stats(); assert.equal(before.nativePromptCalls, 9);
  node.process.send({ type: 'disconnect' }); await node.wait('connected'); await online(nodeId);
  assert.equal((await node.stats()).nativePromptCalls, before.nativePromptCalls);
  await until(async () => (await node.stats()).pending === 0);
  await node.stop(); node = child(dir); const reconnected = await node.wait('connected'); assert.equal(reconnected.nodeId, nodeId); await online(nodeId);
  for (const saved of completed) {
    await sessionState(saved.sessionId, 'closed');
    assert.equal((await api('POST', '/v1/sessions', saved.body, saved.key, 202)).id, saved.operation.id);
  }
  assert.equal((await node.stats()).nativePromptCalls, 9);
  console.log('PASS reconnect spool ACK, independent Daemon restart, identity preservation, no native replay');
  const original=completed.find(x=>agents.find(a=>a.id===x.body.agentId)?.name==='codex');
  const closed=await sessionState(original.sessionId,'closed');
  const restoreBody={expectedTurnId:closed.turnId,capabilityRevision:closed.capabilityRevision,control:{action:'workspace',request:{kind:'resume'}}},restoreKey=id('op');
  const restored=await operation(await api('POST','/v1/sessions/'+closed.id+'/native',restoreBody,restoreKey,202));
  const resumed=await sessionState(closed.id,'completed');assert.equal(restored.result.sessionId,closed.id);assert.equal(resumed.turnId,closed.turnId);assert.equal((await node.stats()).nativePromptCalls,9);
  assert.equal((await api('POST','/v1/sessions/'+closed.id+'/native',restoreBody,restoreKey,202)).id,restored.id);
  console.log('PASS original session resumes after Node restart; identical session and turn IDs, no prompt, idempotent');

  for(const agent of agents.filter(a=>a.capabilities.historyImport)){
    const body={nodeId,projectId:project.id,agentId:agent.id,capabilityRevision:agent.capabilityRevision};
    const browserOp=await operation(await api('POST','/v1/sessions',{...body,historyOnly:true},id('op'),202));
    const browser=await sessionState(browserOp.result.sessionId,'completed');
    const count=(await node.stats()).nativePromptCalls;
    const listed=await operation(await api('POST','/v1/sessions/'+browser.id+'/native',{expectedTurnId:browser.turnId,capabilityRevision:browser.capabilityRevision,control:{action:'workspace',request:{kind:'history'}}},id('op'),202));
    const origin=listed.result.native.view.entries.find(e=>e.origin?.mode==='import')?.origin;
    assert.ok(origin,'External native history must be selectable');
    const key=id('op'),payload={...body,prompt:'complete',origin};
    const imported=await operation(await api('POST','/v1/sessions',payload,key,202));
    const session=await sessionState(imported.result.sessionId,'completed');
    assert.notEqual(session.id,browser.id);assert.equal(session.originMode,'import');assert.equal(session.parentSessionId,null);
    assert.equal((await node.stats()).nativePromptCalls,count+1);
    assert.equal((await api('POST','/v1/sessions',payload,key,202)).id,imported.id);
    const duplicate=await operation(await api('POST','/v1/sessions',payload,id('op'),202),'failed');
    assert.equal(duplicate.error.code,'IDEMPOTENCY_CONFLICT');
    assert.equal((await node.stats()).nativePromptCalls,count+1);
    console.log('PASS '+agent.name+' prompt-free history browser, native copy continuation and duplicate import rejection');
  }

  await node.stop();

  const crashDir = join(directory, 'crash'); let crash = child(crashDir, 'after-accept'); const crashNode = await pair(crash);
  const crashAgent = (await api('GET', `/v1/agents?nodeId=${crashNode}`)).items.find(a => a.name === 'codex');
  const crashProject = (await api('GET', `/v1/projects?nodeId=${crashNode}`)).items[0];
  const crashBody = { nodeId: crashNode, projectId: crashProject.id, agentId: crashAgent.id, prompt: 'hold', capabilityRevision: 1 }, crashKey = id('op');
  const uncertain = await api('POST', '/v1/sessions', crashBody, crashKey, 202);
  await crash.wait('fault-after-accept'); await until(() => crash.process.exitCode !== null);
  crash = child(crashDir); await crash.wait('connected'); await online(crashNode);
  await operation(uncertain, 'reconciling');
  assert.equal((await api('POST', '/v1/sessions', crashBody, crashKey, 202)).id, uncertain.id);
  const stats = await crash.stats(); assert.equal(stats.nativePromptCalls, 1); assert.equal(stats.operations.find(o => o.id === uncertain.id).state, 'unknown');
  console.log('PASS native-accepted / journal-unconfirmed crash remains unknown; never retried');
  assert.ok(children.every(c => !c.events.some(e => ['halted', 'gateway-error', 'protocol-conflict'].includes(e.event))), 'No hidden protocol errors');
  console.log('Integration passed: real Go Gateway + PostgreSQL + independent Node processes; no real model prompts.');
} finally {
  await Promise.all(children.map(c => c.stop()));
  rmSync(directory, { recursive: true, force: true });
}
