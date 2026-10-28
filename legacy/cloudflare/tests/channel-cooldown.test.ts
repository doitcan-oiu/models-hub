import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../worker/index';
import { Store } from '../worker/store';
import { apiKey } from '../worker/validation';
import type { Env } from '../worker/env';
import type { AttemptRecord, GatewayChannel, GatewaySettings } from '../shared/types';

const testEnv = env as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const defaults = { firstToken: true, error: true };

async function call(path: string, method = 'GET', data?: unknown) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('http://127.0.0.1:8787' + path, {
    method,
    headers: { authorization: 'Bearer ' + testEnv.ADMIN_TOKEN, ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }), testEnv, ctx);
  const json = await response.json() as { channel: GatewayChannel; channels: GatewayChannel[] };
  await waitOnExecutionContext(ctx);
  return { status: response.status, json };
}

async function createChannel(config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const result = await call('/api/channels', 'POST', {
    name: 'Cooldown test', models: ['test-model'], config: { protocol: 'mock', mock: { delayMs: 1 }, ...config }, ...extra,
  });
  expect(result.status).toBe(201);
  return result.json.channel;
}

function attempt(channel: GatewayChannel, patch: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: crypto.randomUUID(), requestId: crypto.randomUUID(), channelId: channel.id, channelName: channel.name,
    credentialId: null, model: 'test-model', stream: true, startedAt: new Date().toISOString(),
    ttft: 5, duration: 5, status: 200, result: 'slow', error: null, inputTokens: 1, outputTokens: 1, attempt: 1, ...patch,
  };
}

async function settings(patch: Partial<GatewaySettings> = {}) {
  const store = new Store(testEnv);
  await store.saveSettings({
    ...await store.getSettings(), strategy: 'failover', stickyMode: 'off', autoSwitch: true, autoRecover: false,
    threshold: 1, responseThreshold: 1, window: 2, samples: 2, cooldown: 600,
    maxChannelRetries: 0, maxSameChannelRetries: 0, ...patch,
  });
}

async function request(token: string, stream = false) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('http://127.0.0.1:8787/v1/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'Check channel cooldown' }], stream, max_tokens: 32 }),
  }), testEnv, ctx);
  const content = await response.text();
  await waitOnExecutionContext(ctx);
  return { status: response.status, channelId: response.headers.get('x-pulsegate-channel-id'), content };
}

beforeAll(async () => { await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS); });
beforeEach(async () => {
  await testEnv.DB.batch(['channel_accounts', 'credentials', 'channels', 'profile_usage', 'api_keys', 'attempts', 'request_logs', 'events', 'tags', 'settings', 'gateway_state'].map(table => testEnv.DB.prepare('DELETE FROM ' + table)));
});

describe('per-channel cooldown configuration', () => {
  it('defaults both switches on and deeply merges partial PATCH requests', async () => {
    const channel = await createChannel();
    expect(channel.config.cooldown).toEqual(defaults);
    const first = await call(`/api/channels/${channel.id}`, 'PATCH', { config: { cooldown: { firstToken: false } } });
    expect(first.status).toBe(200); expect(first.json.channel.config.cooldown).toEqual({ firstToken: false, error: true });
    const second = await call(`/api/channels/${channel.id}`, 'PATCH', { config: { cooldown: { error: false } } });
    expect(second.status).toBe(200); expect(second.json.channel.config.cooldown).toEqual({ firstToken: false, error: false });
    const renamed = await call(`/api/channels/${channel.id}`, 'PATCH', { name: 'Retained switches', config: { mock: { delayMs: 2 } } });
    expect(renamed.json.channel.config.cooldown).toEqual({ firstToken: false, error: false });
    expect(renamed.json.channel.config.protocol).toBe('mock');
    expect((await new Store(testEnv).getChannel(channel.id))?.config.cooldown).toEqual({ firstToken: false, error: false });
  });

  it('normalizes legacy and incomplete stored configuration without a database migration', async () => {
    const channel = await createChannel({ cooldown: { firstToken: false, error: false } });
    await testEnv.DB.prepare("UPDATE channels SET data=json_remove(data,'$.config.cooldown') WHERE id=?").bind(channel.id).run();
    const store = new Store(testEnv);
    expect((await store.getChannel(channel.id))?.config.cooldown).toEqual(defaults);
    expect((await store.listChannels())[0].config.cooldown).toEqual(defaults);
    expect((await call('/api/bootstrap')).json.channels[0].config.cooldown).toEqual(defaults);
    const raw = await testEnv.DB.prepare('SELECT data FROM channels WHERE id=?').bind(channel.id).first<{ data: string }>();
    expect(JSON.parse(raw!.data).config).not.toHaveProperty('cooldown');
    await testEnv.DB.prepare("UPDATE channels SET data=json_set(data,'$.config.cooldown',json(?)) WHERE id=?").bind(JSON.stringify({ firstToken: false }), channel.id).run();
    expect((await store.getChannel(channel.id))?.config.cooldown).toEqual({ firstToken: false, error: true });
    const patched = await call(`/api/channels/${channel.id}`, 'PATCH', { name: 'Legacy edited' });
    expect(patched.status).toBe(200); expect(patched.json.channel.config.cooldown).toEqual({ firstToken: false, error: true });
  });

  it('preserves switches through imports and clones and supplies missing defaults', async () => {
    const imported = await call('/api/channels/import', 'POST', { channels: [
      { name: 'First token exempt', models: ['test-model'], config: { protocol: 'mock', cooldown: { firstToken: false } } },
      { name: 'Error exempt', models: ['test-model'], config: { protocol: 'mock', cooldown: { error: false } } },
      { name: 'Legacy import', models: ['test-model'], config: { protocol: 'mock' } },
    ] });
    expect(imported.status).toBe(201);
    expect(imported.json.channels.map(channel => channel.config.cooldown)).toEqual([
      { firstToken: false, error: true }, { firstToken: true, error: false }, defaults,
    ]);
    const clone = await call(`/api/channels/${imported.json.channels[0].id}/clone`, 'POST', {});
    expect(clone.status).toBe(201); expect(clone.json.channel.config.cooldown).toEqual({ firstToken: false, error: true });
    expect(clone.json.channel.id).not.toBe(imported.json.channels[0].id);
  });

  it('strictly rejects invalid switch values before saving edits or partial imports', async () => {
    const channel = await createChannel({ cooldown: { firstToken: false, error: false } });
    const invalid = [null, false, 1, 'false', [], { firstToken: null }, { firstToken: 0 }, { firstToken: 'false' }, { error: null }, { error: 1 }, { error: 'false' }, { error: [] }];
    for (const cooldown of invalid) {
      expect((await call('/api/channels', 'POST', { name: 'Invalid', models: ['test-model'], config: { protocol: 'mock', cooldown } })).status).toBe(400);
      expect((await call(`/api/channels/${channel.id}`, 'PATCH', { name: 'Must not save', config: { cooldown } })).status).toBe(400);
    }
    const imported = await call('/api/channels/import', 'POST', { channels: [
      { name: 'Must not import', models: ['test-model'], tags: ['must-not-remain'], config: { protocol: 'mock' } },
      { name: 'Invalid import', models: ['test-model'], config: { protocol: 'mock', cooldown: { error: 'false' } } },
    ] });
    expect(imported.status).toBe(400);
    const store = new Store(testEnv);
    expect(await store.listChannels()).toHaveLength(1); expect(await store.listTags()).toEqual([]);
    expect(await store.getChannel(channel.id)).toMatchObject({ name: 'Cooldown test', config: { cooldown: { firstToken: false, error: false } } });
  });
});

describe('per-channel cooldown behavior', () => {
  it('keeps a slow SSE primary routable while preserving slow attempts and request logs', async () => {
    const primary = await createChannel({ cooldown: { firstToken: false }, mock: { scenario: 'slow', delayMs: 100 } }, { priority: 0 });
    const backup = await createChannel({}, { priority: 1 });
    await settings({ threshold: 0.05, streamFirstTokenTimeout: 1 });
    const store = new Store(testEnv), key = await store.createKey(apiKey({ name: 'Slow exempt routing' }));
    for (let i = 0; i < 3; i++) {
      const response = await request(key.token, true);
      expect(response.status).toBe(200); expect(response.channelId).toBe(primary.id); expect(response.content).toContain('[DONE]');
    }
    const current = (await store.getChannel(primary.id))!;
    expect(current.status).toBe('healthy'); expect(current.health.cooldownUntil).toBeNull(); expect(current.health.averageTtft).toBeGreaterThan(0.05);
    expect(current.requests).toBe(3); expect((await store.getChannel(backup.id))?.requests).toBe(0);
    expect(await store.getRecentAttempts(primary.id, true, 10)).toHaveLength(3);
    expect((await store.listLogs({ channelId: primary.id })).logs).toHaveLength(3);
    expect((await store.listLogs({ channelId: primary.id })).logs.every(log => log.result === 'slow')).toBe(true);
    await call(`/api/channels/${primary.id}`, 'PATCH', { config: { cooldown: { firstToken: true } } });
    expect((await request(key.token, true)).channelId).toBe(primary.id);
    expect((await store.getChannel(primary.id))?.status).toBe('degraded');
    expect((await request(key.token, true)).channelId).toBe(backup.id);
  });

  it('keeps an error-exempt primary routable after failures and records each failed request', async () => {
    const primary = await createChannel({ cooldown: { error: false }, mock: { scenario: 'error', delayMs: 1, status: 401 } }, { priority: 0 });
    const backup = await createChannel({}, { priority: 1 });
    await settings({ autoDisableEnabled: true, autoDisableTarget: 'channel', autoDisableStatuses: [401], autoDisableThreshold: 1 });
    const store = new Store(testEnv), key = await store.createKey(apiKey({ name: 'Error exempt routing' }));
    for (let i = 0; i < 3; i++) expect((await request(key.token)).status).toBe(401);
    const current = (await store.getChannel(primary.id))!;
    expect(current.status).toBe('healthy'); expect(current.health.autoDisabled).toBe(false); expect(current.health.cooldownUntil).toBeNull();
    expect(current.requests).toBe(3); expect(current.successRate).toBe(0); expect((await store.getChannel(backup.id))?.requests).toBe(0);
    expect(await store.getRecentAttempts(primary.id, false, 10)).toHaveLength(3);
    const logs = (await store.listLogs({ channelId: primary.id })).logs;
    expect(logs).toHaveLength(3); expect(logs.every(log => log.status === 401 && log.result === 'error')).toBe(true);
  });

  it('applies error and first-token exemptions independently and retains non-stream latency isolation', async () => {
    await settings();
    const store = new Store(testEnv);
    const firstTokenExempt = await createChannel({ cooldown: { firstToken: false } });
    for (let i = 0; i < 2; i++) await store.recordAttempt(attempt(firstTokenExempt, { result: 'error', status: 500, ttft: null }));
    expect((await store.getChannel(firstTokenExempt.id))?.health.reason).toContain('失败率');
    const errorExempt = await createChannel({ cooldown: { error: false } });
    for (let i = 0; i < 2; i++) await store.recordAttempt(attempt(errorExempt));
    expect((await store.getChannel(errorExempt.id))?.health.reason).toContain('首字');
    const bothExempt = await createChannel({ cooldown: { firstToken: false, error: false } });
    for (let i = 0; i < 2; i++) await store.recordAttempt(attempt(bothExempt, { stream: false, ttft: null }));
    const current = (await store.getChannel(bothExempt.id))!;
    expect(current.status).toBe('degraded'); expect(current.health.reason).toContain('响应耗时');
  });

  it.each([
    { source: 'global', target: 'channel' }, { source: 'local', target: 'channel' },
    { source: 'global', target: 'key' }, { source: 'local', target: 'key' },
  ] as const)('skips $source HTTP automatic disable for $target until error cooldown is enabled', async ({ source, target }) => {
    await settings({ autoSwitch: false, autoDisableEnabled: source === 'global', autoDisableTarget: target, autoDisableStatuses: [401], autoDisableThreshold: 2 });
    const channel = await createChannel({
      cooldown: { error: false },
      autoDisable: { enabled: source === 'local', target, statuses: [401], threshold: 2, recover: true, cooldown: 600 },
    });
    const store = new Store(testEnv), credential = await store.addCredential(channel.id, 'Automatic disable test', 'private-test-secret');
    const failed = { credentialId: credential.id, status: 401, result: 'error' as const, ttft: null };
    for (let i = 0; i < 2; i++) await store.recordAttempt(attempt(channel, failed));
    expect((await store.getChannel(channel.id))?.health.autoDisabled).toBe(false);
    expect((await store.listCredentialMeta(channel.id))[0].enabled).toBe(true);
    const patched = await call(`/api/channels/${channel.id}`, 'PATCH', { config: { cooldown: { error: true } } });
    expect(patched.status).toBe(200);
    for (let i = 0; i < 2; i++) await store.recordAttempt(attempt(channel, failed));
    if (target === 'channel') expect((await store.getChannel(channel.id))?.health.autoDisabled).toBe(true);
    else expect((await store.listCredentialMeta(channel.id))[0]).toMatchObject({ enabled: false, reason: 'HTTP 401' });
  });
});

describe('saving cooldown exemptions releases existing restrictions', () => {
  it.each([
    { reason: 'HTTP 401', autoDisabled: true, status: 'offline' as const },
    { reason: '连续 2 次首字延迟均超过 1s', autoDisabled: false, status: 'degraded' as const },
  ])('preserves valid non-stream latency isolation when rejecting a stale $reason restriction', async ({ reason, autoDisabled, status }) => {
    const channel = await createChannel({ cooldown: { firstToken: false, error: false } }), store = new Store(testEnv);
    const until = new Date(Date.now() + 600_000).toISOString();
    await store.updateHealth(channel.id, {
      reason: '平均响应耗时 50s 超过 20s', cooldownUntil: until, autoDisabled: false, averageDuration: 50, samples: 2,
    }, 'degraded');
    await store.updateHealth(channel.id, {
      reason, autoDisabled, cooldownUntil: new Date(Date.now() + 1_200_000).toISOString(), averageTtft: 5, failureCount: 3,
    }, status);
    expect(await store.getChannel(channel.id)).toMatchObject({
      status: 'degraded',
      health: { reason: '平均响应耗时 50s 超过 20s', cooldownUntil: until, autoDisabled: false, averageDuration: 50, samples: 2 },
    });
  });

  it.each([
    { reason: '连续 2 次首字延迟均超过 1s', cooldown: { firstToken: false }, autoDisabled: false },
    { reason: '最近请求失败率超过 50%', cooldown: { error: false }, autoDisabled: false },
    { reason: 'HTTP 401', cooldown: { error: false }, autoDisabled: true },
  ])('rejects a stale $reason health restriction after its cooldown was disabled', async ({ reason, cooldown, autoDisabled }) => {
    const channel = await createChannel(), store = new Store(testEnv);
    const patched = await call(`/api/channels/${channel.id}`, 'PATCH', { config: { cooldown } });
    expect(patched.status).toBe(200);
    // Simulate a request that made its health decision before the administrator saved the exemption.
    await store.updateHealth(channel.id, {
      reason, autoDisabled, cooldownUntil: new Date(Date.now() + 600_000).toISOString(),
      averageTtft: 5, averageDuration: 6, samples: 2, failureCount: 2,
    }, autoDisabled || reason.includes('失败率') ? 'offline' : 'degraded');
    expect(await store.getChannel(channel.id)).toMatchObject({
      status: 'healthy',
      health: { reason: null, autoDisabled: false, cooldownUntil: null, averageTtft: 5, averageDuration: 6, samples: 2 },
    });
  });

  it.each([
    { reason: '连续 2 次首字延迟均超过 1s', cooldown: { firstToken: false }, released: true, autoDisabled: false },
    { reason: '连续 2 次首字延迟均超过 1s', cooldown: { error: false }, released: false, autoDisabled: false },
    { reason: '最近请求失败率超过 50%', cooldown: { firstToken: false }, released: false, autoDisabled: false },
    { reason: '最近请求失败率超过 50%', cooldown: { error: false }, released: true, autoDisabled: false },
    { reason: 'HTTP 401', cooldown: { error: false }, released: true, autoDisabled: true },
    { reason: '平均响应耗时 5.00s 超过 1s', cooldown: { firstToken: false, error: false }, released: false, autoDisabled: false },
  ])('matches the cause of $reason when saving $cooldown', async ({ reason, cooldown, released, autoDisabled }) => {
    const channel = await createChannel(), store = new Store(testEnv);
    const until = new Date(Date.now() + 600_000).toISOString();
    await store.updateHealth(channel.id, { reason, cooldownUntil: until, autoDisabled }, autoDisabled || reason.includes('失败率') ? 'offline' : 'degraded');
    const before = (await store.getChannel(channel.id))!;
    const result = await call(`/api/channels/${channel.id}`, 'PATCH', { config: { cooldown } });
    expect(result.status).toBe(200);
    if (released) expect(result.json.channel).toMatchObject({ status: 'healthy', health: { reason: null, cooldownUntil: null, autoDisabled: false } });
    else expect(result.json.channel).toMatchObject({ status: before.status, health: before.health });
  });

  it('immediately routes back to a primary whose existing first-token cooldown was exempted', async () => {
    const primary = await createChannel({}, { priority: 0 }), backup = await createChannel({}, { priority: 1 });
    const store = new Store(testEnv); await settings();
    await store.updateHealth(primary.id, { reason: '连续 2 次首字延迟均超过 1s', cooldownUntil: new Date(Date.now() + 600_000).toISOString() }, 'degraded');
    const key = await store.createKey(apiKey({ name: 'Released routing' }));
    expect((await request(key.token)).channelId).toBe(backup.id);
    expect((await call(`/api/channels/${primary.id}`, 'PATCH', { config: { cooldown: { firstToken: false } } })).status).toBe(200);
    expect((await request(key.token)).channelId).toBe(primary.id);
  });

  it('restores only automatically disabled keys and preserves manual channel activation, archives, and history', async () => {
    const channel = await createChannel(), store = new Store(testEnv);
    await store.recordAttempt(attempt(channel, { ttft: 0.01, duration: 0.01, result: 'success' }));
    const automatic = await store.addCredential(channel.id, 'Automatic', 'private-automatic-secret');
    const manual = await store.addCredential(channel.id, 'Manual', 'private-manual-secret');
    const missingDeadline = await store.addCredential(channel.id, 'No deadline', 'private-no-deadline-secret');
    await store.setCredentialHealth(automatic.id, { enabled: false, failureCount: 3, reason: 'HTTP 401', disabledAt: new Date(Date.now() + 600_000).toISOString() });
    await store.setCredentialHealth(manual.id, { enabled: false, reason: null, disabledAt: null });
    await store.setCredentialHealth(missingDeadline.id, { enabled: false, reason: 'Manual restriction', disabledAt: null });
    await store.updateHealth(channel.id, { autoDisabled: true, reason: 'HTTP 401', cooldownUntil: new Date(Date.now() + 600_000).toISOString() }, 'offline');
    const result = await call(`/api/channels/${channel.id}`, 'PATCH', { enabled: false, archived: true, config: { cooldown: { error: false } } });
    expect(result.status).toBe(200);
    expect(result.json.channel).toMatchObject({ enabled: false, archived: true, requests: 1, health: { autoDisabled: false, reason: null, cooldownUntil: null } });
    const credentials = await store.listCredentialMeta(channel.id);
    expect(credentials.find(key => key.id === automatic.id)).toMatchObject({ enabled: true, failureCount: 0, reason: null, disabledAt: null });
    expect(credentials.find(key => key.id === manual.id)).toMatchObject({ enabled: false, reason: null, disabledAt: null });
    expect(credentials.find(key => key.id === missingDeadline.id)).toMatchObject({ enabled: false, reason: 'Manual restriction', disabledAt: null });
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM attempts WHERE channel_id=?').bind(channel.id).first<{ count: number }>())?.count).toBe(1);
  });

  it('rolls back the policy edit and channel release when automatic key restoration fails', async () => {
    const channel = await createChannel(), store = new Store(testEnv);
    const credential = await store.addCredential(channel.id, 'Rollback key', 'private-rollback-secret');
    const until = new Date(Date.now() + 600_000).toISOString();
    await store.setCredentialHealth(credential.id, { enabled: false, failureCount: 3, reason: 'HTTP 401', disabledAt: until });
    await store.updateHealth(channel.id, { autoDisabled: true, reason: 'HTTP 401', cooldownUntil: until }, 'offline');
    const before = await store.getChannel(channel.id), credentials = await store.listCredentialMeta(channel.id);
    await testEnv.DB.exec("CREATE TRIGGER reject_cooldown_key_restore BEFORE UPDATE ON credentials WHEN OLD.enabled=0 AND NEW.enabled=1 BEGIN SELECT RAISE(ABORT,'synthetic key restore failure'); END");
    try {
      const result = await call(`/api/channels/${channel.id}`, 'PATCH', { name: 'Must not save', tags: ['must-not-save'], config: { cooldown: { error: false } } });
      expect(result.status).toBe(500);
      expect(await store.getChannel(channel.id)).toEqual(before);
      expect(await store.listCredentialMeta(channel.id)).toEqual(credentials);
      expect(await store.listTags()).toEqual([]);
    } finally { await testEnv.DB.exec('DROP TRIGGER reject_cooldown_key_restore'); }
  });
});
