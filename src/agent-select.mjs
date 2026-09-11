import { emitKeypressEvents } from 'node:readline';

export const agentTypes = ['codex', 'claude', 'pi'];
export function parseAgents(value) {
  const values = value.split(',');
  if (!values.length || values.some(x => !agentTypes.includes(x)) || new Set(values).size !== values.length) throw Error('Choose distinct Agents: codex,claude,pi');
  return values;
}
export function selectAgents(initial = [], input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !input.setRawMode) throw Error('Interactive terminal required; use --agents codex,claude,pi');
  return new Promise((resolve, reject) => {
    const chosen = new Set(initial); let cursor = 0;
    const raw = input.isRaw;
    const draw = () => output.write('\r\x1b[2K' + agentTypes.map((x,i) => `${i===cursor?'>':' '}[${chosen.has(x)?'x':' '}] ${x}`).join('  '));
    const done = (error) => { input.removeListener('keypress', keypress); input.setRawMode(raw); input.pause(); output.write('\n'); error ? reject(error) : resolve(agentTypes.filter(x => chosen.has(x))); };
    const keypress = (_, key = {}) => {
      if (key.ctrl && key.name === 'c' || key.name === 'escape') return done(Error('Cancelled'));
      if (['left','up'].includes(key.name)) cursor = (cursor + 2) % 3;
      if (['right','down','tab'].includes(key.name)) cursor = (cursor + 1) % 3;
      if (key.name === 'space') chosen.has(agentTypes[cursor]) ? chosen.delete(agentTypes[cursor]) : chosen.add(agentTypes[cursor]);
      if (key.name === 'return' && chosen.size) return done();
      draw();
    };
    output.write('Agents: arrows move, Space selects, Enter confirms (at least one).\n');
    emitKeypressEvents(input); input.setRawMode(true); input.resume(); input.on('keypress', keypress); draw();
  });
}
