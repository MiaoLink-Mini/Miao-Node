import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { progress, logoFrame, showIntro } from '../src/install-progress.mjs';

test('喵连 intro finishes before options and retains the cat terminal mark', async () => {
  const clean = lines => lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''));
  assert.deepEqual(logoFrame(22), logoFrame(100));
  assert.notDeepEqual(logoFrame(0), logoFrame(22));
  assert.equal(logoFrame(22).length, 8);
  for (const line of clean(logoFrame(22))) assert.equal(line.length, 34);
  for (const line of clean(logoFrame(22, ' '))) assert.equal(line.length, 28);
  const completed = clean(logoFrame(22)).join('\n');
  assert.ok(completed.includes('/\\_/\\'));
  assert.ok(completed.includes('>_'));
  assert.doesNotMatch(completed, /GoLink|WeAgent/);
  let text = '', waits = [];
  await showIntro({ isTTY: true, columns: 80, rows: 24, write: s => { text += s; } }, {}, async ms => { waits.push(ms); });
  text += 'MENU';
  assert.equal(waits.length, 24);
  assert.equal(waits.at(-1), 350);
  assert.ok(text.endsWith('\r\n  喵连\n\nMENU'));
  assert.ok(text.includes(logoFrame(22).at(-1)));
  for (const [isTTY, env] of [[false, {}], [true, {CI: '1'}], [true, {NO_COLOR: '1'}], [true, {TERM: 'dumb'}]]) {
    text = '';
    await showIntro({ isTTY, write: s => { text += s; } }, env, () => { throw Error('must not delay logs'); });
    assert.equal(text, '\n  喵连\n');
  }
});

test('download progress can suppress the standalone blocks before the 喵连 intro', () => {
  let text = '';
  const finish = progress('download', { isTTY: true, columns: 100, rows: 30, write: s => { text += s; } }, {});
  finish();
  assert.equal(text.includes('\x1b[8A'), false);
  assert.equal(/\x1b\[4[1-6]m/.test(text), false);
  assert.ok(text.endsWith('[OK] download\n'));
});

test('all terminals use single-line progress without blocks', () => {
  for (const columns of [24, 80]) {
    let text = '';
    const finish = progress('fixture', { isTTY: true, columns, rows: 24, write: s => { text += s; } }, {});
    finish();
    assert.equal(text.includes('\x1b[8A'), false);
    assert.ok(text.endsWith('[OK] fixture\n'));
  }
});

test('progress animates only interactive terminals and finishes once', async () => {
  for (const [isTTY, env, animated] of [[true, {}, true], [false, {}, false], [true, { CI: '1' }, false], [true, { TERM: 'dumb' }, false], [true, { NO_COLOR: '1' }, false]]) {
    let text = '';
    const done = progress('fixture', { isTTY, write: s => { text += s; } }, env);
    await new Promise(resolve => setTimeout(resolve, 220));
    done(); done(false);
    assert.equal(text.includes('\x1b['), animated);
    assert.equal(text.split('[OK]').length, 2);
    const finished = text;
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(text, finished);
  }
});

test('command wrapper preserves exit status, drains output, and reports failures without ANSI in logs', () => {
  const script = fileURLToPath(new URL('../src/install-progress.mjs', import.meta.url));
  for (const code of [0, 7]) {
    const result = spawnSync(process.execPath, [script, JSON.stringify({ command: process.execPath, args: ['-e', `process.stdout.write('x'.repeat(100000));console.error('fixture diagnostic');process.exitCode=${code}`], label: 'fixture' })], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, code);
    assert.equal(result.stderr.includes('\x1b['), false);
    assert.match(result.stdout, code ? /\[FAIL\]/ : /\[OK\]/);
    if (code) { assert.match(result.stderr, /fixture diagnostic/); assert.ok(result.stderr.length < 17000); }
  }
  const missing = spawnSync(process.execPath, [script, JSON.stringify({ command: 'golink-nonexistent-fixture-command', args: [], label: 'fixture' })], { encoding: 'utf8', timeout: 10000 });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /\[FAIL\]/);
});
