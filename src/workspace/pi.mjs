import { piHistoryView } from './pi-history.mjs';
import { cut, failure, textContent } from '../common.mjs';
import { entry, control, field, view } from './view.mjs';
import { inputParts, verifyCommand, withTextFiles } from './input.mjs';

export const piSections = [['thinking', 'Thinking levels'], ['config', 'Native settings'], ['skills', 'Runtime skills'], ['commands', 'Commands and templates'], ['retry', 'Automatic retry and compaction'], ['history', 'Local native history']];
const persistence = p => { if (!p.options.workspacePolicy?.allowNativeSettingsWrite) throw failure('FORBIDDEN', 'The host must explicitly enable workspace.allowNativeSettingsWrite because Pi persists these native settings'); };
const persistNotice = 'Pi saves this value through its native SettingsManager. Host opt-in is required; this is not a session-only override.';
const policyControl = (label, kind, enabled) => control(label, { kind, enabled }, { confirm: true, notice: persistNotice });

export async function piWorkspace(r, w) {
  const p = this;
  switch (r.kind) {
    case 'thinking': {
      const state = await p.rpc.call('get_state'), result = await p.rpc.call('get_available_thinking_levels');
      if (!Array.isArray(result?.levels)) throw failure('PROTOCOL_UNSUPPORTED', 'The installed Pi did not return a thinking-level directory');
      return view('Pi thinking levels', `${persistNotice}\nCurrent: ${state.thinkingLevel}`, result.levels.map(value => entry(value, '', { ...(value === state.thinkingLevel ? { state: 'current' } : {}), controls: p.options.workspacePolicy?.allowNativeSettingsWrite ? [control('Use this level', { kind: 'set_thinking', value }, { confirm: true, notice: persistNotice })] : [] })));
    }
    case 'set_thinking': {
      persistence(p); const result = await p.rpc.call('get_available_thinking_levels');
      if (!result?.levels?.includes(r.value)) throw failure('CAPABILITY_UNSUPPORTED', 'Selected Pi model does not advertise this thinking level');
      await p.rpc.call('set_thinking_level', { level: r.value });
      const after = await p.rpc.call('get_state');
      if (after.thinkingLevel !== r.value) throw failure('OPERATION_UNKNOWN', 'Pi did not report the requested thinking level', false);
      return view('Pi thinking level applied', `${r.value}. ${persistNotice}`);
    }
    case 'config': {
      const state = await p.rpc.call('get_state');
      const list = [entry('Automatic compaction', String(state.autoCompactionEnabled)), entry('Steering mode', state.steeringMode), entry('Follow-up mode', state.followUpMode)];
      const controls = p.options.workspacePolicy?.allowNativeSettingsWrite ? ['steering', 'follow_up'].map(target => control(`Set ${target} mode`, { kind: 'native_queue_policy', target, value: target === 'steering' ? state.steeringMode : state.followUpMode }, { fields: [field('value', 'Native delivery policy', { options: ['all', 'one-at-a-time'] })], confirm: true, notice: persistNotice })) : [];
      return view('Pi native settings', persistNotice + ' Platform FIFO queue settings are separate and do not edit these values.', list, controls);
    }
    case 'native_queue_policy':
      persistence(p); await p.rpc.call(r.target === 'steering' ? 'set_steering_mode' : 'set_follow_up_mode', { mode: r.value });
      return p.workspaceControl({ kind: 'config' }, w);
    case 'skills': case 'commands': {
      const list = await p.rpc.call('get_commands');
      if (!Array.isArray(list?.commands)) throw failure('PROTOCOL_UNSUPPORTED', 'Pi command directory is invalid');
      return view(r.kind === 'skills' ? 'Pi skills' : 'Pi command directory', 'Only runtime-returned names can be invoked. Built-in TUI commands are not RPC commands. Extra native resources remain disabled unless explicitly enabled by the host.', list.commands.filter(c => r.kind !== 'skills' || c.source === 'skill').map(c => {
        const key = w.handles.put('command', { name: c.name, source: c.source });
        return entry(c.name, `${c.description ?? ''}\nSource: ${c.source}`, { id: key, referenceId: key, state: 'command' });
      }));
    }
    case 'retry': {
      const state = await p.rpc.call('get_state');
      const controls = [control('Stop current native retry', { kind: 'abort_retry' }, { confirm: true, notice: 'This addresses retry only; it does not silently cancel other queued work.' })];
      if (p.options.workspacePolicy?.allowNativeSettingsWrite) controls.push(policyControl('Enable automatic retry', 'set_auto_retry', true), policyControl('Disable automatic retry', 'set_auto_retry', false), policyControl('Enable automatic compaction', 'set_auto_compaction', true), policyControl('Disable automatic compaction', 'set_auto_compaction', false));
      return view('Pi retry and compaction', 'Retry events and compaction results are native evidence. The RPC state does not expose an automatic-retry getter; a missing prior value is not rendered as false.', [entry('Automatic compaction', String(state.autoCompactionEnabled)), entry('Compacting', String(state.isCompacting)), entry('Last requested retry setting', w.native.autoRetry === undefined ? 'Not set through this session' : String(w.native.autoRetry))], controls, { text: cut(JSON.stringify({ retry: w.native.retry ?? null, compaction: w.native.compaction ?? null }, null, 2), 24000) });
    }
    case 'set_auto_retry': case 'set_auto_compaction':
      persistence(p); await p.rpc.call(r.kind, { enabled: r.enabled });
      if (r.kind === 'set_auto_retry') w.native.autoRetry = r.enabled;
      return view('Pi settings command accepted', `${r.kind}: ${r.enabled}. ${persistNotice}`, [], [control('Refresh native state', { kind: 'retry' })]);
    case 'abort_retry':
      await p.rpc.call('abort_retry'); w.native.retryAbortRequested = true;
      return view('Retry abort accepted', 'Wait for native retry-end or settled state. No terminal success was fabricated.', [], [control('Refresh native retry status', { kind: 'retry' })]);
    case 'steer':
      if (!p.busy) throw failure('STALE_TURN', 'Steering requires an active native turn');
      p.validatePrompt(r.text); await p.rpc.call('steer', { message: r.text });
      return view('Steering instruction accepted', 'Pi accepted this steering instruction for the current run. This is distinct from the platform next-turn queue.');
    case 'native_rename':
      await p.rpc.call('set_session_name', { name: r.name });
      return view('Native session renamed', 'Platform title is managed separately.');
    case 'history': case 'history_messages': return piHistoryView.call(p,r,w);
    default: throw failure('CAPABILITY_UNSUPPORTED', 'This operation is not exposed by the installed Pi RPC adapter');
  }
}
export async function piInput(input) {
  if (!input.command) this.validatePrompt(input.text);
  const parts = inputParts(input), state = await this.rpc.call('get_state');
  if (parts.images.length && !state.model?.input?.includes('image')) throw failure('CAPABILITY_UNSUPPORTED', 'The current Pi model has not advertised image input');
  const text = await verifyCommand(input, input.command ? (await this.rpc.call('get_commands')).commands : []);
  return { message: withTextFiles(text, parts.texts), ...(parts.images.length ? { images: parts.images.map(f => ({ type: 'image', data: f.bytes.toString('base64'), mimeType: f.mediaType })) } : {}) };
}
export function observePi(p, m) {
  const w = p.workspace; if (!w) return;
  if (m.type === 'auto_retry_start') w.native.retry = { state: 'waiting', attempt: m.attempt, maxAttempts: m.maxAttempts, delayMs: m.delayMs, error: cut(m.errorMessage, 2000) };
  if (m.type === 'auto_retry_end') w.native.retry = { state: m.success ? 'completed' : 'failed', attempt: m.attempt, error: cut(m.finalError, 2000) };
  if (m.type === 'compaction_start') w.native.compaction = { state: 'running', reason: m.reason };
  if (m.type === 'compaction_end') w.native.compaction = { state: m.aborted ? 'cancelled' : m.result ? 'completed' : 'failed', summary: cut(m.result?.summary, 18000), beforeTokens: m.result?.tokensBefore ?? null, afterTokens: m.result?.estimatedTokensAfter ?? null, error: cut(m.errorMessage, 2000), willRetry: m.willRetry };
  if (m.type === 'extension_error') w.diagnostic(p.displayPath(m.extensionPath) || 'Host extension', `${m.event}: ${cut(m.error, 2000)}`);
  if (m.type === 'tool_execution_start' && ['write', 'edit'].includes(m.toolName)) (w.native.fileTools ??= new Map()).set(m.toolCallId, m.args?.path);
  if (m.type === 'tool_execution_end') { const path = w.native.fileTools?.get(m.toolCallId); if (path && !m.isError) void w.files.record(path, p.turnId).catch(() => {}); w.native.fileTools?.delete(m.toolCallId); }
  if (m.type !== 'extension_ui_request') return;
  if (m.method === 'setStatus') { if (m.statusText === undefined) w.widgets.delete('status:' + m.statusKey); else w.widgets.set('status:' + m.statusKey, entry(m.statusKey, m.statusText)); }
  if (m.method === 'setWidget') { if (m.widgetLines === undefined) w.widgets.delete('widget:' + m.widgetKey); else w.widgets.set('widget:' + m.widgetKey, entry(m.widgetKey, m.widgetLines.join('\n'))); }
  if (m.method === 'setTitle') w.native.title = cut(m.title, 200);
  if (m.method === 'set_editor_text') w.native.prefill = cut(m.text, 4000);
  while (w.widgets.size > 50) w.widgets.delete(w.widgets.keys().next().value);
}
