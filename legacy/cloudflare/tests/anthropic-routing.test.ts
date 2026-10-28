import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../worker/index';
import { parseSSE } from '../worker/sse';
import type { Env } from '../worker/env';

const testEnv = env as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const message = { model: 'client-claude', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] };

async function call(path: string, method = 'POST', data?: unknown, headers: Record<string, string> = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('http://127.0.0.1:8787' + path, {
    method, headers: { ...(data !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(data !== undefined && !['GET', 'HEAD'].includes(method) ? { body: typeof data === 'string' ? data : JSON.stringify(data) } : {}),
  }), testEnv, ctx);
  const content = await response.text(); await waitOnExecutionContext(ctx);
  let json: any = null; try { json = JSON.parse(content); } catch { /* Native SSE is inspected separately. */ }
  return { response, content, json };
}
const admin = (path: string, method: string, data?: unknown) => call(path, method, data, { authorization: 'Bearer ' + testEnv.ADMIN_TOKEN });
async function newChannel(alias = true) {
  const result = await admin('/api/channels', 'POST', { name: 'Native route upstream', endpoint: 'https://native-upstream.example', apiKeys: ['synthetic-managed-key'], models: ['actual-upstream-model'], tags: ['production'], config: { protocol: 'gemini', aliases: alias ? [{ from: 'client-claude', to: 'actual-upstream-model' }] : [] } });
  expect(result.response.status).toBe(201); return result.json.channel;
}
function nativeReply() {
  return { id: 'msg_upstream', type: 'message', role: 'assistant', model: 'actual-upstream-model', content: [{ type: 'text', text: 'Native route upstream' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 3 }, provider_extension: null };
}
function upstream(stream = false) {
  const frames = [
    { type: 'message_start', message: { ...nativeReply(), content: [], usage: { input_tokens: 2, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Native route upstream' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe('https://native-upstream.example/v1/messages');
    expect(new Headers(init?.headers).get('x-api-key')).toBe('synthetic-managed-key');
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
    return stream ? new Response(frames.map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }) : Response.json(nativeReply());
  }));
}
async function newKey(input: Record<string, unknown> = {}) {
  const result = await admin('/api/keys', 'POST', { name: 'Messages client', ...input });
  expect(result.response.status).toBe(201); return result.json;
}
function expectNativeError(result: Awaited<ReturnType<typeof call>>, status: number, type: string) {
  expect(result.response.status).toBe(status); expect(result.json).toMatchObject({ type: 'error', error: { type, message: expect.any(String) } });
  expect(result.json.error.type).not.toBe('gateway_error'); expect(result.response.headers.get('cache-control')).toBe('no-store');
}
async function expectNoGatewayDispatch() {
  expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM attempts').first<{ count: number }>())?.count).toBe(0);
  expect((await testEnv.DB.prepare('SELECT COALESCE(SUM(used),0) AS used FROM profile_usage').first<{ used: number }>())?.used).toBe(0);
  expect((await testEnv.DB.prepare('SELECT COALESCE(SUM(used),0) AS used FROM api_keys').first<{ used: number }>())?.used).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
}

beforeAll(async () => { await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS); });
beforeEach(async () => {
  await testEnv.DB.batch(['channel_accounts', 'credentials', 'channels', 'profile_usage', 'api_keys', 'attempts', 'request_logs', 'events', 'tags', 'settings', 'gateway_state', 'admin_sessions'].map(table => testEnv.DB.prepare('DELETE FROM ' + table)));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected real upstream request'); }));
});
afterEach(() => vi.unstubAllGlobals());

describe('public Anthropic Messages route authentication and routing', () => {
  it.each(['x-api-key', 'authorization'] as const)('accepts a PulseGate client key in %s and returns the requested alias in native JSON', async header => {
    const channel = await newChannel(), key = await newKey();
    upstream();
    const result = await call('/v1/messages', 'POST', message, { [header]: header === 'authorization' ? 'Bearer ' + key.token : key.token, 'anthropic-version': '2023-06-01' });
    expect(result.response.status).toBe(200); expect(result.json).toMatchObject({ type: 'message', role: 'assistant', model: 'client-claude', stop_reason: 'end_turn', stop_sequence: null });
    expect(result.json).toEqual({ ...nativeReply(), model: 'client-claude' });
    expect(result.json.content).toEqual([{ type: 'text', text: 'Native route upstream' }]);
    expect(result.json.usage.input_tokens).toBeGreaterThan(0); expect(result.json.usage.output_tokens).toBeGreaterThan(0);
    expect(result.response.headers.get('x-pulsegate-channel-id')).toBe(channel.id);
    const attempt = await testEnv.DB.prepare('SELECT data FROM attempts').first<{ data: string }>(), log = await testEnv.DB.prepare('SELECT data FROM request_logs').first<{ data: string }>();
    expect(JSON.parse(attempt!.data).model).toBe('actual-upstream-model'); expect(JSON.parse(log!.data)).toMatchObject({ model: 'client-claude', apiKeyId: key.key.id });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('frames native SSE events through the public route and preserves the client alias', async () => {
    await newChannel(); const key = await newKey();
    upstream(true);
    const result = await call('/v1/messages', 'POST', { ...message, stream: true }, { 'x-api-key': key.token, 'anthropic-version': '2023-06-01' });
    expect(result.response.status).toBe(200); expect(result.response.headers.get('content-type')).toContain('text/event-stream');
    const events = [];
    for await (const event of parseSSE(new Response(result.content).body!)) events.push({ event: event.event, value: JSON.parse(event.data) });
    expect(events[0]).toMatchObject({ event: 'message_start', value: { type: 'message_start', message: { type: 'message', model: 'client-claude', role: 'assistant' } } });
    expect(events.some(event => event.event === 'content_block_start')).toBe(true); expect(events.some(event => event.event === 'content_block_stop')).toBe(true);
    expect(events.filter(event => event.event === 'content_block_delta').map(event => event.value.delta.text || '').join('')).toContain('Native route upstream');
    expect(events.find(event => event.event === 'message_delta')?.value).toMatchObject({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: expect.any(Number) } });
    expect(events.at(-1)).toMatchObject({ event: 'message_stop', value: { type: 'message_stop' } }); expect(result.content).not.toContain('[DONE]'); expect(result.content).not.toContain('actual-upstream-model');
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM attempts').first<{ count: number }>())?.count).toBe(1); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['missing', 'wrong', 'admin', 'expired', 'revoked', 'deleted', 'disabled'] as const)('returns a native authentication error for a %s client key before dispatch', async mode => {
    await newChannel(); let headers: Record<string, string> = {};
    if (mode === 'wrong') headers = { 'x-api-key': 'pg_live_unknown-client-key' };
    if (mode === 'admin') headers = { 'x-api-key': testEnv.ADMIN_TOKEN! };
    if (['expired', 'revoked', 'deleted', 'disabled'].includes(mode)) {
      const key = await newKey(mode === 'expired' ? { expires: '2000-01-01T00:00:00Z' } : mode === 'disabled' ? { status: 'disabled' } : {});
      if (mode === 'deleted') {
        const deleted = await admin(`/api/keys/${key.key.id}`, 'DELETE');
        expect(deleted.response.status).toBe(204); expect(deleted.content).toBe('');
      }
      if (mode === 'revoked') await testEnv.DB.prepare("UPDATE api_keys SET data=json_set(data,'$.status','revoked') WHERE id=?").bind(key.key.id).run();
      headers = { 'x-api-key': key.token };
    }
    expectNativeError(await call('/v1/messages', 'POST', message, headers), 401, 'authentication_error'); await expectNoGatewayDispatch();
  });
  it.each([
    { scope: 'tags', tags: ['other-tag'] },
    { scope: 'channels', channelIds: ['other-channel'] },
    { modelMode: 'selected', models: ['other-model'] },
  ])('enforces the client profile before upstream dispatch: %s', async restriction => {
    await newChannel(); const key = await newKey({ profiles: [{ id: 'restricted', name: 'Restricted', requestLimit: '1', ...restriction }], activeProfile: 'restricted' });
    expectNativeError(await call('/v1/messages', 'POST', message, { 'x-api-key': key.token }), 403, 'permission_error'); await expectNoGatewayDispatch();
  });
  it('returns a native permission error when the selected Key profile is no longer present', async () => {
    await newChannel(); const key = await newKey();
    await testEnv.DB.prepare("UPDATE api_keys SET data=json_set(data,'$.activeProfile','missing-profile') WHERE id=?").bind(key.key.id).run();
    expectNativeError(await call('/v1/messages', 'POST', message, { 'x-api-key': key.token }), 403, 'permission_error'); await expectNoGatewayDispatch();
  });
  it.each([
    '{', [], {}, { ...message, model: '' }, { ...message, model: 3 },
  ])('rejects invalid JSON or basic Messages envelopes before quota and upstream work: %s', async input => {
    await newChannel(); const key = await newKey({ profiles: [{ id: 'limited', name: 'Limited', requestLimit: '1' }], activeProfile: 'limited' });
    expectNativeError(await call('/v1/messages', 'POST', input, { 'x-api-key': key.token }), 400, 'invalid_request_error'); await expectNoGatewayDispatch();
  });
  it.each(['/v1/messages', '/v1/chat/completions'])('keeps the exact HTTP request and JSON response through %s without aliases or body overrides', async path => {
    const channel = await newChannel(false), key = await newKey({ profiles: [{ id: 'limited', name: 'Limited', requestLimit: '1' }], activeProfile: 'limited' });
    const raw = '{\r\n "vendor" : {"custom":null}, "messages" : [],\r\n "model" : "actual-upstream-model", "max_tokens" : 0, "stream" : "provider-decides"\r\n}\n';
    const provider = '{\r\n "vendor":null, "model" : "actual-upstream-model", "unexpected" : [1,2,3]\r\n}\n';
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://native-upstream.example' + path); expect(init?.body).toBe(raw);
      const headers = new Headers(init?.headers);
      expect(headers.get('x-api-key')).toBe(path === '/v1/messages' ? 'synthetic-managed-key' : null);
      expect(headers.get('authorization')).toBe(path === '/v1/chat/completions' ? 'Bearer synthetic-managed-key' : null);
      return new Response(provider, { headers: { 'content-type': 'application/json', 'x-provider-request-id': 'preserved' } });
    }));
    const authorization = path === '/v1/messages' ? { 'x-api-key': key.token } : { authorization: 'Bearer ' + key.token };
    const result = await call(path, 'POST', raw, authorization);
    expect(result.response.status).toBe(200); expect(result.content).toBe(provider); expect(result.response.headers.get('x-provider-request-id')).toBe('preserved'); expect(result.response.headers.get('x-pulsegate-channel-id')).toBe(channel.id);
    expect((await testEnv.DB.prepare('SELECT used FROM api_keys WHERE id=?').bind(key.key.id).first<{ used: number }>())?.used).toBe(1);
    expect((await testEnv.DB.prepare('SELECT used FROM profile_usage WHERE key_id=? AND profile_id=?').bind(key.key.id, 'limited').first<{ used: number }>())?.used).toBe(1);
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM attempts').first<{ count: number }>())?.count).toBe(1); expect(fetch).toHaveBeenCalledTimes(1);
    const exhausted = await call(path, 'POST', raw, authorization);
    if (path === '/v1/messages') expectNativeError(exhausted, 429, 'rate_limit_error'); else expect(exhausted.response.status).toBe(429);
    expect((await testEnv.DB.prepare('SELECT used FROM api_keys WHERE id=?').bind(key.key.id).first<{ used: number }>())?.used).toBe(1);
    expect((await testEnv.DB.prepare('SELECT used FROM profile_usage WHERE key_id=? AND profile_id=?').bind(key.key.id, 'limited').first<{ used: number }>())?.used).toBe(1);
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM attempts').first<{ count: number }>())?.count).toBe(1); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not replace an upstream error with a local Anthropic error envelope', async () => {
    await newChannel(); const key = await newKey();
    const raw = '{\r\n "error":{"type":"provider_specific","message":"bad vendor option"},"vendor":null\r\n}\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, { status: 422, headers: { 'content-type': 'application/json', 'x-provider-error-id': 'original' } })));
    const result = await call('/v1/messages', 'POST', { model: 'client-claude', arbitrary: { provider: 'validates' } }, { 'x-api-key': key.token });
    expect(result.response.status).toBe(422); expect(result.content).toBe(raw); expect(result.response.headers.get('x-provider-error-id')).toBe('original');
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM attempts').first<{ count: number }>())?.count).toBe(1);
    const log = await testEnv.DB.prepare('SELECT data FROM request_logs').first<{ data: string }>(); expect(JSON.parse(log!.data)).toMatchObject({ result: 'error', status: 422, attempts: 1 });
  });
  it('returns native not-found errors for an unsupported method on the Messages route while existing routes keep their envelope', async () => {
    const key = await newKey();
    expectNativeError(await call('/v1/messages', 'GET', undefined, { 'x-api-key': key.token }), 404, 'not_found_error');
    expectNativeError(await call('/v1/messages', 'PUT', message, { 'x-api-key': key.token }), 404, 'not_found_error');
    for (const path of ['/v1/responses', '/v1/v1/messages']) {
      const result = await call(path, 'GET', undefined, { 'x-api-key': key.token });
      expect(result.response.status).toBe(404); expect(result.json).toMatchObject({ error: { type: 'gateway_error', message: 'API endpoint not found' } });
    }
    await expectNoGatewayDispatch();
  });
});
