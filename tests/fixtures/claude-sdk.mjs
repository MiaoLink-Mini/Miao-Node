import { InputStream } from '../../src/plugins/claude.mjs';

// SDK API fixture, not a second implementation of Claude's private wire protocol.
export function fakeQuery({ prompt, options }, { compact = false } = {}) {
  const output = new InputStream(), abort = new AbortController(); let current;
  const result = () => output.push({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 20, output_tokens: 10 }, total_cost_usd: 0.01 });
  const consumer = (async () => {
    for await (const message of prompt) {
      if (output.ended) return;
      current = message.uuid;
      const text = message.message.content;
      output.push({ type: 'user', uuid: current, message: { role: 'user', content: text } });
      if (compact && text === '/compact') {
        output.push({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 100, post_tokens: 20 } });
        result(); continue;
      }
      if (text === 'hold') continue;
      if (text === 'approval' || text === 'question') {
        const input = text === 'approval' ? { command: 'echo fixture' } : { questions: [{ header: '恢复', question: '保留哪些内容？', multiSelect: true, options: [{ label: '历史' }, { label: '草稿' }] }] };
        const answer = await options.canUseTool(text === 'approval' ? 'Bash' : 'AskUserQuestion', input, { toolUseID: 'native_tool', requestId: 'native_request', signal: abort.signal });
        if (output.ended) return;
        output.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'native_tool', is_error: answer.behavior === 'deny', content: [{ type: 'text', text: 'received' }] }] } });
      }
      const nativeId = 'assistant_' + current;
      output.push({ type: 'stream_event', event: { type: 'message_start', message: { id: nativeId } } });
      output.push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello 世界' } } });
      output.push({ type: 'assistant', message: { id: nativeId, content: [{ type: 'text', text: 'hello 世界' }, { type: 'tool_use', id: 'plan_tool', name: 'TodoWrite', input: { todos: [{ content: '完成检查', status: 'completed' }] } }] } });
      result();
    }
  })();
  consumer.catch(() => output.end());
  const commands = compact ? [{ name: 'compact', description: 'Fixture native compaction', argumentHint: '' }] : [];
  output.initializationResult = async () => ({ commands, models: [] });
  if (compact) output.supportedCommands = async () => commands;
  output.supportedModels = async () => [{ value: 'fixture-model', displayName: 'Fixture model', apiKey: 'NEVER_PUBLISH' }, { value: 'fixture-next', displayName: 'Fixture next' }];
  output.setModel = async model => { output.selectedModel = model; };
  output.interrupt = async () => { result(); return { still_queued: [] }; };
  output.close = () => { abort.abort(); output.end(); prompt.end?.(); };
  return output;
}
