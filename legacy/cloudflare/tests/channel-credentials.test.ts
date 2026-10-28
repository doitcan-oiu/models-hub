import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../worker/index';
import { decryptSecret } from '../worker/crypto';
import { Store } from '../worker/store';
import { apiKey } from '../worker/validation';
import type { Env } from '../worker/env';
import type { GatewayChannel } from '../shared/types';

const testEnv = env as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
type CredentialRow = { id: string; channel_id: string; label: string; preview: string; secret: string; enabled: number; failure_count: number; recovery_count: number; disabled_at: string | null; reason: string | null; created_at: string };

async function call(path: string, method = 'GET', data?: unknown, customEnv: Env = testEnv) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('http://127.0.0.1:8787' + path, {
    method, headers: { authorization: 'Bearer ' + testEnv.ADMIN_TOKEN, ...(data !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  }), customEnv, ctx);
  const content = await response.text(); await waitOnExecutionContext(ctx);
  return { status: response.status, content, json: JSON.parse(content) };
}
async function createChannel(name = 'Editable credentials', secret = 'original-private-upstream-key'): Promise<GatewayChannel> {
  const result = await call('/api/channels', 'POST', { name, endpoint: 'https://keys.example/v1', models: ['test'], apiKeys: [{ label: 'Original label', secret }] });
  expect(result.status).toBe(201); return result.json.channel;
}
async function rows(channelId: string): Promise<CredentialRow[]> {
  return (await testEnv.DB.prepare('SELECT * FROM credentials WHERE channel_id=? ORDER BY id').bind(channelId).all<CredentialRow>()).results;
}
async function snapshot() {
  return Promise.all([
    testEnv.DB.prepare('SELECT * FROM channels ORDER BY id').all(),
    testEnv.DB.prepare('SELECT * FROM credentials ORDER BY id').all(),
    testEnv.DB.prepare('SELECT * FROM credential_balances ORDER BY credential_id').all(),
    testEnv.DB.prepare('SELECT * FROM channel_accounts ORDER BY channel_id').all(),
    testEnv.DB.prepare('SELECT * FROM tags ORDER BY name').all(),
    testEnv.DB.prepare('SELECT * FROM gateway_state ORDER BY id').all(),
  ]).then(results => results.map(result => result.results));
}
async function markUnhealthy(id: string, enabled = 1) {
  await testEnv.DB.prepare('UPDATE credentials SET enabled=?,failure_count=7,recovery_count=2,disabled_at=?,reason=? WHERE id=?')
    .bind(enabled, '2099-01-01T00:00:00.000Z', 'HTTP 401', id).run();
}

beforeAll(async () => { await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS); });
beforeEach(async () => {
  await testEnv.DB.batch(['credential_balances', 'channel_accounts', 'credentials', 'channels', 'profile_usage', 'api_keys', 'attempts', 'request_logs', 'events', 'tags', 'settings', 'gateway_state'].map(table => testEnv.DB.prepare('DELETE FROM ' + table)));
});

describe('editing saved channel credentials', () => {
  it('replaces an existing key in place, preserves its creation time and count, and only returns a masked preview', async () => {
    const channel = await createChannel(), [before] = await rows(channel.id), secret = 'replacement-private-upstream-key';
    const result = await call(`/api/channels/${channel.id}`, 'PATCH', { credentialUpdates: [{ id: before.id, label: '  Replacement label  ', secret: `  ${secret}  ` }] });
    expect(result.status).toBe(200); expect(result.json.channel.credentialCount).toBe(1);
    const [after] = await rows(channel.id); expect(await rows(channel.id)).toHaveLength(1);
    expect(after).toMatchObject({ id: before.id, channel_id: channel.id, label: 'Replacement label', created_at: before.created_at, preview: '••••-key' });
    expect(after.secret).not.toBe(before.secret); expect(after.secret.startsWith('v1:')).toBe(true);
    expect(after.secret).not.toContain(secret); expect(await decryptSecret(after.secret, testEnv)).toBe(secret);
    const listed = await call(`/api/channels/${channel.id}/credentials`);
    expect(listed.json.credentials).toEqual([expect.objectContaining({ id: before.id, label: 'Replacement label', preview: '••••-key', createdAt: before.created_at })]);
    expect(listed.json.credentials[0]).not.toHaveProperty('secret');
    const bootstrap = await call('/api/bootstrap');
    for (const privateValue of ['original-private-upstream-key', secret, before.secret, after.secret]) expect(result.content + listed.content + bootstrap.content).not.toContain(privateValue);
  });

  it('renames a key without changing its encrypted value, preview or health state', async () => {
    const channel = await createChannel(), [original] = await rows(channel.id); await markUnhealthy(original.id, 0);
    const [before] = await rows(channel.id);
    const result = await call(`/api/channels/${channel.id}`, 'PATCH', { credentialUpdates: [{ id: original.id, label: '  Renamed only  ' }] });
    expect(result.status).toBe(200); expect(await rows(channel.id)).toEqual([{ ...before, label: 'Renamed only' }]);
  });

  it.each([0, 1])('resets stale key health after replacing the secret while preserving enabled=%i', async enabled => {
    const channel = await createChannel(), [before] = await rows(channel.id); await markUnhealthy(before.id, enabled);
    const result = await call(`/api/channels/${channel.id}`, 'PATCH', { credentialUpdates: [{ id: before.id, secret: 'fresh-private-secret' }] });
    expect(result.status).toBe(200);
    const [after] = await rows(channel.id);
    expect(after).toMatchObject({ id: before.id, label: before.label, created_at: before.created_at, enabled, failure_count: 0, recovery_count: 0, disabled_at: null, reason: null });
    expect(await decryptSecret(after.secret, testEnv)).toBe('fresh-private-secret');
    if (!enabled) expect(await new Store(testEnv).getCredentials(channel.id)).toEqual([]);
  });

  it('saves channel settings, existing-key edits and additional keys in one channel edit', async () => {
    const channel = await createChannel(), [before] = await rows(channel.id);
    const result = await call(`/api/channels/${channel.id}`, 'PATCH', {
      name: 'Updated channel', tags: ['edited-key'], weight: 3, config: { cooldown: { firstToken: false } },
      credentialUpdates: [{ id: before.id, label: 'Edited saved key', secret: 'edited-saved-private-key' }],
      apiKeys: [{ label: 'Additional key', secret: 'additional-private-key' }],
    });
    expect(result.status).toBe(200); expect(result.json.channel).toMatchObject({ name: 'Updated channel', tags: ['edited-key'], weight: 3, credentialCount: 2, config: { cooldown: { firstToken: false } } });
    const saved = await rows(channel.id); expect(saved).toHaveLength(2);
    const updated = saved.find(row => row.id === before.id)!, added = saved.find(row => row.id !== before.id)!;
    expect(updated).toMatchObject({ label: 'Edited saved key', created_at: before.created_at }); expect(await decryptSecret(updated.secret, testEnv)).toBe('edited-saved-private-key');
    expect(added.label).toBe('Additional key'); expect(await decryptSecret(added.secret, testEnv)).toBe('additional-private-key');
  });

  it('rejects missing, foreign and duplicate key ids before saving any part of the channel edit', async () => {
    const channel = await createChannel(), [key] = await rows(channel.id), foreign = await createChannel('Other channel'), [foreignKey] = await rows(foreign.id);
    const before = await snapshot();
    for (const credentialUpdates of [
      [{ id: key.id, secret: 'must-not-save-valid-key' }, { id: 'missing-key', secret: 'missing-private-key' }],
      [{ id: key.id, secret: 'must-not-save-valid-key' }, { id: foreignKey.id, secret: 'foreign-private-key' }],
      [{ id: key.id, label: 'Duplicate first' }, { id: key.id, secret: 'duplicate-private-key' }],
    ]) {
      const result = await call(`/api/channels/${channel.id}`, 'PATCH', { name: 'Must not save', tags: ['must-not-save'], apiKeys: ['must-not-insert-key'], credentialUpdates });
      expect([400, 404]).toContain(result.status); expect(await snapshot()).toEqual(before);
      expect(result.content).not.toContain('private-key');
    }
  });

  it('validates the entire bounded edit list and every supplied field before writing', async () => {
    const channel = await createChannel(), [key] = await rows(channel.id);
    const second = await new Store(testEnv).addCredential(channel.id, 'Unchanged second key', 'second-private-key');
    const before = await snapshot();
    const invalidUpdates: unknown[] = [null, {}, 'invalid', Array.from({ length: 101 }, (_, index) => ({ id: 'key-' + index, label: 'Too many' }))];
    const invalidEntries: unknown[] = [null, 'invalid', {}, { id: '' }, { id: 123 }, { id: key.id, label: '' }, { id: key.id, label: '   ' }, { id: key.id, label: null }, { id: key.id, label: 123 }, { id: key.id, label: 'x'.repeat(129) }, { id: key.id, secret: '' }, { id: key.id, secret: '   ' }, { id: key.id, secret: null }, { id: key.id, secret: false }, { id: key.id, secret: 's'.repeat(16001) }];
    invalidUpdates.push(...invalidEntries.map(entry => [{ id: second.id, label: 'Must not rename' }, entry]));
    for (const credentialUpdates of invalidUpdates) {
      const result = await call(`/api/channels/${channel.id}`, 'PATCH', { name: 'Must not save', tags: ['must-not-save'], apiKeys: ['must-not-insert-key'], credentialUpdates });
      expect(result.status).toBe(400); expect(await snapshot()).toEqual(before);
    }
    const valid = await call(`/api/channels/${channel.id}`, 'PATCH', { credentialUpdates: [{ id: key.id, label: 'x'.repeat(128), secret: 's'.repeat(16000) }] });
    expect(valid.status).toBe(200); const saved = (await rows(channel.id)).find(row => row.id === key.id)!; expect(saved.label).toHaveLength(128); expect(await decryptSecret(saved.secret, testEnv)).toHaveLength(16000);
  });

  it('prepares replacement encryption before changing the channel, tags or inserted keys', async () => {
    const channel = await createChannel(), [key] = await rows(channel.id), before = await snapshot();
    const result = await call(`/api/channels/${channel.id}`, 'PATCH', { name: 'Must not save', tags: ['must-not-save'], credentialUpdates: [{ id: key.id, secret: 'replacement-private-key' }] }, { ...testEnv, ENCRYPTION_KEY: 'invalid-encryption-key' });
    expect(result.status).toBe(500); expect(await snapshot()).toEqual(before); expect(result.content).not.toContain('replacement-private-key');
  });

  it('rolls back the complete channel edit when a saved-key update fails in the database', async () => {
    const channel = await createChannel(), [key] = await rows(channel.id), before = await snapshot();
    await testEnv.DB.exec("CREATE TRIGGER reject_credential_edit BEFORE UPDATE ON credentials WHEN NEW.label='reject-edit' BEGIN SELECT RAISE(ABORT,'synthetic key edit failure'); END");
    try {
      const result = await call(`/api/channels/${channel.id}`, 'PATCH', { name: 'Must roll back', tags: ['must-roll-back'], config: { cooldown: { firstToken: false } }, apiKeys: [{ label: 'Must roll back', secret: 'must-roll-back-private-key' }], credentialUpdates: [{ id: key.id, label: 'reject-edit', secret: 'rejected-private-key' }] });
      expect(result.status).toBe(500); expect(await snapshot()).toEqual(before);
      expect(result.content).not.toContain('rejected-private-key');
    } finally { await testEnv.DB.exec('DROP TRIGGER reject_credential_edit'); }
  });

  it('supports independent rename and secret replacement on the existing credential endpoint', async () => {
    const channel = await createChannel(), [key] = await rows(channel.id); await markUnhealthy(key.id, 0);
    const [before] = await rows(channel.id);
    const renamed = await call(`/api/channels/${channel.id}/credentials/${key.id}`, 'PATCH', { label: '  Single rename  ' });
    expect(renamed.status).toBe(200); expect(await rows(channel.id)).toEqual([{ ...before, label: 'Single rename' }]);
    const replaced = await call(`/api/channels/${channel.id}/credentials/${key.id}`, 'PATCH', { secret: '  single-replacement-private-key  ' });
    expect(replaced.status).toBe(200); expect(replaced.json.credential).toMatchObject({ id: key.id, label: 'Single rename', createdAt: key.created_at, enabled: false, failureCount: 0, reason: null, disabledAt: null, preview: '••••-key' });
    expect(replaced.json.credential).not.toHaveProperty('secret'); expect(replaced.content).not.toContain('single-replacement-private-key');
    const [saved] = await rows(channel.id); expect(saved.recovery_count).toBe(0); expect(await decryptSecret(saved.secret, testEnv)).toBe('single-replacement-private-key');
  });

  it('leaves the existing credential intact when a single-key edit contains an invalid label or secret', async () => {
    const channel = await createChannel(), [key] = await rows(channel.id), before = await snapshot();
    for (const patch of [{ label: '', secret: 'must-not-save-private-key' }, { label: '   ', secret: 'must-not-save-private-key' }, { label: 'x'.repeat(129), secret: 'must-not-save-private-key' }, { label: 'Must not rename', secret: '' }, { label: 'Must not rename', secret: '   ' }]) {
      expect((await call(`/api/channels/${channel.id}/credentials/${key.id}`, 'PATCH', patch)).status).toBe(400);
      expect(await snapshot()).toEqual(before);
    }
  });

  it('atomically rolls back a single-key label, secret and activation edit when the database rejects it', async () => {
    const channel = await createChannel(), [key] = await rows(channel.id); await markUnhealthy(key.id, 0);
    const before = await snapshot();
    await testEnv.DB.exec("CREATE TRIGGER reject_single_credential_edit BEFORE UPDATE OF label ON credentials WHEN NEW.label='reject-single-edit' BEGIN SELECT RAISE(ABORT,'synthetic single-key edit failure'); END");
    try {
      const result = await call(`/api/channels/${channel.id}/credentials/${key.id}`, 'PATCH', { label: 'reject-single-edit', secret: 'rejected-single-private-key', enabled: true });
      expect(result.status).toBe(500); expect(await snapshot()).toEqual(before);
    } finally { await testEnv.DB.exec('DROP TRIGGER reject_single_credential_edit'); }
  });

  it('uses the replacement immediately on the next real gateway request', async () => {
    const channel = await createChannel(), [credential] = await rows(channel.id), store = new Store(testEnv);
    const edited = await call(`/api/channels/${channel.id}`, 'PATCH', { endpoint: 'https://gateway-runtime.test', config: { endpoints: { chat: '/json/chat/completions' } }, credentialUpdates: [{ id: credential.id, secret: 'runtime-upstream-secret' }] });
    expect(edited.status).toBe(200);
    const key = await store.createKey(apiKey({ name: 'Edited credential routing' })), ctx = createExecutionContext();
    const response = await worker.fetch(new Request('http://127.0.0.1:8787/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + key.token, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'Use the replacement key' }], stream: false }) }), testEnv, ctx);
    const content = await response.text(); await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200); expect(content).toContain('runtime JSON reply'); expect(response.headers.get('x-pulsegate-channel-id')).toBe(channel.id);
    expect(await rows(channel.id)).toHaveLength(1); expect((await rows(channel.id))[0].id).toBe(credential.id);
    expect(content).not.toContain('runtime-upstream-secret');
  });
});

describe('deleting keys from the channel editor', () => {
  it('atomically saves channel settings, added keys, edited keys and deletions, including balance cleanup', async () => {
    const created = await call('/api/channels', 'POST', {
      name: 'Editable BBDevLab pool', endpoint: 'https://keys.example/v1', models: ['test'], config: { integration: 'bbdevlab' },
      apiKeys: [{ label: 'Remove', secret: 'removed-private-key' }, { label: 'Edit', secret: 'edited-private-key' }, { label: 'Keep', secret: 'kept-private-key' }],
    });
    expect(created.status).toBe(201);
    const channel = created.json.channel as GatewayChannel, initial = await rows(channel.id);
    const removed = initial.find(key => key.label === 'Remove')!, edited = initial.find(key => key.label === 'Edit')!, kept = initial.find(key => key.label === 'Keep')!;
    const updatedAt = new Date().toISOString();
    await testEnv.DB.batch(initial.map(key => testEnv.DB.prepare('INSERT INTO credential_balances(credential_id,balance,next_refresh_at) VALUES(?,?,?)')
      .bind(key.id, JSON.stringify({ status: 'ok', amount: key.id === kept.id ? 3.25 : 8, unit: '余额', updatedAt, checkedAt: updatedAt }), Date.now() + 60000)));
    const result = await call(`/api/channels/${channel.id}`, 'PATCH', {
      name: 'Saved pool', tags: ['pool-edit'], weight: 4,
      apiKeys: [{ label: 'Added', secret: 'added-private-key' }],
      credentialUpdates: [{ id: edited.id, label: 'Edited', secret: 'replacement-private-key' }],
      credentialDeletes: [`  ${removed.id}  `],
    });
    expect(result.status).toBe(200);
    expect(result.json.channel).toMatchObject({ name: 'Saved pool', tags: ['pool-edit'], weight: 4, credentialCount: 3, accountBalance: { amount: 3.25, keyCount: 3, availableKeys: 3 } });
    const saved = await rows(channel.id);
    expect(saved).toHaveLength(3); expect(saved.find(key => key.id === removed.id)).toBeUndefined();
    expect(saved.find(key => key.id === kept.id)).toEqual(kept);
    const replacement = saved.find(key => key.id === edited.id)!;
    expect(replacement).toMatchObject({ label: 'Edited', created_at: edited.created_at });
    expect(await decryptSecret(replacement.secret, testEnv)).toBe('replacement-private-key');
    expect(await decryptSecret(saved.find(key => key.label === 'Added')!.secret, testEnv)).toBe('added-private-key');
    const store = new Store(testEnv), listed = await call(`/api/channels/${channel.id}/credentials`);
    expect(listed.json.credentials.map((key: { id: string }) => key.id)).not.toContain(removed.id);
    expect((await store.getCredentials(channel.id)).map(key => key.id)).not.toContain(removed.id);
    expect((await store.listCredentialMeta(channel.id)).map(key => key.id)).not.toContain(removed.id);
    expect((await store.listChannels()).find(value => value.id === channel.id)?.credentialCount).toBe(3);
    expect(await testEnv.DB.prepare('SELECT * FROM credential_balances WHERE credential_id=?').bind(removed.id).first()).toBeNull();
    expect(await testEnv.DB.prepare('SELECT balance FROM credential_balances WHERE credential_id=?').bind(edited.id).first()).toEqual({ balance: null });
    for (const privateValue of ['removed-private-key', 'edited-private-key', 'replacement-private-key', 'added-private-key']) expect(result.content + listed.content).not.toContain(privateValue);
  });

  it('allows deleting all 100 keys in one bounded edit while retaining the channel and request history', async () => {
    const channel = await createChannel(), store = new Store(testEnv);
    await store.saveChannel(channel, false, Array.from({ length: 99 }, (_, index) => ({ label: `Pool ${index}`, secret: `pool-private-key-${index}` })));
    const keys = await rows(channel.id), startedAt = new Date().toISOString();
    await testEnv.DB.prepare('INSERT INTO attempts(id,request_id,channel_id,stream,started_at,data) VALUES(?,?,?,?,?,?)')
      .bind('retained-attempt', 'retained-request', channel.id, 0, startedAt, JSON.stringify({ credentialId: keys[0].id })).run();
    await testEnv.DB.prepare('INSERT INTO request_logs(id,created_at,channel_id,result,source,model,data) VALUES(?,?,?,?,?,?,?)')
      .bind('retained-log', startedAt, channel.id, 'success', 'api', 'test', JSON.stringify({ attempts: 1 })).run();
    const history = () => Promise.all([testEnv.DB.prepare('SELECT * FROM attempts').all(), testEnv.DB.prepare('SELECT * FROM request_logs').all()]).then(results => results.map(result => result.results));
    const historyBefore = await history();
    const result = await call(`/api/channels/${channel.id}`, 'PATCH', { credentialDeletes: keys.map(key => key.id) });
    expect(result.status).toBe(200); expect(result.json.channel.credentialCount).toBe(0);
    expect(await rows(channel.id)).toEqual([]); expect(await store.listCredentialMeta(channel.id)).toEqual([]);
    expect(await store.getCredentials(channel.id, true)).toEqual([]); expect(await store.getChannel(channel.id)).not.toBeNull();
    expect(await history()).toEqual(historyBefore);
  });

  it('rejects malformed, duplicate, oversized and conflicting delete lists before saving any changes', async () => {
    const channel = await createChannel(), [key] = await rows(channel.id), before = await snapshot();
    const invalidDeletes: unknown[] = [null, {}, 'invalid', 1, [null], [1], [{}], [''], ['   '], ['x'.repeat(129)], [key.id, key.id], [key.id, ` ${key.id} `], Array.from({ length: 101 }, (_, index) => `key-${index}`)];
    for (const credentialDeletes of invalidDeletes) {
      const result = await call(`/api/channels/${channel.id}`, 'PATCH', { name: 'Must not save', tags: ['must-not-save'], apiKeys: ['must-not-insert-private-key'], credentialDeletes });
      expect(result.status).toBe(400); expect(await snapshot()).toEqual(before);
    }
    for (const update of [{ id: key.id, label: 'Must not rename' }, { id: ` ${key.id} `, secret: 'must-not-replace-private-key' }]) {
      const result = await call(`/api/channels/${channel.id}`, 'PATCH', { name: 'Must not save', credentialUpdates: [update], credentialDeletes: [key.id] });
      expect(result.status).toBe(400); expect(await snapshot()).toEqual(before);
    }
  });

  it('rejects missing or foreign deletions without applying valid edits, additions or earlier deletions', async () => {
    const channel = await createChannel(), [key] = await rows(channel.id), store = new Store(testEnv);
    const second = await store.addCredential(channel.id, 'Second', 'second-private-key'), foreignChannel = await createChannel('Foreign pool'), [foreign] = await rows(foreignChannel.id), before = await snapshot();
    for (const id of ['missing-key', foreign.id]) {
      const result = await call(`/api/channels/${channel.id}`, 'PATCH', { name: 'Must not save', tags: ['must-not-save'], apiKeys: ['must-not-insert-private-key'], credentialUpdates: [{ id: key.id, secret: 'must-not-replace-private-key' }], credentialDeletes: [second.id, id] });
      expect(result.status).toBe(404); expect(await snapshot()).toEqual(before);
    }
  });

  it('retains pending deletions when any update is invalid or its replacement cannot be encrypted', async () => {
    const channel = await createChannel(), [removed] = await rows(channel.id), edited = await new Store(testEnv).addCredential(channel.id, 'Keep unchanged', 'keep-private-key'), before = await snapshot();
    for (const credentialUpdates of [[{ id: edited.id, secret: '' }], [{ id: 'missing-key', secret: 'must-not-save-private-key' }]]) {
      const result = await call(`/api/channels/${channel.id}`, 'PATCH', { name: 'Must not save', credentialUpdates, credentialDeletes: [removed.id] });
      expect([400, 404]).toContain(result.status); expect(await snapshot()).toEqual(before);
    }
    const encryptionFailure = await call(`/api/channels/${channel.id}`, 'PATCH', { name: 'Must not save', credentialUpdates: [{ id: edited.id, secret: 'must-not-save-private-key' }], credentialDeletes: [removed.id] }, { ...testEnv, ENCRYPTION_KEY: 'invalid-encryption-key' });
    expect(encryptionFailure.status).toBe(500); expect(await snapshot()).toEqual(before);
  });

  it('rolls back channel settings, additions, edits and cascading balance deletes when a database deletion fails', async () => {
    const channel = await createChannel(), [removed] = await rows(channel.id), store = new Store(testEnv);
    const edited = await store.addCredential(channel.id, 'Unchanged', 'unchanged-private-key');
    await testEnv.DB.prepare('INSERT INTO credential_balances(credential_id,balance) VALUES(?,?)').bind(removed.id, JSON.stringify({ status: 'ok', amount: 7 })).run();
    const before = await snapshot();
    await testEnv.DB.exec("CREATE TRIGGER reject_pool_credential_delete BEFORE DELETE ON credentials WHEN OLD.label='Original label' BEGIN SELECT RAISE(ABORT,'synthetic key delete failure'); END");
    try {
      const result = await call(`/api/channels/${channel.id}`, 'PATCH', { name: 'Must roll back', tags: ['must-roll-back'], weight: 8, apiKeys: ['must-not-insert-private-key'], credentialUpdates: [{ id: edited.id, label: 'Must roll back', secret: 'must-not-replace-private-key' }], credentialDeletes: [removed.id] });
      expect(result.status).toBe(500); expect(await snapshot()).toEqual(before);
    } finally { await testEnv.DB.exec('DROP TRIGGER reject_pool_credential_delete'); }
  });

  it('does not accept deletions while creating a new channel and accepts an empty delete list', async () => {
    const channel = await createChannel(), [key] = await rows(channel.id), before = await snapshot();
    const failed = await call('/api/channels', 'POST', { name: 'Must not create', endpoint: 'https://keys.example/v1', models: ['test'], apiKeys: ['must-not-insert-private-key'], credentialDeletes: [key.id] });
    expect(failed.status).toBe(400); expect(await snapshot()).toEqual(before);
    expect((await call(`/api/channels/${channel.id}`, 'PATCH', { credentialDeletes: [] })).status).toBe(200);
    expect((await call('/api/channels', 'POST', { name: 'Empty delete list', endpoint: 'https://keys.example/v1', models: ['test'], credentialDeletes: [] })).status).toBe(201);
  });

  it('guards direct Store saves against malformed, duplicate, conflicting and unowned delete ids', async () => {
    const channel = await createChannel(), [key] = await rows(channel.id), foreignChannel = await createChannel('Foreign pool'), [foreign] = await rows(foreignChannel.id), store = new Store(testEnv), before = await snapshot();
    const invalidLists: unknown[] = [null, {}, 'invalid', [''], [null], [123], ['x'.repeat(129)], [key.id, ` ${key.id} `], Array.from({ length: 101 }, (_, index) => `key-${index}`)];
    for (const ids of invalidLists) {
      await expect(store.saveChannel({ ...channel, name: 'Must not save' }, false, [], undefined, [], ids as string[])).rejects.toMatchObject({ status: 400 });
      expect(await snapshot()).toEqual(before);
    }
    for (const id of ['missing-key', foreign.id]) {
      await expect(store.saveChannel({ ...channel, name: 'Must not save' }, false, [], undefined, [], [id])).rejects.toMatchObject({ status: 404 });
      expect(await snapshot()).toEqual(before);
    }
    await expect(store.saveChannel({ ...channel, name: 'Must not save' }, false, [], undefined, [{ id: key.id, label: 'Must not rename' }], [key.id])).rejects.toMatchObject({ status: 400 });
    expect(await snapshot()).toEqual(before);
  });
});
