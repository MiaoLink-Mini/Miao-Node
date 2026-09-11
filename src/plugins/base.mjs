import { EventEmitter } from 'node:events';
import { relative, isAbsolute } from 'node:path';
import { bounded, cut, deferred, digest, failure, id } from '../common.mjs';

export class Plugin extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = options; this.requests = new Map(); this.messages = new Map(); this.busy = false; this.closing = false;
  }
  publish(event) { this.emit('event', event); }
  validateControl(control) {
    if (this.busy) throw failure('STALE_TURN', '请等待原生 Agent 空闲');
    const key = control.action === 'compact' ? 'compact' : 'models';
    if (!['models', 'set_model', 'compact'].includes(control.action) || !this.constructor.capabilities?.[key]) throw failure('CAPABILITY_UNSUPPORTED', '原生运行时未开放此能力');
  }
  catalog(entries, truncated = false) {
    // Explicit projection: never return provider objects, endpoints or account credentials.
    const valid = entries.filter(m => typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 200 && typeof m.label === 'string' && m.label.length > 0);
    this.modelCatalog = new Map(valid.slice(0, 100).map(m => [m.id, m]));
    return { action: 'models', models: [...this.modelCatalog.values()].map(m => ({ id: m.id, label: cut(m.label, 200), ...(m.input ? { input: m.input } : {}), ...(m.thinking ? { thinking: m.thinking } : {}), ...(m.inputEvidence ? { inputEvidence: m.inputEvidence } : {}) })), selected: this.selectedModel ?? null, truncated: truncated || valid.length > 100 };
  }
  async control(control, turnId) {
    this.validateControl(control);
    if (control.action === 'compact') return this.compact(turnId);
    const catalog = await this.listModels();
    if (control.action === 'models') return catalog;
    const model = this.modelCatalog.get(control.modelId);
    if (!model) throw failure('VALIDATION_FAILED', '模型不在当前原生运行时目录中，请刷新');
    const applied = await this.selectModel(model);
    this.selectedModel = model.id;
    return { action: 'set_model', modelId: model.id, effect: 'next_turn', applied };
  }
  validatePrompt(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw failure('VALIDATION_FAILED', '任务文本必须为 1–4000 字符');
  }
  begin(turnId) {
    if (this.busy) throw failure('STALE_TURN', '原生 Agent 正忙');
    this.turnId = turnId; this.busy = true; this.cancelling = false; this.failed = false; this.messages.clear();
  }
  itemId(nativeId) { return `item_${digest([this.turnId, String(nativeId)]).slice(0, 40)}`; }
  message(nativeId, text, complete = false) {
    const itemId = this.itemId(nativeId), old = this.messages.get(itemId) ?? '';
    const clean = cut(text), next = complete ? clean : cut(old + clean);
    this.messages.set(itemId, next);
    if (complete) this.publish({ kind: 'event', type: 'message.completed', data: { itemId, role: 'assistant', text: next, truncated: String(text).length > 48000 || old.length === 48000 } });
    else {
      const delta = next.slice(old.length);
      for (let i = 0; i < delta.length; i += 4096) this.publish({ kind: 'event', type: 'message.delta', data: { itemId, role: 'assistant', text: delta.slice(i, i + 4096) } });
    }
  }
  item(nativeId, body) { this.publish({ kind: 'event', type: 'item.upsert', data: { ...body, itemId: this.itemId(nativeId), turnId: this.turnId } }); }
  tool(nativeId, title, state, summary = '', output = null) {
    this.item(nativeId, { type: 'tool', title: cut(title, 200), state, summary: cut(summary, 4000), output: output === null ? null : cut(output), truncated: String(output ?? '').length > 48000 });
  }
  usage(nativeId, input, output, cost, context) {
    const number = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
    this.item(nativeId, { type: 'usage', inputTokens: number(input), outputTokens: number(output), cost: Number.isFinite(cost) && cost >= 0 ? { amount: cost.toFixed(8), currency: 'USD' } : null,
      ...(context ? {contextUsedTokens:number(context.used),contextWindowTokens:number(context.limit)} : {}) });
  }
  displayPath(path) {
    const result = (isAbsolute(path) ? relative(this.options.cwd, path) : path).replaceAll('\\', '/');
    if (!result || result.length > 1000 || result.startsWith('/') || result.includes(':') || result.split('/').some(x => x === '..' || x === '.' || !x)) return null;
    return result;
  }
  ask(key, definition, reply, { timeout = 30 * 60 * 1000, cancel } = {}) {
    if (this.requests.has(key)) throw failure('SOURCE_CONFLICT', '原生请求关联 ID 在待处理期间被复用', false);
    if (this.requests.size >= 20) throw failure('SERVICE_UNAVAILABLE', '并发交互请求过多', false);
    const requestId = id('req'), entry = { key, requestId, definition, reply, cancel, sent: false, done: deferred() };
    entry.expires = Date.now() + Math.min(Math.max(timeout, 1), 30 * 60 * 1000);
    entry.timer = setTimeout(() => this.withdraw(key, '原生请求已到期'), entry.expires - Date.now());
    entry.timer.unref(); this.requests.set(key, entry);
    this.publish({ kind: 'request', requestId, definition, expiresAt: new Date(entry.expires).toISOString() });
    return entry;
  }
  async respond(requestId, decision) {
    const entry = [...this.requests.values()].find(x => x.requestId === requestId);
    if (!entry || Date.now() >= entry.expires) throw failure('REQUEST_EXPIRED', '原生请求已失效');
    if (entry.sent) throw failure('REQUEST_ALREADY_DECIDED', '原生回答已经提交');
    validateDecision(entry.definition, decision);
    entry.sent = true;
    await entry.reply(decision);
    // A successful write is not acceptance. Each adapter resolves this using native evidence.
    await bounded(entry.done.promise, this.options.responseTimeout ?? 30000);
  }
  consumed(key) {
    const entry = this.requests.get(key);
    if (!entry?.sent || this.cancelling) return;
    clearTimeout(entry.timer); this.requests.delete(key); entry.done.resolve();
    this.publish({ kind: 'request-consumed', requestId: entry.requestId });
  }
  withdraw(key, reason) {
    const entry = this.requests.get(key); if (!entry) return;
    clearTimeout(entry.timer); this.requests.delete(key);
    try { entry.cancel?.(); } catch { /* Closed native transport. */ }
    entry.done.reject(failure('OPERATION_UNKNOWN', '原生请求已被清理，无法确认回答', false));
    this.publish({ kind: 'request-cancelled', requestId: entry.requestId, reason });
  }
  finish(state) {
    if (!this.busy) return;
    for (const key of [...this.requests.keys()]) this.withdraw(key, '本轮已结束');
    this.busy = false; this.publish({ kind: 'state', state });
  }
  fault() {
    if (this.closing) return;
    const wasBusy = this.busy;
    this.finish('closed');
    if (!wasBusy) this.publish({ kind: 'state', state: 'closed' });
  }
  async close() {
    this.closing = true;
    for (const key of [...this.requests.keys()]) this.withdraw(key, '会话已关闭');
    await this.rpc?.close();
  }
}

export const approval = (title, summary, action = '执行工具', scope = '') => ({
  kind: 'approval', title: cut(title, 200) || '工具执行确认', summary: cut(summary, 4000), action: cut(action, 200), scope: cut(scope, 1000),
  choices: [{ id: 'allow', label: '仅允许本次' }, { id: 'deny', label: '拒绝' }],
});

// Public IDs never depend on labels (native labels may contain punctuation or secrets).
export function questions(nativeQuestions) {
  if (!Array.isArray(nativeQuestions) || !nativeQuestions.length || nativeQuestions.length > 20 || nativeQuestions.some(q => q.isSecret)) throw failure('CAPABILITY_UNSUPPORTED', '此原生问题不能通过公开移动端回答');
  const mapping = nativeQuestions.map((q, i) => ({ native: q, id: `q${i}`, choices: (q.options ?? []).map((o, j) => ({ id: `o${j}`, label: typeof o === 'string' ? o : o.label })) }));
  if (mapping.some(q => q.choices.length > 20 || q.choices.some(c => !c.label || c.label.length > 160))) throw failure('CAPABILITY_UNSUPPORTED', '原生问题选项超出公开契约');
  return {
    definition: { kind: 'question', title: cut(nativeQuestions[0].header ?? 'Agent 提问', 200) || 'Agent 提问', summary: '', questions: mapping.map(q => {
      const common = { id: q.id, label: cut(q.native.question ?? q.native.title, 500) || '请输入回答', required: true };
      if (!q.choices.length || q.native.isOther) return { ...common, type: 'text', maxLength: 4000 };
      return { ...common, type: q.native.multiSelect ? 'multiple' : 'single', options: q.choices, ...(q.native.multiSelect ? { max: q.choices.length } : {}) };
    }) },
    decode(decision) {
      return mapping.map(q => {
        const value = decision.answers[q.id];
        const translate = v => q.native.isOther ? v : (q.choices.find(c => c.id === v)?.label ?? v);
        return { native: q.native, values: (Array.isArray(value) ? value : [value]).map(translate) };
      });
    },
  };
}

export function validateDecision(definition, decision) {
  if (definition.kind !== decision.kind) throw failure('VALIDATION_FAILED', '回答类型不匹配');
  if (definition.kind === 'approval') {
    if (!definition.choices.some(c => c.id === decision.choiceId)) throw failure('VALIDATION_FAILED', '审批选项无效');
    return;
  }
  const answers = decision.answers;
  if (!answers || Object.keys(answers).some(k => !definition.questions.some(q => q.id === k))) throw failure('VALIDATION_FAILED', '回答包含未知问题');
  for (const q of definition.questions) {
    const value = answers[q.id];
    if (q.type === 'text') {
      if (typeof value !== 'string' || value.length > q.maxLength || q.required && !value.trim()) throw failure('VALIDATION_FAILED', '文本回答无效');
    } else if (q.type === 'single') {
      if (typeof value !== 'string' || !q.options.some(o => o.id === value)) throw failure('VALIDATION_FAILED', '单选回答无效');
    } else if (!Array.isArray(value) || value.length > q.max || q.required && !value.length || new Set(value).size !== value.length || value.some(v => !q.options.some(o => o.id === v))) throw failure('VALIDATION_FAILED', '多选回答无效');
  }
}
