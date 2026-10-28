import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../worker/index';
import { Store } from '../worker/store';
import { apiKey } from '../worker/validation';
import type { Env } from '../worker/env';
import type { AttemptRecord, GatewayChannel } from '../shared/types';

const testEnv = env as unknown as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
async function call(path: string, authenticated = true, origin = 'http://127.0.0.1:8787') {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('http://127.0.0.1:8787' + path, { method:'POST',headers:{ origin,...(authenticated ? { authorization:'Bearer '+testEnv.ADMIN_TOKEN } : {}) } }),testEnv,ctx);
  const json = await response.json() as { channel:GatewayChannel }; await waitOnExecutionContext(ctx);
  return { status:response.status,json };
}
async function createChannel(): Promise<GatewayChannel> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('http://127.0.0.1:8787/api/channels',{ method:'POST',headers:{ authorization:'Bearer '+testEnv.ADMIN_TOKEN,'content-type':'application/json' },body:JSON.stringify({ name:'Health management',models:['test-model'],config:{ protocol:'mock' } }) }),testEnv,ctx);
  const json = await response.json() as { channel:GatewayChannel }; await waitOnExecutionContext(ctx);
  expect(response.status).toBe(201); return json.channel;
}
function attempt(c: GatewayChannel, stream: boolean, startedAt: string, failed = false): AttemptRecord {
  return { id:crypto.randomUUID(),requestId:crypto.randomUUID(),channelId:c.id,channelName:c.name,credentialId:null,model:'test-model',stream,startedAt,ttft:stream ? 5 : null,duration:5,status:failed ? 401 : 200,result:failed ? 'error' : 'slow',error:null,inputTokens:1,outputTokens:1,attempt:1 };
}
const healthy = { averageTtft:null,averageDuration:null,samples:0,cooldownUntil:null,recoveryCount:0,failureCount:0,reason:null,autoDisabled:false };

beforeAll(async () => { await applyD1Migrations(testEnv.DB,testEnv.TEST_MIGRATIONS); });
beforeEach(async () => {
  await testEnv.DB.batch(['credentials','channels','profile_usage','api_keys','attempts','request_logs','events','tags','settings','gateway_state'].map(table => testEnv.DB.prepare('DELETE FROM '+table)));
});

describe('manual channel health reset', () => {
  it('requires administrator authentication and same-origin access', async () => {
    const c = await createChannel();
    expect((await call(`/api/channels/${c.id}/reset-health`,false)).status).toBe(401);
    expect((await call(`/api/channels/${c.id}/reset-health`,true,'https://foreign.example')).status).toBe(403);
    expect((await call('/api/channels/missing/reset-health')).status).toBe(404);
  });

  it('releases health isolation while preserving manual activation, archives, credentials and request history', async () => {
    const c = await createChannel(), store = new Store(testEnv);
    const old = new Date(Date.now()-2000).toISOString();
    await store.recordAttempt(attempt(c,true,old)); await store.recordAttempt(attempt(c,false,old));
    await store.saveChannel({ ...(await store.getChannel(c.id))!,enabled:false,archived:true,name:'Keep this edit' });
    const manual = await store.addCredential(c.id,'Manual disable','manual-private-key');
    const automatic = await store.addCredential(c.id,'Automatic disable','automatic-private-key');
    await store.setCredentialHealth(manual.id,{ enabled:false,failureCount:0,reason:null,disabledAt:null });
    await store.setCredentialHealth(automatic.id,{ enabled:false,failureCount:3,reason:'HTTP 401',disabledAt:new Date(Date.now()+60000).toISOString() });
    await store.updateHealth(c.id,{ autoDisabled:true,cooldownUntil:new Date(Date.now()+60000).toISOString(),reason:'连续 3 次首字延迟均超过 1s',recoveryCount:1,failureCount:3 },'offline');
    await testEnv.DB.prepare('INSERT INTO gateway_state(id,value) VALUES(?,?)').bind('auto-disable:'+c.id,'3').run();
    const before = (await store.getChannel(c.id))!;
    const credentials = (await testEnv.DB.prepare('SELECT * FROM credentials ORDER BY id').all()).results;
    const result = await call(`/api/channels/${c.id}/reset-health`);
    expect(result.status).toBe(200); expect(result.json.channel).toEqual({ ...before,status:'healthy',health:healthy });
    expect((await testEnv.DB.prepare('SELECT * FROM credentials ORDER BY id').all()).results).toEqual(credentials);
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM attempts WHERE channel_id=?').bind(c.id).first<{count:number}>())?.count).toBe(2);
    expect(await store.getRecentAttempts(c.id,true,100)).toEqual([]); expect(await store.getRecentAttempts(c.id,false,100)).toEqual([]);
    expect(await testEnv.DB.prepare('SELECT value FROM gateway_state WHERE id=?').bind('auto-disable:'+c.id).first()).toBeNull();
    expect((await store.listEvents()).some(event => event.channelId === c.id && event.type === 'recovery')).toBe(true);
  });

  it('discards both old sample windows and late completions while continuing fresh health checks', async () => {
    const c = await createChannel(), store = new Store(testEnv);
    await store.saveSettings({ ...await store.getSettings(),threshold:1,responseThreshold:1,window:3,samples:3,cooldown:600 });
    const started = Date.now()-10000;
    for (const stream of [true,false]) for (let i=0;i<3;i++) await store.recordAttempt(attempt(c,stream,new Date(started+i).toISOString()));
    expect((await store.getChannel(c.id))?.status).toBe('degraded');
    expect((await call(`/api/channels/${c.id}/reset-health`)).status).toBe(200);
    const reset = await testEnv.DB.prepare('SELECT value FROM gateway_state WHERE id=?').bind('health-reset:'+c.id).first<{value:string}>();
    await store.recordAttempt(attempt(c,true,new Date(started+500).toISOString(),true));
    await store.recordAttempt(attempt(c,false,reset!.value,true));
    expect((await store.getChannel(c.id))?.health).toEqual(healthy);
    let sequence = 1;
    for (const stream of [true,false]) {
      await store.recordAttempt(attempt(c,stream,new Date(Date.parse(reset!.value)+sequence++).toISOString()));
      expect((await store.getChannel(c.id))?.status).toBe('healthy');
      expect(await store.getRecentAttempts(c.id,stream,100)).toHaveLength(1);
    }
    for (let i=0;i<2;i++) await store.recordAttempt(attempt(c,true,new Date(Date.parse(reset!.value)+sequence++).toISOString()));
    const current = (await store.getChannel(c.id))!;
    expect(current.status).toBe('degraded'); expect(current.health.reason).toContain('连续 3 次'); expect(current.requests).toBe(12);
  });

  it('starts HTTP automatic-disable streaks again and ignores failures from requests started before reset', async () => {
    const c = await createChannel(), store = new Store(testEnv);
    await store.saveChannel({ ...c,config:{ ...c.config,autoDisable:{ enabled:true,target:'channel',statuses:[401],threshold:2,recover:true,cooldown:600 } } });
    await store.saveSettings({ ...await store.getSettings(),autoSwitch:false });
    const old = new Date(Date.now()-10000).toISOString();
    await store.recordAttempt(attempt(c,true,old,true)); await store.recordAttempt(attempt(c,true,old,true));
    expect((await store.getChannel(c.id))?.health.autoDisabled).toBe(true);
    await call(`/api/channels/${c.id}/reset-health`);
    const reset = await testEnv.DB.prepare('SELECT value FROM gateway_state WHERE id=?').bind('health-reset:'+c.id).first<{value:string}>();
    await store.recordAttempt(attempt(c,true,old,true));
    await store.recordAttempt(attempt(c,true,new Date(Date.parse(reset!.value)+1).toISOString(),true));
    const first = (await store.getChannel(c.id))!;
    expect(first.status).toBe('healthy'); expect(first.health.autoDisabled).toBe(false); expect(first.health.failureCount).toBe(1);
    await store.recordAttempt(attempt(c,true,new Date(Date.parse(reset!.value)+2).toISOString(),true));
    expect((await store.getChannel(c.id))?.health.autoDisabled).toBe(true);
  });

  it('routes real SSE requests back to the primary immediately after its cooldown is released', async () => {
    const primary = await createChannel(), backup = await createChannel(), store = new Store(testEnv);
    await store.saveChannel({ ...primary,name:'Slow primary',priority:0,config:{ ...primary.config,mock:{ ...primary.config.mock,scenario:'slow',delayMs:120 } } });
    await store.saveChannel({ ...backup,name:'Fast backup',priority:1,config:{ ...backup.config,mock:{ ...backup.config.mock,scenario:'healthy',delayMs:1 } } });
    await store.saveSettings({ ...await store.getSettings(),strategy:'failover',stickyMode:'off',autoSwitch:true,autoRecover:false,threshold:.06,window:2,samples:2,cooldown:600,streamFirstTokenTimeout:1,maxSameChannelRetries:0,maxChannelRetries:0 });
    const key = await store.createKey(apiKey({ name:'Health reset routing key' }));
    const requestSse = async () => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request('http://127.0.0.1:8787/v1/chat/completions',{ method:'POST',headers:{ authorization:'Bearer '+key.token,'content-type':'application/json' },body:JSON.stringify({ model:'test-model',messages:[{ role:'user',content:'Check recovered routing' }],stream:true,max_tokens:32 }) }),testEnv,ctx);
      const content = await response.text(); await waitOnExecutionContext(ctx);
      expect(response.status).toBe(200); expect(content).toContain('[DONE]');
      return response.headers.get('x-pulsegate-channel-id');
    };
    expect(await requestSse()).toBe(primary.id); expect(await requestSse()).toBe(primary.id);
    const degraded = (await store.getChannel(primary.id))!;
    expect(degraded.status).toBe('degraded'); expect(Date.parse(degraded.health.cooldownUntil!)).toBeGreaterThan(Date.now());
    expect(await requestSse()).toBe(backup.id);
    const released = await call(`/api/channels/${primary.id}/reset-health`);
    expect(released.status).toBe(200); expect(released.json.channel.status).toBe('healthy'); expect(released.json.channel.health.cooldownUntil).toBeNull();
    expect(await requestSse()).toBe(primary.id);
    const current = (await store.getChannel(primary.id))!;
    expect(current.status).toBe('healthy'); expect(current.health.samples).toBe(1); expect(current.requests).toBe(3);
    expect((await store.getChannel(backup.id))?.requests).toBe(1);
  });

  it('rolls back the health change when resetting a sampling window fails', async () => {
    const c = await createChannel(), store = new Store(testEnv);
    await store.updateHealth(c.id,{ reason:'Slow channel',cooldownUntil:new Date(Date.now()+60000).toISOString() },'degraded');
    const before = await store.getChannel(c.id);
    await testEnv.DB.exec("CREATE TRIGGER reject_health_reset BEFORE INSERT ON gateway_state WHEN NEW.id LIKE 'health-window:%' BEGIN SELECT RAISE(ABORT,'synthetic reset failure'); END");
    try {
      expect((await call(`/api/channels/${c.id}/reset-health`)).status).toBe(500);
      expect(await store.getChannel(c.id)).toEqual(before);
      expect((await testEnv.DB.prepare("SELECT * FROM gateway_state WHERE id LIKE 'health-%'").all()).results).toEqual([]);
    } finally { await testEnv.DB.exec('DROP TRIGGER reject_health_reset'); }
  });
});
