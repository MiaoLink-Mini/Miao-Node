import { id, failure } from '../common.mjs';

/** Opaque, bounded, session-local native resource references. Never decode phone input as a path. */
export class Handles {
  constructor({ now = Date.now, ttl = 15 * 60 * 1000, max = 2048 } = {}) {
    this.now = now; this.ttl = ttl; this.max = max; this.records = new Map();
  }
  put(kind, value, { ttl = this.ttl } = {}) {
    this.sweep();
    if (this.records.size >= this.max) throw failure('SERVICE_UNAVAILABLE', 'Resource reference limit reached; refresh the session later');
    const key = id('resource');
    this.records.set(key, { kind, value, expires: this.now() + ttl });
    return key;
  }
  get(key, kind) {
    const record = this.records.get(key);
    if (!record || record.kind !== kind || record.expires <= this.now()) {
      if (record?.expires <= this.now()) this.records.delete(key);
      throw failure('NOT_FOUND', 'Resource reference is missing, expired or belongs to another session; refresh its directory');
    }
    return record.value;
  }
  expires(key) { return new Date(this.records.get(key)?.expires ?? 0).toISOString(); }
  remove(key) { this.records.delete(key); }
  sweep() { for (const [key, record] of this.records) if (record.expires <= this.now()) this.records.delete(key); }
  clear() { this.records.clear(); }
}
