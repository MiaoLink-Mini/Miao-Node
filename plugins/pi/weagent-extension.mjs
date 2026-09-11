import { randomUUID } from 'node:crypto';

// Loaded explicitly with -e, never installed into the user's global Pi settings.
// This is an application permission gate, NOT an OS filesystem/network sandbox.
export default function weagent(pi) {
  const dialog = async (ctx, definition, options, signal) => {
    const nonce = randomUUID(), title = JSON.stringify({ weagent: 1, nonce, ...definition });
    const value = options?.length
      ? await ctx.ui.select(title, options, { timeout: 30 * 60 * 1000, signal })
      : await ctx.ui.input(title, '请输入回答', { timeout: 30 * 60 * 1000, signal });
    ctx.ui.notify(JSON.stringify({ weagent: 1, event: 'decision', nonce, received: value !== undefined }), 'info');
    return value;
  };
  pi.on('session_start', async (_, ctx) => {
    ctx.ui.notify(JSON.stringify({ weagent: 1, event: 'ready', version: 1 }), 'info');
  });
  pi.on('tool_call', async (event, ctx) => {
    if (!['bash', 'edit', 'write'].includes(event.toolName)) return;
    const summary = event.toolName === 'bash' ? String(event.input.command ?? '') : JSON.stringify(event.input);
    // Never approve a command whose full identity does not fit the review contract.
    if (summary.length > 4000) return { block: true, reason: '喵连 review payload exceeds 4000 characters' };
    const value = await dialog(ctx, { kind: 'approval', title: `允许执行 ${event.toolName}？`, summary, toolCallId: event.toolCallId }, ['仅允许本次', '拒绝']);
    if (value !== '仅允许本次') return { block: true, reason: 'User declined or permission expired' };
  });
  pi.registerTool({
    name: 'weagent_question', label: '喵连 Question',
    description: 'Ask the mobile user a single-choice or text question and wait for their answer. Use this when task requirements need clarification.',
    parameters: { type: 'object', properties: { question: { type: 'string', minLength: 1, maxLength: 500 }, options: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 160 }, maxItems: 20 } }, required: ['question'], additionalProperties: false },
    executionMode: 'sequential',
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const value = await dialog(ctx, { kind: 'question', title: params.question, toolCallId }, params.options, signal);
      return { content: [{ type: 'text', text: value === undefined ? 'User cancelled the question.' : value }], details: {} };
    },
  });
}
