import { realpath } from 'node:fs/promises';
import { cut, failure } from '../common.mjs';
import { inputParts, withTextFiles } from './input.mjs';
import { entry, control, field, view } from './view.mjs';

export const codexSections = [['account','Authentication'],['history','Native history'],['thinking','Model reasoning'],['permissions','Sandbox policy'],['skills','Skills'],['mcp','MCP tools and resources'],['extensions','Plugins'],['goal','Native goal'],['review_targets','Native code review'],['tasks','Native tasks and processes'],['retry','Compaction status']];
const writePolicy = p => { if (!p.options.workspacePolicy?.allowNativeSettingsWrite) throw failure('FORBIDDEN', 'The host has not enabled native settings/account/plugin writes'); };
const sameProject = async (p, path) => { try { return await realpath(path) === await realpath(p.options.cwd); } catch { return false; } };
const thread = async (p, resource, turns = false) => {
  const r = await p.rpc.call('thread/read', { threadId: resource.threadId, includeTurns: turns });
  if (!r?.thread || !await sameProject(p, r.thread.cwd)) throw failure('FORBIDDEN', 'Native thread is not in this authorized project');
  return r.thread;
};
const checkHistory = async (p, h, mutate = false) => {
  const t = await thread(p, h);
  if (t.updatedAt !== h.updatedAt) throw failure('SOURCE_CONFLICT', 'Native history changed; refresh before acting');
  if (mutate && (!p.options.nativeSessionIdle?.(t.id) || t.id === p.threadId || t.status?.type === 'active')) throw failure('READ_ONLY', 'Native history mutation/resume requires a known, inactive, owned session');
  return t;
};
async function skills(p, reload = false) {
  const r = await p.rpc.call('skills/list', { cwds: [p.options.cwd], forceReload: reload });
  if (!Array.isArray(r?.data)) throw failure('PROTOCOL_UNSUPPORTED', 'Codex skills response is not supported');
  const rows = [];
  for (const group of r.data) if (await sameProject(p, group.cwd)) {
    if (!Array.isArray(group.skills)) throw failure('PROTOCOL_UNSUPPORTED', 'Codex skills response is not supported');
    rows.push(...group.skills);
    for (const e of group.errors ?? []) p.workspace?.diagnostic('Skill loading', cut(e.message, 1500));
  }
  return rows.slice(0,100);
}
async function models(p) {
  const r = await p.rpc.call('model/list', { limit: 100, includeHidden: false });
  if (!Array.isArray(r?.data)) throw failure('PROTOCOL_UNSUPPORTED', 'Codex model response is not supported');
  return r.data;
}
async function mcp(p) {
  const r = await p.rpc.call('mcpServerStatus/list', { limit: 100 });
  if (!Array.isArray(r?.data)) throw failure('PROTOCOL_UNSUPPORTED', 'Codex MCP response is not supported');
  return r;
}
async function plugins(p, reload = false) {
  const r = await p.rpc.call('plugin/list', { cwds: [p.options.cwd], forceRefetch: reload });
  if (!Array.isArray(r?.marketplaces)) throw failure('PROTOCOL_UNSUPPORTED', 'Codex plugin directory is not supported');
  return r;
}
function authControls(p, w) {
  const controls = [];
  if (p.options.workspacePolicy?.allowNativeSettingsWrite) controls.push(control('Start host ChatGPT login', { kind: 'start_auth' }, { confirm: true, notice: 'Changes the host Codex account. The browser will request the account owner\'s consent; 喵连 does not collect a password or API key.' }));
  if (w.native.login) controls.push(control('Cancel pending login', { kind: 'cancel_auth', resourceId: w.native.login.resourceId }, { confirm: true }));
  return controls;
}
export async function codexWorkspace(r, w, turnId) {
  const p = this;
  switch (r.kind) {
    case 'account': {
      const a = await p.rpc.call('account/read', { refreshToken: false });
      const account = a.account;
      return view('Codex authentication', 'Only authentication type and plan are projected. No email, account ID, API key or token is sent to the phone. A configured account is not proof of a successful model call.', [entry('Authentication', account?.type ?? 'not authenticated'), entry('Plan', account?.planType ?? 'not reported'), entry('Login flow', w.native.authState ?? 'not started')], authControls(p,w));
    }
    case 'start_auth': {
      writePolicy(p);
      if (w.native.login) throw failure('SOURCE_CONFLICT', 'Cancel or finish the existing login before starting another');
      const result = await p.rpc.call('account/login/start', { type: 'chatgptDeviceCode' });
      if (result?.type !== 'chatgptDeviceCode' || typeof result.loginId !== 'string' || typeof result.userCode !== 'string') throw failure('OPERATION_UNKNOWN', 'Native device login was not confirmed', false);
      const resourceId = w.handles.put('codex-login', { loginId: result.loginId });
      w.native.login = { resourceId, loginId: result.loginId }; w.native.authState = 'pending';
      return view('Device authorization', 'This one-time code authorizes the HOST Codex account. Verify the account in the browser. This screen is not proof of completion.', [entry('One-time code', result.userCode)], [w.external('Account authorization', result.verificationUrl), ...authControls(p,w).filter(c=>c.request.kind==='cancel_auth')]);
    }
    case 'cancel_auth': {
      const h = w.handles.get(r.resourceId, 'codex-login');
      if (w.native.login?.loginId !== h.loginId) throw failure('SOURCE_CONFLICT', 'This login is no longer pending');
      await p.rpc.call('account/login/cancel', { loginId: h.loginId });
      w.handles.remove(r.resourceId); delete w.native.login; w.native.authState = 'cancel requested';
      return view('Login cancellation accepted', 'No account logout was performed. Native completion notifications and a refreshed account read determine the final state.');
    }
    case 'history': {
      const items=[]; let truncated=false;
      for (const archived of [false,true]) {
        const result=await p.rpc.call('thread/list',{cwd:p.options.cwd,limit:50,archived});
        if (!Array.isArray(result?.data)) throw failure('PROTOCOL_UNSUPPORTED','Codex history response is not supported');
        truncated ||= !!result.nextCursor;
        for (const t of result.data) if (await sameProject(p,t.cwd)) {
          const h={threadId:t.id,updatedAt:t.updatedAt,archived,sourceSessionId:p.options.nativeSessionOwner?.(t.id)};
          // The list index can lag behind the persisted rollout. Establish an
          // authoritative read-version before issuing a managed history handle.
          // checkHistory still rejects changes after this selection snapshot.
          if(h.sourceSessionId && p.options.nativeSessionIdle?.(t.id) && t.id!==p.threadId && t.status?.type!=='active') {
            const actual=await thread(p,h);
            if(actual.id!==t.id || actual.status?.type==='active') continue;
            h.updatedAt=actual.updatedAt;
          }
          h.external=!h.sourceSessionId && t.id!==p.threadId && t.status?.type!=='active';
          const resourceId=w.handles.put('history',h);
          const owned=h.sourceSessionId && p.options.nativeSessionIdle?.(t.id) && t.id!==p.threadId && t.status?.type!=='active';
          items.push(entry(t.name || t.preview || t.id, `${t.cliVersion}; ${archived?'archived':'current'}; ${t.status?.type ?? 'not reported'}`, {id:resourceId,request:{kind:'history_messages',resourceId}, ...(owned?{origin:{sessionId:w.session.sessionId,sourceSessionId:h.sourceSessionId,resourceId,mode:'resume'},controls:[control(archived?'Unarchive native history':'Archive native history',{kind:'native_archive',resourceId,enabled:!archived},{confirm:true,notice:'Native history on this host; platform organization is separate.'})]}:h.external?{origin:{sessionId:w.session.sessionId,resourceId,mode:'import'},state:'history'}:{state:'readonly'})}));
        }
      }
      return view('Native Codex history','Only this exact project is listed. External history imports create independent native copies. Stop the original terminal task before continuing. Fork/clone create a separate owned thread; resume never attaches to an active external process.',items,[control('Rename current native thread',{kind:'native_rename',name:'Thread'},{fields:[field('name','Native name',{maxLength:200})],confirm:true})],{truncated});
    }
    case 'history_messages': {
      const h=w.handles.get(r.resourceId,'history'); const t=await thread(p,h,true), items=[];
      for(const turn of t.turns ?? []) {
        if(turn.status==='inProgress') continue;
        const pointId=w.handles.put('history-point',{threadId:t.id,turnId:turn.id,nativePoint:turn.id});
        const lines=[];
        for(const item of turn.items ?? []) {
          if(item.type==='userMessage') lines.push('User: '+item.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'));
          if(item.type==='agentMessage') lines.push('Assistant: '+item.text);
        }
        items.push(entry(turn.id,lines.join('\n'),{...(h.sourceSessionId&&p.options.nativeSessionIdle?.(t.id)&&t.id!==p.threadId?{origin:{sessionId:w.session.sessionId,sourceSessionId:h.sourceSessionId,resourceId:r.resourceId,mode:'fork',pointId,pointLabel:turn.id}}:{})}));
      }
      return view('Native transcript','Native turn boundaries, not platform message cursors. Only completed turns can be selected as fork points.',items.slice(r.offset ?? 0,(r.offset ?? 0)+40),items.length>(r.offset??0)+40?[control('More turns',{kind:'history_messages',resourceId:r.resourceId,offset:(r.offset??0)+40})]:[]);
    }
    case 'native_rename':
      await p.rpc.call('thread/name/set',{threadId:p.threadId,name:r.name});
      return view('Native thread renamed','Platform title and tags are independent metadata.');
    case 'native_archive': {
      const h=w.handles.get(r.resourceId,'history'); await checkHistory(p,h,true);
      await p.rpc.call(r.enabled?'thread/archive':'thread/unarchive',{threadId:h.threadId}); w.handles.remove(r.resourceId);
      return view('Native archive updated','Refresh history to obtain current resource IDs. No project files were deleted.');
    }
    case 'config': case 'permissions':
      return view('Codex next-turn sandbox','These are staged per-turn overrides, not settings-file edits or proof that a turn has already used the policy. Network access is disabled for the workspace-write override; permission escalation still asks explicitly.',[entry('Sandbox',p.nextSandbox??'workspace-write'),entry('Approval','untrusted')],[control('Next-turn sandbox',{kind:'set_permission',value:p.nextSandbox??'workspace-write'},{fields:[field('value','Sandbox',{options:['read-only','workspace-write']})],confirm:true})]);
    case 'set_permission':
      if(!['read-only','workspace-write'].includes(r.value)) throw failure('FORBIDDEN','Only read-only or workspace-write sandbox overrides are exposed');
      p.nextSandbox=r.value; return view('Sandbox override staged',`${r.value}. It will be sent with the next native turn, subject to host policy.`);
    case 'thinking': {
      const m=(await models(p)).find(x=>x.model===(p.nextModel??p.selectedModel));
      if(!m || !Array.isArray(m.supportedReasoningEfforts)) return view('Reasoning effort','Select a model and refresh. No model effort levels have been invented.');
      const current=p.nextEffort??m.defaultReasoningEffort??null;
      return view('Reasoning effort','Values are from the native model directory. Selection is staged for the next turn.',m.supportedReasoningEfforts.map(x=>entry(x.reasoningEffort,x.description,{...(x.reasoningEffort===current?{state:'current'}:{}),controls:[control('Select effort',{kind:'set_thinking',value:x.reasoningEffort})]})));
    }
    case 'set_thinking': {
      const m=(await models(p)).find(x=>x.model===(p.nextModel??p.selectedModel));
      if(!m?.supportedReasoningEfforts?.some(x=>x.reasoningEffort===r.value)) throw failure('CAPABILITY_UNSUPPORTED','Current model did not advertise this effort');
      p.nextEffort=r.value; return view('Reasoning override staged',`${r.value}; next turn only, not a host settings-file change.`);
    }
    case 'skills': case 'commands': case 'reload_skills': {
      const list=await skills(p,r.kind==='reload_skills');
      return view('Codex skills','Selection sends a native skill input, not an invented slash command. Host-authorized enable/disable writes native skill configuration.',list.map(s=>{
        const resourceId=w.handles.put('codex-skill',{name:s.name,path:s.path});
        const controls=p.options.workspacePolicy?.allowNativeSettingsWrite?[control(s.enabled?'Disable skill':'Enable skill',{kind:'set_skill',resourceId,enabled:!s.enabled},{confirm:true,notice:'Persistent native skill configuration; affects other sessions using that configuration.'})]:[];
        const key=s.enabled?w.handles.put('command',{name:s.name,path:s.path,source:'codex-skill'}):null;
        return entry(s.name,s.description,{id:resourceId,state:s.enabled?'skill':'disabled',...(key?{referenceId:key}:{}),controls});
      }),[control('Reload skill directory',{kind:'reload_skills'},{confirm:true})]);
    }
    case 'set_skill': {
      writePolicy(p); const h=w.handles.get(r.resourceId,'codex-skill');
      if(!(await skills(p)).some(s=>s.name===h.name&&s.path===h.path)) throw failure('SOURCE_CONFLICT','Skill is no longer in the native catalog');
      await p.rpc.call('skills/config/write',{path:h.path,enabled:r.enabled});
      return view('Skill configuration accepted','Persistent native configuration was changed. Refresh the skill directory before invoking it.');
    }
    case 'mcp': {
      const result=await mcp(p);
      return view('MCP servers','Tools and resource names are metadata, not permission to invoke or read arbitrary MCP content.',result.data.map(s=>{
        const auth=w.native.mcpAuth?.[s.name];if(auth?.state==='pending'&&Date.now()>=auth.expiresAt)auth.state='expired';
        const resourceId=w.handles.put('codex-mcp',{name:s.name});
        return entry(s.name,`Authentication: ${s.authStatus}; ${Object.keys(s.tools??{}).length} tools${auth?'\nOAuth: '+auth.state:''}`,{request:{kind:'mcp_tools',resourceId},controls:p.options.workspacePolicy?.allowNativeSettingsWrite&&auth?.state!=='pending'?[control('Begin MCP authorization',{kind:'authorize_mcp',resourceId},{confirm:true,notice:'Starts the native server-specific OAuth flow. Verify its domain before opening.'})]:[]});
      }),[],{truncated:!!result.nextCursor});
    }
    case 'mcp_tools': {
      const h=w.handles.get(r.resourceId,'codex-mcp'), s=(await mcp(p)).data.find(x=>x.name===h.name);
      if(!s) throw failure('NOT_FOUND','MCP server is no longer in the current directory');
      return view(s.name,'Native tool and resource metadata. No tool has been invoked.',[...Object.entries(s.tools??{}).map(([name,t])=>entry(name,t.description??'')),...(s.resources??[]).map(x=>entry(x.name,x.description??'')),...(s.resourceTemplates??[]).map(x=>entry(x.name,x.description??''))]);
    }
    case 'authorize_mcp': {
      // This control explicitly starts OAuth, never silently reconnects using guessed credentials.
      writePolicy(p); const h=w.handles.get(r.resourceId,'codex-mcp');
      w.native.mcpAuth??={};const prior=w.native.mcpAuth[h.name];
      if(prior?.state==='pending'&&Date.now()<prior.expiresAt)throw failure('STALE_TURN','An OAuth attempt is already pending');
      if(!(await mcp(p)).data.some(x=>x.name===h.name)) throw failure('NOT_FOUND','MCP server disappeared');
      const result=await p.rpc.call('mcpServer/oauth/login',{name:h.name,threadId:p.threadId,timeoutSecs:120});
      w.native.mcpAuth[h.name]={state:'pending',expiresAt:Date.now()+120000};
      return view('MCP authorization requested','请在浏览器完成授权。链接最多保留 2 分钟；刷新 MCP，以原生认证状态为准。',[],[w.external('MCP authorization',result.authorizationUrl,120000),control('刷新授权状态',{kind:'mcp'})]);
    }
    case 'extensions': case 'reload_extensions': {
      const result=await plugins(p,r.kind==='reload_extensions'), rows=[entry('Skills','技能目录与启用状态',{request:{kind:'skills'}}),entry('MCP','服务、工具与认证状态',{request:{kind:'mcp'}})];
      const offset=r.offset??0,query=(r.query??'').trim().toLowerCase();
      const catalog=result.marketplaces.flatMap(market=>(market.plugins??[]).map(plugin=>({market,plugin}))).filter(({plugin})=>!query||String(plugin.name).toLowerCase().includes(query));
      for(const key of w.native.pluginHandles??[])w.handles.remove(key);w.native.pluginHandles=[];
      for(const {market,plugin} of catalog.slice(offset,offset+50)) {
        const resourceId=p.options.workspacePolicy?.allowNativeSettingsWrite?w.handles.put('codex-plugin',{id:plugin.id,name:plugin.name,marketplacePath:market.path,installed:plugin.installed}):null;
        if(resourceId)w.native.pluginHandles.push(resourceId);
        const controls=p.options.workspacePolicy?.allowNativeSettingsWrite && !plugin.mustShowInstallationInterstitial && typeof market.path==='string'?[control(plugin.installed?'Uninstall plugin':'Install plugin',{kind:plugin.installed?'uninstall_plugin':'install_plugin',resourceId},{confirm:true,notice:`Native plugin ${plugin.name} from ${market.name}; may execute code and add tools. Persistent host change.`})]:[];
        rows.push(entry(plugin.name,`Marketplace: ${market.name}; installed: ${plugin.installed}; enabled: ${plugin.enabled}; version: ${plugin.localVersion??plugin.version??'not reported'}`,{controls:plugin.mustShowInstallationInterstitial?[]:controls}));
      }
      for(const e of result.marketplaceLoadErrors??[]) w.diagnostic('Plugin marketplace',cut(e.message,1500));
      return view('Native plugin directory',`共 ${catalog.length} 个插件，当前从 ${Math.min(offset+1,catalog.length)} 显示。安装与卸载需主机允许；需要原生确认页的插件请在主机安装。`,rows,[control('搜索插件',{kind:'extensions',query:r.query??''},{fields:[field('query','插件名称',{maxLength:200})]}),...(offset>0?[control('上一页',{kind:'extensions',offset:Math.max(0,offset-50),query:r.query??''})]:[]),...(offset+50<catalog.length?[control('下一页',{kind:'extensions',offset:offset+50,query:r.query??''})]:[]),control('Refresh native catalog',{kind:'reload_extensions'},{confirm:true})]);
    }
    case 'install_plugin': case 'uninstall_plugin': {
      writePolicy(p); const h=w.handles.get(r.resourceId,'codex-plugin'), result=await plugins(p);
      const market=result.marketplaces.find(x=>x.path===h.marketplacePath), current=market?.plugins?.find(x=>x.id===h.id&&x.name===h.name);
      if(!current || current.installed!==h.installed || current.mustShowInstallationInterstitial) throw failure('SOURCE_CONFLICT','Plugin state changed or installation requires a host interstitial');
      if(r.kind==='install_plugin') await p.rpc.call('plugin/install',{marketplacePath:h.marketplacePath,pluginName:h.name});
      else await p.rpc.call('plugin/uninstall',{pluginId:h.id});
      w.handles.remove(r.resourceId); return view('Native plugin change accepted','Refresh the plugin directory for the actual installed/enabled state. MCP authentication may still be required.');
    }
    case 'goal': {
      const result=await p.rpc.call('thread/goal/get',{threadId:p.threadId}); const g=result.goal;
      return view('Native goal','New goals are created paused, so saving an objective does not silently start autonomous work or incur model usage. Progress comes from native goal state.',g?[entry(g.objective,`State: ${g.status}; tokens: ${g.tokensUsed}; budget: ${g.tokenBudget??'not set'}; time: ${g.timeUsedSeconds}s`)]:[],[control('Save paused objective',{kind:'set_goal',text:g?.objective??'New objective'},{fields:[field('text','Objective')],confirm:true}),...(g?[control('Clear native goal',{kind:'clear_goal'},{confirm:true})]:[])]);
    }
    case 'set_goal':
      await p.rpc.call('thread/goal/set',{threadId:p.threadId,objective:r.text,status:'paused'}); return p.workspaceControl({kind:'goal'},w,turnId);
    case 'clear_goal':
      await p.rpc.call('thread/goal/clear',{threadId:p.threadId}); return view('Native goal cleared','No project file or task history was removed.');
    case 'review_targets': {
      const resourceId=w.handles.put('codex-review',{type:'uncommittedChanges'});
      return view('Native code review','Uses Codex review/start, not a prompt pretending to be a review mode. It creates a new tracked native turn and may incur model usage.',[entry('Uncommitted changes','Review the actual working tree diff',{controls:[control('Start native review',{kind:'review',resourceId},{confirm:true})]})]);
    }
    case 'review': {
      const target=w.handles.get(r.resourceId,'codex-review');
      p.begin(turnId); p.starting=true; p.startBuffer=[]; p.startBytes=0;
      try {
        const result=await p.rpc.call('review/start',{threadId:p.threadId,target,delivery:'inline'});
        if(!result?.turn?.id) throw failure('OPERATION_UNKNOWN','Codex did not confirm the review turn',false);
        p.nativeTurnId=result.turn.id; p.starting=false;
        for(const message of p.startBuffer) p.onMessage(message);
        return view('Native review started','Results will arrive in the current session timeline.');
      } finally {p.starting=false;p.startBuffer=[];}
    }
    case 'steer':
      if(!p.busy||!p.nativeTurnId) throw failure('STALE_TURN','No active native turn to steer');
      p.validatePrompt(r.text); await p.rpc.call('turn/steer',{threadId:p.threadId,expectedTurnId:p.nativeTurnId,input:[{type:'text',text:r.text,text_elements:[]}]});
      return view('Steering input accepted','Appended to the specific native turn. This is not a platform next-turn queue item.');
    case 'tasks':
      return view('Observed native tasks','Only this owned thread\'s observed task/tool events. Raw process IDs are not accepted as control input.',[...w.tasks.values()].map(t=>entry(t.label,t.detail,{state:t.state,request:{kind:'task',resourceId:t.resourceId}})));
    case 'task': {
      const h=w.handles.get(r.resourceId,'codex-task'), t=w.tasks.get(h.id);
      if(!t) throw failure('NOT_FOUND','Task is no longer available');
      return view(t.label,'当前会话观察到的原生任务；不会把停止整轮冒充停止单个任务。',[entry('状态',t.state),entry('原生任务 ID',h.id),entry('开始观察时间',t.startedAt??''),entry('结束观察时间',t.endedAt??'')],[control('刷新详情',{kind:'task',resourceId:r.resourceId})],{text:cut(t.detail,24000)});
    }
    case 'retry':
      return view('Compaction and retry','No Codex retry-policy setter has been inferred. Native compaction completion is reported separately from ordinary turn completion.',[],[],{text:cut(JSON.stringify(w.native.compaction??{}),24000)});
    default: throw failure('CAPABILITY_UNSUPPORTED','The installed Codex adapter does not expose this native operation');
  }
}
export async function codexOrigin(h, mode, point, w) {
  if(mode==='attach') throw failure('READ_ONLY','External native processes are read-only; no terminal process is taken over');
  if(mode==='import') {
    const t=await checkHistory(this,h);
    if(!h.external || h.sourceSessionId || this.options.nativeSessionOwner?.(t.id) || t.id===this.threadId || t.status?.type==='active') throw failure('READ_ONLY','History cannot be imported from an active or managed source');
    // Copy through the native API; never attach to or write the source thread.
    return {threadId:t.id,mode:'clone',cwd:t.cwd,importVersion:t.updatedAt};
  }
  const t=await checkHistory(this,h,true);
  if(point && (point.threadId!==t.id || mode==='resume')) throw failure('VALIDATION_FAILED','Fork point does not belong to this history operation');
  return {threadId:t.id,mode,...(point?{lastTurnId:point.turnId}:{}),cwd:t.cwd};
}
export async function codexInput(input) {
  this.validatePrompt(input.text);
  const parts=inputParts(input), text=withTextFiles(input.text,parts.texts), result=[{type:'text',text,text_elements:[]}];
  if(parts.images.length) {
    const m=(await models(this)).find(x=>x.model===(this.nextModel??this.selectedModel));
    if(!m?.inputModalities?.includes('image')) throw failure('CAPABILITY_UNSUPPORTED','Selected Codex model did not advertise image input');
    result.push(...parts.images.map(f=>({type:'image',url:`data:${f.mediaType};base64,${f.bytes.toString('base64')}`})));
  }
  if(input.command) {
    const c=(await skills(this)).find(s=>s.enabled&&s.name===input.command.name&&s.path===input.command.path);
    if(!c || input.command.source!=='codex-skill') throw failure('SOURCE_CONFLICT','Native skill is no longer enabled at the selected path');
    result.push({type:'skill',name:c.name,path:c.path});
  }
  return result;
}
export function observeCodex(p,m) {
  const w=p.workspace; if(!w)return; const a=m.params??{};
  if(a.threadId&&p.threadId&&a.threadId!==p.threadId)return;
  if(m.method==='item/commandExecution/outputDelta') {
    const t=w.tasks.get(a.itemId);
    if(t){t.output=cut((t.output??'')+(a.delta??''),22000);t.detail=cut((t.command??'')+'\n'+t.output,24000);}
  }
  if(m.method==='account/login/completed') {
    if(w.native.login?.loginId===a.loginId) {w.handles.remove(w.native.login.resourceId);delete w.native.login;w.native.authState=a.success?'completed':'failed';}
  }
  if(m.method==='mcpServer/oauthLogin/completed') {
    const auth=w.native.mcpAuth?.[a.name];if(auth?.state==='pending')auth.state=a.success?'native_completed':'native_failed';
    w.diagnostic('MCP authorization',`${cut(a.name,200)}: ${a.success?'completed':'failed'}`);
  }
  const item=a.item;
  if(item && ['item/started','item/completed'].includes(m.method)) {
    if(['commandExecution','collabAgentToolCall','mcpToolCall'].includes(item.type)) {
      const old=w.tasks.get(item.id), resourceId=old?.resourceId??w.handles.put('codex-task',{id:item.id});
      const output=item.aggregatedOutput??old?.output??'';
      const detail=item.type==='commandExecution'?`${item.command}\n${output}\nExit: ${item.exitCode??'未上报'}`:item.type==='mcpToolCall'?`${item.server}/${item.tool}\n${JSON.stringify({arguments:item.arguments,result:item.result,error:item.error})}`:JSON.stringify({tool:item.tool,status:item.status,receiverThreadIds:item.receiverThreadIds,agentsStates:item.agentsStates,prompt:item.prompt});
      w.tasks.set(item.id,{resourceId,label:item.type,command:item.command,output:cut(output,22000),startedAt:old?.startedAt??new Date().toISOString(),endedAt:m.method==='item/completed'?new Date().toISOString():old?.endedAt,detail:cut(detail,24000),state:item.status??(m.method==='item/started'?'running':'completed')});
      while(w.tasks.size>100)w.tasks.delete(w.tasks.keys().next().value);
    }
    if(item.type==='fileChange'&&m.method==='item/completed'&&item.status==='completed') for(const f of item.changes??[]) void w.files.record(f.path,p.turnId).catch(()=>{});
    if(item.type==='contextCompaction') w.native.compaction={state:m.method==='item/completed'?'completed':'running'};
    if(item.type==='enteredReviewMode'||item.type==='exitedReviewMode') p.message(item.id,cut('[Codex native review: '+item.type+']\n'+item.review,4000),true);
  }
}
