import { isAbsolute } from 'node:path';
import { questions } from '../plugins/base.mjs';
import { failure } from '../common.mjs';

// Unknown or newer entries-based profiles fail closed; no path is decoded from a phone ID.
export async function permissionQuestion(profile, workspace) {
  if(!profile || typeof profile!=='object' || !workspace) throw failure('CAPABILITY_UNSUPPORTED','Permission profile is not supported');
  if(Object.keys(profile).some(k=>!['network','fileSystem'].includes(k))) throw failure('CAPABILITY_UNSUPPORTED','Unknown permission profile field');
  const choices=[{label:'Deny all additional permissions',kind:'deny'}];
  if(profile.network){
    if(Object.keys(profile.network).some(k=>k!=='enabled') || ![true,false,null].includes(profile.network.enabled)) throw failure('CAPABILITY_UNSUPPORTED','Unsupported network permission');
    if(profile.network.enabled===true) choices.push({label:'Enable native network access (not restricted to one host)',kind:'network'});
  }
  if(profile.fileSystem){
    if(Object.keys(profile.fileSystem).some(k=>!['read','write'].includes(k))) throw failure('CAPABILITY_UNSUPPORTED','Entries-based filesystem permissions are not supported');
    for(const kind of ['read','write']){
      const paths=profile.fileSystem[kind];if(paths!==null && !Array.isArray(paths)) throw failure('CAPABILITY_UNSUPPORTED','Unsupported filesystem permission');
      for(const path of paths??[]){
        if(typeof path!=='string'||!isAbsolute(path)) throw failure('CAPABILITY_UNSUPPORTED','Absolute native permission path required');
        await workspace.files.check(path);
        const label=kind.toUpperCase()+': '+path;
        if(label.length>160)throw failure('CAPABILITY_UNSUPPORTED','Permission path cannot fit the mobile review interface');
        if(!choices.some(c=>c.kind===kind&&c.path===path)) choices.push({label,kind,path});
      }
    }
  }
  if(choices.length===1 || choices.length>20)throw failure('CAPABILITY_UNSUPPORTED','Permission subset has no reviewable bounded choices');
  const q=questions([{header:'Additional native permissions',question:'Select only the permissions to grant. Deny all overrides every other selection.',multiSelect:true,options:choices.map(c=>({label:c.label}))},{question:'Permission lifetime',options:[{label:'Current turn only'},{label:'Current native session'}]}]);
  q.definition.summary='Only the explicit selection is returned. Filesystem paths outside this project, links, hidden files and unknown native permission fields are denied.';
  return {definition:q.definition,async encode(decision){
    const answers=q.decode(decision),selected=choices.filter(c=>answers[0].values.includes(c.label));
    if(selected.some(c=>c.kind==='deny'))return {permissions:{},scope:'turn'};
    const permissions={};
    if(selected.some(c=>c.kind==='network'))permissions.network={enabled:true};
    const read=[],write=[];
    for(const c of selected)if(c.path){await workspace.files.check(c.path);(c.kind==='read'?read:write).push(c.path);}
    if(read.length||write.length)permissions.fileSystem={read,write};
    return {permissions,scope:answers[1].values[0]==='Current native session'?'session':'turn'};
  }};
}
