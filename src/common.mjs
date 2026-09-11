import { randomUUID, createHash } from 'node:crypto';

export const id = (prefix = 'n') => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export const now = () => new Date().toISOString();
export const cut = (value, max = 48000) => String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').slice(0, max);
export const textContent = content => typeof content === 'string' ? content : (content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function failure(code, message, definite = true) {
  return Object.assign(new Error(message), { code, definite });
}
export function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  // A native event can reject before a caller attaches its await handler.
  promise.catch(() => {});
  return { promise, resolve, reject };
}
export async function bounded(promise, ms = 30000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(failure('OPERATION_UNKNOWN', '原生接收结果未确认', false)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
export const capabilities = overrides => ({ send: true, cancel: true, approval: true, question: true, diff: false, plan: false, usage: true, queue: false, steer: false, ...overrides });
