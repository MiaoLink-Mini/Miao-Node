import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseCLI, requireRuntime } from './cli-options.mjs';

try {
  const options = parseCLI(process.argv.slice(2));
  const { command, configPath: path } = options;
  if (command === 'help') {
    process.stdout.write('  background (managed launcher)\n  project-add FOLDER [--config PATH]\n  agents [--agents codex,claude,pi] [--config PATH]\n  uninstall --yes (managed launcher; stop first; retains identity/history)\n');
    process.stdout.write('喵连 Node\n  node src/cli.mjs doctor --config config.local.json\n  node src/cli.mjs start --config config.local.json\n  node src/cli.mjs stop --config config.local.json\n复制 config.example.json 后检查 Gateway、项目白名单和启用的插件。\n');
  } else {
    requireRuntime(process.versions.node);
    const { loadConfig, discover } = await import('./config.mjs');
    if (!path || !existsSync(path)) throw new Error('缺少配置；请复制 config.example.json 为 config.local.json 并检查项目路径');
    const config = loadConfig(resolve(path));
    if (['project-add','agents'].includes(command)) {
      const { manage } = await import('./manage.mjs'); await manage(command,path,options);
    } else if (command === 'background') {
      const root=process.env.GOLINK_INSTALL_ROOT;
      if(!root) throw Error('Use the managed launch.mjs for background startup');
      const {startBackground}=await import('../scripts/install.mjs');
      const result=await startBackground(join(root,'launch.mjs'),join(root,'daemon.log'));
      console.log('Daemon running in background (PID '+result.pid+')');
    } else if (command === 'uninstall') {
      const { uninstall } = await import('../scripts/install.mjs');
      await uninstall(process.env.GOLINK_INSTALL_ROOT, options.yes);
    } else if (command === 'doctor') {
      const profiles = await Promise.all(config.profiles.map(discover));
      process.stdout.write(JSON.stringify({ gateway: config.gateway, projects: config.projects.map(p => ({ id: p.id, name: p.name })), agents: profiles.map(p => ({ id: p.id, state: p.state, version: p.version, diagnostic: p.diagnostic, checks: p.checks, capabilities: p.capabilities })) }, null, 2) + '\n');
      if (profiles.some(p => p.state !== 'ready')) process.exitCode = 1;
    } else if (command === 'stop') {
      // Stop the daemon that owns the state lock. Windows ends the process forcefully;
      // a leftover lock from a dead owner is cleaned by the Daemon itself on next start.
      const lock = join(config.stateDir, 'daemon.lock');
      if (!existsSync(lock)) process.stdout.write('喵连 Node: 未在运行\n');
      else {
        const pid = Number(readFileSync(lock, 'utf8'));
        let alive = Number.isInteger(pid) && pid > 0;
        if (alive) try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        if (!alive) process.stdout.write('喵连 Node: 未在运行（残留状态锁将由下次启动自动清理）\n');
        else { process.kill(pid); process.stdout.write(`喵连 Node: 已停止守护进程 (PID ${pid})\n`); }
      }
    } else {
      const { Daemon } = await import('./daemon.mjs');
      const daemon = new Daemon(config);
      const stop = () => { void daemon.close(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try { await daemon.run(); }
      finally { await daemon.close(); daemon.state.close(); }
      if (daemon.poisoned) process.exitCode = 1;
    }
  }
} catch (error) { if (['project-add','agents','uninstall'].includes(process.argv[2])) process.stderr.write(error.message+'\n'); process.stderr.write(`喵连 Node: 错误码：${error.code ?? 'CONFIG_ERROR'} — 操作失败，请检查本机配置或连接状态\n`); process.exitCode = 1; }
