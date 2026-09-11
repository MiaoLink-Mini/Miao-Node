import Ajv from 'ajv/dist/2020.js';
import { failure } from '../common.mjs';

// Deliberately bounded native form subset. No external refs, nested objects,
// secret formats, arbitrary regex or schema execution from an MCP server.
export function elicitationForm(request) {
  const schema=request.requestedSchema;
  if(!schema || schema.type!=='object' || !schema.properties || typeof schema.properties!=='object' || Array.isArray(schema.properties)) throw failure('CAPABILITY_UNSUPPORTED','Native form has no supported object schema');
  if(Object.keys(schema).some(k=>!['type','properties','required','additionalProperties','title','description','$schema'].includes(k))) throw failure('CAPABILITY_UNSUPPORTED','Unsupported form schema keyword');
  const fields=Object.entries(schema.properties);
  if(!fields.length || fields.length>18 || JSON.stringify(schema).length>16000) throw failure('CAPABILITY_UNSUPPORTED','Form exceeds the mobile review limit');
  if(schema.required!==undefined && (!Array.isArray(schema.required)||schema.required.some(k=>!Object.hasOwn(schema.properties,k)))) throw failure('CAPABILITY_UNSUPPORTED','Invalid required form fields');
  const allowed=new Set(['type','title','description','enum','minLength','maxLength','minimum','maximum','default']);
  for(const [name,s] of fields){
    if(name.length>120 || !s || typeof s!=='object'|| Object.keys(s).some(k=>!allowed.has(k)) || !['string','number','integer','boolean'].includes(s.type)) throw failure('CAPABILITY_UNSUPPORTED','Native form requires unsupported or secret input');
    if(s.enum && (!Array.isArray(s.enum)||s.enum.length>20))throw failure('CAPABILITY_UNSUPPORTED','Native enum exceeds the mobile review limit');
  }
  const validate=new Ajv({strict:false,allErrors:false,validateFormats:false}).compile({...schema,additionalProperties:false});
  const definition={kind:'question',title:(request.title||request.serverName||'MCP form').slice(0,200),summary:('Native form request, not tool permission. '+request.message).slice(0,4000),questions:[{id:'action',label:'Submit the form or decline it',type:'single',required:true,options:[{id:'submit',label:'Submit to this MCP server'},{id:'decline',label:'Decline'}]},...fields.map(([name,s],i)=>({id:'field'+i,label:(name+' - '+(s.title||s.description||s.type)+(s.enum?' (allowed: '+JSON.stringify(s.enum)+')':'')+(s.type==='boolean'?' (true / false)':'')).slice(0,500),type:'text',required:false,maxLength:Math.min(4000,s.maxLength??4000)}))]};
  return {definition,encode(decision){
    if(decision.answers.action==='decline')return {action:'decline'};
    const content=Object.create(null);
    fields.forEach(([name,s],i)=>{
      const text=decision.answers['field'+i];
      if(text===''&&!schema.required?.includes(name))return;
      if(s.type==='string') content[name]=text;
      else if(s.type==='boolean') {if(text!=='true'&&text!=='false')throw failure('VALIDATION_FAILED','Boolean form value must be true or false');content[name]=text==='true';}
      else {if(typeof text!=='string'||!text.trim())throw failure('VALIDATION_FAILED','Numeric form value is required');const n=Number(text);if(!Number.isFinite(n)||s.type==='integer'&&!Number.isSafeInteger(n))throw failure('VALIDATION_FAILED','Invalid numeric form value');content[name]=n;}
    });
    if(!validate(content))throw failure('VALIDATION_FAILED','Form does not satisfy the native requested schema');
    return {action:'accept',content};
  }};
}
