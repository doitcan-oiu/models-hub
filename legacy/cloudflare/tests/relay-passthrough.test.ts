import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultChannelConfig, defaultSettings, type AttemptRecord, type GatewayChannel, type GatewayLog, type KeyProfile } from '../shared/types';
import type { GatewayContext, GatewayStore } from '../worker/env';
import { handleAnthropicMessages } from '../worker/anthropic-ingress';
import { handleGateway } from '../worker/gateway';
import { parseSSE } from '../worker/sse';
import { relayStream } from '../worker/relay';

type RelayProtocol = 'openai' | 'anthropic';
type ChannelProtocol = 'openai' | 'anthropic' | 'gemini';
const clientModel = 'client-alias', upstreamModel = 'provider-model', upstreamSecret = 'upstream-private-secret';
const encoder = new TextEncoder();
const backgroundTasks: Promise<unknown>[] = [];
async function flush() { while (backgroundTasks.length) await Promise.all(backgroundTasks.splice(0)); }
function channel(id = 'primary', actualModel = upstreamModel, protocol: ChannelProtocol = 'anthropic', alias = true): GatewayChannel {
  return { id, name: id, provider: protocol, model: actualModel, models: [actualModel], tags: ['production'], weight: 1, endpoint: `https://${id}.example`, status: 'healthy', priority: id === 'primary' ? 0 : 1, ttft: 0, successRate: 100, requests: 0, enabled: true, color: '#000', history: [], createdAt: new Date().toISOString(), archived: false, credentialCount: 1,
    health: { averageTtft: null, averageDuration: null, samples: 0, cooldownUntil: null, recoveryCount: 0, failureCount: 0, reason: null, autoDisabled: false },
    config: { ...structuredClone(defaultChannelConfig), protocol, aliases: alias ? [{ from: clientModel, to: actualModel }] : [] } };
}
function setup(channels = [channel()]) {
  const attempts: AttemptRecord[] = [], logs: GatewayLog[] = [];
  const context: GatewayContext = { channels, settings: { ...defaultSettings, errorMode: 'raw', retryEnabled: false, emptyResponseDetection: false }, env: {} as GatewayContext['env'], ctx: { waitUntil: vi.fn((task: Promise<unknown>) => { backgroundTasks.push(task); }) } as unknown as ExecutionContext, key: null, profile: null, source: 'api' };
  const store: GatewayStore = {
    getCredentials: async () => [{ id: 'credential', label: 'upstream', secret: upstreamSecret, enabled: true, failureCount: 0, disabledAt: null }],
    recordAttempt: async value => { attempts.push(value); }, recordLog: async value => { logs.push(value); }, recordEvent: vi.fn(async () => {}),
    getRecentAttempts: async () => [], updateHealth: vi.fn(async () => {}), setCredentialHealth: vi.fn(async () => {}), incrementKeyUsage: vi.fn(async () => true),
    nextRoundRobin: async () => 0, getSticky: async () => null, setSticky: async () => {}, getAiGatewayToken: async () => null, reserveChannel: vi.fn(async () => true),
  };
  return { context, store, attempts, logs, flush };
}
function request(body: unknown, protocol: RelayProtocol = 'anthropic', signal?: AbortSignal) {
  return new Request('https://gateway.test/v1/' + (protocol === 'anthropic' ? 'messages' : 'chat/completions'), { method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-api-key': 'pg_live_client', authorization: 'Bearer pg_live_client', 'x-trace-id': 'transparent-relay', 'anthropic-version': '2024-01-01', 'anthropic-beta': 'prompt-caching-2024-07-31,tools-2024-05-16' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
function dispatch(body: unknown, context: GatewayContext, store: GatewayStore, protocol: RelayProtocol = 'anthropic') {
  const incoming = request(body, protocol);
  return protocol === 'anthropic' ? handleAnthropicMessages(incoming, undefined, context, store) : handleGateway(incoming, { ...context, relayProtocol: protocol }, store);
}
function nativeMessage() {
  return { id: 'msg_provider', type: 'message', role: 'assistant', model: 'provider-snapshot', content: [{ type: 'text', text: 'Answer', vendor_annotation: { preserved: true } }], stop_reason: 'future_stop', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: 5, cache_read_input_tokens: 7 }, vendor_message: { nullable: null, nested: ['preserve', { model: 'nested-model' }] } };
}
function chatCompletion() {
  return { id: 'chatcmpl_provider', object: 'chat.completion', model: 'provider-snapshot', choices: [{ index: 0, message: { role: 'assistant', content: 'Answer', vendor_field: null }, finish_reason: 'future_stop', unknown: [] }], usage: { prompt_tokens: 14, completion_tokens: 3, total_tokens: 17 }, vendor_message: { model: 'nested-model', nullable: null } };
}
type Event = { event: string; data: Record<string, any> };
const frame = (event: Event) => encoder.encode(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
function streaming(events: Event[]) { return new Response(events.map(event => new TextDecoder().decode(frame(event))).join(''), { headers: { 'content-type': 'text/event-stream' } }); }
async function readEvents(response: Response): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of parseSSE(response.body!)) events.push({ event: event.event, data: JSON.parse(event.data) });
  return events;
}
function nativeEvents(): Event[] {
  return [
    { event: 'message_start', data: { type: 'message_start', model: upstreamModel, vendor_start: null, message: { id: 'msg_stream', type: 'message', role: 'assistant', model: upstreamModel, content: [], usage: { input_tokens: 2, output_tokens: 0 }, vendor_message: { model: 'nested-model' } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' }, unknown_start: 1 } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Answer', future_delta: [null, { vendor: true }] } } },
    { event: 'vendor_progress', data: { type: 'different_vendor_payload_type', model: upstreamModel, nested: { model: 'nested-model', extra: null }, vendor_progress: 7 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'future_provider_stop', vendor_delta: 1 }, usage: { output_tokens: 3, vendor_tokens: 9 }, extra: null } },
    { event: 'message_stop', data: { type: 'message_stop', model: upstreamModel, future_stop_metadata: { preserved: true } } },
  ];
}

afterEach(async () => { await flush(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('public relay preserves the incoming protocol and provider payloads', () => {
  it.each((['anthropic', 'openai'] as const).flatMap(incoming => (['openai', 'anthropic', 'gemini'] as const).map(configured => ({ incoming, configured }))))('keeps $incoming path, body and JSON response through a $configured channel', async ({ incoming, configured }) => {
    const { context, store, attempts, logs } = setup([channel('primary', upstreamModel, configured)]);
    const body = incoming === 'anthropic'
      ? { model: clientModel, thinking: { type: 'adaptive', vendor: null }, top_k: 17, metadata: null, messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'Thought', signature: 'opaque' }, { type: 'text', text: 'Answer' }] }], vendor_field: [null, { retained: true }] }
      : { model: clientModel, messages: [], temperature: { vendor: true }, response_format: null, extra_body: { future: true } };
    const upstream = incoming === 'anthropic' ? nativeMessage() : chatCompletion(), original = structuredClone(body);
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://primary.example/v1/' + (incoming === 'anthropic' ? 'messages' : 'chat/completions'));
      expect(JSON.parse(String(init?.body))).toEqual({ ...body, model: upstreamModel });
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(incoming === 'openai' ? 'Bearer ' + upstreamSecret : null);
      expect(headers.get('x-api-key')).toBe(incoming === 'anthropic' ? upstreamSecret : null); expect(headers.get('x-goog-api-key')).toBeNull();
      if (incoming === 'anthropic') { expect(headers.get('anthropic-version')).toBe('2024-01-01'); expect(headers.get('anthropic-beta')).toBe('prompt-caching-2024-07-31,tools-2024-05-16'); }
      return Response.json(upstream, { headers: { 'x-provider-extension': 'preserved' } });
    }); vi.stubGlobal('fetch', fetcher);
    const response = await dispatch(body, context, store, incoming);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ...upstream, model: clientModel }); expect(body).toEqual(original);
    expect(response.headers.get('x-provider-extension')).toBe('preserved'); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(attempts[0]).toMatchObject({ model: upstreamModel, result: 'success', status: 200 }); expect(logs[0]).toMatchObject({ model: clientModel, tokens: 17, result: 'success' });
  });

  it.each(['anthropic', 'openai'] as const)('preserves exact request and JSON response text without aliases or overrides through the %s entry', async incoming => {
    const { context, store } = setup([channel('primary', upstreamModel, incoming === 'anthropic' ? 'openai' : 'gemini', false)]);
    const raw = '{\r\n  "unknown" : [null, {"key":"值"}], "messages" : [],\r\n  "model" : "provider-model", "stream" : false, "temperature" : null\r\n}\n';
    const upstream = '{\r\n "vendor" : { "unknown":null }, "model" : "provider-model", "content" : [{"type":"future","answer":"值"}], "usage": {"input_tokens":2,"output_tokens":3}\r\n}\n';
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { expect(init?.body).toBe(raw); return new Response(upstream, { headers: { 'content-type': 'application/json; charset=utf-8' } }); }));
    const response = await dispatch(raw, context, store, incoming);
    expect(response.status).toBe(200); expect(await response.text()).toBe(upstream);
  });

  it.each([204, 205, 304])('preserves an upstream %s without a body or empty-response rejection', async status => {
    const { context, store, attempts, logs } = setup([channel('primary', upstreamModel, 'openai')]); context.settings.emptyResponseDetection = true;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status, statusText: 'Provider status reason', headers: { 'x-provider-empty': 'original', 'content-type': 'application/json' } })));
    const response = await dispatch({ model: clientModel }, context, store);
    expect(response.status).toBe(status); expect(response.statusText).toBe('Provider status reason'); expect(response.body).toBeNull(); expect(await response.text()).toBe(''); expect(response.headers.get('x-provider-empty')).toBe('original');
    expect(attempts[0]).toMatchObject({ status, result: status < 300 ? 'success' : 'error' }); expect(logs[0]).toMatchObject({ status, result: status < 300 ? 'success' : 'error' });
  });

  it('forwards the input query and preserves the provider status text through the native entry', async () => {
    const { context, store } = setup([channel('primary', upstreamModel, 'openai')]), body = { model: clientModel, arbitrary: null };
    const source = request(body), incoming = new Request(source.url + '?beta=true&client_option=%2F%20', { method: 'POST', headers: source.headers, body: JSON.stringify(body) });
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = new URL(String(url)); expect(target.origin + target.pathname).toBe('https://primary.example/v1/messages'); expect(target.searchParams.get('beta')).toBe('true'); expect(target.searchParams.get('client_option')).toBe('/ '); expect(JSON.parse(String(init?.body))).toEqual({ ...body, model: upstreamModel });
      return Response.json(nativeMessage(), { status: 201, statusText: 'Provider generated', headers: { 'x-provider-status': 'original' } });
    }));
    const response = await handleAnthropicMessages(incoming, undefined, context, store);
    expect(response.status).toBe(201); expect(response.statusText).toBe('Provider generated'); expect(response.headers.get('x-provider-status')).toBe('original'); expect(await response.json()).toEqual({ ...nativeMessage(), model: clientModel });
  });

  it('forwards arbitrary optional values and missing message fields to the upstream without validating their schema', async () => {
    const values = [{ model: clientModel }, { model: clientModel, max_tokens: 0 }, { model: clientModel, max_tokens: -1, temperature: [] }, { model: clientModel, max_tokens: null, metadata: null }, { model: clientModel, messages: [], stream: 'true' }, { model: clientModel, messages: [{ role: 'system', content: null }], stream: { vendor: true } }];
    const sent: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body))); return Response.json(nativeMessage()); }));
    for (const body of values) {
      const { context, store } = setup([channel('primary', upstreamModel, 'gemini')]);
      const response = await dispatch(body, context, store); expect(response.status).toBe(200); await response.text();
    }
    expect(sent).toEqual(values.map(body => ({ ...body, model: upstreamModel })));
  });

  it('forwards complex native history, MCP, server tools, cache controls and unknown fields without reordering or normalizing blocks', async () => {
    const body = { model: clientModel, max_tokens: null, stream: false, metadata: null, output_config: { effort: 'high', future: null }, thinking: { type: 'adaptive', display: 'summarized' }, cache_control: { type: 'ephemeral', ttl: '1h' }, container: { id: 'container', vendor: true },
      mcp_servers: [{ type: 'url', url: 'https://mcp.example', name: 'server', custom_field: [null, 1] }], unknown_top_level: { arbitrary: [{ key: 'value' }], model: 'nested-model' },
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1, future_field: null }, { name: 'custom', input_schema: { type: 'object' }, strict: true }], tool_choice: { type: 'auto', disable_parallel_tool_use: true, future_option: null },
      messages: [
        { role: 'user', custom_message_field: null, content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' }, citations: { enabled: true }, title: 'Document' }, { type: 'text', text: 'Inspect', cache_control: { type: 'ephemeral' } }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'Preserved reasoning', signature: 'opaque-signature', extra: true }, { type: 'redacted_thinking', data: 'opaque-redacted' }, { type: 'server_tool_use', id: 'server_tool', name: 'web_search', input: { query: 'topic' } }, { type: 'tool_use', id: 'tool_one', name: 'custom', input: {} }, { type: 'text', text: 'Text after tool' }, { type: 'tool_use', id: 'tool_two', name: 'custom', input: { second: true } }] },
        { role: 'user', content: [{ type: 'text', text: 'Text before results' }, { type: 'tool_result', tool_use_id: 'tool_one', content: [{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'Failure detail' } }], is_error: true }, { type: 'tool_result', tool_use_id: 'tool_two', content: 'Done', future_result: null }] },
      ] };
    const { context, store } = setup([channel('primary', upstreamModel, 'openai')]);
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { expect(JSON.parse(String(init?.body))).toEqual({ ...body, model: upstreamModel }); return Response.json(nativeMessage()); }));
    const response = await dispatch(body, context, store); expect(response.status).toBe(200); await response.text();
  });

  it('preserves native tool-result blocks, future stop reasons and extension fields while changing only public model identity', async () => {
    const { context, store, attempts, logs } = setup([channel('primary', upstreamModel, 'openai')]);
    const native = { ...nativeMessage(), content: [{ type: 'server_tool_use', id: 'srv_one', name: 'web_search', input: { query: 'topic' }, future: null }, { type: 'web_search_tool_result', tool_use_id: 'srv_one', content: [{ type: 'web_search_result', url: 'https://example.test', encrypted_content: 'opaque' }] }, { type: 'future_content_block', nested: { model: 'nested-model', answer: 'Answer' } }], stop_sequence: 'CUSTOM' };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(native)));
    const response = await dispatch({ model: clientModel }, context, store);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ...native, model: clientModel }); expect(attempts[0].result).toBe('success'); expect(logs[0].tokens).toBe(17);
  });

  it('uses unknown nested content for empty-response observation without requiring known provider block types', async () => {
    const { context, store, attempts, logs } = setup([channel('primary', upstreamModel, 'openai')]); context.settings.emptyResponseDetection = true;
    const native = { ...nativeMessage(), content: [{ type: 'future_content_block', nested: { payload: { answer: 'Actual reply' }, metadata: { ignored: true } } }] };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(native)));
    const response = await dispatch({ model: clientModel }, context, store);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ...native, model: clientModel });
    expect(attempts[0].result).toBe('success'); expect(logs[0].result).toBe('success');
  });

  it('still applies configured empty-response detection to metadata-only streams and records a failed health sample', async () => {
    const { context, store, attempts, logs } = setup([channel('primary', upstreamModel, 'gemini')]); context.settings.emptyResponseDetection = true;
    const events: Event[] = [nativeEvents()[0], { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'future_content_block', metadata: { vendor: 'tracking' }, nested: { signature: 'opaque' } } } }, { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque' } } }, ...nativeEvents().slice(-2)];
    vi.stubGlobal('fetch', vi.fn(async () => streaming(events)));
    const response = await dispatch({ model: clientModel, stream: true }, context, store);
    expect(response.status).toBe(502); expect(await response.json()).toMatchObject({ type: 'error' });
    expect(attempts[0]).toMatchObject({ result: 'empty', status: 502, ttft: null }); expect(logs[0].result).toBe('error');
  });

  it.each(['anthropic', 'openai'] as const)('preserves all SSE bytes, unknown events and non-JSON data without a model rewrite through %s', async incoming => {
    const { context, store, attempts, logs } = setup([channel('primary', upstreamModel, 'gemini', false)]);
    const raw = ': provider heartbeat\r\nretry: 2500\r\nid: first\r\nevent: vendor_progress\r\ndata: opaque non-JSON payload\r\ndata: continuation 值\r\n\r\n: another comment\n\nevent: future_response\r\nid: second\r\ndata: { "model" : "provider-model", "unknown" : { "value":null } }\r\n\r\ndata: [DONE]\r\n\r\n: provider trailer\r\n\r\nid: final\r\ndata: opaque EOF tail 值';
    const bytes = encoder.encode(raw);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(output) { for (let offset = 0; offset < bytes.length; offset += 7) output.enqueue(bytes.slice(offset, offset + 7)); output.close(); } }), { headers: { 'content-type': 'text/event-stream', 'x-provider-extension': 'stream' } })));
    const response = await dispatch({ model: upstreamModel, stream: true }, context, store, incoming);
    expect(response.status).toBe(200); expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes); expect(response.headers.get('x-provider-extension')).toBe('stream');
    expect(attempts[0]).toMatchObject({ result: 'success', status: 200 }); expect(logs[0]).toMatchObject({ model: upstreamModel, result: 'success' });
  });

  it('relays an actual SSE response even when the original request does not ask for streaming', async () => {
    const { context, store } = setup([channel('primary', upstreamModel, 'gemini', false)]);
    const raw = 'event: future\r\nid: 1\r\ndata: unknown opaque output\r\n\r\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, { headers: { 'content-type': 'text/event-stream' } })));
    const response = await dispatch({ model: upstreamModel, stream: false }, context, store);
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('text/event-stream'); expect(await response.text()).toBe(raw);
  });

  it.each([
    { name: 'unknown JSON event', data: '{"type":"future_reply","vendor":{"answer":"Actual reply"},"nullable":null}' },
    { name: 'opaque non-JSON data', data: 'Opaque actual reply 值' },
  ])('accepts $name with default empty-response detection and records the provider SSE status', async ({ data }) => {
    const { context, store, attempts, logs } = setup([channel('primary', upstreamModel, 'gemini', false)]); context.settings.emptyResponseDetection = true;
    const raw = 'event: vendor_extension\r\nid: original\r\ndata: ' + data + '\r\n\r\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, { status: 201, statusText: 'Provider stream created', headers: { 'content-type': 'text/event-stream' } })));
    const response = await dispatch({ model: upstreamModel, stream: true }, context, store);
    expect(response.status).toBe(201); expect(response.statusText).toBe('Provider stream created'); expect(await response.text()).toBe(raw);
    expect(attempts[0]).toMatchObject({ result: 'success', status: 201, stream: true, ttft: expect.any(Number) }); expect(logs[0]).toMatchObject({ result: 'success', status: 201, stream: true });
  });

  it('retains native SSE event names and unknown fields while replacing root and message_start models only', async () => {
    const { context, store, attempts, logs } = setup([channel('primary', upstreamModel, 'openai')]);
    const native = nativeEvents(); vi.stubGlobal('fetch', vi.fn(async () => streaming(native)));
    const response = await dispatch({ model: clientModel, stream: true, vendor_stream: null }, context, store);
    const expected = native.map(({ event, data }) => ({ event, data: { ...data, ...(typeof data.model === 'string' ? { model: clientModel } : {}), ...(event === 'message_start' ? { message: { ...data.message, model: clientModel } } : {}) } }));
    expect(await readEvents(response)).toEqual(expected); await flush(); expect(attempts[0]).toMatchObject({ result: 'success', status: 200 }); expect(logs[0]).toMatchObject({ model: clientModel, result: 'success' });
  });

  it('preserves SSE comments, id, retry, event names, line endings and opaque data when another frame needs an alias rewrite', async () => {
    const { context, store } = setup([channel('primary', upstreamModel, 'gemini')]);
    const prefix = ': heartbeat\r\nretry: 1234\r\nid: opaque\r\nevent: custom\r\ndata: not JSON 值\r\n\r\n';
    const raw = prefix + 'id: model\r\nevent: arbitrary\r\ndata: {"model":"provider-model","nested":{"model":"nested-model"},"future":null}\r\n\r\n: final comment\r\n\r\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, { headers: { 'content-type': 'text/event-stream' } })));
    const response = await dispatch({ model: clientModel, stream: true }, context, store), actual = await response.text();
    await flush();
    expect(actual).toBe(raw.replace('"model":"provider-model"', '"model":"client-alias"'));
  });

  it('rejects only unusable JSON routing envelopes locally before quota or upstream dispatch', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const body of ['{', null, [], {}, { model: '' }, { model: 3 }]) {
      const { context, store, attempts } = setup();
      const response = await dispatch(body, context, store);
      expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
      expect(store.reserveChannel).not.toHaveBeenCalled(); expect(store.incrementKeyUsage).not.toHaveBeenCalled(); expect(attempts).toHaveLength(0);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('still enforces Key profile authorization before transparent dispatch or quota reservation', async () => {
    const { context, store, attempts } = setup();
    const profile: KeyProfile = { id: 'restricted', name: 'Restricted', scope: 'tags', tags: ['other'], match: 'any', channelIds: [], modelMode: 'all', models: [], requestLimit: '1', mappings: [] };
    context.profile = profile; context.key = { id: 'client-key', name: 'Client', preview: 'pg_masked', status: 'active', createdAt: new Date().toISOString(), expires: '', note: '', used: 0, activeProfile: profile.id, profiles: [profile], tokenHash: 'hash' };
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const response = await dispatch({ model: clientModel, unknown_option: true }, context, store);
    expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ type: 'error', error: { type: 'permission_error' } });
    expect(fetcher).not.toHaveBeenCalled(); expect(store.reserveChannel).not.toHaveBeenCalled(); expect(store.incrementKeyUsage).not.toHaveBeenCalled(); expect(attempts).toHaveLength(0);
  });

  it('replays the complete incoming body on failover with per-channel aliases despite different channel protocols', async () => {
    const body = { model: clientModel, thinking: { type: 'adaptive' }, metadata: null, vendor_option: { preserved: true } }, { context, store, attempts, logs } = setup([channel('primary', upstreamModel, 'openai'), channel('backup', 'backup-provider-model', 'gemini')]);
    context.settings.retryEnabled = true; context.settings.maxSameChannelRetries = 0; context.settings.retryDelayMs = 100;
    const sent: unknown[] = [], urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => { urls.push(String(url)); sent.push(JSON.parse(String(init?.body))); return sent.length === 1 ? Response.json({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, { status: 503 }) : Response.json(nativeMessage()); }));
    const response = await dispatch(body, context, store);
    expect(response.status).toBe(200); expect((await response.json() as any).model).toBe(clientModel); expect(response.headers.get('x-pulsegate-channel-id')).toBe('backup');
    expect(urls).toEqual(['https://primary.example/v1/messages', 'https://backup.example/v1/messages']); expect(sent).toEqual([{ ...body, model: upstreamModel }, { ...body, model: 'backup-provider-model' }]);
    expect(attempts.map(attempt => [attempt.channelId, attempt.status, attempt.result])).toEqual([['primary', 503, 'error'], ['backup', 200, 'success']]); expect(logs[0]).toMatchObject({ result: 'failover', model: clientModel, attempts: 2 });
    expect(store.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'switch', channelId: 'backup' }));
  });

  it('refreshes managed credentials on same-channel retries without forwarding the client key', async () => {
    const { context, store, attempts } = setup([channel('primary', upstreamModel, 'openai')]);
    context.settings.retryEnabled = true; context.settings.maxSameChannelRetries = 1; context.settings.maxChannelRetries = 0; context.settings.retryDelayMs = 100;
    let credentialCalls = 0; store.getCredentials = async () => [{ id: 'credential', label: 'upstream', secret: credentialCalls++ ? 'replacement-upstream-secret' : upstreamSecret, enabled: true, failureCount: 0, disabledAt: null }];
    const keys: (string | null)[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { const headers = new Headers(init?.headers); keys.push(headers.get('x-api-key')); expect(headers.get('authorization')).toBeNull(); return keys.length === 1 ? Response.json({ error: { message: 'busy' } }, { status: 503 }) : Response.json(nativeMessage()); }));
    const response = await dispatch({ model: clientModel, top_k: 9 }, context, store);
    expect(response.status).toBe(200); await response.text(); expect(keys).toEqual([upstreamSecret, 'replacement-upstream-secret']); expect(attempts.map(attempt => attempt.status)).toEqual([503, 200]);
  });

  it('returns the exact upstream HTTP error envelope and records a failed attempt without exposing managed secrets', async () => {
    const { context, store, attempts, logs } = setup();
    const raw = '{\r\n "type":"error", "error":{"type":"vendor_limit","message":"limited"}, "metadata":{"token":"public-diagnostic-id"}, "future":"' + 'x'.repeat(5000) + '"\r\n}\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '7', 'x-provider-error': 'original' } })));
    const response = await dispatch({ model: clientModel }, context, store);
    expect(response.status).toBe(429); expect(await response.text()).toBe(raw); expect(response.headers.get('retry-after')).toBe('7'); expect(response.headers.get('x-provider-error')).toBe('original');
    expect(attempts[0]).toMatchObject({ status: 429, result: 'error' }); expect(logs[0]).toMatchObject({ status: 429, result: 'error' });
    const second = setup(); vi.stubGlobal('fetch', vi.fn(async () => Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'limited ' + upstreamSecret } }, { status: 429 })));
    const safe = await dispatch({ model: clientModel }, second.context, second.store); expect(await safe.text()).not.toContain(upstreamSecret); expect(second.logs[0].error).not.toContain(upstreamSecret);
  });

  it('preserves a provider stream error frame after output and records failure without adding a success terminator', async () => {
    const { context, store, attempts, logs } = setup([channel('primary', upstreamModel, 'openai')]);
    const errorFrame = ': provider failure\r\nid: failed\r\nevent: error\r\ndata: {"type":"error","error":{"type":"vendor_error","message":"failed"},"unknown":null}\r\n\r\n';
    const raw = nativeEvents().slice(0, 3).map(event => new TextDecoder().decode(frame(event))).join('') + errorFrame;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, { headers: { 'content-type': 'text/event-stream' } })));
    const response = await dispatch({ model: clientModel, stream: true }, context, store), actual = await response.text();
    expect(actual).toContain('content_block_delta'); expect(actual.endsWith(errorFrame)).toBe(true); expect(actual).not.toContain('message_stop'); expect(actual).not.toContain('[DONE]');
    expect(attempts[0]).toMatchObject({ status: 200, result: 'error' }); expect(logs[0]).toMatchObject({ status: 200, result: 'error' });
  });

  it('redacts an actual managed secret in a provider error frame while preserving its event and other fields', async () => {
    const { context, store, attempts, logs } = setup();
    const native = nativeEvents().slice(0, 3); native.push({ event: 'error', data: { type: 'error', error: { type: 'vendor_error', message: 'failed ' + upstreamSecret }, future: null } });
    vi.stubGlobal('fetch', vi.fn(async () => streaming(native)));
    const response = await dispatch({ model: clientModel, stream: true }, context, store), text = await response.text();
    await flush();
    expect(text).not.toContain(upstreamSecret);
    const events = await readEvents(new Response(text)); expect(events.at(-1)).toMatchObject({ event: 'error', data: { type: 'error', error: { type: 'vendor_error' }, future: null } });
    expect(attempts[0]).toMatchObject({ result: 'error' }); expect(logs[0].error).not.toContain(upstreamSecret);
  });

  it('cancels the upstream source and aborts its fetch when the transparent downstream is cancelled', async () => {
    const { context, store, attempts, logs } = setup([channel('primary', upstreamModel, 'gemini')]);
    let cancelled = false, upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      upstreamSignal = init?.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({ start(output) { for (const event of nativeEvents().slice(0, 3)) output.enqueue(frame(event)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
    }));
    const response = await dispatch({ model: clientModel, stream: true }, context, store), reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: message_start'); await reader.cancel();
    await flush();
    expect(cancelled).toBe(true); expect(upstreamSignal?.aborted).toBe(true); expect(attempts[0]).toMatchObject({ status: 499, result: 'cancelled' }); expect(logs[0]).toMatchObject({ status: 499, result: 'error' });
  });

  it('surfaces a broken upstream stream as a read error without injecting protocol payloads into the original wire data', async () => {
    const { context, store, attempts, logs } = setup([channel('primary', upstreamModel, 'gemini')]);
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      upstreamSignal = init?.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({ start(output) { for (const event of nativeEvents().slice(0, 3)) output.enqueue(frame(event)); }, pull(output) { output.error(new Error('Provider connection broken')); } }), { headers: { 'content-type': 'text/event-stream' } });
    }));
    const response = await dispatch({ model: clientModel, stream: true }, context, store), reader = response.body!.getReader();
    const output: string[] = [];
    await expect((async () => { while (true) { const item = await reader.read(); if (item.done) return; output.push(new TextDecoder().decode(item.value)); } })()).rejects.toThrow('Provider connection broken');
    await flush();
    expect(output.join('')).toContain('content_block_delta'); expect(output.join('')).not.toContain('event: error'); expect(output.join('')).not.toContain('[DONE]');
    expect(upstreamSignal?.aborted).toBe(true); expect(attempts[0]).toMatchObject({ status: 502, result: 'error' }); expect(logs[0]).toMatchObject({ status: 502, result: 'error' });
  });
});

describe('relay byte scanner boundaries', () => {
  it('cancels an oversized unterminated frame before reading the complete upstream body', async () => {
    let pulls = 0, cancelled = false;
    const chunk = encoder.encode('x'.repeat(16 * 1024));
    const source = new ReadableStream<Uint8Array>({ pull(output) { pulls++; if (pulls <= 128) output.enqueue(chunk); else output.close(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const iterator = relayStream(source, clientModel, false, new AbortController().signal);
    await expect(iterator.next().then(item => item.done)).rejects.toThrow('SSE event exceeded 1 MiB');
    expect(cancelled).toBe(true); expect(pulls).toBeLessThan(128);
  });
  it('bounds frames after the first token without limiting a chunk containing many small valid frames', async () => {
    const first = frame(nativeEvents()[2]);
    const large = encoder.encode('data: ' + 'x'.repeat(1024 * 1024) + '\n\n');
    const iterator = relayStream(new ReadableStream<Uint8Array>({ start(output) { output.enqueue(first); output.enqueue(large); output.close(); } }), clientModel, false, new AbortController().signal);
    expect((await iterator.next()).value).toMatchObject({ meaningful: true });
    await expect(iterator.next().then(item => item.done)).rejects.toThrow('SSE event exceeded 1 MiB');
    const raw = ('data: ' + 'x'.repeat(16 * 1024) + '\n\n').repeat(70); let total = 0;
    for await (const item of relayStream(new Response(raw).body!, clientModel, false, new AbortController().signal)) total += item.bytes.byteLength;
    expect(total).toBe(encoder.encode(raw).byteLength);
  });
  it('observes opaque heartbeat and control events without counting them as output or changing their bytes', async () => {
    const names = ['ping', 'message_start', 'message_delta', 'message_stop', 'error', 'vendor_metadata', 'vendor_signature', 'vendor_status', 'vendor_output'];
    const raw = names.map(name => `event: ${name}\r\ndata: Opaque ${name} value\r\n\r\n`).join('');
    const frames = [];
    for await (const item of relayStream(new Response(raw).body!, clientModel, false, new AbortController().signal)) frames.push(item);
    expect(frames.map(item => item.meaningful)).toEqual([false, false, false, false, false, false, false, false, true]);
    expect(frames.map(item => new TextDecoder().decode(item.bytes)).join('')).toBe(raw);
  });
  it('preserves CR, CRLF, UTF-8, multiline data and unterminated tails at every short chunk size', async () => {
    const raw = ': comment 值\r\nid: id\r\nretry: 3\r\nevent: future\r\ndata: {"model":"provider-model",\r\ndata: "answer":"值","extra":null}\r\n\r\nevent: custom\rdata: opaque\r\r: final unterminated 值';
    const bytes = encoder.encode(raw);
    for (let chunkSize = 1; chunkSize <= 19; chunkSize++) {
      const source = new ReadableStream<Uint8Array>({ start(output) { for (let offset = 0; offset < bytes.length; offset += chunkSize) output.enqueue(bytes.slice(offset, offset + chunkSize)); output.close(); } });
      const frames = [];
      for await (const item of relayStream(source, clientModel, false, new AbortController().signal)) frames.push(item.bytes);
      const returned = new Uint8Array(frames.reduce((size, item) => size + item.length, 0)); let offset = 0;
      for (const item of frames) { returned.set(item, offset); offset += item.length; }
      expect(returned).toEqual(bytes);
    }
  });
  it('keeps non-data lines in a multiline JSON frame while applying only the alias to its parsed data', async () => {
    const raw = ': header\r\nid: 1\r\ndata: {"model":"provider-model",\r\n: between data lines\r\nretry: 9\r\ndata: "nested":{"model":"nested-model"},"future":null}\r\nevent: custom_event\r\n\r\n';
    const frames = [];
    for await (const item of relayStream(new Response(raw).body!, clientModel, true, new AbortController().signal)) frames.push(new TextDecoder().decode(item.bytes));
    expect(frames.join('')).toBe(': header\r\nid: 1\r\ndata: {"model":"client-alias","nested":{"model":"nested-model"},"future":null}\r\n: between data lines\r\nretry: 9\r\nevent: custom_event\r\n\r\n');
  });
});

describe('completed responses survive ancillary persistence failures', () => {
  it.each(['recordAttempt', 'recordLog', 'setSticky'] as const)('does not regenerate a JSON response when %s fails', async operation => {
    const { context, store, logs } = setup(); context.settings.retryEnabled = true; context.settings.maxSameChannelRetries = 1;
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    store[operation] = vi.fn(async () => { throw new Error('Storage failed: ' + upstreamSecret); });
    const fetcher = vi.fn(async () => Response.json(nativeMessage())); vi.stubGlobal('fetch', fetcher);
    const response = await dispatch({ model: clientModel }, context, store);
    expect(response.status).toBe(200); expect((await response.json() as any).content[0].text).toBe('Answer'); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalled(); expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(upstreamSecret);
    if (operation === 'recordAttempt') expect(logs[0].tokens).toBe(17);
  });
  it.each(['recordAttempt', 'recordLog', 'setSticky'] as const)('keeps a successful SSE response intact when %s fails', async operation => {
    const { context, store } = setup(); context.settings.retryEnabled = true; context.settings.maxSameChannelRetries = 1;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    store[operation] = vi.fn(async () => { throw new Error('Storage unavailable'); });
    const fetcher = vi.fn(async () => streaming(nativeEvents())); vi.stubGlobal('fetch', fetcher);
    const response = await dispatch({ model: clientModel, stream: true }, context, store);
    expect(response.status).toBe(200); expect((await readEvents(response)).at(-1)?.event).toBe('message_stop'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('returns the successful backup response even when the failover event cannot be saved', async () => {
    const { context, store } = setup([channel(), channel('backup')]); context.settings.retryEnabled = true; context.settings.maxSameChannelRetries = 0; context.settings.retryDelayMs = 100;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    store.recordEvent = vi.fn(async () => { throw new Error('Event storage unavailable'); });
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: 'busy' }, { status: 503 })).mockImplementation(async () => Response.json(nativeMessage())); vi.stubGlobal('fetch', fetcher);
    const response = await dispatch({ model: clientModel }, context, store);
    expect(response.status).toBe(200); expect((await response.json() as any).content[0].text).toBe('Answer'); expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
