/** Parse only the documented commands. A typo must never start with another config. */
export function parseCLI(args) {
  if (!args.length || args.length === 1 && ['help', '--help'].includes(args[0])) return { command: 'help', configPath: null };
  const [command, ...rest] = args;
  if (['project-add','agents','uninstall'].includes(command)) {
    const result={command,configPath:'config.local.json'};
    for(let i=0;i<rest.length;i++) {
      const item=rest[i];
      if(item==='--config' || command==='agents' && item==='--agents') {
        const value=rest[++i]; if(!value || value.startsWith('--')) throw Error('Missing option value');
        const key=item==='--config'?'configPath':'agents';
        if(result['_'+key]) throw Error('Repeated option'); result['_'+key]=true;result[key]=value;
      } else if(command==='project-add' && !item.startsWith('--') && !result.directory) result.directory=item;
      else if(command==='uninstall' && item==='--yes' && !result.yes) result.yes=true;
      else throw Error('Unknown option: '+item);
    }
    if(command==='project-add' && !result.directory) throw Error('project-add requires a folder path');
    delete result._configPath;delete result._agents;return result;
  }
  if (!['start', 'doctor', 'stop', 'background'].includes(command)) throw Error('Unknown command: ' + command);
  if (!rest.length) return { command, configPath: 'config.local.json' };
  if (rest.length === 1 && rest[0] === '--help') return { command: 'help', configPath: null };
  if (rest.length !== 2 || rest[0] !== '--config' || !rest[1] || rest[1].startsWith('--')) throw Error('Expected exactly: ' + command + ' [--config PATH]');
  return { command, configPath: rest[1] };
}
export function requireRuntime(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[1]) < 24 || Number(match[1]) === 24 && Number(match[2]) < 1) throw Error('Node.js >=24.1.0 is required; current runtime: ' + version);
}
