import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { checkVersion, parseArgs, readInstallFiles, install, marker, launcherSource, autostartSpec, enableAutostart, disableAutostart, startBackground, readPairingCode, uninstall, reinstall, menuChoice, menuItems } from '../scripts/install.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
test('Windows release promotion retries only transient locks and remains bounded', async () => {
  const { renameWithRetry } = await import('../scripts/install.mjs');
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    let calls = 0; const waits = [];
    renameWithRetry('source', 'target', { platform: 'win32', wait: ms => waits.push(ms), rename() { if (++calls < 4) throw Object.assign(new Error('locked'), { code }); } });
    assert.equal(calls, 4); assert.deepEqual(waits, [100, 200, 400]);
  }
  for (const [platform, code, expected] of [['win32', 'EPERM', 13], ['win32', 'ENOSPC', 1], ['linux', 'EPERM', 1]]) {
    let calls = 0;
    assert.throws(() => renameWithRetry('source', 'target', { platform, wait() {}, rename() { calls++; throw Object.assign(new Error('fixture'), { code }); } }), /fixture/);
    assert.equal(calls, expected);
  }
});
test('failed release promotion preserves active release and configuration and permits retry', t => {
  const f = fixture(t); install(f.options, f.deps);
  const active = fs.readFileSync(path.join(f.dir, 'active.json'));
  const config = fs.readFileSync(path.join(f.dir, 'config.local.json'));
  f.modify();
  assert.throws(() => install({ dir: f.dir, yes: true }, { ...f.deps, renameRelease() { throw Object.assign(new Error('fixture locked'), { code: 'EPERM' }); } }), /fixture locked/);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'active.json')), active);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'config.local.json')), config);
  assert.equal(fs.existsSync(path.join(f.dir, 'install.lock')), false);
  assert.equal(fs.readdirSync(path.join(f.dir, 'releases')).some(n => n.startsWith('.staging-')), false);
  install({ dir: f.dir, yes: true }, f.deps);
  assert.notDeepEqual(fs.readFileSync(path.join(f.dir, 'active.json')), active);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'config.local.json')), config);
});
test('downloaded manager resolves only verified active-release modules',async t=>{
 const {installedModuleURL}=await import('../scripts/install.mjs');
 const f=fixture(t);install(f.options,f.deps);const active=JSON.parse(fs.readFileSync(path.join(f.dir,'active.json')));
 const url=installedModuleURL(f.dir,active,'config');assert.ok(url.includes('/releases/'));assert.ok(!url.includes('/source/'));
 await import(url);assert.throws(()=>installedModuleURL(f.dir,{...active,release:'releases/'+'0'.repeat(24)},'config'),/changed/);
 assert.throws(()=>installedModuleURL(f.dir,active,'../outside'),/Unsupported/);
 fs.writeFileSync(path.join(f.dir,active.release,'WeAgent-Node/src/config.mjs'),'changed');assert.throws(()=>installedModuleURL(f.dir,active,'config'),/checksum|modified|integrity/i);
});
test('pairing regeneration refuses bound devices without deleting identity',async t=>{
 const f=fixture(t),result=install(f.options,f.deps);
 const {loadConfig}=await import('../src/config.mjs'),{Daemon}=await import('../src/daemon.mjs');
 const {regeneratePairing}=await import('../scripts/install.mjs');
 const d=new Daemon(loadConfig(result.configuration),{report:()=>{}});d.identity.nodeId='node_bound';d.state.set('identity',d.identity);const key=d.identity.privateKey;await d.close();d.state.close();
 await assert.rejects(regeneratePairing(result.configuration),/ALREADY_PAIRED/);
 const next=new Daemon(loadConfig(result.configuration),{report:()=>{}});assert.equal(next.identity.nodeId,'node_bound');assert.equal(next.identity.privateKey,key);await next.close();next.state.close();
});
test('interactive menu exposes all management choices and rejects invalid input',()=>{
 assert.equal(menuItems.length,7);for(let i=0;i<=7;i++)assert.equal(menuChoice(String(i)),i);
 for(const x of ['','8','-1','1.5','1oops'])assert.throws(()=>menuChoice(x));assert.equal(parseArgs(['--menu']).menu,true);
});
function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'weagent-install-test-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const sourceRoot = path.join(temp, 'source'), dir = path.join(temp, 'private install'), project = path.join(temp, 'project with spaces');
  fs.mkdirSync(project, { recursive: true });
  const files = [
    ['WeAgent-Node/package.json', '{"name":"weagent-node","version":"0.1.0"}'],
    ['WeAgent-Node/package-lock.json', '{"lockfileVersion":3}'],
    ['WeAgent-Node/src/cli.mjs', '// fixture CLI v1\n'],
    ['WeAgent-Node/src/config.mjs', '// fixture config\n'],
    ['WeAgent-Backend/contracts/protocol.schema.json', '{}'],
    ['WeAgent-Backend/contracts/workspace-operations.json', '[]'],
    ['WeAgent-Node/scripts/install.mjs', '// fixture installer']
  ];
  for (const [name, bytes] of files) { const p = path.join(sourceRoot, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); }
  const manifest = { version: 1, files: files.map(([p, b]) => ({ path: p, sha256: hash(b) })) };
  const manifestPath = path.join(sourceRoot, 'WeAgent-Node/install-files.json'); fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const calls = [], deps = { sourceRoot, nodeVersion: '24.1.0', run(command, args, opts) { calls.push({ command, args, opts }); } };
  const options = { dir, gateway: 'https://gateway.example', projects: [project], plugins: 'claude', yes: true };
  return { temp, sourceRoot, dir, project, manifest, manifestPath, calls, deps, options,
    modify() { const p = path.join(sourceRoot, files[2][0]); fs.writeFileSync(p, '// fixture CLI v2'); manifest.files[2].sha256 = hash(fs.readFileSync(p)); fs.writeFileSync(manifestPath, JSON.stringify(manifest)); } };
}
for (const version of ['22.16.0', '24.0.0', '24.1', '24.1.0-rc.1', 'garbage']) test('installer refuses unsupported runtime ' + version, () => assert.throws(() => checkVersion(version), /Node.js/));
for (const version of ['24.1.0', '24.8.1', '25.0.0']) test('installer accepts supported runtime ' + version, () => checkVersion(version));
test('strict installer options preserve paths and reject ambiguous flags', () => {
  assert.deepEqual(parseArgs(['--project', '/a b', '--project', '/c', '--yes']).projects, ['/a b', '/c']);
  for (const args of [['--gateway'], ['--unknown'], ['--yes', '--yes'], ['--config', '/a', '--gateway', 'https://b'], ['--rollback', '--plugins', 'claude'], ['--autostart', '--no-autostart'], ['--start', '--autostart']]) assert.throws(() => parseArgs(args));
  assert.equal(parseArgs(['--rollback', '--autostart', '--yes']).autostart, true);
  assert.equal(parseArgs(['--no-autostart'])['no-autostart'], true);
});
test('dry-run validates scope without creating directories or invoking npm', t => {
  const f = fixture(t), result = install({ ...f.options, 'dry-run': true }, f.deps);
  assert.equal(fs.existsSync(f.dir), false); assert.equal(f.calls.length, 0); assert.equal(result.existingConfiguration, false);
});
test('runtime gate runs before filesystem mutation', t => {
  const f = fixture(t); assert.throws(() => install(f.options, { ...f.deps, nodeVersion: '22.16.0' }), /Node.js/); assert.equal(fs.existsSync(f.dir), false);
});

test('new installations default to the public Gateway while upgrades preserve existing origins', t => {
  const f = fixture(t), options = { ...f.options }; delete options.gateway;
  const result = install(options, f.deps);
  assert.equal(JSON.parse(fs.readFileSync(result.configuration)).gateway, 'https://agent.000.moe');
  const existing = JSON.parse(fs.readFileSync(result.configuration));
  existing.gateway = 'https://private.example';
  fs.writeFileSync(result.configuration, JSON.stringify(existing));
  const before = fs.readFileSync(result.configuration);
  install({ dir: f.dir, yes: true }, f.deps);
  assert.deepEqual(fs.readFileSync(result.configuration), before);
});
test('private first installation validates doctor and uses immutable release layout', t => {
  const f = fixture(t), result = install(f.options, f.deps);
  assert.equal(f.calls.length, 2); assert.ok(f.calls[0].args.includes('--ignore-scripts')); assert.ok(f.calls[0].args.includes('ci'));
  assert.ok(f.calls[1].args.includes('doctor')); assert.equal(f.calls[1].opts.shell, false);
  const config = JSON.parse(fs.readFileSync(result.configuration));
  assert.equal(config.projects[0].path, f.project); assert.equal(config.stateDir, path.join(f.dir, 'state'));
  assert.equal(fs.existsSync(config.stateDir), false, 'installation does not initialize an identity');
  assert.equal(fs.readFileSync(path.join(f.dir, '.weagent-node-install'), 'utf8'), marker);
  // POSIX mode bits do not represent NTFS ACLs; Windows privacy is a host prerequisite.
  if (process.platform !== 'win32') assert.equal(fs.statSync(result.configuration).mode & 0o077, 0);
  assert.equal(fs.readFileSync(path.join(f.dir, 'launch.mjs'), 'utf8'), launcherSource());
});
test('failed npm installation cannot replace active code or mutate configuration/state', t => {
  const f = fixture(t), first = install(f.options, f.deps), config = fs.readFileSync(first.configuration), active = fs.readFileSync(path.join(f.dir, 'active.json'));
  fs.mkdirSync(first.stateDirectory); fs.writeFileSync(path.join(first.stateDirectory, 'state.sqlite'), 'sentinel database'); f.modify();
  assert.throws(() => install({ dir: f.dir, yes: true }, { ...f.deps, run() { throw Error('npm unavailable'); } }), /npm unavailable/);
  assert.deepEqual(fs.readFileSync(first.configuration), config); assert.deepEqual(fs.readFileSync(path.join(f.dir, 'active.json')), active);
  assert.equal(fs.readFileSync(path.join(first.stateDirectory, 'state.sqlite'), 'utf8'), 'sentinel database');
  assert.equal(fs.existsSync(path.join(f.dir, 'install.lock')), false); assert.ok(!fs.readdirSync(path.join(f.dir, 'releases')).some(p => p.startsWith('.staging-')));
});
test('doctor failure cannot activate a first install', t => {
  const f = fixture(t); let n = 0;
  assert.throws(() => install(f.options, { ...f.deps, run() { if (++n === 2) throw Error('Agent unavailable'); } }), /Agent unavailable/);
  assert.equal(fs.existsSync(path.join(f.dir, 'active.json')), false); assert.equal(fs.existsSync(path.join(f.dir, 'config.local.json')), false);
});
test('update and rollback keep exact existing config bytes and journal path', t => {
  const f = fixture(t), first = install(f.options, f.deps), before = fs.readFileSync(first.configuration); f.modify();
  const second = install({ dir: f.dir, yes: true }, f.deps); assert.notEqual(first.release, second.release);
  const back = install({ dir: f.dir, rollback: true, yes: true }, f.deps);
  assert.equal(back.release, first.release); assert.deepEqual(fs.readFileSync(first.configuration), before); assert.equal(back.stateDirectory, first.stateDirectory);
});
test('existing external configuration is not copied or rewritten', t => {
  const f = fixture(t), config = path.join(f.temp, 'external.json');
  const bytes = '{\n "gateway":"https://gateway.example", "stateDir":"outside-state", "projects":[], "plugins":[]\n}\n'; fs.writeFileSync(config, bytes);
  const result = install({ dir: f.dir, config, yes: true }, f.deps);
  assert.equal(result.configuration, config); assert.equal(result.stateDirectory, path.join(f.temp, 'outside-state'));
  assert.equal(fs.readFileSync(config, 'utf8'), bytes); assert.equal(fs.existsSync(path.join(f.dir, 'config.local.json')), false);
});
test('running daemon lock blocks update and is never deleted', t => {
  const f = fixture(t), first = install(f.options, f.deps); fs.mkdirSync(first.stateDirectory); const lock = path.join(first.stateDirectory, 'daemon.lock'); fs.writeFileSync(lock, String(process.pid));
  assert.throws(() => install({ dir: f.dir, yes: true }, f.deps), /Stop the existing/); assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid));
});
test('unmanaged paths and source symlinks are never overwritten', t => {
  const f = fixture(t); fs.mkdirSync(f.dir); fs.writeFileSync(path.join(f.dir, 'keep'), 'private');
  assert.throws(() => install(f.options, f.deps), /not managed/);
  const p = path.join(f.sourceRoot, f.manifest.files[2].path); fs.unlinkSync(p); fs.symlinkSync(path.join(f.dir, 'keep'), p);
  assert.throws(() => readInstallFiles(f.sourceRoot), /symlink/);
});
test('installation validates source checksum, exact casing and path allowlist', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.sourceRoot, f.manifest.files[2].path), 'tampered');
  assert.throws(() => readInstallFiles(f.sourceRoot), /checksum/);
  for (const name of ['../secret', 'WeAgent-Node/.runtime/identity', '/etc/passwd', 'WeAgent-Node/src/../src/cli.mjs', 'WeAgent-Node/node_modules/private']) {
    f.manifest.files[2].path = name; fs.writeFileSync(f.manifestPath, JSON.stringify(f.manifest)); assert.throws(() => readInstallFiles(f.sourceRoot));
  }
});
test('installer never stores credentials in a Gateway origin', t => {
  const f = fixture(t);
  for (const gateway of ['http://remote.example', 'https://user:password@example.org', 'https://example.org/api', 'https://example.org/?token=x']) assert.throws(() => install({ ...f.options, gateway, 'dry-run': true }, f.deps));
  assert.equal(fs.existsSync(f.dir), false);
});
test('shell wrappers forward arguments instead of evaluating user paths', () => {
  const sh = fs.readFileSync(new URL('../install.sh', import.meta.url), 'utf8'), ps = fs.readFileSync(new URL('../install.ps1', import.meta.url), 'utf8');
  assert.ok(sh.includes('"$@"')); assert.ok(ps.includes('@args')); assert.doesNotMatch(sh + ps, /curl|Invoke-Expression|Set-ExecutionPolicy/);
});

test('PowerShell wrapper selects one Node and preserves arguments and exit status', { skip: process.platform !== 'win32' }, t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'golink wrapper '));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  fs.mkdirSync(path.join(directory,'scripts'));
  fs.copyFileSync(new URL('../install.ps1',import.meta.url),path.join(directory,'install.ps1'));
  // Run only a disposable entry point; never install or launch a real daemon.
  fs.writeFileSync(path.join(directory,'scripts/install.mjs'),'console.log(JSON.stringify(process.argv.slice(2))); process.exit(7);');
  const quote=value=>"'"+value.replaceAll("'","''")+"'";
  const runner=path.join(directory,'runner.ps1');
  fs.writeFileSync(runner,`function Get-Command {\n[pscustomobject]@{ Source = ${quote(process.execPath)} }\n[pscustomobject]@{ Source = 'C:\\must-not-run\\node.exe' }\n}\n& ${quote(path.join(directory,'install.ps1'))} @args\nexit $LASTEXITCODE\n`);
  const args=['--config',path.join(directory,"user's config.json"),'--start'];
  const result=spawnSync('powershell.exe',['-NoProfile','-File',runner,...args],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.ifError(result.error);
  assert.equal(result.status,7,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()),args);
});
test('updating never silently ignores requested configuration changes', t => {
  const f = fixture(t); install(f.options, f.deps);
  assert.throws(() => install({ dir: f.dir, gateway: 'https://other.example', yes: true }, f.deps), /preserved/);
});
test('reusing an installed release rechecks source and doctor without reinstalling', t => {
  const f = fixture(t); const first = install(f.options, f.deps); f.calls.length = 0;
  install({ dir: f.dir, yes: true }, f.deps); assert.equal(f.calls.length, 1); assert.ok(f.calls[0].args.includes('doctor'));
  fs.writeFileSync(path.join(f.dir, first.release, 'WeAgent-Node/src/cli.mjs'), '// changed');
  assert.throws(() => install({ dir: f.dir, yes: true }, f.deps), /checksum/);
});
test('rollback refuses a modified older source release and retains active pointer', t => {
  const f = fixture(t); const first = install(f.options, f.deps); f.modify(); install({ dir: f.dir, yes: true }, f.deps);
  const before = fs.readFileSync(path.join(f.dir, 'active.json'));
  fs.writeFileSync(path.join(f.dir, first.release, 'WeAgent-Node/src/cli.mjs'), 'modified old code');
  assert.throws(() => install({ dir: f.dir, yes: true, rollback: true }, f.deps), /checksum/);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'active.json')), before);
});
test('release directory and management marker cannot redirect through symlinks', t => {
  const f = fixture(t); fs.mkdirSync(f.dir, { mode: 0o700 });
  const real = path.join(f.temp, 'marker'); fs.writeFileSync(real, marker); fs.symlinkSync(real, path.join(f.dir, '.weagent-node-install'));
  assert.throws(() => install(f.options, f.deps), /links/);
  fs.unlinkSync(path.join(f.dir, '.weagent-node-install')); fs.writeFileSync(path.join(f.dir, '.weagent-node-install'), marker);
  const elsewhere = path.join(f.temp, 'outside'); fs.mkdirSync(elsewhere); fs.symlinkSync(elsewhere, path.join(f.dir, 'releases'));
  assert.throws(() => install(f.options, f.deps), /links/); assert.deepEqual(fs.readdirSync(elsewhere), []);
});
test('installer keeps its code and private data outside project authorization', t => {
  const f = fixture(t); const dir = path.join(f.project, '.install');
  assert.throws(() => install({ ...f.options, dir }, f.deps), /authorized project/); assert.equal(fs.existsSync(dir), false);
});
test('concurrent install lock is retained rather than guessed stale or deleted', t => {
  const f = fixture(t); install(f.options, f.deps); const lock = path.join(f.dir, 'install.lock'); fs.writeFileSync(lock, '1');
  assert.throws(() => install({ dir: f.dir, yes: true }, f.deps), /Another installation/); assert.equal(fs.readFileSync(lock, 'utf8'), '1');
});
test('a stale lock left by a dead Daemon no longer blocks updates', async t => {
  const f = fixture(t); const first = install(f.options, f.deps); f.modify();
  fs.mkdirSync(path.join(f.dir, 'state'), { recursive: true });
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }); const pid = child.pid;
  await once(child, 'exit');
  fs.writeFileSync(path.join(f.dir, 'state', 'daemon.lock'), String(pid));
  const second = install({ dir: f.dir, yes: true }, f.deps);
  assert.notEqual(second.release, first.release);
  assert.equal(fs.readFileSync(path.join(f.dir, 'state', 'daemon.lock'), 'utf8'), String(pid), 'installer never deletes the lock');
});
test('plan reports the auto-start decision without side effects', t => {
  const f = fixture(t);
  assert.equal(install({ ...f.options, autostart: true, 'dry-run': true }, f.deps).autostart, 'enable');
  assert.equal(install({ ...f.options, 'no-autostart': true, 'dry-run': true }, f.deps).autostart, 'disable');
  assert.equal(install({ ...f.options, 'dry-run': true }, f.deps).autostart, null);
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.dir), false);
});
test('windows auto-start writes a hidden helper and registers the per-user Run key', t => {
  const f = fixture(t); install(f.options, f.deps); const calls = [];
  const result = enableAutostart(f.dir, { platform: 'win32', nodePath: 'C:\\Program Files\\nodejs\\node.exe', execute(command, args, opts) { calls.push({ command, args, opts }); } });
  assert.equal(result.startsNow, false);
  const vbs = path.join(f.dir, 'launch-hidden.vbs'), text = fs.readFileSync(vbs, 'utf8');
  assert.match(text, /WScript\.Shell/); assert.match(text, /daemon\.log/); assert.match(text, /node\.exe/);
  assert.equal(calls.length, 1); assert.equal(calls[0].command, 'reg.exe'); assert.equal(calls[0].opts.shell, false);
  assert.deepEqual(calls[0].args.slice(0, 2), ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run']);
  assert.equal(calls[0].args[calls[0].args.indexOf('/d') + 1], 'wscript.exe "' + vbs + '"');
  assert.equal(calls[0].args.at(-1), '/f');
});
test('macOS auto-start installs a LaunchAgent that starts immediately', t => {
  const f = fixture(t); install(f.options, f.deps); const home = path.join(f.temp, 'home'); const calls = [];
  const result = enableAutostart(f.dir, { platform: 'darwin', nodePath: '/usr/local/bin/node', home, execute(command, args) { calls.push([command, args]); } });
  assert.equal(result.startsNow, true);
  const plist = path.join(home, 'Library', 'LaunchAgents', 'moe.000.golink.node.plist'), text = fs.readFileSync(plist, 'utf8');
  assert.match(text, /<key>RunAtLoad<\/key><true\/>/); assert.match(text, /launch\.mjs/); assert.match(text, /daemon\.log/);
  assert.ok(calls.some(c => c[0] === 'launchctl' && c[1][0] === 'load' && c[1][1] === plist));
});
test('launchd and unit sources escape untrusted path characters', () => {
  const home = '/h', root = '/r with & <tag>', nodePath = '/n&b/node';
  assert.match(autostartSpec('darwin', root, nodePath, home).plistSource, /\/n&amp;b\/node/);
  assert.doesNotMatch(autostartSpec('darwin', root, nodePath, home).plistSource, /<string>\/n&b/);
  // path separators are host-normalized; the untrusted characters must survive quoting verbatim.
  assert.match(autostartSpec('linux', root, nodePath, home).unitSource, /ExecStart="[^"]*&[^"]*" "[^"]*<tag>[^"]*"/);
});
test('linux auto-start enables a systemd user unit and starts now', t => {
  const f = fixture(t); install(f.options, f.deps); const home = path.join(f.temp, 'home'); const calls = [];
  const result = enableAutostart(f.dir, { platform: 'linux', nodePath: '/usr/bin/node', home, execute(command, args) { calls.push([command, args]); } });
  assert.equal(result.startsNow, true);
  const unit = path.join(home, '.config', 'systemd', 'user', 'golink-node.service'), text = fs.readFileSync(unit, 'utf8');
  assert.match(text, /ExecStart="\/usr\/bin\/node" ".*launch\.mjs"/); assert.match(text, /WantedBy=default\.target/);
  assert.ok(calls.some(c => c[0] === 'systemctl' && c[1].join(' ') === '--user enable --now golink-node'));
  assert.ok(calls.some(c => c[0] === 'systemctl' && c[1].join(' ') === '--user daemon-reload'));
});
test('disabling auto-start removes the entry only when it is present', t => {
  const f = fixture(t); install(f.options, f.deps); const calls = [];
  const deps = { platform: 'win32', execute(command, args) { calls.push([command, args]); } };
  assert.equal(disableAutostart(f.dir, { ...deps, probe: () => false }).removed, false);
  assert.equal(calls.length, 0);
  assert.equal(disableAutostart(f.dir, { ...deps, probe: () => true }).removed, true);
  assert.deepEqual(calls[0], ['reg.exe', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'GoLinkNode', '/f']]);
});

for (const kind of ['healthy','exit','no-lock']) test('background startup confirms actual daemon: '+kind, async t => {
  const f=fixture(t);const installed=install(f.options,f.deps);
  const cli=path.join(f.dir,installed.release,'WeAgent-Node/src/cli.mjs');
  const lock=path.join(installed.stateDirectory,'daemon.lock');
  fs.mkdirSync(installed.stateDirectory,{recursive:true});
  fs.writeFileSync(cli,kind==='exit'?'process.exit(7);':
    "import fs from 'node:fs';"+(kind==='healthy'?"fs.writeFileSync("+JSON.stringify(lock)+",String(process.pid));":"")+"setInterval(()=>{},1000);");
  const launcher=path.join(f.dir,'launch.mjs'),log=path.join(f.dir,'daemon.log');
  if(kind==='healthy'){
    let child;const running=await startBackground(launcher,log,{timeout:3000,stableMs:200,spawnFn:(...args)=>(child=spawn(...args))});
    try{assert.equal(Number(fs.readFileSync(lock,'utf8')),running.pid);process.kill(running.pid,0);}
    finally{child.ref();const closed=once(child,'close');child.kill();await closed;}
  }else await assert.rejects(startBackground(launcher,log,{timeout:500,stableMs:200}),/startup|exited/);
});

test('pairing code is parsed from the newest daemon log line', t => {
  const f = fixture(t); const log = path.join(f.temp, 'daemon.log');
  fs.writeFileSync(log, '{"event":"retry","code":"SERVICE_UNAVAILABLE"}\nnot json\n{"event":"pairing","code":"ABCD-1234","expiresAt":"2026-09-08T12:00:00Z"}\n');
  assert.deepEqual(readPairingCode(log), { code: 'ABCD-1234', expiresAt: '2026-09-08T12:00:00Z' });
  assert.equal(readPairingCode(path.join(f.temp, 'missing.log')), null);
});
test('managed launcher forwards stop against the active configuration', () => {
  assert.ok(launcherSource().includes("forward.includes('--config')||forward.some(x=>x==='help'||x==='--help')?[]:['--config',active.config]"));
});

test('uninstall requires confirmation, preserves state, and supports reinstall',async t=>{
 const f=fixture(t),result=install(f.options,f.deps),state=path.join(f.dir,'state');fs.mkdirSync(state);fs.writeFileSync(path.join(state,'identity'),'keep');
 const before=fs.readFileSync(result.configuration);await assert.rejects(uninstall(f.dir,false),/--yes/);assert.ok(fs.existsSync(path.join(f.dir,'launch.mjs')));
 const cwd=process.cwd();let disabled=false;
 try{await uninstall(f.dir,true,{disableAutostart(){disabled=true;}});}finally{process.chdir(cwd);}
 assert.equal(disabled,true);assert.equal(fs.existsSync(path.join(f.dir,'active.json')),false);assert.deepEqual(fs.readFileSync(result.configuration),before);assert.equal(fs.readFileSync(path.join(state,'identity'),'utf8'),'keep');
 install({dir:f.dir,yes:true},f.deps);assert.ok(fs.existsSync(path.join(f.dir,'launch.mjs')));assert.deepEqual(fs.readFileSync(result.configuration),before);
});
test('reinstall rebuilds the same release and rolls back a failed dependency install',t=>{
 const f=fixture(t),initial=install(f.options,f.deps),config=fs.readFileSync(initial.configuration);
 const target=path.join(f.dir,initial.release),cli=path.join(target,'WeAgent-Node/src/cli.mjs');
 fs.writeFileSync(cli,'broken fixture');
 assert.throws(()=>reinstall({dir:f.dir}, {...f.deps,run(){throw Error('npm failed');}}),/npm failed/);
 assert.equal(fs.readFileSync(cli,'utf8'),'broken fixture');assert.deepEqual(fs.readFileSync(initial.configuration),config);
 reinstall({dir:f.dir},f.deps);assert.equal(fs.readFileSync(cli,'utf8'),'// fixture CLI v1\n');assert.deepEqual(fs.readFileSync(initial.configuration),config);
});

test('elevated stop is scoped to recorded PID, exact node executable and managed launcher',async()=>{
 const {elevatedStopScript}=await import('../scripts/install.mjs');
 const source=elevatedStopScript("C:\\fixture's root","C:\\state\\daemon.lock",4321,'C:\\Node\\node.exe');
 assert.match(source,/ProcessId=4321/);assert.match(source,/Stop-Process -Id 4321/);assert.match(source,/ExecutablePath -ine/);assert.match(source,/CommandLine.Contains/);assert.match(source,/fixture''s root/);assert.match(source,/Daemon identity changed/);
 assert.doesNotMatch(source,/Remove-Item|taskkill|Stop-Process -Name/);
 assert.throws(()=>elevatedStopScript('x','y',0),/Invalid/);
});
