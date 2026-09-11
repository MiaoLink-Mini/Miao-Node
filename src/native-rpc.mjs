import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { bounded, deferred, failure, id } from './common.mjs';

// LF only: U+2028 and U+2029 inside JSON strings are NOT record separators.
export class JsonLines {
  constructor(onMessage, maxBytes = 1024 * 1024) {
    this.onMessage = onMessage; this.maxBytes = maxBytes;
    this.decoder = new StringDecoder('utf8'); this.pending = '';
  }
  push(chunk) {
    this.pending += this.decoder.write(chunk);
    let end;
    while ((end = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, end).replace(/\r$/, '');
      this.pending = this.pending.slice(end + 1);
      if (Buffer.byteLength(line) > this.maxBytes) throw failure('PAYLOAD_TOO_LARGE', '原生帧超出上限', false);
      if (line.trim()) this.onMessage(JSON.parse(line));
    }
    if (Buffer.byteLength(this.pending) > this.maxBytes) throw failure('PAYLOAD_TOO_LARGE', '原生帧超出上限', false);
  }
  end() {
    this.pending += this.decoder.end();
    if (this.pending.trim()) throw failure('PROTOCOL_UNSUPPORTED', '原生 JSONL 被截断', false);
  }
}

export class NativeRPC extends EventEmitter {
  constructor(command, args, { cwd, env, mode = 'jsonrpc', timeout = 30000, maxFrameBytes = 1024*1024 } = {}) {
    super(); this.pending = new Map(); this.timeout = timeout; this.mode = mode; this.closed = false;
    if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1024||maxFrameBytes>16*1024*1024)throw new RangeError('Invalid native frame limit');
    this.child = spawn(command, args, { cwd, env: env ?? process.env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = deferred();
    // Do not relay stderr: native diagnostics may contain credentials or raw protocol.
    this.child.stderr.resume();
    const parser = new JsonLines(message => this.receive(message),maxFrameBytes);
    this.child.stdout.on('data', chunk => {
      try { parser.push(chunk); } catch { this.fail(failure('PROTOCOL_UNSUPPORTED', '原生输出协议错误', false)); this.child.kill(); }
    });
    this.child.stdout.on('end', () => { try { parser.end(); } catch (e) { this.fail(e); } });
    this.child.stdin.on('error', () => this.fail(failure('OPERATION_UNKNOWN', '原生输入通道关闭', false)));
    this.child.on('error', () => this.fail(failure('SERVICE_UNAVAILABLE', '无法启动原生 Agent')));
    this.child.on('close', () => { this.fail(failure('OPERATION_UNKNOWN', '原生 Agent 进程已退出', false)); this.exited.resolve(); });
  }
  receive(message) {
    const isResponse = this.mode === 'pi' ? message.type === 'response' : !message.method && ('result' in message || 'error' in message);
    const wait = this.pending.get(message.id);
    if (isResponse && wait) {
      this.pending.delete(message.id);
      if (message.error || message.success === false) wait.reject(failure('VALIDATION_FAILED', '原生 Agent 拒绝了操作'));
      else wait.resolve(this.mode === 'pi' ? message.data : message.result);
    } else this.emit('message', message);
  }
  write(message) {
    if (this.closed || this.child.stdin.destroyed) throw failure('OPERATION_UNKNOWN', '原生通道不可用', false);
    const line = `${JSON.stringify(message)}\n`;
    if (this.child.stdin.writableLength + Buffer.byteLength(line) > 1024 * 1024) throw failure('SERVICE_UNAVAILABLE', '原生输入背压', false);
    this.child.stdin.write(line);
  }
  async call(method, params = {}) {
    const requestId = id('rpc'), wait = deferred(); this.pending.set(requestId, wait);
    try {
      this.write(this.mode === 'pi' ? { id: requestId, type: method, ...params } : { id: requestId, method, params });
      return await bounded(wait.promise, this.timeout);
    } finally { this.pending.delete(requestId); }
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const wait of this.pending.values()) wait.reject(error);
    this.pending.clear(); this.emit('fault', error);
  }
  async close() {
    if (!this.closed) { this.child.stdin.end(); this.child.kill(); }
    try { await bounded(this.exited.promise, 2000); }
    catch { this.child.kill('SIGKILL'); await bounded(this.exited.promise, 2000).catch(() => {}); }
  }
}
