import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.mjs';
import { agentTypes, parseAgents, selectAgents } from './agent-select.mjs';

export function assertStopped(config) {
  const lock = path.join(config.stateDir, 'daemon.lock');
  if (!fs.existsSync(lock)) return;
  const pid = Number(fs.readFileSync(lock, 'utf8'));
  if (!Number.isInteger(pid) || pid <= 0) throw Error('Invalid state lock; inspect it before editing configuration');
  try { process.kill(pid, 0); } catch(e) { if (e.code === 'ESRCH') return; throw e; }
  throw Error('Stop the Daemon first: node ~/.weagent-node/launch.mjs stop. Configuration and identity were not changed.');
}
export function addProject(raw, directory, base) {
  const actual = fs.realpathSync(path.resolve(directory));
  if (!fs.statSync(actual).isDirectory() || actual === path.parse(actual).root || actual === fs.realpathSync(os.homedir())) throw Error('Select a project folder, not a drive or home directory');
  if (raw.projects.some(p => fs.realpathSync(path.resolve(base,p.path)) === actual)) throw Error('Project folder already authorized');
  if (raw.projects.length >= 100) throw Error('At most 100 projects');
  return {...raw, projects:[...raw.projects,{id:'project_'+randomUUID().replaceAll('-',''),name:path.basename(actual).slice(0,100),path:actual,description:''}]};
}
export function setAgents(raw, selected) {
  parseAgents(selected.join(','));
  const entries = raw.plugins ?? agentTypes.map(type => ({type}));
  return {...raw, plugins:[...entries.map(p => ({...p,enabled:selected.includes(p.type)})), ...selected.filter(type => !entries.some(p => p.type === type)).map(type => ({type,enabled:true,...(type==='claude'?{maxBudgetUsd:2}:{})}))]};
}
export function removeProject(raw, projectId) {
  if(!raw.projects.some(p=>p.id===projectId)) throw Error('Project not found');
  if(raw.projects.length===1) throw Error('Keep at least one authorized project; add another folder first');
  return {...raw,projects:raw.projects.filter(p=>p.id!==projectId)};
}
export async function manage(command, filename, options) {
  const file = path.resolve(filename), before = fs.readFileSync(file,'utf8');
  if (fs.lstatSync(file).isSymbolicLink()) throw Error('Configuration symlinks are not supported');
  assertStopped(loadConfig(file));
  let raw = JSON.parse(before);
  if (command === 'project-add') raw = addProject(raw, path.resolve(process.env.GOLINK_CALLER_CWD || process.cwd(),options.directory), path.dirname(file));
  else if(command==='project-remove') raw=removeProject(raw,options.projectId);
  else raw = setAgents(raw, options.agents ? parseAgents(options.agents) : await selectAgents((raw.plugins ?? agentTypes.map(type => ({type}))).filter(p=>p.enabled!==false).map(p=>p.type)));
  const temp = file+'.'+randomUUID()+'.tmp';
  try {
    fs.writeFileSync(temp,JSON.stringify(raw,null,2)+'\n',{flag:'wx',mode:0o600});
    loadConfig(temp); assertStopped(loadConfig(file));
    if (fs.readFileSync(file,'utf8') !== before) throw Error('Configuration changed concurrently; retry');
    fs.copyFileSync(file,file+'.bak'); fs.chmodSync(file+'.bak',0o600);
    fs.renameSync(temp,file);
  } finally { if(fs.existsSync(temp)) fs.unlinkSync(temp); }
  console.log('Saved. Restart the Daemon to sync. Pairing identity and history preserved; backup: '+file+'.bak');
}
