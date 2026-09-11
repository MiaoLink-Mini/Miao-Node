import { fileURLToPath } from 'node:url';
import { Plugin, approval, questions } from './base.mjs';
import { piOrigin, preparePiOrigin, listPiHistory } from '../workspace/pi-history.mjs';
import { NativeRPC } from '../native-rpc.mjs';
import { piWorkspace, piSections, piInput, observePi } from '../workspace/pi.mjs';
import { bounded, capabilities, cut, deferred, digest, failure, id, textContent } from '../common.mjs';

export class PiPlugin extends Plugin {
  static capabilities = capabilities({ models: true, compact: true, workspace: true, queue: true, steer: true, historyImport: true });
  resolveOrigin = piOrigin;
  async openHistory() {}
  async resumeOrigin(nativeId) {
    const history=(await listPiHistory(this)).find(h=>h.sessionId===nativeId);
    if(!history)throw failure('NOT_FOUND','Saved Pi history is unavailable; older ephemeral sessions cannot resume');
    return {...history,mode:'resume'};
  }
  workspaceSections = piSections;
  workspaceControl = piWorkspace;
  validateInput = piInput;
  prepareCommand = true;
  async open() {
    this.extensionReady = deferred();
    const args = [...(this.options.args ?? []), '--mode', 'rpc', '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve', '-e', fileURLToPath(new URL('../../plugins/pi/weagent-extension.mjs', import.meta.url))];
    if(this.options.origin)args.push('--session',await preparePiOrigin(this,this.options.origin));
    else if(this.options.workspacePolicy?.persistHistory===false)args.push('--no-session');
    if (this.options.workspacePolicy?.enableNativeResources) { for (const flag of ['--no-extensions', '--no-skills', '--no-prompt-templates']) args.splice(args.indexOf(flag), 1); }
    if (this.options.model) args.push('--model', this.options.model);
    this.rpc = new NativeRPC(this.options.command, args, { cwd: this.options.cwd, mode: 'pi', timeout: this.options.timeout });
    this.rpc.on('message', m => { try { this.onMessage(m); } catch { this.fault(); void this.close(); } });
    this.rpc.on('fault', e => { this.extensionReady.reject(e); this.fault(); });
    const state = await this.rpc.call('get_state');
    await bounded(this.extensionReady.promise, this.options.timeout ?? 30000);
    if (!state?.sessionId || state.isStreaming || state.pendingMessageCount) throw failure('PROTOCOL_UNSUPPORTED', 'Pi 初始会话不为空闲状态');
    if (state.model?.provider && state.model?.id) this.selectedModel = this.modelKey(state.model);
    this.nativeSessionId=state.sessionId;
    if(this.options.origin?.mode==='resume'&&state.sessionId!==this.options.origin.sessionId)throw failure('PROTOCOL_UNSUPPORTED','Pi resume changed native identity');
    return { nativeSessionId: state.sessionId, info: 'Pi RPC + 喵连 extension v1' };
  }
  modelKey(m) { return `model_${digest([m.provider, m.id]).slice(0, 40)}`; }
  async listModels() {
    const result = await this.rpc.call('get_available_models');
    if (!Array.isArray(result?.models)) throw failure('PROTOCOL_UNSUPPORTED', 'Pi 模型目录格式不支持');
    return this.catalog(result.models.filter(m => typeof m.id === 'string' && typeof m.provider === 'string').map(m => ({ id: this.modelKey(m), label: `${m.name || m.id} · ${m.provider}`, native: { provider: m.provider, modelId: m.id }, ...(Array.isArray(m.input) ? { input: m.input.filter(x => ['text', 'image', 'file'].includes(x)) } : {}) })));
  }
  async selectModel(model) {
    const result = await this.rpc.call('set_model', model.native);
    if (result?.id !== model.native.modelId || result?.provider !== model.native.provider) throw failure('OPERATION_UNKNOWN', 'Pi 未确认选中的模型', false);
    return true;
  }
  async compact(turnId) {
    this.begin(turnId); this.tool('compact', '压缩上下文', 'running', '等待 Pi 原生压缩完成');
    const result = await this.rpc.call('compact');
    if (this.workspace) this.workspace.native.compaction = { state: 'completed', summary: cut(result?.summary, 18000), beforeTokens: result?.tokensBefore ?? null, afterTokens: result?.estimatedTokensAfter ?? null };
    this.tool('compact', '压缩上下文', 'completed', 'Pi 已完成原生压缩'); this.finish('completed');
    return { action: 'compact', status: 'completed' };
  }
  validatePrompt(text) {
    super.validatePrompt(text);
    if (text.trimStart().startsWith('/')) throw failure('CAPABILITY_UNSUPPORTED', 'Pi 原生斜杠命令不通过任务消息执行');
  }
  async start(text, turnId, structured) {
    if (!structured?.command) this.validatePrompt(text);
    const payload = structured ? await this.validateInput(structured) : { message: text };
    this.begin(turnId); this.finalState = 'completed';
    await this.rpc.call('prompt', payload);
    return { nativeTurnId: turnId };
  }
  async cancel() {
    this.cancelling = true; this.finalState = 'cancelled';
    await this.rpc.call('abort');
    this.finish('cancelled');
  }
  onMessage(m) {
    observePi(this, m);
    if (m.type === 'extension_ui_request') return this.ui(m);
    if (m.type === 'extension_error' && m.extensionPath !== fileURLToPath(new URL('../../plugins/pi/weagent-extension.mjs', import.meta.url))) return;
    if (m.type === 'extension_error') { this.extensionReady.reject(failure('PROTOCOL_UNSUPPORTED', 'Pi 扩展加载失败')); this.fault(); void this.close(); return; }
    if (!this.busy) return;
    if (m.type === 'message_start' && m.message?.role === 'assistant') this.messageKey = id('pi');
    if (m.type === 'message_update' && m.assistantMessageEvent?.type === 'text_delta') this.message(this.messageKey ??= id('pi'), m.assistantMessageEvent.delta);
    if (m.type === 'message_end' && m.message?.role === 'assistant') {
      this.message(this.messageKey ??= id('pi'), textContent(m.message.content), true);
      const u = m.message.usage;
      if (u) this.usage(`${this.messageKey}_usage`, u.input, u.output, u.cost?.total);
      if (m.message.stopReason === 'error') this.finalState = 'failed';
      if (m.message.stopReason === 'aborted') this.finalState = 'cancelled';
    }
    if (m.type === 'tool_execution_start') this.tool(m.toolCallId, m.toolName, 'running');
    if (m.type === 'tool_execution_update') this.tool(m.toolCallId, m.toolName, 'running', '', textContent(m.partialResult?.content));
    if (m.type === 'tool_execution_end') this.tool(m.toolCallId, m.toolName, m.isError ? 'failed' : 'completed', '', textContent(m.result?.content));
    // agent_end is NOT final: Pi can retry/compact afterward. 0.85+ agent_settled is authoritative.
    if (m.type === 'agent_settled') this.finish(this.finalState);
  }
  ui(m) {
    if (m.method === 'notify') {
      let meta; try { meta = JSON.parse(m.message); } catch { return; }
      if (meta.weagent !== 1) return;
      if (meta.event === 'ready' && meta.version === 1) this.extensionReady.resolve();
      if (meta.event === 'decision') {
        if (meta.received) this.consumed(meta.nonce);
        else this.withdraw(meta.nonce, 'Pi 已取消或超时');
      }
      return;
    }
    if (!['select', 'confirm', 'input', 'editor'].includes(m.method)) return;
    const send = body => this.rpc.write({ type: 'extension_ui_response', id: m.id, ...body });
    let meta; try { meta = JSON.parse(m.title); } catch { send({ cancelled: true }); return; }
    // Only managed dialogs carry an explicit consumption receipt; other extensions are disabled.
    if (!this.busy || meta.weagent !== 1 || typeof meta.nonce !== 'string') { send({ cancelled: true }); return; }
    if (meta.kind === 'approval' && m.method === 'select') {
      this.ask(meta.nonce, approval(meta.title, meta.summary, 'Pi 工具授权', '当前主机项目'), d => send({ value: d.choiceId === 'allow' ? '仅允许本次' : '拒绝' }), { timeout: m.timeout, cancel: () => send({ cancelled: true }) });
    } else if (meta.kind === 'question') {
      const q = questions([{ question: meta.title, options: m.options }]);
      this.ask(meta.nonce, q.definition, d => send({ value: q.decode(d)[0].values[0] }), { timeout: m.timeout, cancel: () => send({ cancelled: true }) });
    } else send({ cancelled: true });
  }
}
