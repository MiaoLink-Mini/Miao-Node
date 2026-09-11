import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { State, readOnlyCommand } from './state.mjs';
import { discover, makePlugin } from './config.mjs';
import { validate, frame } from './protocol.mjs';
import { Workspace, operations as workspaceOperations } from './workspace/service.mjs';
import { projectInfo } from './workspace/project.mjs';
import { bounded, capabilities, deferred, digest, failure, id } from './common.mjs';

export class Daemon {
  constructor(config, { state, pluginFactory = makePlugin, discoverProfile = discover, report = value => process.stdout.write(JSON.stringify(value) + '\n') } = {}) {
    this.config = config; this.state = state ?? new State(config.stateDir); this.pluginFactory = pluginFactory;
    this.discoverProfile = discoverProfile; this.report = report; this.active = new Map(); this.workspaces = new Map(); this.dispatching = new Set(); this.liveSessions = new Map(); this.inFlight = new Set(); this.tasks = new Set();
    this.abort = new AbortController(); this.offset = 0; this.epoch = 0; this.closed = false; this.poisoned = false;
    this.identity = this.state.get('identity');
    if (!this.identity) {
      const { privateKey } = generateKeyPairSync('ed25519');
      this.identity = { privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), nodeId: null };
      this.state.set('identity', this.identity); this.state.markInitialized();
    }
    if (this.identity.gateway && this.identity.gateway !== config.gateway) throw new Error('身份已绑定其他 Gateway，请使用独立状态目录');
    this.identity.gateway = config.gateway; this.state.set('identity', this.identity);
    this.key = createPrivateKey({ key: Buffer.from(this.identity.privateKey, 'base64'), type: 'pkcs8', format: 'der' });
    this.state.recover();
  }
  async initialize() {
    const namespace = createPublicKey(this.key).export({ format: 'jwk' }).x;
    this.profiles = await Promise.all(this.config.profiles.map(this.discoverProfile));
    this.projects = this.config.projects.map(p => ({ ...p, id: `project_${digest([namespace, p.id]).slice(0, 32)}` }));
    for (const profile of this.profiles) {
      profile.id = `agent_${digest([namespace, profile.id]).slice(0, 32)}`;
      const fingerprint = digest([profile.capabilities, profile.adapterVersion, profile.version]);
      const old = this.state.get(profile.id);
      profile.capabilityRevision = old ? old.revision + Number(old.fingerprint !== fingerprint) : 1;
      this.state.set(profile.id, { fingerprint, revision: profile.capabilityRevision });
    }
  }
  serverNow() { return Date.now() + this.offset; }
  async api(method, path, token, body, schema) {
    const response = await fetch(this.config.gateway + path, { method, redirect: 'error', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10000)]) });
    // Bound decoded bytes while reading, not after an untrusted response has filled memory.
    const reader = response.body?.getReader(), chunks = []; let size = 0;
    try {
      if (Number(response.headers.get('content-length')) > 256 * 1024) throw failure('PROTOCOL_UNSUPPORTED', 'Gateway HTTP 响应超出上限');
      if (reader) while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 256 * 1024) throw failure('PROTOCOL_UNSUPPORTED', 'Gateway HTTP 响应超出上限');
        chunks.push(value);
      }
    } catch (error) { await reader?.cancel().catch(() => {}); throw error; }
    finally { reader?.releaseLock(); }
    if (!response.ok) throw failure('SERVICE_UNAVAILABLE', `Gateway HTTP ${response.status}`);
    let result;
    try { result = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
    catch { throw failure('PROTOCOL_UNSUPPORTED', 'Gateway HTTP 响应不是有效 JSON'); }
    return schema ? validate(schema, result) : result;
  }
  async pair() {
    let enrollment = this.state.get('enrollment');
    if (enrollment && Date.parse(enrollment.expiresAt) <= this.serverNow()) enrollment = null;
    if (!enrollment) {
      const jwk = createPublicKey(this.key).export({ format: 'jwk' });
      enrollment = await this.api('POST', '/v1/node/enrollments', null, { publicKey: Buffer.from(jwk.x, 'base64url').toString('base64'), name: this.config.name, platform: { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform] ?? 'other', version: 'weagent-node/0.1.0' }, 'Enrollment');
      this.state.set('enrollment', enrollment);
    }
    this.report({ event: 'pairing', code: enrollment.code, keyFingerprint: enrollment.keyFingerprint, expiresAt: enrollment.expiresAt });
    while (!this.closed) {
      const status = await this.api('GET', `/v1/node/enrollments/${enrollment.id}`, enrollment.pollToken, null, 'EnrollmentStatus');
      if (status.state === 'confirmed') { this.identity.nodeId = status.nodeId; this.state.set('identity', this.identity); this.state.set('enrollment', null); return; }
      if (status.state === 'expired') { this.state.set('enrollment', null); return; }
      await sleep(1500, undefined, { signal: this.abort.signal });
    }
  }
  async run() {
    await this.initialize(); let retries = 0;
    while (!this.closed && !this.poisoned) {
      try {
        if (!this.identity.nodeId) { await this.pair(); continue; }
        // Brief/flapping connections must not reset exponential backoff.
        if (await this.connect()) retries = 0;
      } catch (e) {
        if (this.closed || this.poisoned) break;
        this.report({ event: 'retry', code: e.code ?? 'SERVICE_UNAVAILABLE' });
      }
      if (!this.closed && !this.poisoned) await sleep(Math.min(30000, 1000 * 2 ** Math.min(retries++, 5)), undefined, { signal: this.abort.signal }).catch(() => {});
    }
  }
  async connect() {
    const challenge = await this.api('POST', '/v1/node/auth/challenges', null, { nodeId: this.identity.nodeId }, 'NodeChallenge');
    const proof = await this.api('POST', '/v1/node/auth/prove', null, { challengeId: challenge.id, signature: sign(null, Buffer.from(challenge.signingInput), this.key).toString('base64') }, 'NodeToken');
    const socket = new WebSocket(this.config.gateway.replace(/^http/, 'ws') + '/v1/ws/node', { headers: { Authorization: `Bearer ${proof.accessToken}` }, maxPayload: 256 * 1024, handshakeTimeout: 10000, followRedirects: false });
    this.socket = socket; this.ready = false; this.sentOrdinal = 0;
    const disconnected = deferred(); let heartbeat, readyTimer, connectedAt, connectionError;
    socket.on('open', () => {
      readyTimer = setTimeout(() => {
        connectionError = failure('SERVICE_UNAVAILABLE', 'Gateway 未按时发送 node.ready', false);
        socket.terminate();
      }, 10000);
    });
    socket.on('error', () => { connectionError = failure('NODE_OFFLINE', 'Node 通道连接失败', false); socket.terminate(); });
    socket.on('close', () => {
      clearTimeout(readyTimer); clearInterval(heartbeat);
      if (this.socket === socket) this.ready = false;
      if (!connectedAt && !this.closed && !this.poisoned) disconnected.reject(connectionError ?? failure('NODE_OFFLINE', 'Node 就绪前连接已断开', false));
      else disconnected.resolve(!!connectedAt && Date.now() - connectedAt >= 30000);
    });
    socket.on('message', bytes => {
      if (this.socket !== socket) return;
      try {
        const message = validate('GatewayToNodeFrame', JSON.parse(bytes.toString('utf8'))), d = message.data;
        if (message.type === 'node.ready') {
          if (this.ready || d.nodeId !== this.identity.nodeId) throw failure('PROTOCOL_UNSUPPORTED', 'Node 握手身份冲突');
          clearTimeout(readyTimer); connectedAt = Date.now();
          this.epoch = d.epoch; this.offset = Date.parse(d.serverTime) - Date.now(); this.lastHeartbeat = Date.now();
          this.ready = true;
          void this.synchronize(socket).catch(() => socket.terminate());
          heartbeat = setInterval(() => {
            if (Date.now() - this.lastHeartbeat > d.heartbeatSeconds * 3000) { socket.terminate(); return; }
            this.send('node.heartbeat', { nonce: id('hb') }).catch(() => socket.terminate());
          }, d.heartbeatSeconds * 1000);
        } else if (message.type === 'error') {
          this.report({ event: 'gateway-error', code: d.code });
          // Protocol/source conflicts require inspection, not an endless reconnect loop.
          if (['SOURCE_CONFLICT', 'PROTOCOL_UNSUPPORTED', 'HISTORY_PURGED'].includes(d.code)) this.poison();
          socket.terminate();
        } else {
          if (!this.ready || (message.type === 'command' ? d.nodeEpoch : d.epoch) !== this.epoch) throw failure('PROTOCOL_UNSUPPORTED', '旧 epoch 消息被拒绝');
          if (message.type === 'command') {
            const task = this.command(d).catch(() => this.poison()); this.tasks.add(task);
            void task.finally(() => this.tasks.delete(task));
          }
          if (message.type === 'command.query') this.receipt(this.state.operation(d.operationId), 'command.status', d.operationId);
          if (message.type === 'events.ack') this.state.ack(d.sessionId, d.sourceSequence);
          if (message.type === 'node.heartbeat') { this.offset = Date.parse(d.serverTime) - Date.now(); this.lastHeartbeat = Date.now(); }
        }
      } catch { this.poison(); socket.terminate(); }
    });
    return await disconnected.promise;
  }
  async send(type, data) {
    const message = validate('NodeToGatewayFrame', frame(type, { ...data, epoch: this.epoch }));
    const socket = this.socket;
    if (!this.ready || socket?.readyState !== WebSocket.OPEN) throw failure('NODE_OFFLINE', 'Node 通道未连接', false);
    await bounded(new Promise((resolve, reject) => socket.send(JSON.stringify(message), e => e ? reject(e) : resolve())), 5000);
  }
  async synchronize(socket = this.socket) {
    const current = () => this.socket === socket && this.ready && !this.closed;
    const projects = await Promise.all(this.projects.map(async p => { const info = await projectInfo(p.path); return { id: p.id, name: p.name, description: p.description, branch: info.branch, valid: info.valid }; }));
    if (!current()) return;
    await this.send('node.inventory', { inventoryId: id('inv'), projects, agents: this.profiles.map(p => ({ id: p.id, name: p.name, state: p.state, version: p.version, adapterVersion: p.adapterVersion, capabilities: p.capabilities, capabilityRevision: p.capabilityRevision })), complete: true });
    if (!current()) return;
    // Re-emit current state after older spool entries. Reconnect is not a native restart.
    for (const session of this.state.sessions()) this.emitState(session);
    await this.pump();
    if (!current()) return;
    for (const session of this.liveSessions.values()) this.scheduleQueue(session.sessionId);
    this.report({ event: 'connected', nodeId: this.identity.nodeId, epoch: this.epoch, agents: this.profiles.map(p => ({ id: p.id, state: p.state })) });
  }
  async pump() {
    if (this.pumping || !this.ready) return;
    this.pumping = true; const socket = this.socket;
    try {
      while (this.ready && this.socket === socket) {
        const row = this.state.db.prepare('SELECT ord,value FROM spool WHERE ord>? ORDER BY ord LIMIT 1').get(this.sentOrdinal);
        if (!row) break;
        const message = JSON.parse(row.value); await this.send(message.type, message.data); this.sentOrdinal = row.ord;
      }
    } catch { socket?.terminate(); }
    finally { this.pumping = false; if (this.socket !== socket && this.ready) void this.pump(); }
  }
  source(session, type, body) {
    const result = this.state.append(session.sessionId, type, body, f => validate('NodeToGatewayFrame', f));
    void this.pump(); return result;
  }
  emitState(session) {
    this.state.saveSession(session);
    const { sessionId, turnId, state, capabilities, capabilityRevision } = session;
    this.source(session, 'node.session', { session: { sessionId, turnId, state, capabilities, capabilityRevision, queue: (session.queue ?? []).map(({ id, operationId, text, state, createdAt }) => ({ id, operationId, text, state, createdAt })) } });
  }
  receipt(entry, type = 'command.ack', operationId = entry?.command.operationId) {
    if (entry && type === 'command.ack' && entry.command.nodeEpoch !== this.epoch) type = 'command.status';
    const state = entry?.state === 'executing' ? 'unknown' : entry?.state ?? 'not_seen';
    void this.send(type, { operationId, state, result: state === 'confirmed' ? entry.result : null, error: state === 'rejected' ? entry.error : null }).catch(() => {});
  }
  async command(command) {
    if (command.nodeEpoch !== this.epoch) return;
    let received;
    try { received = this.state.receive(command); }
    catch (e) {
      if (e.code === 'IDEMPOTENCY_CONFLICT') { this.report({ event: 'protocol-conflict', code: e.code }); this.poison(); return; }
      throw e;
    }
    const entry = received.entry;
    this.receipt(entry);
    if (!received.fresh) return;
    const payload = command.payload; let session = command.sessionId ? this.liveSessions.get(command.sessionId) ?? this.state.session(command.sessionId) : null, startedNative = false, ownsFlight = false, importKey, originResolved = false; const originLocks = [];
    try {
      if (this.poisoned || this.closed) throw failure('SERVICE_UNAVAILABLE', 'Node 不再接收新任务');
      if (Date.parse(command.deadlineAt) <= this.serverNow()) throw failure('VALIDATION_FAILED', '操作已超过 Gateway 截止时间');
      if (['create', 'send', 'native'].includes(command.kind) && this.inFlight.has(command.sessionId)) throw failure('STALE_TURN', '此会话已有操作正在确认');
      // respond/cancel must remain possible while start is awaiting first native evidence.
      if (['create', 'send', 'native'].includes(command.kind)) { this.inFlight.add(command.sessionId); ownsFlight = true; }
      if (command.kind === 'history') {
        entry.nativeResult=await this.projectHistory(payload);
      } else if (command.kind === 'create') {
        if (session) throw failure('IDEMPOTENCY_CONFLICT', '会话已存在');
        if (payload.nodeId !== this.identity.nodeId) throw failure('FORBIDDEN', 'Node ID 不匹配');
        if (this.active.size >= this.config.maxSessions) throw failure('SERVICE_UNAVAILABLE', '活动会话已到本机上限');
        const project = this.projects.find(p => p.id === payload.projectId), profile = this.profiles.find(p => p.id === payload.agentId);
        if (!project || !profile) throw failure('NOT_FOUND', '项目或插件不在本机白名单中');
        if (payload.capabilityRevision !== profile.capabilityRevision) throw failure('CAPABILITY_CHANGED', 'Agent 能力已改变');
        if ((payload.historyOnly && payload.origin || payload.origin?.mode === 'import') && !profile.capabilities.historyImport) throw failure('CAPABILITY_UNSUPPORTED', 'Native history import is not advertised by this Agent');
        if (payload.historyOnly && (payload.prompt !== undefined || payload.origin && (!['codex','claude','pi'].includes(profile.type) || !['resume','fork','clone','import'].includes(payload.origin.mode)) || payload.preset)) throw failure('CAPABILITY_UNSUPPORTED', 'Unsupported prompt-free origin');
        if (realpathSync(project.path) !== project.path) throw failure('FORBIDDEN', '项目路径已改变，请重启并重新检查');
        let sourceWorkspace;
        if (payload.origin) {
          sourceWorkspace = this.workspaces.get(payload.origin.sessionId);
          if(!!sourceWorkspace?.projectHistory!==!!payload.origin.projectHistory)throw failure('FORBIDDEN','History context type mismatch');
          if (!sourceWorkspace || sourceWorkspace.session.projectId !== project.id || sourceWorkspace.session.agentId !== profile.id) throw failure('FORBIDDEN', 'History origin must be in the same authorized project and Agent');
          if (payload.origin.mode === 'import') {
            const history = sourceWorkspace.handles.get(payload.origin.resourceId, 'history');
            if (!history.external || history.sourceSessionId || payload.origin.sourceSessionId) throw failure('FORBIDDEN', 'Import requires a listed external history');
            const nativeId = history.sessionId ?? history.threadId;
            if (typeof nativeId !== 'string' || !nativeId || !Number.isFinite(history.lastModified ?? history.updatedAt)) throw failure('PROTOCOL_UNSUPPORTED', 'Native history has no stable identity or revision');
            const candidate = 'native-import:' + digest([profile.id, project.id, nativeId, history.lastModified ?? history.updatedAt]);
            if (this.state.get(candidate)) throw failure('IDEMPOTENCY_CONFLICT', 'This native history version already has an import; reconcile the original operation');
            importKey = candidate;
            this.state.set(importKey, {operationId:command.operationId, sessionId:command.sessionId});
          } else {
          const source = this.state.session(payload.origin.sourceSessionId);
          if (!source?.native?.nativeSessionId || source.agentId !== profile.id || source.projectId !== project.id) throw failure('FORBIDDEN', 'Unverified native source owner');
          const owners = this.state.sessions().filter(x => x.agentId === profile.id && x.projectId === project.id && x.native?.nativeSessionId === source.native.nativeSessionId);
          if (owners.some(x => this.inFlight.has(x.sessionId) || ['running','waiting_approval','waiting_input','cancelling'].includes(x.state))) throw failure('STALE_TURN','Native history is busy');
          for (const owner of owners) { this.inFlight.add(owner.sessionId); originLocks.push(owner.sessionId); }
          }
        }
        let agentPreset;
        if(payload.preset) {
          const source = this.workspaces.get(payload.preset.sessionId);
          if(!source || source.session.projectId !== project.id || source.session.agentId !== profile.id) throw failure('FORBIDDEN','Agent preset must belong to this project and adapter');
          agentPreset = await source.resolvePreset(payload.preset.resourceId);
        }
        const plugin = this.pluginFactory(profile, { cwd: project.path, sessionId: command.sessionId,
          workspacePolicy: profile.workspacePolicy ?? {}, agentPreset, nativeSessionOwner: nativeId => this.state.sessions().find(x => x.agentId === profile.id && x.projectId === project.id && x.native?.nativeSessionId === nativeId)?.sessionId, nativeSessionClosed: nativeId => { const owners = this.state.sessions().filter(x => x.agentId === profile.id && x.projectId === project.id && x.native?.nativeSessionId === nativeId); return owners.length > 0 && owners.every(x => x.state === 'closed'); }, nativeSessionIdle: nativeId => { const owners = this.state.sessions().filter(x => x.agentId === profile.id && x.projectId === project.id && x.native?.nativeSessionId === nativeId); return owners.length > 0 && owners.every(x => !['running','waiting_approval','waiting_input','cancelling'].includes(x.state)); } });
        if (!payload.historyOnly) plugin.validatePrompt(payload.prompt);
        session = { sessionId: command.sessionId, turnId: command.turnId, state: 'running', capabilities: profile.capabilities, capabilityRevision: profile.capabilityRevision, agentId: profile.id, projectId: project.id, requests: {}, queue: [], queuePolicy: 'automatic' };
        this.state.saveSession(session); this.active.set(session.sessionId, plugin); this.liveSessions.set(session.sessionId, session);
        const workspace = this.createWorkspace(session, project, plugin);
        plugin.on('event', event => { try { this.nativeEvent(session, event); } catch { this.poison(); } });
        // Journal intent is committed before touching the native API.
        entry.state = 'executing'; this.state.saveOperation(entry); startedNative = true;
        if (sourceWorkspace) { plugin.options.origin = await sourceWorkspace.origin(payload.origin.resourceId, payload.origin.mode, payload.origin.pointId, payload.origin.sourceSessionId, payload.origin.pointLabel); originResolved = true; }
        const native = await plugin.open(); session.native = native; this.emitState(session);
        if (payload.historyOnly) { session.state = 'completed'; session.historyOnly = true; this.emitState(session); }
        else { this.userMessage(session, payload.prompt); await plugin.start(payload.prompt, command.turnId); }
      } else if (command.kind === 'native' && payload.control.action === 'workspace' && payload.control.request.kind === 'resume') {
        if(this.active.size>=this.config.maxSessions) throw failure('SERVICE_UNAVAILABLE','Active session limit reached');
        if (!session || session.state !== 'closed' || !session.native?.nativeSessionId || this.active.has(session.sessionId)) throw failure('READ_ONLY','Only a closed native session can resume');
        if (payload.expectedTurnId !== session.turnId || command.nextTurnId) throw failure('STALE_TURN','Resume must preserve the original turn');
        if (payload.capabilityRevision !== session.capabilityRevision) throw failure('CAPABILITY_CHANGED','Session capabilities changed');
        const profile=this.profiles.find(p=>p.id===session.agentId),project=this.projects.find(p=>p.id===session.projectId);
        if(!profile?.capabilities.historyImport || !project || realpathSync(project.path)!==project.path) throw failure('CAPABILITY_UNSUPPORTED','Native resume is unavailable');
        const nativeId=session.native.nativeSessionId;
        if(this.state.sessions().some(s=>s.sessionId!==session.sessionId&&s.agentId===session.agentId&&s.native?.nativeSessionId===nativeId&&s.state!=='closed')) throw failure('READ_ONLY','Another managed session still owns this native process');
        let origin;
        if(profile.type==='codex') origin={threadId:nativeId,mode:'resume'};
        else if(profile.type==='claude') {
          const {getSessionInfo}=await import('@anthropic-ai/claude-agent-sdk');
          const info=await getSessionInfo(nativeId,{dir:project.path});
          if(!info?.cwd||realpathSync(info.cwd)!==project.path) throw failure('FORBIDDEN','Native history is not in the authorized project');
          origin={resume:nativeId};
        } else if(profile.type==='pi') {
          const reader=this.pluginFactory(profile,{cwd:project.path});
          origin=await reader.resumeOrigin(nativeId);
        } else throw failure('CAPABILITY_UNSUPPORTED','Native resume is unavailable');
        const plugin=this.pluginFactory(profile,{cwd:project.path,sessionId:session.sessionId,workspacePolicy:profile.workspacePolicy??{},origin,
          nativeSessionOwner:id=>this.state.sessions().find(s=>s.agentId===profile.id&&s.projectId===project.id&&s.native?.nativeSessionId===id)?.sessionId,
          nativeSessionIdle:id=>!this.state.sessions().some(s=>s.native?.nativeSessionId===id&&['running','waiting_approval','waiting_input','cancelling'].includes(s.state)),
          nativeSessionClosed:id=>this.state.sessions().filter(s=>s.native?.nativeSessionId===id).every(s=>s.state==='closed')});
        entry.state='executing';this.state.saveOperation(entry);startedNative=true;
        this.active.set(session.sessionId,plugin);this.liveSessions.set(session.sessionId,session);
        await this.workspaces.get(session.sessionId)?.dispose();
        this.createWorkspace(session,project,plugin);
        plugin.on('event',event=>{try{this.nativeEvent(session,event);}catch{this.poison();}});
        const native=await plugin.open();
        if(native.nativeSessionId!==nativeId) throw failure('PROTOCOL_UNSUPPORTED','Resume changed native identity',false);
        session.native=native;session.state='completed';this.emitState(session);
        entry.nativeResult={action:'workspace',requestKind:'resume',view:{title:'Session resumed',notice:'Original session and history retained. No prompt was sent.',entries:[],controls:[]}};
      } else {
        const closedRead = session?.state === 'closed' && command.kind === 'native' && payload.control.action === 'workspace' && workspaceOperations.get(payload.control.request.kind)?.closed;
        if(closedRead) {
          const project=this.projects.find(p=>p.id===session.projectId);
          if(!project)throw failure('FORBIDDEN','Project is no longer authorized');
          this.liveSessions.set(session.sessionId,session);
          if(!this.workspaces.has(session.sessionId)||this.workspaces.get(session.sessionId).uploads.closed)this.createWorkspace(session,project,null);
        }
        if (!session || !closedRead && (session.state === 'closed' || !this.active.has(session.sessionId))) throw failure('READ_ONLY', '此会话已关闭或原生进程不可恢复');
        if (payload.expectedTurnId !== session.turnId) throw failure('STALE_TURN', '当前轮次已改变');
        if (payload.capabilityRevision !== session.capabilityRevision) throw failure('CAPABILITY_CHANGED', '会话能力已改变');
        if (closedRead && ['history','history_messages'].includes(payload.control.request.kind)) {
          const workspace=this.workspaces.get(session.sessionId);
          if (!workspace.plugin) {
            const profile=this.profiles.find(p=>p.id===session.agentId);
            if (!profile || realpathSync(workspace.project.path)!==workspace.project.path) throw failure('FORBIDDEN','Project or Agent is no longer authorized');
            const reader=this.pluginFactory(profile,{cwd:workspace.project.path,sessionId:session.sessionId,workspacePolicy:profile.workspacePolicy??{},
              nativeSessionOwner:id=>this.state.sessions().find(s=>s.agentId===profile.id&&s.projectId===session.projectId&&s.native?.nativeSessionId===id)?.sessionId,
              nativeSessionIdle:id=>!this.state.sessions().some(s=>s.native?.nativeSessionId===id&&['running','waiting_approval','waiting_input','cancelling'].includes(s.state)),
              nativeSessionClosed:id=>this.state.sessions().filter(s=>s.native?.nativeSessionId===id).every(s=>s.state==='closed')});
            if (!reader.openHistory) throw failure('CAPABILITY_UNSUPPORTED','Adapter does not expose a read-only history connection');
            try { await reader.openHistory(); } catch(error) { await reader.close(); throw error; }
            workspace.plugin=reader; reader.workspace=workspace; workspace.ownsHistoryReader=true;
          }
        }
        const plugin = this.active.get(session.sessionId);
        if (command.kind === 'send') {
          const workspace = this.workspaces.get(session.sessionId);
          const structured = await workspace.input(payload.text, payload);
          if (payload.mode === 'queue') {
            if (!session.capabilities.queue) throw failure('CAPABILITY_UNSUPPORTED', 'Queue is not supported');
            if (!['running','waiting_approval','waiting_input'].includes(session.state)) throw failure('STALE_TURN', 'Queue requires an active turn');
            if ((session.queue ?? []).length >= 20) throw failure('PAYLOAD_TOO_LARGE', 'Queue limit reached');
            const queued = { id: id('queue'), operationId: command.operationId, text: payload.text, state: 'queued', createdAt: new Date(this.serverNow()).toISOString(), nextTurnId: command.nextTurnId,
              referenceVersions: structured.references.map(x => x.version) };
            workspace.uploads.pin(payload.attachments ?? []);
            session.queue.push(queued); entry.queueItemId = queued.id;
            this.state.transaction(() => { this.state.saveSession(session); this.confirm(entry, false); });
            this.receipt(entry); this.emitState(session); return;
          }
          if (!['completed', 'cancelled', 'failed'].includes(session.state)) throw failure('STALE_TURN', 'Current turn has not ended');
          entry.state = 'executing'; this.state.saveOperation(entry); startedNative = true;
          session.turnId = command.nextTurnId; session.state = 'running'; session.requests = {}; this.emitState(session);
          this.userMessage(session, payload.text); await plugin.start(payload.text, command.nextTurnId, structured);
          workspace.uploads.accept(payload.attachments ?? []);
        } else if (command.kind === 'native') {
          const workspace = this.workspaces.get(session.sessionId), extended = payload.control.action === 'workspace';
          const operation = extended ? workspace.check(payload.control.request) : null;
          if (!extended) plugin.validateControl(payload.control);
          const newTurn = extended ? operation.newTurn : payload.control.action === 'compact';
          if (newTurn !== !!command.nextTurnId || newTurn && command.nextTurnId === session.turnId) throw failure('VALIDATION_FAILED', 'Native turn reservation mismatch');
          if (!session.capabilities[extended ? 'workspace' : newTurn ? 'compact' : 'models']) throw failure('CAPABILITY_UNSUPPORTED', 'Native capability is not enabled');
          entry.state = 'executing'; this.state.saveOperation(entry); startedNative = true;
          // Registry preflight must run before advancing the turn state.
          if (newTurn) { session.turnId = command.nextTurnId; session.state = 'running'; this.emitState(session); }
          entry.nativeResult = extended ? await workspace.execute(payload.control.request, session.turnId, { prechecked: newTurn }) : await plugin.control(payload.control, session.turnId);
        } else if (command.kind === 'cancel') {
          if (!['running', 'waiting_approval', 'waiting_input', 'cancelling'].includes(session.state)) throw failure('STALE_TURN', '当前轮次已经结束');
          entry.state = 'executing'; this.state.saveOperation(entry); startedNative = true;
          session.state = 'cancelling'; this.emitState(session); await plugin.cancel();
        } else if (command.kind === 'respond') {
          const request = session.requests[command.requestId];
          if (!request || Date.parse(request.expiresAt) <= this.serverNow()) throw failure('REQUEST_EXPIRED', '交互请求已失效');
          // Gateway owns revisions (including increments after a rejected answer).
          // The adapter owns native pending/consumed state; it must not assume revision=1 forever.
          if (request.lastRevision && payload.requestRevision <= request.lastRevision) throw failure('REQUEST_ALREADY_DECIDED', '请求修订已被处理');
          request.lastRevision = payload.requestRevision; request.operationId = command.operationId; this.state.saveSession(session);
          entry.state = 'executing'; this.state.saveOperation(entry); startedNative = true;
          await plugin.respond(command.requestId, payload.decision);
        }
      }
      this.confirm(entry);
    } catch (error) {
      if (importKey && !originResolved && (error.definite || !startedNative)) this.state.set(importKey, null);
      entry.state = startedNative && !error.definite && !readOnlyCommand(command) ? 'unknown' : 'rejected';
      const publicFailure = typeof error.definite === 'boolean';
      entry.error = entry.state === 'rejected' ? { code: publicFailure ? error.code : 'SERVICE_UNAVAILABLE', message: publicFailure ? error.message : '本机 Agent 操作失败', retryable: false, requestId: id('trace') } : null;
      this.state.saveOperation(entry); this.receipt(entry);
      if (command.kind === 'create' && !session) {
        const profile = this.profiles.find(p => p.id === payload.agentId);
        // Even a preflight rejection refers to a Gateway-reserved session. Retain a
        // closed tombstone so reconnect can never require a nonexistent native process.
        session = { sessionId: command.sessionId, turnId: command.turnId, state: 'closed', requests: {},
          capabilities: profile?.capabilities ?? capabilities({ send: false, cancel: false, approval: false, question: false, usage: false }),
          capabilityRevision: Math.max(profile?.capabilityRevision ?? 0, payload.capabilityRevision + 1) };
        this.emitState(session);
      }
      if (startedNative && (command.kind === 'create' || command.kind === 'send' || command.kind === 'native' && (payload.control.action === 'compact' || (payload.control.action === 'set_model' || payload.control.action === 'workspace' && workspaceOperations.get(payload.control.request.kind)?.write) && entry.state === 'unknown' || payload.control.action === 'workspace' && !!command.nextTurnId))) {
        await this.active.get(command.sessionId)?.close(); this.active.delete(command.sessionId);
        if (session) { session.state = 'closed'; session.requests = {}; this.emitState(session); }
      }
    } finally { for (const sourceId of originLocks) this.inFlight.delete(sourceId); if (ownsFlight) this.inFlight.delete(command.sessionId); this.scheduleQueue(command.sessionId); }
  }
  confirm(entry, sendReceipt = true) {
    const command = entry.command;
    entry.state = 'confirmed'; entry.error = null;
    entry.result = { sessionId: command.sessionId ?? null, turnId: (command.payload.mode === 'queue' ? command.payload.expectedTurnId : command.nextTurnId ?? (command.kind === 'create' ? command.turnId : command.payload.expectedTurnId)) ?? null, requestId: command.requestId ?? null, nodeId: this.identity.nodeId, queueItemId: entry.queueItemId ?? null, ...(entry.nativeResult ? { native: entry.nativeResult } : {}) };
    this.state.saveOperation(entry); if (sendReceipt) this.receipt(entry);
  }
  userMessage(session, text) { this.source(session, 'node.events', { sessionId: session.sessionId, turnId: session.turnId, type: 'message.completed', data: { itemId: id('msg'), role: 'user', text, truncated: false } }); }
  nativeEvent(session, event) {
    if (this.poisoned || this.closed || session.state === 'closed') return;
    if (event.kind === 'event') this.source(session, 'node.events', { sessionId: session.sessionId, turnId: session.turnId, type: event.type, data: event.data });
    if (event.kind === 'state') { session.state = event.state; this.emitState(session); if (event.state === 'closed') this.active.delete(session.sessionId); if (event.state === 'completed') this.scheduleQueue(session.sessionId); }
    if (event.kind === 'request') {
      // Translate local expiry to the Gateway clock without extending its duration.
      const expiresAt = new Date(Date.parse(event.expiresAt) + this.offset).toISOString();
      session.requests[event.requestId] = { expiresAt };
      this.source(session, 'node.request', { request: { ...event.definition, id: event.requestId, sessionId: session.sessionId, turnId: session.turnId, createdAt: new Date(this.serverNow()).toISOString(), expiresAt } });
      const next = event.definition.kind === 'approval' ? 'waiting_approval' : 'waiting_input';
      if (session.state.startsWith('waiting_') && session.state !== next) { session.state = 'running'; this.emitState(session); }
      if (session.state !== 'cancelling') { session.state = next; this.emitState(session); }
    }
    if (event.kind === 'request-cancelled' || event.kind === 'request-consumed') {
      const request = session.requests[event.requestId];
      if (event.kind === 'request-consumed' && request?.operationId) {
        const entry = this.state.operation(request.operationId);
        // Late native evidence can settle a timed-out respond without replaying it.
        if (entry && ['executing', 'unknown'].includes(entry.state)) this.confirm(entry);
      }
      delete session.requests[event.requestId];
      if (event.kind === 'request-cancelled') this.source(session, 'node.request.cancel', { sessionId: session.sessionId, turnId: session.turnId, requestId: event.requestId, reason: event.reason });
      if (!Object.keys(session.requests).length && session.state.startsWith('waiting_')) session.state = 'running';
      this.emitState(session);
    }
  }
  async projectHistory(payload) {
    validate('ProjectHistory',payload);
    if(payload.nodeId!==this.identity.nodeId)throw failure('FORBIDDEN','Node mismatch');
    const project=this.projects.find(p=>p.id===payload.projectId),profile=this.profiles.find(p=>p.id===payload.agentId);
    if(!project||!profile||realpathSync(project.path)!==project.path)throw failure('FORBIDDEN','Project or Agent no longer authorized');
    if(profile.capabilityRevision!==payload.capabilityRevision)throw failure('CAPABILITY_CHANGED','Agent changed');
    if(!profile.capabilities.historyImport)throw failure('CAPABILITY_UNSUPPORTED','Project history is unavailable');
    const key='history_'+digest([project.id,profile.id]).slice(0,32);
    if(this.inFlight.has(key))throw failure('STALE_TURN','History read already in progress');
    this.inFlight.add(key);
    try {
      for(const [id,w] of this.workspaces)if(w.projectHistory&&id!==key&&!this.inFlight.has(id)&&Date.now()-w.lastUsed>15*60*1000){await w.dispose();this.workspaces.delete(id);}
      let w=this.workspaces.get(key);
      if(w&&w.session.capabilityRevision!==profile.capabilityRevision){await w.dispose();this.workspaces.delete(key);w=null;}
      if(!w) {
        if([...this.workspaces.values()].filter(w=>w.projectHistory).length>=16)throw failure('SERVICE_UNAVAILABLE','History browser limit reached');
        const reader=this.pluginFactory(profile,{cwd:project.path,sessionId:key,workspacePolicy:profile.workspacePolicy??{},
          nativeSessionOwner:id=>this.state.sessions().find(s=>s.agentId===profile.id&&s.projectId===project.id&&s.native?.nativeSessionId===id)?.sessionId,
          nativeSessionIdle:id=>!this.state.sessions().some(s=>s.native?.nativeSessionId===id&&['running','waiting_approval','waiting_input','cancelling'].includes(s.state)),
          nativeSessionClosed:id=>this.state.sessions().filter(s=>s.native?.nativeSessionId===id).every(s=>s.state==='closed')});
        if(!reader.openHistory)throw failure('CAPABILITY_UNSUPPORTED','Read-only history unavailable');
        try{await reader.openHistory();}catch(e){await reader.close();throw e;}
        w=this.createWorkspace({sessionId:key,projectId:project.id,agentId:profile.id,state:'closed',capabilityRevision:profile.capabilityRevision},project,reader);
        w.projectHistory=true;w.ownsHistoryReader=true;
      }
      w.lastUsed=Date.now();
      const result=await w.execute(payload.request,null);
      for(const item of result.view.entries)if(item.origin)item.origin.projectHistory=true;
      return result;
    } finally {this.inFlight.delete(key);}
  }
  createWorkspace(session, project, plugin) {
    const workspace = new Workspace({ session, project, projects: this.projects, plugin, stateDir: this.config.stateDir,
      save: () => this.state.saveSession(session), close: () => this.closeSession(session.sessionId), schedule: () => this.scheduleQueue(session.sessionId) });
    this.workspaces.set(session.sessionId, workspace); return workspace;
  }
  async closeSession(sessionId) {
    const session = this.liveSessions.get(sessionId); if (!session) throw failure('NOT_FOUND', 'Managed session not found');
    session.queuePolicy = 'manual';
    await this.active.get(sessionId)?.close(); this.active.delete(sessionId);
    session.state = 'closed'; session.requests = {}; this.emitState(session);
    await this.workspaces.get(sessionId)?.dispose();
  }
  scheduleQueue(sessionId) {
    if (this.closed || this.poisoned || !this.ready || this.dispatching.has(sessionId)) return;
    const task = Promise.resolve().then(() => this.dispatchQueue(sessionId)).catch(() => this.poison());
    this.tasks.add(task); void task.finally(() => this.tasks.delete(task));
  }
  async dispatchQueue(sessionId) {
    const session = this.liveSessions.get(sessionId), plugin = this.active.get(sessionId), workspace = this.workspaces.get(sessionId);
    if (!session || !plugin || !workspace || this.inFlight.has(sessionId) || this.dispatching.has(sessionId) || session.state !== 'completed' || session.queuePolicy !== 'automatic' || !session.queue?.length) return;
    this.dispatching.add(sessionId); this.inFlight.add(sessionId);
    const queued = session.queue[0], accepted = this.state.operation(queued.operationId); let invoked = false;
    try {
      if (!accepted || accepted.state !== 'confirmed' || accepted.dispatchState) throw failure('READ_ONLY', 'Queue acceptance or previous dispatch is not safely known');
      const payload = accepted.command.payload, structured = await workspace.input(payload.text, payload);
      if (JSON.stringify(queued.referenceVersions) !== JSON.stringify(structured.references.map(x => x.version))) throw failure('SOURCE_CONFLICT', 'A queued file reference changed; dispatch paused');
      // Persist the irreversible start fence before native I/O. Restart never dispatches it again.
      accepted.dispatchState = 'starting'; this.state.saveOperation(accepted);
      session.queue.shift(); session.turnId = queued.nextTurnId; session.state = 'running'; session.requests = {};
      this.emitState(session); this.userMessage(session, queued.text); invoked = true;
      await plugin.start(payload.text, queued.nextTurnId, structured);
      workspace.uploads.accept(payload.attachments ?? []); workspace.uploads.unpin(payload.attachments ?? []);
      accepted.dispatchState = 'accepted'; this.state.saveOperation(accepted);
    } catch (error) {
      session.queuePolicy = 'manual';
      workspace.diagnostic('Input queue', error.definite ? error.message : 'Native dispatch could not be confirmed; never automatically replay this input');
      if (invoked) { accepted.dispatchState = 'unknown'; this.state.saveOperation(accepted); await this.closeSession(sessionId); }
      else this.emitState(session);
    } finally { this.inFlight.delete(sessionId); this.dispatching.delete(sessionId); }
    this.scheduleQueue(sessionId);
  }
  poison() {
    if (this.poisoned) return;
    this.poisoned = true; this.report({ event: 'halted', code: 'SERVICE_UNAVAILABLE', message: '请检查本机状态；未丢弃 spool 或重新执行命令' });
    for (const plugin of this.active.values()) void plugin.close();
    this.socket?.terminate();
  }
  close() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true; this.abort.abort(); this.socket?.terminate();
    this.shutdownPromise = (async () => {
      await Promise.all([...this.active.values()].map(p => p.close().catch(() => {})));
      await Promise.allSettled([...this.tasks]);
      this.active.clear();
      await Promise.allSettled([...this.workspaces.values()].map(w => w.dispose()));
      this.workspaces.clear();
      // Every caller awaits the same drain before cli closes SQLite.
    })();
    return this.shutdownPromise;
  }
}
