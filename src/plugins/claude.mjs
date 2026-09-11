import { elicitationForm } from '../workspace/elicitation.mjs';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Plugin, approval, questions } from './base.mjs';
import { claudeWorkspace, claudeSections, claudeOrigin, observeClaude } from '../workspace/claude.mjs';
import { inputParts, withTextFiles, verifyCommand } from '../workspace/input.mjs';
import { bounded, capabilities, cut, deferred, failure, textContent } from '../common.mjs';

export class InputStream {
  constructor() { this.items = []; this.wait = null; this.ended = false; }
  push(value) { if (this.ended) throw failure('OPERATION_UNKNOWN', 'Claude 输入流已关闭', false); if (this.wait) { this.wait.resolve({ value, done: false }); this.wait = null; } else this.items.push(value); }
  end() { this.ended = true; this.wait?.resolve({ done: true }); this.wait = null; }
  [Symbol.asyncIterator]() { return this; }
  next() { if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false }); if (this.ended) return Promise.resolve({ done: true }); this.wait = deferred(); return this.wait.promise; }
}

export class ClaudePlugin extends Plugin {
  static capabilities = capabilities({ plan: true, models: true, compact: true, workspace: true, queue: true, historyImport: true });
  workspaceSections = claudeSections;
  workspaceControl = claudeWorkspace;
  resolveOrigin = claudeOrigin;
  prepareCommand = true;
  // History APIs read SDK transcripts without opening a query or creating a session.
  async openHistory() {}
  async resolvePreset(preset) {
    const list = await bounded(this.query.supportedAgents());
    const exact = list.find(a => a.name === preset.name && a.model === preset.model && a.description === preset.description);
    if(!exact) throw failure('SOURCE_CONFLICT','Native agent definition changed; refresh before selecting');
    return { name: exact.name, model: exact.model };
  }
  async open() {
    this.input = new InputStream(); this.nativeSessionId = this.options.origin?.resume ?? randomUUID();
    const options = {
      cwd: this.options.cwd, ...(this.options.origin?.resume ? { resume: this.nativeSessionId } : { sessionId: this.nativeSessionId }), persistSession: this.options.workspacePolicy?.persistHistory !== false, enableFileCheckpointing: true,
      ...(this.options.agentPreset ? { agent: this.options.agentPreset.name } : {}),
      includePartialMessages: true, permissionMode: 'default', settingSources: this.options.workspacePolicy?.settingSources ?? [], skills: this.options.workspacePolicy?.skills ?? [],
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'NotebookEdit', 'AskUserQuestion', 'TodoWrite', 'Agent', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'TaskStop', 'TaskOutput'],
      mcpServers: {}, strictMcpConfig: true,
      // Explicit ask rules prevent remembered local allow rules bypassing the mobile gate.
      settings: { permissions: { ask: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'AskUserQuestion'] } },
      canUseTool: (name, input, context) => this.permission(name, input, context),
      onElicitation: (request, context) => this.elicitation(request, context),
      ...(this.options.command ? { pathToClaudeCodeExecutable: this.options.command } : {}),
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.maxBudgetUsd ? { maxBudgetUsd: this.options.maxBudgetUsd } : {}),
      stderr: () => {},
    };
    this.query = (this.options.queryFactory ?? query)({ prompt: this.input, options });
    this.reader = (async () => {
      try { for await (const message of this.query) this.onMessage(message); }
      catch { this.accepted?.reject(failure('OPERATION_UNKNOWN', 'Claude 原生通道失败', false)); this.fault(); }
      finally { if (!this.closing) { this.accepted?.reject(failure('OPERATION_UNKNOWN', 'Claude 原生进程已结束', false)); this.fault(); } }
    })();
    this.initialization = await bounded(this.query.initializationResult(), this.options.timeout ?? 30000);
    this.selectedModel = this.options.model ?? null;
    return { nativeSessionId: this.nativeSessionId, info: 'Claude Agent SDK' };
  }
  async listModels() {
    const models = await bounded(this.query.supportedModels(), this.options.timeout ?? 30000);
    if (!Array.isArray(models)) throw failure('PROTOCOL_UNSUPPORTED', 'Claude 模型目录格式不支持');
    return this.catalog(models.map(m => ({ id: m.value, label: m.displayName, thinking: m.supportedEffortLevels ?? [], inputEvidence: 'Model-specific image/file modalities are not provided by supportedModels; structured SDK image transport is available.' })));
  }
  async selectModel(model) {
    await bounded(this.query.setModel(model.id), this.options.timeout ?? 30000); return true;
  }
  validatePrompt(text) {
    super.validatePrompt(text);
    if (text.trimStart().startsWith('/')) throw failure('CAPABILITY_UNSUPPORTED', 'Claude 原生斜杠命令不通过任务消息执行');
  }
  async start(text, turnId, structured) {
    if (!structured?.command) this.validatePrompt(text);
    let content = text;
    if (structured) { const prepared = await this.validateInput(structured); content = prepared.content; }
    this.begin(turnId); this.accepted = deferred(); this.promptId = randomUUID();
    this.input.push({ type: 'user', uuid: this.promptId, session_id: this.nativeSessionId, parent_tool_use_id: null, message: { role: 'user', content } });
    await bounded(this.accepted.promise, this.options.timeout ?? 30000);
    return { nativeTurnId: this.promptId };
  }
  async validateInput(input) {
    if (!input.command) this.validatePrompt(input.text);
    const parts = inputParts(input);
    const text = withTextFiles(await verifyCommand(input, input.command ? await bounded(this.query.supportedCommands()) : []), parts.texts);
    const content = [...parts.images.map(f => ({ type: 'image', source: { type: 'base64', media_type: f.mediaType, data: f.bytes.toString('base64') } })), { type: 'text', text }];
    return { content: parts.images.length ? content : text };
  }
  async compact(turnId) {
    if (typeof this.query.supportedCommands !== 'function') throw failure('CAPABILITY_UNSUPPORTED', 'Native command catalog unavailable');
    const list = await bounded(this.query.supportedCommands());
    const command = list.find(c => c.name === 'compact');
    if (!command) throw failure('CAPABILITY_UNSUPPORTED', 'This Claude runtime did not advertise the compact command');
    await this.start('', turnId, { text: '', attachments: [], references: [], command });
    return { action: 'compact', status: 'started' };
  }
  async cancel() {
    this.cancelling = true;
    await bounded(this.query.interrupt(), this.options.timeout ?? 30000);
  }
  async elicitation(request,context) {
    if(!this.busy || context.signal.aborted)return {action:'decline'};
    if(request.mode==='url') {
      try {const c=this.workspace.external(request.serverName,request.url);this.workspace.widgets.set('auth:'+request.elicitationId,{id:'auth_'+randomUUID(),label:request.serverName,detail:'External authorization requested. Verify the URL and complete it on the host; no approval was sent.',controls:[c]});}catch{}
      return {action:'decline'};
    }
    let form;try{form=elicitationForm(request);}catch(error){this.workspace?.diagnostic(request.serverName,error.message);return {action:'decline'};}
    const result=deferred(),key='elicitation:'+context.requestId;
    const entry=this.ask(key,form.definition,d=>{
      const encoded=form.encode(d);result.resolve(encoded);
      // The SDK does not expose a correlated acknowledgement for form replies.
      // Keep operation status unknown instead of claiming the MCP server accepted it.
      this.workspace?.diagnostic(request.serverName,'Form response handed to SDK. Server acceptance is not confirmed by this callback.');
    },{cancel:()=>result.resolve({action:'cancel'})});
    entry.elicitation=true;
    const abort=()=>this.withdraw(key,'Native form was cancelled');context.signal.addEventListener('abort',abort,{once:true});
    try{return await result.promise;}finally{context.signal.removeEventListener('abort',abort);}
  }
  async permission(name, input, context) {
    if (!this.busy || context.signal.aborted) return { behavior: 'deny', message: 'No active 喵连 turn' };
    this.accepted?.resolve(); // A correlated tool request proves that the prompt is being processed.
    const answer = deferred(), key = context.toolUseID;
    let definition, encode;
    if (name === 'AskUserQuestion') {
      try {
        const q = questions(input.questions); definition = q.definition;
        encode = d => ({ behavior: 'allow', updatedInput: { ...input, answers: Object.fromEntries(q.decode(d).map(a => [a.native.question, a.values.join(', ')])) } });
      } catch { return { behavior: 'deny', message: 'Question cannot be represented by 喵连' }; }
    } else {
      const summary = name === 'Bash' ? String(input.command ?? '') : JSON.stringify(input);
      if (summary.length > 4000) return { behavior: 'deny', message: 'Review payload exceeds 喵连 limit' };
      definition = approval(context.title ?? `允许执行 ${name}？`, summary, name, '当前主机项目');
      const grants = (context.suggestions ?? []).filter(s => s.destination === 'session' && s.type === 'addRules' && s.behavior === 'allow' && s.rules.length > 0 && s.rules.every(r => r.toolName === name));
      const readable = JSON.stringify(grants);
      const extendedSummary = definition.summary + '\nSession rule grant offered by native runtime: ' + readable;
      if (grants.length && readable.length <= 1800 && extendedSummary.length <= 4000) {
        definition.summary = extendedSummary; definition.choices.push({ id: 'allow_session', label: 'Allow the displayed session rules' });
      }
      encode = d => d.choiceId === 'allow' || d.choiceId === 'allow_session' ? { behavior: 'allow', updatedInput: input, ...(d.choiceId === 'allow_session' ? { updatedPermissions: grants } : {}) } : { behavior: 'deny', message: 'Declined by 喵连 user' };
    }
    this.ask(key, definition, d => answer.resolve(encode(d)), { cancel: () => answer.resolve({ behavior: 'deny', message: '喵连 request cancelled or expired' }) });
    const abort = () => this.withdraw(key, 'Claude 已撤回请求');
    context.signal.addEventListener('abort', abort, { once: true });
    try { return await answer.promise; } finally { context.signal.removeEventListener('abort', abort); }
  }
  onMessage(m) {
    observeClaude(this, m);
    if (!this.busy || m.parent_tool_use_id) return;
    if (m.type === 'stream_event') {
      this.accepted?.resolve();
      const e = m.event;
      if (e.type === 'message_start') this.messageKey = e.message.id;
      if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') this.message(this.messageKey ?? m.uuid, e.delta.text);
    }
    if (m.type === 'assistant') {
      this.accepted?.resolve();
      this.message(m.message.id, textContent(m.message.content), true);
      for (const block of m.message.content ?? []) if (block.type === 'tool_use') {
        this.tool(block.id, block.name, 'running');
        if (block.name === 'TodoWrite') this.item(block.id + '_plan', { type: 'plan', title: '执行计划', steps: (block.input?.todos ?? []).slice(0, 100).map((s, i) => ({ id: `step${i}`, text: cut(s.content, 1000), state: s.status === 'completed' ? 'completed' : s.status === 'in_progress' ? 'running' : 'pending' })) });
      }
    }
    if (m.type === 'tool_progress') this.consumed(m.tool_use_id);
    if (m.type === 'user') {
      if (m.uuid === this.promptId) this.accepted?.resolve();
      for (const block of Array.isArray(m.message?.content) ? m.message.content : []) if (block.type === 'tool_result') {
        this.consumed(block.tool_use_id); this.tool(block.tool_use_id, '工具结果', block.is_error ? 'failed' : 'completed', '', textContent(block.content));
      }
    }
    if (m.type === 'result') {
      this.accepted?.resolve();
      if (m.usage) this.usage('usage', m.usage.input_tokens, m.usage.output_tokens, m.total_cost_usd);
      this.finish(this.cancelling ? 'cancelled' : m.is_error || m.subtype !== 'success' ? 'failed' : 'completed');
    }
  }
  async close() {
    await super.close(); this.input?.end(); this.query?.close();
    await bounded(this.reader ?? Promise.resolve(), 3000).catch(() => {});
  }
}
