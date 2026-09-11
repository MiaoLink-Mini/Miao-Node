import { permissionQuestion } from '../workspace/codex-permissions.mjs';
import { estimateCodexCost } from '../pricing.mjs';
import { codexSections, codexWorkspace, codexOrigin, codexInput, observeCodex } from '../workspace/codex.mjs';
import { Plugin, approval, questions } from './base.mjs';
import { NativeRPC } from '../native-rpc.mjs';
import { realpath } from 'node:fs/promises';
import { capabilities, cut, failure, id, now } from '../common.mjs';

export class CodexPlugin extends Plugin {
  begin(turnId) {
    super.begin(turnId);
    this.usageBase = this.lastUsageTotal ? {...this.lastUsageTotal} : null;
    this.usagePrevious = this.usageBase;
    this.usageCost = 0;
    this.usageCostKnown = true;
  }
  reportUsage(value) {
    const last=value.last??{},total=value.total;
    const keys=['inputTokens','outputTokens','cachedInputTokens','cacheWriteInputTokens'];
    const valid=u=>u&&['inputTokens','outputTokens'].every(k=>Number.isSafeInteger(u[k])&&u[k]>=0);
    let usage=last,cost=estimateCodexCost(this.selectedModel,last);
    if(valid(total)&&valid(last)) {
      if(!this.usageBase) this.usageBase=Object.fromEntries(keys.map(k=>[k,Math.max(0,(total[k]??0)-(last[k]??0))]));
      const previous=this.usagePrevious??this.usageBase;
      // Ignore duplicate or regressive cumulative snapshots, never double bill.
      if(total.inputTokens<previous.inputTokens||total.outputTokens<previous.outputTokens)return;
      const delta=Object.fromEntries(keys.map(k=>[k,Math.max(0,(total[k]??0)-(previous[k]??0))]));
      usage=Object.fromEntries(keys.map(k=>[k,Math.max(0,(total[k]??0)-(this.usageBase[k]??0))]));
      if(delta.inputTokens||delta.outputTokens) {
        const amount=estimateCodexCost(this.selectedModel,delta);
        this.usageCostKnown=(this.usageCostKnown??true)&&amount!==undefined;
        this.usageCost=(this.usageCost??0)+(amount??0);
      }
      cost=this.usageCostKnown?this.usageCost:undefined;
      this.usagePrevious={...total};this.lastUsageTotal={...total};
    }
    this.usage('usage',usage.inputTokens,usage.outputTokens,cost,{used:last.totalTokens,limit:value.modelContextWindow});
  }
  static capabilities = capabilities({ diff: true, plan: true, models: true, compact: true, workspace: true, queue: true, steer: true, historyImport: true });
  workspaceSections = codexSections;
  workspaceControl = codexWorkspace;
  resolveOrigin = codexOrigin;
  validateInput = codexInput;
  prepareCommand = true;
  async openHistory() {
    // MCP and marketplace catalogs contain schemas and can exceed the 1 MiB default.
    // Views sent to the phone remain independently bounded to 44 KiB.
    this.rpc = new NativeRPC(this.options.command, [...(this.options.args ?? []), 'app-server', '--listen', 'stdio://'], { cwd: this.options.cwd, timeout: this.options.timeout, maxFrameBytes:16*1024*1024 });
    this.rpc.on('message', m => { try { this.onMessage(m); } catch { this.fault(); void this.close(); } });
    this.rpc.on('fault', () => this.fault());
    const init = await this.rpc.call('initialize', { clientInfo: { name: 'weagent_node', title: '喵连 Node', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.rpc.write({ method: 'initialized', params: {} });
    return init;
  }
  async open() {
    const init = await this.openHistory();
    const origin = this.options.origin;
    if(origin?.mode==='resume') {
      const result=await this.rpc.call('thread/read',{threadId:origin.threadId,includeTurns:false});
      if(result?.thread?.id!==origin.threadId || await realpath(result.thread.cwd).catch(()=>null)!==await realpath(this.options.cwd)) throw failure('FORBIDDEN','Native resume project does not match');
      if(result.thread.status?.type==='active') throw failure('READ_ONLY','Native thread is active');
    }
    if(origin?.importVersion !== undefined) {
      const current=await this.rpc.call('thread/read',{threadId:origin.threadId,includeTurns:false});
      if(!current?.thread || current.thread.updatedAt!==origin.importVersion || current.thread.status?.type==='active') throw failure('SOURCE_CONFLICT','Native history changed before import');
      if(await realpath(current.thread.cwd).catch(()=>null)!==await realpath(this.options.cwd)) throw failure('FORBIDDEN','Native history project changed before import');
    }
    const common = { cwd: this.options.cwd, approvalPolicy: 'untrusted', sandbox: 'workspace-write', ...(this.options.model ? { model: this.options.model } : {}) };
    const method = !origin ? 'thread/start' : origin.mode === 'resume' ? 'thread/resume' : 'thread/fork';
    const result = await this.rpc.call(method, { ...common, ...(origin ? { threadId: origin.threadId, ...(origin.lastTurnId ? { lastTurnId: origin.lastTurnId } : {}) } : {}), ...(method !== 'thread/resume' ? { ephemeral: this.options.workspacePolicy?.persistHistory === false } : {}) });
    if (!result?.thread?.id) throw failure('PROTOCOL_UNSUPPORTED', 'Codex 未返回 thread ID');
    if(origin?.importVersion !== undefined && result.thread.id===origin.threadId) throw failure('PROTOCOL_UNSUPPORTED','Native import did not create an independent thread',false);
    if(origin?.importVersion !== undefined) {
      const after=await this.rpc.call('thread/read',{threadId:origin.threadId,includeTurns:false});
      if(!after?.thread || after.thread.updatedAt!==origin.importVersion || after.thread.status?.type==='active') throw failure('SOURCE_CONFLICT','Source history changed during import; no prompt was sent');
    }
    this.selectedModel = result.model ?? this.options.model ?? null;
    this.threadId = result.thread.id; return { nativeSessionId: this.threadId, info: init?.userAgent ?? 'Codex App Server' };
  }
  async listModels() {
    const entries = []; let cursor = null, pages = 0;
    do {
      const result = await this.rpc.call('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result?.data)) throw failure('PROTOCOL_UNSUPPORTED', 'Codex 模型目录格式不支持');
      entries.push(...result.data.filter(m => !m.hidden).map(m => ({ id: m.model, label: m.displayName, ...(Array.isArray(m.inputModalities) ? { input: m.inputModalities.filter(x => ['text','image','file'].includes(x)) } : {}), ...(Array.isArray(m.supportedReasoningEfforts) ? { thinking: m.supportedReasoningEfforts.map(x => x.reasoningEffort) } : {}) })));
      if (cursor && result.nextCursor === cursor) throw failure('PROTOCOL_UNSUPPORTED', 'Codex 模型目录游标未推进');
      cursor = result.nextCursor;
    } while (cursor && entries.length < 100 && ++pages < 5);
    return this.catalog(entries, !!cursor);
  }
  async selectModel(model) {
    // App Server exposes model overrides on turn/start, not a standalone session setter.
    // Report a staged next-turn override, NOT an already applied native setting.
    this.nextModel = model.id; delete this.nextEffort; return false;
  }
  async compact(turnId) {
    this.begin(turnId); this.compacting = true; this.awaitingCompactTurn = true;
    this.tool('compact', '压缩上下文', 'running', '等待 Codex 原生压缩完成');
    await this.rpc.call('thread/compact/start', { threadId: this.threadId });
    return { action: 'compact', status: 'started' };
  }
  async start(text, turnId, structured) {
    this.validatePrompt(text); const input = structured ? await this.validateInput(structured) : [{ type: 'text', text, text_elements: [] }];
    this.begin(turnId); this.starting = true; this.startBuffer = []; this.startBytes = 0;
    try {
      const result = await this.rpc.call('turn/start', { threadId: this.threadId, input, ...(this.nextModel ? { model: this.nextModel } : {}), ...(this.nextEffort ? { effort: this.nextEffort } : {}), ...(this.nextSandbox ? { approvalPolicy: 'untrusted', sandboxPolicy: this.nextSandbox === 'read-only' ? { type: 'readOnly', networkAccess: false } : { type: 'workspaceWrite', writableRoots: [this.options.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } } : {}) });
      if (!result?.turn?.id) throw failure('OPERATION_UNKNOWN', 'Codex 未确认 turn ID', false);
      this.nativeTurnId = result.turn.id; this.starting = false;
      for (const message of this.startBuffer) this.onMessage(message);
      return { nativeTurnId: this.nativeTurnId };
    } finally { this.starting = false; this.startBuffer = []; }
  }
  async cancel() {
    this.cancelling = true;
    if (!this.nativeTurnId) throw failure('OPERATION_UNKNOWN', 'Codex turn 尚未确认', false);
    await this.rpc.call('turn/interrupt', { threadId: this.threadId, turnId: this.nativeTurnId });
  }
  onMessage(m) {
    const p = m.params ?? {}, item = p.item;
    if (p.threadId && this.threadId && p.threadId !== this.threadId) return;
    if (this.starting && m.method) {
      this.startBytes += Buffer.byteLength(JSON.stringify(m));
      if (this.startBuffer.length >= 1000 || this.startBytes > 1024 * 1024) throw failure('SERVICE_UNAVAILABLE', 'Codex 启动缓冲区已满', false);
      this.startBuffer.push(m); return;
    }
    const nativeTurn = p.turnId ?? p.turn?.id;
    if (this.awaitingCompactTurn) {
      if (m.method === 'turn/started' && p.turn?.id && p.turn.id !== this.nativeTurnId) {
        this.nativeTurnId = p.turn.id; this.awaitingCompactTurn = false;
      } else {
        if (m.id !== undefined && m.method) this.rpc.write({ id: m.id, error: { code: -32600, message: 'Compaction turn not started' } });
        return;
      }
    }
    if (nativeTurn && this.nativeTurnId && nativeTurn !== this.nativeTurnId) {
      if (m.id !== undefined) this.rpc.write({ id: m.id, error: { code: -32600, message: 'Stale native turn' } });
      return;
    }
    if (m.id !== undefined && m.method) return this.serverRequest(m);
    observeCodex(this, m);
    if (!this.busy) {
      if(m.method==='thread/tokenUsage/updated'&&p.tokenUsage?.total)this.lastUsageTotal={...p.tokenUsage.total};
      return;
    }
    if (m.method === 'turn/started') this.nativeTurnId = p.turn?.id;
    if (m.method === 'item/agentMessage/delta') this.message(p.itemId, p.delta);
    if (m.method === 'item/commandExecution/outputDelta') this.consumed(p.itemId);
    if (m.method === 'item/started' || m.method === 'item/completed') {
      if (!item) return;
      const done = m.method === 'item/completed';
      if (done) this.consumed(item.id);
      if (item.type === 'agentMessage' && done) this.message(item.id, item.text, true);
      if (item.type === 'commandExecution') this.tool(item.id, '执行命令', done ? (item.status === 'completed' ? 'completed' : 'failed') : 'running', item.command, item.aggregatedOutput ?? null);
      if (item.type === 'fileChange') {
        this.tool(item.id, '文件修改', done ? (item.status === 'completed' ? 'completed' : 'failed') : 'running');
        if (done) this.diff(item);
      }
    }
    if (m.method === 'turn/plan/updated') this.item('plan', { type: 'plan', title: cut(p.explanation ?? '执行计划', 200), steps: (p.plan ?? []).slice(0, 100).map((s, i) => ({ id: `step${i}`, text: cut(s.step, 1000), state: s.status === 'completed' ? 'completed' : s.status === 'inProgress' ? 'running' : 'pending' })) });
    if (m.method === 'thread/tokenUsage/updated') {
      this.reportUsage(p.tokenUsage??{});
    }
    // serverRequest/resolved also means cancellation; not sufficient proof of a submitted answer.
    if (m.method === 'serverRequest/resolved') {
      for (const [key, entry] of this.requests) if (entry.nativeRequestId === p.requestId && !entry.sent) this.withdraw(key, '原生请求已结束');
    }
    if (m.method === 'turn/completed') {
      if (this.compacting) { this.tool('compact', '压缩上下文', p.turn?.status === 'completed' ? 'completed' : 'failed', p.turn?.status === 'completed' ? 'Codex 已完成原生压缩' : '原生压缩未完成'); this.compacting = false; }
      this.finish(p.turn?.status === 'completed' ? 'completed' : p.turn?.status === 'interrupted' ? 'cancelled' : 'failed');
    }
  }
  serverRequest(m) {
    const p = m.params ?? {}, key = p.itemId ?? String(m.id);
    const reply = result => this.rpc.write({ id: m.id, result });
    if (!this.busy) { this.rpc.write({ id: m.id, error: { code: -32601, message: 'No active 喵连 turn' } }); return; }
    let entry;
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(m.method)) {
      if (String(p.command ?? p.reason ?? '').length > 4000) { reply({ decision: 'decline' }); return; }
      const definition = approval(m.method.includes('commandExecution') ? 'Allow native command?' : 'Allow native file change?', p.command ?? p.reason ?? 'Native operation approval', 'Native operation', 'Current host project');
      if(p.networkApprovalContext) definition.summary += `\nNetwork target: ${p.networkApprovalContext.protocol}://${p.networkApprovalContext.host}`;
      if(definition.summary.length > 4000){reply({decision:'decline'});return;}
      definition.choices.push({id:'allow_session',label:'Allow for this native session'});
      entry = this.ask(key, definition, d => reply({ decision: d.choiceId === 'allow' ? 'accept' : d.choiceId === 'allow_session' ? 'acceptForSession' : 'decline' }), { cancel: () => reply({ decision: 'cancel' }) });
    } else if (m.method === 'item/tool/requestUserInput') {
      try {
        const q = questions(p.questions);
        entry = this.ask(key, q.definition, d => reply({ answers: Object.fromEntries(q.decode(d).map(a => [a.native.id, { answers: a.values }])) }), { timeout: p.autoResolutionMs ?? undefined, cancel: () => reply({ answers: {} }) });
      } catch { reply({ answers: {} }); }
    } else if (m.method === 'item/permissions/requestApproval') {
      const turn=this.turnId;
      void permissionQuestion(p.permissions,this.workspace).then(q=>{
        if(!this.busy||this.turnId!==turn){reply({permissions:{},scope:'turn'});return;}
        const request=this.ask(key,q.definition,async d=>reply(await q.encode(d)),{cancel:()=>reply({permissions:{},scope:'turn'})});
        request.nativeRequestId=m.id;
      }).catch(()=>reply({permissions:{},scope:'turn'}));
    }
    else if (m.method === 'mcpServer/elicitation/request') reply({ action: 'decline', content: null, _meta: null });
    else this.rpc.write({ id: m.id, error: { code: -32601, message: 'Unsupported by 喵连 adapter' } });
    if (entry) entry.nativeRequestId = m.id;
  }
  diff(item) {
    const itemId = this.itemId(`${item.id}_diff`), files = [];
    for (const change of (item.changes ?? []).slice(0, 100)) {
      const path = this.displayPath(change.path ?? ''); if (!path) continue;
      const kind = typeof change.kind === 'string' ? change.kind : change.kind?.type;
      let fullPatch = String(change.diff ?? '');
      if (kind === 'add' || kind === 'delete') {
        const content = fullPatch.replace(/\r\n/g, '\n');
        const rows = content ? content.split('\n') : [];
        if (content.endsWith('\n')) rows.pop();
        const count = rows.length;
        fullPatch = (kind === 'add' ? `@@ -0,0 +${count ? 1 : 0},${count} @@` : `@@ -${count ? 1 : 0},${count} +0,0 @@`) + '\n' + rows.map(line => (kind === 'add' ? '+' : '-') + line).join('\n');
      }
      const patch = cut(fullPatch), fileId = id('file');
      this.publish({ kind: 'event', type: 'diff.file', data: { id: fileId, sessionId: this.options.sessionId, itemId, path, language: null, patch, truncated: fullPatch.length > 48000, createdAt: now() } });
      const lines = fullPatch.split('\n');
      let hunk = false, added = 0, removed = 0;
      for (const line of lines) {
        if (line.startsWith('@@')) { hunk = true; continue; }
        if (line.startsWith('diff --git ')) { hunk = false; continue; }
        if (hunk && line.startsWith('+')) added++;
        if (hunk && line.startsWith('-')) removed++;
      }
      files.push({ fileId, path, added, removed });
    }
    if (files.length) this.item(`${item.id}_diff`, { type: 'diff', title: '文件差异', summary: `${files.length} 个文件`, files });
  }
}
