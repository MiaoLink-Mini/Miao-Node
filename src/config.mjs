import { readFileSync, realpathSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { homedir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CodexPlugin } from './plugins/codex.mjs';
import { PiPlugin } from './plugins/pi.mjs';
import { ClaudePlugin } from './plugins/claude.mjs';
import { capabilities, failure } from './common.mjs';

export const plugins = { codex: CodexPlugin, pi: PiPlugin, claude: ClaudePlugin };
const names = { codex: 'Codex', pi: 'Pi', claude: 'Claude Code' };
const exec = promisify(execFile);
export function loadConfig(path) {
  const base = dirname(resolve(path)), raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw new Error('Configuration must be an object');
  const url = new URL(raw.gateway);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['http:', 'https:'].includes(url.protocol)) throw new Error('Gateway 必须为不含凭证的 HTTP(S) origin');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('非回环地址必须使用 HTTPS');
  if (!Array.isArray(raw.projects) || !raw.projects.length || raw.projects.length > 100) throw new Error('请配置 1–100 个本机项目白名单');
  const projects = raw.projects.map(p => {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(p.id) || typeof p.name !== 'string' || !p.name || p.name.length > 100) throw new Error('项目 id/name 无效');
    const path = realpathSync(resolve(base, p.path)); if (!statSync(path).isDirectory()) throw new Error('项目不是目录');
    return { id: p.id, name: p.name, path, description: String(p.description ?? '').slice(0, 500) };
  });
  if (new Set(projects.map(p => p.id)).size !== projects.length) throw new Error('项目 ID 重复');
  const entries = raw.plugins ?? Object.keys(plugins).map(type => ({ type }));
  if (!Array.isArray(entries) || entries.some(p => !p || Array.isArray(p) || typeof p !== 'object' || typeof p.type !== 'string' || !Object.hasOwn(plugins, p.type) || p.enabled !== undefined && typeof p.enabled !== 'boolean')) throw new Error('Invalid built-in plugin configuration');
  const profiles = entries.filter(p => p.enabled !== false).map(p => {
    if (!Object.hasOwn(plugins, p.type)) throw new Error('只允许 codex/pi/claude 内置适配器');
    if (p.command !== undefined && (typeof p.command !== 'string' || !p.command || !isAbsolute(p.command))) throw new Error('自定义 executable 必须为绝对路径');
    if (p.command && /\.(cmd|bat|ps1)$/i.test(p.command)) throw new Error('不能使用 shell 包装脚本；请指定 exe 或 node.exe + JS 入口');
    if (p.args !== undefined && (!Array.isArray(p.args) || p.args.some(x => typeof x !== 'string' || x.includes('\0')))) throw new Error('args 必须为字符串数组');
    if (p.type === 'claude' && p.args?.length) throw new Error('Claude SDK executable 不接受自定义启动参数');
    if (p.model !== undefined && (typeof p.model !== 'string' || !p.model || p.model.length > 160)) throw new Error('model 无效');
    if (p.maxBudgetUsd !== undefined && (!Number.isFinite(p.maxBudgetUsd) || p.maxBudgetUsd <= 0)) throw new Error('maxBudgetUsd 必须为正数');
    return { ...p, workspacePolicy: workspacePolicy(p.workspacePolicy), id: `agent_${p.type}`, name: names[p.type] };
  });
  if (!profiles.length || new Set(profiles.map(p => p.type)).size !== profiles.length) throw new Error('至少启用一个插件，且每种插件只允许一个配置');
  const maxSessions = raw.maxSessions ?? 8;
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 32) throw new Error('maxSessions 必须为 1–32');
  if (raw.stateDir !== undefined && (typeof raw.stateDir !== 'string' || !raw.stateDir)) throw new Error('stateDir must be a nonempty path');
  return { gateway: url.origin, name: String(raw.name ?? hostname()).slice(0, 80), stateDir: resolve(base, raw.stateDir ?? '.runtime/state'), projects, profiles, maxSessions };
}

export function discoverCommand(type) {
  if (type === 'claude') {
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    const candidate = fileURLToPath(new URL(`../node_modules/${pkg}/${process.platform === 'win32' ? 'claude.exe' : 'claude'}`, import.meta.url));
    if (existsSync(candidate)) return { command: candidate, args: [] };
    return null;
  }
  const roots = [process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules'), '/usr/local/lib/node_modules', '/usr/lib/node_modules', join(homedir(), '.npm-global/lib/node_modules')].filter(Boolean);
  const tail = type === 'codex' ? '@openai/codex/bin/codex.js' : '@earendil-works/pi-coding-agent/dist/bundle/cli.js';
  for (const root of roots) if (existsSync(join(root, tail))) return { command: process.execPath, args: [join(root, tail)] };
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!isAbsolute(dir)) continue;
    const path = join(dir, type + (process.platform === 'win32' ? '.exe' : ''));
    if (existsSync(path) && statSync(path).isFile()) return { command: path, args: [] };
  }
  return null;
}

export async function discover(profile) {
  const executable = profile.command ? { command: profile.command, args: profile.args ?? [] } : discoverCommand(profile.type);
  const result = { ...profile, executable, state: 'unavailable', version: null, capabilities: capabilities(Object.fromEntries(Object.keys(capabilities()).map(k => [k, false]))), capabilityRevision: 1, adapterVersion: '0.1.0', diagnostic: { code: 'EXECUTABLE_NOT_FOUND', phase: 'discovery' }, checks: { version: 'not_checked', authentication: 'not_checked', protocol: 'not_checked' } };
  if (!executable) return result;
  try {
    const { stdout } = await exec(executable.command, [...executable.args, '--version'], { windowsHide: true, shell: false, timeout: 10000, maxBuffer: 16384 });
    const version = stdout.match(/\d+\.\d+\.\d+/)?.[0];
    if (!version) throw failure('VERSION_UNRECOGNIZED', 'unrecognized version');
    result.version = version;
    const [major, minor] = version.split('.').map(Number);
    if (profile.type === 'pi' && major === 0 && minor < 85 || profile.type === 'codex' && major === 0 && minor < 153) throw failure('VERSION_UNSUPPORTED', 'unsupported version');
    result.version = version; result.state = 'ready'; result.capabilities = {...plugins[profile.type].capabilities,workspaceSections:(new plugins[profile.type]({}).workspaceSections??[]).map(([kind])=>kind)};
    result.diagnostic = null; result.checks.version = 'passed';
  } catch (error) {
    result.state = 'error'; result.checks.version = 'failed';
    const versionError = ['VERSION_UNSUPPORTED', 'VERSION_UNRECOGNIZED'].includes(error.code);
    const code = versionError ? error.code : error.code === 'ENOENT' ? 'EXECUTABLE_NOT_FOUND' : error.killed ? 'EXECUTABLE_TIMEOUT' : 'EXECUTABLE_START_FAILED';
    result.diagnostic = { code, phase: versionError ? 'version' : 'startup' };
  }
  return result;
}

export function makePlugin(profile, context) {
  if (profile.state !== 'ready') throw failure('SERVICE_UNAVAILABLE', '此 Agent 未就绪，请运行本机 doctor');
  return new plugins[profile.type]({ ...profile.executable, model: profile.model, maxBudgetUsd: profile.maxBudgetUsd, workspacePolicy: profile.workspacePolicy ?? {}, ...context });
}

export function workspacePolicy(value = {}) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('workspacePolicy must be an object');
  const allowed = new Set(['persistHistory','enableNativeResources','allowNativeSettingsWrite','settingSources','skills','mcpServers']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error('Unknown workspacePolicy field: ' + key);
  for (const key of ['persistHistory','enableNativeResources','allowNativeSettingsWrite']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error(key + ' must be boolean');
  if (value.settingSources !== undefined && (!Array.isArray(value.settingSources) || value.settingSources.some(x => !['user','project','local'].includes(x)))) throw new Error('settingSources must be explicit native scopes');
  if (value.skills !== undefined && (!Array.isArray(value.skills) || value.skills.length > 100 || value.skills.some(x => typeof x !== 'string' || !x || x.length > 200))) throw new Error('skills must contain exact native names');
  if (value.mcpServers !== undefined && (!value.mcpServers || Array.isArray(value.mcpServers) || typeof value.mcpServers !== 'object' || Object.keys(value.mcpServers).length > 20)) throw new Error('mcpServers must be a bounded host allowlist');
  return { persistHistory: true, enableNativeResources: false, allowNativeSettingsWrite: false, ...value };
}
