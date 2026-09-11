#!/usr/bin/env node
/** Local-source installer. No curl-pipe-shell, global npm install, credentials or daemon replay. */
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { selectAgents } from '../src/agent-select.mjs';
import { progress, showIntro } from '../src/install-progress.mjs';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
export const marker = 'weagent-node-installer/1\n';
const defaultGateway = 'https://agent.000.moe';
const fail = message => { throw new Error(message); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = filename => { try { fs.lstatSync(filename); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
export function checkVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[1]) < 24 || Number(match[1]) === 24 && Number(match[2]) < 1) fail('Node.js >=24.1.0 is required. Install a supported Node.js release and retry.');
}
export function parseArgs(args) {
  const valueFlags = new Set(['--dir', '--config', '--gateway', '--project', '--plugins', '--name']);
  const booleanFlags = new Set(['--yes', '--dry-run', '--start', '--rollback', '--help', '--autostart', '--no-autostart', '--menu']);
  const options = { projects: [] }, seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!valueFlags.has(flag) && !booleanFlags.has(flag)) fail('Unknown option: ' + flag);
    if (seen.has(flag) && flag !== '--project') fail('Repeated option: ' + flag);
    seen.add(flag);
    if (booleanFlags.has(flag)) { options[flag.slice(2)] = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) fail('Missing value: ' + flag);
    if (flag === '--project') options.projects.push(value); else options[flag.slice(2)] = value;
  }
  if (options.config && (options.gateway || options.projects.length || options.plugins || options.name)) fail('--config cannot be combined with new-configuration fields.');
  if (options.rollback && (options.config || options.gateway || options.projects.length || options.plugins || options.name)) fail('--rollback keeps the existing configuration.');
  if (options.autostart && options['no-autostart']) fail('Use either --autostart or --no-autostart, not both.');
  if (options.start && options.autostart) fail('--autostart already starts the Daemon after installation; remove --start.');
  return options;
}
function assertPlainFile(filename) {
  const st = fs.lstatSync(filename);
  if (!st.isFile() || st.isSymbolicLink()) fail('Expected a regular file: ' + filename);
  return st;
}
function noLinks(filename) {
  const absolute = path.resolve(filename), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (exists(current) && fs.lstatSync(current).isSymbolicLink()) fail('Symbolic links are not accepted for installation paths: ' + current);
  }
}
export function readInstallFiles(root) {
  const manifestPath = path.join(root, 'WeAgent-Node/install-files.json');
  noLinks(manifestPath); assertPlainFile(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) fail('Invalid installation manifest.');
  const paths = new Set(), files = [];
  const fixed = new Set(['WeAgent-Node/scripts/install.mjs', 'WeAgent-Node/package.json', 'WeAgent-Node/package-lock.json', 'WeAgent-Backend/contracts/protocol.schema.json', 'WeAgent-Backend/contracts/workspace-operations.json']);
  for (const entry of manifest.files) {
    const name = entry.path;
    if (typeof name !== 'string' || !name || /[\\:\x00-\x1f]/.test(name) || name !== path.posix.normalize(name) || name.startsWith('/') || name.split('/').some(p => p === '..' || p.startsWith('.')) || paths.has(name)) fail('Unsafe or duplicated manifest path.');
    if (!fixed.has(name) && !name.startsWith('WeAgent-Node/src/') && !name.startsWith('WeAgent-Node/plugins/')) fail('Unapproved installation path: ' + name);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) fail('Invalid source checksum.');
    let exact = root;
    for (const part of name.split('/')) {
      if (!fs.readdirSync(exact).includes(part)) fail('Exact source path missing: ' + name);
      exact = path.join(exact, part);
      if (fs.lstatSync(exact).isSymbolicLink()) fail('Source symlink refused: ' + name);
    }
    assertPlainFile(exact);
    const bytes = fs.readFileSync(exact);
    if (digest(bytes) !== entry.sha256) fail('Source checksum mismatch: ' + name);
    paths.add(name); files.push({ name, bytes, sha256: entry.sha256 });
  }
  for (const required of [...fixed, 'WeAgent-Node/src/cli.mjs', 'WeAgent-Node/src/config.mjs']) if (!paths.has(required)) fail('Installation manifest is incomplete: ' + required);
  return { files, version: digest(JSON.stringify(manifest.files)).slice(0, 24) };
}
export function freshConfig(options) {
  if (!options.projects.length || !options.plugins) fail('Supply at least one --project and --plugins, or use --config.');
  const url = new URL(options.gateway ?? defaultGateway);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['http:', 'https:'].includes(url.protocol)) fail('Gateway must be an HTTP(S) origin without credentials, path, query or fragment.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail('A remote Gateway requires HTTPS.');
  const types = options.plugins.split(',');
  if (!types.length || types.some(type => !['claude', 'codex', 'pi'].includes(type)) || new Set(types).size !== types.length) fail('--plugins accepts distinct exact values: claude,codex,pi.');
  if (options.projects.length > 100) fail('At most 100 projects may be authorized.');
  const seen = new Set();
  const projects = options.projects.map((value, index) => {
    const resolved = fs.realpathSync(path.resolve(value));
    if (!fs.statSync(resolved).isDirectory() || seen.has(resolved)) fail('Project must be a distinct existing directory: ' + value);
    if (resolved === path.parse(resolved).root || resolved === fs.realpathSync(os.homedir())) fail('Do not authorize an entire drive or home directory. Select a project directory.');
    seen.add(resolved);
    return { id: 'project_' + (index + 1), name: path.basename(resolved).slice(0, 100) || 'Project', path: resolved, description: '' };
  });
  const name = options.name || os.hostname();
  if (!name || name.length > 80 || /[\x00-\x1f]/.test(name)) fail('Host name must contain 1-80 printable characters.');
  return { gateway: url.origin, name, stateDir: path.join(options.dir, 'state'), maxSessions: 8, projects,
    plugins: types.map(type => ({ type, enabled: true, ...(type === 'claude' ? { maxBudgetUsd: 2 } : {}) })) };
}
function activeState(root) {
  const filename = path.join(root, 'active.json');
  if (!exists(filename)) return null;
  noLinks(filename); assertPlainFile(filename);
  const current = JSON.parse(fs.readFileSync(filename, 'utf8'));
  for (const item of [current, current.previous].filter(Boolean)) {
    if (item.version !== 1 || !/^releases\/[a-f0-9]{24}$/.test(item.release) || typeof item.config !== 'string' || !path.isAbsolute(item.config)) fail('Invalid active installation record.');
  }
  return current;
}
function stopRequired(configPath, config) {
  const raw = config || JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const stateDir = path.resolve(path.dirname(configPath), raw.stateDir ?? '.runtime/state');
  const lock = path.join(stateDir, 'daemon.lock');
  if (exists(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    // An unreadable owner is treated as alive: never guess a lock away. Only ESRCH proves staleness.
    let alive = true;
    if (Number.isInteger(pid) && pid > 0) try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    // A live owner blocks the install; a dead owner left a stale lock that the Daemon itself removes on next start.
    if (alive) fail('Stop the existing Daemon before installing or rolling back (node launch.mjs stop). Its state lock is present; the installer never deletes it.');
  }
  return stateDir;
}
function privateRoot(root) {
  if (root === path.parse(root).root || root === path.resolve(os.homedir())) fail('Installation directory cannot be a drive root or home itself.');
  noLinks(root);
  if (exists(root)) {
    if (!fs.statSync(root).isDirectory()) fail('Installation path is not a directory.');
    const stamp = path.join(root, '.weagent-node-install');
    if (!exists(stamp)) fail('Existing directory is not managed by this installer. Choose an empty new path.');
    noLinks(stamp); assertPlainFile(stamp);
    if (fs.readFileSync(stamp, 'utf8') !== marker) fail('Existing directory is not managed by this installer. Choose an empty new path.');
    if (process.platform !== 'win32' && fs.statSync(root).mode & 0o077) fail('Installation directory must be private (chmod 700).');
  }
}
function verifyInstalledRelease(target, release, source = null) {
  noLinks(target);
  const stamp = path.join(target, '.complete.json');
  noLinks(stamp); assertPlainFile(stamp);
  const complete = JSON.parse(fs.readFileSync(stamp, 'utf8'));
  if (complete.version !== 1 || complete.release !== release || !Array.isArray(complete.files) || !complete.files.length) fail('Invalid completed release record.');
  const seen = new Set();
  for (const entry of complete.files) {
    if (!entry || typeof entry.path !== 'string' || /[\\:\x00-\x1f]/.test(entry.path) || entry.path !== path.posix.normalize(entry.path) || entry.path.startsWith('/') || entry.path.split('/').some(p => p.startsWith('.')) || seen.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail('Invalid completed release file.');
    if (!['WeAgent-Node/scripts/install.mjs', 'WeAgent-Node/package.json', 'WeAgent-Node/package-lock.json', 'WeAgent-Backend/contracts/protocol.schema.json', 'WeAgent-Backend/contracts/workspace-operations.json'].includes(entry.path) && !entry.path.startsWith('WeAgent-Node/src/') && !entry.path.startsWith('WeAgent-Node/plugins/')) fail('Unapproved completed release path.');
    seen.add(entry.path);
    const filename = path.join(target, entry.path);
    noLinks(filename); assertPlainFile(filename);
    if (digest(fs.readFileSync(filename)) !== entry.sha256) fail('Installed source checksum mismatch: ' + entry.path);
  }
  if ('releases/' + digest(JSON.stringify(complete.files)).slice(0, 24) !== release) fail('Release identity does not match its file manifest.');
  if (source && JSON.stringify(complete.files) !== JSON.stringify(source.files.map(f => ({ path: f.name, sha256: f.sha256 })))) fail('Completed release differs from requested source.');
}
function doctor(directory, configPath, config, execute) {
  const checkConfig = config ? path.join(directory, 'config.install-' + randomUUID() + '.json') : configPath;
  try {
    if (config) fs.writeFileSync(checkConfig, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    execute(process.execPath, [path.join(directory, 'WeAgent-Node/src/cli.mjs'), 'doctor', '--config', checkConfig], { cwd: path.join(directory, 'WeAgent-Node'), shell: false, label: '检查配置与 Agent 环境' });
  } finally { if (config && exists(checkConfig)) fs.unlinkSync(checkConfig); }
}
function privateScope(root, configPath, config) {
  const raw = config || JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const state = path.resolve(path.dirname(configPath), raw.stateDir ?? '.runtime/state');
  const inDirectory = (value, directory) => { const rel = path.relative(directory, value); return rel === '' || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
  if (inDirectory(state, path.join(root, 'releases')) || inDirectory(configPath, path.join(root, 'releases'))) fail('Configuration and state must remain outside source releases.');
  for (const project of raw.projects || []) {
    if (!project || typeof project.path !== 'string') fail('Invalid project path in existing configuration.');
    const directory = fs.realpathSync(path.resolve(path.dirname(configPath), project.path));
    if (inDirectory(root, directory)) fail('Installation directory must not be inside an authorized project. Select a separate private directory.');
  }
}
function atomicFile(filename, data, mode = 0o600) {
  if (exists(filename)) assertPlainFile(filename);
  const temporary = filename + '.tmp-' + randomUUID();
  try { fs.writeFileSync(temporary, data, { flag: 'wx', mode }); fs.renameSync(temporary, filename); }
  finally { if (exists(temporary)) fs.unlinkSync(temporary); }
}
// Windows scanners can briefly retain directory handles after npm/doctor exit.
// Keep the operation atomic; never replace rename with a partial directory copy.
export function renameWithRetry(from, to, { rename = fs.renameSync, platform = process.platform, wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return rename(from, to); }
    catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 12) throw error;
      wait(Math.min(100 * 2 ** attempt, 800));
    }
  }
}
function run(command, args, options = {}) {
  const { label, ...childOptions } = options;
  const result = label
    ? spawnSync(process.execPath, [fileURLToPath(new URL('../src/install-progress.mjs', import.meta.url)), JSON.stringify({ command, args, options: childOptions, label })], { stdio: 'inherit', windowsHide: true, shell: false })
    : spawnSync(command, args, { stdio: 'inherit', ...childOptions });
  if (result.error) throw result.error;
  if (result.status !== 0) fail('Installation step failed (' + (result.status ?? result.signal) + '): ' + path.basename(command));
}
export function npmCommand() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    ...String(process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'node_modules/npm/bin/npm-cli.js'))];
  const cli = candidates.find(file => file && file.endsWith('.js') && exists(file));
  if (cli) return [process.execPath, [cli], false];
  if (process.platform !== 'win32') return ['npm', [], false];
  fail('npm-cli.js not found. Install npm alongside Node.js; shell wrappers are not used.');
}
export function launcherSource() {
  return `// Managed launcher. Keeps state/config outside immutable source releases.\nimport fs from 'node:fs';\nimport path from 'node:path';\nimport {fileURLToPath,pathToFileURL} from 'node:url';\nconst root=path.dirname(fileURLToPath(import.meta.url));\nconst active=JSON.parse(fs.readFileSync(path.join(root,'active.json'),'utf8'));\nif(active.version!==1||!/^releases\\/[a-f0-9]{24}$/.test(active.release)||!path.isAbsolute(active.config))throw Error('Invalid installation record');\nconst forward=process.argv.slice(2);\nconst args=forward.length?[...forward,...(forward.includes('--config')||forward.some(x=>x==='help'||x==='--help')?[]:['--config',active.config])]:['start','--config',active.config];\nconst cwd=path.join(root,active.release,'WeAgent-Node');\nconst cli=path.join(cwd,'src/cli.mjs');\nprocess.env.GOLINK_INSTALL_ROOT=root;\nprocess.env.GOLINK_CALLER_CWD=process.cwd();\nprocess.chdir(cwd);\nprocess.argv=[process.execPath,cli,...args];\nawait import(pathToFileURL(cli).href);\n`;
}
/** Pure per-platform description of the opt-in login entry. No writes, no process execution. */
export function autostartSpec(platform, root, nodePath, home = os.homedir()) {
  const launcher = path.join(root, 'launch.mjs'), log = path.join(root, 'daemon.log');
  if (platform === 'win32') {
    const vbsPath = path.join(root, 'launch-hidden.vbs');
    // wscript keeps the window hidden; cmd appends Daemon output to the shared log.
    const inner = 'cmd /c ""' + nodePath + '" "' + launcher + '" >> "' + log + '" 2>&1"';
    const vbsQuote = value => '"' + value.replaceAll('"', '""') + '"';
    return { kind: 'windows', registryKey: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', valueName: 'GoLinkNode',
      command: 'wscript.exe "' + vbsPath + '"', vbsPath,
      vbsSource: `' Managed by the 喵连 installer; runs the Daemon hidden at login.\nCreateObject("WScript.Shell").Run ${vbsQuote(inner)}, 0, False\n` };
  }
  if (platform === 'darwin') {
    const esc = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return { kind: 'launchd', label: 'moe.000.golink.node', plistPath: path.join(home, 'Library', 'LaunchAgents', 'moe.000.golink.node.plist'),
      plistSource: '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>moe.000.golink.node</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>' + esc(nodePath) + '</string>\n    <string>' + esc(launcher) + '</string>\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>ProcessType</key><string>Background</string>\n  <key>StandardOutPath</key><string>' + esc(log) + '</string>\n  <key>StandardErrorPath</key><string>' + esc(log) + '</string>\n</dict>\n</plist>\n' };
  }
  if (platform === 'linux') {
    return { kind: 'systemd', service: 'golink-node', unitPath: path.join(home, '.config', 'systemd', 'user', 'golink-node.service'),
      unitSource: '[Unit]\nDescription=喵连 Node daemon\nAfter=network-online.target\n\n[Service]\nExecStart="' + nodePath + '" "' + launcher + '"\nRestart=on-failure\nStandardOutput=append:' + log + '\nStandardError=append:' + log + '\n\n[Install]\nWantedBy=default.target\n' };
  }
  return { kind: 'unsupported' };
}
function defaultProbe(command, args) {
  try { return spawnSync(command, args, { stdio: 'ignore', windowsHide: true, shell: false }).status === 0; } catch { return false; }
}
/** Register the per-user login entry. Returns whether the service manager also started the Daemon now. */
export function enableAutostart(root, deps = {}) {
  const { execute = run, nodePath = process.execPath, platform = process.platform, home = os.homedir() } = deps;
  if (!exists(path.join(root, 'launch.mjs'))) fail('No active installation to auto-start.');
  const spec = autostartSpec(platform, root, nodePath, home);
  if (spec.kind === 'windows') {
    atomicFile(spec.vbsPath, spec.vbsSource);
    execute('reg.exe', ['add', spec.registryKey, '/v', spec.valueName, '/t', 'REG_SZ', '/d', spec.command, '/f'], { shell: false });
    return { startsNow: false, description: 'Windows Run key' };
  }
  if (spec.kind === 'launchd') {
    fs.mkdirSync(path.dirname(spec.plistPath), { recursive: true });
    atomicFile(spec.plistPath, spec.plistSource);
    try { execute('launchctl', ['unload', spec.plistPath], { shell: false }); } catch { /* not loaded yet */ }
    execute('launchctl', ['load', spec.plistPath], { shell: false });
    return { startsNow: true, description: 'macOS LaunchAgent' };
  }
  if (spec.kind === 'systemd') {
    fs.mkdirSync(path.dirname(spec.unitPath), { recursive: true });
    atomicFile(spec.unitPath, spec.unitSource);
    execute('systemctl', ['--user', 'daemon-reload'], { shell: false });
    execute('systemctl', ['--user', 'enable', '--now', spec.service], { shell: false });
    return { startsNow: true, description: 'systemd user unit' };
  }
  fail('Auto-start is not supported on this platform.');
}
/** Remove the per-user login entry and the generated helper; a no-op when never enabled. */
export function disableAutostart(root, deps = {}) {
  const { execute = run, probe = defaultProbe, nodePath = process.execPath, platform = process.platform, home = os.homedir() } = deps;
  const spec = autostartSpec(platform, root, nodePath, home);
  if (spec.kind === 'windows') {
    if (!probe('reg.exe', ['query', spec.registryKey, '/v', spec.valueName])) return { removed: false };
    execute('reg.exe', ['delete', spec.registryKey, '/v', spec.valueName, '/f'], { shell: false });
    if (exists(spec.vbsPath)) fs.unlinkSync(spec.vbsPath);
    return { removed: true };
  }
  if (spec.kind === 'launchd') {
    if (!exists(spec.plistPath)) return { removed: false };
    try { execute('launchctl', ['unload', spec.plistPath], { shell: false }); } catch { /* not loaded */ }
    fs.unlinkSync(spec.plistPath);
    return { removed: true };
  }
  if (spec.kind === 'systemd') {
    if (!exists(spec.unitPath)) return { removed: false };
    execute('systemctl', ['--user', 'disable', '--now', spec.service], { shell: false });
    fs.unlinkSync(spec.unitPath);
    execute('systemctl', ['--user', 'daemon-reload'], { shell: false });
    return { removed: true };
  }
  fail('Auto-start is not supported on this platform.');
}
/** Detached background start with output appended to the managed log. */
export async function startBackground(launcher, logPath, { spawnFn = spawn, open = fs.openSync, close = fs.closeSync, timeout = 15000, stableMs = 1500 } = {}) {
  const root = path.dirname(launcher), active = JSON.parse(fs.readFileSync(path.join(root, 'active.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(active.config, 'utf8'));
  const lock = path.join(path.resolve(path.dirname(active.config), config.stateDir || '.runtime/state'), 'daemon.lock');
  const out = open(logPath, 'a');
  let child, spawnError;
  try {
    child = spawnFn(process.execPath, [launcher], { cwd: root, detached: true, stdio: ['ignore', out, out], windowsHide: true, shell: false });
    child.on('error', error => { spawnError = error; });
  } finally { close(out); }
  try {
    const deadline = Date.now() + timeout; let readyAt;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode) fail('Daemon exited before startup confirmation; log: ' + logPath);
      let pid; try { pid = Number(fs.readFileSync(lock, 'utf8')); } catch { /* starting */ }
      if (pid === child.pid) {
        process.kill(pid, 0); readyAt ??= Date.now();
        if (Date.now() - readyAt >= stableMs) { child.unref(); return { pid, logPath }; }
      } else readyAt = undefined;
      await sleep(100);
    }
    fail('Daemon startup was not confirmed; log: ' + logPath);
  } catch (error) {
    if (child.pid && child.exitCode === null && !child.signalCode) {
      await new Promise(resolve => { child.once('close', resolve); child.kill(); });
    }
    throw error;
  }
}
/** Latest pairing event from the daemon log, if any. */
export function readPairingCode(logPath) {
  let text; try { text = fs.readFileSync(logPath, 'utf8'); } catch { return null; }
  let found = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"pairing"')) continue;
    try { const event = JSON.parse(line); if (event?.event === 'pairing') found = event; } catch { /* partial line */ }
  }
  return found ? { code: found.code, expiresAt: found.expiresAt } : null;
}
export function install(options, deps = {}) {
  checkVersion(deps.nodeVersion || process.versions.node);
  const execute = deps.run || run, root = path.resolve(options.dir || path.join(os.homedir(), '.weagent-node'));
  options = { ...options, dir: root };
  privateRoot(root);
  const old = activeState(root);
  if (options.rollback && !old?.previous) fail('No previous installation to roll back to.');
  const configPath = path.resolve(options.config || old?.config || path.join(root, 'config.local.json'));
  const usesExisting = !!options.config || !!old || exists(configPath);
  if (usesExisting && (options.gateway || options.projects?.length || options.plugins || options.name)) fail('Existing configuration is preserved. New-configuration fields cannot be applied during update.');
  if (usesExisting) { noLinks(configPath); assertPlainFile(configPath); }
  if (old && options.config && configPath !== old.config) fail('An update cannot switch configuration or identity. Create a separate installation.');
  const config = usesExisting ? null : freshConfig(options);
  const stateDir = stopRequired(configPath, config);
  privateScope(root, configPath, config);
  noLinks(path.join(root, 'releases'));
  const source = options.rollback ? null : readInstallFiles(deps.sourceRoot || sourceRoot);
  const release = options.rollback ? old.previous.release : 'releases/' + source.version;
  const target = path.join(root, release);
  // Show scope before any persistent write or network request.
  const plan = { action: options.rollback ? 'rollback' : old ? 'update' : 'install', directory: root, release, configuration: configPath, stateDirectory: stateDir, existingConfiguration: usesExisting, autostart: options.autostart ? 'enable' : options['no-autostart'] ? 'disable' : null, start: !!options.start };
  if (options['dry-run']) return plan;
  if (!options.yes) fail('Installation needs confirmation; use the interactive entry point or --yes.');
  if (!exists(root)) { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(root, '.weagent-node-install'), marker, { flag: 'wx', mode: 0o600 }); }
  const lockPath = path.join(root, 'install.lock');
  let lock;
  try { lock = fs.openSync(lockPath, 'wx', 0o600); fs.writeFileSync(lock, String(process.pid)); }
  catch (e) { if (e.code === 'EEXIST') fail('Another installation is active or interrupted. Inspect install.lock; it is never removed automatically.'); throw e; }
  let staging;
  try {
    // Repeat all mutable checks under the installation lock.
    if (JSON.stringify(activeState(root)) !== JSON.stringify(old)) fail('Installation changed; retry after inspecting the current version.');
    stopRequired(configPath, config);
    noLinks(path.join(root, 'releases'));
    if (options.rollback) {
      verifyInstalledRelease(target, release);
      doctor(target, configPath, config, execute);
    } else if (!exists(target)) {
      fs.mkdirSync(path.join(root, 'releases'), { recursive: true, mode: 0o700 });
      staging = path.join(root, 'releases', '.staging-' + randomUUID());
      fs.mkdirSync(staging, { mode: 0o700 });
      for (const file of source.files) { const dest = path.join(staging, file.name); fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 }); fs.writeFileSync(dest, file.bytes, { flag: 'wx', mode: 0o600 }); }
      const [command, prefix, shell] = npmCommand();
      execute(command, [...prefix, 'ci', '--ignore-scripts', '--no-fund', '--no-audit'], { cwd: path.join(staging, 'WeAgent-Node'), shell, label: '安装依赖' });
      doctor(staging, configPath, config, execute);
      fs.writeFileSync(path.join(staging, '.complete.json'), JSON.stringify({ version: 1, release, installedAt: new Date().toISOString(), files: source.files.map(f => ({ path: f.name, sha256: f.sha256 })) }) + '\n', { flag: 'wx', mode: 0o600 });
      (deps.renameRelease || renameWithRetry)(staging, target); staging = null;
    } else { verifyInstalledRelease(target, release, source); doctor(target, configPath, config, execute); }
    stopRequired(configPath, config);
    if (config) fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const record = { version: 1, release, config: configPath, previous: old && old.release !== release ? { version: 1, release: old.release, config: old.config } : old?.previous || null };
    atomicFile(path.join(root, 'launch.mjs'), launcherSource());
    atomicFile(path.join(root, 'active.json'), JSON.stringify(record, null, 2) + '\n');
    return plan;
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true }); // Only the unique staging directory created by THIS run.
    fs.closeSync(lock); fs.unlinkSync(lockPath);
  }
}
const help = `喵连 Node one-command installer (run from the downloaded source bundle)\n\n  bash WeAgent-Node/install.sh\n  powershell -NoProfile -File .\\WeAgent-Node\\install.ps1\n\nOptions:\n  --dir PATH          Managed installation directory (default: ~/.weagent-node)\n  --config PATH       Reuse an existing config in place; never overwrite it\n  --gateway ORIGIN    New-install Gateway origin (default: https://agent.000.moe)\n  --project PATH      Explicit project allowlist entry; may be repeated\n  --plugins TYPES     Exact comma-separated values: claude,codex,pi\n  --name TEXT         Device label (default: actual hostname)\n  --yes               Confirm this installation\n  --dry-run           Validate and print the plan; no writes, npm or process start\n  --start             Run the Daemon in the foreground after installation\n  --autostart         Register a per-user login entry so the Daemon starts at login\n  --no-autostart      Remove the per-user login entry\n  --rollback          Activate the preceding source release; keep config and state\n  --help              Show this text\n\nAfter installation the Daemon starts in the background and logs to <dir>/daemon.log.\nAuto-start is opt-in and per-user only: a Windows Run key, a macOS LaunchAgent or a\nLinux systemd user unit. No admin rights and no system-level service are involved.\nStop the Daemon with: node <dir>/launch.mjs stop\n\nRequires Node.js >=24.1 and npm. Does not install Node.js or third-party Agents,\ncreate model credentials, change Gateway or migrate its database.\nStop an existing Daemon before update/rollback. Windows: choose a private NTFS directory.\n`;
export function disableOwnedAutostart(root) {
  const spec=autostartSpec(process.platform,root,process.execPath);
  if(spec.kind==='windows') {
    const result=spawnSync('reg.exe',['query',spec.registryKey,'/v',spec.valueName],{encoding:'utf8',windowsHide:true,shell:false});
    if(result.status!==0 || !result.stdout.toLowerCase().includes(spec.vbsPath.toLowerCase())) return {removed:false};
  } else {
    const file=spec.plistPath || spec.unitPath;
    if(!file || !exists(file)) return {removed:false};
    noLinks(file);
    const expected=spec.plistSource || spec.unitSource;
    if(fs.readFileSync(file,'utf8')!==expected) return {removed:false};
  }
  return disableAutostart(root);
}
export async function uninstall(directory, confirmed, deps = {}) {
  if (!directory) fail('Run uninstall through the managed launch.mjs.');
  const root = path.resolve(directory); noLinks(root); privateRoot(root);
  const active = activeState(root); if (!active) fail('No managed installation found.');
  stopRequired(active.config, null);
  const releases = path.join(root,'releases'); noLinks(releases);
  const targets = fs.readdirSync(releases).map(name => {
    if (!/^[a-f0-9]{24}$/.test(name)) fail('Unexpected release directory; inspect it before uninstalling.');
    const target = path.resolve(releases,name);
    if (path.dirname(target)!==releases) fail('Unsafe removal path');
    noLinks(target); verifyInstalledRelease(target,'releases/'+name);
    return target;
  });
  const config = JSON.parse(fs.readFileSync(active.config,'utf8'));
  const state = path.resolve(path.dirname(active.config), config.stateDir ?? '.runtime/state');
  for(const file of [active.config,state]) if(file===releases || file.startsWith(releases+path.sep)) fail('Configuration/state is inside a release; refusing removal.');
  if (!confirmed) fail('Uninstall removes program files, retaining configuration, pairing identity and history. Stop the Daemon, then repeat uninstall --yes.');
  (deps.disableAutostart || disableOwnedAutostart)(root);
  // Only verified immutable releases under this marked installation are removed.
  process.chdir(root);
  for(const target of targets) fs.rmSync(target,{recursive:true,force:false});
  for(const name of ['active.json','launch.mjs','launch-hidden.vbs']) {
    const file=path.join(root,name); noLinks(file); if(exists(file)) fs.unlinkSync(file);
  }
  console.log('Uninstalled. Configuration, pairing identity and history retained in '+root+'; state: '+state);
}
export const menuItems=['安装 / 更新','卸载','重装（保留配置与历史）','添加项目','删除项目授权','连接 Agent','重新生成配对码'];
export function menuChoice(value) {
  if(!/^[0-7]$/.test(value.trim())) throw Error('请选择 0–7');
  return Number(value.trim());
}
async function ask(label) {
  const rl=createInterface({input:process.stdin,output:process.stdout});
  try{return (await rl.question(label)).trim();}finally{rl.close();}
}
export function elevatedStopScript(root, lock, pid, nodePath = process.execPath) {
  if (!Number.isSafeInteger(pid) || pid <= 0) fail('Invalid Daemon PID');
  const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
  return `$ErrorActionPreference='Stop'; try {
    if ([int](Get-Content -LiteralPath ${quote(lock)} -Raw) -ne ${pid}) { throw 'Daemon identity changed' }
    $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'
    if (!$p) { exit 0 }
    if ($p.ExecutablePath -ine ${quote(nodePath)} -or !$p.CommandLine -or !$p.CommandLine.Contains(${quote(path.join(root,'launch.mjs'))})) { throw 'Daemon process identity not verified' }
    Stop-Process -Id ${pid} -ErrorAction Stop
    exit 0
  } catch { exit 1 }`;
}
export function stopElevated(root, lock, pid) {
  const encoded = Buffer.from(elevatedStopScript(root, lock, pid), 'utf16le').toString('base64');
  const command = `$ErrorActionPreference='Stop'; try { $p=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'; exit $p.ExitCode } catch { exit 1 }`;
  const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')], { stdio:'inherit', shell:false, windowsHide:true });
  if (result.error || result.status !== 0) fail('未能停止旧节点：UAC 被取消或进程身份核验失败。配置与历史未修改。');
}
async function stopForManagement(root, active) {
  const raw=JSON.parse(fs.readFileSync(active.config,'utf8'));
  const state=path.resolve(path.dirname(active.config),raw.stateDir??'.runtime/state');
  const lock=path.join(state,'daemon.lock');
  if(!exists(lock))return false;
  const pid=Number(fs.readFileSync(lock,'utf8'));
  if(!Number.isInteger(pid)||pid<=0)fail('Invalid Daemon lock');
  let elevated = false;
  try{process.kill(pid,0);}catch(e){
    if(e.code==='ESRCH')return false;
    if(process.platform!=='win32'||e.code!=='EPERM')throw e;
    console.log('旧节点需要管理员权限才能停止，请确认 Windows UAC 提示。仅停止旧节点，安装器不会以管理员身份运行。');
    stopElevated(root,lock,pid); elevated=true;
  }
  if(!elevated)run(process.execPath,[path.join(root,'launch.mjs'),'stop'],{shell:false});
  for(const end=Date.now()+15000;Date.now()<end;){
    try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')return true;throw e;}
    await sleep(200);
  }
  fail('Daemon did not stop; no configuration changes made');
}
export function reinstall(options, deps={}) {
  const root=path.resolve(options.dir),active=activeState(root);privateRoot(root);
  if(!active)fail('Install before reinstalling');
  stopRequired(active.config,null);
  if(exists(path.join(root,'install.lock')))fail('Another installation is active');
  // Rebuild from the verified downloaded source, never clear config or identity.
  const release=readInstallFiles(deps.sourceRoot||sourceRoot);
  const target=path.resolve(root,'releases',release.version);
  const parent=path.resolve(root,'releases');
  if(path.dirname(target)!==parent)fail('Unsafe reinstall path');noLinks(target);
  let backup;
  if(exists(target)){
    const backups=path.join(root,'repair-backups');noLinks(backups);fs.mkdirSync(backups,{recursive:true,mode:0o700});
    backup=path.join(backups,randomUUID());renameWithRetry(target,backup);
  }
  try{return install({...options,yes:true},deps);}
  catch(error){if(backup&&!exists(target))renameWithRetry(backup,target);throw error;}
}
export function installedModuleURL(root, active, name) {
  if(!['manage','config','daemon'].includes(name))fail('Unsupported management module');
  const current=activeState(root);
  if(!current || current.release!==active.release || current.config!==active.config)fail('Active installation changed; reopen the menu');
  const release=path.resolve(root,active.release);noLinks(release);
  verifyInstalledRelease(release,active.release);
  const file=path.join(release,'WeAgent-Node','src',name+'.mjs');noLinks(file);assertPlainFile(file);
  return pathToFileURL(file).href;
}
export async function regeneratePairing(configPath, modules={}) {
  const {loadConfig}=modules.config || await import('../src/config.mjs');
  const {Daemon}=modules.daemon || await import('../src/daemon.mjs');
  const {createPublicKey}=await import('node:crypto');
  const daemon=new Daemon(loadConfig(configPath),{report:()=>{}});
  try{
    if(daemon.identity.nodeId)fail('ALREADY_PAIRED: 此设备已绑定，不会清除身份。无需重新配对；更换账号请先在小程序管理绑定。');
    const old=daemon.state.get('enrollment');
    if(old){
      const status=await daemon.api('GET','/v1/node/enrollments/'+old.id,old.pollToken,null,'EnrollmentStatus');
      if(status.state==='confirmed'){
        daemon.identity.nodeId=status.nodeId;daemon.state.set('identity',daemon.identity);daemon.state.set('enrollment',null);
        fail('ALREADY_PAIRED: 已完成绑定，保留原身份。');
      }
    }
    const jwk=createPublicKey(daemon.key).export({format:'jwk'});
    const enrollment=await daemon.api('POST','/v1/node/enrollments',null,{publicKey:Buffer.from(jwk.x,'base64url').toString('base64'),name:daemon.config.name,platform:{win32:'windows',darwin:'macos',linux:'linux'}[process.platform]??'other',version:'weagent-node/0.1.0'},'Enrollment');
    daemon.state.set('enrollment',enrollment);
    console.log('配对码：'+enrollment.code+'；有效期至 '+enrollment.expiresAt);
  }finally{await daemon.close();daemon.state.close();}
}
async function interactiveMenu(options) {
  const root=path.resolve(options.dir||path.join(os.homedir(),'.weagent-node'));
  await showIntro();
  console.log('\n喵连 Node 管理\n'+menuItems.map((x,i)=>(i+1)+'. '+x).join('\n')+'\n0. 退出\n目录：'+root);
  const choice=menuChoice(await ask('选择操作 [0–7]：'));
  if(!choice)return null;
  const active=activeState(root);
  if(choice!==1&&!active)fail('请先安装 Node。');
  if(choice===1&&!active)return {...options,dir:root};
  let project,selection;
  if(choice===4){project=await ask('项目文件夹路径：');if(!project)fail('未输入目录');}
  if(choice===5){
    const raw=JSON.parse(fs.readFileSync(active.config,'utf8'));
    console.log(raw.projects.map((p,i)=>(i+1)+'. '+p.name+' — '+p.path).join('\n'));
    const number=await ask('选择要撤销授权的项目编号（不会删除文件）：');
    if(!/^[1-9][0-9]*$/.test(number)||!raw.projects[Number(number)-1])fail('无效项目编号');
    selection=raw.projects[Number(number)-1].id;
    if(raw.projects.length===1)fail('至少保留一个项目，请先添加替代项目。');
  }
  if(choice===7)console.log('仅用于尚未绑定的设备。旧配对码在到期前可能仍有效；请只使用新码。');
  if(await ask('将停止当前 Daemon，请先结束运行中的任务。继续？输入 yes：')!=='yes')return null;
  // Downloaded source intentionally has no node_modules. Resolve management
  // code from the active npm-installed release, BEFORE interrupting the Daemon.
  let management, pairingModules;
  if([4,5,6].includes(choice))management=await import(installedModuleURL(root,active,'manage'));
  if(choice===7)pairingModules={config:await import(installedModuleURL(root,active,'config')),daemon:await import(installedModuleURL(root,active,'daemon'))};
  const wasRunning=await stopForManagement(root,active);
  let removed=false;
  try{
    if(choice===1)return {...options,dir:root};
    if(choice===2){await uninstall(root,true);removed=true;return null;}
    if(choice===3){reinstall({dir:root,yes:true});}
    if(choice===4||choice===5||choice===6){
      const {manage}=management;
      await manage(choice===4?'project-add':choice===5?'project-remove':'agents',active.config,{directory:project,projectId:selection});
    }
    if(choice===7)await regeneratePairing(active.config,pairingModules);
  }finally{
    if(!removed && choice!==1 && (wasRunning||choice===3||choice===6||choice===7)){
      const running=await startBackground(path.join(root,'launch.mjs'),path.join(root,'daemon.log'));
      console.log('Daemon 已在后台启动，PID '+running.pid);
    }
  }
  return null;
}
async function main() {
  let options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(help); return; }
  checkVersion(process.versions.node);
  if(options.menu || !process.argv.slice(2).length){
    if(!process.stdin.isTTY)fail('交互菜单需要终端；自动化请使用 --yes 与明确参数。');
    options=await interactiveMenu(options);if(!options)return;
  }
  if (!options.yes && !options['dry-run']) {
    if (!process.stdin.isTTY) fail('No interactive terminal. Supply explicit fields with --yes or --dry-run.');
    let rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      options.dir = path.resolve(options.dir || path.join(os.homedir(), '.weagent-node'));
      if (!options.config && !options.rollback && !exists(path.join(options.dir, 'active.json')) && !exists(path.join(options.dir, 'config.local.json'))) {
        options.gateway ||= (await rl.question(`Gateway origin [${defaultGateway}]: `)).trim() || defaultGateway;
        if (!options.projects.length) { const p = (await rl.question('Project directory to authorize: ')).trim(); if (p) options.projects.push(p); }
        if (!options.plugins) { rl.close(); options.plugins = (await selectAgents()).join(','); rl = createInterface({ input: process.stdin, output: process.stdout }); }
      }
      const auto = (await rl.question('Auto-start the Daemon at login? (yes/no; Enter keeps the current setting): ')).trim().toLowerCase();
      if (auto === 'y' || auto === 'yes') options.autostart = true;
      else if (auto === 'n' || auto === 'no') options['no-autostart'] = true;
      const plan = install({ ...options, 'dry-run': true }); console.log(JSON.stringify(plan, null, 2));
      if ((await rl.question('Install exactly this scope? Type yes: ')).trim() !== 'yes') { console.log('Cancelled. No changes made.'); return; }
      options.yes = true;
    } finally { rl.close(); }
  }
  const result = install(options); console.log(JSON.stringify(result, null, 2));
  if (!options['dry-run']) {
    const launcher = path.join(result.directory, 'launch.mjs'), logPath = path.join(result.directory, 'daemon.log');
    let startedByManager = false;
    if (options.autostart) {
      const enabled = enableAutostart(result.directory); startedByManager = enabled.startsNow;
      console.log('Auto-start at login: enabled (' + enabled.description + ').');
    } else if (options['no-autostart']) {
      try { const removal = disableAutostart(result.directory); console.log(removal.removed ? 'Auto-start at login: entry removed.' : 'Auto-start at login: no entry present.'); }
      catch (e) { console.error('喵连 installer: could not remove the login entry: ' + e.message); }
    }
    if (options.start && !startedByManager) run(process.execPath, [launcher], { shell: false });
    else if (!startedByManager) {
      const ready = progress('启动后台节点');
      let running;
      try { running = await startBackground(launcher, logPath); ready(true); }
      catch (error) { ready(false); throw error; }
      console.log('Daemon: running in the background (PID ' + running.pid + '); log: ' + logPath);
      if (result.action === 'install') {
        let pairing = null;
        for (const deadline = Date.now() + 12000; !pairing && Date.now() < deadline;) { pairing = readPairingCode(logPath); if (!pairing) await sleep(400); }
        if (pairing) console.log('Pairing code: ' + pairing.code + ' (expires ' + pairing.expiresAt + ') — enter it in the 喵连 app to pair this device.');
        else console.log('Pairing code not observed yet; check the "pairing" line in the log once the Gateway is reachable.');
      }
    } else console.log('Daemon: started by the OS service manager; log: ' + logPath);
    console.log('Stop: node ' + JSON.stringify(launcher) + ' stop');
    console.log('After pairing, keep the full state directory. Never delete it to fix a connection.');
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(e => { console.error('喵连 installer: ' + e.message); process.exitCode = 1; });
