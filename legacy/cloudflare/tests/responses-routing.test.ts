import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../worker/index';
import type { Env } from '../worker/env';

const testEnv = env as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const model = 'provider-model';
async function call(path: string, method = 'POST', data?: unknown, token?: string) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('http://127.0.0.1:8787' + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    ...(data !== undefined ? { body: typeof data === 'string' ? data : JSON.stringify(data) } : {}),
  }), testEnv, ctx);
  const bytes = new Uint8Array(await response.arrayBuffer()), content = new TextDecoder().decode(bytes);
  await waitOnExecutionContext(ctx);
  let json: any; try { json = JSON.parse(content); } catch { /* SSE and binary output stay in their original format. */ }
  return { response, bytes, content, json };
}
const admin = (path: string, data: unknown, method = 'POST') => call(path, method, data, testEnv.ADMIN_TOKEN);
async function channel(extra: Record<string, unknown> = {}) {
  const created = await admin('/api/channels', { name: 'Responses upstream', endpoint: 'https://responses-upstream.example/tenant/v1', models: [model], apiKeys: ['synthetic-responses-upstream-key'], ...extra });
  expect(created.response.status).toBe(201); return created.json.channel;
}
async function key(extra: Record<string, unknown> = {}) {
  const created = await admin('/api/keys', { name: 'Responses client', ...extra });
  expect(created.response.status).toBe(201); return created.json;
}
function responseValue(actualModel = model) {
  return { id: 'resp_synthetic', object: 'response', model: actualModel, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer', annotations: [] }] }], usage: { input_tokens: 3, input_tokens_details: { cached_tokens: 2 }, output_tokens: 2, total_tokens: 5 }, vendor_extension: null };
}
async function counts() {
  return {
    attempts: (await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM attempts').first<{ count: number }>())!.count,
    used: (await testEnv.DB.prepare('SELECT COALESCE(SUM(used),0) AS count FROM api_keys').first<{ count: number }>())!.count,
  };
}

beforeAll(async () => { await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS); });
beforeEach(async () => {
  await testEnv.DB.batch(['channel_accounts', 'credentials', 'channels', 'profile_usage', 'api_keys', 'attempts', 'request_logs', 'events', 'tags', 'settings', 'gateway_state', 'admin_sessions'].map(table => testEnv.DB.prepare('DELETE FROM ' + table)));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected real upstream request'); }));
  expect((await admin('/api/settings', { retryEnabled: false, stickyMode: 'off', emptyResponseDetection: true }, 'PATCH')).response.status).toBe(200);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('model-based public POST routes relay the client format', () => {
  it.each(['/v1/responses', '/v1/responses/compact', '/v1/vendor/future-endpoint'])('preserves the actual %s path, query, request body and response without a Chat schema requirement', async path => {
    const upstream = await channel({ config: { protocol: 'gemini', conversions: { systemToUser: true, stripUnsupported: true } } }), client = await key();
    const raw = '{\r\n "model" : "provider-model", "input" : [{"type":"future_input","payload":[null,{"model":"nested-model"}]}],\r\n "instructions":"keep me", "max_output_tokens":0, "stream":"provider-decides", "tools":[{"type":"future_tool"}], "vendor":null\r\n}\n';
    const reply = JSON.stringify(responseValue(), null, 2) + '\r\n';
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://responses-upstream.example/tenant' + path + '?tag=first&tag=second&opaque=a%2Bb');
      expect(init?.method).toBe('POST'); expect(init?.body).toBe(raw);
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer synthetic-responses-upstream-key');
      expect(headers.get('x-goog-api-key')).toBeNull(); expect(headers.get('x-api-key')).toBeNull();
      return new Response(reply, { headers: { 'content-type': 'application/json', 'x-provider-extension': 'preserved' } });
    }));
    const result = await call(path + '?tag=first&tag=second&opaque=a%2Bb', 'POST', raw, client.token);
    expect(result.response.status).toBe(200); expect(result.content).toBe(reply);
    expect(result.response.headers.get('x-provider-extension')).toBe('preserved');
    expect(result.response.headers.get('x-pulsegate-channel-id')).toBe(upstream.id);
    expect(await counts()).toEqual({ attempts: 1, used: 1 });
    const log = await testEnv.DB.prepare('SELECT data FROM request_logs').first<{ data: string }>();
    expect(JSON.parse(log!.data)).toMatchObject({ tokens: 5, result: 'success', model });
  });

  it('retains Responses options and nested models when an explicit channel alias maps the routing model', async () => {
    await channel({ config: { protocol: 'openai', aliases: [{ from: 'client-alias', to: model }] } }); const client = await key();
    const input = { model: 'client-alias', input: 'hello', previous_response_id: 'resp_previous', instructions: null, reasoning: { effort: 'vendor-effort' }, text: { format: { type: 'vendor-format' } }, vendor: { model: 'nested-model' } };
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://responses-upstream.example/tenant/v1/responses');
      expect(JSON.parse(String(init?.body))).toEqual({ ...input, model });
      return Response.json({ ...responseValue(), vendor: { model: 'nested-model' } });
    }));
    const result = await call('/v1/responses', 'POST', input, client.token);
    expect(result.response.status).toBe(200); expect(result.json.model).toBe('client-alias'); expect(result.json.vendor.model).toBe('nested-model');
  });

  it('relays original Responses SSE event bytes and records final nested usage with empty detection enabled', async () => {
    await channel(); const client = await key();
    const frames = [
      ': keepalive\r\n\r\n',
      'event: response.created\r\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_synthetic","object":"response","model":"provider-model","status":"in_progress","output":[],"usage":null}}\r\n\r\n',
      'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","sequence_number":1,"item_id":"msg_synthetic","output_index":0,"content_index":0,"delta":"Answer","vendor":null}\r\n\r\n',
      'event: vendor.future\r\ndata: {"opaque":[null,{"preserved":true}]}\r\n\r\n',
      'event: response.completed\r\ndata: ' + JSON.stringify({ type: 'response.completed', sequence_number: 2, response: responseValue() }) + '\r\n\r\n',
    ].join('');
    const bytes = new TextEncoder().encode(frames);
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ model, input: 'hello', stream: true });
      return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream', 'x-provider-stream': 'preserved' } });
    }));
    const result = await call('/v1/responses', 'POST', { model, input: 'hello', stream: true }, client.token);
    expect(result.response.status).toBe(200); expect(result.content).toBe(frames); expect(result.content).not.toContain('[DONE]');
    expect(result.response.headers.get('x-provider-stream')).toBe('preserved'); expect(fetch).toHaveBeenCalledTimes(1);
    const attempt = await testEnv.DB.prepare('SELECT data FROM attempts').first<{ data: string }>();
    expect(JSON.parse(attempt!.data)).toMatchObject({ inputTokens: 3, outputTokens: 2, result: 'success', stream: true });
    expect(JSON.parse(attempt!.data).ttft).not.toBeNull(); expect(await counts()).toEqual({ attempts: 1, used: 1 });
  });

  it('preserves a Responses failed event without Chat validation or an empty-response retry', async () => {
    await channel(); const client = await key();
    const frame = 'event: response.failed\ndata: {"type":"response.failed","sequence_number":1,"response":{"id":"resp_failed","object":"response","status":"failed","model":"provider-model","output":[],"error":{"code":"vendor_failure","message":"provider error"},"usage":{"input_tokens":1,"output_tokens":0}}}\n\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(frame, { headers: { 'content-type': 'text/event-stream' } })));
    const result = await call('/v1/responses', 'POST', { model, input: 'hello', stream: true }, client.token);
    expect(result.response.status).toBe(200); expect(result.content).toBe(frame); expect(fetch).toHaveBeenCalledTimes(1);
    const attempt = await testEnv.DB.prepare('SELECT data FROM attempts').first<{ data: string }>();
    expect(JSON.parse(attempt!.data)).toMatchObject({ result: 'error', error: 'provider error', inputTokens: 1, outputTokens: 0 });
  });

  it.each(['response.completed', 'response.incomplete'])('accepts %s containing the full output even when there were no earlier delta events', async type => {
    await channel(); const client = await key();
    const response = { ...responseValue(), status: type === 'response.incomplete' ? 'incomplete' : 'completed', error: null, incomplete_details: type === 'response.incomplete' ? { reason: 'max_output_tokens' } : null };
    const frame = `event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(frame, { headers: { 'content-type': 'text/event-stream' } })));
    const result = await call('/v1/responses', 'POST', { model, input: 'hello', stream: true }, client.token);
    expect(result.response.status).toBe(200); expect(result.content).toBe(frame); expect(fetch).toHaveBeenCalledTimes(1);
    const attempt = await testEnv.DB.prepare('SELECT data FROM attempts').first<{ data: string }>();
    expect(JSON.parse(attempt!.data)).toMatchObject({ result: 'success', inputTokens: 3, outputTokens: 2 });
  });

  it.each(['queued', 'in_progress'])('preserves a successful background %s acknowledgment without treating it as an empty completion', async status => {
    await channel(); const client = await key();
    const reply = JSON.stringify({ id: 'resp_background', object: 'response', status, background: true, model, output: [], error: null, usage: null });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(reply, { headers: { 'content-type': 'application/json' } })));
    const result = await call('/v1/responses', 'POST', { model, input: 'hello', background: true }, client.token);
    expect(result.response.status).toBe(200); expect(result.content).toBe(reply); expect(fetch).toHaveBeenCalledTimes(1);
    expect(await counts()).toEqual({ attempts: 1, used: 1 });
  });

  it('returns the upstream validation error body and status unchanged', async () => {
    await channel(); const client = await key();
    const reply = '{\n "error": {"type":"provider_specific","message":"unsupported vendor input"}, "unknown":null\n}\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(reply, { status: 422, headers: { 'content-type': 'application/json', 'x-provider-error': 'original' } })));
    const result = await call('/v1/responses', 'POST', { model, input: { arbitrary: true } }, client.token);
    expect(result.response.status).toBe(422); expect(result.content).toBe(reply); expect(result.response.headers.get('x-provider-error')).toBe('original'); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('accepts an unfamiliar JSON acknowledgment without imposing a completion response schema', async () => {
    await channel(); const client = await key(); const reply = '{ "id": "job_synthetic", "status": "accepted" }\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(reply, { status: 202, headers: { 'content-type': 'application/json' } })));
    const result = await call('/v1/vendor/jobs', 'POST', { model, vendor_input: 'hello' }, client.token);
    expect(result.response.status).toBe(202); expect(result.content).toBe(reply); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves binary provider output from a model-based JSON request', async () => {
    await channel(); const client = await key(); const bytes = new Uint8Array([0, 255, 128, 254, 1, 13, 10]);
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe('https://responses-upstream.example/tenant/v1/audio/speech');
      return new Response(bytes, { headers: { 'content-type': 'audio/mpeg' } });
    }));
    const result = await call('/v1/audio/speech', 'POST', { model, input: 'hello', voice: 'vendor-voice' }, client.token);
    expect(result.response.status).toBe(200); expect(result.bytes).toEqual(bytes); expect(result.response.headers.get('content-type')).toBe('audio/mpeg');
  });

  it('keeps API Key authentication, model authorization and JSON routing envelopes enforced before dispatch', async () => {
    await channel(); const client = await key({ profiles: [{ id: 'restricted', name: 'Restricted', modelMode: 'selected', models: ['other-model'] }], activeProfile: 'restricted' });
    for (const token of [undefined, 'pg_live_unknown-responses-key', testEnv.ADMIN_TOKEN]) {
      expect((await call('/v1/responses', 'POST', { model, input: 'hello' }, token)).response.status).toBe(401);
    }
    expect((await call('/v1/responses', 'POST', { model, input: 'hello' }, client.token)).response.status).toBe(403);
    for (const input of ['{', {}, { model: '' }]) expect((await call('/v1/responses', 'POST', input, client.token)).response.status).toBe(400);
    expect(await counts()).toEqual({ attempts: 0, used: 0 }); expect(fetch).not.toHaveBeenCalled();
  });
});
