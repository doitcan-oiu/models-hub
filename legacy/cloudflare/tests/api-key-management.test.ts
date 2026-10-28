import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../worker/index';
import { Store } from '../worker/store';
import type { Env } from '../worker/env';
import type { GatewayApiKey } from '../shared/types';

const testEnv = env as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
let cookie = '';
async function call(path: string, method = 'GET', data?: unknown, options: { cookie?: string; origin?: string; token?: string; env?: Env } = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('http://127.0.0.1:8787' + path, {
    method, headers: { ...(data !== undefined ? { 'content-type': 'application/json' } : {}),
      ...((options.cookie ?? cookie) ? { cookie: options.cookie ?? cookie } : {}),
      ...(!['GET', 'HEAD'].includes(method) ? { origin: options.origin ?? 'http://127.0.0.1:8787' } : {}),
      ...(options.token ? { authorization: 'Bearer ' + options.token } : {}) },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  }), options.env ?? testEnv, ctx);
  const content = await response.text(); await waitOnExecutionContext(ctx);
  let json: any = null; try { json = JSON.parse(content); } catch { /* DELETE intentionally returns an empty body. */ }
  return { response, content, json };
}
async function newKey(input: Record<string, unknown> = {}) {
  const result = await call('/api/keys', 'POST', { name: 'Managed key', ...input });
  expect(result.response.status).toBe(201); return result.json as { key: GatewayApiKey; token: string };
}
const bulk = (ids: string[], action: 'enable' | 'disable' | 'delete') => call('/api/keys/bulk', 'POST', { ids, action });
const keyRows = async () => (await testEnv.DB.prepare('SELECT * FROM api_keys ORDER BY id').all()).results;
const usageRows = async () => (await testEnv.DB.prepare('SELECT * FROM profile_usage ORDER BY key_id,profile_id').all()).results;
const publicModels = (token: string) => call('/v1/models', 'GET', undefined, { cookie: '', token });

beforeAll(async () => { await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS); });
beforeEach(async () => {
  await testEnv.DB.batch(['channel_accounts', 'credentials', 'channels', 'profile_usage', 'api_keys', 'attempts', 'request_logs', 'events', 'tags', 'settings', 'gateway_state', 'admin_sessions'].map(table => testEnv.DB.prepare('DELETE FROM ' + table)));
  cookie = '';
  const login = await call('/api/session', 'POST', { dev: true });
  expect(login.response.status).toBe(200); cookie = login.response.headers.get('set-cookie')!.split(';')[0];
});

describe('API Key permanent deletion', () => {
  it('removes the key and profile quota while retaining request history and unrelated keys', async () => {
    expect((await call('/api/channels', 'POST', { name: 'Deletion history', models: ['test-model'], config: { protocol: 'mock', mock: { delayMs: 1 } } })).response.status).toBe(201);
    const created = await newKey({ profiles: [{ id: 'used', name: 'Used', requestLimit: '5' }, { id: 'spare', name: 'Spare' }], activeProfile: 'used' });
    const other = await newKey({ name: 'Keep me' }); const store = new Store(testEnv);
    const chat = await call('/v1/chat/completions', 'POST', { model: 'test-model', messages: [{ role: 'user', content: 'hello' }], stream: false }, { cookie: '', token: created.token });
    expect(chat.response.status).toBe(200); expect((await store.getKey(created.key.id))?.used).toBe(1);
    expect((await usageRows()).filter(row => row.key_id === created.key.id)).toHaveLength(2);
    const logs = (await testEnv.DB.prepare('SELECT * FROM request_logs ORDER BY id').all()).results;
    const attempts = (await testEnv.DB.prepare('SELECT * FROM attempts ORDER BY id').all()).results;
    expect(logs).toHaveLength(1); expect(attempts).toHaveLength(1);
    const otherBefore = await store.getKey(other.key.id), otherUsage = (await usageRows()).filter(row => row.key_id === other.key.id);
    const deleted = await call(`/api/keys/${created.key.id}`, 'DELETE');
    expect(deleted.response.status).toBe(204); expect(deleted.content).toBe('');
    expect(await store.getKey(created.key.id)).toBeNull(); expect(await store.findKey(created.token)).toBeNull();
    expect((await usageRows()).filter(row => row.key_id === created.key.id)).toEqual([]);
    expect((await call('/api/keys')).json.keys.map((key: GatewayApiKey) => key.id)).toEqual([other.key.id]);
    expect((await call('/api/bootstrap')).json.keys.map((key: GatewayApiKey) => key.id)).toEqual([other.key.id]);
    expect((await publicModels(created.token)).response.status).toBe(401);
    expect((await call('/v1/chat/completions', 'POST', { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] }, { cookie: '', token: created.token })).response.status).toBe(401);
    expect((await publicModels(other.token)).response.status).toBe(200);
    expect(await store.getKey(other.key.id)).toEqual(otherBefore); expect(await usageRows()).toEqual(otherUsage);
    expect((await testEnv.DB.prepare('SELECT * FROM request_logs ORDER BY id').all()).results).toEqual(logs);
    expect((await testEnv.DB.prepare('SELECT * FROM attempts ORDER BY id').all()).results).toEqual(attempts);
    expect((await call(`/api/keys/${created.key.id}`, 'DELETE')).response.status).toBe(404);
    expect((await call(`/api/keys/${created.key.id}`, 'PATCH', { name: 'Revive' })).response.status).toBe(404);
    expect((await call(`/api/keys/${created.key.id}/rotate`, 'POST', {})).response.status).toBe(404);
    await expect(store.saveKey({ ...created.key, name: 'Stale save' })).rejects.toMatchObject({ status: 404 });
    await expect(store.rotateKey(created.key)).rejects.toMatchObject({ status: 404 });
    expect(await store.incrementKeyUsage(created.key.id, 'used', 5)).toBe(false);
    expect(await store.getKey(created.key.id)).toBeNull(); expect(await usageRows()).toEqual(otherUsage);
  });

  it('can permanently remove legacy revoked keys without allowing stale edits to revive them', async () => {
    const created = await newKey(); const store = new Store(testEnv);
    await testEnv.DB.prepare("UPDATE api_keys SET data=json_set(data,'$.status','revoked') WHERE id=?").bind(created.key.id).run();
    await expect(store.saveKey(created.key)).rejects.toMatchObject({ status: 409 });
    await expect(store.rotateKey(created.key)).rejects.toMatchObject({ status: 409 });
    expect((await call(`/api/keys/${created.key.id}`, 'DELETE')).response.status).toBe(204);
    expect(await keyRows()).toEqual([]); expect(await usageRows()).toEqual([]);
    expect((await publicModels(created.token)).response.status).toBe(401);
  });

  it('keeps the key and quota intact when its cascading quota deletion fails', async () => {
    const created = await newKey(), before = await keyRows(), usage = await usageRows();
    await testEnv.DB.prepare("CREATE TRIGGER reject_key_quota_delete BEFORE DELETE ON profile_usage BEGIN SELECT RAISE(ABORT,'synthetic quota cleanup failure'); END").run();
    try {
      expect((await call(`/api/keys/${created.key.id}`, 'DELETE')).response.status).toBe(500);
      expect(await keyRows()).toEqual(before); expect(await usageRows()).toEqual(usage);
      expect((await publicModels(created.token)).response.status).toBe(200);
    } finally { await testEnv.DB.prepare('DROP TRIGGER reject_key_quota_delete').run(); }
    expect((await call(`/api/keys/${created.key.id}`, 'DELETE')).response.status).toBe(204);
    expect(await keyRows()).toEqual([]); expect(await usageRows()).toEqual([]);
  });

  it('requires admin authentication and same-origin session requests before changing any selected key', async () => {
    const created = await newKey(), before = await keyRows();
    for (const [path, method, data] of [[`/api/keys/${created.key.id}`, 'DELETE', undefined], ['/api/keys/bulk', 'POST', { ids: [created.key.id], action: 'delete' }], ['/api/keys/bulk', 'POST', { ids: [created.key.id], action: 'disable' }]] as const) {
      expect((await call(path, method, data, { cookie: '' })).response.status).toBe(401);
      expect((await call(path, method, data, { cookie: '', token: created.token })).response.status).toBe(401);
      expect((await call(path, method, data, { origin: 'https://evil.example' })).response.status).toBe(403);
      expect(await keyRows()).toEqual(before);
    }
  });
});

describe('API Key batch management', () => {
  it('disables and enables a whole selection while preserving secrets, policies, quotas and unselected keys', async () => {
    const first = await newKey({ note: 'Keep policy', profiles: [{ id: 'limit', name: 'Limited', requestLimit: '5' }], activeProfile: 'limit' });
    const second = await newKey({ name: 'Second', status: 'disabled' }), other = await newKey({ name: 'Unselected' });
    const store = new Store(testEnv); expect(await store.incrementKeyUsage(first.key.id, 'limit', 5)).toBe(true);
    const initial = new Map((await keyRows()).map(row => [row.id, row])), usage = await usageRows();
    const disabled = await bulk([first.key.id, second.key.id], 'disable');
    expect(disabled.response.status).toBe(200); expect(disabled.json.keys).toHaveLength(3);
    expect(disabled.json.keys.filter((key: GatewayApiKey) => key.id !== other.key.id).every((key: GatewayApiKey) => key.status === 'disabled')).toBe(true);
    expect(disabled.content).not.toContain(first.token); expect(disabled.content).not.toContain('token_hash');
    expect((await publicModels(first.token)).response.status).toBe(401); expect((await publicModels(second.token)).response.status).toBe(401);
    const enabled = await bulk([first.key.id, second.key.id], 'enable');
    expect(enabled.response.status).toBe(200); expect(enabled.json.keys.every((key: GatewayApiKey) => key.status === 'active')).toBe(true);
    expect((await publicModels(first.token)).response.status).toBe(200); expect((await publicModels(second.token)).response.status).toBe(200);
    for (const row of await keyRows()) {
      const original = initial.get(row.id)!;
      expect(row.token_hash).toBe(original.token_hash); expect(row.used).toBe(original.used);
      expect(JSON.parse(row.data as string)).toEqual({ ...JSON.parse(original.data as string), status: 'active' });
    }
    expect(await usageRows()).toEqual(usage);
  });

  it('deletes a selection containing legacy revoked keys and keeps unselected keys usable', async () => {
    const first = await newKey(), second = await newKey(), other = await newKey(); const store = new Store(testEnv);
    await testEnv.DB.prepare("UPDATE api_keys SET data=json_set(data,'$.status','revoked') WHERE id=?").bind(second.key.id).run();
    const result = await bulk([first.key.id, second.key.id], 'delete');
    expect(result.response.status).toBe(200); expect(result.json.keys.map((key: GatewayApiKey) => key.id)).toEqual([other.key.id]);
    for (const key of [first, second]) { expect(await store.getKey(key.key.id)).toBeNull(); expect(await store.findKey(key.token)).toBeNull(); expect((await publicModels(key.token)).response.status).toBe(401); }
    expect((await usageRows()).every(row => row.key_id === other.key.id)).toBe(true);
    expect((await publicModels(other.token)).response.status).toBe(200);
  });

  it('rejects malformed and duplicate selections without modifying a valid key', async () => {
    const created = await newKey(), before = await keyRows(), usage = await usageRows();
    const bodies: unknown[] = [null, [], {}, { action: 'delete' }, { ids: created.key.id, action: 'delete' },
      { ids: [], action: 'delete' }, { ids: [created.key.id, created.key.id], action: 'delete' },
      ...['', ' ', ' ' + created.key.id, created.key.id + ' ', 'x'.repeat(129), 12, null, {}].map(id => ({ ids: [created.key.id, id], action: 'delete' })),
      { ids: Array.from({ length: 201 }, (_, i) => 'key-' + i), action: 'delete' },
      ...[undefined, 'revoke', 'DELETE', '', null, 1].map(action => ({ ids: [created.key.id], action }))];
    for (const body of bodies) {
      expect((await call('/api/keys/bulk', 'POST', body)).response.status, JSON.stringify(body)).toBe(400);
      expect(await keyRows()).toEqual(before); expect(await usageRows()).toEqual(usage);
    }
  });

  it.each(['enable', 'disable', 'delete'] as const)('rejects a missing member without partially applying %s', async action => {
    const first = await newKey({ status: action === 'enable' ? 'disabled' : 'active' }), second = await newKey();
    const before = await keyRows(), usage = await usageRows();
    expect((await bulk([first.key.id, 'nonexistent', second.key.id], action)).response.status).toBe(404);
    expect(await keyRows()).toEqual(before); expect(await usageRows()).toEqual(usage);
  });

  it.each(['enable', 'disable'] as const)('rejects legacy revoked members without partially applying %s', async action => {
    const first = await newKey({ status: action === 'enable' ? 'disabled' : 'active' }), second = await newKey();
    await testEnv.DB.prepare("UPDATE api_keys SET data=json_set(data,'$.status','revoked') WHERE id=?").bind(second.key.id).run();
    const before = await keyRows(), usage = await usageRows();
    expect((await bulk([first.key.id, second.key.id], action)).response.status).toBe(409);
    expect(await keyRows()).toEqual(before); expect(await usageRows()).toEqual(usage);
  });

  it('accepts the supported boundary of 200 selected IDs in one operation', async () => {
    const created = await newKey(), ids = [created.key.id, ...Array.from({ length: 199 }, (_, i) => 'bulk-boundary-' + i)];
    await testEnv.DB.batch(ids.slice(1).map(id => testEnv.DB.prepare('INSERT INTO api_keys(id,token_hash,data) VALUES(?,?,?)').bind(id, id, JSON.stringify({ ...created.key, id }))));
    expect((await bulk(ids, 'disable')).response.status).toBe(200);
    expect((await new Store(testEnv).listKeys()).every(key => key.status === 'disabled')).toBe(true);
    expect((await bulk(ids, 'delete')).response.status).toBe(200); expect(await keyRows()).toEqual([]); expect(await usageRows()).toEqual([]);
  });

  it.each(['enable', 'disable', 'delete'] as const)('rolls back all selected keys and quota rows when a %s trigger fails', async action => {
    const first = await newKey({ status: action === 'enable' ? 'disabled' : 'active' }), second = await newKey({ status: action === 'enable' ? 'disabled' : 'active' });
    const before = await keyRows(), usage = await usageRows();
    await testEnv.DB.prepare(`CREATE TRIGGER reject_key_batch BEFORE ${action === 'delete' ? 'DELETE' : 'UPDATE'} ON api_keys WHEN OLD.id='${second.key.id}' BEGIN SELECT RAISE(ABORT,'synthetic batch failure'); END`).run();
    try {
      expect((await bulk([first.key.id, second.key.id], action)).response.status).toBe(500);
      expect(await keyRows()).toEqual(before); expect(await usageRows()).toEqual(usage);
    } finally { await testEnv.DB.prepare('DROP TRIGGER reject_key_batch').run(); }
    expect((await bulk([first.key.id, second.key.id], action)).response.status).toBe(200);
  });
});

// Mutate a selected row after preflight validation but immediately before the
// guarded SQL write, using real D1 statements on both sides of the race.
function racingEnv(race: () => Promise<void>): Env {
  let raced = false;
  const wrap = (statement: D1PreparedStatement, query: string): D1PreparedStatement => new Proxy(statement, { get(target, property) {
    if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), query);
    if ((property === 'run' || property === 'all') && /^(UPDATE|DELETE FROM) api_keys/.test(query)) return async () => { if (!raced) { raced = true; await race(); } return target[property](); };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const database = new Proxy(testEnv.DB, { get(target, property) {
    if (property === 'prepare') return (query: string) => wrap(target.prepare(query), query);
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { ...testEnv, DB: database };
}

describe('API Key batch races', () => {
  it.each(['enable', 'disable', 'delete'] as const)('does not partially %s the selection after a concurrent deletion', async action => {
    const first = await newKey({ status: action === 'enable' ? 'disabled' : 'active' }), second = await newKey();
    const before = await new Store(testEnv).getKey(first.key.id);
    const result = await call('/api/keys/bulk', 'POST', { ids: [first.key.id, second.key.id], action }, { env: racingEnv(async () => { await testEnv.DB.prepare('DELETE FROM api_keys WHERE id=?').bind(second.key.id).run(); }) });
    expect(result.response.status).toBe(404); expect(await new Store(testEnv).getKey(first.key.id)).toEqual(before);
    expect(await new Store(testEnv).getKey(second.key.id)).toBeNull();
    expect((await usageRows()).some(row => row.key_id === first.key.id)).toBe(true);
  });

  it.each(['enable', 'disable'] as const)('does not partially %s the selection after a concurrent revocation', async action => {
    const first = await newKey({ status: action === 'enable' ? 'disabled' : 'active' }), second = await newKey();
    const before = await new Store(testEnv).getKey(first.key.id), usage = await usageRows();
    const result = await call('/api/keys/bulk', 'POST', { ids: [first.key.id, second.key.id], action }, { env: racingEnv(async () => { await testEnv.DB.prepare("UPDATE api_keys SET data=json_set(data,'$.status','revoked') WHERE id=?").bind(second.key.id).run(); }) });
    expect(result.response.status).toBe(409); expect(await new Store(testEnv).getKey(first.key.id)).toEqual(before);
    expect((await new Store(testEnv).getKey(second.key.id))?.status).toBe('revoked'); expect(await usageRows()).toEqual(usage);
  });
});
