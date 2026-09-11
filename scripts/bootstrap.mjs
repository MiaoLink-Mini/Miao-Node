#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Replaced by build-download.mjs. The versioned bundle cannot change silently.
const bundleHash = '__BUNDLE_SHA256__';
// Standalone entry point: no local modules exist until the bundle is verified.
/* __INSTALL_PROGRESS__ */
async function main() {
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major<24 || major===24 && minor<1) throw Error('Install Node.js >=24.1 and npm first.');
  console.log('\n  喵连 Node Installer\n');
  const downloaded=progress('下载 喵连 Node');
  let bytes;
  try {
  const response=await fetch('https://agent.000.moe/downloads/node/'+bundleHash+'.json',{signal:AbortSignal.timeout(120000),redirect:'error'});
  if(!response.ok) throw Error('Download failed: HTTP '+response.status);
  bytes=Buffer.from(await response.arrayBuffer());
  downloaded(true);
  } catch(error) {downloaded(false);throw error;}
  if(bytes.length>20*1024*1024 || createHash('sha256').update(bytes).digest('hex')!==bundleHash) throw Error('Invalid download checksum');
  const bundle=JSON.parse(bytes), names=new Set();
  if(bundle.version!==1 || !Array.isArray(bundle.files)) throw Error('Invalid bundle');
  console.log('  [OK] 安装包 SHA-256 校验');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'golink-download-'));
  try {
    for(const file of bundle.files) {
      if(typeof file.path!=='string' || !/^(WeAgent-Node|WeAgent-Backend)\/[A-Za-z0-9_./-]+$/.test(file.path) || file.path.split('/').some(x=>!x || x==='.' || x==='..') || names.has(file.path)) throw Error('Unsafe bundle path');
      names.add(file.path);
      const data=Buffer.from(file.content,'base64');
      if(createHash('sha256').update(data).digest('hex')!==file.sha256) throw Error('Invalid file checksum');
      const target=path.join(root,file.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,data,{flag:'wx',mode:0o600});
    }
    console.log('  [OK] 解包与文件校验\n');
    const result=spawnSync(process.execPath,[path.join(root,'WeAgent-Node/scripts/install.mjs'),...process.argv.slice(2)],{stdio:'inherit',shell:false,windowsHide:true});
    if(result.error) throw result.error;
    process.exitCode=result.status ?? 1;
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
main().catch(e=>{console.error('喵连: '+e.message);process.exitCode=1;});
