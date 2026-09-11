// Test-only Pi history in the caller's disposable state tree, never ~/.pi.
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { piHistoryDir } from '../../src/workspace/pi-history.mjs';

export async function seedPiHistory({ cwd, piAgentDir }) {
  if (typeof piAgentDir !== 'string' || !isAbsolute(piAgentDir)) {
    throw new TypeError('A private absolute piAgentDir is required for this fixture');
  }
  const project = await realpath(cwd);
  const directory = piHistoryDir({ options: { cwd: project, piAgentDir } });
  const path = join(directory, 'external.jsonl');
  const sessionId = 'external_pi';
  const rows = [
    { type: 'session', version: 3, id: sessionId, cwd: project, timestamp: '2026-09-10T00:00:00.000Z' },
    { type: 'message', id: 'fixture_user', parentId: null,
      message: { role: 'user', content: [{ type: 'text', text: 'Local Pi fixture history' }] } },
  ];
  const bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Restarting the daemon must preserve this source snapshot and its digest.
    if (!(await readFile(path)).equals(bytes)) {
      throw new Error('Pi fixture history changed; refusing to overwrite it');
    }
  }
  return { path, directory, sessionId };
}
