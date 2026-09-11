import * as installedSDK from '@anthropic-ai/claude-agent-sdk';
import { realpath, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bounded, cut, digest, failure, textContent } from '../common.mjs';
import { entry, control, field, view } from './view.mjs';

export const claudeSections = [ ['account', 'Authentication status'], ['history', 'Native history'], ['config', 'Session settings'], ['thinking', 'Thinking effort'], ['permissions', 'Run and permission mode'], ['sources', 'Context and instruction sources'], ['output_styles', 'Output styles'], ['agents', 'Subagent directory'], ['skills', 'Skills and slash commands'], ['mcp', 'MCP servers and tools'], ['extensions', 'Plugins and extensions'], ['tasks', 'Tasks and background processes'], ['checkpoints', 'Native file checkpoints'], ['retry', 'Retry and compaction status'] ];
const call = (p, name, ...args) => {
  if (typeof p.query?.[name] !== 'function') throw failure('CAPABILITY_UNSUPPORTED', `Installed Claude SDK does not expose ${name}`);
  return bounded(p.query[name](...args), p.options.timeout ?? 30000);
};
const sdk = p => p.options.sdk ?? installedSDK;
const opts = p => ({ dir: p.options.cwd });
const terminal = state => ['completed', 'failed', 'stopped', 'killed'].includes(state);
const basicAccount = account => [ ['Authentication provider', account.apiProvider], ['Token source', account.tokenSource], ['API key source', account.apiKeySource], ['Subscription type', account.subscriptionType] ].filter(([,v]) => typeof v === 'string').map(([k,v]) => entry(k, v));
const commands = async p => { const list = await call(p, 'supportedCommands'); if (!Array.isArray(list)) throw failure('PROTOCOL_UNSUPPORTED', 'Invalid Claude command catalog'); return list; };
const settingsControls = [
  control('Automatic compaction on', { kind: 'set_auto_compaction', enabled: true }, { confirm: true, notice: 'Session flag only. Managed policy remains authoritative.' }),
  control('Automatic compaction off', { kind: 'set_auto_compaction', enabled: false }, { confirm: true, notice: 'Session flag only. This does not change automatic retry policy.' }),
];

export async function claudeWorkspace(r, w, turnId) {
  const p = this;
  switch (r.kind) {
    case 'account': {
      const a = await call(p, 'accountInfo');
      return view('Claude authentication', 'Credentials, account email, organization ID and endpoints are never returned. SDK configuration is not proof of a successful paid API call. Complete login on the host.', basicAccount(a), [], w.native.auth ? { text: w.native.auth } : {});
    }
    case 'config':
      return view('Claude session settings', 'Only audited session flag settings are writable. Reset removes this session override; it does not delete host settings. Managed policy cannot be overridden here.', ['effortLevel', 'autoCompactEnabled'].map(key => {
        const resourceId = w.handles.put('setting', { key });
        const values = key === 'autoCompactEnabled' ? ['true', 'false'] : null;
        return entry(key, w.native.settings?.[key] === undefined ? 'No 喵连 session override' : String(w.native.settings[key]), { controls: [control('Reset session override', { kind: 'reset_config', resourceId }, { confirm: true }), ...(values ? [control('Set flag', { kind: 'set_config', resourceId, value: String(w.native.settings?.[key] ?? true) }, { fields: [field('value', key, { options: values })] })] : [])] });
      }), [control('Thinking effort', { kind: 'thinking' }), ...settingsControls]);
    case 'set_config': {
      const setting = w.handles.get(r.resourceId, 'setting');
      if (setting.key !== 'autoCompactEnabled' || !['true', 'false'].includes(r.value)) throw failure('VALIDATION_FAILED', 'Use the current model effort catalog for thinking settings');
      return p.workspaceControl({ kind: 'set_auto_compaction', enabled: r.value === 'true' }, w, turnId);
    }
    case 'reset_config': {
      const setting = w.handles.get(r.resourceId, 'setting');
      if (!['effortLevel', 'autoCompactEnabled'].includes(setting.key)) throw failure('FORBIDDEN', 'Setting is not in the session flag allowlist');
      await call(p, 'applyFlagSettings', { [setting.key]: null });
      delete (w.native.settings ??= {})[setting.key];
      return view('Session override removed', `${setting.key}: the native runtime resumes its underlying setting. No settings file was erased.`);
    }
    case 'thinking': {
      const list = await call(p, 'supportedModels');
      const selected = list.find(m => m.value === p.selectedModel);
      if (!selected?.supportsEffort || !Array.isArray(selected.supportedEffortLevels)) return view('Thinking effort', 'The selected model did not report supported effort levels. Select a model and refresh; no levels have been invented.');
      const current = (w.native.settings ?? {}).effortLevel ?? null;
      return view('Thinking effort', 'Values come from the selected model. Changes apply to this session and subsequent turns.', selected.supportedEffortLevels.map(value => entry(value, '', { ...(value === current ? { state: 'current' } : {}), controls: [control('Use this effort', { kind: 'set_thinking', value })] })));
    }
    case 'set_thinking': {
      const list = await call(p, 'supportedModels'); const model = list.find(m => m.value === p.selectedModel);
      if (!model?.supportsEffort || !model.supportedEffortLevels?.includes(r.value)) throw failure('CAPABILITY_UNSUPPORTED', 'The selected model did not advertise this effort');
      await call(p, 'applyFlagSettings', { effortLevel: r.value }); (w.native.settings ??= {}).effortLevel = r.value;
      return view('Thinking effort accepted', `${r.value}; session flag layer, effective subject to native managed policy.`);
    }
    case 'permissions':
      return view('Run and permission mode', `Current reported mode: ${w.native.permissionMode ?? 'not reported'}. Bypass permissions and automatic edit acceptance are deliberately not exposed.`, [], ['default', 'plan', 'dontAsk'].map(value => control(value, { kind: 'set_mode', value }, { confirm: true, notice: value === 'dontAsk' ? 'Native denies tools that would require asking; this does not grant permission.' : 'Session-scoped native permission mode.' })));
    case 'set_permission': case 'set_mode':
      if (!['default', 'plan', 'dontAsk'].includes(r.value)) throw failure('FORBIDDEN', 'This permission mode is not exposed by the remote controller');
      await call(p, 'setPermissionMode', r.value); w.native.permissionMode = r.value;
      return view('Native mode accepted', `Session mode: ${r.value}. No host configuration or permission rules were relaxed.`);
    case 'set_auto_compaction':
      await call(p, 'applyFlagSettings', { autoCompactEnabled: r.enabled }); (w.native.settings ??= {}).autoCompactEnabled = r.enabled;
      return view('Automatic compaction updated', `Native session flag: ${r.enabled}; platform queue and retries are unchanged.`);
    case 'retry':
      return view('Native retry and compaction', 'Status is populated from native events. Claude SDK has no public independent automatic-retry policy/abort setter in this integration; stopping the whole turn is a separate action.', [], settingsControls, { text: JSON.stringify({ retry: w.native.retry ?? null, compaction: w.native.compaction ?? null }, null, 2) });
    case 'sources': {
      const usage = await call(p, 'getContextUsage', { detail: 'summary' });
      const rows = (usage.categories ?? []).map(x => entry(x.name, `${x.tokens} tokens`));
      for (const f of usage.memory_files ?? []) {
        const path = p.displayPath(f.path); rows.push(entry(path ?? 'Host-managed instruction source', `${f.type}; ${f.tokens} tokens; ${path ? 'within project' : 'path not exposed outside authorized project'}`));
      }
      return view('Context and instruction sources', 'Native summary; no extra paid full-detail token-count request was made. Source contents remain on the host unless separately read from an authorized project path.', rows);
    }
    case 'output_styles': {
      const list = await call(p, 'reloadOutputStyles');
      return view('Output styles', 'Names returned by the running CLI. Applying a style updates the session flag layer, not a settings file.', list.available_output_styles.map(value => entry(value, '', { controls: [control('Apply output style', { kind: 'set_output_style', value }, { confirm: true })] })));
    }
    case 'set_output_style': {
      const list = await call(p, 'reloadOutputStyles');
      if (!list.available_output_styles.includes(r.value)) throw failure('VALIDATION_FAILED', 'Output style is no longer available');
      await call(p, 'applyFlagSettings', { outputStyle: r.value });
      return view('Output style accepted', `${r.value}; session flag only.`);
    }
    case 'agents': {
      const list = await call(p, 'supportedAgents');
      return view('Available native subagents', 'Selection creates a new managed session using the native definition as the main agent. Its native prompt, tool restrictions and model apply; host permission gates remain. The current session is unchanged.', list.map(a => entry(a.name, `${a.description}\nModel: ${a.model ?? 'inherited'}`, {preset:{sessionId:w.session.sessionId,resourceId:w.handles.put('agent-preset',{name:a.name,model:a.model,description:a.description})}})));
    }
    case 'skills': case 'commands': {
      const list = r.kind === 'skills' ? (await call(p, 'reloadSkills')).skills : await commands(p);
      return view(r.kind === 'skills' ? 'Runtime skills' : 'Native slash commands', 'Only names returned by the current CLI can be invoked. Selecting inserts an explicit command attachment; nothing is executed until Send.', list.map(c => {
        const key = w.handles.put('command', { name: c.name, source: 'claude', description: c.description });
        return entry(c.name, c.description ?? '', { id: key, referenceId: key, state: 'command' });
      }), [control('Reload skills', { kind: 'reload_skills' }, { confirm: true })]);
    }
    case 'reload_skills': {
      const result = await call(p, 'reloadSkills');
      return view('Skills reloaded', `${result.skills.length} current skill commands. Previously issued command handles are revalidated before execution.`, result.skills.map(c => entry(c.name, c.description ?? '')));
    }
    case 'extensions':
      return view('Loaded plugin diagnostics', 'Reload only re-reads host-approved native configuration; it does not install, uninstall, or execute arbitrary packages. Host settings sources are opt-in in the Node configuration.', [entry('Skills','技能与命令',{request:{kind:'skills'}}),entry('MCP','服务、工具与连接状态',{request:{kind:'mcp'}}),...(w.native.plugins ?? []).map(x => entry(x.name, typeof x.version === 'string' ? x.version : 'Version not reported'))], [control('Reload plugins', { kind: 'reload_extensions' }, { confirm: true })]);
    case 'reload_extensions': {
      const result = await call(p, 'reloadPlugins'); w.native.plugins = result.plugins;
      return view('Native plugins reloaded', `${result.plugins.length} plugins; ${result.error_count} reported errors. Individual MCP server status remains inspectable.`, result.plugins.map(x => entry(x.name, x.version ?? 'Version not reported')), [control('Inspect MCP status', { kind: 'mcp' })]);
    }
    case 'mcp': {
      const servers = await call(p, 'mcpServerStatus');
      const controls = Object.entries(p.options.workspacePolicy?.mcpServers ?? {}).map(([name, config]) => control(`Add host-approved ${name}`, { kind: 'add_mcp', resourceId: w.handles.put('mcp-config', { name, config }) }, { confirm: true, notice: 'Starts host-approved configuration. Remote clients never submit shell commands or credentials.' }));
      return view('MCP servers', 'Only server names, statuses, tool metadata and bounded errors are projected. Server commands, headers, tokens and URLs from native configuration are never returned.', servers.map(s => {
        const key = w.handles.put('mcp', { name: s.name });
        return entry(s.name, s.error ? 'Native server error; credential-bearing details remain on the host' : `Scope: ${s.scope ?? 'not reported'}`, { id: key, state: s.status, request: { kind: 'mcp_tools', resourceId: key }, controls: [control('Reconnect', { kind: 'reconnect_mcp', resourceId: key }, { confirm: true }), control(s.status === 'disabled' ? 'Enable' : 'Disable', { kind: 'set_mcp', resourceId: key, enabled: s.status === 'disabled' }, { confirm: true }), ...(w.native.dynamicMcp?.[s.name] ? [control('Remove dynamic session server', { kind: 'remove_mcp', resourceId: key }, { confirm: true })] : [])] });
      }), controls);
    }
    case 'mcp_tools': {
      const { name } = w.handles.get(r.resourceId, 'mcp'); const server = (await call(p, 'mcpServerStatus')).find(s => s.name === name);
      if (!server) throw failure('NOT_FOUND', 'MCP server is no longer registered');
      return view(`${name} tools`, 'Metadata only. Invoking a tool still goes through the native permission gate. This SDK response does not enumerate MCP resources.', (server.tools ?? []).map(t => entry(t.name, `${t.description ?? ''}\n${JSON.stringify(t.annotations ?? {})}`)));
    }
    case 'set_mcp': case 'reconnect_mcp': {
      const { name } = w.handles.get(r.resourceId, 'mcp');
      if (!(await call(p, 'mcpServerStatus')).some(x => x.name === name)) throw failure('NOT_FOUND', 'MCP server disappeared');
      if (r.kind === 'set_mcp') await call(p, 'toggleMcpServer', name, r.enabled); else await call(p, 'reconnectMcpServer', name);
      return p.workspaceControl({ kind: 'mcp' }, w, turnId);
    }
    case 'add_mcp': case 'remove_mcp': {
      const next = { ...(w.native.dynamicMcp ?? {}) };
      if (r.kind === 'add_mcp') { const { name, config } = w.handles.get(r.resourceId, 'mcp-config'); next[name] = config; }
      else { const { name } = w.handles.get(r.resourceId, 'mcp'); if (!Object.hasOwn(next, name)) throw failure('FORBIDDEN', 'Only dynamic session servers added here can be removed'); delete next[name]; }
      const result = await call(p, 'setMcpServers', next);
      // The SDK reports per-server errors. Retain requested map for removal, never claim every server connected.
      w.native.dynamicMcp = next;
      return view('Dynamic MCP configuration submitted', 'Refresh status to inspect connection results. Static plugin/user configuration was not deleted.', [], [control('Refresh MCP', { kind: 'mcp' })], { text: JSON.stringify({ added: result.added, removed: result.removed, errors: Object.keys(result.errors ?? {}).map(name => ({name,error:'Native configuration rejected; inspect this server on the host'})) }, null, 2).slice(0, 16000) });
    }
    case 'tasks':
      return view('Native tasks', 'Separate task IDs and status are preserved. Stopping one task does not cancel the parent session. Parent/child relationships are shown only when provided by native events.', [...w.tasks.values()].map(t => {
        const key = w.handles.put('task', { id: t.id });
        return entry(t.description || t.id, [t.taskType, `Parent session: ${w.session.sessionId}`, t.observedStart ? `First observed: ${t.observedStart} (Node receipt time)` : 'Native start time not reported', t.observedEnd ? `Terminal observed: ${t.observedEnd} (Node receipt time)` : 'Terminal time not observed', t.parentTool ? `Parent tool: ${t.parentTool}` : '', t.summary ?? '',t.blockedBy ? 'Blocked by: '+t.blockedBy.join(', ') : '',t.blocks ? 'Blocks: '+t.blocks.join(', '):''].filter(Boolean).join('\n'), { id: key, state: t.state, request: { kind: 'task', resourceId: key }, controls: t.taskType !== 'structured-todo' && !terminal(t.state) ? [control('Stop this task', { kind: 'stop_task', resourceId: key }, { confirm: true })] : [] });
      }));
    case 'task': {
      const t = w.tasks.get(w.handles.get(r.resourceId, 'task').id); if (!t) throw failure('NOT_FOUND', 'Task no longer available');
      return view(t.description || 'Native task', `State: ${t.state}; ${t.taskType ?? ''}`, [...(t.items??[]),...(t.usage?[entry('用量',JSON.stringify(t.usage))]:[])], [control('刷新详情',{kind:'task',resourceId:r.resourceId}),...(t.taskType !== 'structured-todo' && !terminal(t.state) ? [control('Stop this task', { kind: 'stop_task', resourceId: r.resourceId }, { confirm: true })] : [])], { text: cut([t.summary, t.output,t.stream].filter(Boolean).join('\n'), 16000) });
    }
    case 'stop_task': {
      const t = w.tasks.get(w.handles.get(r.resourceId, 'task').id); if (!t || t.taskType === 'structured-todo' || terminal(t.state)) throw failure('STALE_TURN', 'Task is already terminal or missing');
      await call(p, 'stopTask', t.id); t.stopRequested = true;
      return view('Task stop request accepted', 'Only the selected task was addressed. Refresh for the native terminal notification; no stopped status is fabricated.', [], [control('Refresh tasks', { kind: 'tasks' })]);
    }
    case 'checkpoints':
      return view('Native file checkpoints', 'These are user-message IDs observed in this managed session with SDK file checkpointing enabled. A checkpoint exists for restoration only if the native dry run confirms it.', [...w.checkpoints.values()].map(c => {
        const key = w.handles.put('checkpoint', c);
        return entry(c.label, c.createdAt, { controls: [control('Preview native restoration', { kind: 'restore_preview', resourceId: key })] });
      }));
    case 'restore_preview': {
      const checkpoint = w.handles.get(r.resourceId, 'checkpoint');
      const result = await call(p, 'rewindFiles', checkpoint.uuid, { dryRun: true });
      if (!result.canRewind) return view('Restoration unavailable', result.error || 'Native runtime cannot rewind this checkpoint');
      const files = [];
      for (const path of result.filesChanged ?? []) {
        const absolute = resolve(p.options.cwd, path); const stat = await w.files.check(absolute);
        if (!stat.isFile()) throw failure('FORBIDDEN', 'Restoration preview contains a non-regular or excluded file');
        const key = w.handles.put('file', { path: absolute, identity: stat }); const file = await w.files.bytes(key);
        files.push({ key, version: file.version, name: p.displayPath(absolute) });
      }
      const version = digest({ uuid: checkpoint.uuid, files, turn: w.session.turnId });
      const resourceId = w.handles.put('restore', { checkpoint, files, version, turn: w.session.turnId, used: false }, { ttl: 2 * 60 * 1000 });
      return view('Native restoration preview', 'Only the native file checkpoint is restored. This does not rewind conversation history, delete platform history or perform git reset. Recheck every file before applying.', files.map(f => entry(f.name, f.version)), [control('Apply this exact preview', { kind: 'restore_apply', resourceId, version }, { confirm: true })]);
    }
    case 'restore_apply': {
      const preview = w.handles.get(r.resourceId, 'restore');
      if (preview.used || preview.version !== r.version || preview.turn !== w.session.turnId) throw failure('SOURCE_CONFLICT', 'Restoration preview is stale or already consumed');
      for (const file of preview.files) await w.files.bytes(file.key, file.version);
      const second = await call(p, 'rewindFiles', preview.checkpoint.uuid, { dryRun: true });
      if (!second.canRewind || JSON.stringify((second.filesChanged ?? []).map(x => p.displayPath(x)).sort()) !== JSON.stringify(preview.files.map(x => x.name).sort())) throw failure('SOURCE_CONFLICT', 'Native restoration scope changed since preview');
      preview.used = true;
      const result = await call(p, 'rewindFiles', preview.checkpoint.uuid, { dryRun: false });
      const skipped = Number.isSafeInteger(result.skippedLinks) && result.skippedLinks >= 0 ? result.skippedLinks : null;
      const notice = result.error || (result.canRewind ? 'Native rewind returned success; this is not a per-file success guarantee.' : 'Native rewind was not completed.');
      return view('Native restoration result', notice + ' The SDK reports a link-safety skip count but no complete per-file failure list. Files below are native-reported, not independently classified as restored.', [entry('Link-safety skipped files', skipped === null ? 'Not reported by this SDK response' : String(skipped)), ...(result.filesChanged ?? []).map(path => entry(p.displayPath(path) ?? 'Outside-project path withheld', 'Native returned file'))]);
    }
    case 'history': {
      const list = await sdk(p).listSessions({ ...opts(p), includeWorktrees: false, limit: 100, offset: 0 });
      const rows = [];
      for (const s of list) {
        if (s.cwd && await realpath(s.cwd).catch(() => null) !== p.options.cwd) continue;
        const sourceSessionId=p.options.nativeSessionOwner?.(s.sessionId);
        const external=!sourceSessionId && s.sessionId!==p.nativeSessionId && !!s.cwd;
        const key = w.handles.put('history', { sessionId: s.sessionId, cwd: p.options.cwd, lastModified: s.lastModified, sourceSessionId, external });
        rows.push(entry(s.customTitle || s.summary, `${new Date(s.lastModified).toISOString()}${s.tag ? `; tag: ${s.tag}` : ''}`, { id: key, state: s.sessionId === p.nativeSessionId ? 'current' : 'history', request: { kind: 'history_messages', resourceId: key, offset: 0 }, ...(s.sessionId !== p.nativeSessionId && p.options.nativeSessionIdle?.(s.sessionId) && sourceSessionId ? { origin: { sessionId: w.session.sessionId, sourceSessionId, resourceId: key, mode: 'resume' }, controls: [control('Delete this native transcript', { kind: 'native_delete', resourceId: key }, { confirm: true, notice: 'Only this native transcript, not its descendants or project files. An active native session cannot be deleted through this page.' })] } : external ? {origin:{sessionId:w.session.sessionId,resourceId:key,mode:'import'}} : {state:'readonly'}) }));
      }
      return view('Native project history', 'Only this exact authorized project; sibling worktrees are excluded. External native histories can be copied into independent 喵连 sessions. Stop the original terminal task before continuing. JSON transcript uploads are not native resumable sessions. Externally owned running processes cannot be attached by PID.', rows, [], { truncated: list.length === 100 });
    }
    case 'history_messages': {
      const history = w.handles.get(r.resourceId, 'history');
      const messages = await sdk(p).getSessionMessages(history.sessionId, { ...opts(p), offset: r.offset ?? 0, limit: 30 });
      const rows = messages.map(m => {
        const pointId = w.handles.put('history-point', { sessionId: history.sessionId, uuid: m.uuid, nativePoint: m.uuid });
        const text = typeof m.message === 'object' && m.message ? textContent(m.message.content) : '';
        return entry(m.type, cut(text, 4000), { ...(history.sourceSessionId && p.options.nativeSessionIdle?.(history.sessionId) ? {origin: { sessionId: w.session.sessionId, sourceSessionId: history.sourceSessionId, resourceId: r.resourceId, mode: 'fork', pointId, pointLabel: m.uuid }} : {state:'readonly'}) });
      });
      return view('Native history messages', 'Fork creates a new native transcript at the selected message. The source is not overwritten. Non-text content is not fabricated as text.', rows, messages.length === 30 ? [control('Next history page', { kind: 'history_messages', resourceId: r.resourceId, offset: (r.offset ?? 0) + 30 })] : []);
    }
    case 'native_rename':
      if (p.options.workspacePolicy?.persistHistory === false) throw failure('CAPABILITY_UNSUPPORTED', 'Native transcript persistence is disabled');
      await sdk(p).renameSession(p.nativeSessionId, r.name, opts(p));
      return view('Native session renamed', 'This changes the native transcript title. Platform title and tags are managed separately.');
    case 'native_delete': {
      const h = w.handles.get(r.resourceId, 'history');
      if (h.sessionId === p.nativeSessionId || !p.options.nativeSessionIdle?.(h.sessionId)) throw failure('READ_ONLY', 'Only a verified inactive 喵连-owned native session can be deleted');
      const current = await sdk(p).getSessionInfo(h.sessionId, opts(p));
      if (!current || current.lastModified !== h.lastModified) throw failure('SOURCE_CONFLICT', 'Native history changed; refresh before deleting');
      await sdk(p).deleteSession(h.sessionId, opts(p)); w.handles.remove(r.resourceId);
      return view('Native transcript deleted', 'Only the selected transcript was removed. Platform history, descendants and project files remain.');
    }
    default: throw failure('CAPABILITY_UNSUPPORTED', 'This native capability is not exposed by the installed Claude SDK integration');
  }
}

export async function claudeOrigin(h, mode, point, w) {
  if (h.cwd !== this.options.cwd) throw failure('FORBIDDEN', 'History belongs to another project');
  if (mode === 'attach') throw failure('CAPABILITY_UNSUPPORTED', 'Arbitrary terminal processes have no authenticated managed attachment channel; history remains read-only');
  const importing=mode==='import';
  if(importing) {
    if(!h.external || h.sourceSessionId || this.options.nativeSessionOwner?.(h.sessionId) || h.sessionId===this.nativeSessionId) throw failure('READ_ONLY','Only external history can be imported as a separate native copy');
  } else if (h.sessionId === this.nativeSessionId && this.busy || !this.options.nativeSessionIdle?.(h.sessionId)) throw failure('READ_ONLY', 'Native history is active or ownership is not verified');
  const current = await sdk(this).getSessionInfo(h.sessionId, opts(this));
  if (!current || current.lastModified !== h.lastModified) throw failure('SOURCE_CONFLICT', 'Native history changed since it was listed');
  if(importing && (!current.cwd || await realpath(current.cwd).catch(()=>null)!==this.options.cwd)) throw failure('FORBIDDEN','Native history no longer belongs to the authorized project');
  if (mode === 'resume') return { type: 'claude', resume: h.sessionId };
  if (point && point.sessionId !== h.sessionId) throw failure('FORBIDDEN', 'History point belongs to another native session');
  // Native SDK performs the copy; transcript text is never sent as a fake resume prompt.
  const fork = await sdk(this).forkSession(h.sessionId, { ...opts(this), ...(point ? { upToMessageId: point.uuid } : {}) });
  if(importing) {
    if(!fork?.sessionId || fork.sessionId===h.sessionId) throw failure('PROTOCOL_UNSUPPORTED','Native import did not create an independent transcript',false);
    const after=await sdk(this).getSessionInfo(h.sessionId,opts(this));
    if(!after || after.lastModified!==h.lastModified) throw failure('SOURCE_CONFLICT','Source history changed during import; refresh before continuing');
  }
  return { type: 'claude', resume: fork.sessionId };
}

export function observeClaude(p, m) {
  const w = p.workspace; if (!w) return;
  if (m.type === 'auth_status') w.native.auth = m.isAuthenticating ? 'Native authentication in progress' : m.error ? 'Native authentication failed; inspect the host for details' : 'Native authentication flow ended';
  if (m.type === 'system' && m.subtype === 'init') { w.native.permissionMode = m.permissionMode; w.native.plugins = m.plugins; p.selectedModel = m.model; }
  if (m.type === 'system' && m.subtype === 'api_retry') w.native.retry = { attempt: m.attempt, maxRetries: m.max_retries, delayMs: m.retry_delay_ms, status: m.error_status, error: m.error, observedAt: new Date().toISOString() };
  if (m.type === 'system' && m.subtype === 'compact_boundary') w.native.compaction = { trigger: m.compact_metadata.trigger, beforeTokens: m.compact_metadata.pre_tokens, afterTokens: m.compact_metadata.post_tokens ?? null, durationMs: m.compact_metadata.duration_ms ?? null, state: 'completed' };
  if (m.type === 'system' && m.subtype === 'status' && (m.status === 'compacting' || m.compact_result)) w.native.compaction = { state: m.compact_result ?? 'running', error: m.compact_error ? cut(m.compact_error, 1000) : null };
  if (m.type === 'user' && m.uuid && !m.parent_tool_use_id) { w.checkpoints.set(m.uuid, { uuid: m.uuid, label: 'Input ' + m.uuid, createdAt: new Date().toISOString() }); if (w.checkpoints.size > 100) w.checkpoints.delete(w.checkpoints.keys().next().value); }
  if (m.type === 'system' && ['task_started', 'task_progress', 'task_notification', 'task_updated'].includes(m.subtype)) {
    const t = w.tasks.get(m.task_id) ?? { id: m.task_id, state: 'running', items: [], observedStart: new Date().toISOString() };
    if (m.subtype === 'task_started') { t.description = m.description; t.taskType = m.task_type; t.parentTool = m.tool_use_id; }
    if (m.subtype === 'task_progress') { t.summary = m.summary; t.description = m.description; t.usage = m.usage; }
    if (m.subtype === 'task_notification') { t.state = m.status; t.summary = m.summary; t.usage = m.usage; }
    if (m.subtype === 'task_updated') { if (m.patch.status) t.state = m.patch.status; if (m.patch.description) t.description = m.patch.description; if (m.patch.error) t.summary = cut(m.patch.error, 2000); }
    if (terminal(t.state)) t.observedEnd ??= new Date().toISOString();
    w.tasks.set(t.id, t); if (w.tasks.size > 100) { const old = [...w.tasks.values()].find(x => terminal(x.state)); if (old) w.tasks.delete(old.id); }
  }
  if (m.parent_tool_use_id && ['assistant', 'user'].includes(m.type)) {
    const t = [...w.tasks.values()].find(x => x.parentTool === m.parent_tool_use_id);
    if (t) {
      t.seen??=[];if(m.uuid&&t.seen.includes(m.uuid))return;
      if(m.uuid)t.seen=[...t.seen,m.uuid].slice(-100);
      const parts=m.message?.content;
      const detail=Array.isArray(parts)?parts.map(x=>x.type==='tool_use'?`工具 ${x.name} (${x.id})\n${JSON.stringify(x.input)}`:x.type==='tool_result'?`工具结果 ${x.tool_use_id}${x.is_error?' · 失败':''}\n${typeof x.content==='string'?x.content:textContent(x.content)}`:x.text??'').filter(Boolean).join('\n'):textContent(parts);
      t.items.push(entry(m.type,cut(detail,4000)));t.items=t.items.slice(-50);t.stream='';
    }
  }
  if(m.parent_tool_use_id&&m.type==='stream_event'&&m.event?.type==='content_block_delta'&&m.event.delta?.type==='text_delta') {
    const t=[...w.tasks.values()].find(x=>x.parentTool===m.parent_tool_use_id);
    if(t)t.stream=cut((t.stream??'')+m.event.delta.text,16000);
  }
  if(m.type==='system' && m.subtype==='background_tasks_changed') {
    const live=new Set((m.tasks??[]).map(t=>t.task_id));
    for(const t of w.tasks.values()) if(t.background && !live.has(t.id)) {t.background=false;if(!terminal(t.state))t.state='unknown';}
    for(const row of m.tasks??[]) {
      const t=w.tasks.get(row.task_id)??{id:row.task_id,state:'running',items:[]};
      Object.assign(t,{background:true,taskType:row.task_type,description:row.description});w.tasks.set(t.id,t);
    }
  }
  if(m.type==='system' && ['hook_started','hook_progress','hook_response'].includes(m.subtype)) {
    const name=typeof m.hook_name==='string'?m.hook_name:'Native hook';
    w.widgets.set('hook:'+m.hook_id,entry(name,typeof m.output==='string'?cut(m.output,1800):m.subtype));
    if(w.widgets.size>100)w.widgets.delete(w.widgets.keys().next().value);
  }
  if(m.type==='assistant')for(const b of m.message?.content??[])if(b.type==='tool_use'&&['TaskCreate','TaskGet','TaskUpdate','TaskList'].includes(b.name))(w.native.taskTools??=new Map()).set(b.id,b.name);
  if(m.type==='user' && Array.isArray(m.message?.content)) {
    const results=m.message.content.filter(b=>b.type==='tool_result');
    if(results.length===1){
      const b=results[0],kind=w.native.taskTools?.get(b.tool_use_id),out=m.tool_use_result;
      if(kind && !b.is_error && out && typeof out==='object'){
        const rows=kind==='TaskList'?out.tasks:kind==='TaskGet'||kind==='TaskCreate'?[out.task]:[];
        for(const row of Array.isArray(rows)?rows:[])if(row&&typeof row.id==='string'&&typeof row.subject==='string'){
          const key='todo:'+row.id;const t=w.tasks.get(key)??{id:key,items:[],state:'unknown'};
          t.description=row.subject;t.taskType='structured-todo';t.summary=typeof row.description==='string'?row.description:t.summary;
          if(['pending','in_progress','completed'].includes(row.status))t.state=row.status;
          if(Array.isArray(row.blockedBy)&&row.blockedBy.every(x=>typeof x==='string'))t.blockedBy=row.blockedBy;
          if(Array.isArray(row.blocks)&&row.blocks.every(x=>typeof x==='string'))t.blocks=row.blocks;
          w.tasks.set(key,t);
        }
        if(kind==='TaskUpdate'&&out.success===true&&typeof out.taskId==='string'&&out.statusChange){const t=w.tasks.get('todo:'+out.taskId);if(t&&['pending','in_progress','completed','deleted'].includes(out.statusChange.to))t.state=out.statusChange.to;}
      }
      w.native.taskTools?.delete(b.tool_use_id);
    }
  }
  if (m.type === 'assistant') for (const block of m.message?.content ?? []) if (block.type === 'tool_use' && ['Write', 'Edit', 'NotebookEdit'].includes(block.name)) (w.native.fileTools ??= new Map()).set(block.id, block.name === 'NotebookEdit' ? block.input.notebook_path : block.input.file_path);
  if (m.type === 'user') for (const block of Array.isArray(m.message?.content) ? m.message.content : []) if (block.type === 'tool_result') {
    const path = w.native.fileTools?.get(block.tool_use_id);
    if (path && !block.is_error) void w.files.record(path, p.turnId).catch(() => {});
    w.native.fileTools?.delete(block.tool_use_id);
  }
}
