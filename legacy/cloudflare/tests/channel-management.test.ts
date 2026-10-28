import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../worker/index';
import { decryptSecret } from '../worker/crypto';
import { accountBase, refreshAccountBalance, refreshDueAccounts } from '../worker/accounts';
import { Store } from '../worker/store';
import { channel as parseChannel } from '../worker/validation';
import { gatewayCandidates, orderedCandidates } from '../worker/gateway';
import { prepareBody, prepareRelayBody, upstreamHeaders, upstreamUrl } from '../worker/protocols';
import type { Env, GatewayContext } from '../worker/env';
import type { GatewayChannel } from '../shared/types';
import { defaultSettings } from '../shared/types';

const testEnv = env as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
async function call(path: string, method = 'GET', data?: unknown, authenticated = true, customEnv: Env = testEnv) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('http://127.0.0.1:8787' + path, { method, headers: { ...(authenticated ? { authorization: 'Bearer ' + testEnv.ADMIN_TOKEN } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }), customEnv, ctx);
  const content = await response.text(); await waitOnExecutionContext(ctx);
  return { status: response.status, content, json: JSON.parse(content) };
}
async function runScheduled(customEnv: Env = testEnv) {
  const ctx = createExecutionContext();
  try { await worker.scheduled(createScheduledController({ cron: '* * * * *', scheduledTime: Date.now() }), customEnv, ctx); }
  finally { await waitOnExecutionContext(ctx); }
}
async function manualBalance(id: string) {
  const refreshed = await call(`/api/channels/${id}/balance`, 'POST', {});
  expect(refreshed.status).toBe(200); return refreshed;
}
beforeAll(async () => { await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS); });
beforeEach(async () => {
  await testEnv.DB.batch(['channel_accounts','credentials','channels','settings','tags','gateway_state'].map(table => testEnv.DB.prepare('DELETE FROM ' + table)));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function mockAccount(balance = 12.5) {
  return vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/login')) return Response.json({ success: true, data: { access_token: 'private-session-token', user: { id: 42 }, expires_in: 3600 } });
    if (path === '/api/status') return Response.json({ success: true, data: { quota_per_unit: 500000 } });
    return Response.json({ success: true, data: { quota: balance * 500000, balance } });
  }));
}
async function accountChannel(kind: 'newapi' | 'sub2api' = 'newapi') {
  const result = await call('/api/channels', 'POST', { name: 'Account test', endpoint: 'https://account.example/v1', models: ['model-a'], config: { protocol: 'openai', integration: kind }, accountCredentials: { username: 'fake-user@example.com', password: 'fake-account-password' }, apiKeys: ['fake-api-key'] });
  expect(result.status).toBe(201); await manualBalance(result.json.channel.id); return result;
}

describe('display-only channel multiplier', () => {
  const input = { name: 'Display metadata', models: ['model-a'], config: { protocol: 'mock' } };

  it('defaults to one and preserves precise decimals through edits and unrelated PATCH requests', async () => {
    const created = await call('/api/channels', 'POST', input);
    expect(created.status).toBe(201); expect(created.json.channel.displayMultiplier).toBe(1);
    const id = created.json.channel.id, prices = [{ model: 'model-a', input: 2.5, output: 4.5 }];
    const first = await call(`/api/channels/${id}`, 'PATCH', { displayMultiplier: 0.04, config: { prices } });
    expect(first.status).toBe(200); expect(first.json.channel.displayMultiplier).toBe(0.04);
    const renamed = await call(`/api/channels/${id}`, 'PATCH', { name: 'Renamed', tags: ['display'], weight: 3 });
    expect(renamed.status).toBe(200); expect(renamed.json.channel.displayMultiplier).toBe(0.04);
    const edited = await call(`/api/channels/${id}`, 'PATCH', { displayMultiplier: 0.109 });
    expect(edited.status).toBe(200); expect(edited.json.channel.displayMultiplier).toBe(0.109); expect(edited.json.channel.config.prices).toEqual(prices); expect(edited.json.channel.weight).toBe(3);
    const row = await testEnv.DB.prepare('SELECT data FROM channels WHERE id=?').bind(id).first<{ data: string }>();
    expect(JSON.parse(row!.data).displayMultiplier).toBe(0.109);
    expect((await new Store(testEnv).getChannel(id))?.displayMultiplier).toBe(0.109);
  });

  it('reads legacy rows as one without a migration and retains that default on later edits', async () => {
    const created = await call('/api/channels', 'POST', { ...input, displayMultiplier: 0.04 }), id = created.json.channel.id;
    await testEnv.DB.prepare("UPDATE channels SET data=json_remove(data,'$.displayMultiplier') WHERE id=?").bind(id).run();
    const store = new Store(testEnv);
    expect((await store.getChannel(id))?.displayMultiplier).toBe(1); expect((await store.listChannels())[0].displayMultiplier).toBe(1);
    expect((await call('/api/bootstrap')).json.channels[0].displayMultiplier).toBe(1);
    const before = await testEnv.DB.prepare('SELECT data FROM channels WHERE id=?').bind(id).first<{ data: string }>();
    expect(JSON.parse(before!.data)).not.toHaveProperty('displayMultiplier');
    const edited = await call(`/api/channels/${id}`, 'PATCH', { name: 'Legacy edited' });
    expect(edited.status).toBe(200); expect(edited.json.channel.displayMultiplier).toBe(1);
  });

  it('persists imported decimals and bounds, applies missing defaults, and carries the value into clones', async () => {
    const values = [0.04, 0.109, 0, 1000000, undefined];
    const imported = await call('/api/channels/import', 'POST', { channels: values.map((value, index) => ({ ...input, name: `Imported display ${index}`, ...(value === undefined ? {} : { displayMultiplier: value }) })) });
    expect(imported.status).toBe(201); expect(imported.json.channels.map((channel: GatewayChannel) => channel.displayMultiplier)).toEqual([0.04, 0.109, 0, 1000000, 1]);
    const clone = await call(`/api/channels/${imported.json.channels[1].id}/clone`, 'POST', {});
    expect(clone.status).toBe(201); expect(clone.json.channel.displayMultiplier).toBe(0.109); expect(clone.json.channel.id).not.toBe(imported.json.channels[1].id);
    expect((await new Store(testEnv).getChannel(clone.json.channel.id))?.displayMultiplier).toBe(0.109);
  });

  it('rejects invalid multiplier types and ranges before changing channels or partial imports', async () => {
    const created = await call('/api/channels', 'POST', { ...input, displayMultiplier: 0.04 }), id = created.json.channel.id;
    for (const value of [null, '', '0.04', false, [], {}, -0.001, 1000000.001]) {
      expect((await call('/api/channels', 'POST', { ...input, displayMultiplier: value })).status).toBe(400);
      expect((await call(`/api/channels/${id}`, 'PATCH', { name: 'Must not save', displayMultiplier: value })).status).toBe(400);
    }
    for (const value of [NaN, Infinity, -Infinity]) expect(() => parseChannel({ ...input, displayMultiplier: value }, true)).toThrow();
    const imported = await call('/api/channels/import', 'POST', { channels: [{ ...input, name: 'Must not import', tags: ['must-not-import'] }, { ...input, displayMultiplier: null }] });
    expect(imported.status).toBe(400);
    const store = new Store(testEnv); expect(await store.listChannels()).toHaveLength(1); expect(await store.listTags()).toEqual([]);
    expect(await store.getChannel(id)).toMatchObject({ name: input.name, displayMultiplier: 0.04 });
  });
});

describe('display-only channel website', () => {
  const input = { name: 'Website metadata', endpoint: 'https://upstream.example/v1', models: ['model-a'] };
  const website = 'https://provider.example/docs/get-started/?source=console&lang=zh#pricing';

  it('defaults to empty, trims a supplied URL, preserves omitted edits, and allows clearing', async () => {
    const created = await call('/api/channels', 'POST', input), id = created.json.channel.id;
    expect(created.status).toBe(201); expect(created.json.channel.website).toBe('');
    const updated = await call(`/api/channels/${id}`, 'PATCH', { website: `  ${website}  ` });
    expect(updated.status).toBe(200); expect(updated.json.channel.website).toBe(website);
    const renamed = await call(`/api/channels/${id}`, 'PATCH', { name: 'Website renamed', weight: 3 });
    expect(renamed.status).toBe(200); expect(renamed.json.channel.website).toBe(website);
    const store = new Store(testEnv); expect((await store.listChannels())[0].website).toBe(website);
    expect((await store.getChannel(id))?.website).toBe(website);
    const row = await testEnv.DB.prepare('SELECT data FROM channels WHERE id=?').bind(id).first<{ data: string }>();
    expect(JSON.parse(row!.data).website).toBe(website);
    const cleared = await call(`/api/channels/${id}`, 'PATCH', { website: '' });
    expect(cleared.status).toBe(200); expect(cleared.json.channel.website).toBe('');
    expect((await store.getChannel(id))?.website).toBe('');
  });

  it('accepts HTTP and HTTPS independently of upstream URL restrictions and preserves URL components', async () => {
    const longest = 'https://provider.example/' + 'a'.repeat(2048 - 'https://provider.example/'.length);
    for (const value of [website, 'http://provider.example/', 'http://localhost:3000/docs?q=hello%20world#start', 'http://127.0.0.1:8000/?a=1#b', 'HTTPS://provider.example/docs/', longest, '   ']) {
      expect(parseChannel({ ...input, website: value }, false).website).toBe(value.trim());
    }
    const created = await call('/api/channels', 'POST', { ...input, website: 'http://localhost:3000/docs?q=1#start' });
    expect(created.status).toBe(201); expect(created.json.channel.website).toBe('http://localhost:3000/docs?q=1#start');
  });

  it('reads missing legacy websites as empty without rewriting the database', async () => {
    const created = await call('/api/channels', 'POST', { ...input, website }), id = created.json.channel.id;
    await testEnv.DB.prepare("UPDATE channels SET data=json_remove(data,'$.website') WHERE id=?").bind(id).run();
    const store = new Store(testEnv);
    expect((await store.getChannel(id))?.website).toBe(''); expect((await store.listChannels())[0].website).toBe('');
    expect((await call('/api/bootstrap')).json.channels[0].website).toBe('');
    const row = await testEnv.DB.prepare('SELECT data FROM channels WHERE id=?').bind(id).first<{ data: string }>();
    expect(JSON.parse(row!.data)).not.toHaveProperty('website');
    expect((await call(`/api/channels/${id}`, 'PATCH', { enabled: false })).json.channel.website).toBe('');
  });

  it('preserves imported and cloned websites, applies missing defaults, and retains metadata during bulk edits', async () => {
    const imported = await call('/api/channels/import', 'POST', { channels: [{ ...input, website }, { ...input, name: 'No website' }] });
    expect(imported.status).toBe(201); expect(imported.json.channels.map((channel: GatewayChannel) => channel.website)).toEqual([website, '']);
    const original = imported.json.channels[0], clone = await call(`/api/channels/${original.id}/clone`, 'POST', {});
    expect(clone.status).toBe(201); expect(clone.json.channel.website).toBe(website); expect(clone.json.channel.id).not.toBe(original.id);
    await call('/api/channels/bulk', 'POST', { ids: [original.id, clone.json.channel.id], action: 'tags', tags: ['website'], mode: 'add' });
    const store = new Store(testEnv);
    expect((await store.getChannel(original.id))?.website).toBe(website);
    expect((await store.getChannel(clone.json.channel.id))?.website).toBe(website);
  });

  it('rejects invalid website values before changing a channel or partially importing data', async () => {
    const created = await call('/api/channels', 'POST', { ...input, website }), id = created.json.channel.id;
    for (const value of [null, 123, false, [], {}, '/docs', '//provider.example', 'provider.example', 'https:provider.example', 'http:/provider.example', 'https:///provider.example', 'https://', 'ftp://provider.example', 'javascript:alert(1)', 'data:text/html,hello', 'https://private-user:private-password@provider.example', 'https://@provider.example', 'https://provider.example:invalid', 'https://provider.example/line\nbreak', 'https://provider.example/has space', 'https://provider.example\\path', 'https://provider.example/' + 'a'.repeat(2048)]) {
      const invalid = await call('/api/channels', 'POST', { ...input, website: value });
      expect(invalid.status).toBe(400); expect(invalid.content).not.toContain('private-password');
      expect((await call(`/api/channels/${id}`, 'PATCH', { name: 'Must not save', website: value })).status).toBe(400);
    }
    const imported = await call('/api/channels/import', 'POST', { channels: [{ ...input, name: 'Must not import', tags: ['must-not-import'], website }, { ...input, website: 'javascript:alert(1)' }] });
    expect(imported.status).toBe(400);
    const store = new Store(testEnv); expect(await store.listChannels()).toHaveLength(1); expect(await store.listTags()).toEqual([]);
    expect(await store.getChannel(id)).toMatchObject({ name: input.name, website });
  });

  it('does not forward the website or use it for upstream destinations, routing, or model prices', async () => {
    const prices = [{ model: 'model-a', input: 2.5, output: 4.5 }];
    const first = parseChannel({ ...input, website, priority: 10, config: { prices } }, false);
    const second = parseChannel({ ...input, name: 'Priority channel', priority: 0, website: 'http://localhost:3000/' }, false);
    const original = { model: 'model-a', messages: [{ role: 'user', content: 'hello' }], stream: false };
    expect(prepareBody(first, original, 'model-a')).toEqual(original);
    expect(prepareRelayBody(first, original, 'model-a')).toEqual(original);
    expect(upstreamUrl(first, defaultSettings, 'model-a', false)).toBe('https://upstream.example/v1/chat/completions');
    expect(upstreamHeaders(first, 'fake-website-inference-key', null).has('website')).toBe(false);
    expect(accountBase(first, false)).toBe('https://upstream.example'); expect(first.config.prices).toEqual(prices);
    const context: GatewayContext = { env: testEnv, ctx: createExecutionContext(), settings: { ...defaultSettings, strategy: 'failover', stickyMode: 'off' }, channels: [first, second], key: null, profile: null, source: 'api' };
    expect((await orderedCandidates(gatewayCandidates(context, 'model-a'), context, new Store(testEnv), '')).map(candidate => candidate.channel.id)).toEqual([second.id, first.id]);
  });

  it('keeps BBDevLab API keys and their balances when only the website changes', async () => {
    const fetcher = vi.fn(async (target: RequestInfo | URL) => {
      expect(String(target)).toBe('https://upstream.example/api/usage/token/');
      return Response.json({ code: true, data: { total_available: 100000 } });
    }); vi.stubGlobal('fetch', fetcher);
    const created = await call('/api/channels', 'POST', { ...input, website, config: { integration: 'bbdevlab' }, apiKeys: ['fake-website-balance-key'] }), id = created.json.channel.id;
    await manualBalance(id);
    const before = await testEnv.DB.prepare('SELECT k.secret,b.balance,b.version FROM credentials k JOIN credential_balances b ON b.credential_id=k.id WHERE k.channel_id=?').bind(id).first();
    const updated = await call(`/api/channels/${id}`, 'PATCH', { website: 'http://localhost:3000/new-site?from=console#start' });
    expect(updated.status).toBe(200); expect(updated.json.channel.accountBalance).toMatchObject({ status: 'ok', amount: 1 });
    expect(await testEnv.DB.prepare('SELECT k.secret,b.balance,b.version FROM credentials k JOIN credential_balances b ON b.credential_id=k.id WHERE k.channel_id=?').bind(id).first()).toEqual(before);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('model discovery management endpoint', () => {
  it.each([
    ['openai', 'https://models.example', '/v1/models', 'authorization', 'Bearer fake-key', { data: [{ id: 'model-a' }] }, 'model-a'],
    ['anthropic', 'https://models.example/', '/v1/models', 'x-api-key', 'fake-key', { data: [{ id: 'claude-a' }], has_more: false }, 'claude-a'],
    ['gemini', 'https://models.example', '/v1beta/models', 'x-goog-api-key', 'fake-key', { models: [{ name: 'models/gemini-a' }] }, 'gemini-a'],
  ] as const)('discovers %s models from a Base URL without a version suffix', async (protocol, endpoint, path, header, headerValue, response, model) => {
    const fetcher = vi.fn(async () => Response.json(response)); vi.stubGlobal('fetch', fetcher);
    const result = await call('/api/channels/discover-models', 'POST', { endpoint, config: { protocol }, apiKey: 'fake-key' });
    expect(result.status).toBe(200); expect(result.json.models).toEqual([model]);
    expect(result.json.endpoint).toBe('https://models.example' + path);
    const [target, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(target).pathname).toBe(path);
    expect(new Headers(options.headers).get(header)).toBe(headerValue);
  });
  it('uses an explicitly versioned models path with a bare Base URL', async () => {
    const fetcher = vi.fn(async () => Response.json({ data: [{ id: 'model-a' }] })); vi.stubGlobal('fetch', fetcher);
    const result = await call('/api/channels/discover-models', 'POST', { endpoint: 'https://models.example', config: { protocol: 'openai', endpoints: { models: '/v2/models' } }, apiKey: 'fake-key' });
    expect(result.status).toBe(200); expect(result.json.endpoint).toBe('https://models.example/v2/models');
    expect(String((fetcher.mock.calls[0] as unknown as [string])[0])).toBe(result.json.endpoint);
  });
  it('requires admin access and fetches the configured URL with its API key', async () => {
    const input = { endpoint: 'https://models.example/v1', config: { protocol: 'openai', endpoints: { models: '/v1/models' } }, apiKey: 'fake-discovery-key' };
    expect((await call('/api/channels/discover-models', 'POST', input, false)).status).toBe(401);
    const fetcher = vi.fn(async () => Response.json({ data: [{ id: 'z' }, { id: 'a' }, { id: 'z' }] })); vi.stubGlobal('fetch', fetcher);
    const result = await call('/api/channels/discover-models', 'POST', input);
    expect(result.status).toBe(200); expect(result.json.models).toEqual(['a','z']);
    const [target, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(target)).toBe('https://models.example/v1/models');
    expect(new Headers(options.headers).get('authorization')).toBe('Bearer fake-discovery-key'); expect(options.redirect).toBe('manual');
    expect((await new Store(testEnv).listChannels())).toEqual([]);
  });
  it('uses saved credentials without returning them, and reports safe upstream errors', async () => {
    const channel = await call('/api/channels', 'POST', { name:'Saved', endpoint:'https://models.example/v1', models:['existing'], apiKeys:['saved-private-key'] });
    const fetcher = vi.fn(async () => Response.json({ error: { message:'saved-private-key password-secret' } }, { status:401 })); vi.stubGlobal('fetch', fetcher);
    const result = await call('/api/channels/discover-models', 'POST', { channelId:channel.json.channel.id });
    expect(result.status).toBe(502); expect(result.content).toContain('401'); expect(result.content).not.toContain('saved-private-key'); expect(result.content).not.toContain('password-secret');
    expect(new Headers((fetcher.mock.calls[0] as unknown as [unknown,RequestInit])[1].headers).get('authorization')).toBe('Bearer saved-private-key');
    expect((await new Store(testEnv).getChannel(channel.json.channel.id))?.models).toEqual(['existing']);
  });
  it('paginates native model listings and normalizes Gemini model names', async () => {
    const gemini = vi.fn().mockResolvedValueOnce(Response.json({ models:[{ name:'models/gemini-a',supportedGenerationMethods:['generateContent'] }, { name:'models/embed',supportedGenerationMethods:['embedContent'] }], nextPageToken:'cursor' })).mockResolvedValueOnce(Response.json({ models:[{ name:'models/gemini-b' }] }));
    vi.stubGlobal('fetch', gemini);
    const result = await call('/api/channels/discover-models','POST',{ endpoint:'https://models.example/v1beta', config:{ protocol:'gemini' }, apiKey:'fake-key' });
    expect(result.json.models).toEqual(['gemini-a','gemini-b']); expect(gemini).toHaveBeenCalledTimes(2);
    expect(new URL(String(gemini.mock.calls[1][0])).searchParams.get('pageToken')).toBe('cursor');
    const anthropic = vi.fn().mockResolvedValueOnce(Response.json({ data:[{ id:'claude-a' }],has_more:true,last_id:'a' })).mockResolvedValueOnce(Response.json({ data:[{ id:'claude-b' }],has_more:false })); vi.stubGlobal('fetch', anthropic);
    const claude = await call('/api/channels/discover-models','POST',{ endpoint:'https://models.example/v1',config:{ protocol:'anthropic' },apiKey:'fake-key' });
    expect(claude.json.models).toEqual(['claude-a','claude-b']); expect(new Headers(anthropic.mock.calls[0][1].headers).get('x-api-key')).toBe('fake-key');
  });
  it('rejects missing keys, malformed responses and disallowed addresses', async () => {
    expect((await call('/api/channels/discover-models','POST',{ endpoint:'https://models.example/v1' })).status).toBe(400);
    expect((await call('/api/channels/discover-models','POST',{ endpoint:'http://public.example/v1',apiKey:'fake' })).status).toBe(400);
    vi.stubGlobal('fetch',vi.fn(async () => Response.json({ hello:'world' })));
    expect((await call('/api/channels/discover-models','POST',{ endpoint:'https://models.example/v1',apiKey:'fake' })).status).toBe(502);
  });
});

describe('account monitoring independent of the API protocol', () => {
  type AccountSnapshot = { credentials: string; auth_secret: string | null; balance: string | null; next_refresh_at: number; lease_until: number; version: number };
  async function accountSnapshot(id: string) {
    return (await testEnv.DB.prepare('SELECT credentials,auth_secret,balance,next_refresh_at,lease_until,version FROM channel_accounts WHERE channel_id=?').bind(id).first<AccountSnapshot>())!;
  }
  it.each(['anthropic', 'gemini'] as const)('discovers %s models using inference credentials while a NewAPI token monitors the account', async protocol => {
    const monitorToken = 'private-monitor-token', inferenceKey = 'private-inference-key';
    const fetcher = vi.fn(async (target: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(target)).pathname, headers = new Headers(init?.headers);
      if (path === '/api/user/self') {
        expect(headers.get('authorization')).toBe('Bearer ' + monitorToken); expect(headers.get('x-api-key')).toBeNull(); expect(headers.get('x-goog-api-key')).toBeNull();
        return Response.json({ success: true, data: { quota: 1500000 } });
      }
      if (path === '/api/status') return Response.json({ success: true, data: { quota_per_unit: 500000 } });
      expect(path).toBe(protocol === 'anthropic' ? '/v1/models' : '/v1beta/models');
      expect(headers.get(protocol === 'anthropic' ? 'x-api-key' : 'x-goog-api-key')).toBe(inferenceKey); expect(headers.get('authorization')).toBeNull();
      return Response.json(protocol === 'anthropic' ? { data: [{ id: 'native-model' }], has_more: false } : { models: [{ name: 'models/native-model', supportedGenerationMethods: ['generateContent'] }] });
    }); vi.stubGlobal('fetch', fetcher);
    const created = await call('/api/channels', 'POST', { name: 'Native monitored', endpoint: 'https://account.example', models: ['native-model'], config: { protocol, integration: 'newapi' }, apiKeys: [inferenceKey], accountCredentials: { accessToken: monitorToken, userId: '42' } });
    expect(created.status).toBe(201); expect(created.json.channel.config).toMatchObject({ protocol, integration: 'newapi' }); expect(created.json.channel.accountIntegration).toBe('newapi');
    await manualBalance(created.json.channel.id);
    expect((await new Store(testEnv).getChannel(created.json.channel.id))?.accountBalance).toMatchObject({ status: 'ok', amount: 3 });
    const discovered = await call('/api/channels/discover-models', 'POST', { channelId: created.json.channel.id });
    expect(discovered.status).toBe(200); expect(discovered.json.models).toEqual(['native-model']);
    expect(discovered.json.endpoint).toBe('https://account.example' + (protocol === 'anthropic' ? '/v1/models' : '/v1beta/models'));
    const clientKey = await call('/api/keys', 'POST', { name: 'Native model access' }), ctx = createExecutionContext();
    const listed = await worker.fetch(new Request('http://127.0.0.1:8787/v1/models', { headers: { authorization: 'Bearer ' + clientKey.json.token } }), testEnv, ctx);
    expect(listed.status).toBe(200); expect((await listed.json() as any).data.map((model: { id: string }) => model.id)).toEqual(['native-model']); await waitOnExecutionContext(ctx);
    expect(created.content + discovered.content + (await call('/api/bootstrap')).content).not.toContain(monitorToken);
    expect(created.content + discovered.content).not.toContain(inferenceKey);
  });
  it.each(['newapi', 'sub2api'] as const)('retains %s credentials and cached balance/session when only the API protocol changes', async integration => {
    mockAccount(); const created = await accountChannel(integration), id = created.json.channel.id;
    const before = await accountSnapshot(id); expect(before.auth_secret).not.toBeNull(); expect(before.balance).not.toBeNull();
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const protocol of ['anthropic', 'gemini'] as const) {
      const edited = await call(`/api/channels/${id}`, 'PATCH', { config: { protocol } });
      expect(edited.status).toBe(200); expect(edited.json.channel.config).toMatchObject({ protocol, integration });
      expect(edited.json.channel.accountIntegration).toBe(integration); expect(edited.json.channel.hasAccountCredentials).toBe(true);
      expect(await accountSnapshot(id)).toEqual(before);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['newapi', 'sub2api'] as const)('keeps saved %s credentials while monitoring is off and can reenable the same backend', async integration => {
    mockAccount(); const created = await accountChannel(integration), id = created.json.channel.id;
    const before = await accountSnapshot(id);
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const disabled = await call(`/api/channels/${id}`, 'PATCH', { config: { integration: 'native', protocol: 'anthropic' } });
    expect(disabled.status).toBe(200); expect(disabled.json.channel.config.integration).toBe('native'); expect(disabled.json.channel.accountIntegration).toBe(integration);
    expect(disabled.json.channel.hasAccountCredentials).toBe(true); expect((await accountSnapshot(id)).credentials).toBe(before.credentials);
    const manual = await call(`/api/channels/${id}/balance`, 'POST', {}); expect(manual.status).toBe(400);
    await testEnv.DB.prepare('UPDATE channel_accounts SET next_refresh_at=0 WHERE channel_id=?').bind(id).run();
    const offSnapshot = await accountSnapshot(id), store = new Store(testEnv), offChannel = (await store.getChannel(id))!;
    await refreshAccountBalance(testEnv, offChannel, true, true); await refreshDueAccounts(testEnv, await store.listChannels(), true);
    expect(fetcher).not.toHaveBeenCalled(); expect(await accountSnapshot(id)).toEqual(offSnapshot);
    mockAccount(); const enabled = await call(`/api/channels/${id}`, 'PATCH', { config: { integration } });
    expect(enabled.status).toBe(200); expect(enabled.json.channel.config).toMatchObject({ protocol: 'anthropic', integration }); expect(enabled.json.channel.accountIntegration).toBe(integration);
    expect((await accountSnapshot(id)).credentials).toBe(before.credentials); expect((await store.getChannel(id))?.accountBalance?.status).toBe('ok');
  });
  it.each([
    ['newapi', 'sub2api', { username: 'fresh-sub-account', password: 'fresh-sub-password' }],
    ['sub2api', 'newapi', { accessToken: 'fresh-newapi-token', userId: '42' }],
  ] as const)('requires fresh credentials when switching monitoring from %s to %s and rejects edits atomically', async (original, next, credentials) => {
    mockAccount(); const created = await accountChannel(original), id = created.json.channel.id, before = await accountSnapshot(id);
    for (const accountCredentials of [undefined, { username: 'incomplete' }]) {
      const edited = await call(`/api/channels/${id}`, 'PATCH', { name: 'Must not save', tags: ['must-not-save'], apiKeys: ['must-not-insert'], config: { integration: next }, ...(accountCredentials ? { accountCredentials } : {}) });
      expect(edited.status).toBe(400); expect(await accountSnapshot(id)).toEqual(before);
      const saved = (await new Store(testEnv).getChannel(id))!;
      expect(saved.name).toBe('Account test'); expect(saved.config.integration).toBe(original); expect(saved.credentialCount).toBe(1); expect(saved.accountIntegration).toBe(original);
      expect(await new Store(testEnv).listTags()).not.toContain('must-not-save');
    }
    const replaced = await call(`/api/channels/${id}`, 'PATCH', { config: { integration: next }, accountCredentials: credentials });
    expect(replaced.status).toBe(200); expect(replaced.json.channel.accountIntegration).toBe(next);
    expect(JSON.parse(await decryptSecret((await accountSnapshot(id)).credentials, testEnv))).toEqual(credentials);
  });
  it('retains the NewAPI token backend across monitoring disable and rejects carrying it into Sub2API', async () => {
    mockAccount();
    const created = await call('/api/channels', 'POST', { name: 'Token monitor', endpoint: 'https://account.example', models: ['a'], config: { protocol: 'gemini', integration: 'newapi' }, accountCredentials: { accessToken: 'private-retained-token', userId: '42' } });
    expect(created.status).toBe(201); const id = created.json.channel.id;
    expect((await call(`/api/channels/${id}`, 'PATCH', { config: { integration: 'native' } })).status).toBe(200);
    const before = await accountSnapshot(id), store = new Store(testEnv);
    expect(await store.getChannel(id)).toMatchObject({ accountAuthMode: 'token', accountIntegration: 'newapi', config: { protocol: 'gemini', integration: 'native' } });
    for (const accountCredentials of [undefined, { accessToken: 'wrong-backend-token' }]) {
      expect((await call(`/api/channels/${id}`, 'PATCH', { name: 'Must not save', config: { integration: 'sub2api' }, ...(accountCredentials ? { accountCredentials } : {}) })).status).toBe(400);
      expect(await accountSnapshot(id)).toEqual(before); expect((await store.getChannel(id))?.config.integration).toBe('native');
    }
    const enabled = await call(`/api/channels/${id}`, 'PATCH', { config: { integration: 'newapi' } });
    expect(enabled.status).toBe(200); expect(enabled.json.channel.accountAuthMode).toBe('token'); expect((await accountSnapshot(id)).credentials).toBe(before.credentials);
  });
  it('keeps legacy active-backend credentials but requires fresh credentials for an unknown saved backend after monitoring was disabled', async () => {
    mockAccount(); const created = await accountChannel(), id = created.json.channel.id;
    await testEnv.DB.prepare("UPDATE channels SET data=json_remove(data,'$.accountIntegration') WHERE id=?").bind(id).run();
    expect((await call(`/api/channels/${id}`, 'PATCH', { name: 'Legacy retained' })).status).toBe(200);
    const before = await accountSnapshot(id);
    await testEnv.DB.prepare("UPDATE channels SET data=json_remove(json_set(data,'$.config.integration','native'),'$.accountIntegration') WHERE id=?").bind(id).run();
    for (const integration of ['newapi', 'sub2api'] as const) {
      expect((await call(`/api/channels/${id}`, 'PATCH', { config: { integration } })).status).toBe(400); expect(await accountSnapshot(id)).toEqual(before);
    }
    const enabled = await call(`/api/channels/${id}`, 'PATCH', { config: { integration: 'newapi' }, accountCredentials: { accessToken: 'new-legacy-token' } });
    expect(enabled.status).toBe(200); expect(enabled.json.channel.accountIntegration).toBe('newapi'); expect(enabled.json.channel.accountAuthMode).toBe('token');
  });
  it.each([
    { original: 'newapi', next: 'sub2api', credentials: { username: 'fresh-sub-user', password: 'fresh-sub-password' }, mode: 'password' },
    { original: 'sub2api', next: 'newapi', credentials: { accessToken: 'fresh-newapi-token', userId: '42' }, mode: 'token' },
    { original: 'newapi', next: 'newapi', credentials: { accessToken: 'fresh-same-backend-token', userId: '42' }, mode: 'token' },
    { original: 'sub2api', next: 'sub2api', credentials: { cookie: 'session=fresh-concurrent-cookie', accessToken: 'fresh-concurrent-token' }, mode: 'cookie' },
  ] as const)('keeps a concurrent $next account and destination when a $original metadata save reaches its final transaction', async ({ original, next, credentials, mode }) => {
    mockAccount(); const created = await accountChannel(original), id = created.json.channel.id;
    const store = new Store(testEnv), stale = (await store.getChannel(id))!;
    const fresh = { ...stale, endpoint: 'https://fresh-account.example/v1', config: { ...stale.config, integration: next } };
    let freshSnapshot: AccountSnapshot | undefined;
    const racingDB = new Proxy(testEnv.DB, { get(target, property) {
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
        // The older save has already passed its reuse check. Replace the account
        // immediately before its batch to exercise the real atomic SQL merge.
        await store.saveChannel(fresh, false, [], credentials);
        await refreshAccountBalance(testEnv, fresh, true, true);
        freshSnapshot = await accountSnapshot(id);
        return target.batch(statements);
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await new Store({ ...testEnv, DB: racingDB }).saveChannel({ ...stale, name: 'Concurrent metadata', config: { ...stale.config, protocol: 'gemini' } });
    const saved = (await store.getChannel(id))!;
    expect(saved).toMatchObject({ name: 'Concurrent metadata', endpoint: fresh.endpoint, accountAuthMode: mode, accountIntegration: next, config: { protocol: 'gemini', integration: next } });
    expect(await accountSnapshot(id)).toEqual(freshSnapshot);
    expect(JSON.parse(await decryptSecret(freshSnapshot!.credentials, testEnv))).toEqual(credentials);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input)); expect(url.hostname).toBe('fresh-account.example');
      expect([next === 'sub2api' ? '/api/v1/user/profile' : '/api/user/self', ...(next === 'newapi' ? ['/api/status'] : [])]).toContain(url.pathname);
      return Response.json({ success: true, data: { quota: 1500000, quota_per_unit: 500000, balance: 3 } });
    }); vi.stubGlobal('fetch', fetcher);
    await testEnv.DB.prepare('UPDATE channel_accounts SET next_refresh_at=0 WHERE channel_id=?').bind(id).run();
    await refreshDueAccounts(testEnv, await store.listChannels(), true);
    expect(fetcher).toHaveBeenCalled(); expect((await store.getChannel(id))?.accountBalance).toMatchObject({ status: 'ok', amount: 3 });
  });
  it('can disable monitoring during a concurrent backend replacement without moving its saved credentials back to the old site', async () => {
    mockAccount(); const created = await accountChannel(), id = created.json.channel.id;
    const store = new Store(testEnv), stale = (await store.getChannel(id))!;
    const fresh = { ...stale, endpoint: 'https://fresh-account.example/v1', config: { ...stale.config, integration: 'sub2api' as const } };
    let freshSnapshot: AccountSnapshot | undefined;
    const racingDB = new Proxy(testEnv.DB, { get(target, property) {
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
        await store.saveChannel(fresh, false, [], { username: 'fresh-sub-user', password: 'fresh-sub-password' });
        await refreshAccountBalance(testEnv, fresh, true, true);
        freshSnapshot = await accountSnapshot(id);
        return target.batch(statements);
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await new Store({ ...testEnv, DB: racingDB }).saveChannel({ ...stale, config: { ...stale.config, integration: 'native' } });
    const off = (await store.getChannel(id))!;
    expect(off).toMatchObject({ endpoint: fresh.endpoint, accountIntegration: 'sub2api', config: { integration: 'native' } });
    expect(await accountSnapshot(id)).toEqual(freshSnapshot);
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await refreshAccountBalance(testEnv, off, true, true); await refreshDueAccounts(testEnv, await store.listChannels(), true);
    expect(fetcher).not.toHaveBeenCalled();
    mockAccount();
    const enabled = await call(`/api/channels/${id}`, 'PATCH', { config: { integration: 'sub2api' } });
    expect(enabled.status).toBe(200); expect(enabled.json.channel.endpoint).toBe(fresh.endpoint);
    expect((await accountSnapshot(id)).credentials).toBe(freshSnapshot!.credentials);
  });
  it.each([
    { protocol: 'anthropic', integration: 'newapi' }, { protocol: 'gemini', integration: 'sub2api' },
  ])('requires monitoring credentials on create and import even with native API protocol %s', async config => {
    const input = { name: 'Missing monitor credentials', endpoint: 'https://account.example', models: ['a'], config };
    expect((await call('/api/channels', 'POST', input)).status).toBe(400);
    expect((await call('/api/channels/import', 'POST', { channels: [{ name: 'First must not persist', endpoint: 'https://account.example', models: ['a'], tags: ['must-not-persist'] }, input] })).status).toBe(400);
    expect(await new Store(testEnv).listChannels()).toEqual([]); expect(await new Store(testEnv).listTags()).toEqual([]);
  });
});

describe('encrypted channel accounts and balance refresh', () => {
  const browserCredentials = { cookie: 'session=private-browser-cookie; clearance=private-clearance-cookie', accessToken: 'private-browser-token' };
  async function cookieAccountRow(id: string) {
    return (await testEnv.DB.prepare('SELECT credentials,auth_secret,balance,next_refresh_at,lease_until,version FROM channel_accounts WHERE channel_id=?').bind(id).first<{ credentials: string; auth_secret: string | null; balance: string | null; next_refresh_at: number; lease_until: number; version: number }>())!;
  }
  function mockCookieProfile(balance = 7.25, expected = browserCredentials) {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/api/v1/user/profile');
      const headers = new Headers(init?.headers);
      expect(headers.get('Cookie')).toBe(expected.cookie); expect(headers.get('Authorization')).toBe('Bearer ' + expected.accessToken); expect(headers.get('New-Api-User')).toBeNull();
      expect(init?.body).toBeUndefined();
      return Response.json({ code: 0, data: { balance } });
    }); vi.stubGlobal('fetch', fetcher); return fetcher;
  }
  async function cookieAccountChannel() {
    const created = await call('/api/channels', 'POST', { name: 'Cookie account', endpoint: 'https://account.example', models: ['a'], config: { protocol: 'anthropic', integration: 'sub2api' }, accountCredentials: browserCredentials });
    expect(created.status).toBe(201); await manualBalance(created.json.channel.id); return created;
  }
  it('persists a Sub2API browser JWT without a Cookie under encrypted browser-session mode', async () => {
    const token = 'private-jwt-without-cookie';
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe('/api/v1/user/profile');
      const headers = new Headers(init?.headers); expect(headers.get('Cookie')).toBeNull(); expect(headers.get('Authorization')).toBe('Bearer ' + token); expect(headers.get('New-Api-User')).toBeNull();
      return Response.json({ code: 0, data: { balance: 11.75 } });
    }); vi.stubGlobal('fetch', fetcher);
    const created = await call('/api/channels', 'POST', { name: 'JWT session account', endpoint: 'https://account.example', models: ['a'], config: { integration: 'sub2api' }, accountCredentials: { cookie: '', accessToken: 'Bearer ' + token } });
    expect(created.status).toBe(201); expect(created.json.channel).toMatchObject({ accountAuthMode: 'cookie', accountIntegration: 'sub2api', hasAccountCredentials: true });
    await manualBalance(created.json.channel.id);
    const id = created.json.channel.id, row = await cookieAccountRow(id);
    expect(JSON.parse(await decryptSecret(row.credentials, testEnv))).toEqual({ cookie: '', accessToken: token });
    expect(row.credentials).not.toContain(token); expect(row.auth_secret).not.toContain(token);
    expect((await new Store(testEnv).getChannel(id))?.accountBalance).toMatchObject({ status: 'ok', amount: 11.75 });
    const edited = await call(`/api/channels/${id}`, 'PATCH', { name: 'Kept JWT' });
    expect(edited.status).toBe(200); expect(edited.json.channel.accountAuthMode).toBe('cookie'); expect(await cookieAccountRow(id)).toEqual(row);
    expect(created.content + edited.content + (await call('/api/bootstrap')).content).not.toContain(token); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('encrypts Sub2API Cookie and access-token credentials, preserves blank edits, and never copies them into clones', async () => {
    const fetcher = mockCookieProfile(), created = await cookieAccountChannel(), id = created.json.channel.id, store = new Store(testEnv);
    expect(created.json.channel).toMatchObject({ accountAuthMode: 'cookie', accountIntegration: 'sub2api', hasAccountCredentials: true });
    expect((await store.getChannel(id))?.accountBalance).toMatchObject({ status: 'ok', amount: 7.25, unit: 'USD' });
    const row = await cookieAccountRow(id); expect(row.credentials.startsWith('v1:')).toBe(true); expect(row.auth_secret?.startsWith('v1:')).toBe(true);
    expect(JSON.parse(await decryptSecret(row.credentials, testEnv))).toEqual(browserCredentials);
    expect(JSON.parse(await decryptSecret(row.auth_secret!, testEnv))).toMatchObject({ cookie: browserCredentials.cookie, token: browserCredentials.accessToken });
    for (const value of Object.values(browserCredentials)) { expect(row.credentials).not.toContain(value); expect(row.auth_secret).not.toContain(value); }
    const edited = await call(`/api/channels/${id}`, 'PATCH', { name: 'Kept Cookie', config: { protocol: 'gemini' } });
    expect(edited.status).toBe(200); expect(edited.json.channel.accountAuthMode).toBe('cookie'); expect(await cookieAccountRow(id)).toEqual(row);
    const clone = await call(`/api/channels/${id}/clone`, 'POST', {});
    expect(clone.json.channel.hasAccountCredentials).toBe(false); expect(clone.json.channel.accountAuthMode).toBeUndefined();
    expect(await testEnv.DB.prepare('SELECT channel_id FROM channel_accounts WHERE channel_id=?').bind(clone.json.channel.id).first()).toBeNull();
    for (const value of Object.values(browserCredentials)) expect(created.content + edited.content + clone.content + (await call('/api/bootstrap')).content).not.toContain(value);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('imports Cookie accounts atomically with safe public metadata', async () => {
    const result = await call('/api/channels/import', 'POST', { channels: [{ name: 'Imported Cookie', endpoint: 'https://account.example', models: ['a'], config: { integration: 'sub2api' }, accountCredentials: browserCredentials }] });
    expect(result.status).toBe(201); expect(result.json.channels[0]).toMatchObject({ accountAuthMode: 'cookie', accountIntegration: 'sub2api', hasAccountCredentials: true, accountBalance: { status: 'pending' } });
    const id = result.json.channels[0].id, row = await cookieAccountRow(id);
    expect(JSON.parse(await decryptSecret(row.credentials, testEnv))).toEqual(browserCredentials);
    expect((await new Store(testEnv).getChannel(id))?.accountAuthMode).toBe('cookie');
    for (const value of Object.values(browserCredentials)) expect(result.content).not.toContain(value);
  });
  it('retains Cookie mode and credentials while monitoring is disabled and reenables without password login', async () => {
    mockCookieProfile(); const created = await cookieAccountChannel(), id = created.json.channel.id;
    const row = await cookieAccountRow(id), store = new Store(testEnv), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const off = await call(`/api/channels/${id}`, 'PATCH', { config: { integration: 'native' } });
    expect(off.status).toBe(200); expect(off.json.channel).toMatchObject({ accountAuthMode: 'cookie', accountIntegration: 'sub2api', hasAccountCredentials: true });
    expect((await cookieAccountRow(id)).credentials).toBe(row.credentials);
    expect((await call(`/api/channels/${id}/balance`, 'POST', {})).status).toBe(400); expect(fetcher).not.toHaveBeenCalled();
    const profileFetch = mockCookieProfile(10.25);
    const on = await call(`/api/channels/${id}`, 'PATCH', { config: { integration: 'sub2api' } });
    expect(on.status).toBe(200); expect(on.json.channel.accountAuthMode).toBe('cookie'); expect(profileFetch).not.toHaveBeenCalled();
    await manualBalance(id); expect(profileFetch).toHaveBeenCalledTimes(1);
    expect((await cookieAccountRow(id)).credentials).toBe(row.credentials); expect((await store.getChannel(id))?.accountBalance?.amount).toBe(10.25);
  });
  it.each(['newapi', 'native'] as const)('rejects Cookie credentials for %s before saving channels or partial imports', async integration => {
    const input = { name: 'Wrong Cookie backend', endpoint: 'https://account.example', models: ['a'], tags: ['must-not-save'], config: { integration }, accountCredentials: browserCredentials };
    expect((await call('/api/channels', 'POST', input)).status).toBe(400);
    expect((await call('/api/channels/import', 'POST', { channels: [{ ...input, name: 'Valid first Cookie', config: { integration: 'sub2api' } }, input] })).status).toBe(400);
    expect(await new Store(testEnv).listChannels()).toEqual([]); expect(await new Store(testEnv).listTags()).toEqual([]);
  });
  it('replaces password and Cookie authentication without retaining the previous mode session', async () => {
    mockAccount(); const created = await accountChannel('sub2api'), id = created.json.channel.id, store = new Store(testEnv);
    const old = await cookieAccountRow(id); expect((await store.getChannel(id))?.accountAuthMode).toBe('password');
    mockCookieProfile(6.75);
    const cookie = await call(`/api/channels/${id}`, 'PATCH', { accountCredentials: browserCredentials });
    expect(cookie.status).toBe(200); expect(cookie.json.channel.accountAuthMode).toBe('cookie');
    await manualBalance(id);
    const cookieRow = await cookieAccountRow(id); expect(cookieRow.version).toBeGreaterThan(old.version); expect(JSON.parse(await decryptSecret(cookieRow.credentials, testEnv))).toEqual(browserCredentials);
    expect(JSON.parse(await decryptSecret(cookieRow.auth_secret!, testEnv))).toMatchObject({ cookie: browserCredentials.cookie, token: browserCredentials.accessToken });
    expect((await store.getChannel(id))?.accountBalance?.amount).toBe(6.75);
    mockAccount(9.5);
    const password = await call(`/api/channels/${id}`, 'PATCH', { accountCredentials: { username: 'new-private-user', password: 'new-private-password' } });
    expect(password.status).toBe(200); expect(password.json.channel.accountAuthMode).toBe('password');
    await manualBalance(id);
    const passwordRow = await cookieAccountRow(id);
    expect(JSON.parse(await decryptSecret(passwordRow.credentials, testEnv))).toEqual({ username: 'new-private-user', password: 'new-private-password' });
    expect(JSON.parse(await decryptSecret(passwordRow.auth_secret!, testEnv))).not.toHaveProperty('cookie');
    expect((await store.getChannel(id))?.accountBalance?.amount).toBe(9.5);
  });
  it('uses Cookie credentials for manual and scheduled refresh and safely preserves a balance on expiry', async () => {
    mockCookieProfile(); const created = await cookieAccountChannel(), id = created.json.channel.id, store = new Store(testEnv);
    const manualFetch = mockCookieProfile(8.5);
    expect((await call(`/api/channels/${id}/balance`, 'POST', {})).status).toBe(200); expect(manualFetch).toHaveBeenCalledTimes(1);
    expect((await store.getChannel(id))?.accountBalance?.amount).toBe(8.5);
    await testEnv.DB.prepare('UPDATE channel_accounts SET next_refresh_at=0 WHERE channel_id=?').bind(id).run();
    const cronFetch = mockCookieProfile(9.5); await runScheduled(); expect(cronFetch).toHaveBeenCalledTimes(1);
    const last = (await store.getChannel(id))!.accountBalance!;
    const failedFetch = vi.fn(async () => Response.json({ message: JSON.stringify(browserCredentials) }, { status: 401 })); vi.stubGlobal('fetch', failedFetch);
    const failure = await call(`/api/channels/${id}/balance`, 'POST', {});
    const balance = (await store.getChannel(id))!.accountBalance!;
    expect(balance).toMatchObject({ status: 'error', amount: last.amount, updatedAt: last.updatedAt }); expect(balance.error).toMatch(/Cookie|会话/);
    for (const value of Object.values(browserCredentials)) expect(failure.content + JSON.stringify(balance)).not.toContain(value);
    expect(failedFetch).toHaveBeenCalledTimes(1);
  });
  it('does not overwrite a newer Cookie credential replacement when an older balance refresh completes', async () => {
    mockCookieProfile(); const created = await cookieAccountChannel(), id = created.json.channel.id, store = new Store(testEnv);
    const staleChannel = (await store.getChannel(id))!, old = await cookieAccountRow(id);
    let release!: (value: Response) => void, started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Cookie')).toBe(browserCredentials.cookie); started();
      return new Promise<Response>(resolve => { release = resolve; });
    }); vi.stubGlobal('fetch', fetcher);
    const refreshing = refreshAccountBalance(testEnv, staleChannel, true, true); await began;
    const next = { cookie: 'session=fresh-private-browser-cookie', accessToken: 'fresh-private-browser-token' };
    await store.saveChannel(staleChannel, false, [], next);
    const replaced = await cookieAccountRow(id); expect(replaced.version).toBe(old.version + 1); expect(replaced.auth_secret).toBeNull(); expect(replaced.balance).toBeNull();
    release(Response.json({ code: 0, data: { balance: 999 } })); await refreshing;
    expect(await cookieAccountRow(id)).toEqual(replaced); expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await store.getChannel(id))?.accountBalance).toMatchObject({ status: 'pending', amount: null });
  });
  it('encrypts NewAPI dashboard tokens, refreshes without login, and preserves authentication mode on edits', async () => {
    const token = 'private-dashboard-access-token';
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      expect(path).not.toContain('/login');
      if (path === '/api/status') return Response.json({ success:true,data:{ turnstile_check:true,quota_per_unit:500000 } });
      expect(path).toBe('/api/user/self');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ' + token);
      expect(new Headers(init?.headers).get('New-Api-User')).toBe('42');
      return Response.json({ success:true,data:{ quota:2500000 } });
    });
    vi.stubGlobal('fetch',fetcher);
    const created = await call('/api/channels','POST',{ name:'Token account',endpoint:'https://account.example',models:['a'],config:{ integration:'newapi' },accountCredentials:{ accessToken:token,userId:'42' } });
    expect(created.status).toBe(201); expect(created.json.channel.accountAuthMode).toBe('token');
    const id = created.json.channel.id;
    await manualBalance(id);
    const store = new Store(testEnv);
    expect((await store.getChannel(id))?.accountBalance).toMatchObject({ status:'ok',amount:5,unit:'USD' });
    const row = await testEnv.DB.prepare('SELECT credentials FROM channel_accounts WHERE channel_id=?').bind(id).first<{credentials:string}>();
    expect(row!.credentials.startsWith('v1:')).toBe(true); expect(row!.credentials).not.toContain(token);
    expect(JSON.parse(await decryptSecret(row!.credentials,testEnv))).toEqual({ accessToken:token,userId:'42' });
    const edited = await call(`/api/channels/${id}`,'PATCH',{ name:'Kept token' });
    expect(edited.json.channel.accountAuthMode).toBe('token');
    expect((await testEnv.DB.prepare('SELECT credentials FROM channel_accounts WHERE channel_id=?').bind(id).first<{credentials:string}>())?.credentials).toBe(row!.credentials);
    const clone = await call(`/api/channels/${id}/clone`,'POST',{});
    expect(clone.json.channel.hasAccountCredentials).toBe(false); expect(clone.json.channel.accountAuthMode).toBeUndefined();
    expect(created.content+edited.content+clone.content+(await call('/api/bootstrap')).content).not.toContain(token);
    mockAccount();
    const replaced = await call(`/api/channels/${id}`,'PATCH',{ accountCredentials:{ username:'updated-user',password:'updated-password' } });
    expect(replaced.status).toBe(200); expect(replaced.json.channel.accountAuthMode).toBe('password');
    const next = await testEnv.DB.prepare('SELECT credentials FROM channel_accounts WHERE channel_id=?').bind(id).first<{credentials:string}>();
    expect(JSON.parse(await decryptSecret(next!.credentials,testEnv))).toEqual({ username:'updated-user',password:'updated-password' });
  });
  it('imports NewAPI token accounts with public mode metadata and encrypted credentials', async () => {
    const token = 'private-imported-dashboard-token';
    const result = await call('/api/channels/import','POST',{ channels:[{ name:'Imported token',endpoint:'https://account.example/v1',models:['a'],config:{ integration:'newapi' },accountCredentials:{ accessToken:token } }] });
    expect(result.status).toBe(201); expect(result.json.channels[0].accountAuthMode).toBe('token');
    expect(result.content).not.toContain(token);
    const saved = await new Store(testEnv).getChannel(result.json.channels[0].id);
    expect(saved?.accountAuthMode).toBe('token'); expect(saved?.hasAccountCredentials).toBe(true);
    const row = await testEnv.DB.prepare('SELECT credentials FROM channel_accounts WHERE channel_id=?').bind(saved!.id).first<{credentials:string}>();
    expect(JSON.parse(await decryptSecret(row!.credentials,testEnv))).toEqual({ accessToken:token });
  });
  it('preserves the current authentication mode when an older metadata snapshot is saved', async () => {
    mockAccount();
    const created = await accountChannel();
    const store = new Store(testEnv);
    const stale = (await store.getChannel(created.json.channel.id))!;
    await store.saveChannel(stale,false,[],{ accessToken:'new-dashboard-token',userId:'42' });
    await store.saveChannel({ ...stale,name:'Updated from old snapshot' });
    expect((await store.getChannel(stale.id))?.accountAuthMode).toBe('token');
    const row = await testEnv.DB.prepare('SELECT credentials FROM channel_accounts WHERE channel_id=?').bind(stale.id).first<{credentials:string}>();
    expect(JSON.parse(await decryptSecret(row!.credentials,testEnv))).toEqual({ accessToken:'new-dashboard-token',userId:'42' });
    expect((await call(`/api/channels/${stale.id}`,'PATCH',{ config:{ integration:'sub2api' } })).status).toBe(400);
  });
  it('rejects token accounts for Sub2API before writing channels or partial imports', async () => {
    const input = { name:'Unsupported token',endpoint:'https://account.example/v1',models:['a'],config:{ integration:'sub2api' },accountCredentials:{ accessToken:'private-token' } };
    expect((await call('/api/channels','POST',input)).status).toBe(400);
    expect((await call('/api/channels/import','POST',{ channels:[{ ...input,name:'Valid token',config:{ integration:'newapi' } },input] })).status).toBe(400);
    expect(await new Store(testEnv).listChannels()).toEqual([]);
  });
  it('completes a NewAPI encrypted-password handshake after ordinary login is rejected', async () => {
    const pair = await crypto.subtle.generateKey({ name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256' },true,['encrypt','decrypt']);
    const exported = new Uint8Array(await crypto.subtle.exportKey('spki',pair.publicKey));
    const publicKey = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...exported))}\n-----END PUBLIC KEY-----`;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/status') return Response.json({ success:true,data:{ password_login_encryption_enabled:true,quota_per_unit:500000 } });
      if (path === '/api/user/login/encryption-key') return Response.json({ success:true,data:{ enabled:true,kid:'test-kid',public_key:publicKey } });
      if (path === '/api/user/login') {
        const payload = JSON.parse(String(init?.body));
        if (payload.password) return Response.json({ success:false,message:'Encrypted password required' });
        expect(payload.encryption_key_id).toBe('test-kid'); expect(payload.password).toBeUndefined();
        const ciphertext = Uint8Array.from(atob(payload.password_encrypted), c => c.charCodeAt(0));
        expect(new TextDecoder().decode(await crypto.subtle.decrypt({ name:'RSA-OAEP' },pair.privateKey,ciphertext))).toBe('fake-account-password');
        return Response.json({ success:true,data:{ access_token:'fake-session',user:{ id:42 },expires_in:3600 } });
      }
      return Response.json({ success:true,data:{ quota:5000000 } });
    });
    vi.stubGlobal('fetch',fetcher);
    const result = await accountChannel();
    expect((await new Store(testEnv).getChannel(result.json.channel.id))?.accountBalance?.amount).toBe(10);
    expect(fetcher.mock.calls.filter(([target]) => new URL(String(target)).pathname === '/api/user/login')).toHaveLength(2);
  });
  it('encrypts account data and sessions, keeps edits blank, and does not copy accounts', async () => {
    mockAccount(); const created = await accountChannel(); const id = created.json.channel.id;
    const row = await testEnv.DB.prepare('SELECT * FROM channel_accounts WHERE channel_id=?').bind(id).first<{ credentials:string;auth_secret:string;balance:string }>();
    expect(JSON.parse(await decryptSecret(row!.credentials,testEnv))).toEqual({ username:'fake-user@example.com',password:'fake-account-password' });
    expect(row!.credentials).not.toContain('fake-account-password'); expect(row!.auth_secret).not.toContain('private-session-token');
    expect(JSON.parse(row!.balance).amount).toBe(12.5);
    const patched = await call(`/api/channels/${id}`,'PATCH',{ name:'Edited' });
    expect(patched.json.channel.hasAccountCredentials).toBe(true); expect(patched.json.channel.accountBalance.amount).toBe(12.5);
    const clone = await call(`/api/channels/${id}/clone`,'POST',{}); expect(clone.json.channel.hasAccountCredentials).toBe(false);
    expect(await testEnv.DB.prepare('SELECT channel_id FROM channel_accounts WHERE channel_id=?').bind(clone.json.channel.id).first()).toBeNull();
    for (const secret of ['fake-user@example.com','fake-account-password','private-session-token']) { expect(created.content+patched.content+(await call('/api/bootstrap')).content).not.toContain(secret); }
    expect((await testEnv.DB.prepare('SELECT credentials FROM channel_accounts WHERE channel_id=?').bind(id).first<{ credentials:string }>())?.credentials).toBe(row!.credentials);
  });
  it('requires a complete account and validates before modifying metadata', async () => {
    expect((await call('/api/channels','POST',{ name:'Missing account',endpoint:'https://account.example/v1',models:['a'],config:{ integration:'newapi' } })).status).toBe(400);
    mockAccount(); const created = await accountChannel('sub2api');
    expect((await call(`/api/channels/${created.json.channel.id}`,'PATCH',{ name:'Should not change',accountCredentials:{ username:'incomplete' } })).status).toBe(400);
    expect((await new Store(testEnv).getChannel(created.json.channel.id))?.name).toBe('Account test');
  });
  it('validates every imported account before creating any channel', async () => {
    const result = await call('/api/channels/import','POST',{ channels:[{ name:'Valid first',endpoint:'https://models.example/v1',models:['a'] },{ name:'Incomplete second',endpoint:'https://account.example/v1',models:['a'],config:{ integration:'newapi' },accountCredentials:{ username:'incomplete' } }] });
    expect(result.status).toBe(400); expect(await new Store(testEnv).listChannels()).toEqual([]);
  });
  it('pre-encrypts the entire import and leaves no channels or tags after a later encryption failure', async () => {
    const result = await call('/api/channels/import','POST',{ channels:[
      { name:'First no keys',endpoint:'https://models.example/v1',models:['a'],tags:['must-not-remain'] },
      { name:'Later key',endpoint:'https://models.example/v1',models:['a'],apiKeys:['private-imported-key'] },
    ] },true,{ ...testEnv,ENCRYPTION_KEY:undefined });
    expect(result.status).toBe(500); expect(await new Store(testEnv).listChannels()).toEqual([]); expect(await new Store(testEnv).listTags()).toEqual([]);
  });
  it('imports credentials and management accounts atomically without exposing secrets', async () => {
    const result = await call('/api/channels/import','POST',{ channels:[
      { name:'Plain',endpoint:'https://models.example/v1',models:['a'],tags:['shared'],apiKeys:['imported-private-key'] },
      { name:'Managed',endpoint:'https://account.example/v1',models:['a'],tags:['shared'],config:{ integration:'sub2api' },accountCredentials:{ username:'private-user@example.com',password:'private-password' } },
    ] });
    expect(result.status).toBe(201); expect(result.json.channels).toHaveLength(2); expect(await new Store(testEnv).listTags()).toEqual(['shared']);
    const plain = result.json.channels.find((c:GatewayChannel) => c.name === 'Plain'); const managed = result.json.channels.find((c:GatewayChannel) => c.name === 'Managed');
    expect((await new Store(testEnv).getCredentials(plain.id))[0].secret).toBe('imported-private-key');
    expect(managed.hasAccountCredentials).toBe(true); expect(managed.accountBalance.status).toBe('pending');
    for (const secret of ['imported-private-key','private-user@example.com','private-password']) expect(result.content).not.toContain(secret);
  });
  it('rolls back every imported channel, tag and key if the final D1 write is rejected', async () => {
    await testEnv.DB.exec("CREATE TRIGGER reject_imported_key BEFORE INSERT ON credentials WHEN NEW.label='reject-import' BEGIN SELECT RAISE(ABORT,'injected write failure'); END");
    try {
      const result = await call('/api/channels/import','POST',{ channels:[
        { name:'First',endpoint:'https://models.example/v1',models:['a'],tags:['rolled-back'] },
        { name:'Second',endpoint:'https://models.example/v1',models:['a'],apiKeys:[{ label:'reject-import',secret:'private-key' }] },
      ] });
      expect(result.status).toBe(500); const store = new Store(testEnv); expect(await store.listChannels()).toEqual([]); expect(await store.listTags()).toEqual([]);
      expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM credentials').first<{count:number}>())?.count).toBe(0);
    } finally { await testEnv.DB.exec('DROP TRIGGER reject_imported_key'); }
  });
  it('invalidates cached sessions and balances when the configured site changes', async () => {
    mockAccount(); const created = await accountChannel(); const store = new Store(testEnv); const id = created.json.channel.id;
    const before = await testEnv.DB.prepare('SELECT credentials,version FROM channel_accounts WHERE channel_id=?').bind(id).first<{ credentials:string;version:number }>();
    await store.saveChannel({ ...(await store.getChannel(id))!,endpoint:'https://another-site.example/v1' });
    const row = await testEnv.DB.prepare('SELECT * FROM channel_accounts WHERE channel_id=?').bind(id).first<{ credentials:string;auth_secret:string|null;balance:string|null;version:number;next_refresh_at:number }>();
    expect(row?.credentials).toBe(before?.credentials); expect(row?.auth_secret).toBeNull(); expect(row?.balance).toBeNull(); expect(row?.version).toBe(before!.version+1); expect(row?.next_refresh_at).toBe(0);
    expect((await store.getChannel(id))?.accountBalance?.status).toBe('pending');
  });
  it('pairs fresh credentials with their current site even when Cron supplies an older channel snapshot', async () => {
    mockAccount(); const created = await accountChannel(); const store = new Store(testEnv);
    const stale = (await store.getChannel(created.json.channel.id))!;
    await store.saveChannel({ ...stale,endpoint:'https://new-account-site.example/v1' },false,[],{ username:'new-user@example.com',password:'new-account-password' });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).hostname).toBe('new-account-site.example');
      if (new URL(String(input)).pathname.endsWith('/login')) {
        expect(JSON.parse(String(init?.body))).toEqual({ username:'new-user@example.com',password:'new-account-password' });
        return Response.json({ success:true,data:{ access_token:'new-session',user:{ id:55 } } });
      }
      return Response.json({ success:true,data:{ quota:1500000,quota_per_unit:500000 } });
    });
    vi.stubGlobal('fetch',fetcher);
    await refreshAccountBalance(testEnv,stale,true,true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect((await store.getChannel(stale.id))?.accountBalance?.amount).toBe(3);
  });
  it('throttles automatic refresh, allows forced refresh, and preserves last known balance on failure', async () => {
    mockAccount(); const created = await accountChannel(); const store = new Store(testEnv); const channel = (await store.getChannel(created.json.channel.id))!;
    const fetcher = vi.fn(async () => Response.json({ success:true,data:{ quota:1000000,quota_per_unit:500000 } })); vi.stubGlobal('fetch',fetcher);
    await refreshAccountBalance(testEnv,channel,true); expect(fetcher).not.toHaveBeenCalled();
    await refreshAccountBalance(testEnv,channel,true,true); expect((await store.getChannel(channel.id))?.accountBalance?.amount).toBe(2);
    vi.stubGlobal('fetch',vi.fn(async () => Response.json({ message:'fake-account-password private-session-token' },{ status:503 })));
    await refreshAccountBalance(testEnv,channel,true,true);
    const result = (await store.getChannel(channel.id))?.accountBalance;
    expect(result?.status).toBe('error'); expect(result?.amount).toBe(2); expect(result?.updatedAt).not.toBeNull(); expect(JSON.stringify(result)).not.toContain('fake-account-password');
  });
  it('does not let archived accounts consume scheduled refresh slots', async () => {
    mockAccount(); const created = await accountChannel(); const store = new Store(testEnv); const channel = (await store.getChannel(created.json.channel.id))!;
    await store.saveChannel({ ...channel,archived:true });
    await testEnv.DB.prepare('UPDATE channel_accounts SET next_refresh_at=0').run();
    const fetcher = vi.fn(); vi.stubGlobal('fetch',fetcher);
    await refreshDueAccounts(testEnv,await store.listChannels(),true); expect(fetcher).not.toHaveBeenCalled();
  });
  it('bounds each Cron batch to five and leaves bootstrap as a cached read', async () => {
    mockAccount();
    for (let i=0;i<7;i++) await accountChannel();
    await testEnv.DB.prepare('UPDATE channel_accounts SET next_refresh_at=0').run();
    await runScheduled();
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM channel_accounts WHERE next_refresh_at>0').first<{count:number}>())?.count).toBe(5);
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await call('/api/bootstrap');
    expect(fetcher).not.toHaveBeenCalled();
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM channel_accounts WHERE next_refresh_at>0').first<{count:number}>())?.count).toBe(5);
    mockAccount(); await runScheduled();
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM channel_accounts WHERE next_refresh_at>0').first<{count:number}>())?.count).toBe(7);
  });
});

describe('Worker Cron balance monitoring', () => {
  const backends = [
    { integration: 'newapi', credentials: { accessToken: 'fake-cron-newapi-token', userId: '42' }, path: '/api/user/self', payload: { success: true, data: { quota: 1500000 } }, amount: 3, unit: 'USD' },
    { integration: 'sub2api', credentials: { cookie: 'session=fake-cron-cookie', accessToken: 'fake-cron-sub2api-token' }, path: '/api/v1/user/profile', payload: { code: 0, data: { balance: 9.5 } }, amount: 9.5, unit: 'USD' },
  ] as const;

  it.each(backends)('does not query $integration balances from create, edit, or browser reads', async ({ integration, credentials }) => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const created = await call('/api/channels', 'POST', { name: `${integration} queued`, endpoint: 'https://monitor.example/v1', models: ['a'], config: { integration }, accountCredentials: credentials });
    expect(created.status).toBe(201); expect(created.json.channel.accountBalance).toMatchObject({ status: 'pending', amount: null });
    const id = created.json.channel.id;
    const edited = await call(`/api/channels/${id}`, 'PATCH', { endpoint: 'https://updated-monitor.example/v1', config: { protocol: 'gemini' }, accountCredentials: credentials });
    expect(edited.status).toBe(200); expect(edited.json.channel.accountBalance).toMatchObject({ status: 'pending', amount: null });
    expect((await call('/api/bootstrap')).status).toBe(200); expect((await call('/api/channels')).status).toBe(200);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await testEnv.DB.prepare('SELECT next_refresh_at,lease_until,auth_secret,balance FROM channel_accounts WHERE channel_id=?').bind(id).first()).toMatchObject({ next_refresh_at: 0, lease_until: 0, auth_secret: null, balance: null });
  });

  it.each(backends)('refreshes $integration through a scheduled event without an HTTP entry', async ({ integration, credentials, path, payload, amount, unit }) => {
    const store = new Store(testEnv);
    const channel = parseChannel({ name: `${integration} scheduled`, endpoint: 'https://cron-monitor.example/v1', models: ['a'], config: { integration } }, true);
    await store.saveChannel(channel, false, [], credentials);
    const http = vi.spyOn(worker, 'fetch');
    const fetcher = vi.fn(async (target: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(target)), headers = new Headers(init?.headers);
      expect(url.origin).toBe('https://cron-monitor.example'); expect(init?.body).toBeUndefined(); expect(headers.get('Accept')).toBe('application/json');
      if (integration === 'newapi' && url.pathname === '/api/status') return Response.json({ success: true, data: { quota_per_unit: 500000 } });
      expect(url.pathname).toBe(path); expect(headers.get('Authorization')).toBe('Bearer ' + credentials.accessToken);
      if (integration === 'newapi') expect(headers.get('New-Api-User')).toBe('42');
      if (integration === 'sub2api') expect(headers.get('Cookie')).toBe('session=fake-cron-cookie');
      return Response.json(payload);
    }); vi.stubGlobal('fetch', fetcher);
    const started = Date.now();
    await runScheduled();
    expect(http).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(integration === 'newapi' ? 2 : 1);
    const balance = (await store.getChannel(channel.id))?.accountBalance;
    expect(balance).toMatchObject({ status: 'ok', amount, unit }); expect(Date.parse(balance!.checkedAt!)).toBeGreaterThanOrEqual(started);
    const row = await testEnv.DB.prepare('SELECT next_refresh_at,lease_until,credentials,auth_secret FROM channel_accounts WHERE channel_id=?').bind(channel.id).first<{ next_refresh_at: number; lease_until: number; credentials: string; auth_secret: string }>();
    expect(row!.next_refresh_at).toBeGreaterThan(started); expect(row!.lease_until).toBe(0); expect(row!.credentials).not.toContain(credentials.accessToken); expect(row!.auth_secret).not.toContain(credentials.accessToken);
    await runScheduled(); expect(fetcher).toHaveBeenCalledTimes(integration === 'newapi' ? 2 : 1);
  });

  it('advances failing accounts and later batches so one rejected upstream cannot starve the queue', async () => {
    const store = new Store(testEnv), ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const channel = parseChannel({ name: `Cron queue ${i}`, endpoint: `https://queue-${i}.example/v1`, models: ['a'], config: { integration: 'newapi' } }, true);
      await store.saveChannel(channel, false, [], { accessToken: `fake-queue-token-${i}` }); ids.push(channel.id);
    }
    const fetcher = vi.fn(async (target: RequestInfo | URL) => {
      const url = new URL(String(target));
      if (url.hostname === 'queue-0.example') return Response.json({ message: 'fake-queue-token-0' }, { status: 503 });
      if (url.pathname === '/api/status') return Response.json({ success: true, data: { quota_per_unit: 500000 } });
      expect(url.pathname).toBe('/api/user/self'); return Response.json({ success: true, data: { quota: 500000 } });
    }); vi.stubGlobal('fetch', fetcher);
    await runScheduled();
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM channel_accounts WHERE next_refresh_at>0').first<{ count: number }>())?.count).toBe(5);
    await runScheduled();
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM channel_accounts WHERE next_refresh_at>0 AND lease_until=0').first<{ count: number }>())?.count).toBe(7);
    const failed = (await store.getChannel(ids[0]))!.accountBalance!;
    expect(failed).toMatchObject({ status: 'error', amount: null }); expect(failed.error).not.toContain('fake-queue-token-0');
    for (const id of ids.slice(1)) expect((await store.getChannel(id))?.accountBalance).toMatchObject({ status: 'ok', amount: 1 });
    expect(fetcher.mock.calls.filter(([target]) => new URL(String(target)).hostname === 'queue-0.example')).toHaveLength(1);
  });

  it('still refreshes balances and releases their lease when settings cannot be read', async () => {
    const store = new Store(testEnv), fixture = backends[1];
    const channel = parseChannel({ name: 'Balance survives settings failure', endpoint: 'https://independent-cron.example/v1', models: ['a'], config: { integration: fixture.integration } }, true);
    await store.saveChannel(channel, false, [], fixture.credentials);
    vi.spyOn(Store.prototype, 'getSettings').mockRejectedValueOnce(new Error('injected settings read failure'));
    const fetcher = vi.fn(async (target: RequestInfo | URL) => {
      expect(new URL(String(target)).pathname).toBe(fixture.path); return Response.json(fixture.payload);
    }); vi.stubGlobal('fetch', fetcher);
    const started = Date.now();
    await expect(runScheduled()).rejects.toThrow('injected settings read failure');
    expect(fetcher).toHaveBeenCalledTimes(1); expect((await store.getChannel(channel.id))?.accountBalance).toMatchObject({ status: 'ok', amount: fixture.amount, unit: fixture.unit });
    const row = await testEnv.DB.prepare('SELECT next_refresh_at,lease_until FROM channel_accounts WHERE channel_id=?').bind(channel.id).first<{ next_refresh_at: number; lease_until: number }>();
    expect(row!.lease_until).toBe(0); expect(row!.next_refresh_at).toBeGreaterThan(started);
  });

  it('still refreshes balances and releases their lease when the health recovery query fails', async () => {
    const store = new Store(testEnv), fixture = backends[1];
    const channel = parseChannel({ name: 'Balance survives health failure', endpoint: 'https://independent-cron.example/v1', models: ['a'], config: { integration: fixture.integration } }, true);
    await store.saveChannel(channel, false, [], fixture.credentials);
    const failure = new Error('injected health recovery query failure');
    let healthQueries = 0;
    const database = new Proxy(testEnv.DB, { get(target, property) {
      if (property === 'prepare') return (sql: string) => {
        if (sql.startsWith('SELECT k.channel_id,k.id,k.reason,k.disabled_at FROM credentials k')) { healthQueries++; throw failure; }
        return target.prepare(sql);
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const http = vi.spyOn(worker, 'fetch');
    const fetcher = vi.fn(async (target: RequestInfo | URL) => {
      expect(new URL(String(target)).pathname).toBe(fixture.path); return Response.json(fixture.payload);
    }); vi.stubGlobal('fetch', fetcher);
    const started = Date.now();
    await expect(runScheduled({ ...testEnv, DB: database })).rejects.toThrow(failure.message);
    expect(healthQueries).toBe(1); expect(http).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await store.getChannel(channel.id))?.accountBalance).toMatchObject({ status: 'ok', amount: fixture.amount, unit: fixture.unit });
    const row = await testEnv.DB.prepare('SELECT next_refresh_at,lease_until FROM channel_accounts WHERE channel_id=?').bind(channel.id).first<{ next_refresh_at: number; lease_until: number }>();
    expect(row!.lease_until).toBe(0); expect(row!.next_refresh_at).toBeGreaterThan(started);
  });

  it('still refreshes balances when cleanup fails and reports the scheduled failure', async () => {
    const store = new Store(testEnv), fixture = backends[1];
    const channel = parseChannel({ name: 'Independent Cron balance', endpoint: 'https://independent-cron.example/v1', models: ['a'], config: { integration: fixture.integration } }, true);
    await store.saveChannel(channel, false, [], fixture.credentials);
    vi.spyOn(Store.prototype, 'cleanup').mockRejectedValueOnce(new Error('injected cleanup failure'));
    const fetcher = vi.fn(async (target: RequestInfo | URL) => {
      expect(new URL(String(target)).pathname).toBe(fixture.path); return Response.json(fixture.payload);
    }); vi.stubGlobal('fetch', fetcher);
    await expect(runScheduled()).rejects.toThrow('injected cleanup failure');
    expect(fetcher).toHaveBeenCalledTimes(1); expect((await store.getChannel(channel.id))?.accountBalance).toMatchObject({ status: 'ok', amount: fixture.amount });
  });
});
