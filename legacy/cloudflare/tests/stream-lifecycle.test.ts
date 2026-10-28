import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultChannelConfig, defaultSettings, type AttemptRecord, type GatewayChannel, type GatewayLog } from '../shared/types';
import { handleGateway } from '../worker/gateway';
import type { GatewayContext, GatewayStore } from '../worker/env';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const content = 'data: {"choices":[{"delta":{"content":"first token"}}]}\n\n';
const terminal = 'data: [DONE]\n\n';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Stream output waited for unrelated persistence')), 500); });
  try { return await Promise.race([promise, deadline]); } finally { clearTimeout(timer!); }
}
function setup() {
  const attempts: AttemptRecord[] = [], logs: GatewayLog[] = [], background: Promise<unknown>[] = [];
  const channel: GatewayChannel = {
    id: 'lifecycle', name: 'Stream lifecycle', provider: 'OpenAI', model: 'test', models: ['test'], tags: [], weight: 1,
    endpoint: 'https://stream-lifecycle.example/v1', status: 'healthy', priority: 0, ttft: 0, successRate: 100, requests: 0,
    enabled: true, color: '', history: [], createdAt: new Date().toISOString(), archived: false, credentialCount: 1,
    health: { averageTtft: null, averageDuration: null, samples: 0, cooldownUntil: null, recoveryCount: 0, failureCount: 0, reason: null, autoDisabled: false },
    config: structuredClone(defaultChannelConfig),
  };
  const context: GatewayContext = {
    channels: [channel], env: {} as GatewayContext['env'], ctx: { waitUntil(task: Promise<unknown>) { background.push(task); } } as ExecutionContext,
    settings: { ...defaultSettings, retryEnabled: false, stickyMode: 'off', errorMode: 'raw' }, key: null, profile: null, source: 'api', relayProtocol: 'openai',
  };
  const store: GatewayStore = {
    getCredentials: async () => [{ id: 'credential', label: 'synthetic', secret: 'synthetic-lifecycle-key', enabled: true, failureCount: 0, disabledAt: null }],
    recordAttempt: async value => { attempts.push(value); }, recordLog: async value => { logs.push(value); }, recordEvent: async () => {},
    getRecentAttempts: async () => [], updateHealth: async () => {}, setCredentialHealth: async () => {}, incrementKeyUsage: async () => true,
    nextRoundRobin: async () => 0, getSticky: async () => null, setSticky: async () => {}, getAiGatewayToken: async () => null, reserveChannel: async () => true,
  };
  const request = () => new Request('https://gateway.test/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-trace-id': 'lifecycle-test' }, body: JSON.stringify({ model: 'test', messages: [], stream: true }) });
  const flush = async () => { while (background.length) await Promise.all(background.splice(0)); };
  return { context, store, attempts, logs, request, flush, background };
}
function provider(text: string) { return new Response(text, { headers: { 'content-type': 'text/event-stream' } }); }
afterEach(() => vi.unstubAllGlobals());

describe('stream transport does not wait for ancillary storage', () => {
  it('delivers the first token while sticky affinity storage is still pending', async () => {
    const { context, store, request, flush, background } = setup(), gate = deferred(), started = deferred();
    context.settings.stickyMode = 'prefer'; store.setSticky = async () => { started.resolve(); await gate.promise; };
    vi.stubGlobal('fetch', vi.fn(async () => provider(content + terminal)));
    const dispatched = handleGateway(request(), context, store);
    try {
      await started.promise;
      const response = await promptly(dispatched);
      expect(await promptly(response.text())).toBe(content + terminal); expect(background.length).toBeGreaterThan(0);
    } finally { gate.resolve(); await dispatched; await flush(); }
  });

  it.each(['recordAttempt', 'recordLog'] as const)('delivers the terminal frame and EOF while %s is still pending', async operation => {
    const { context, store, attempts, logs, request, flush } = setup(), gate = deferred();
    if (operation === 'recordAttempt') store.recordAttempt = async value => { await gate.promise; attempts.push(value); };
    else store.recordLog = async value => { await gate.promise; logs.push(value); };
    vi.stubGlobal('fetch', vi.fn(async () => provider(content + terminal)));
    try {
      const response = await handleGateway(request(), context, store);
      expect(await promptly(response.text())).toBe(content + terminal);
      expect(logs).toHaveLength(0);
      if (operation === 'recordAttempt') expect(attempts).toHaveLength(0);
    } finally { gate.resolve(); await flush(); }
    expect(attempts).toHaveLength(1); expect(logs).toHaveLength(1); expect(attempts[0].result).toBe('success');
  });

  it('forwards an upstream read failure without waiting for the failure log to persist', async () => {
    const { context, store, attempts, logs, request, flush } = setup(), gate = deferred();
    store.recordAttempt = async value => { await gate.promise; attempts.push(value); };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(output) { output.enqueue(encoder.encode(content)); }, pull(output) { output.error(new Error('Synthetic upstream disconnected')); } }), { headers: { 'content-type': 'text/event-stream' } })));
    try {
      const response = await handleGateway(request(), context, store);
      await expect(promptly(response.text())).rejects.toThrow('Synthetic upstream disconnected'); expect(attempts).toHaveLength(0);
    } finally { gate.resolve(); await flush(); }
    expect(attempts).toHaveLength(1); expect(attempts[0]).toMatchObject({ status: 502, result: 'error' }); expect(logs).toHaveLength(1);
  });

  it('aborts an upstream pending read promptly when the downstream cancels, even while logging is delayed', async () => {
    const { context, store, attempts, logs, request, flush } = setup(), gate = deferred();
    let upstreamSignal: AbortSignal | undefined, cancelled = false;
    store.recordAttempt = async value => { await gate.promise; attempts.push(value); };
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      upstreamSignal = init?.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({ start(output) { output.enqueue(encoder.encode(content)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
    }));
    try {
      const response = await handleGateway(request(), context, store), reader = response.body!.getReader();
      expect(decoder.decode((await reader.read()).value)).toBe(content);
      const pending = reader.read(); await promptly(reader.cancel()); await promptly(pending);
      expect(upstreamSignal?.aborted).toBe(true); expect(cancelled).toBe(true);
    } finally { gate.resolve(); await flush(); }
    expect(attempts).toHaveLength(1); expect(attempts[0]).toMatchObject({ result: 'cancelled', status: 499 }); expect(logs).toHaveLength(1);
  });

  it('keeps a delivered terminal response successful when the consumer closes immediately after DONE', async () => {
    const { context, store, attempts, logs, request, flush } = setup(), gate = deferred();
    store.recordAttempt = async value => { await gate.promise; attempts.push(value); };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(output) { output.enqueue(encoder.encode(content + terminal)); } }), { headers: { 'content-type': 'text/event-stream' } })));
    try {
      const response = await handleGateway(request(), context, store), reader = response.body!.getReader();
      expect(decoder.decode((await reader.read()).value)).toBe(content);
      expect(decoder.decode((await promptly(reader.read())).value)).toBe(terminal);
      await promptly(reader.cancel());
    } finally { gate.resolve(); await flush(); }
    expect(attempts).toHaveLength(1); expect(attempts[0]).toMatchObject({ result: 'success', status: 200 }); expect(logs).toHaveLength(1);
  });
});
