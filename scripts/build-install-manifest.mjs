/** Explicit installer inventory derived only from the reviewed release whitelist. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
if (process.argv.length > 3 || process.argv[2] && process.argv[2] !== '--check') throw Error('Usage: node scripts/build-install-manifest.mjs [--check]');
const exact = new Set(['WeAgent-Node/scripts/install.mjs','WeAgent-Node/package.json','WeAgent-Node/package-lock.json',
  'WeAgent-Backend/contracts/protocol.schema.json','WeAgent-Backend/contracts/workspace-operations.json']);
const release = JSON.parse(fs.readFileSync(path.join(root,'release-files.json'),'utf8'));
const names = release.files.filter(name => exact.has(name) || name.startsWith('WeAgent-Node/src/') || name.startsWith('WeAgent-Node/plugins/')).sort();
if (new Set(names).size !== names.length) throw Error('Duplicate release path');
const files = names.map(name => {
  let current = root;
  for (const part of name.split('/')) {
    if (!fs.readdirSync(current).includes(part)) throw Error('Exact source path missing: ' + name);
    current = path.join(current,part);
    if (fs.lstatSync(current).isSymbolicLink()) throw Error('Source symlink: '+name);
  }
  if (!fs.statSync(current).isFile()) throw Error('Not a source file: '+name);
  return {path:name,sha256:createHash('sha256').update(fs.readFileSync(current)).digest('hex')};
});
for (const required of [...exact,'WeAgent-Node/src/cli.mjs','WeAgent-Node/src/config.mjs','WeAgent-Node/src/cli-options.mjs']) if (!names.includes(required)) throw Error('Missing reviewed installation source: '+required);
const text=JSON.stringify({version:1,files},null,2)+'\n';
const output=path.join(root,'WeAgent-Node/install-files.json');
if (process.argv[2]==='--check') {
  if (fs.readFileSync(output,'utf8')!==text) throw Error('Installation manifest is stale. Review source changes and rebuild it.');
  console.log('Installation manifest verified:',files.length,'source files');
} else { fs.writeFileSync(output,text); console.log('Installation manifest generated:',files.length,'source files'); }
