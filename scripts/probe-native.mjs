import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { discover, makePlugin } from '../src/config.mjs';

// Control-plane only: no prompt, API call to a model, task, or persistent native session.
const cwd = mkdtempSync(join(tmpdir(), 'weagent-probe-'));
try {
  for (const type of ['codex', 'pi', 'claude']) {
    const profile = await discover({ type, id: `agent_${type}`, name: type });
    let plugin;
    try {
      plugin = makePlugin(profile, { cwd, sessionId: 'probe', timeout: 20000 });
      await plugin.open();
      const catalog = await plugin.control({ action: 'models' });
      // Select only inside this disposable SDK/RPC session; no prompt or config-file write.
      const selection = catalog.models.length ? await plugin.control({ action: 'set_model', modelId: catalog.models[0].id }) : null;
      process.stdout.write(JSON.stringify({ plugin: type, version: profile.version, handshake: 'passed', models: catalog.models.length, selection: selection ? selection.applied ? 'native-confirmed' : 'staged-next-turn' : 'empty-catalog', modelPromptSent: false }) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ plugin: type, version: profile.version, handshake: 'failed', code: error.code ?? 'NATIVE_ERROR' }) + '\n');
      process.exitCode = 1;
    } finally { await plugin?.close(); }
  }
} finally {
  const within = relative(tmpdir(), cwd);
  if (!within || within.startsWith('..') || isAbsolute(within) || !within.startsWith('weagent-probe-')) throw new Error('Unsafe probe cleanup target');
  // SDK close finishes its stream before Windows releases the child working directory.
  await rm(cwd, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
}
