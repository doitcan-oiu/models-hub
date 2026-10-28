import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../worker/index';
import { prepareAccountSave, refreshAccountBalance, refreshDueAccounts } from '../worker/accounts';
import { BBDEVLAB_EXHAUSTED_REASON, BBDEVLAB_EXPIRED_REASON, channelCredentialBalance, refreshChannelCredentialBalances, refreshCredentialBalance, refreshDueCredentialBalances } from '../worker/credential-balances';
import { decryptSecret } from '../worker/crypto';
import { Store } from '../worker/store';
import { apiKey, channel as parseChannel } from '../worker/validation';
import type { Env } from '../worker/env';
import type { AttemptRecord, GatewayChannel } from '../shared/types';

const testEnv = env as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
type BalanceRow = { credential_id: string; balance: string | null; next_refresh_at: number; lease_until: number; version: number };
type KeyRow = { id: string; enabled: number; reason: string | null; disabled_at: string | null; secret: string };
const store = () => new Store(testEnv);
const balanceRow = (id: string) => testEnv.DB.prepare('SELECT * FROM credential_balances WHERE credential_id=?').bind(id).first<BalanceRow>();
const keyRow = (id: string) => testEnv.DB.prepare('SELECT id,enabled,reason,disabled_at,secret FROM credentials WHERE id=?').bind(id).first<KeyRow>();
const usage = (available: unknown) => Response.json({ code: true, data: { total_available: available } });
const expiringUsage = (available: unknown, expiresAt: unknown) => Response.json({ code: true, data: { total_available: available, expires_at: expiresAt } });
const keyMeta = async (channel: GatewayChannel, id: string) => (await store().listCredentialMeta(channel.id)).find(key => key.id === id)!;

async function call(path: string, method = 'GET', data?: unknown) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('http://127.0.0.1:8787' + path, {
    method, headers: { authorization: 'Bearer ' + testEnv.ADMIN_TOKEN, ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }), testEnv, ctx);
  const content = await response.text(); await waitOnExecutionContext(ctx);
  return { status: response.status, content, json: JSON.parse(content) };
}
async function inference(token: string) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('http://127.0.0.1:8787/v1/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'Use the aggregated keys' }], stream: false }),
  }), testEnv, ctx);
  const content = await response.text(); await waitOnExecutionContext(ctx);
  return { response, content };
}
function attempt(channel: GatewayChannel, credentialId: string, patch: Partial<AttemptRecord> = {}): AttemptRecord {
  return { id: crypto.randomUUID(), requestId: crypto.randomUUID(), channelId: channel.id, channelName: channel.name,
    credentialId, model: 'test', stream: false, startedAt: new Date().toISOString(), ttft: null, duration: 0.01,
    status: 200, result: 'success', error: null, inputTokens: 1, outputTokens: 1, attempt: 1, ...patch };
}
async function seed(count = 1, options: { archived?: boolean; integration?: 'bbdevlab' | 'native'; endpoint?: string } = {}) {
  const channel = parseChannel({ name: 'Aggregated BBDevLab keys', endpoint: options.endpoint ?? 'https://bb.example/deployment/v1/', models: ['test'], archived: options.archived ?? false, config: { integration: options.integration ?? 'bbdevlab' } }, true);
  const secrets = Array.from({ length: count }, (_, i) => `private-bb-key-${i}-${channel.id}`);
  await store().saveChannel(channel, false, secrets.map((secret, i) => ({ label: `Key ${i}`, secret })));
  return { channel: (await store().getChannel(channel.id))!, keys: (await store().listCredentialMeta(channel.id)).sort((a, b) => a.label.localeCompare(b.label)), secrets };
}
function fetchValues(...values: unknown[]) {
  const fetcher = vi.fn<typeof globalThis.fetch>();
  for (const value of values) fetcher.mockResolvedValueOnce(value instanceof Response ? value : usage(value));
  fetcher.mockRejectedValue(new Error('Unexpected BBDevLab request')); vi.stubGlobal('fetch', fetcher); return fetcher;
}
function fetchKeyValues(secrets: string[], values: unknown[]) {
  const fetcher = vi.fn(async (_target: RequestInfo | URL, init?: RequestInit) => {
    const index = secrets.findIndex(secret => new Headers(init?.headers).get('authorization') === 'Bearer ' + secret);
    if (index < 0) throw new Error('Unexpected credential');
    return usage(values[index]);
  });
  vi.stubGlobal('fetch', fetcher); return fetcher;
}
function holdFetch() {
  let began!: () => void, finish!: (response: Response) => void;
  const started = new Promise<void>(resolve => began = resolve), response = new Promise<Response>(resolve => finish = resolve);
  const fetcher = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => { began(); return response; });
  vi.stubGlobal('fetch', fetcher); return { started, finish, fetcher };
}

beforeAll(async () => { await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS); });
beforeEach(async () => {
  await testEnv.DB.batch(['credential_balances', 'channel_accounts', 'credentials', 'channels', 'profile_usage', 'api_keys', 'attempts', 'request_logs', 'events', 'settings', 'tags', 'gateway_state'].map(table => testEnv.DB.prepare('DELETE FROM ' + table)));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('BBDevLab API key expiry', () => {
  const seconds = () => Math.floor(Date.now() / 1000);
  const iso = (value: number) => new Date(value * 1000).toISOString();
  const saveCachedExpiry = async (id: string, expiresAt: number, amount = 5) => {
    await testEnv.DB.prepare('INSERT INTO credential_balances(credential_id,balance,next_refresh_at) VALUES(?,?,?) ON CONFLICT(credential_id) DO UPDATE SET balance=excluded.balance,next_refresh_at=excluded.next_refresh_at')
      .bind(id, JSON.stringify({ status: 'ok', amount, expiresAt: iso(expiresAt), unit: '余额', updatedAt: new Date().toISOString(), checkedAt: new Date().toISOString() }), Date.now() + 60000).run();
  };

  it('reads the supplied token_usage response using Unix seconds and retains its full balance precision', async () => {
    const { channel, keys } = await seed();
    fetchValues(Response.json({ code: true, data: { expires_at: 1792859041, model_limits: { 'gemini-3.8-flash': true, 'gemini-4-argon': true }, model_limits_enabled: true, name: 'BAL-example', object: 'token_usage', total_available: 49832984, total_granted: 50000000, total_used: 167016, unlimited_quota: false }, message: 'ok' }));
    await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    expect((await keyMeta(channel, keys[0].id)).balance).toMatchObject({ status: 'ok', amount: 498.32984, expiresAt: '2026-10-24T16:24:01.000Z' });
  });

  it.each([500000, 0])('marks an expired key unavailable even with quota %s, with expiry taking precedence over exhaustion', async quota => {
    const { channel, keys } = await seed(), expired = seconds() - 30;
    fetchValues(expiringUsage(quota, expired));
    await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 0, reason: BBDEVLAB_EXPIRED_REASON, disabled_at: null });
    expect((await keyMeta(channel, keys[0].id)).balance).toMatchObject({ amount: quota / 100000, expiresAt: iso(expired) });
    expect(await store().getCredentials(channel.id)).toEqual([]);
    expect(await store().getCredentials(channel.id, true)).toEqual([]);
    expect((await store().getChannel(channel.id))?.accountBalance).toMatchObject({ amount: 0, availableKeys: 0, expiredKeys: 1, exhaustedKeys: 0 });
    expect((await store().getChannel(channel.id))?.enabled).toBe(true);
  });

  it('enforces the exact expiry boundary during selection and aggregation without waiting for a balance refresh', async () => {
    const { channel, keys } = await seed(2), expiry = seconds() + 600;
    await saveCachedExpiry(keys[0].id, expiry, 7); await saveCachedExpiry(keys[1].id, expiry + 600, 2);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(expiry * 1000 - 1);
    expect((await store().getCredentials(channel.id)).map(key => key.id).sort()).toEqual(keys.map(key => key.id).sort());
    expect((await store().getChannel(channel.id))?.accountBalance).toMatchObject({ amount: 9, availableKeys: 2, expiredKeys: 0 });
    clock.mockReturnValue(expiry * 1000);
    expect((await store().getCredentials(channel.id)).map(key => key.id)).toEqual([keys[1].id]);
    expect((await store().getCredentials(channel.id, true)).map(key => key.id)).toEqual([keys[1].id]);
    expect((await store().getChannel(channel.id))?.accountBalance).toMatchObject({ amount: 2, availableKeys: 1, expiredKeys: 1 });
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 1, reason: null });
  });

  it('cannot bypass known expiry by manually enabling a key, disabling cooldowns or using a recovery probe', async () => {
    const { channel, keys } = await seed(), expiry = seconds() - 30;
    fetchValues(expiringUsage(100000, expiry)); await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    await store().changeCredential(channel.id, keys[0].id, { enabled: true });
    await store().saveChannel({ ...channel, config: { ...channel.config, cooldown: { firstToken: false, error: false } } });
    await store().saveSettings({ ...await store().getSettings(), autoRecover: true, autoDisableRecover: true });
    expect(await store().getCredentials(channel.id)).toEqual([]);
    expect(await store().getCredentials(channel.id, true)).toEqual([]);
    await testEnv.DB.prepare("UPDATE credentials SET enabled=0,reason='HTTP 401',disabled_at=? WHERE id=?").bind(iso(expiry - 30), keys[0].id).run();
    expect(await store().getCredentials(channel.id, true)).toEqual([]);
  });

  it('leaves ordinary native credentials eligible despite unrelated cached expiry data', async () => {
    const { channel, keys } = await seed(1, { integration: 'native' }); await saveCachedExpiry(keys[0].id, seconds() - 30);
    expect((await store().getCredentials(channel.id)).map(key => key.id)).toEqual([keys[0].id]);
  });

  it('omits expired funds immediately and classifies each expired key only once in pool totals', async () => {
    const { channel, keys } = await seed(4), expiry = seconds() - 30;
    await saveCachedExpiry(keys[0].id, expiry, 9); await saveCachedExpiry(keys[1].id, expiry, 0);
    await saveCachedExpiry(keys[2].id, expiry, 8); await saveCachedExpiry(keys[3].id, expiry + 600, 3);
    await testEnv.DB.prepare('UPDATE credentials SET enabled=0,reason=? WHERE id=?').bind(BBDEVLAB_EXHAUSTED_REASON, keys[1].id).run();
    await store().changeCredential(channel.id, keys[2].id, { enabled: false });
    expect(await channelCredentialBalance(testEnv, channel.id)).toMatchObject({ amount: 3, keyCount: 4, availableKeys: 1, expiredKeys: 3, exhaustedKeys: 0 });
  });

  it('restores automatically expired keys after an extension while respecting manual disables', async () => {
    const { channel, keys } = await seed(2), expiry = seconds() - 30;
    fetchValues(expiringUsage(100000, expiry), expiringUsage(100000, expiry)); await refreshChannelCredentialBalances(testEnv, channel, false);
    await store().changeCredential(channel.id, keys[1].id, { enabled: false });
    fetchValues(expiringUsage(200000, expiry + 600), expiringUsage(200000, expiry + 600)); await refreshChannelCredentialBalances(testEnv, channel, false);
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 1, reason: null, disabled_at: null });
    expect(await keyRow(keys[1].id)).toMatchObject({ enabled: 0, reason: null, disabled_at: null });
    expect((await store().getChannel(channel.id))?.accountBalance).toMatchObject({ amount: 2, availableKeys: 1, expiredKeys: 0 });
  });

  it('keeps an extended key exhausted until its balance is also positive', async () => {
    const { channel, keys } = await seed(), expiry = seconds() - 30;
    fetchValues(expiringUsage(100000, expiry)); await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    fetchValues(expiringUsage(0, expiry + 600)); await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 0, reason: BBDEVLAB_EXHAUSTED_REASON });
    expect((await store().getChannel(channel.id))?.accountBalance).toMatchObject({ amount: 0, expiredKeys: 0, exhaustedKeys: 1 });
  });

  it('continues scheduled monitoring of expired keys so a renewed key can rejoin the pool', async () => {
    const { channel, keys } = await seed(), expiry = seconds() - 30;
    fetchValues(expiringUsage(100000, expiry)); await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    await testEnv.DB.prepare('UPDATE credential_balances SET next_refresh_at=0 WHERE credential_id=?').bind(keys[0].id).run();
    const fetcher = fetchValues(expiringUsage(100000, expiry + 600)); await refreshDueCredentialBalances(testEnv, false);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 1, reason: null });
  });

  it('checks again no later than a known upcoming expiry', async () => {
    const { channel, keys } = await seed(), expiry = seconds() + 15;
    fetchValues(expiringUsage(100000, expiry)); await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    expect((await balanceRow(keys[0].id))?.next_refresh_at).toBe(expiry * 1000);
  });

  it('retains known expiry on query failure and disables a newly expired key instead of extending its life', async () => {
    const { channel, keys } = await seed(), expiry = seconds() + 300;
    fetchValues(expiringUsage(500000, expiry)); await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    const before = (await keyMeta(channel, keys[0].id)).balance!;
    vi.spyOn(Date, 'now').mockReturnValue(expiry * 1000);
    fetchValues(new Response('provider unavailable', { status: 503 })); await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    expect((await keyMeta(channel, keys[0].id)).balance).toMatchObject({ status: 'error', amount: 5, expiresAt: iso(expiry), updatedAt: before.updatedAt });
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 0, reason: BBDEVLAB_EXPIRED_REASON });
    expect(await store().getCredentials(channel.id)).toEqual([]);
  });

  it.each(['not-a-timestamp', '', '1.5', 1.5, true, {}, -2, 1792859041000, Number.MAX_SAFE_INTEGER])('preserves a previously confirmed expiry when expires_at=%s is invalid', async invalid => {
    const { channel, keys } = await seed(), expiry = seconds() - 30;
    fetchValues(expiringUsage(100000, expiry)); await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    fetchValues(expiringUsage(900000, invalid)); await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    expect((await keyMeta(channel, keys[0].id)).balance).toMatchObject({ status: 'error', amount: 1, expiresAt: iso(expiry) });
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 0, reason: BBDEVLAB_EXPIRED_REASON });
  });

  it('preserves an existing expiry when a later valid quota response omits expires_at', async () => {
    const { channel, keys } = await seed(), expiry = seconds() - 30;
    fetchValues(expiringUsage(100000, expiry)); await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    fetchValues(200000); await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    expect((await keyMeta(channel, keys[0].id)).balance).toMatchObject({ status: 'ok', amount: 2, expiresAt: iso(expiry) });
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 0, reason: BBDEVLAB_EXPIRED_REASON });
  });

  it.each([null, 0, -1, '0', '-1'])('treats explicit expires_at=%s as no deadline and clears the old expired restriction', async expiry => {
    const { channel, keys } = await seed(); fetchValues(expiringUsage(100000, seconds() - 30));
    await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    fetchValues(expiringUsage(200000, expiry)); await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    expect((await keyMeta(channel, keys[0].id)).balance).toMatchObject({ status: 'ok', amount: 2, expiresAt: null });
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 1, reason: null });
  });

  it.each(['direct', 'channel-save'] as const)('clears expiry and its automatic disable after a secret replacement via %s', async mode => {
    const { channel, keys } = await seed(); fetchValues(expiringUsage(100000, seconds() - 30));
    await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    if (mode === 'direct') await store().changeCredential(channel.id, keys[0].id, { secret: 'private-new-expiry-key' });
    else await store().saveChannel(channel, false, [], undefined, [{ id: keys[0].id, secret: 'private-new-expiry-key' }]);
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 1, reason: null, disabled_at: null });
    expect((await keyMeta(channel, keys[0].id)).balance).toMatchObject({ status: 'pending', amount: null });
    expect((await store().getCredentials(channel.id)).map(key => key.id)).toEqual([keys[0].id]);
  });

  it.each(['endpoint', 'integration'] as const)('clears expiry restrictions when the saved %s is replaced', async field => {
    const { channel, keys } = await seed(2), expiry = seconds() - 30;
    fetchValues(expiringUsage(100000, expiry), expiringUsage(100000, expiry)); await refreshChannelCredentialBalances(testEnv, channel, false);
    await store().changeCredential(channel.id, keys[1].id, { enabled: false });
    await store().saveChannel({ ...channel, ...(field === 'endpoint' ? { endpoint: 'https://other-bb.example/v1' } : { config: { ...channel.config, integration: 'native' as const } }) });
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 1, reason: null });
    expect(await keyRow(keys[1].id)).toMatchObject({ enabled: 0, reason: null });
    expect((await store().getCredentials(channel.id)).map(key => key.id)).toEqual([keys[0].id]);
    expect((await balanceRow(keys[0].id))?.balance).toBeNull();
  });

  it('ignores a late expired result after the secret was replaced', async () => {
    const { channel, keys } = await seed(), held = holdFetch();
    const refreshing = refreshCredentialBalance(testEnv, channel, keys[0].id, false, true); await held.started;
    await store().changeCredential(channel.id, keys[0].id, { secret: 'private-new-usable-key' });
    held.finish(expiringUsage(100000, seconds() - 30)); await refreshing;
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 1, reason: null });
    expect((await keyMeta(channel, keys[0].id)).balance).toMatchObject({ status: 'pending', amount: null });
  });

  it('does not count a late expired-key failure against channel health even before a monitor disables the row', async () => {
    const { channel, keys } = await seed(); await saveCachedExpiry(keys[0].id, seconds() - 30);
    await store().saveSettings({ ...await store().getSettings(), autoSwitch: true, autoRecover: false, samples: 1, window: 1,
      autoDisableEnabled: true, autoDisableTarget: 'channel', autoDisableStatuses: [403], autoDisableThreshold: 1 });
    const failed = attempt(channel, keys[0].id, { status: 403, result: 'error', error: 'token has expired' }); await store().recordAttempt(failed);
    const row = await testEnv.DB.prepare('SELECT data FROM attempts WHERE id=?').bind(failed.id).first<{ data: string }>();
    expect(JSON.parse(row!.data)).toMatchObject({ status: 403, result: 'error', healthIgnored: true });
    expect(await store().getChannel(channel.id)).toMatchObject({ requests: 1, status: 'healthy', health: { autoDisabled: false, failureCount: 0, samples: 0 } });
    expect(await store().getRecentAttempts(channel.id, false, 20)).toEqual([]);
  });

  it('sends inference only to a funded unexpired key and fails without an upstream call once all keys expire', async () => {
    const { channel, keys, secrets } = await seed(2), expiry = seconds() - 30;
    await saveCachedExpiry(keys[0].id, expiry); await saveCachedExpiry(keys[1].id, expiry + 600);
    const gatewayKey = await store().createKey(apiKey({ name: 'Expiry guarded requests' }));
    const fetcher = vi.fn(async (_target: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST'); expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + secrets[1]);
      return Response.json({ model: 'test', choices: [{ message: { role: 'assistant', content: 'unexpired reply' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }); vi.stubGlobal('fetch', fetcher);
    expect((await inference(gatewayKey.token)).response.status).toBe(200); expect(fetcher).toHaveBeenCalledTimes(1);
    await saveCachedExpiry(keys[1].id, expiry);
    expect((await inference(gatewayKey.token)).response.status).toBe(503); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rechecks a selected key after awaiting the channel reservation so crossing its expiry never sends a request', async () => {
    const { channel, keys } = await seed(), expiry = seconds() + 30;
    await saveCachedExpiry(keys[0].id, expiry);
    await store().saveSettings({ ...await store().getSettings(), retryEnabled: false });
    const gatewayKey = await store().createKey(apiKey({ name: 'Expiry during reservation' }));
    const clock = vi.spyOn(Date, 'now').mockReturnValue((expiry - 1) * 1000);
    const reservation = vi.spyOn(Store.prototype, 'reserveChannel').mockImplementationOnce(async () => {
      clock.mockReturnValue(expiry * 1000); return true;
    });
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const result = await inference(gatewayKey.token);
    expect(result.response.status).toBe(503); expect(reservation).toHaveBeenCalledTimes(1); expect(fetcher).not.toHaveBeenCalled();
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM attempts WHERE channel_id=?').bind(channel.id).first<{ count: number }>())?.count).toBe(0);
  });

  it('rechecks newly cached expiry learned while a reservation was pending even when the selected snapshot had no expiry', async () => {
    const { channel, keys } = await seed();
    await store().saveSettings({ ...await store().getSettings(), retryEnabled: false });
    const gatewayKey = await store().createKey(apiKey({ name: 'Expiry learned during reservation' }));
    const reservation = vi.spyOn(Store.prototype, 'reserveChannel').mockImplementationOnce(async () => {
      await saveCachedExpiry(keys[0].id, seconds() - 30); return true;
    });
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const result = await inference(gatewayKey.token);
    expect(result.response.status).toBe(503); expect(reservation).toHaveBeenCalledTimes(1); expect(fetcher).not.toHaveBeenCalled();
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM attempts WHERE channel_id=?').bind(channel.id).first<{ count: number }>())?.count).toBe(0);
  });
});

describe('BBDevLab API key balance aggregation', () => {
  it('creates and imports monitored channels with API keys alone and never fetches from ordinary browser reads', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const input = { name: 'API keys only', endpoint: 'https://bb.example/v1', models: ['test'], config: { integration: 'bbdevlab' }, apiKeys: ['private-create-key-a', 'private-create-key-b'] };
    const created = await call('/api/channels', 'POST', input);
    expect(created.status).toBe(201); expect(created.json.channel.credentialCount).toBe(2);
    expect(created.json.channel.accountBalance).toMatchObject({ status: 'pending', amount: null, keyCount: 2 });
    const edited = await call(`/api/channels/${created.json.channel.id}`, 'PATCH', { name: 'Kept API keys' });
    expect(edited.status).toBe(200);
    const imported = await call('/api/channels/import', 'POST', { channels: [{ ...input, name: 'Imported keys' }] });
    expect(imported.status).toBe(201); expect(imported.json.channels[0].accountBalance).toMatchObject({ status: 'pending', keyCount: 2 });
    const bootstrap = await call('/api/bootstrap');
    expect(bootstrap.status).toBe(200); expect(fetcher).not.toHaveBeenCalled();
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM channel_accounts').first<{ count: number }>())?.count).toBe(0);
    for (const secret of input.apiKeys) expect(created.content + edited.content + imported.content + bootstrap.content).not.toContain(secret);
  });

  it('queries each saved API key at its deployment-relative endpoint and exposes precise safe per-key balances and a sum', async () => {
    const { channel, keys, secrets } = await seed(2), fetcher = fetchKeyValues(secrets, [1, '133516262']);
    await refreshChannelCredentialBalances(testEnv, channel, false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const requestedKeys: string[] = [];
    for (const [target, init] of fetcher.mock.calls) {
      expect(String(target)).toBe('https://bb.example/deployment/api/usage/token/');
      expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('manual'); expect(init?.body).toBeUndefined(); expect(init?.signal).toBeDefined();
      const headers = new Headers(init?.headers), authorization = headers.get('authorization')!;
      expect([...headers.entries()].sort()).toEqual([['accept', 'application/json'], ['authorization', authorization]]);
      requestedKeys.push(authorization);
    }
    expect(requestedKeys.sort()).toEqual(secrets.map(secret => 'Bearer ' + secret).sort());
    const metas = await Promise.all(keys.map(key => keyMeta(channel, key.id)));
    expect(metas[0].balance).toMatchObject({ status: 'ok', amount: 0.00001, unit: '余额' });
    expect(metas[1].balance).toMatchObject({ status: 'ok', amount: 1335.16262, unit: '余额' });
    expect(await channelCredentialBalance(testEnv, channel.id)).toMatchObject({ status: 'ok', unit: '余额', keyCount: 2, availableKeys: 2, exhaustedKeys: 0 });
    expect((await store().getChannel(channel.id))?.accountBalance?.amount).toBeCloseTo(1335.16263, 8);
    const publicKeys = await call(`/api/channels/${channel.id}/credentials`), bootstrap = await call('/api/bootstrap');
    for (let i = 0; i < keys.length; i++) {
      const row = (await keyRow(keys[i].id))!;
      expect(row.secret).not.toContain(secrets[i]); expect(await decryptSecret(row.secret, testEnv)).toBe(secrets[i]);
      expect(publicKeys.content + bootstrap.content + JSON.stringify(await balanceRow(keys[i].id))).not.toContain(secrets[i]);
    }
  });

  it.each([0, -1, '-100000'])('disables only the exhausted key for total_available=%s and leaves the channel and funded keys available', async available => {
    const { channel, keys, secrets } = await seed(2); fetchKeyValues(secrets, [available, 1]);
    await refreshChannelCredentialBalances(testEnv, channel, false);
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 0, reason: BBDEVLAB_EXHAUSTED_REASON, disabled_at: null });
    expect(await keyRow(keys[1].id)).toMatchObject({ enabled: 1, reason: null });
    expect((await store().getCredentials(channel.id)).map(key => key.id)).toEqual([keys[1].id]);
    expect((await store().getCredentials(channel.id, true)).map(key => key.id)).toEqual([keys[1].id]);
    expect(await store().getChannel(channel.id)).toMatchObject({ enabled: true, health: { autoDisabled: false }, accountBalance: { amount: 0.00001, keyCount: 2, availableKeys: 1, exhaustedKeys: 1 } });
  });

  it('restores an automatically exhausted key after a positive balance, while preserving a manual disabled key', async () => {
    const { channel, keys } = await seed(2); fetchValues(0, 0);
    await refreshChannelCredentialBalances(testEnv, channel, false);
    await store().changeCredential(channel.id, keys[1].id, { enabled: false });
    fetchValues(1, 200000);
    await refreshChannelCredentialBalances(testEnv, channel, false);
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 1, reason: null, disabled_at: null });
    expect(await keyRow(keys[1].id)).toMatchObject({ enabled: 0, reason: null, disabled_at: null });
  });

  it('turns a prior HTTP cooldown into confirmed budget exhaustion so health probes cannot revive an empty key', async () => {
    const { channel, keys } = await seed();
    await testEnv.DB.prepare("UPDATE credentials SET enabled=0,reason='HTTP 401',disabled_at=? WHERE id=?").bind(new Date(Date.now() - 1000).toISOString(), keys[0].id).run();
    const fetcher = fetchValues(0); await refreshDueCredentialBalances(testEnv, false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 0, reason: BBDEVLAB_EXHAUSTED_REASON, disabled_at: null });
    expect(await store().getCredentials(channel.id, true)).toEqual([]);
  });

  it.each([
    () => new Response('private-bb-provider-error', { status: 401 }),
    () => Response.json({ code: false, message: 'private-bb-provider-error' }),
    () => usage('not-a-number'),
    () => usage(null),
    () => new Response('private-bb-provider-error'),
  ])('preserves an existing balance and does not disable a funded key when monitoring fails (%#)', async failure => {
    const { channel, keys, secrets } = await seed(); fetchValues(125001);
    await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    const before = (await keyMeta(channel, keys[0].id)).balance!;
    fetchValues(failure()); await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    const after = (await keyMeta(channel, keys[0].id)).balance!;
    expect(after).toMatchObject({ status: 'error', amount: 1.25001, unit: '余额', updatedAt: before.updatedAt });
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 1, reason: null });
    expect(JSON.stringify(after)).not.toContain('private-bb-provider-error'); expect(JSON.stringify(after)).not.toContain(secrets[0]);
    expect((await balanceRow(keys[0].id))?.lease_until).toBe(0);
  });

  it('does not interpret a first monitoring failure as an exhausted key', async () => {
    const { channel, keys } = await seed(); fetchValues(new Response('unavailable', { status: 503 }));
    await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    expect((await keyMeta(channel, keys[0].id)).balance).toMatchObject({ status: 'error', amount: null });
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 1, reason: null });
  });

  it.each([1, 'true', false, null])('requires code:true and treats code=%s as a monitoring error', async code => {
    const { channel, keys } = await seed(); fetchValues(Response.json({ code, data: { total_available: 0 } }));
    await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    expect((await keyMeta(channel, keys[0].id)).balance).toMatchObject({ status: 'error', amount: null });
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 1, reason: null });
  });

  it.each(['', '  ', true, false, 'Infinity', '-Infinity', 'NaN', [], {}])('does not mistake invalid quota %s for exhaustion', async raw => {
    const { channel, keys } = await seed(); fetchValues(raw);
    await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    expect((await keyMeta(channel, keys[0].id)).balance).toMatchObject({ status: 'error', amount: null });
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 1, reason: null });
  });

  it('sums fractional quotas without visible floating-point artifacts', async () => {
    const { channel, secrets } = await seed(2); fetchKeyValues(secrets, [10000, 20000]);
    await refreshChannelCredentialBalances(testEnv, channel, false);
    expect((await store().getChannel(channel.id))?.accountBalance?.amount).toBe(0.3);
  });

  it('excludes an unqueried manually disabled key from aggregate pending state while retaining it in the total count', async () => {
    const { channel, keys } = await seed(2);
    await store().changeCredential(channel.id, keys[1].id, { enabled: false });
    fetchValues(100000); await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    expect((await store().getChannel(channel.id))?.accountBalance).toMatchObject({ status: 'ok', amount: 1, keyCount: 2, availableKeys: 1 });
    expect((await keyMeta(channel, keys[1].id)).balance).toMatchObject({ status: 'pending', amount: null });
    await testEnv.DB.prepare("UPDATE credentials SET reason='HTTP 401',disabled_at=? WHERE id=?").bind(new Date(Date.now() + 60000).toISOString(), keys[1].id).run();
    expect((await store().getChannel(channel.id))?.accountBalance).toMatchObject({ status: 'pending', amount: 1, keyCount: 2, availableKeys: 1 });
  });

  it('retains a manually disabled key balance for inspection without including its old amount, errors or dates in the pool summary', async () => {
    const { channel, keys, secrets } = await seed(2); fetchKeyValues(secrets, [100000, 900000]);
    await refreshChannelCredentialBalances(testEnv, channel, false);
    const active = (await keyMeta(channel, keys[0].id)).balance!;
    fetchValues(new Response('monitor unavailable', { status: 503 }));
    await refreshCredentialBalance(testEnv, channel, keys[1].id, false, true);
    await store().changeCredential(channel.id, keys[1].id, { enabled: false });
    expect((await keyMeta(channel, keys[1].id)).balance).toMatchObject({ status: 'error', amount: 9 });
    const summary = (await store().getChannel(channel.id))!.accountBalance!;
    expect(summary).toMatchObject({ status: 'ok', amount: 1, keyCount: 2, availableKeys: 1, updatedAt: active.updatedAt, checkedAt: active.checkedAt });
    expect(summary.error).toBeUndefined();
  });

  it('reports zero usable balance when every saved key is manually disabled', async () => {
    const { channel, keys } = await seed(2);
    for (const key of keys) await store().changeCredential(channel.id, key.id, { enabled: false });
    expect((await store().getChannel(channel.id))?.accountBalance).toMatchObject({ status: 'ok', amount: 0, keyCount: 2, availableKeys: 0, exhaustedKeys: 0 });
  });

  it('keeps an exhausted key disabled after a monitoring failure and later restores it from a scheduled positive balance', async () => {
    const { channel, keys } = await seed(); fetchValues(0);
    await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    fetchValues(new Response('expired authentication', { status: 401 }));
    await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 0, reason: BBDEVLAB_EXHAUSTED_REASON });
    expect((await keyMeta(channel, keys[0].id)).balance).toMatchObject({ status: 'error', amount: 0 });
    await testEnv.DB.prepare('UPDATE credential_balances SET next_refresh_at=0 WHERE credential_id=?').bind(keys[0].id).run();
    fetchValues(1); await refreshDueCredentialBalances(testEnv, false);
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 1, reason: null });
  });

  it('uses saved API keys even if a legacy independent dashboard token is present, and excludes BBDevLab from account refresh', async () => {
    const { channel, keys, secrets } = await seed();
    await (await prepareAccountSave(testEnv, channel, { accessToken: 'private-obsolete-dashboard-token' }))!.run();
    const fetcher = fetchValues(100000);
    await refreshAccountBalance(testEnv, channel, false, true); await refreshDueAccounts(testEnv, [channel], false);
    expect(fetcher).not.toHaveBeenCalled();
    await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer ' + secrets[0]);
  });

  it('supports manual channel refresh without an account token and does not revive exhausted keys through cooldown settings', async () => {
    const { channel, keys, secrets } = await seed(2); const fetcher = fetchKeyValues(secrets, [0, 300000]);
    const refreshed = await call(`/api/channels/${channel.id}/balance`, 'POST', {});
    expect(refreshed.status).toBe(200); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(refreshed.json.channel.accountBalance).toMatchObject({ amount: 3, keyCount: 2, availableKeys: 1, exhaustedKeys: 1 });
    const changed = await call(`/api/channels/${channel.id}`, 'PATCH', { config: { cooldown: { error: false, firstToken: false } } });
    expect(changed.status).toBe(200); expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 0, reason: BBDEVLAB_EXHAUSTED_REASON });
  });

  it('does not revive an exhausted key when an inference request already in flight later reports success', async () => {
    const { channel, keys } = await seed(); fetchValues(0);
    await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    await store().saveSettings({ ...await store().getSettings(), recovery: 1, autoDisableRecover: true });
    await store().recordAttempt({ id: crypto.randomUUID(), requestId: crypto.randomUUID(), channelId: channel.id, channelName: channel.name,
      credentialId: keys[0].id, model: 'test', stream: true, startedAt: new Date().toISOString(), ttft: 0.01, duration: 0.01,
      status: 200, result: 'success', error: null, inputTokens: 1, outputTokens: 1, attempt: 1 });
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 0, reason: BBDEVLAB_EXHAUSTED_REASON, disabled_at: null });
  });
});

describe('BBDevLab refresh scheduling and stale responses', () => {
  it('refreshes at one-minute intervals and permits only one request per leased key', async () => {
    const { channel, keys } = await seed(), held = holdFetch(), startedAt = Date.now();
    const refreshing = refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    await held.started;
    await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    expect(held.fetcher).toHaveBeenCalledTimes(1);
    held.finish(usage(1)); await refreshing;
    const saved = (await balanceRow(keys[0].id))!;
    expect(saved.lease_until).toBe(0); expect(saved.next_refresh_at).toBeGreaterThanOrEqual(startedAt + 60000); expect(saved.next_refresh_at).toBeLessThanOrEqual(Date.now() + 60000);
    await refreshCredentialBalance(testEnv, channel, keys[0].id, false);
    expect(held.fetcher).toHaveBeenCalledTimes(1);
  });

  it('discards an in-flight exhausted result after the API key has been replaced in place', async () => {
    const { channel, keys } = await seed(), held = holdFetch();
    const refreshing = refreshCredentialBalance(testEnv, channel, keys[0].id, false, true); await held.started;
    await store().changeCredential(channel.id, keys[0].id, { secret: 'private-replacement-api-key' });
    held.finish(usage(0)); await refreshing;
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 1, reason: null });
    expect((await keyMeta(channel, keys[0].id)).balance).toMatchObject({ status: 'pending', amount: null });
    const fetcher = fetchValues(100000);
    await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer private-replacement-api-key');
    expect((await keyMeta(channel, keys[0].id)).balance?.amount).toBe(1);
  });

  it.each(['endpoint', 'integration'] as const)('discards an in-flight response after the monitored %s changes', async field => {
    const { channel, keys } = await seed(), held = holdFetch();
    const refreshing = refreshCredentialBalance(testEnv, channel, keys[0].id, false, true); await held.started;
    const next = { ...channel, ...(field === 'endpoint' ? { endpoint: 'https://fresh-bb.example/v1' } : { config: { ...channel.config, integration: 'native' as const } }) };
    await store().saveChannel(next);
    held.finish(usage(0)); await refreshing;
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 1, reason: null });
    if (field === 'endpoint') expect((await keyMeta(channel, keys[0].id)).balance).toMatchObject({ status: 'pending', amount: null });
    else expect((await store().getChannel(channel.id))?.accountBalance).toBeUndefined();
  });

  it('pairs the latest saved API key with the latest endpoint when a caller supplies an older channel snapshot', async () => {
    const { channel, keys } = await seed();
    await store().saveChannel({ ...channel, endpoint: 'https://latest-bb.example/site/v1' });
    await store().changeCredential(channel.id, keys[0].id, { secret: 'private-latest-bb-key' });
    const fetcher = fetchValues(100000);
    await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    expect(String(fetcher.mock.calls[0][0])).toBe('https://latest-bb.example/site/api/usage/token/');
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer private-latest-bb-key');
    expect((await keyMeta(channel, keys[0].id)).balance).toMatchObject({ status: 'ok', amount: 1 });
  });

  it('does not re-enable a key manually disabled while a positive refresh is in flight', async () => {
    const { channel, keys } = await seed(); fetchValues(0); await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    const held = holdFetch(), refreshing = refreshCredentialBalance(testEnv, channel, keys[0].id, false, true); await held.started;
    await store().changeCredential(channel.id, keys[0].id, { enabled: false });
    held.finish(usage(200000)); await refreshing;
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 0, reason: null, disabled_at: null });
  });

  it('advances a failing key and refreshes later batches fairly while skipping archived and native channels', async () => {
    const { channel, keys, secrets } = await seed(5), archived = await seed(1, { archived: true }), native = await seed(1, { integration: 'native' });
    const fetcher = vi.fn(async (_target: RequestInfo | URL, init?: RequestInit) => new Headers(init?.headers).get('authorization') === 'Bearer ' + secrets[0] ? new Response('temporary failure', { status: 503 }) : usage(100000));
    vi.stubGlobal('fetch', fetcher);
    await refreshDueCredentialBalances(testEnv, false, 2); expect(fetcher).toHaveBeenCalledTimes(2);
    await refreshDueCredentialBalances(testEnv, false, 2); expect(fetcher).toHaveBeenCalledTimes(4);
    await refreshDueCredentialBalances(testEnv, false, 2); expect(fetcher).toHaveBeenCalledTimes(5);
    expect((await keyMeta(channel, keys[0].id)).balance).toMatchObject({ status: 'error', amount: null });
    for (const key of keys.slice(1)) expect((await keyMeta(channel, key.id)).balance).toMatchObject({ status: 'ok', amount: 1 });
    for (const secret of [archived.secrets[0], native.secrets[0]]) expect(fetcher.mock.calls.some(([, init]) => new Headers(init?.headers).get('authorization') === 'Bearer ' + secret)).toBe(false);
    expect(fetcher.mock.calls.filter(([, init]) => new Headers(init?.headers).get('authorization') === 'Bearer ' + secrets[0])).toHaveLength(1);
  });

  it('refreshes API keys through the scheduled handler without making an HTTP admin request', async () => {
    const { channel, keys, secrets } = await seed(2), fetcher = fetchKeyValues(secrets, [1, 0]), http = vi.spyOn(worker, 'fetch'), ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: '* * * * *', scheduledTime: Date.now() }), testEnv, ctx); await waitOnExecutionContext(ctx);
    expect(http).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await store().getChannel(channel.id))?.accountBalance).toMatchObject({ amount: 0.00001, keyCount: 2, availableKeys: 1, exhaustedKeys: 1 });
    expect(await keyRow(keys[1].id)).toMatchObject({ enabled: 0, reason: BBDEVLAB_EXHAUSTED_REASON });
  });

  it('allows manual balance refresh for a disabled channel while scheduled monitoring leaves it disabled and skips its keys', async () => {
    const { channel } = await seed(); await store().saveChannel({ ...channel, enabled: false });
    const fetcher = fetchValues(100000);
    await refreshDueCredentialBalances(testEnv, false); expect(fetcher).not.toHaveBeenCalled();
    const refreshed = await call(`/api/channels/${channel.id}/balance`, 'POST', {});
    expect(refreshed.status).toBe(200); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(refreshed.json.channel).toMatchObject({ enabled: false, accountBalance: { status: 'ok', amount: 1 } });
  });

  it('still refreshes BBDevLab API key balances and releases their leases when scheduled settings fail', async () => {
    const { channel, keys } = await seed(), fetcher = fetchValues(100000), ctx = createExecutionContext();
    vi.spyOn(Store.prototype, 'getSettings').mockRejectedValueOnce(new Error('injected BBDevLab settings failure'));
    const startedAt = Date.now();
    await expect(worker.scheduled(createScheduledController({ cron: '* * * * *', scheduledTime: startedAt }), testEnv, ctx)).rejects.toThrow('injected BBDevLab settings failure');
    await waitOnExecutionContext(ctx);
    expect(fetcher).toHaveBeenCalledTimes(1); expect((await store().getChannel(channel.id))?.accountBalance).toMatchObject({ status: 'ok', amount: 1 });
    const row = (await balanceRow(keys[0].id))!;
    expect(row.lease_until).toBe(0); expect(row.next_refresh_at).toBeGreaterThanOrEqual(startedAt + 60000);
  });

  it.each(['single-key delete', 'channel editor save'])('deletes the balance row and ignores late refresh results after a %s', async mode => {
    const { channel, keys } = await seed(), held = holdFetch(), refreshing = refreshCredentialBalance(testEnv, channel, keys[0].id, false, true); await held.started;
    if (mode === 'single-key delete') await store().deleteCredential(channel.id, keys[0].id);
    else {
      const saved = await call(`/api/channels/${channel.id}`, 'PATCH', { credentialDeletes: [keys[0].id] });
      expect(saved.status).toBe(200); expect(saved.json.channel.credentialCount).toBe(0);
    }
    held.finish(usage(0)); await refreshing;
    expect(await keyRow(keys[0].id)).toBeNull(); expect(await balanceRow(keys[0].id)).toBeNull();
    expect(await store().getCredentials(channel.id, true)).toEqual([]);
    expect((await store().getChannel(channel.id))?.accountBalance).toMatchObject({ keyCount: 0, availableKeys: 0, exhaustedKeys: 0, expiredKeys: 0 });
  });
});

describe('BBDevLab request exhaustion and channel health', () => {
  it('keeps exhausted-key errors in attempt history and request counts without disabling the channel or polluting future health samples', async () => {
    const { channel, keys } = await seed(2); fetchValues(0);
    await refreshCredentialBalance(testEnv, channel, keys[0].id, false, true);
    await store().saveSettings({ ...await store().getSettings(), autoSwitch: true, autoRecover: false, samples: 1, window: 2,
      autoDisableEnabled: true, autoDisableTarget: 'channel', autoDisableStatuses: [403], autoDisableThreshold: 1 });
    const failed = attempt(channel, keys[0].id, { status: 403, result: 'error', error: 'quota exhausted' });
    await store().recordAttempt(failed);
    const row = await testEnv.DB.prepare('SELECT data FROM attempts WHERE id=?').bind(failed.id).first<{ data: string }>();
    expect(JSON.parse(row!.data)).toMatchObject({ id: failed.id, status: 403, result: 'error', healthIgnored: true });
    expect(await store().getChannel(channel.id)).toMatchObject({ requests: 1, status: 'healthy', health: { autoDisabled: false, failureCount: 0, samples: 0, reason: null } });
    expect(await store().getRecentAttempts(channel.id, false, 20)).toEqual([]);
    expect(await testEnv.DB.prepare('SELECT value FROM gateway_state WHERE id=?').bind('auto-disable:' + channel.id).first()).toBeNull();
    const healthy = attempt(channel, keys[1].id); await store().recordAttempt(healthy);
    expect((await store().getRecentAttempts(channel.id, false, 20)).map(value => value.id)).toEqual([healthy.id]);
    expect(await store().getChannel(channel.id)).toMatchObject({ requests: 2, status: 'healthy', successRate: 100, health: { autoDisabled: false, failureCount: 0, samples: 1, reason: null } });
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 0, reason: BBDEVLAB_EXHAUSTED_REASON });
  });

  it('confirms a 403 as exhausted using only that API key and retries a funded key on the same channel even when 403 is not a retry status', async () => {
    const { channel } = await seed(2), credentials = await store().getCredentials(channel.id), [emptyKey, fundedKey] = credentials;
    await store().saveSettings({ ...await store().getSettings(), retryEnabled: true, retryStatuses: [500], maxSameChannelRetries: 2,
      maxChannelRetries: 0, retryDelayMs: 100, stickyMode: 'off', autoSwitch: true, autoRecover: false, samples: 1, window: 1,
      autoDisableEnabled: true, autoDisableTarget: 'channel', autoDisableStatuses: [403], autoDisableThreshold: 1 });
    const gatewayKey = await store().createKey(apiKey({ name: 'Aggregate BBDevLab requests' }));
    const fetcher = vi.fn(async (target: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(target)), authorization = new Headers(init?.headers).get('authorization');
      if (init?.method === 'GET') {
        expect(url.pathname).toBe('/deployment/api/usage/token/'); expect(authorization).toBe('Bearer ' + emptyKey.secret);
        return usage(0);
      }
      expect(init?.method).toBe('POST'); expect(url.pathname).toBe('/deployment/v1/chat/completions');
      if (authorization === 'Bearer ' + emptyKey.secret) return Response.json({ error: { message: 'quota exhausted' } }, { status: 403 });
      expect(authorization).toBe('Bearer ' + fundedKey.secret);
      return Response.json({ model: 'test', choices: [{ message: { role: 'assistant', content: 'funded key reply' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }); vi.stubGlobal('fetch', fetcher);
    const first = await inference(gatewayKey.token);
    expect(first.response.status).toBe(200); expect(first.content).toContain('funded key reply');
    expect(first.response.headers.get('x-pulsegate-channel-id')).toBe(channel.id); expect(first.response.headers.get('x-pulsegate-attempts')).toBe('2');
    expect(await keyRow(emptyKey.id)).toMatchObject({ enabled: 0, reason: BBDEVLAB_EXHAUSTED_REASON });
    expect(await store().getChannel(channel.id)).toMatchObject({ requests: 2, status: 'healthy', health: { autoDisabled: false, failureCount: 0, reason: null } });
    const second = await inference(gatewayKey.token);
    expect(second.response.status).toBe(200); expect(second.response.headers.get('x-pulsegate-attempts')).toBe('1');
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(3);
    const savedAttempts = (await testEnv.DB.prepare('SELECT data FROM attempts WHERE channel_id=? ORDER BY rowid').bind(channel.id).all<{ data: string }>()).results.map(row => JSON.parse(row.data) as AttemptRecord);
    expect(savedAttempts).toHaveLength(3); expect(savedAttempts.filter(value => value.healthIgnored)).toHaveLength(1);
    expect(savedAttempts.find(value => value.healthIgnored)).toMatchObject({ credentialId: emptyKey.id, status: 403, result: 'error' });
    expect((await store().getRecentAttempts(channel.id, false, 20)).every(value => value.result === 'success')).toBe(true);
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM request_logs WHERE channel_id=?').bind(channel.id).first<{ count: number }>())?.count).toBe(2);
    for (const secret of [gatewayKey.token, emptyKey.secret, fundedKey.secret]) expect(first.content + second.content).not.toContain(secret);
  });

  it('does not confirm a 403 as exhaustion when the balance query fails and ordinary HTTP auto-disable is off', async () => {
    const { channel, keys } = await seed();
    await store().saveChannel({ ...channel, config: { ...channel.config, cooldown: { ...channel.config.cooldown, error: false } } });
    await store().saveSettings({ ...await store().getSettings(), retryEnabled: false, autoSwitch: false, autoDisableEnabled: false });
    const gatewayKey = await store().createKey(apiKey({ name: 'Uncertain BBDevLab quota' }));
    const fetcher = vi.fn(async (_target: RequestInfo | URL, init?: RequestInit) => init?.method === 'GET'
      ? new Response('monitoring unavailable', { status: 503 })
      : Response.json({ error: { message: 'forbidden by provider' } }, { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    const result = await inference(gatewayKey.token);
    expect(result.response.status).toBe(403); expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET']);
    expect(await keyRow(keys[0].id)).toMatchObject({ enabled: 1, reason: null, disabled_at: null });
    expect((await keyMeta(channel, keys[0].id)).balance).toMatchObject({ status: 'error', amount: null });
    const row = await testEnv.DB.prepare('SELECT data FROM attempts WHERE channel_id=?').bind(channel.id).first<{ data: string }>();
    expect(JSON.parse(row!.data)).toMatchObject({ status: 403, result: 'error' }); expect(JSON.parse(row!.data).healthIgnored).not.toBe(true);
    expect(await store().getChannel(channel.id)).toMatchObject({ requests: 1, status: 'healthy', health: { autoDisabled: false } });
  });
});
