// Test-only process entry: native fixtures + IPC faults, never imported by production CLI.
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { seedPiHistory } from './pi-history.mjs';
import { Daemon } from '../../src/daemon.mjs';
import { plugins } from '../../src/config.mjs';
import { nativeFixture } from '../helpers.mjs';
import { fakeQuery } from './claude-sdk.mjs';
const [gateway, stateDir, fault] = process.argv.slice(2);
const piAgentDir = join(stateDir, 'pi-agent');
const config = { gateway, stateDir, name: 'Plugin integration fixture', maxSessions: 8, projects: [{ id: 'fixture', name: 'Fixture workspace', path: realpathSync(process.cwd()), description: 'No model calls' }], profiles: ['codex', 'pi', 'claude'].map(type => ({ type, id: 'agent_' + type, name: type })) };
const daemon = new Daemon(config, {
  report: event => process.send?.(event),
  discoverProfile: async profile => ({ ...profile, state: 'ready', version: 'fixture/1', adapterVersion: '0.1.0', capabilities: plugins[profile.type].capabilities }),
  pluginFactory: (profile, context) => {
    const plugin = nativeFixture(profile.type, { ...context, ...(profile.type === 'pi' ? { piAgentDir } : {}) }), start = plugin.start.bind(plugin);
    if (profile.type === 'claude') plugin.options.queryFactory = args => fakeQuery(args, { compact: true });
    if(profile.type==='claude') plugin.options.sdk={
      listSessions:async()=>[{sessionId:'external_claude',cwd:context.cwd,lastModified:1,summary:'Local history'}],
      getSessionInfo:async()=>({sessionId:'external_claude',cwd:context.cwd,lastModified:1}),
      forkSession:async()=>({sessionId:'imported_claude'}),
    };
    plugin.start = async (...args) => {
      daemon.state.set('nativePromptCalls', (daemon.state.get('nativePromptCalls') ?? 0) + 1);
      const result = await start(...args);
      if (fault === 'after-accept') { process.send?.({ event: 'fault-after-accept' }, () => process.exit(17)); await new Promise(() => {}); }
      return result;
    };
    return plugin;
  },
});
process.on('message', message => {
  if (message.type === 'disconnect') daemon.socket?.terminate();
  if (message.type === 'stats') process.send?.({ event: 'stats', nativePromptCalls: daemon.state.get('nativePromptCalls') ?? 0, pending: daemon.state.pending().length, operations: daemon.state.db.prepare('SELECT value FROM journal').all().map(r => { const e = JSON.parse(r.value); return { id: e.command.operationId, state: e.state }; }) });
  if (message.type === 'stop') void daemon.close();
});
process.on('SIGTERM', () => { void daemon.close(); });
try {
  await seedPiHistory({ cwd: config.projects[0].path, piAgentDir });
  await daemon.run();
}
finally { await daemon.close(); daemon.state.close(); process.disconnect?.(); }
if (daemon.poisoned) process.exitCode = 1;
