import { describe, expect, it } from 'vitest';
import { defaultChannelConfig, type GatewayChannel } from '../shared/types';
import { normalizedStream } from '../worker/protocols';
import { meaningfulOpenAIChunk, parseSSE } from '../worker/sse';

function fragmented(text: string) { const bytes = new TextEncoder().encode(text); return new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } }); }
describe('SSE parsing', () => {
  it('handles UTF-8 boundaries, CRLF, heartbeat comments and multiline data', async () => {
    const result = []; for await (const event of parseSSE(fragmented(':ping\r\n\r\nevent: custom\r\ndata: 你好\r\ndata: world\r\n\r\ndata: [DONE]\n\n'))) result.push(event);
    expect(result).toEqual([{ event: 'custom', data: '你好\nworld' }, { event: 'message', data: '[DONE]' }]);
  });
  it('does not classify role, usage or empty delta as model content', () => {
    expect(meaningfulOpenAIChunk({ choices: [{ delta: { role: 'assistant', content: '' } }], usage: { prompt_tokens: 1 } })).toBe(false);
    expect(meaningfulOpenAIChunk({ choices: [{ delta: { reasoning_content: 'thinking' } }] })).toBe(true);
    expect(meaningfulOpenAIChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'fn' } }] } }] })).toBe(true);
  });
  it('normalizes Anthropic tool JSON fragments, reasoning and completion marker', async () => {
    const channel = { config: { ...defaultChannelConfig, protocol: 'anthropic' } } as GatewayChannel;
    const events = [ { type: 'message_start', message: { id: 'msg1', usage: { input_tokens: 8 } } }, { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool1', name: 'weather' } }, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":"Shanghai"}' } }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reason' } }, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }, { type: 'message_stop' } ];
    const results = []; for await (const event of normalizedStream(fragmented(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')), channel, 'public', new AbortController().signal)) results.push(event);
    expect(results.at(-1)).toBe('[DONE]'); expect((results[1] as any).choices[0].delta.tool_calls[0].function.name).toBe('weather'); expect((results[3] as any).choices[0].delta.reasoning_content).toBe('reason'); expect((results[4] as any).usage.total_tokens).toBe(12);
  });
  it('rejects truncated streams instead of declaring partial output successful', async () => {
    const channel = { config: { ...defaultChannelConfig, protocol: 'openai' } } as GatewayChannel;
    await expect((async () => { for await (const _ of normalizedStream(fragmented('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'), channel, 'test', new AbortController().signal)) { /* drain */ } })()).rejects.toThrow('completion marker');
  });
});
