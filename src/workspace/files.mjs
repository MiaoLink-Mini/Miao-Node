import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, realpath, readdir, mkdir, rm, rename } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { failure, id } from '../common.mjs';
import { entry, control, view } from './view.mjs';

export const FILE_LIMITS = Object.freeze({ fileBytes: 4 * 1024 * 1024, attachmentBytes: 512 * 1024, promptBytes: 600 * 1024, sessionBytes: 8 * 1024 * 1024, chunkBytes: 24 * 1024, pageEntries: 60, ttl: 30 * 60 * 1000 });
const HIDDEN = new Set(['.git', '.hg', '.svn', '.env', '.ssh', '.aws', '.azure', '.kube', '.npmrc', '.pypirc', '.runtime', 'node_modules']);
const TYPES = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.pdf', 'application/pdf'], ['.json', 'application/json']]);
const TEXT = new Set(['.txt', '.md', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.go', '.py', '.rs', '.c', '.h', '.cpp', '.java', '.yaml', '.yml', '.toml', '.xml', '.sql', '.sh', '.log', '.csv']);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
const unchangedIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const isWithin = (root, path) => { const r = relative(root, path); return !isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep); };
const mime = path => TYPES.get(extname(path).toLowerCase()) ?? (TEXT.has(extname(path).toLowerCase()) ? 'text/plain' : 'application/octet-stream');
const dec = () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

async function identityStat(path) {
  const before = await lstat(path);
  // Windows path-based stat can report dev=0 while fstat reports the volume ID.
  // Obtain the real volume identity instead of ignoring dev in sameFile checks.
  if (process.platform !== 'win32' || before.dev !== 0 || before.isSymbolicLink() || (!before.isFile() && !before.isDirectory())) return before;
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await fd.stat(), after = await lstat(path);
    if (after.isSymbolicLink() || !sameFile(before, after) || !sameFile(before, { ...opened, dev: before.dev }) || before.isFile() !== opened.isFile() || before.isDirectory() !== opened.isDirectory()) {
      throw failure('SOURCE_CONFLICT', 'File identity changed while checking its volume');
    }
    return opened;
  } finally { await fd.close(); }
}

export class ProjectFiles {
  constructor(root, handles, { allowHidden = false, maxBytes = FILE_LIMITS.fileBytes } = {}) {
    this.root = resolve(root); this.handles = handles; this.allowHidden = allowHidden; this.maxBytes = Math.min(maxBytes, FILE_LIMITS.fileBytes);
    this.artifacts = new Map();
  }
  async initialize() {
    const actual = await realpath(this.root); const st = await identityStat(this.root);
    if (actual !== this.root || st.isSymbolicLink() || !st.isDirectory()) throw failure('FORBIDDEN', 'Project root changed or is not a real directory');
    this.identity = st; return this;
  }
  async check(path) {
    if (!this.identity) await this.initialize();
    const absolute = resolve(path);
    if (!isWithin(this.root, absolute)) throw failure('FORBIDDEN', 'Resource is outside the authorized project');
    const root = await identityStat(this.root);
    if (!unchangedIdentity(root, this.identity) || root.isSymbolicLink() || await realpath(this.root) !== this.root) throw failure('FORBIDDEN', 'Authorized project root has changed');
    const r = relative(this.root, absolute); let current = this.root;
    for (const part of r ? r.split(sep) : []) {
      if (HIDDEN.has(part) || !this.allowHidden && part.startsWith('.')) throw failure('FORBIDDEN', 'This file is excluded by the host file policy');
      current = join(current, part);
      const st = await identityStat(current);
      if (st.isSymbolicLink() || await realpath(current) !== current) throw failure('FORBIDDEN', 'Symbolic links and junctions are not browsable');
    }
    const st = await identityStat(absolute);
    if (!st.isFile() && !st.isDirectory()) throw failure('FORBIDDEN', 'Only regular files and directories are browsable');
    return st;
  }
  async record(path, turnId, observedAt = new Date().toISOString()) {
    if (typeof path !== 'string' || !path) return;
    const absolute = isAbsolute(path) ? path : join(this.root, path);
    try {
      const st = await this.check(absolute);
      if (!st.isFile()) return;
      this.artifacts.set(absolute, { path: absolute, turnId, observedAt, size: st.size });
      if (this.artifacts.size > 300) this.artifacts.delete(this.artifacts.keys().next().value);
    } catch { /* A native result may mention paths outside the authorized project; do not publish them. */ }
  }
  async list(resourceId, offset = 0) {
    const target = resourceId ? this.handles.get(resourceId, 'directory') : { path: this.root };
    const before = await this.check(target.path);
    if (!before.isDirectory()) throw failure('NOT_FOUND', 'Directory no longer exists');
    const names = (await readdir(target.path)).sort((a, b) => a.localeCompare(b));
    const after = await this.check(target.path);
    if (!unchangedIdentity(before, after)) throw failure('SOURCE_CONFLICT', 'Directory changed while being read');
    const visible = names.filter(name => !HIDDEN.has(name) && (this.allowHidden || !name.startsWith('.')));
    const entries = [];
    for (const name of visible.slice(offset, offset + FILE_LIMITS.pageEntries)) {
      const path = join(target.path, name);
      try {
        const st = await this.check(path);
        const key = this.handles.put(st.isDirectory() ? 'directory' : 'file', { path, identity: st });
        entries.push(entry(name, st.isDirectory() ? 'Directory' : `${st.size} bytes; modified ${st.mtime.toISOString()}`, {
          id: key, state: st.isDirectory() ? 'directory' : 'file', ...(st.isFile() ? { referenceId: key, size: Math.min(st.size, 16777216), mediaType: mime(path) } : {}),
          request: st.isDirectory() ? { kind: 'list_files', resourceId: key, offset: 0 } : { kind: 'read_file', resourceId: key, offset: 0, format: 'text' },
          ...(st.isFile() && st.size <= this.maxBytes ? { controls: [control('Download exact version', { kind: 'read_file', resourceId: key, offset: 0, format: 'base64' })] } : {}),
        }));
      } catch (e) {
        if (e.code !== 'ENOENT' && e.code !== 'FORBIDDEN') throw e;
        // Excluded/changed entries are omitted, never followed to a different path.
      }
    }
    const key = resourceId ?? this.handles.put('directory', { path: this.root });
    const controls = [control('Refresh directory', { kind: 'list_files', resourceId: key, offset: 0 })];
    if (target.path !== this.root) controls.push(control('Parent directory', { kind: 'list_files', resourceId: this.handles.put('directory', { path: dirname(target.path) }), offset: 0 }));
    if (offset + FILE_LIMITS.pageEntries < visible.length) controls.push(control('Next page', { kind: 'list_files', resourceId: key, offset: offset + FILE_LIMITS.pageEntries }));
    return view(relative(this.root, target.path).split(sep).join('/') || 'Authorized project', `Read-only. Files above ${this.maxBytes} bytes are metadata-only. Hidden files, links and host exclusions are not traversed.`, entries, controls, { truncated: offset + FILE_LIMITS.pageEntries < visible.length });
  }
  async bytes(resourceId, expectedVersion) {
    const record = this.handles.get(resourceId, 'file'); const before = await this.check(record.path);
    if (!before.isFile() || !sameFile(record.identity, before)) throw failure('SOURCE_CONFLICT', 'File changed after it was listed; refresh before opening a new version');
    if (before.size > this.maxBytes) throw failure('PAYLOAD_TOO_LARGE', 'File exceeds the host read limit');
    let fd;
    try {
      fd = await open(record.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await fd.stat();
      if (!sameFile(before, opened) || !sameFile(before, await this.check(record.path))) throw failure('SOURCE_CONFLICT', 'File identity changed before read');
      const bytes = await fd.readFile();
      if (bytes.length > this.maxBytes || !sameFile(opened, await fd.stat()) || !sameFile(before, await this.check(record.path))) throw failure('SOURCE_CONFLICT', 'File changed during read; no partial version was returned');
      const version = sha256(bytes);
      if ((expectedVersion && version !== expectedVersion) || (record.version && record.version !== version)) throw failure('SOURCE_CONFLICT', 'File version changed; restart the preview or download');
      record.version = version;
      return { bytes, version, path: record.path, mediaType: mime(record.path), name: basename(record.path) };
    } finally { await fd?.close(); }
  }
  async read({ resourceId, offset = 0, format, version }) {
    const file = await this.bytes(resourceId, version);
    if (offset > file.bytes.length) throw failure('VALIDATION_FAILED', 'Read offset is beyond the file');
    const binary = format === 'base64'; let end = Math.min(file.bytes.length, offset + (binary ? FILE_LIMITS.chunkBytes : 16000)); let text;
    if (!binary) {
      // Decode the complete bounded file first: a valid suffix does not prove a binary file is UTF-8.
      try { dec().decode(file.bytes); } catch { return view(file.name, 'Not UTF-8 text. No replacement characters were inserted. Download the binary file instead.', [], [control('Download', { kind: 'read_file', resourceId, offset: 0, version: file.version, format: 'base64' })]); }
      for (let trim = 0; trim < 4; trim++) {
        try { text = dec().decode(file.bytes.subarray(offset, end)); break; } catch { end--; }
      }
      if (text === undefined) throw failure('VALIDATION_FAILED', 'Offset is not on a UTF-8 boundary');
    }
    const transfer = { id: resourceId, name: file.name, mediaType: file.mediaType, size: file.bytes.length, sha256: file.version, version: file.version, offset, nextOffset: end, eof: end === file.bytes.length, state: 'download', expiresAt: this.handles.expires(resourceId), ...(binary ? { content: file.bytes.subarray(offset, end).toString('base64') } : {}) };
    const controls = end < file.bytes.length ? [control('Continue this exact version', { kind: 'read_file', resourceId, offset: end, version: file.version, format })] : [];
    return view(file.name, `Version ${file.version}; bytes ${offset}-${end}/${file.bytes.length}. The next read fails if the file changes.`, [], controls, { transfer, ...(binary ? {} : { text }) });
  }
  async recent() {
    const entries = [];
    for (const [path, record] of [...this.artifacts].reverse()) {
      try {
        const st = await this.check(path); const key = this.handles.put('file', { path, identity: st });
        entries.push(entry(relative(this.root, path).split(sep).join('/'), `Observed ${record.observedAt}; turn ${record.turnId}; ${st.size} bytes`, { state: 'exists', referenceId: key, size: Math.min(st.size,16777216), mediaType:mime(path), request: { kind: 'read_file', resourceId: key, offset: 0, format: 'text' }, controls: st.size <= this.maxBytes ? [control('Download exact version',{kind:'read_file',resourceId:key,offset:0,format:'base64'})] : [] }));
      } catch { entries.push(entry(relative(this.root, path).split(sep).join('/'), `Observed ${record.observedAt}; no longer available`, { state: 'missing' })); }
    }
    return view('Generated and changed files', 'Only files identified by completed native tool events are listed. This is not an inferred list of every project file.', entries);
  }
}

export class Uploads {
  constructor(stateDir, sessionId, handles, { now = Date.now } = {}) {
    this.root = resolve(stateDir, 'content', sessionId); this.handles = handles; this.now = now; this.records = new Map(); this.closed = false;
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const st = await identityStat(this.root);
    if (st.isSymbolicLink() || await realpath(this.root) !== this.root) throw failure('FORBIDDEN', 'Upload storage is not a private real directory');
    this.identity = st;
  }
  async begin({ name, mediaType, size, sha256: hash }) {
    if (this.closed) throw failure('READ_ONLY', 'Session upload storage is closed');
    await this.sweep();
    if (!this.identity) await this.initialize();
    await this.guardRoot();
    if (basename(name) !== name || /[\\/\x00-\x1f]/u.test(name) || name === '.' || name === '..') throw failure('VALIDATION_FAILED', 'Attachment name must be a single display filename');
    if (size > FILE_LIMITS.attachmentBytes) throw failure('PAYLOAD_TOO_LARGE', `Attachment limit is ${FILE_LIMITS.attachmentBytes} bytes`);
    if (this.records.size >= 16 || [...this.records.values()].reduce((n, r) => n + r.size, 0) + size > FILE_LIMITS.sessionBytes) throw failure('PAYLOAD_TOO_LARGE', 'Session upload quota exceeded');
    const key = this.handles.put('upload', { key: null }, { ttl: FILE_LIMITS.ttl }); this.handles.get(key, 'upload').key = key;
    const path = join(this.root, key + '.part'); const fd = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600); await fd.close();
    const record = { key, name, mediaType, size, sha256: hash, received: 0, path, state: 'uploading', expires: this.now() + FILE_LIMITS.ttl, pinned: 0 };
    this.records.set(key, record); return this.result(record);
  }
  get(key) {
    this.handles.get(key, 'upload'); const record = this.records.get(key);
    if (!record || this.closed || record.expires <= this.now() && !record.pinned) throw failure('NOT_FOUND', 'Attachment expired or belongs to another session');
    return record;
  }
  async guardRoot() {
    if (!this.identity || !unchangedIdentity(this.identity, await identityStat(this.root)) || await realpath(this.root) !== this.root) throw failure('FORBIDDEN', 'Upload storage identity changed');
  }
  async remove(record) {
    await this.guardRoot();
    try { await this.guard(record); } catch (error) { if(error.code !== 'ENOENT') throw error; return; }
    await rm(record.path, { force: true });
  }
  async guard(record) {
    await this.guardRoot();
    const st = await identityStat(record.path);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw failure('FORBIDDEN', 'Unsafe upload file');
    return st;
  }
  async chunk({ resourceId, offset, content }) {
    const record = this.get(resourceId); if (record.state !== 'uploading') throw failure('VALIDATION_FAILED', 'Upload already committed');
    const bytes = Buffer.from(content, 'base64');
    if (bytes.toString('base64') !== content || !bytes.length || bytes.length > FILE_LIMITS.chunkBytes || offset + bytes.length > record.size || offset > record.received) throw failure('VALIDATION_FAILED', 'Invalid or out-of-order upload chunk');
    const before = await this.guard(record); const fd = await open(record.path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!sameFile(before, await fd.stat())) throw failure('SOURCE_CONFLICT', 'Upload file changed');
      if (offset < record.received) {
        if (offset + bytes.length > record.received) throw failure('SOURCE_CONFLICT', 'Upload retry overlaps an unreceived range');
        const old = Buffer.alloc(bytes.length); const read = await fd.read(old, 0, old.length, offset);
        if (read.bytesRead !== bytes.length || !old.equals(bytes)) throw failure('IDEMPOTENCY_CONFLICT', 'Upload retry has different bytes');
      } else {
        let written = 0;
        while (written < bytes.length) { const n = await fd.write(bytes, written, bytes.length - written, offset + written); if (!n.bytesWritten) throw failure('SERVICE_UNAVAILABLE', 'Upload write made no progress'); written += n.bytesWritten; }
        await fd.sync(); record.received += bytes.length;
      }
    } finally { await fd.close(); }
    return this.result(record);
  }
  async commit(resourceId) {
    const record = this.get(resourceId);
    if (record.state !== 'uploading') return this.result(record);
    if (record.received !== record.size) throw failure('VALIDATION_FAILED', 'Upload is incomplete');
    const before = await this.guard(record); const fd = await open(record.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes; try { if (!sameFile(before, await fd.stat())) throw failure('SOURCE_CONFLICT', 'Upload identity changed'); bytes = await fd.readFile(); if (!sameFile(before, await fd.stat()) || !sameFile(before, await this.guard(record))) throw failure('SOURCE_CONFLICT', 'Upload changed while being read'); } finally { await fd.close(); }
    if (bytes.length !== record.size || sha256(bytes) !== record.sha256) throw failure('SOURCE_CONFLICT', 'Attachment checksum does not match');
    this.verifyType(record.mediaType, bytes);
    await this.guard(record);
    const target = join(this.root, record.key + '.bin'); await rename(record.path, target); record.path = target; record.state = 'received';
    return this.result(record);
  }
  verifyType(type, bytes) {
    let ok = true;
    if (type === 'image/png') ok = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    if (type === 'image/jpeg') ok = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (type === 'image/gif') ok = ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
    if (type === 'image/webp') ok = bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    if (type === 'application/pdf') ok = bytes.subarray(0, 5).toString('ascii') === '%PDF-';
    if (['text/plain', 'application/json'].includes(type)) {
      try { const text = dec().decode(bytes); if (type === 'application/json') JSON.parse(text); } catch { ok = false; }
    }
    if (!ok) throw failure('VALIDATION_FAILED', 'Attachment bytes do not match the declared media type');
  }
  async content(resourceId) {
    const record = this.get(resourceId);
    if (!['received','accepted'].includes(record.state)) throw failure('VALIDATION_FAILED', 'Attachment has not reached the Node');
    const before = await this.guard(record); const fd = await open(record.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); let bytes;
    try { if (!sameFile(before, await fd.stat())) throw failure('SOURCE_CONFLICT', 'Attachment identity changed'); bytes = await fd.readFile(); if (!sameFile(before, await fd.stat()) || !sameFile(before, await this.guard(record))) throw failure('SOURCE_CONFLICT', 'Attachment changed while being read'); } finally { await fd.close(); }
    if (bytes.length !== record.size || sha256(bytes) !== record.sha256) throw failure('SOURCE_CONFLICT', 'Stored attachment changed');
    return { ...record, bytes };
  }
  accept(keys) { for (const key of keys) { const r = this.get(key); r.state = 'accepted'; } }
  pin(keys) { for (const key of keys) { const r = this.get(key); r.pinned++; const h = this.handles.records.get(key); h.expires = Number.MAX_SAFE_INTEGER; } }
  unpin(keys) { for (const key of keys) { const r = this.records.get(key); if (r) { r.pinned = Math.max(0, r.pinned - 1); if (!r.pinned) { r.expires = this.now() + FILE_LIMITS.ttl; const h = this.handles.records.get(key); if (h) h.expires = r.expires; } } } }
  async discard(key) { const r = this.get(key); if (r.pinned) throw failure('STALE_TURN', 'Attachment is referenced by an accepted queue item'); await this.remove(r); this.records.delete(key); this.handles.remove(key); return view('Attachment removed', 'Only the staged Node copy was removed; no remote task was sent.'); }
  result(r) { return view(r.name, r.state === 'uploading' ? 'Uploading to the Node; not available to the Agent yet.' : r.state === 'received' ? 'Node checksum verified. The Agent has not accepted this attachment yet.' : 'An Agent input containing this attachment has been accepted.', [], [], { transfer: { id: r.key, name: r.name, mediaType: r.mediaType, size: r.size, sha256: r.sha256, offset: r.received, state: r.state, expiresAt: new Date(r.expires).toISOString() } }); }
  list() { return view('Attachments', `Max ${FILE_LIMITS.attachmentBytes} bytes/file; ${FILE_LIMITS.promptBytes} total attachment bytes per input. Upload completion is not Agent acceptance.`, [...this.records.values()].map(r => entry(r.name, `${r.received}/${r.size} bytes; ${r.mediaType}`, { id: r.key, referenceId: r.key, state: r.state, controls: r.pinned ? [] : [control('Remove staged copy', { kind: 'discard_upload', resourceId: r.key }, { confirm: true })] }))); }
  async sweep() { for (const [key, r] of this.records) if (!r.pinned && r.expires <= this.now()) { await this.remove(r); this.records.delete(key); this.handles.remove(key); } }
  async close() { this.closed = true; for (const r of this.records.values()) await this.remove(r); this.records.clear(); }
}
