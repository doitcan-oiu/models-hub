import type { GatewayChannel } from '../shared/types';
import { sseBytes } from './sse';

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Request cancelled', 'AbortError')); return; }
    const abort = () => { clearTimeout(timer); reject(new DOMException('Request cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, Math.max(0, ms));
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function mockUpstream(channel: GatewayChannel, body: Record<string, any>, attempt: number, signal: AbortSignal): Promise<Response> {
  const config = channel.config.mock;
  const failing = config.scenario === 'error' || (config.scenario === 'transient' && attempt <= config.failuresBeforeSuccess);
  const delay = config.delayMs;
  if (failing) { await sleep(delay, signal); return Response.json({ error: { message: '演示上游暂时不可用', type: 'mock_upstream_error' } }, { status: Math.max(400, config.status) }); }
  const id = `chatcmpl-${crypto.randomUUID()}`; const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model };
  const prompt = [...(body.messages || [])].reverse().find((m: any) => m.role === 'user')?.content;
  const text = `你好！这是 ${channel.name} 的本地演示响应。${typeof prompt === 'string' ? `\n\n你发送了：${prompt}` : ''}\n\n网关已记录首字延迟、渠道选择和请求轨迹。`;
  if (!body.stream) {
    await sleep(delay, signal);
    if (config.scenario === 'disconnect') throw new Error('Mock connection reset');
    return Response.json({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: config.scenario === 'empty' ? '' : text }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: config.scenario === 'empty' ? 0 : Math.ceil(text.length / 2), total_tokens: 12 + Math.ceil(text.length / 2) } });
  }
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(sseBytes({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }));
        await sleep(delay, signal);
        if (config.scenario !== 'empty') {
          const pieces = text.match(/.{1,10}|\n/gs) || [text];
          for (let i = 0; i < pieces.length; i++) {
            if (cancelled) return;
            controller.enqueue(sseBytes({ ...base, choices: [{ index: 0, delta: { content: pieces[i] }, finish_reason: null }] }));
            if (config.scenario === 'disconnect' && i === 1) throw new Error('Mock stream disconnected after content');
            await sleep(8, signal);
          }
        }
        if (cancelled) return;
        controller.enqueue(sseBytes({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: config.scenario === 'empty' ? 0 : Math.ceil(text.length / 2) } }));
        controller.enqueue(sseBytes('[DONE]')); controller.close();
      } catch (error) { if (!cancelled) controller.error(error); }
    },
    cancel() { cancelled = true; },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}
