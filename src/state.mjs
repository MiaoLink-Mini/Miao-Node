import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { id, digest, failure } from './common.mjs';
const workspaceEffects = new Map(JSON.parse(readFileSync(new URL('../../WeAgent-Backend/contracts/workspace-operations.json', import.meta.url),'utf8')).map(x=>[x.kind,x]));
export function readOnlyCommand(command) {
  if(command?.kind==='history')return true;
  const control=command?.payload?.control, op=workspaceEffects.get(control?.request?.kind);
  return command?.kind==='native' && !command.nextTurnId && control?.action==='workspace' && op?.write===false && op.newTurn===false;
}

export class State {
  constructor(dir, { maxSpoolBytes = 32 * 1024 * 1024, maxJournal = 100000 } = {}) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.lock = join(dir, 'daemon.lock'); this.maxSpoolBytes = maxSpoolBytes; this.maxJournal = maxJournal;
    if (existsSync(this.lock)) {
      const pid = Number(readFileSync(this.lock, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('状态锁无效；请人工检查，不自动删除');
      let alive = true;
      try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('状态目录已被另一个 Daemon 使用');
      unlinkSync(this.lock);
    }
    const fd = openSync(this.lock, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd);
    try {
      const path = join(dir, 'state.sqlite');
      // A missing DB next to the sentinel is data loss, not a brand new identity.
      const sentinel = join(dir, 'initialized');
      if (existsSync(sentinel) && !existsSync(path)) throw new Error('journal 丢失，禁止自动重建身份');
      this.db = new DatabaseSync(path);
      chmodSync(path, 0o600);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS journal (id TEXT PRIMARY KEY, hash TEXT NOT NULL, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, ack INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS spool (ord INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL, bytes INTEGER NOT NULL, UNIQUE(session,seq));`);
      if (this.db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('journal 完整性校验失败');
      if (existsSync(sentinel) && !this.get('identity')) throw new Error('身份记录丢失，禁止恢复为空状态');
      this.sentinel = sentinel;
    } catch (e) { this.db?.close(); unlinkSync(this.lock); throw e; }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  get(key) { const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key); return row && JSON.parse(row.value); }
  set(key, value) { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  markInitialized() { writeFileSync(this.sentinel, 'weagent-node/1\n', { mode: 0o600 }); }
  operation(operationId) { const row = this.db.prepare('SELECT value FROM journal WHERE id=?').get(operationId); return row && JSON.parse(row.value); }
  receive(command) {
    // Epoch is transport fencing, not the identity of a business operation.
    const { nodeEpoch, ...semantic } = command, hash = digest(semantic);
    return this.transaction(() => {
      const old = this.db.prepare('SELECT hash,value FROM journal WHERE id=?').get(command.operationId);
      if (old) {
        if (old.hash !== hash) throw failure('IDEMPOTENCY_CONFLICT', '同一操作 ID 的内容不一致');
        return { fresh: false, entry: JSON.parse(old.value) };
      }
      if (this.db.prepare('SELECT count(*) AS n FROM journal').get().n >= this.maxJournal) throw failure('SERVICE_UNAVAILABLE', 'journal 配额已满，需要本机维护');
      const entry = { command, state: 'delivered', result: null, error: null };
      this.db.prepare('INSERT INTO journal VALUES (?,?,?)').run(command.operationId, hash, JSON.stringify(entry));
      return { fresh: true, entry };
    });
  }
  saveOperation(entry) { this.db.prepare('UPDATE journal SET value=? WHERE id=?').run(JSON.stringify(entry), entry.command.operationId); }
  sessions() { return this.db.prepare('SELECT value FROM sessions ORDER BY id').all().map(r => JSON.parse(r.value)); }
  session(sessionId) { const row = this.db.prepare('SELECT value FROM sessions WHERE id=?').get(sessionId); return row && JSON.parse(row.value); }
  saveSession(session) { this.db.prepare('INSERT INTO sessions(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(session.sessionId, JSON.stringify(session)); }
  append(sessionId, type, body, validateFrame) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT seq FROM sessions WHERE id=?').get(sessionId);
      if (!row) throw new Error('source session missing');
      const sourceSequence = row.seq + 1, sourceEventId = id('src');
      const data = type === 'node.events' ? { events: [{ ...body, sourceEventId, sourceSequence }] } : { ...body, sourceEventId, sourceSequence };
      const frame = { version: 'weagent/1', type, data };
      validateFrame?.({ ...frame, data: { ...data, epoch: 1 } });
      const value = JSON.stringify(frame), bytes = Buffer.byteLength(value);
      if (bytes > 240 * 1024 || this.spoolBytes() + bytes > this.maxSpoolBytes) throw failure('SERVICE_UNAVAILABLE', '事件 spool 配额已满，需要本机干预', false);
      this.db.prepare('INSERT INTO spool(session,seq,value,bytes) VALUES (?,?,?,?)').run(sessionId, sourceSequence, value, bytes);
      this.db.prepare('UPDATE sessions SET seq=? WHERE id=?').run(sourceSequence, sessionId);
      return frame;
    });
  }
  spoolBytes() { return this.db.prepare('SELECT coalesce(sum(bytes),0) AS n FROM spool').get().n; }
  pending() { return this.db.prepare('SELECT value FROM spool ORDER BY ord').all().map(r => JSON.parse(r.value)); }
  ack(sessionId, sequence) {
    this.transaction(() => {
      const row = this.db.prepare('SELECT seq,ack FROM sessions WHERE id=?').get(sessionId);
      if (!row || sequence > row.seq) throw failure('SOURCE_CONFLICT', 'Gateway ACK 超出本地事件末尾', false);
      if (sequence <= row.ack) return;
      this.db.prepare('DELETE FROM spool WHERE session=? AND seq<=?').run(sessionId, sequence);
      this.db.prepare('UPDATE sessions SET ack=? WHERE id=?').run(sequence, sessionId);
    });
  }
  recover() {
    this.transaction(() => {
      for (const row of this.db.prepare('SELECT value FROM journal').all()) {
        const entry = JSON.parse(row.value);
        if (entry.state === 'executing' || entry.state === 'delivered') { entry.state = 'unknown'; this.saveOperation(entry); }
        if(entry.state==='unknown' && readOnlyCommand(entry.command)) {
          entry.state='rejected';entry.error={code:'SERVICE_UNAVAILABLE',message:'Read-only query did not complete; retry the query',retryable:true,requestId:id('trace')};
          this.saveOperation(entry);
        }
      }
      for (const session of this.sessions()) {
        // Native pending requests cannot survive a daemon restart. Also repair
        // closed records written by older builds, which cleared the wrong field.
        session.state = 'closed';
        if (session.queue?.length) session.queuePolicy = 'manual';
        session.requests = {};
        delete session.request;
        this.saveSession(session);
      }
    });
  }
  close() { this.db?.close(); this.db = null; if (this.lock) { unlinkSync(this.lock); this.lock = null; } }
}
