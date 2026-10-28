import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../worker/index';
import { Store } from '../worker/store';
import { decryptSecret } from '../worker/crypto';
import { channel as parseChannel } from '../worker/validation';
import type { Env } from '../worker/env';
import type { AttemptRecord, GatewayApiKey, GatewayChannel, GatewayLog } from '../shared/types';

const testEnv = env as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
let cookie = '';
async function call(path: string,method = 'GET',data?: unknown,options: { token?:string;cookie?:string;origin?:string;env?:Env;host?:string;headers?:Record<string,string> } = {}) {
  const ctx = createExecutionContext();
  const request = new Request((options.host ?? 'http://127.0.0.1:8787')+path,{ method,headers:{ ...(data !== undefined ? { 'content-type':'application/json' } : {}),...(options.token ? { authorization:'Bearer '+options.token } : {}),...(options.cookie ?? cookie ? { cookie:options.cookie ?? cookie } : {}),...(!['GET','HEAD'].includes(method) ? { origin:options.origin ?? 'http://127.0.0.1:8787' } : {}),...options.headers },...(data !== undefined ? { body:JSON.stringify(data) } : {}) });
  const result = await worker.fetch(request,options.env ?? testEnv,ctx);
  const content = await result.text(); await waitOnExecutionContext(ctx);
  let json: any = null; try { json = JSON.parse(content); } catch { /* SSE content is intentionally not parsed as JSON. */ }
  return { response:result,json,content };
}
async function newChannel(name = 'Test',tags = ['production']) { const r = await call('/api/channels','POST',{ name,models:['test-model'],tags,config:{ protocol:'mock',mock:{ delayMs:1 } } }); expect(r.response.status).toBe(201); return r.json.channel as GatewayChannel; }
async function newKey(input: Record<string,unknown> = {}) { const r = await call('/api/keys','POST',{ name:'Test key',...input }); expect(r.response.status).toBe(201); return r.json as { key:GatewayApiKey;token:string }; }
const publicCall = (path: string, headers: Record<string,string> = {}, method = 'GET', data?: unknown) => call(path,method,data,{ cookie:'',headers });

beforeAll(async () => { await applyD1Migrations(testEnv.DB,testEnv.TEST_MIGRATIONS); });
beforeEach(async () => {
  const tables = ['credentials','channels','profile_usage','api_keys','attempts','request_logs','events','tags','settings','gateway_state','admin_sessions'];
  await testEnv.DB.batch(tables.map(t => testEnv.DB.prepare('DELETE FROM '+t)));
  cookie = '';
  const login = await call('/api/session','POST',{ dev:true });
  expect(login.response.status).toBe(200); cookie = login.response.headers.get('set-cookie')!.split(';')[0];
});

describe('admin authentication and encryption', () => {
  it('rejects oversized UTF-8 log searches before D1 while accepting the exact supported boundaries', async () => {
    const store = new Store(testEnv);
    await store.recordLog({ id:'search-limit-fixture',createdAt:new Date().toISOString(),time:'12:00:00',model:'search-model',channel:'search-channel',channelId:null,apiKeyId:null,stream:false,ttft:0,duration:1,tokens:0,status:200,result:'success',attempts:1,source:'api',traceId:null,error:null });
    for (const query of ['a'.repeat(48),'中'.repeat(16),'😀'.repeat(12)]) {
      const result = await call('/api/logs?q='+encodeURIComponent(query)); expect(result.response.status).toBe(200); expect(result.json.logs).toEqual([]);
    }
    for (const query of ['a'.repeat(49),'中'.repeat(17),'😀'.repeat(13)]) {
      const result = await call('/api/logs?q='+encodeURIComponent(query)); expect(result.response.status).toBe(400); expect(result.json.error.message).toContain('搜索');
    }
  });
  it('requires authentication and denies CSRF from foreign origins',async () => {
    expect((await call('/api/bootstrap','GET',undefined,{ cookie:'' })).response.status).toBe(401);
    expect((await call('/api/channels','POST',{ name:'blocked' },{ origin:'https://evil.example' })).response.status).toBe(403);
    expect((await call('/api/session','GET')).json.authenticated).toBe(true);
  });
  it('development login is unavailable on public hosts or when DEV_MODE is false',async () => {
    expect((await call('/api/session','POST',{ dev:true },{ host:'https://public.example',origin:'https://public.example',cookie:'' })).response.status).toBe(401);
    expect((await call('/api/session','POST',{ dev:true },{ env:{ ...testEnv,DEV_MODE:'false' },cookie:'' })).response.status).toBe(401);
    expect((await call('/api/dev/fixtures','POST',{}, { env:{ ...testEnv,DEV_MODE:'false' },token:testEnv.ADMIN_TOKEN,cookie:'' })).response.status).toBe(404);
  });
  it('stores only AES-GCM upstream secrets and returns metadata',async () => {
    const c = await newChannel(); const secret = 'sk-example-private-upstream-key-123456789';
    const created = await call(`/api/channels/${c.id}/credentials`,'POST',{ label:'primary',secret });
    expect(created.response.status).toBe(201); expect(created.content).not.toContain(secret);
    const stored = await testEnv.DB.prepare('SELECT secret FROM credentials WHERE id=?').bind(created.json.credential.id).first<{ secret:string }>();
    expect(stored!.secret.startsWith('v1:')).toBe(true); expect(stored!.secret).not.toContain(secret); expect(await decryptSecret(stored!.secret,testEnv)).toBe(secret);
    expect((await call('/api/bootstrap')).content).not.toContain(secret);
    const clone = await call(`/api/channels/${c.id}/clone`,'POST',{});
    expect(clone.json.channel.enabled).toBe(false); expect((await call(`/api/channels/${clone.json.channel.id}/credentials`)).json.credentials).toEqual([]);
  });
  it('appends encrypted credentials during channel edits while preserving existing keys',async () => {
    const originalSecret = 'sk-original-private-upstream-key-123456';
    const firstSecret = 'sk-first-appended-private-key-654321';
    const secondSecret = 'sk-second-appended-private-key-987654';
    const created = await call('/api/channels','POST',{ name:'Original',models:['test-model'],config:{ protocol:'mock' },apiKeys:[{ label:'Existing',secret:originalSecret }] });
    expect(created.response.status).toBe(201); expect(created.json.channel.credentialCount).toBe(1);
    const c = created.json.channel as GatewayChannel;
    const meta = (await call(`/api/channels/${c.id}/credentials`)).json.credentials;
    await call(`/api/channels/${c.id}/credentials/${meta[0].id}`,'PATCH',{ enabled:false });
    const before = await testEnv.DB.prepare('SELECT * FROM credentials WHERE id=?').bind(meta[0].id).first();
    const patched = await call(`/api/channels/${c.id}`,'PATCH',{ name:'Updated',apiKeys:[firstSecret,{ label:'Secondary',secret:secondSecret }] });
    expect(patched.response.status).toBe(200); expect(patched.json.channel.name).toBe('Updated'); expect(patched.json.channel.credentialCount).toBe(3);
    const after = await testEnv.DB.prepare('SELECT * FROM credentials WHERE channel_id=?').bind(c.id).all<{ id:string;secret:string }>();
    expect(after.results.find(row => row.id === meta[0].id)).toEqual(before);
    const decrypted = await Promise.all(after.results.map(row => decryptSecret(row.secret,testEnv)));
    expect(decrypted.sort()).toEqual([originalSecret,firstSecret,secondSecret].sort());
    const exposed = created.content + patched.content + (await call(`/api/channels/${c.id}/credentials`)).content + (await call('/api/bootstrap')).content;
    for (const secret of [originalSecret,firstSecret,secondSecret]) expect(exposed).not.toContain(secret);
    for (const row of after.results) { expect(row.secret.startsWith('v1:')).toBe(true); expect(decrypted).not.toContain(row.secret); }
  });
  it('validates all imported keys before changing channel metadata or inserting any credential',async () => {
    const c = await newChannel('Unchanged');
    const initial = await call(`/api/channels/${c.id}/credentials`,'POST',{ label:'Original',secret:'original-secret' });
    expect(initial.response.status).toBe(201);
    const before = await testEnv.DB.prepare('SELECT * FROM credentials WHERE channel_id=?').bind(c.id).all();
    const invalidKeys = ['', 'x'.repeat(16001), { label:'x'.repeat(129),secret:'valid-secret' }];
    const batches = invalidKeys.map(invalid => ['first-valid-key',invalid]);
    batches.push(Array.from({ length:101 },() => 'valid-key'));
    for (const apiKeys of batches) {
      const patch = await call(`/api/channels/${c.id}`,'PATCH',{ name:'Should not save',tags:['failed-edit-tag'],apiKeys });
      expect(patch.response.status).toBe(400);
      const create = await call('/api/channels','POST',{ name:'Should not exist',models:['test-model'],config:{ protocol:'mock' },tags:['failed-create-tag'],apiKeys });
      expect(create.response.status).toBe(400);
    }
    const failedEncryption = await call(`/api/channels/${c.id}`,'PATCH',{ name:'Should not save',tags:['failed-edit-tag'],apiKeys:['first-valid-key','second-valid-key'] },{ env:{ ...testEnv,ENCRYPTION_KEY:undefined } });
    expect(failedEncryption.response.status).toBe(500);
    const channels = (await call('/api/channels')).json.channels;
    expect(channels).toHaveLength(1); expect(channels[0].name).toBe('Unchanged'); expect(channels[0].tags).toEqual(c.tags); expect(channels[0].credentialCount).toBe(1);
    expect((await testEnv.DB.prepare('SELECT * FROM credentials WHERE channel_id=?').bind(c.id).all()).results).toEqual(before.results);
    const tags = (await call('/api/tags')).json.tags;
    expect(tags).not.toContain('failed-edit-tag'); expect(tags).not.toContain('failed-create-tag');
  });
  it('fails credential writes without an encryption key and rejects plaintext credential headers',async () => {
    const c = await newChannel();
    expect((await call(`/api/channels/${c.id}/credentials`,'POST',{ secret:'secret' },{ env:{ ...testEnv,ENCRYPTION_KEY:undefined } })).response.status).toBe(500);
    expect((await call(`/api/channels/${c.id}`,'PATCH',{ config:{ headers:{ Authorization:'Bearer secret' } } })).response.status).toBe(400);
    expect((await call(`/api/channels/${c.id}`,'PATCH',{ config:{ bodyOverrides:{ max_tokens:500 } } })).response.status).toBe(200);
  });
  it('rejects invalid HTTP headers and gateway-managed body overrides before saving', async () => {
    const c = await newChannel();
    for (const config of [{ headers: { 'x invalid':'ok' } }, { headers: { 'x-safe':'\u0000' } }, { bodyOverrides: { model:'override' } }, { bodyOverrides: { stream:false } }]) {
      expect((await call(`/api/channels/${c.id}`,'PATCH',{ name:'Bad config',config })).response.status).toBe(400);
    }
    expect((await new Store(testEnv).getChannel(c.id))?.name).toBe(c.name);
    expect((await call(`/api/channels/${c.id}`,'PATCH',{ config:{ headers:{ 'X-Project':'valid' },bodyOverrides:{ temperature:.5 } } })).response.status).toBe(200);
  });
});

describe('API keys and profiles', () => {
  it('returns a fresh API token once, saves only its hash and rotates/deletes it',async () => {
    await newChannel(); const created = await newKey();
    expect(created.token.startsWith('pg_live_')).toBe(true);
    const stored = await testEnv.DB.prepare('SELECT token_hash,data FROM api_keys WHERE id=?').bind(created.key.id).first<{ token_hash:string;data:string }>();
    expect(stored!.token_hash).toMatch(/^[0-9a-f]{64}$/); expect(stored!.data).not.toContain(created.token);
    expect((await call('/api/keys')).content).not.toContain(created.token);
    const rotated = await call(`/api/keys/${created.key.id}/rotate`,'POST',{});
    expect(rotated.json.token).not.toBe(created.token);
    expect((await call('/v1/models','GET',undefined,{ token:created.token })).response.status).toBe(401);
    expect((await call('/v1/models','GET',undefined,{ token:rotated.json.token })).response.status).toBe(200);
    expect((await call(`/api/keys/${created.key.id}`,'DELETE')).response.status).toBe(204);
    expect((await call('/v1/models','GET',undefined,{ token:rotated.json.token })).response.status).toBe(401);
    expect((await call(`/api/keys/${created.key.id}`,'PATCH',{ status:'active' })).response.status).toBe(404);
  });
  it('filters model discovery by tag scope and model whitelist, including mappings',async () => {
    const c = await newChannel('Prod',['prod']); await call(`/api/channels/${c.id}`,'PATCH',{ models:['real-model'],config:{ aliases:[{ from:'stable',to:'real-model' }] } });
    const other = await newChannel('Other',['other']); await call(`/api/channels/${other.id}`,'PATCH',{ models:['private-model'],model:'private-model' });
    const k = await newKey({ profiles:[{ id:'p',name:'restricted',scope:'tags',tags:['prod'],match:'any',modelMode:'selected',models:['stable'],requestLimit:'5',mappings:[{ from:'public-model',to:['stable'] }] }],activeProfile:'p' });
    for (const headers of [{ authorization:'Bearer '+k.token }, { authorization:'bEaReR\t  '+k.token }, { 'x-api-key':k.token }]) {
      const list = await publicCall('/v1/models',headers);
      expect(list.response.status).toBe(200); expect(list.json.data.map((m:{ id:string }) => m.id)).toEqual(['stable','public-model']);
    }
  });
  it('applies quotas atomically to the selected profile under concurrent requests',async () => {
    const k = await newKey({ profiles:[{ id:'a',name:'A',requestLimit:'3' },{ id:'b',name:'B',requestLimit:'1' }],activeProfile:'a' });
    const store = new Store(testEnv);
    const a = await Promise.all(Array.from({ length:10 },() => store.incrementKeyUsage(k.key.id,'a',3)));
    expect(a.filter(Boolean)).toHaveLength(3);
    expect(await store.incrementKeyUsage(k.key.id,'b',1)).toBe(false);
    await call(`/api/keys/${k.key.id}`,'PATCH',{ activeProfile:'b' });
    expect(await store.incrementKeyUsage(k.key.id,'b',1)).toBe(true); expect(await store.incrementKeyUsage(k.key.id,'b',1)).toBe(false);
    const usage = await store.getKey(k.key.id); expect(usage!.used).toBe(4);
  });
  it('rolls back the profile reservation when the key total update fails and keeps the quota queue usable', async () => {
    const created = await newKey({ profiles:[{ id:'quota-rollback',name:'Rollback',requestLimit:'1' }],activeProfile:'quota-rollback' });
    const store = new Store(testEnv);
    const profileUsed = async () => (await testEnv.DB.prepare('SELECT used FROM profile_usage WHERE key_id=? AND profile_id=?').bind(created.key.id,'quota-rollback').first<{ used:number }>())!.used;
    await testEnv.DB.prepare("CREATE TRIGGER reject_key_usage BEFORE UPDATE OF used ON api_keys BEGIN SELECT RAISE(ABORT,'synthetic key usage failure'); END").run();
    try {
      await expect(store.incrementKeyUsage(created.key.id,'quota-rollback',1)).rejects.toThrow('State mutation failed');
      expect(await profileUsed()).toBe(0); expect((await store.getKey(created.key.id))!.used).toBe(0);
    } finally { await testEnv.DB.prepare('DROP TRIGGER reject_key_usage').run(); }
    expect(await store.incrementKeyUsage(created.key.id,'quota-rollback',1)).toBe(true);
    expect(await store.incrementKeyUsage(created.key.id,'quota-rollback',1)).toBe(false);
    expect(await profileUsed()).toBe(1); expect((await store.getKey(created.key.id))!.used).toBe(1);
  });
  it('renames tags across every profile and blocks deletion for NONE exclusions',async () => {
    await newChannel('Prod',['prod']);
    const k = await newKey({ profiles:[{ id:'a',name:'ANY',scope:'tags',tags:['prod'] },{ id:'b',name:'NONE',scope:'tags',tags:['prod'],match:'none' }],activeProfile:'a' });
    const renamed = await call('/api/tags/prod','PATCH',{ name:'production' }); expect(renamed.response.status).toBe(200);
    const keys = (await call('/api/keys')).json.keys as GatewayApiKey[];
    expect(keys[0].profiles.every(p => p.tags.includes('production'))).toBe(true);
    expect((await call('/api/tags/production','DELETE')).response.status).toBe(409);
    await call(`/api/keys/${k.key.id}`,'DELETE'); expect((await call('/api/tags/production','DELETE')).response.status).toBe(200);
  });
  it('cannot revive a deleted key from a stale edit or rotation snapshot', async () => {
    const created = await newKey(); const store = new Store(testEnv);
    const stale = structuredClone(created.key);
    await call(`/api/keys/${stale.id}`,'DELETE');
    await expect(store.saveKey({ ...stale,name:'stale edit' })).rejects.toMatchObject({ status:404 });
    await expect(store.rotateKey(stale)).rejects.toMatchObject({ status:404 });
    expect(await store.getKey(stale.id)).toBeNull();
    expect((await call('/v1/models','GET',undefined,{ token:created.token })).response.status).toBe(401);
  });
  it('rotates only the token and keeps a policy edited after the rotation snapshot', async () => {
    const created = await newKey(); const store = new Store(testEnv);
    await call(`/api/keys/${created.key.id}`,'PATCH',{ name:'Fresh policy',expires:'never',profiles:[{ id:'new-policy',name:'Changed',requestLimit:'2' }],activeProfile:'new-policy' });
    const rotated = await store.rotateKey(created.key);
    expect(rotated.key.name).toBe('Fresh policy'); expect(rotated.key.activeProfile).toBe('new-policy');
    expect((await call('/v1/models','GET',undefined,{ token:rotated.token })).response.status).toBe(200);
  });
  it('keeps concurrent health updates and key revocation intact when renaming/deleting a tag', async () => {
    const c = await newChannel('Race',['old']); const k = await newKey({ profiles:[{ id:'p',scope:'tags',tags:['old'] }],activeProfile:'p' });
    let phase = 0;
    const racingDB = new Proxy(testEnv.DB, { get(target, property) {
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
        phase++;
        await target.prepare("UPDATE channels SET data=json_set(data,'$.status','degraded','$.requests',?,'$.health.reason','concurrent health update'),health_version=health_version+1 WHERE id=?").bind(70+phase,c.id).run();
        await target.prepare("UPDATE api_keys SET data=json_set(data,'$.status','revoked','$.name','concurrent revocation') WHERE id=?").bind(k.key.id).run();
        return target.batch(statements);
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const store = new Store({ ...testEnv,DB:racingDB });
    await store.renameTag('old','new');
    let current = (await store.getChannel(c.id))!;
    expect(current.tags).toEqual(['new']); expect(current.requests).toBe(71); expect(current.status).toBe('degraded'); expect(current.health.reason).toBe('concurrent health update');
    const key = (await store.getKey(k.key.id))!;
    expect(key.status).toBe('revoked'); expect(key.name).toBe('concurrent revocation'); expect(key.profiles[0].tags).toEqual(['new']);
    await store.deleteTag('new'); current = (await store.getChannel(c.id))!;
    expect(current.tags).toEqual([]); expect(current.requests).toBe(72); expect(current.status).toBe('degraded'); expect(current.health.reason).toBe('concurrent health update');
  });
});

describe('public API authentication header compatibility', () => {
  it.each([
    ['standard', 'Bearer '], ['lowercase', 'bearer '], ['uppercase', 'BEARER '],
    ['multiple spaces', 'Bearer   '], ['tab separator', 'Bearer\t'], ['mixed horizontal whitespace', 'bEaReR \t  '],
  ])('accepts %s Bearer syntax for model discovery', async (_label, prefix) => {
    await newChannel(); const key = await newKey();
    const result = await publicCall('/v1/models',{ authorization:prefix+key.token });
    expect(result.response.status).toBe(200); expect(result.json.data.map((model: { id:string }) => model.id)).toEqual(['test-model']);
    expect((await new Store(testEnv).getKey(key.key.id))?.used).toBe(0);
  });

  it('accepts x-api-key for models while keeping chat and admin authentication boundaries', async () => {
    await newChannel(); const key = await newKey();
    const listed = await publicCall('/v1/models',{ 'x-api-key':key.token });
    expect(listed.response.status).toBe(200); expect(listed.json.data.map((model: { id:string }) => model.id)).toEqual(['test-model']);
    const chat = await publicCall('/v1/chat/completions',{ 'x-api-key':key.token },'POST',{ model:'test-model',messages:[{ role:'user',content:'hello' }],stream:false });
    expect(chat.response.status).toBe(401);
    expect((await publicCall('/api/bootstrap',{ authorization:'bearer '+key.token })).response.status).toBe(401);
    expect((await publicCall('/api/bootstrap',{ 'x-api-key':testEnv.ADMIN_TOKEN! })).response.status).toBe(401);
    expect((await new Store(testEnv).getKey(key.key.id))?.used).toBe(0);
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM attempts').first<{ count:number }>())?.count).toBe(0);
  });

  it.each(['wrong','preview','admin','upstream','missing','disabled','revoked','deleted','expired','rotated'] as const)('keeps rejecting a %s credential through both models authentication headers', async mode => {
    const channel = await newChannel();
    const key = await newKey(mode === 'expired' ? { expires:'2000-01-01T00:00:00Z' } : mode === 'disabled' ? { status:'disabled' } : {});
    let token = key.token;
    if (mode === 'wrong') token = 'pg_live_synthetic-unknown-client-key';
    if (mode === 'preview') token = key.key.preview;
    if (mode === 'admin') token = testEnv.ADMIN_TOKEN!;
    if (mode === 'upstream') {
      token = 'pg_live_synthetic-upstream-only-key';
      expect((await call(`/api/channels/${channel.id}/credentials`,'POST',{ label:'Upstream only',secret:token })).response.status).toBe(201);
    }
    if (mode === 'revoked') await testEnv.DB.prepare("UPDATE api_keys SET data=json_set(data,'$.status','revoked') WHERE id=?").bind(key.key.id).run();
    if (mode === 'deleted') expect((await call(`/api/keys/${key.key.id}`,'DELETE')).response.status).toBe(204);
    if (mode === 'rotated') expect((await call(`/api/keys/${key.key.id}/rotate`,'POST',{})).response.status).toBe(200);
    const variants: Record<string,string>[] = mode === 'missing' ? [{}] : [{ authorization:'Bearer '+token }, { 'x-api-key':token }];
    for (const headers of variants) {
      const result = await publicCall('/v1/models',headers);
      expect(result.response.status).toBe(401); expect(result.json.error.message).toBe('Invalid, disabled or expired API key');
      expect(result.content).not.toContain(token);
    }
  });

  it.each(['/v1/models','/v1/messages'])('does not replace an explicit incorrect Bearer token with a valid x-api-key on %s', async path => {
    await newChannel(); const key = await newKey();
    const result = await publicCall(path,{ authorization:'Bearer pg_live_synthetic-wrong-client-key','x-api-key':key.token },path === '/v1/models' ? 'GET' : 'POST',path === '/v1/models' ? undefined : { model:'test-model',max_tokens:32,messages:[{ role:'user',content:'hello' }] });
    expect(result.response.status).toBe(401); expect(result.content).not.toContain(key.token);
    expect((await new Store(testEnv).getKey(key.key.id))?.used).toBe(0);
  });

  it.each(['internal space','internal tab','comma joined','repeated Bearer','multiple values','duplicate headers','missing token'] as const)('rejects malformed or duplicated Bearer credentials: %s', async mode => {
    await newChannel(); const key = await newKey();
    const split = Math.floor(key.token.length/2);
    const values = {
      'internal space':`Bearer ${key.token.slice(0,split)} ${key.token.slice(split)}`,
      'internal tab':`Bearer ${key.token.slice(0,split)}\t${key.token.slice(split)}`,
      'comma joined':`Bearer ${key.token},${key.token}`,
      'repeated Bearer':`Bearer Bearer ${key.token}`,
      'multiple values':`Bearer ${key.token}, Bearer ${key.token}`,
      'duplicate headers':`Bearer ${key.token}`,
      'missing token':'Bearer   ',
    };
    const headers: Record<string,string> = { authorization:values[mode],...(mode === 'duplicate headers' ? { Authorization:`Bearer ${key.token}` } : {}) };
    expect((await publicCall('/v1/models',headers)).response.status).toBe(401);
  });

  it('keeps a missing current profile as a permission failure under either accepted header', async () => {
    await newChannel(); const key = await newKey();
    await testEnv.DB.prepare("UPDATE api_keys SET data=json_set(data,'$.activeProfile','missing-profile') WHERE id=?").bind(key.key.id).run();
    for (const headers of [{ authorization:'bearer '+key.token }, { 'x-api-key':key.token }]) {
      const result = await publicCall('/v1/models',headers);
      expect(result.response.status).toBe(403); expect(result.json.error.message).toBe('Active profile is unavailable');
    }
  });
});

describe('persisted routing state and administration', () => {
  it('stores settings and encrypted AI Gateway token independently',async () => {
    const saved = await call('/api/settings','PATCH',{ threshold:8,window:10,samples:3,aiGatewayToken:'ai-private-token-123' });
    expect(saved.json.settings.threshold).toBe(8); expect(saved.json.settings.hasAiGatewayToken).toBe(true); expect(saved.content).not.toContain('ai-private-token-123');
    const store = new Store(testEnv); expect(await store.getAiGatewayToken()).toBe('ai-private-token-123');
    await call('/api/settings','PATCH',{ aiGatewayToken:'' }); expect(await store.getAiGatewayToken()).toBe('ai-private-token-123');
    await call('/api/settings','PATCH',{ clearAiGatewayToken:true }); expect(await store.getAiGatewayToken()).toBeNull();
  });
  it('persists round robin and enforces rates without oversubscription',async () => {
    const c = await newChannel(); c.config.rateLimit.requestsPerMinute = 2; const store = new Store(testEnv);
    const values = await Promise.all(Array.from({ length:5 },() => store.nextRoundRobin('test'))); expect([...values].sort()).toEqual([0,1,2,3,4]);
    const reservations = await Promise.all(Array.from({ length:5 },() => store.reserveChannel(c,100))); expect(reservations.filter(Boolean)).toHaveLength(2);
    await store.setSticky('trace','channel-a'); expect(await new Store(testEnv).getSticky('trace')).toBe('channel-a');
  });
  it('supports bulk actions and fixture cleanup without deleting real channels',async () => {
    const c = await newChannel(); await call('/api/channels/bulk','POST',{ ids:[c.id],action:'tags',tags:['extra'],mode:'add' });
    expect((await call(`/api/channels/${c.id}`)).json.channel.tags).toEqual(['production','extra']);
    await call('/api/dev/fixtures','POST',{}); expect((await call('/api/channels')).json.channels).toHaveLength(3);
    await call('/api/dev/fixtures','DELETE'); expect((await call('/api/channels')).json.channels).toHaveLength(1);
  });
  it('validates merged bulk tag limits for every channel before changing an earlier valid channel', async () => {
    const first = await newChannel('First',['original']), second = await newChannel('At limit',Array.from({ length:100 },(_,i) => `tag-${i}`));
    const result = await call('/api/channels/bulk','POST',{ ids:[first.id,second.id],action:'tags',mode:'add',tags:['extra'] });
    expect(result.response.status).toBe(400); const store = new Store(testEnv);
    expect((await store.getChannel(first.id))?.tags).toEqual(first.tags); expect((await store.getChannel(second.id))?.tags).toEqual(second.tags);
    expect(await store.listTags()).not.toContain('extra');
    expect((await call('/api/channels/bulk','POST',{ ids:[first.id,second.id],action:'tags',mode:'replace',tags:['shared'] })).response.status).toBe(200);
    expect((await store.getChannel(first.id))?.tags).toEqual(['shared']); expect((await store.getChannel(second.id))?.tags).toEqual(['shared']);
  });
  it('records genuine gateway traffic and returns attempt details',async () => {
    const c = await newChannel(); const k = await newKey();
    const chat = await call('/v1/chat/completions','POST',{ model:'test-model',messages:[{ role:'user',content:'Hello' }],stream:false },{ token:k.token });
    expect(chat.response.status).toBe(200); expect(chat.json.choices[0].message.content).toBeTruthy();
    const logs = (await call('/api/logs')).json.logs; expect(logs).toHaveLength(1); expect(logs[0].channelId).toBe(c.id);
    const details = (await call(`/api/logs/${logs[0].id}`)).json; expect(details.attempts).toHaveLength(1); expect(details.attempts[0].result).toBe('success');
    expect((await call('/api/dashboard')).json.totals.requests).toBe(1);
  });
  it('clears every request log and attempt while preserving channels, usage, health and independent records',async () => {
    const c = await newChannel(); const k = await newKey(); const store = new Store(testEnv);
    await call('/api/settings','PATCH',{ threshold:.1 });
    const chat = await call('/v1/chat/completions','POST',{ model:'test-model',messages:[{ role:'user',content:'Log clearing test' }] },{ token:k.token });
    expect(chat.response.status).toBe(200);
    expect((await call(`/api/channels/${c.id}/test`,'POST',{ stream:false })).response.status).toBe(200);
    await store.recordAttempt({ id:crypto.randomUUID(),requestId:'orphan-request',channelId:c.id,channelName:c.name,credentialId:null,model:'test-model',stream:false,startedAt:new Date().toISOString(),ttft:null,duration:.01,status:200,result:'success',error:null,inputTokens:1,outputTokens:1,attempt:1 });
    await store.recordEvent({ id:'kept-event',time:'now',createdAt:new Date().toISOString(),title:'Independent event',description:'Keep this event',type:'info',channelId:c.id });
    const logs = (await call('/api/logs')).json.logs as GatewayLog[];
    expect(logs).toHaveLength(2); expect(new Set(logs.map(log => log.source))).toEqual(new Set(['api','probe']));
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS total FROM attempts').first<{ total:number }>())?.total).toBe(3);
    expect((await store.getChannel(c.id))!.requests).toBe(3); expect((await store.getKey(k.key.id))!.used).toBe(1);
    const preservedTables = ['channels','credentials','api_keys','profile_usage','events','settings','tags','gateway_state','admin_sessions'];
    const snapshot = async () => Promise.all(preservedTables.map(async table => ({ table,rows:(await testEnv.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results })));
    const before = await snapshot();
    const cleared = await call('/api/logs?q=does-not-match&result=error','DELETE');
    expect(cleared.response.status).toBe(200); expect(cleared.json).toEqual({ cleared:true });
    expect((await call('/api/logs')).json).toEqual({ logs:[],total:0 });
    for (const log of logs) expect((await call(`/api/logs/${log.id}`)).response.status).toBe(404);
    expect((await call(`/api/channels/${c.id}/tests`)).json).toEqual({ logs:[],total:0 });
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS total FROM attempts').first<{ total:number }>())?.total).toBe(0);
    expect(await snapshot()).toEqual(before);
    expect((await call('/api/logs','DELETE')).json).toEqual({ cleared:true });
  });
  it('requires administrator authentication and same-origin protection before clearing logs',async () => {
    await newChannel(); const k = await newKey();
    await call('/v1/chat/completions','POST',{ model:'test-model',messages:[{ role:'user',content:'Keep this log' }] },{ token:k.token });
    expect((await call('/api/logs','DELETE',undefined,{ cookie:'' })).response.status).toBe(401);
    expect((await call('/api/logs','DELETE',undefined,{ cookie:'',token:k.token })).response.status).toBe(401);
    expect((await call('/api/logs','DELETE',undefined,{ origin:'https://evil.example' })).response.status).toBe(403);
    const ctx = createExecutionContext();
    const withoutOrigin = await worker.fetch(new Request('http://127.0.0.1:8787/api/logs',{ method:'DELETE',headers:{ cookie } }),testEnv,ctx);
    expect(withoutOrigin.status).toBe(403); await withoutOrigin.text(); await waitOnExecutionContext(ctx);
    expect((await call('/api/logs')).json.total).toBe(1);
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS total FROM attempts').first<{ total:number }>())?.total).toBe(1);
    expect((await call('/api/logs','DELETE',undefined,{ cookie:'',token:testEnv.ADMIN_TOKEN })).json).toEqual({ cleared:true });
  });
  it('rolls back both log tables if clearing either table fails',async () => {
    await newChannel(); const k = await newKey();
    await call('/v1/chat/completions','POST',{ model:'test-model',messages:[{ role:'user',content:'Atomic clear' }] },{ token:k.token });
    const beforeLogs = (await testEnv.DB.prepare('SELECT * FROM request_logs').all()).results;
    const beforeAttempts = (await testEnv.DB.prepare('SELECT * FROM attempts').all()).results;
    expect(beforeLogs).toHaveLength(1); expect(beforeAttempts).toHaveLength(1);
    await testEnv.DB.prepare("CREATE TRIGGER reject_log_clear BEFORE DELETE ON request_logs BEGIN SELECT RAISE(ABORT,'synthetic clear failure'); END").run();
    try {
      expect((await call('/api/logs','DELETE')).response.status).toBe(500);
      expect((await testEnv.DB.prepare('SELECT * FROM request_logs').all()).results).toEqual(beforeLogs);
      expect((await testEnv.DB.prepare('SELECT * FROM attempts').all()).results).toEqual(beforeAttempts);
    } finally { await testEnv.DB.prepare('DROP TRIGGER reject_log_clear').run(); }
  });
  it('aggregates health across requests, requires the matching mode and starts a fresh recovery window',async () => {
    const c = await newChannel(); const store = new Store(testEnv);
    await call('/api/settings','PATCH',{ threshold:.02,window:4,samples:2,cooldown:1,recovery:2 });
    let sequence = 0;
    const attempt = (ttft:number,stream = true): AttemptRecord => ({ id:crypto.randomUUID(),requestId:crypto.randomUUID(),channelId:c.id,channelName:c.name,credentialId:null,model:'test-model',stream,startedAt:new Date(Date.now()+sequence++*100).toISOString(),ttft:stream ? ttft : null,duration:.01,status:200,result:ttft > .02 ? 'slow' : 'success',error:null,inputTokens:1,outputTokens:1,attempt:1 });
    await Promise.all([store.recordAttempt(attempt(.1)),store.recordAttempt(attempt(.1))]);
    expect((await store.getChannel(c.id))!.status).toBe('healthy');
    expect((await call('/api/events')).json.events).toEqual([]);
    await Promise.all([store.recordAttempt(attempt(.1)),store.recordAttempt(attempt(.1))]);
    expect((await store.getChannel(c.id))!.status).toBe('degraded');
    await store.updateHealth(c.id,{ cooldownUntil:new Date(Date.now()-1000).toISOString() });
    await store.recordAttempt(attempt(.001,false)); expect((await store.getChannel(c.id))!.health.recoveryCount).toBe(0);
    await store.recordAttempt(attempt(.001)); expect((await store.getChannel(c.id))!.health.recoveryCount).toBe(1);
    await store.recordAttempt(attempt(.001)); expect((await store.getChannel(c.id))!.status).toBe('healthy');
    await store.recordAttempt(attempt(.001)); const recovered = (await store.getChannel(c.id))!;
    expect(recovered.status).toBe('healthy'); expect(recovered.health.averageTtft).toBeLessThan(.02); expect(recovered.requests).toBe(8);
  });
  it('routes subsequent real SSE requests away from HTTP 200 channels after their TTFT window degrades',async () => {
    const primary = await newChannel('HTTP 200 slow primary',['slow-test']); const backup = await newChannel('Fast backup',['slow-test']);
    await call(`/api/channels/${primary.id}`,'PATCH',{ priority:0,config:{ mock:{ scenario:'slow',delayMs:120 } } });
    await call(`/api/channels/${backup.id}`,'PATCH',{ priority:1,config:{ mock:{ scenario:'healthy',delayMs:1 } } });
    await call('/api/settings','PATCH',{ threshold:.06,window:4,samples:2,streamFirstTokenTimeout:.5,maxSameChannelRetries:0,maxChannelRetries:1,retryDelayMs:100,stickyMode:'off' });
    const k = await newKey({ profiles:[{ id:'slow',name:'Slow isolated scope',scope:'tags',tags:['slow-test'],requestLimit:'10' }],activeProfile:'slow' });
    const input = { model:'test-model',messages:[{ role:'user',content:'Window integration test' }],stream:true,max_tokens:32 };
    for (let i = 0; i < 4; i++) {
      const result = await call('/v1/chat/completions','POST',input,{ token:k.token });
      expect(result.response.status).toBe(200); expect(result.response.headers.get('x-pulsegate-channel-id')).toBe(primary.id); expect(result.content).toContain('[DONE]');
      if (i < 3) {
        expect((await call(`/api/channels/${primary.id}`)).json.channel.status).toBe('healthy');
        expect((await call('/api/events')).json.events).toEqual([]);
      }
    }
    const health = (await call(`/api/channels/${primary.id}`)).json.channel as GatewayChannel;
    expect(health.status).toBe('degraded'); expect(health.health.samples).toBe(4); expect(health.health.averageTtft).toBeGreaterThan(.06);
    expect(health.health.reason).toContain('连续 4');
    const next = await call('/v1/chat/completions','POST',input,{ token:k.token });
    expect(next.response.status).toBe(200); expect(next.response.headers.get('x-pulsegate-channel-id')).toBe(backup.id);
    const logs = (await call('/api/logs')).json.logs;
    const primaryLogs = logs.filter((l:{channelId:string}) => l.channelId === primary.id);
    expect(primaryLogs).toHaveLength(4); expect(primaryLogs.every((l:{status:number;result:string}) => l.status === 200 && l.result === 'slow')).toBe(true);
    expect((await call('/api/events')).json.events.filter((e:{channelId:string;type:string}) => e.channelId === primary.id && e.type === 'warning')).toHaveLength(1);
  });
  it('keeps a primary with a mixed high-average TTFT window until four consecutive slow requests complete',async () => {
    const primary = await newChannel('Mixed-window primary',['mixed-window']); const backup = await newChannel('Mixed-window backup',['mixed-window']);
    await call(`/api/channels/${primary.id}`,'PATCH',{ priority:0,config:{ mock:{ scenario:'slow',delayMs:120 } } });
    await call(`/api/channels/${backup.id}`,'PATCH',{ priority:1,config:{ mock:{ scenario:'healthy',delayMs:1 } } });
    await call('/api/settings','PATCH',{ threshold:.06,window:4,samples:2,streamFirstTokenTimeout:.5,maxSameChannelRetries:0,maxChannelRetries:1,retryDelayMs:100,stickyMode:'off' });
    const store = new Store(testEnv); const recordedAt = Date.now()-5000;
    for (const [index,ttft] of [.001,2,.001,.001].entries()) {
      await store.recordAttempt({ id:crypto.randomUUID(),requestId:crypto.randomUUID(),channelId:primary.id,channelName:primary.name,credentialId:null,model:'test-model',stream:true,startedAt:new Date(recordedAt+index*100).toISOString(),ttft,duration:ttft+.01,status:200,result:ttft > .06 ? 'slow' : 'success',error:null,inputTokens:1,outputTokens:1,attempt:1 });
      expect((await store.getChannel(primary.id))!.status).toBe('healthy');
      expect((await call('/api/events')).json.events).toEqual([]);
    }
    const mixed = (await store.getChannel(primary.id))!;
    expect(mixed.health.samples).toBe(4); expect(mixed.health.averageTtft).toBeGreaterThan(.06);
    const k = await newKey({ profiles:[{ id:'mixed',name:'Mixed scope',scope:'tags',tags:['mixed-window'],requestLimit:'10' }],activeProfile:'mixed' });
    const input = { model:'test-model',messages:[{ role:'user',content:'Consecutive slow window test' }],stream:true };
    for (let index = 0; index < 4; index++) {
      const response = await call('/v1/chat/completions','POST',input,{ token:k.token });
      expect(response.response.status).toBe(200); expect(response.response.headers.get('x-pulsegate-channel-id')).toBe(primary.id);
      expect(response.response.headers.get('x-pulsegate-attempts')).toBe('1'); expect(response.content).toContain('[DONE]'); expect(response.content).not.toContain('"error"');
      const current = (await store.getChannel(primary.id))!;
      expect(current.status).toBe(index === 3 ? 'degraded' : 'healthy');
      const warnings = (await call('/api/events')).json.events.filter((event:{ channelId:string;type:string }) => event.channelId === primary.id && event.type === 'warning');
      expect(warnings).toHaveLength(index === 3 ? 1 : 0);
    }
    const degraded = (await store.getChannel(primary.id))!;
    expect(degraded.health.reason).toContain('连续 4'); expect(degraded.health.reason).toContain('0.06'); expect(degraded.requests).toBe(8);
    const next = await call('/v1/chat/completions','POST',input,{ token:k.token });
    expect(next.response.status).toBe(200); expect(next.response.headers.get('x-pulsegate-channel-id')).toBe(backup.id); expect(next.content).toContain('[DONE]');
    expect((await store.getChannel(backup.id))!.requests).toBe(1); expect((await store.getKey(k.key.id))!.used).toBe(5);
    const logs = (await call('/api/logs')).json.logs as GatewayLog[];
    expect(logs).toHaveLength(5); expect(logs.filter(log => log.channelId === primary.id)).toHaveLength(4);
    expect(logs.every(log => log.status === 200 && log.attempts === 1)).toBe(true);
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS total FROM attempts').first<{ total:number }>())?.total).toBe(9);
  });
  it('fails over before the first meaningful token on a hard TTFT timeout without waiting for a full health window',async () => {
    const primary = await newChannel('Timeout primary',['timeout-test']); const backup = await newChannel('Timeout backup',['timeout-test']);
    await call(`/api/channels/${primary.id}`,'PATCH',{ priority:0,config:{ mock:{ scenario:'slow',delayMs:120 } } });
    await call(`/api/channels/${backup.id}`,'PATCH',{ priority:1,config:{ mock:{ scenario:'healthy',delayMs:1 } } });
    await call('/api/settings','PATCH',{ threshold:.06,window:10,samples:10,streamFirstTokenTimeout:.03,maxSameChannelRetries:0,maxChannelRetries:1,retryDelayMs:100,stickyMode:'off' });
    const k = await newKey({ profiles:[{ id:'timeout',name:'Timeout scope',scope:'tags',tags:['timeout-test'] }],activeProfile:'timeout' });
    const result = await call('/v1/chat/completions','POST',{ model:'test-model',messages:[{ role:'user',content:'Timeout test' }],stream:true },{ token:k.token });
    expect(result.response.status).toBe(200); expect(result.response.headers.get('x-pulsegate-channel-id')).toBe(backup.id); expect(result.response.headers.get('x-pulsegate-attempts')).toBe('2');
    const output = result.content.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? '').join('');
    expect(output).not.toContain('Timeout primary'); expect(output).toContain('Timeout backup');
    const detail = (await call(`/api/logs/${result.response.headers.get('x-pulsegate-request-id')}`)).json;
    expect(detail.log.result).toBe('failover'); expect(detail.attempts).toHaveLength(2); expect(detail.attempts[0].channelId).toBe(primary.id); expect(detail.attempts[0].status).toBe(504); expect(detail.attempts[0].ttft).toBeNull(); expect(detail.attempts[1].result).toBe('success');
    const primaryHealth = (await call(`/api/channels/${primary.id}`)).json.channel as GatewayChannel;
    expect(primaryHealth.health.samples).toBe(1); expect(primaryHealth.status).toBe('healthy');
  });
  it('preserves credential failure counters on cancellation and requires consecutive recovery probes',async () => {
    const c = await newChannel(); const store = new Store(testEnv);
    await call(`/api/channels/${c.id}`,'PATCH',{ config:{ autoDisable:{ enabled:true,target:'key',statuses:[401],threshold:2,recover:true,cooldown:1 } } });
    await call('/api/settings','PATCH',{ recovery:2 });
    const credential = await store.addCredential(c.id,'upstream','private-upstream-secret'); let seq = 0;
    const attempt = (status:number,result:AttemptRecord['result']): AttemptRecord => ({ id:crypto.randomUUID(),requestId:crypto.randomUUID(),channelId:c.id,channelName:c.name,credentialId:credential.id,model:'test-model',stream:true,startedAt:new Date(Date.now()+seq++).toISOString(),ttft:result === 'success' ? .001 : null,duration:.01,status,result,error:result === 'error' ? 'provider failure' : null,inputTokens:0,outputTokens:0,attempt:1 });
    await store.recordAttempt(attempt(401,'error')); await store.recordAttempt(attempt(499,'cancelled'));
    expect((await store.listCredentialMeta(c.id))[0].failureCount).toBe(1);
    await store.recordAttempt(attempt(401,'error')); expect((await store.listCredentialMeta(c.id))[0].enabled).toBe(false);
    await testEnv.DB.prepare('UPDATE credentials SET disabled_at=? WHERE id=?').bind(new Date(Date.now()-1000).toISOString(),credential.id).run();
    await store.recordAttempt(attempt(200,'success')); expect((await store.listCredentialMeta(c.id))[0].enabled).toBe(false);
    await store.recordAttempt(attempt(503,'error')); await store.recordAttempt(attempt(200,'success')); expect((await store.listCredentialMeta(c.id))[0].enabled).toBe(false);
    await store.recordAttempt(attempt(200,'success')); expect((await store.listCredentialMeta(c.id))[0].enabled).toBe(true);
  });
  it('never probes or restores manually disabled credentials and respects recovery policy/cooldown', async () => {
    const c = await newChannel(); const store = new Store(testEnv);
    await call(`/api/channels/${c.id}`,'PATCH',{ config:{ autoDisable:{ enabled:true,target:'key',recover:true,cooldown:1 } } });
    await call('/api/settings','PATCH',{ recovery:1 });
    const manual = await store.addCredential(c.id,'manual','manual-private-secret');
    const automatic = await store.addCredential(c.id,'automatic','auto-private-secret');
    await store.changeCredential(c.id,manual.id,{ enabled:false });
    await store.setCredentialHealth(automatic.id,{ enabled:false,reason:'HTTP 401',disabledAt:new Date(Date.now()+60000).toISOString() });
    const success = (id:string): AttemptRecord => ({ id:crypto.randomUUID(),requestId:crypto.randomUUID(),channelId:c.id,channelName:c.name,credentialId:id,model:'test-model',stream:true,startedAt:new Date().toISOString(),ttft:.001,duration:.01,status:200,result:'success',error:null,inputTokens:0,outputTokens:0,attempt:1 });
    expect(await store.getCredentials(c.id,true)).toEqual([]);
    await store.recordAttempt(success(manual.id)); await store.recordAttempt(success(automatic.id));
    expect((await store.listCredentialMeta(c.id)).every(key => !key.enabled)).toBe(true);
    await store.setCredentialHealth(automatic.id,{ disabledAt:new Date(Date.now()-1000).toISOString() });
    await call(`/api/channels/${c.id}`,'PATCH',{ config:{ autoDisable:{ enabled:true,recover:false } } });
    expect(await store.getCredentials(c.id,true)).toEqual([]); await store.recordAttempt(success(automatic.id));
    expect((await store.listCredentialMeta(c.id)).every(key => !key.enabled)).toBe(true);
    await call(`/api/channels/${c.id}`,'PATCH',{ config:{ autoDisable:{ enabled:true,recover:true } } });
    expect((await store.getCredentials(c.id,true)).map(key => key.id)).toEqual([automatic.id]);
    await store.recordAttempt(success(automatic.id));
    const meta = await store.listCredentialMeta(c.id); expect(meta.find(key => key.id === manual.id)?.enabled).toBe(false); expect(meta.find(key => key.id === automatic.id)?.enabled).toBe(true);
  });
  it('keeps cancellations in traces without evicting health samples or degrading channel statistics', async () => {
    const c = await newChannel(); const store = new Store(testEnv);
    await call('/api/settings','PATCH',{ window:2,samples:2 });
    let sequence = 0;
    const attempt = (result:AttemptRecord['result']): AttemptRecord => ({ id:crypto.randomUUID(),requestId:crypto.randomUUID(),channelId:c.id,channelName:c.name,credentialId:null,model:'test-model',stream:true,startedAt:new Date(Date.now()+sequence++).toISOString(),ttft:result === 'success' ? .1 : null,duration:1,status:result === 'success' ? 200 : 499,result,error:null,inputTokens:0,outputTokens:0,attempt:1 });
    await store.recordAttempt(attempt('success')); await store.recordAttempt(attempt('success'));
    const before = (await store.getChannel(c.id))!;
    for (let i=0;i<5;i++) await store.recordAttempt(attempt('cancelled'));
    const after = (await store.getChannel(c.id))!;
    expect(after.health).toEqual(before.health); expect(after.history).toEqual(before.history); expect(after.successRate).toBe(100); expect(after.ttft).toBe(before.ttft);
    expect(await store.getRecentAttempts(c.id,true,2)).toHaveLength(2);
    await store.recordAttempt(attempt('success')); expect((await store.getChannel(c.id))?.health.samples).toBe(2);
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM attempts WHERE channel_id=?').bind(c.id).first<{count:number}>())?.count).toBe(8);
  });
  it('uses the same completion/failover totals and valid latency samples on dashboard and analytics', async () => {
    const a = await newChannel('A'), b = await newChannel('B'); const store = new Store(testEnv);
    const log: GatewayLog = { id:crypto.randomUUID(),time:'00:00:00',createdAt:new Date().toISOString(),model:'test-model',channel:b.name,channelId:b.id,apiKeyId:null,stream:true,ttft:999,duration:3,tokens:0,status:502,result:'error',attempts:2,source:'api',traceId:null,error:null };
    await store.recordLog(log);
    for (const [i,c] of [a,b].entries()) await store.recordAttempt({ id:crypto.randomUUID(),requestId:log.id,channelId:c.id,channelName:c.name,credentialId:null,model:'test-model',stream:true,startedAt:new Date().toISOString(),ttft:null,duration:1,status:502,result:'error',error:null,inputTokens:1,outputTokens:0,attempt:i+1 });
    const dashboard = await store.dashboard('1h');
    expect(dashboard.totals).toEqual(dashboard.analytics?.totals); expect(dashboard.totals.failovers).toBe(1); expect(dashboard.totals.successRate).toBe(0);
    expect(dashboard.latency.every(point => point.primary === null && point.backup === null)).toBe(true);
  });
  it('does not let 32 ineligible disabled credentials starve a recoverable channel in Cron', async () => {
    const store = new Store(testEnv);
    const entries = Array.from({ length:33 },(_,i) => ({ channel:parseChannel({ name:`Recovery queue ${i}`,models:['test-model'],enabled:i%3 !== 0,archived:i%3 === 1,config:{ protocol:'mock',mock:{ delayMs:1 },autoDisable:{ enabled:true,recover:i === 32 } } },true),credentials:[{ label:`queue ${i}`,secret:`private-queue-secret-${i}` }] }));
    entries[32].channel.enabled = true; entries[32].channel.archived = false;
    await store.importChannels(entries);
    await testEnv.DB.prepare("UPDATE credentials SET enabled=0,reason='HTTP 401',disabled_at=?").bind(new Date(Date.now()-1000).toISOString()).run();
    await store.saveSettings({ ...await store.getSettings(),recovery:1,autoDisableRecover:false });
    const ctx = createExecutionContext(); await worker.scheduled({} as ScheduledController,testEnv,ctx); await waitOnExecutionContext(ctx);
    const eligible = await store.listCredentialMeta(entries[32].channel.id);
    expect(eligible[0].enabled).toBe(true);
    for (const entry of entries.slice(0,32)) expect((await store.listCredentialMeta(entry.channel.id))[0].enabled).toBe(false);
  });
});
