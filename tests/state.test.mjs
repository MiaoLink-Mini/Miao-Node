import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../src/state.mjs';
import { JsonLines } from '../src/native-rpc.mjs';
import { validate } from '../src/protocol.mjs';

function fixture(t, options) { const dir = mkdtempSync(join(tmpdir(), 'weagent-state-')); const state = new State(dir, options); t.after(() => { if (state.db) state.close(); rmSync(dir, { recursive: true, force: true }); }); return { state, dir }; }
const command = { operationId: 'op1', nodeEpoch: 1, deadlineAt: '2026-09-07T00:00:00Z', kind: 'create', sessionId: 's1', turnId: 't1', payload: {} };

test('recovery settles only interrupted read-only queries, preserving uncertain writes', t=>{
 const {state}=fixture(t);
 for(const kind of ['extensions','reload_extensions','resume','not_registered']) {
  const cmd={...command,operationId:kind,kind:'native',payload:{control:{action:'workspace',request:{kind}}}};
  const {entry}=state.receive(cmd);entry.state='unknown';state.saveOperation(entry);
 }
 state.recover();assert.equal(state.operation('extensions').state,'rejected');assert.equal(state.operation('extensions').error.code,'SERVICE_UNAVAILABLE');
 for(const kind of ['reload_extensions','resume','not_registered'])assert.equal(state.operation(kind).state,'unknown');
});

test('durable journal duplicate/conflict, executing crash window and exclusive lock', t => {
  const { state, dir } = fixture(t);
  const first = state.receive(command); assert.equal(first.fresh, true); assert.equal(first.entry.state, 'delivered');
  assert.equal(state.receive({ ...command, nodeEpoch: 2 }).fresh, false);
  assert.throws(() => state.receive({ ...command, turnId: 't2' }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => new State(dir), /另一个 Daemon/);
  first.entry.state = 'executing'; state.saveOperation(first.entry); state.saveSession({ sessionId: 's1', state: 'running' }); state.close();
  const next = new State(dir); next.recover(); assert.equal(next.operation('op1').state, 'unknown'); assert.equal(next.session('s1').state, 'closed'); next.close();
});

test('source sequence is continuous, stable through reconnect and only pruned by valid ACK', t => {
  const { state, dir } = fixture(t); state.saveSession({ sessionId: 's1', state: 'running' });
  const body = { sessionId: 's1', turnId: 't1', type: 'message.completed', data: { itemId: 'm1', role: 'assistant', text: 'hello', truncated: false } };
  state.append('s1', 'node.events', body, f => validate('NodeToGatewayFrame', f));
  const initial = state.pending(); state.close(); const next = new State(dir);
  assert.deepEqual(next.pending(), initial); next.append('s1', 'node.events', body); assert.equal(next.pending()[1].data.events[0].sourceSequence, 2);
  assert.throws(() => next.ack('s1', 3), { code: 'SOURCE_CONFLICT' }); assert.equal(next.pending().length, 2);
  next.ack('s1', 1); assert.equal(next.pending().length, 1); next.ack('s1', 0); assert.equal(next.pending().length, 1); next.close();
});

test('quota failure rolls back source sequence; full journal does not accept delivered', t => {
  const { state } = fixture(t, { maxSpoolBytes: 350, maxJournal: 1 }); state.saveSession({ sessionId: 's1' });
  state.append('s1', 'node.session', { small: true });
  assert.throws(() => state.append('s1', 'node.session', { large: 'x'.repeat(400) }), { code: 'SERVICE_UNAVAILABLE' });
  assert.equal(state.db.prepare('SELECT seq FROM sessions').get().seq, 1); assert.equal(state.pending().length, 1);
  state.receive(command); assert.throws(() => state.receive({ ...command, operationId: 'op2' }), { code: 'SERVICE_UNAVAILABLE' }); assert.equal(state.operation('op2'), undefined);
});

test('missing initialized database cannot produce a new identity or not_seen', t => {
  const { state, dir } = fixture(t); state.set('identity', { test: true }); state.markInitialized(); state.close(); unlinkSync(join(dir, 'state.sqlite'));
  assert.throws(() => new State(dir), /journal 丢失/);
});

test('JSONL handles CRLF, split UTF-8 and U+2028; rejects oversized, malformed or truncated records', () => {
  const values = [], parser = new JsonLines(v => values.push(v), 100);
  const bytes = Buffer.from('{"text":"中\u2028文"}\r\n{"x":2}\n');
  for (const byte of bytes) parser.push(Buffer.from([byte])); parser.end();
  assert.deepEqual(values, [{ text: '中\u2028文' }, { x: 2 }]);
  assert.throws(() => new JsonLines(() => {}, 3).push(Buffer.from('1234')), { code: 'PAYLOAD_TOO_LARGE' });
  assert.throws(() => new JsonLines(() => {}).push(Buffer.from('{bad}\n')));
  const broken = new JsonLines(() => {}); broken.push(Buffer.from('{}')); assert.throws(() => broken.end(), { code: 'PROTOCOL_UNSUPPORTED' });
});

test('R03: recovery clears requests on active and already-closed legacy sessions, without changing spool or receipts', t => {
  const { state } = fixture(t);
  for (const [index, status] of ['running', 'waiting_input', 'closed'].entries()) {
    state.saveSession({ sessionId: `s${index}`, state: status, requests: { pending: { nativeId: 'native_1', expiresAt: '2099-01-01T00:00:00Z' } }, request: null, capabilityRevision: 7 });
    state.append(`s${index}`, 'node.session', { source: true });
  }
  const saved = state.pending();
  for (const [index, status] of ['delivered', 'executing', 'confirmed', 'failed', 'unknown'].entries()) {
    const entry = state.receive({ ...command, operationId: `op_${index}` }).entry; entry.state = status; state.saveOperation(entry);
  }
  state.recover();
  for (const session of state.sessions()) {
    assert.equal(session.state, 'closed'); assert.deepEqual(session.requests, {});
    assert.equal(Object.hasOwn(session, 'request'), false); assert.equal(session.capabilityRevision, 7);
  }
  assert.deepEqual(state.pending(), saved);
  assert.deepEqual(Array.from({ length: 5 }, (_, index) => state.operation(`op_${index}`).state), ['unknown', 'unknown', 'confirmed', 'failed', 'unknown']);
  const recovered = state.sessions(); state.recover(); assert.deepEqual(state.sessions(), recovered);
});
