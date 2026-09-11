import { cut, id } from '../common.mjs';

export const entry = (label, detail = '', extra = {}) => ({ id: id('entry'), label: cut(label, 300) || '(unnamed)', detail: cut(detail, 4000), ...extra });
export const control = (label, request, { confirm = false, fields = [], notice = '' } = {}) => ({ id: id('control'), label: cut(label, 200) || 'Open', request, confirm, ...(fields.length ? { fields } : {}), ...(notice ? { notice: cut(notice, 2000) } : {}) });
export const field = (key, label, { options, maxLength = 4000, boolean = false } = {}) => ({ key, label, type: boolean ? 'boolean' : options ? 'select' : 'text', ...(options ? { options: options.map(x => typeof x === 'string' ? { value: x, label: x } : x) } : boolean ? {} : { maxLength }) });
export const view = (title, notice = '', entries = [], controls = [], extra = {}) => ({ title: cut(title, 200), notice: cut(notice, 4000), entries: entries.slice(0, 100), controls: controls.slice(0, 60), ...(entries.length > 100 || controls.length > 60 ? { truncated: true } : {}), ...extra });
export const unavailable = (title, reason) => view(title, reason);
export const safeCount = n => Number.isSafeInteger(n) && n >= 0 ? n : null;

// Budget is bytes, not UTF-16 length. Never cut a binary chunk or a command.
export function boundView(input) {
 const result=structuredClone(input);
 const size=()=>Buffer.byteLength(JSON.stringify(result));
 while(size()>44000 && result.entries.length) {result.entries.pop();result.truncated=true;}
 while(size()>44000 && result.controls.length) {result.controls.pop();result.truncated=true;}
 while(size()>44000 && result.text?.length) {result.text=result.text.slice(0,Math.max(0,result.text.length-512));result.truncated=true;}
 if(size()>44000) throw new Error('Workspace view exceeds transport budget');
 return result;
}
