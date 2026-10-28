export type SSEEvent = { event: string; data: string };
export class StreamFailure extends Error {
  constructor(message: string, public status = 502, public kind: 'error' | 'empty' = 'error') { super(message); }
}

/** Incremental SSE framing: works across split UTF-8, CRLF, multiline data and heartbeat comments. */
export async function* parseSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', event = 'message', data: string[] = [];
  let frameBytes = 0;
  const countBytes = (size: number) => {
    frameBytes += size;
    if (frameBytes > 1024 * 1024) throw new StreamFailure('Upstream SSE event exceeded 1 MiB');
  };
  const line = (raw: string): SSEEvent | undefined => {
    const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!value) {
      const complete = data.length ? { event, data: data.join('\n') } : undefined;
      event = 'message'; data = []; frameBytes = 0;
      return complete;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':'), field = colon < 0 ? value : value.slice(0, colon);
    const content = colon < 0 ? '' : value.slice(colon + 1);
    const parsed = content.startsWith(' ') ? content.slice(1) : content;
    if (field === 'event') event = parsed;
    else if (field === 'data') data.push(parsed);
  };
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
      const { value, done } = await reader.read();
      if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
      if (done) {
        buffer += decoder.decode();
        const complete = buffer ? line(buffer) : undefined;
        if (complete) yield complete;
        if (data.length) yield { event, data: data.join('\n') };
        break;
      }
      let offset = 0, newline: number;
      while ((newline = value.indexOf(10, offset)) >= 0) {
        if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
        countBytes(newline + 1 - offset);
        buffer += decoder.decode(value.subarray(offset, newline + 1), { stream: true });
        const complete = line(buffer.slice(0, -1)); buffer = '';
        offset = newline + 1;
        if (complete) yield complete;
      }
      if (offset < value.length) {
        if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
        countBytes(value.length - offset);
        buffer += decoder.decode(value.subarray(offset), { stream: true });
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function meaningfulOpenAIChunk(value: Record<string, any>): boolean {
  return (value.choices || []).some((choice: any) => {
    const delta = choice.delta || choice.message || {};
    return (typeof delta.content === 'string' && delta.content.length > 0) ||
      (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) ||
      (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) ||
      (typeof delta.refusal === 'string' && delta.refusal.length > 0) ||
      (Array.isArray(delta.tool_calls) && delta.tool_calls.some((t: any) => t.function?.name || t.function?.arguments || t.id)) ||
      Boolean(delta.function_call?.name || delta.function_call?.arguments);
  });
}
export function sseBytes(value: unknown): Uint8Array { return new TextEncoder().encode(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`); }
