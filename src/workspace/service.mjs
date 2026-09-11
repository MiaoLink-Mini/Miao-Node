import { readFileSync } from 'node:fs';
import { Handles } from './handles.mjs';
import { ProjectFiles, Uploads, FILE_LIMITS } from './files.mjs';
import { projectView } from './project.mjs';
import { entry, control, field, view, boundView } from './view.mjs';
import { failure, cut } from '../common.mjs';
import { validate } from '../protocol.mjs';

export const operations = new Map(JSON.parse(readFileSync(new URL('../../../WeAgent-Backend/contracts/workspace-operations.json', import.meta.url), 'utf8')).map(x => [x.kind, Object.freeze(x)]));
const TERMINAL = new Set(['completed', 'cancelled', 'failed']);

/** Every identifier in a view is scoped to this session and expires. No remote raw path/RPC dispatch. */
export class Workspace {
  constructor({ session, project, projects, plugin, stateDir, save = () => {}, close, schedule = () => {} }) {
    this.session = session; this.project = project; this.projects = projects; this.plugin = plugin; this.save = save; this.closeSession = close; this.schedule = schedule;
    this.handles = new Handles(); this.files = new ProjectFiles(project.path, this.handles);
    this.uploads = new Uploads(stateDir, session.sessionId, this.handles);
    this.tasks = new Map(); this.widgets = new Map(); this.diagnostics = []; this.checkpoints = new Map(); this.native = {};
    if (plugin) plugin.workspace = this;
  }
  check(request) {
    validate('WorkspaceRequest', request);
    const op = operations.get(request.kind);
    if (!op) throw failure('CAPABILITY_UNSUPPORTED', 'Unknown workspace operation');
    if (this.session.state === 'closed' && !op.closed) throw failure('READ_ONLY', 'This operation requires a live managed Agent');
    if (op.idle && !TERMINAL.has(this.session.state)) throw failure('STALE_TURN', 'Wait until the current turn has finished');
    return op;
  }
  async execute(request, turnId, { prechecked = false } = {}) {
    if (!prechecked) this.check(request); await this.uploads.sweep();
    let result;
    switch (request.kind) {
      case 'overview': result = this.overview(); break;
      case 'project': result = await projectView(this.project.path, this.projects); break;
      case 'files': result = await this.files.list(); break;
      case 'list_files': result = await this.files.list(request.resourceId, request.offset); break;
      case 'read_file': result = await this.files.read(request); break;
      case 'file_status': {
        let state='unchanged';try{await this.files.bytes(request.resourceId,request.version);}catch(error){if(error.code==='SOURCE_CONFLICT')state='changed';else if(['NOT_FOUND','ENOENT','FORBIDDEN'].includes(error.code))state='unavailable';else throw error;}
        result=view('Open file version','The displayed text is a snapshot. Changed content is never merged automatically.',[entry('Version check','',{state})]);break;
      }
      case 'artifacts': result = await this.files.recent(); break;
      case 'attachments': result = this.uploads.list(); break;
      case 'begin_upload': result = await this.uploads.begin(request); break;
      case 'upload_chunk': result = await this.uploads.chunk(request); break;
      case 'commit_upload': result = await this.uploads.commit(request.resourceId); break;
      case 'discard_upload': result = await this.uploads.discard(request.resourceId); break;
      case 'queue': result = this.queueView(); break;
      case 'set_queue_policy':
        if (!['automatic', 'manual'].includes(request.value)) throw failure('VALIDATION_FAILED', 'Unknown platform queue policy');
        this.session.queuePolicy = request.value; this.save(); result = this.queueView(); this.schedule(); break;
      case 'close':
        await this.closeSession(); result = view('Managed process closed', 'Only this owned Agent process was closed. Native history and project files were not deleted. Accepted operation receipts are retained.'); break;
      case 'widgets': result = view(this.native.title || 'Runtime interface', 'Native status and widgets; informational text is not a command. Prefill is applied only after a separate user action.', [...this.widgets.values()], [], this.native.prefill ? { prefill: cut(this.native.prefill, 4000) } : {}); break;
      case 'diagnostics': result = view('Runtime diagnostics', 'Individual extension errors do not imply that every component or the entire Agent has failed.', this.diagnostics.slice(-100).reverse()); break;
      case 'external': {
        const target = this.handles.get(request.resourceId, 'external');
        const url = new URL(target.url);
        if (url.protocol !== 'https:' || url.username || url.password) throw failure('FORBIDDEN', 'External interaction must use an HTTPS URL without embedded credentials');
        result = view(target.label, `External domain: ${url.hostname}. Open only after checking this domain. No authorization has been approved by 喵连.`, [], [], { externalUrl: url.href }); break;
      }
      default:
        if (!this.plugin?.workspaceControl) throw failure('CAPABILITY_UNSUPPORTED', 'The installed Agent adapter does not expose this native operation');
        result = await this.plugin.workspaceControl(request, this, turnId);
    }
    if (this.session.state === 'closed') {
      const allowed = c => operations.get(c.request?.kind)?.closed;
      result.controls = (result.controls ?? []).filter(allowed);
      result.entries=(result.entries??[]).filter(item=>!item.request||operations.get(item.request.kind)?.closed);
      for (const item of result.entries ?? []) if (item.controls) item.controls = item.controls.filter(allowed);
    }
    const wrapped = { action: 'workspace', requestKind: request.kind, view: boundView(result) };
    validate('NativeResult', wrapped); return wrapped;
  }
  overview() {
    const basic = [['project', 'Project and worktrees'], ['files', 'Authorized files'], ['attachments', 'Upload and attachments'], ['artifacts', 'Generated files'], ['queue', 'Input queue'], ['widgets', 'Runtime widgets'], ['diagnostics', 'Diagnostics']];
    const native = this.plugin?.workspaceSections ?? [];
    return view('Agent workspace', 'Real operations use the current managed session. A capability is not considered supported merely because its request name exists in the protocol.', [...basic, ...native].map(([kind, label]) => entry(label, '', { request: { kind } })), [...(this.session.capabilities?.steer && ['running','waiting_approval','waiting_input'].includes(this.session.state) ? [control('Steer the running turn', {kind:'steer',text:'Continue the current task.'}, {fields:[field('text','Additional instruction')],confirm:true,notice:'Sends this instruction into the running native turn; it does not create a follow-up queue item.'})] : []), control('Close managed process', { kind: 'close' }, { confirm: true })]);
  }
  queueView() {
    const items = this.session.queue ?? [];
    return view('Platform input queue', 'FIFO dispatch begins only after a completed turn. Failed/cancelled turns and process restarts never automatically replay queued work. Native steering/follow-up policies are separate.', items.map(q => entry(q.text, `Operation ${q.operationId}`, { id: q.id, state: q.state })), [control('Queue policy', { kind: 'set_queue_policy', value: this.session.queuePolicy ?? 'automatic' }, { fields: [field('value', 'Dispatch', { options: ['automatic', 'manual'] })] })], { queuePolicy: this.session.queuePolicy ?? 'automatic' });
  }
  diagnostic(component, message) {
    this.diagnostics.push(entry(component, message)); if (this.diagnostics.length > 100) this.diagnostics.shift();
  }
  external(label, url, ttl=15*60*1000) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw failure('CAPABILITY_UNSUPPORTED', 'External URL is not safe to publish');
    const resourceId = this.handles.put('external', { label, url: parsed.href },{ttl});
    return control(`Open ${parsed.hostname}`, { kind: 'external', resourceId }, { confirm: true });
  }
  async input(text, payload = {}) {
    const attachments = [], references = [];
    for (const key of payload.attachments ?? []) attachments.push(await this.uploads.content(key));
    for (const key of payload.references ?? []) references.push(await this.files.bytes(key));
    const total = [...attachments, ...references].reduce((n, x) => n + x.bytes.length, 0);
    if (total > FILE_LIMITS.promptBytes) throw failure('PAYLOAD_TOO_LARGE', 'Combined input files exceed the 600 KiB input limit');
    const command = payload.commandId ? this.handles.get(payload.commandId, 'command') : null;
    if (command && !this.plugin?.prepareCommand) throw failure('CAPABILITY_UNSUPPORTED', 'Runtime command invocation is not available');
    const input = { text, attachments, references, command };
    if (this.plugin?.validateInput) await this.plugin.validateInput(input);
    else if (attachments.length || references.length || command) throw failure('CAPABILITY_UNSUPPORTED', 'This Agent has no structured file input support');
    else this.plugin.validatePrompt(text);
    return input;
  }
  async resolvePreset(resourceId) {
    if(!this.plugin?.resolvePreset || this.session.state === 'closed') throw failure('CAPABILITY_UNSUPPORTED','Live native agent discovery is required');
    return this.plugin.resolvePreset(this.handles.get(resourceId,'agent-preset'));
  }
  async origin(resourceId, mode, pointId, sourceSessionId, pointLabel) {
    if (!['resume', 'fork', 'clone', 'attach', 'import'].includes(mode)) throw failure('VALIDATION_FAILED', 'Unsupported origin mode');
    if (!this.plugin?.resolveOrigin) throw failure('CAPABILITY_UNSUPPORTED', 'Native history cannot be resumed by this adapter');
    const history = this.handles.get(resourceId, 'history');
    if (mode === 'import') {
      if (!history.external || history.sourceSessionId || sourceSessionId || pointId || pointLabel) throw failure('FORBIDDEN', 'Only a listed external history can be imported');
      return this.plugin.resolveOrigin(history, mode, null, this);
    }
    if (!history.sourceSessionId || sourceSessionId !== history.sourceSessionId) throw failure('FORBIDDEN', 'History source does not match its issued resource');
    if (mode === 'resume' && !this.plugin.options.nativeSessionClosed?.(history.sessionId ?? history.threadId)) throw failure('READ_ONLY', 'Close every managed process owning this native history before resuming it; fork or clone keep the source separate');
    const point = pointId ? this.handles.get(pointId, 'history-point') : null;
    if (point && (mode !== 'fork' || point.nativePoint !== pointLabel) || !point && pointLabel !== undefined) throw failure('VALIDATION_FAILED', 'Fork point label must match its verified native identity; a full clone has no selected cutoff');
    return this.plugin.resolveOrigin(history, mode, point, this);
  }
  async dispose() { if(this.ownsHistoryReader) { await this.plugin?.close(); this.plugin=null; this.ownsHistoryReader=false; } await this.uploads.close(); this.handles.clear(); }
}
