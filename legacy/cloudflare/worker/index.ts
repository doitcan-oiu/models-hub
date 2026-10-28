import type { Env, GatewayContext, KeyRecord } from './env';
import type { CredentialUpdate, GatewayApiKey, GatewayChannel, GatewaySettings, KeyProfile } from '../shared/types';
import { Store, expired, publicKey } from './store';
import { hashToken, randomToken } from './crypto';
import { handleGateway, probeChannel } from './gateway';
import { HttpError, apiKey, assert, bool, channel, number, object, oneOf, settings, strings, text } from './validation';
import { assertAccountReuse, parseAccountCredentials, refreshAccountBalance, refreshDueAccounts } from './accounts';
import { discoverModels } from './model-discovery';
import { credentialRecoveryAllowed } from './health';
import { refreshChannelCredentialBalances, refreshDueCredentialBalances } from './credential-balances';
import { anthropicErrorResponse, handleAnthropicMessages } from './anthropic-ingress';
export { GatewayState } from './state';

function loopback(request: Request): boolean { return ['127.0.0.1','localhost','[::1]'].includes(new URL(request.url).hostname); }
export function development(request: Request, env: Env): boolean { return env.DEV_MODE === 'true' && loopback(request); }
const bearer = (request: Request): string | null => /^Bearer[ \t]+([^\s,]+)$/i.exec(request.headers.get('authorization')?.trim() ?? '')?.[1] ?? null;
function cookieToken(request: Request): string | null { return request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith('pg_session='))?.slice(11) ?? null; }
function sameOrigin(request: Request, env: Env): void {
  const origin = request.headers.get('origin'); if (!origin) { if (cookieToken(request) && !bearer(request)) throw new HttpError(403,'Origin header required'); return; }
  let parsed: URL; try { parsed = new URL(origin); } catch { throw new HttpError(403,'Invalid Origin'); }
  if (parsed.origin === new URL(request.url).origin) return;
  if (development(request,env) && ['localhost','127.0.0.1','[::1]'].includes(parsed.hostname) && ['http:','https:'].includes(parsed.protocol)) return;
  throw new HttpError(403,'Cross-origin mutation denied');
}
async function authenticated(request: Request, env: Env): Promise<boolean> {
  const token = bearer(request);
  if (token && env.ADMIN_TOKEN && await hashToken(token) === await hashToken(env.ADMIN_TOKEN)) return true;
  const cookie = cookieToken(request); if (!cookie) return false;
  const row = await env.DB.prepare('SELECT auth_hash FROM admin_sessions WHERE hash=? AND expires_at>?').bind(await hashToken(cookie),Date.now()).first<{ auth_hash: string }>();
  if (!row) return false;
  return row.auth_hash === (development(request,env) ? 'dev' : env.ADMIN_TOKEN ? await hashToken(env.ADMIN_TOKEN) : 'unconfigured');
}
async function body(request: Request, limit = 1024*1024): Promise<Record<string,unknown>> {
  const length = Number(request.headers.get('content-length') ?? 0); if (length > limit) throw new HttpError(413,'Request body too large');
  if (!request.body) return {};
  const reader = request.body.getReader(); const parts: Uint8Array[] = []; let bytes = 0;
  while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > limit) { await reader.cancel(); throw new HttpError(413,'Request body too large'); } parts.push(chunk.value); }
  const data = new Uint8Array(bytes); let offset = 0; for (const part of parts) { data.set(part,offset); offset += part.byteLength; }
  if (!bytes) return {};
  try { return object(JSON.parse(new TextDecoder().decode(data))); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400,'Invalid JSON'); }
}
function response(data: unknown, status = 200, extra: Record<string,string> = {}): Response { return Response.json(data,{ status,headers: { 'cache-control':'no-store', 'x-content-type-options':'nosniff',...extra } }); }
function noContent(): Response { return new Response(null,{ status:204 }); }
async function needChannel(store: Store, id: string): Promise<GatewayChannel> { const found = await store.getChannel(id); if (!found) throw new HttpError(404,'Channel not found'); return found; }
async function needKey(store: Store, id: string): Promise<KeyRecord> { const found = await store.getKey(id); if (!found) throw new HttpError(404,'API Key not found'); return found; }
async function authorizeApi(request: Request, store: Store, allowApiKeyHeader = false): Promise<KeyRecord> { const token = bearer(request) ?? (allowApiKeyHeader ? request.headers.get('x-api-key')?.trim() : null); const key = token && token.startsWith('pg_live_') ? await store.findKey(token) : null; if (!key || key.status !== 'active' || expired(key)) throw new HttpError(401,'Invalid, disabled or expired API key'); return key; }
function currentProfile(key: GatewayApiKey): KeyProfile { const profile = key.profiles.find(p => p.id === key.activeProfile); if (!profile) throw new HttpError(403,'Active profile is unavailable'); return profile; }
function allowedChannel(c: GatewayChannel,p: KeyProfile): boolean { if (!c.enabled || c.archived) return false; if (p.scope === 'channels') return p.channelIds.includes(c.id); if (p.scope === 'tags') { if (p.match === 'none') return !p.tags.some(t => c.tags.includes(t)); return p.match === 'all' ? p.tags.every(t => c.tags.includes(t)) : p.tags.some(t => c.tags.includes(t)); } return true; }
function modelsFor(channels: GatewayChannel[],p: KeyProfile): string[] {
  const physical = new Set(channels.filter(c => allowedChannel(c,p)).flatMap(c => [...c.models,...c.config.aliases.map(a => a.from)]));
  const names = [...new Set([...physical,...p.mappings.map(m => m.from)])];
  return names.filter(name => { const targets = p.mappings.find(m => m.from === name)?.to ?? [name]; return targets.some(t => physical.has(t) && (p.modelMode === 'all' || p.models.includes(t))); });
}
async function context(env: Env,ctx: ExecutionContext,store: Store,source: GatewayContext['source'],key: KeyRecord | null = null): Promise<GatewayContext> { return { env,ctx,settings:await store.getSettings(),channels:await store.listChannels(),key,profile:key ? currentProfile(key) : null,source }; }
type ImportedCredential = { label: string; secret: string };
function importedCredentials(b: Record<string,unknown>): ImportedCredential[] {
  if (b.apiKeys === undefined) return []; assert(Array.isArray(b.apiKeys) && b.apiKeys.length <= 100,'Upstream API keys must be a bounded array');
  return (b.apiKeys as unknown[]).map((v,i) => {
    const entry = typeof v === 'string' ? { secret:v } : object(v);
    const credential = { label:text(entry.label,`密钥 ${i+1}`,128),secret:text(entry.secret,'',16000) };
    assert(credential.secret.length > 0,'Upstream API keys cannot be empty');
    return credential;
  });
}
function editedCredentialText(value: unknown, max: number): string {
  assert(typeof value === 'string','Expected text');
  const normalized = (value as string).trim();
  assert(normalized.length > 0 && normalized.length <= max,`Credential text must be 1–${max} characters`);
  return normalized;
}
function credentialUpdates(b: Record<string,unknown>): CredentialUpdate[] {
  if (b.credentialUpdates === undefined) return [];
  assert(Array.isArray(b.credentialUpdates) && b.credentialUpdates.length <= 100,'Credential updates must be a bounded array');
  const updates = (b.credentialUpdates as unknown[]).map(value => {
    const entry = object(value), id = text(entry.id,'',128).trim();
    assert(id,'Credential ID is required');
    return { id, ...(entry.label !== undefined ? { label:editedCredentialText(entry.label,128) } : {}), ...(entry.secret !== undefined ? { secret:editedCredentialText(entry.secret,16000) } : {}) };
  });
  assert(new Set(updates.map(update => update.id)).size === updates.length,'Credential IDs must be unique');
  return updates;
}
function credentialDeletes(b: Record<string,unknown>): string[] {
  if (b.credentialDeletes === undefined) return [];
  assert(Array.isArray(b.credentialDeletes) && b.credentialDeletes.length <= 100,'Credential deletes must be a bounded array');
  const deletes = (b.credentialDeletes as unknown[]).map(value => {
    const id = text(value,'',128).trim();
    assert(id,'Credential ID is required');
    return id;
  });
  assert(new Set(deletes).size === deletes.length,'Credential IDs must be unique');
  return deletes;
}
async function createChannel(store: Store,b: Record<string,unknown>,dev: boolean,fixture = false): Promise<GatewayChannel> {
  assert(!credentialDeletes(b).length,'Cannot delete existing credentials when creating a channel');
  const c = channel(b,dev); const creds = importedCredentials(b);
  const account = parseAccountCredentials(b.accountCredentials);
  assertAccountReuse(c,null,account);
  await store.saveChannel(c,fixture,creds,account);
  return (await store.getChannel(c.id))!;
}
async function testChannel(request: Request,env: Env,ctx: ExecutionContext,store: Store,c: GatewayChannel,b: Record<string,unknown>,recover = false): Promise<Response> {
  const model = text(b.model,c.models[0],256); assert(c.models.includes(model) || c.config.aliases.some(a => a.from === model),'Model is unavailable on this channel');
  const gw = await context(env,ctx,store,'probe'); gw.forceChannelId = c.id;
  let result: Response;
  if (!recover && b.stream === true) result = await handleGateway(new Request(new URL('/v1/chat/completions',request.url),{ method:'POST',headers:{ 'content-type':'application/json' },body:JSON.stringify({ model,messages:[{ role:'user',content:'Reply with OK.' }],max_tokens:32,stream:true }) }),gw,store);
  else result = await probeChannel({ ...c,model,models:[model,...c.models.filter(m => m !== model)] },gw,store,{ stream:b.stream === undefined ? !c.health.reason?.includes('响应耗时') : bool(b.stream,true) });
  const content = await result.text(); const requestId = result.headers.get('x-pulsegate-request-id'); const detail = requestId ? await store.getLog(requestId) : null;
  const success = result.ok && (detail ? detail.log.result !== 'error' : !content.includes('"error"'));
  return response({ success,requestId,ttft:detail?.log.ttft ?? Number(result.headers.get('x-pulsegate-ttft-ms') ?? 0)/1000,duration:detail?.log.duration ?? 0,status:detail?.log.status ?? result.status,error:detail?.log.error ?? (success ? null : '上游测试失败，请查看请求日志'),attempts:detail?.attempts ?? [],channel:await store.getChannel(c.id) });
}
async function sessionRoute(request: Request,env: Env): Promise<Response> {
  const dev = development(request,env); const configured = !!env.ADMIN_TOKEN;
  if (request.method === 'GET') return response({ authenticated:await authenticated(request,env),devMode:dev,configured });
  if (request.method === 'DELETE') { sameOrigin(request,env); const cookie = cookieToken(request); if (cookie) await env.DB.prepare('DELETE FROM admin_sessions WHERE hash=?').bind(await hashToken(cookie)).run(); return response({ authenticated:false },200,{ 'set-cookie':'pg_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'+(new URL(request.url).protocol === 'https:' ? '; Secure' : '') }); }
  if (request.method !== 'POST') throw new HttpError(405,'Method not allowed');
  sameOrigin(request,env); const b = await body(request,32000); const token = text(b.token,'',16000);
  if (!(dev && b.dev === true) && !(configured && token && await hashToken(token) === await hashToken(env.ADMIN_TOKEN!))) throw new HttpError(401,'管理员令牌无效');
  const session = randomToken('pg_session_'); const lifetime = 12*3600;
  await env.DB.prepare('INSERT INTO admin_sessions(hash,expires_at,auth_hash) VALUES(?,?,?)').bind(await hashToken(session),Date.now()+lifetime*1000,dev && b.dev === true ? 'dev' : await hashToken(env.ADMIN_TOKEN!)).run();
  return response({ authenticated:true,devMode:dev,configured },200,{ 'set-cookie':`pg_session=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${lifetime}`+(new URL(request.url).protocol === 'https:' ? '; Secure' : '') });
}
async function admin(request: Request,env: Env,ctx: ExecutionContext,store: Store): Promise<Response> {
  if (!(await authenticated(request,env))) throw new HttpError(401,'请先登录管理控制台');
  if (!['GET','HEAD','OPTIONS'].includes(request.method)) sameOrigin(request,env);
  const path = new URL(request.url).pathname; const url = new URL(request.url); const method = request.method; const dev = development(request,env);
  if (path === '/api/bootstrap' && method === 'GET') return response({ channels:await store.listChannels(),keys:await store.listKeys(),settings:await store.getSettings(),tags:await store.listTags(),devMode:dev });
  if (path === '/api/settings') { if (method === 'GET') return response({ settings:await store.getSettings() }); if (method === 'PATCH') { const b = await body(request); const s = settings(b,await store.getSettings()); await store.saveSettings(s,text(b.aiGatewayToken,'',16000),bool(b.clearAiGatewayToken,false)); return response({ settings:await store.getSettings() }); } }
  if (path === '/api/channels') { if (method === 'GET') return response({ channels:await store.listChannels() }); if (method === 'POST') return response({ channel:await createChannel(store,await body(request),dev) },201); }
  if (path === '/api/channels/import' && method === 'POST') {
    const b = await body(request); assert(Array.isArray(b.channels) && b.channels.length > 0 && b.channels.length <= 200,'Import requires 1–200 channels');
    const entries = (b.channels as unknown[]).map(value => {
      const entry = object(value), c = channel(entry,dev), credentials = importedCredentials(entry), account = parseAccountCredentials(entry.accountCredentials);
      assertAccountReuse(c,null,account);
      return { channel:c, credentials, account };
    });
    return response({ channels:await store.importChannels(entries) },201);
  }
  if (path === '/api/channels/bulk' && method === 'POST') {
    const b = await body(request), ids = strings(b.ids,[],200); assert(ids.length,'Select at least one channel');
    const action = oneOf(b.action,['enable','disable','archive','restore','tags','weights'] as const,'enable'), all = await store.listChannels();
    const selected = ids.map(id => { const c = all.find(c => c.id === id); if (!c) throw new HttpError(404,'Selected channel not found'); return c; });
    const tags = strings(b.tags,[],100), mode = oneOf(b.mode,['add','replace','remove'] as const,'add');
    // Validate every resulting channel before writing any member of the selection.
    const changes = selected.map(channel => {
      const c = { ...channel,tags:[...channel.tags] };
      if (action === 'enable') c.enabled = true;
      else if (action === 'disable') c.enabled = false;
      else if (action === 'archive') { c.archived = true; c.enabled = false; }
      else if (action === 'restore') c.archived = false;
      else if (action === 'weights') c.weight = number(b.weight,1,0,10000);
      else c.tags = strings(mode === 'replace' ? tags : mode === 'remove' ? c.tags.filter(t => !tags.includes(t)) : [...c.tags,...tags],[],100);
      return c;
    });
    for (const c of changes) await store.saveChannel(c);
    return response({ channels:await store.listChannels() });
  }
  if (path === '/api/channels/discover-models' && method === 'POST') {
    const b = await body(request);
    const existing = b.channelId ? await needChannel(store,text(b.channelId,'',128)) : undefined;
    const draft = channel({ name:existing?.name ?? '模型发现', models:existing?.models ?? ['__discovery__'], endpoint:b.endpoint ?? existing?.endpoint, config:b.config ?? { protocol:b.protocol } },dev,existing);
    const provided = text(b.apiKey,'',16000).trim();
    const secret = provided || (existing ? (await store.getCredentials(existing.id))[0]?.secret : '') || '';
    return response(await discoverModels(draft,await store.getSettings(),secret,await store.getAiGatewayToken(),request.signal));
  }
  const channelMatch = path.match(/^\/api\/channels\/([^/]+)(?:\/(.*))?$/);
  if (channelMatch) {
    const c = await needChannel(store,decodeURIComponent(channelMatch[1])); const tail = channelMatch[2];
    if (!tail) {
      if (method === 'GET') return response({ channel:c });
      if (method === 'PATCH') {
        const b = await body(request); const changed = channel(b,dev,c);
        const account = parseAccountCredentials(b.accountCredentials);
        assertAccountReuse(changed,c,account);
        await store.saveChannel(changed,false,importedCredentials(b),account,credentialUpdates(b),credentialDeletes(b));
        return response({ channel:await store.getChannel(c.id) });
      }
      if (method === 'DELETE') { await store.deleteChannel(c.id); return noContent(); }
    }
    if (tail === 'clone' && method === 'POST') { const clone = { ...structuredClone(c),id:crypto.randomUUID(),name:c.name+' · 副本',enabled:false,credentialCount:0,hasAccountCredentials:false,accountAuthMode:undefined,accountIntegration:undefined,accountBalance:undefined,createdAt:new Date().toISOString(),requests:0,ttft:0,successRate:0,history:[],health:{ averageTtft:null,averageDuration:null,samples:0,autoDisabled:false,cooldownUntil:null,recoveryCount:0,failureCount:0,reason:null },status:'healthy' as const }; await store.saveChannel(clone); return response({ channel:clone },201); }
    if (tail === 'test' && method === 'POST') return testChannel(request,env,ctx,store,c,await body(request));
    if (tail === 'balance' && method === 'POST') { assert(['newapi','sub2api','bbdevlab'].includes(c.config.integration ?? ''), '请先开启上游余额监控'); if (c.config.integration === 'bbdevlab') await refreshChannelCredentialBalances(env,c,dev,true); else await refreshAccountBalance(env,c,dev,true); return response({ channel:await store.getChannel(c.id) }); }
    if (tail === 'recover' && method === 'POST') return testChannel(request,env,ctx,store,c,{},true);
    if (tail === 'reset-health' && method === 'POST') { await store.resetChannelHealth(c.id); return response({ channel:await store.getChannel(c.id) }); }
    if (tail === 'tests' && method === 'GET') return response(await store.listLogs({ channelId:c.id,source:'probe',limit:50 }));
    if (tail === 'credentials') { if (method === 'GET') return response({ credentials:await store.listCredentialMeta(c.id) }); if (method === 'POST') { const b = await body(request); return response({ credential:await store.addCredential(c.id,text(b.label,'密钥',128),text(b.secret,'',16000)) },201); } }
    const credMatch = tail?.match(/^credentials\/([^/]+)$/); if (credMatch) { const id = decodeURIComponent(credMatch[1]); if (method === 'PATCH') { const b = await body(request); return response({ credential:await store.changeCredential(c.id,id,{ ...(b.label !== undefined ? { label:editedCredentialText(b.label,128) } : {}),...(b.enabled !== undefined ? { enabled:bool(b.enabled,true) } : {}),...(b.secret !== undefined ? { secret:editedCredentialText(b.secret,16000) } : {}) }) }); } if (method === 'DELETE') { await store.deleteCredential(c.id,id); return noContent(); } }
  }
  if (path === '/api/keys') { if (method === 'GET') return response({ keys:await store.listKeys() }); if (method === 'POST') return response(await store.createKey(apiKey(await body(request))),201); }
  if (path === '/api/keys/bulk' && method === 'POST') {
    const b = await body(request), action = b.action;
    if (action !== 'enable' && action !== 'disable' && action !== 'delete') throw new HttpError(400, 'Invalid API Key bulk action');
    assert(Array.isArray(b.ids), 'Select 1–200 valid API Key IDs');
    await store.bulkKeys(b.ids as string[],action);
    return response({ keys:await store.listKeys() });
  }
  const keyMatch = path.match(/^\/api\/keys\/([^/]+)(?:\/(rotate))?$/);
  if (keyMatch) { const key = await needKey(store,decodeURIComponent(keyMatch[1])); if (keyMatch[2] === 'rotate' && method === 'POST') { if (key.status === 'revoked') throw new HttpError(409,'Revoked keys cannot be rotated'); return response(await store.rotateKey(publicKey(key))); } if (!keyMatch[2]) { if (method === 'PATCH') { const changed = apiKey(await body(request),publicKey(key)); await store.saveKey(changed); return response({ key:changed }); } if (method === 'DELETE') { await store.deleteKey(key.id); return noContent(); } } }
  if (path === '/api/tags') { if (method === 'GET') return response({ tags:await store.listTags() }); if (method === 'POST') { const b = await body(request); const name = text(b.name,'',256).trim(); assert(name,'Tag name is required'); await store.addTag(name); return response({ tags:await store.listTags() },201); } }
  const tagMatch = path.match(/^\/api\/tags\/([^/]+)$/); if (tagMatch) { const name = decodeURIComponent(tagMatch[1]); if (method === 'PATCH') { const b = await body(request); const next = text(b.name,'',256).trim(); assert(next,'Tag name is required'); await store.renameTag(name,next); return response({ tags:await store.listTags() }); } if (method === 'DELETE') { await store.deleteTag(name); return response({ tags:await store.listTags() }); } }
  if (path === '/api/logs' && method === 'GET') return response(await store.listLogs({ limit:Math.floor(number(Number(url.searchParams.get('limit') ?? 50),50,1,200)),offset:Math.floor(number(Number(url.searchParams.get('offset') ?? 0),0,0,1e7)),q:url.searchParams.get('q')?.slice(0,256),result:url.searchParams.get('result') ?? undefined,channelId:url.searchParams.get('channelId') ?? undefined }));
  if (path === '/api/logs' && method === 'DELETE') { await store.clearLogs(); return response({ cleared:true }); }
  const logMatch = path.match(/^\/api\/logs\/([^/]+)$/); if (logMatch && method === 'GET') { const detail = await store.getLog(decodeURIComponent(logMatch[1])); if (!detail) throw new HttpError(404,'Request log not found'); return response(detail); }
  if (path === '/api/dashboard' && method === 'GET') return response(await store.dashboard(oneOf(url.searchParams.get('range') ?? undefined,['1h','24h','7d'] as const,'24h')));
  if (path === '/api/events' && method === 'GET') return response({ events:await store.listEvents() });
  if (path === '/api/playground/chat' && method === 'POST') { const b = await body(request,4*1024*1024); const mode = oneOf(b.mode,['channel','gateway'] as const,'gateway'); const key = b.keyId ? await needKey(store,text(b.keyId)) : null; if (key && (key.status !== 'active' || expired(key))) throw new HttpError(403,'Selected API Key is unavailable'); const gw = await context(env,ctx,store,'playground',mode === 'gateway' ? key : null); gw.relayProtocol = 'openai'; if (mode === 'channel') gw.forceChannelId = (await needChannel(store,text(b.channelId))).id; const input = object(b.request); return handleGateway(new Request(new URL('/v1/chat/completions',request.url),{ method:'POST',headers:{ 'content-type':'application/json',...(request.headers.get('x-trace-id') ? { 'x-trace-id':request.headers.get('x-trace-id')! } : {}),...(request.headers.get('x-thread-id') ? { 'x-thread-id':request.headers.get('x-thread-id')! } : {}) },body:JSON.stringify(input),signal:request.signal }),gw,store); }
  if (path === '/api/dev/fixtures') {
    if (!dev) throw new HttpError(404,'Not found');
    if (method === 'DELETE') { await store.clearFixtures(); return response({ channels:await store.listChannels() }); }
    if (method === 'POST') { await store.clearFixtures(); const channels = []; for (const [name,priority] of [['本地测试 · 主渠道',0],['本地测试 · 备用渠道',1]] as const) channels.push(await createChannel(store,{ name,provider:'Local Mock',models:['mock-model'],tags:['本地测试'],priority,config:{ protocol:'mock' },endpoint:'http://127.0.0.1/mock' },true,true)); return response({ channels },201); }
  }
  throw new HttpError(404,'API endpoint not found');
}
async function recoverDueChannels(env: Env,ctx: ExecutionContext,store: Store,s: GatewaySettings,channels: GatewayChannel[]): Promise<void> {
  const due = channels.filter(c => c.enabled && !c.archived && c.health.cooldownUntil && Date.parse(c.health.cooldownUntil) <= Date.now() && (c.health.autoDisabled ? (c.config.autoDisable.enabled ? c.config.autoDisable.recover : s.autoDisableRecover) : s.autoRecover));
  const disabled = (await env.DB.prepare("SELECT k.channel_id,k.id,k.reason,k.disabled_at FROM credentials k JOIN channels c ON c.id=k.channel_id LEFT JOIN gateway_state p ON p.id='probe-credential:'||k.id WHERE k.enabled=0 AND k.reason IS NOT NULL AND k.disabled_at<=? AND json_extract(c.data,'$.enabled')=1 AND COALESCE(json_extract(c.data,'$.archived'),0)=0 AND CASE WHEN json_extract(c.data,'$.config.autoDisable.enabled')=1 THEN json_extract(c.data,'$.config.autoDisable.recover') ELSE ? END=1 ORDER BY CAST(COALESCE(p.value,'0') AS INTEGER) LIMIT 32").bind(new Date().toISOString(),s.autoDisableRecover ? 1 : 0).all<{ channel_id:string;id:string;reason:string;disabled_at:string }>()).results;
  const eligibleDisabled = disabled.filter(d => { const c = channels.find(c => c.id === d.channel_id); return c && c.enabled && !c.archived && credentialRecoveryAllowed(c,s,{ enabled:false,reason:d.reason,disabledAt:d.disabled_at }); });
  const seen = new Set(due.map(c => c.id)); for (const d of eligibleDisabled) { const c = channels.find(c => c.id === d.channel_id)!; if (!seen.has(c.id)) { due.push(c); seen.add(c.id); } }
  const probes = (await env.DB.prepare('SELECT id,value FROM gateway_state WHERE id LIKE \'probe-channel:%\'').all<{ id:string;value:string }>()).results; const lastProbe = new Map(probes.map(p => [p.id.slice(14),Number(p.value)]));
  due.sort((a,b) => (lastProbe.get(a.id) ?? 0)-(lastProbe.get(b.id) ?? 0));
  for (const c of due.slice(0,8)) { const d = eligibleDisabled.find(d => d.channel_id === c.id); try { const gw: GatewayContext = { env,ctx,settings:c.health.autoDisabled ? { ...s,autoRecover:true } : s,channels,key:null,profile:null,source:'probe',forceChannelId:c.id }; if (d) gw.forceCredentialId = d.id; const result = await probeChannel(c,gw,store,{ stream:!c.health.reason?.includes('响应耗时'),credentialId:d?.id }); await result.text(); } catch { /* Failed probes remain unhealthy. The fair cursor prevents permanently bad channels starving other probes. */ } finally { const statements = [env.DB.prepare('INSERT INTO gateway_state(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').bind('probe-channel:'+c.id,String(Date.now()))]; if (d) statements.push(env.DB.prepare('INSERT INTO gateway_state(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').bind('probe-credential:'+d.id,String(Date.now()))); await env.DB.batch(statements); } }
}
export default {
  async fetch(request: Request,env: Env,ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (path === '/api/session') return await sessionRoute(request,env);
      if (path === '/health' && request.method === 'GET') { const readiness = await env.DB.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE type=\'table\' AND name IN (\'channels\',\'settings\',\'channel_accounts\',\'credential_balances\')').first<{ count:number }>(); return response({ status:readiness?.count === 4 ? 'ok' : 'migrations_required',service:'pulsegate' },readiness?.count === 4 ? 200 : 503); }
      const store = new Store(env);
      if (path.startsWith('/api/')) return await admin(request,env,ctx,store);
      if (path === '/v1/models' && request.method === 'GET') { const key = await authorizeApi(request,store,true); const models = modelsFor(await store.listChannels(),currentProfile(key)); return response({ object:'list',data:models.map(id => ({ id,object:'model',created:0,owned_by:'pulsegate' })) }); }
      if (path.startsWith('/v1/') && request.method === 'POST') {
        const messages = path === '/v1/messages';
        const key = await authorizeApi(request,store,messages);
        const gateway = await context(env,ctx,store,'api',key);
        if (messages) return await handleAnthropicMessages(request,undefined,gateway,store);
        return await handleGateway(request,{ ...gateway,relayProtocol:'openai' },store);
      }
      if (path.startsWith('/v1/')) throw new HttpError(404,'API endpoint not found');
      return await env.ASSETS.fetch(request);
    } catch (error) { if (path === '/v1/messages') return anthropicErrorResponse(error instanceof HttpError ? error.status : 500,error instanceof HttpError ? error.message : 'Gateway operation failed; check server configuration'); if (error instanceof HttpError) return response({ error:{ message:error.message,type:'gateway_error' } },error.status); return response({ error:{ message:'Gateway operation failed; check server configuration',type:'gateway_error' } },500); }
  },
  async scheduled(_controller: ScheduledController,env: Env,ctx: ExecutionContext): Promise<void> {
    const store = new Store(env);
    const settings = store.getSettings();
    const channels = store.listChannels();
    // Balance monitoring must run even if health recovery or log cleanup fails.
    const jobs = await Promise.allSettled([
      // With a Key pool, reserve 20 balance checks, 3 account refreshes (up to
      // 7 fetches each), and 8 health probes within the 50 subrequest budget.
      channels.then(items => refreshDueAccounts(env,items,env.DEV_MODE === 'true',items.some(item => item.config.integration === 'bbdevlab') ? 3 : 5)),
      refreshDueCredentialBalances(env,env.DEV_MODE === 'true'),
      Promise.all([settings,channels]).then(([config,items]) => recoverDueChannels(env,ctx,store,config,items)),
      settings.then(config => store.cleanup(config.logRetentionDays)),
    ]);
    const failed = jobs.find(job => job.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  },
} satisfies ExportedHandler<Env>;
