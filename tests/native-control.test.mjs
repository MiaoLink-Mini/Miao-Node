import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFixture, until } from './helpers.mjs';
import { validate } from '../src/protocol.mjs';

for (const type of ['codex', 'pi', 'claude']) test(`${type}: native catalog, selection and capability fencing`, async t => {
  const plugin = nativeFixture(type); t.after(() => plugin.close()); await plugin.open();
  const result = await plugin.control({ action: 'models' }); validate('NativeResult', result);
  assert.equal(result.models.length, 2); assert.ok(!JSON.stringify(result).includes('NEVER_PUBLISH'));
  await assert.rejects(plugin.control({ action: 'set_model', modelId: 'not-in-catalog' }), { code: 'VALIDATION_FAILED' });
  const chosen = result.models[1].id, receipt = await plugin.control({ action: 'set_model', modelId: chosen });
  validate('NativeResult', receipt); assert.equal(receipt.modelId, chosen); assert.equal(receipt.effect, 'next_turn');
  assert.equal(receipt.applied, type !== 'codex'); assert.equal((await plugin.control({ action: 'models' })).selected, chosen);
  if (type === 'claude') {
    assert.equal(plugin.query.selectedModel, chosen);
    await assert.rejects(plugin.control({ action: 'compact' }, 'compact'), { code: 'CAPABILITY_UNSUPPORTED' });
  }
  if (type === 'codex') {
    const call = plugin.rpc.call.bind(plugin.rpc); let applied;
    plugin.rpc.call = (method, args) => { if (method === 'turn/start') applied = args.model; return call(method, args); };
    await plugin.start('complete', 'turn'); await until(() => !plugin.busy); assert.equal(applied, chosen);
  }
  await plugin.start('hold', 'held');
  for (const action of ['models', 'set_model', 'compact']) await assert.rejects(plugin.control({ action, modelId: chosen }), { code: 'STALE_TURN' });
  await plugin.cancel();
});

for (const type of ['codex', 'pi']) test(`${type}: native compaction has its own turn and a terminal timeline signal`, async t => {
  const plugin = nativeFixture(type), events = []; t.after(() => plugin.close());
  plugin.on('event', e => events.push(e)); await plugin.open(); await plugin.start('complete', 'old'); await until(() => !plugin.busy);
  events.length = 0;
  const pending = plugin.control({ action: 'compact' }, 'compact');
  assert.equal(plugin.busy, true);
  if (type === 'codex') {
    plugin.onMessage({ method: 'turn/completed', params: { threadId: plugin.threadId, turn: { id: plugin.nativeTurnId, status: 'completed' } } });
    assert.equal(plugin.busy, true, 'old completion before compact start must not complete compaction');
  }
  const receipt = await pending; validate('NativeResult', receipt);
  assert.equal(receipt.status, type === 'codex' ? 'started' : 'completed');
  await until(() => !plugin.busy);
  assert.ok(events.some(e => e.state === 'completed'));
  assert.ok(events.some(e => e.data?.title === '压缩上下文' && e.data.state === 'completed' && e.data.turnId === 'compact'));
  assert.ok(!events.some(e => e.type === 'message.completed' && e.data.role === 'user'));
});

test('native controls are typed; arbitrary RPC, file/config paths and attachments stay rejected', () => {
  const body = control => ({ expectedTurnId: 'turn', capabilityRevision: 1, control });
  for (const control of [{ action: 'fs/readFile', path: 'C:/secret' }, { action: 'set_model', modelId: 'x', configPath: 'x' }, { action: 'compact', command: '/compact' }, { action: 'models', attachments: [] }]) assert.throws(() => validate('NativeControl', body(control)));
});
