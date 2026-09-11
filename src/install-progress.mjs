import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function logoFrame(tick, cell = '  ') {
  // A text-only cat/terminal mark for terminals; the PNG remains the UI artwork.
  const rows = [
    '         /\\_/\\',
    '        ( o.o )',
    '         / ^ \\',
    '   +------------------+',
    '   |  >_              |',
    '   |                  |',
    '   +------------------+',
    ''
  ];
  const width = cell.length === 1 ? 26 : 32;
  const visible = Math.floor(width * Math.min(1, Math.max(0, tick) / 22));
  return rows.map(row => {
    const line = row.padEnd(width, ' ').slice(0, visible).padEnd(width, ' ');
    return '  ' + '\x1b[36m' + line + '\x1b[0m';
  });
}

export async function showIntro(output = process.stdout, env = process.env, wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  const animated = output.isTTY && env.TERM !== 'dumb' && !env.CI && !env.NO_COLOR && (output.columns ?? 80) >= 40 && (output.rows ?? 24) >= 12;
  if (!animated) { output.write('\n  喵连\n'); return; }
  const cell = (output.columns ?? 80) >= 74 ? '  ' : ' ';
  output.write('\n');
  for (let tick = 0; tick <= 22; tick++) {
    output.write((tick ? '\x1b[7A' : '') + '\r' + logoFrame(tick, cell).map(line => '\x1b[2K' + line).join('\r\n'));
    await wait(65);
  }
  await wait(350);
  output.write('\r\n  喵连\n\n');
}

/** Indeterminate progress: never invent a percentage for dependency installation. */
export function progress(label, output = process.stdout, env = process.env) {
  const animated = !!output.isTTY && env.TERM !== 'dumb' && !env.CI && !env.NO_COLOR;
  const start = Date.now();
  let frame = 0, finished = false;
  const draw = () => {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    output.write(`\r\x1b[2K  ${['|', '/', '-', '\\'][frame++ % 4]} ${label}  ${elapsed}s`);
  };
  if (animated) draw(); else output.write(`  ... ${label}\n`);
  const timer = animated ? setInterval(draw, 140) : null;
  return (ok = true) => {
    if (finished) return;
    finished = true;
    if (timer) clearInterval(timer);
    output.write(`${animated ? '\r\x1b[2K' : ''}  ${ok ? '[OK]' : '[FAIL]'} ${label}\n`);
  };
}

export async function runStep(command, args, options = {}, label = '执行安装步骤') {
  const done = progress(label);
  let stdoutTail = '', stderrTail = '', interrupted = false;
  const child = spawn(command, args, { ...options, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const collect = (which, data) => {
    const text = data.toString();
    if (which === 'stderr') stderrTail = (stderrTail + text).slice(-8192);
    else stdoutTail = (stdoutTail + text).slice(-8192);
  };
  child.stdout.on('data', data => collect('stdout', data));
  child.stderr.on('data', data => collect('stderr', data));
  const cancel = () => { interrupted = true; child.kill(); };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code));
    });
    const ok = code === 0 && !interrupted;
    done(ok);
    if (!ok && (stderrTail || stdoutTail)) process.stderr.write((stderrTail + stdoutTail).slice(-16384) + '\n');
    return interrupted ? 130 : code ?? 1;
  } catch (error) {
    done(false);
    throw error;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { command, args, options, label } = JSON.parse(process.argv[2]);
    process.exitCode = await runStep(command, args, options, label);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
