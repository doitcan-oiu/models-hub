import { describe, expect, it } from 'vitest';
import { relayStream } from '../worker/relay';
import { parseSSE } from '../worker/sse';

const encoder = new TextEncoder(), limit = 1024 * 1024;
const parsers = [
  { name: 'relayStream', parse: (body: ReadableStream<Uint8Array>, signal: AbortSignal) => relayStream(body, 'client-model', false, signal) },
  { name: 'parseSSE', parse: (body: ReadableStream<Uint8Array>, signal: AbortSignal) => parseSSE(body, signal) },
];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}
async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Parser lifecycle did not settle promptly')), 250);
    })]);
  } finally { clearTimeout(timer); }
}

describe('stream parser cancellation does not wait on underlying cleanup', () => {
  it.each(parsers)('$name settles pending next and queued return after abort while source cancellation is still pending', async ({ parse }) => {
    const cleanup = deferred(), controller = new AbortController();
    let cancellations = 0;
    const source = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() { cancellations++; return cleanup.promise; },
    });
    const iterator = parse(source, controller.signal);
    const reading = iterator.next().then(() => 'unexpected output', error => error.name);
    const closing = iterator.return(undefined);
    controller.abort();
    try {
      expect(await promptly(reading)).toBe('AbortError');
      expect(await promptly(closing)).toMatchObject({ done: true });
      expect(cancellations).toBe(1);
      expect(source.locked).toBe(false);
    } finally { cleanup.resolve(); await Promise.allSettled([reading, closing]); }
  });

  it.each(parsers)('$name returns from a yielded frame even if source cancel never settles first', async ({ parse }) => {
    const cleanup = deferred();
    let cancellations = 0;
    const source = new ReadableStream<Uint8Array>({
      start(output) { output.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ready"}}]}\n\n')); },
      cancel() { cancellations++; return cleanup.promise; },
    });
    const iterator = parse(source, new AbortController().signal);
    expect((await iterator.next()).done).toBe(false);
    const closing = iterator.return(undefined);
    try {
      expect(await promptly(closing)).toMatchObject({ done: true });
      expect(cancellations).toBe(1);
      expect(source.locked).toBe(false);
    } finally { cleanup.resolve(); await closing; }
  });

  it('does not flush a buffered partial SSE line as content when an abort resolves a pending read', async () => {
    const controller = new AbortController(), cleanup = deferred();
    const source = new ReadableStream<Uint8Array>({
      start(output) { output.enqueue(encoder.encode('data: partial buffered output')); },
      cancel() { return cleanup.promise; },
    });
    const iterator = parseSSE(source, controller.signal), reading = iterator.next();
    // Let the parser consume the partial line and enter its next read.
    await Promise.resolve(); await Promise.resolve();
    controller.abort();
    try { await expect(promptly(reading)).rejects.toMatchObject({ name: 'AbortError' }); }
    finally { cleanup.resolve(); await iterator.return(undefined); }
  });
});

describe('parseSSE limits individual events instead of transport chunks', () => {
  it('parses a single chunk larger than 1MiB when each complete event is small', async () => {
    const raw = 'data: {"choices":[{"delta":{"content":"x"}}]}\r\n\r\n'.repeat(25000);
    expect(encoder.encode(raw).length).toBeGreaterThan(limit);
    let total = 0;
    for await (const event of parseSSE(new Response(raw).body!)) {
      expect(event.data).toBe('{"choices":[{"delta":{"content":"x"}}]}');
      total++;
    }
    expect(total).toBe(25000);
  });

  it('accepts the exact 1MiB frame boundary and rejects one extra byte', async () => {
    const raw = 'data: ' + 'x'.repeat(limit - 8) + '\n\n';
    expect(encoder.encode(raw).length).toBe(limit);
    const accepted = parseSSE(new Response(raw).body!);
    expect((await accepted.next()).value?.data.length).toBe(limit - 8);
    expect((await accepted.next()).done).toBe(true);
    const rejected = parseSSE(new Response(raw.replace('data: ', 'data:  ')).body!);
    await expect(rejected.next()).rejects.toThrow('SSE event exceeded 1 MiB');
  });

  it('rejects an oversized event spread across many short data lines and read chunks', async () => {
    const chunk = encoder.encode('data: ' + 'x'.repeat(64 * 1024) + '\n');
    let pulls = 0, cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(output) { pulls++; output.enqueue(chunk); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    await expect(parseSSE(source).next()).rejects.toThrow('SSE event exceeded 1 MiB');
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(18);
    expect(source.locked).toBe(false);
  });

  it('yields preceding valid events before rejecting a later oversized frame in the same chunk', async () => {
    const iterator = parseSSE(new Response('data: ready\n\n' + 'data: ' + 'x'.repeat(limit) + '\n\n').body!);
    expect(await iterator.next()).toMatchObject({ done: false, value: { event: 'message', data: 'ready' } });
    await expect(iterator.next()).rejects.toThrow('SSE event exceeded 1 MiB');
  });

  it('preserves UTF-8, split CRLF, multiline data and normal EOF without a final newline', async () => {
    const bytes = encoder.encode(': heartbeat\r\nevent: custom\r\ndata: 中文\r\ndata:  leading space');
    const source = new ReadableStream<Uint8Array>({ start(output) {
      for (let offset = 0; offset < bytes.length; offset++) output.enqueue(bytes.slice(offset, offset + 1));
      output.close();
    } });
    const events = [];
    for await (const event of parseSSE(source)) events.push(event);
    expect(events).toEqual([{ event: 'custom', data: '中文\n leading space' }]);
  });

  it('preserves an event when EOF arrives after a trailing CR delimiter', async () => {
    const events = [];
    for await (const event of parseSSE(new Response('data: ready\n\r').body!)) events.push(event);
    expect(events).toEqual([{ event: 'message', data: 'ready' }]);
  });
});
