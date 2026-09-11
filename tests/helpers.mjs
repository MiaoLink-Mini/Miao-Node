import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CodexPlugin } from '../src/plugins/codex.mjs';
import { PiPlugin } from '../src/plugins/pi.mjs';
import { ClaudePlugin } from '../src/plugins/claude.mjs';
import { fakeQuery } from './fixtures/claude-sdk.mjs';

export const fixture = fileURLToPath(new URL('./fixtures/native-cli.mjs', import.meta.url));
export function nativeFixture(type, options = {}) {
  const common = { command: process.execPath, args: [fixture, type], cwd: process.cwd(), sessionId: 's1', timeout: 2000, responseTimeout: 2000, ...options };
  return type === 'codex' ? new CodexPlugin(common) : type === 'pi' ? new PiPlugin(common) : new ClaudePlugin({ ...common, queryFactory: fakeQuery });
}
export async function until(fn, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(15); }
  throw new Error('condition timed out');
}
