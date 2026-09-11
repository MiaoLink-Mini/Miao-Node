import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Handles } from '../src/workspace/handles.mjs';
import { ProjectFiles, Uploads } from '../src/workspace/files.mjs';
import { NativeRPC } from '../src/native-rpc.mjs';
import { listPiHistory, piHistoryView, preparePiOrigin, readPiHistory } from '../src/workspace/pi-history.mjs';
import { seedPiHistory } from './fixtures/pi-history.mjs';

async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'golink-ci-fixture-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('canonical fixture roots work without allowing symlinks as project or upload roots', async t => {
  const root = await temporary(t);
  const parent = join(root, 'parent'), alias = join(root, 'alias');
  await mkdir(parent);
  await symlink(parent, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const raw = await mkdtemp(join(alias, 'project-'));
  const canonical = await realpath(raw);
  assert.notEqual(raw, canonical);
  const handles = new Handles();
  await new ProjectFiles(canonical, handles).initialize();
  await assert.rejects(new ProjectFiles(raw, handles).initialize(), { code: 'FORBIDDEN' });
  const uploads = new Uploads(canonical, 'session', handles);
  await uploads.initialize();
  await assert.rejects(new Uploads(raw, 'session', new Handles()).initialize(), { code: 'FORBIDDEN' });
  await uploads.close();
});

test('Pi integration history is selectable and stable across daemon restarts', async t => {
  const root = await temporary(t);
  const options = { cwd: root, piAgentDir: join(root, 'private-agent') };
  const source = await seedPiHistory(options);
  const before = await readFile(source.path);
  assert.deepEqual(await seedPiHistory(options), source);
  assert.deepEqual(await readFile(source.path), before);
  const plugin = { options };
  const history = await listPiHistory(plugin);
  assert.equal(history.length, 1);
  assert.equal(history[0].sessionId, source.sessionId);
  const workspace = { session: { sessionId: 'browser' }, handles: new Handles() };
  const result = await piHistoryView.call(plugin, { kind: 'history' }, workspace);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].origin.mode, 'import');
  assert.equal(result.entries[0].origin.sessionId, 'browser');
  assert.equal(workspace.handles.get(result.entries[0].id, 'history').sessionId, source.sessionId);
});

test('Pi fixture seeding neither overwrites changed history nor uses an implicit agent directory', async t => {
  const root = await temporary(t);
  const options = { cwd: root, piAgentDir: join(root, 'private-agent') };
  const source = await seedPiHistory(options);
  await writeFile(source.path, 'changed fixture\n');
  await assert.rejects(seedPiHistory(options), /refusing to overwrite/);
  assert.equal(await readFile(source.path, 'utf8'), 'changed fixture\n');
  await assert.rejects(seedPiHistory({ cwd: root }), /private absolute piAgentDir/);
});

test('Pi native fixture uses the imported session identity and preserves the source snapshot', async t => {
  const root = await temporary(t);
  const options = { cwd: root, piAgentDir: join(root, 'private-agent') };
  const source = await seedPiHistory(options);
  const before = await readFile(source.path);
  const plugin = { options };
  const history = (await listPiHistory(plugin))[0];
  const importedPath = await preparePiOrigin(plugin, { ...history, mode: 'import' });
  const imported = await readPiHistory(plugin, importedPath);
  assert.notEqual(imported.sessionId, source.sessionId);
  const executable = fileURLToPath(new URL('./fixtures/native-cli.mjs', import.meta.url));
  const rpc = new NativeRPC(process.execPath, [executable, 'pi', '--session', importedPath], {
    cwd: root, mode: 'pi', timeout: 5000,
  });
  try {
    const state = await rpc.call('get_state');
    assert.equal(state.sessionId, imported.sessionId);
    assert.equal(state.isStreaming, false);
    assert.equal(state.pendingMessageCount, 0);
  } finally {
    await rpc.close();
  }
  assert.deepEqual(await readFile(source.path), before);
});
