import { defaultChannelConfig, defaultSettings } from '../shared/types';
import type { GatewayApiKey, GatewayChannel, GatewaySettings, KeyProfile, ChannelConfig } from '../shared/types';

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export const assert = (condition: unknown, message: string): void => { if (!condition) throw new HttpError(400, message); };
export function object(value: unknown): Record<string, unknown> { assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected a JSON object'); return value as Record<string, unknown>; }
export function text(value: unknown, fallback = '', max = 2000): string { assert(value === undefined || typeof value === 'string', 'Expected text'); const result = value === undefined ? fallback : value as string; assert(result.length <= max, `Text exceeds ${max} characters`); return result; }
export function number(value: unknown, fallback: number, min = 0, max = 1000000): number { assert(value === undefined || typeof value === 'number', 'Expected a number'); const n = value === undefined ? fallback : value as number; assert(Number.isFinite(n) && n >= min && n <= max, `Number must be ${min}–${max}`); return n; }
export function bool(value: unknown, fallback: boolean): boolean { assert(value === undefined || typeof value === 'boolean', 'Expected a boolean'); return value === undefined ? fallback : value as boolean; }
export function strings(value: unknown, fallback: string[] = [], max = 1000): string[] { if (value === undefined) return fallback; assert(Array.isArray(value) && value.length <= max && value.every(v => typeof v === 'string' && v.length <= 256 && v.trim()), 'Expected a bounded string array'); return [...new Set((value as string[]).map(v => v.trim()))]; }
export function oneOf<T extends string>(value: unknown, choices: readonly T[], fallback: T): T { if (value === undefined) return fallback; assert(choices.includes(value as T), 'Invalid option'); return value as T; }
export function url(value: unknown, dev: boolean, fallback = '', optional = false): string {
  const result = text(value, fallback, 2048).trim(); if (optional && !result) return '';
  let parsed: URL; try { parsed = new URL(result); } catch { throw new HttpError(400, 'Endpoint must be an absolute URL'); }
  assert(!parsed.username && !parsed.password && !parsed.search && !parsed.hash, 'Endpoint cannot contain credentials, query strings or fragments');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  assert(parsed.protocol === 'https:' || (dev && local && parsed.protocol === 'http:'), 'Upstream endpoints must use HTTPS');
  assert(dev || !local, 'Loopback endpoints are development only');
  return result.replace(/\/$/, '');
}
function channelWebsite(value: unknown, fallback = ''): string {
  const result = text(value, fallback, 2048).trim();
  if (!result) return '';
  assert(/^https?:\/\//i.test(result) && !/[\\\x00-\x20\x7f]/.test(result), '官网须为有效的绝对 HTTP/HTTPS 地址');
  let parsed: URL;
  try { parsed = new URL(result); } catch { throw new HttpError(400, '官网须为有效的绝对 HTTP/HTTPS 地址'); }
  const authority = result.slice(result.indexOf('://') + 3).split(/[/?#]/, 1)[0];
  assert(['http:', 'https:'].includes(parsed.protocol) && parsed.hostname && authority, '官网须为有效的绝对 HTTP/HTTPS 地址');
  assert(!parsed.username && !parsed.password && !authority.includes('@'), '官网地址不能包含登录凭据');
  return result;
}
function pairArray(value: unknown, fallback: { from: string; to: string }[]): { from: string; to: string }[] { if (value === undefined) return fallback; assert(Array.isArray(value) && value.length <= 1000, 'Invalid model aliases'); return (value as unknown[]).map(v => { const p = object(v); const from = text(p.from); const to = text(p.to); assert(from && to, 'Alias names cannot be empty'); return { from, to }; }); }
function statuses(value: unknown, fallback: number[]): number[] { if (value === undefined) return fallback; assert(Array.isArray(value) && value.length <= 100 && value.every(n => Number.isInteger(n) && n >= 400 && n <= 599), 'HTTP statuses must be 400–599'); return [...new Set(value as number[])]; }
export function config(input: unknown, dev: boolean, previous = defaultChannelConfig): ChannelConfig {
  const b = input === undefined ? {} : object(input);
  const rate = b.rateLimit === undefined ? previous.rateLimit : object(b.rateLimit);
  const convert = b.conversions === undefined ? previous.conversions : object(b.conversions);
  const endpoints: Record<string,unknown> = b.endpoints === undefined ? previous.endpoints : object(b.endpoints);
  const ad = b.autoDisable === undefined ? previous.autoDisable : object(b.autoDisable);
  const previousCooldown = { ...defaultChannelConfig.cooldown, ...previous.cooldown };
  const cooldown = b.cooldown === undefined ? previousCooldown : object(b.cooldown);
  const mock = b.mock === undefined ? previous.mock : object(b.mock);
  const headers = b.headers === undefined ? previous.headers : object(b.headers);
  assert(Object.keys(headers).length <= 30, 'Too many upstream headers');
  const validHeaders = new Headers();
  for (const [k, v] of Object.entries(headers)) {
    assert(typeof v === 'string' && v.length <= 2048 && !/[\r\n]/.test(k + v), 'Invalid header');
    assert(!/(authorization|api[-_]?key|token|secret|password|cookie|host|content-length|connection|transfer-encoding)/i.test(k) && !/Bearer\s|(?:sk-|AIza|pg_live_)[A-Za-z0-9_-]{12,}/i.test(String(v)), 'Sensitive headers must use encrypted credential management');
    try { validHeaders.set(k, v as string); } catch { throw new HttpError(400, 'Invalid upstream header name or value'); }
  }
  const overrides = b.bodyOverrides === undefined ? previous.bodyOverrides : object(b.bodyOverrides);
  assert(JSON.stringify(overrides).length <= 32000, 'Body overrides too large');
  function hasSecret(value: unknown): boolean { if (typeof value === 'string') return /Bearer\s|(?:sk-|AIza|pg_live_)[A-Za-z0-9_-]{12,}/i.test(value); if (Array.isArray(value)) return value.some(hasSecret); if (value && typeof value === 'object') return Object.entries(value).some(([k,v]) => /^(?:api[-_]?key|access[-_]?token|token|secret|password|authorization)$/i.test(k) || hasSecret(v)); return false; }
  assert(!hasSecret(overrides), 'Credentials cannot be stored in body overrides');
  const protectedBody = new Set(['model', 'stream', 'messages', 'contents', 'system', 'systemInstruction']);
  assert(!Object.keys(overrides).some(key => protectedBody.has(key)), 'Gateway-managed request fields cannot be overridden');
  const protocol = oneOf(b.protocol, ['openai', 'anthropic', 'gemini', 'mock'] as const, previous.protocol);
  assert(dev || protocol !== 'mock', 'Mock channels are only available in local development');
  const slug = text(b.customProviderSlug,previous.customProviderSlug,128); assert(!slug || /^[a-zA-Z0-9_-]+$/.test(slug),'Invalid custom provider slug');
  const prices = b.prices === undefined ? previous.prices : (assert(Array.isArray(b.prices) && b.prices.length <= 1000, 'Invalid model prices'), (b.prices as unknown[]).map(v => { const p = object(v); return { model: text(p.model), input: number(p.input, 0), output: number(p.output, 0) }; }));
  const parsedEndpoints = Object.fromEntries(Object.entries(previous.endpoints).map(([k, v]) => { const path = text(endpoints[k], v, 1024); assert(path.startsWith('/') && !path.startsWith('//') && !/[?#\r\n]/.test(path), 'Endpoint overrides must be relative paths'); return [k, path]; })) as ChannelConfig['endpoints'];
  return { protocol, integration: oneOf(b.integration, ['native', 'newapi', 'sub2api', 'bbdevlab'] as const, previous.integration ?? 'native'), gatewayMode: oneOf(b.gatewayMode, ['direct', 'ai-gateway'] as const, previous.gatewayMode), customProviderSlug: slug, aliases: pairArray(b.aliases, previous.aliases), prices, headers: headers as Record<string,string>, bodyOverrides: overrides, relayUrl: url(b.relayUrl, dev, previous.relayUrl, true), conversions: { stripUnsupported: bool(convert.stripUnsupported, previous.conversions.stripUnsupported), systemToUser: bool(convert.systemToUser, previous.conversions.systemToUser) }, rateLimit: { requestsPerMinute: Math.floor(number(rate.requestsPerMinute, previous.rateLimit.requestsPerMinute)), tokensPerMinute: Math.floor(number(rate.tokensPerMinute, previous.rateLimit.tokensPerMinute, 0, 1e9)) }, endpoints: parsedEndpoints, cooldown: { firstToken: bool(cooldown.firstToken, previousCooldown.firstToken), error: bool(cooldown.error, previousCooldown.error) }, autoDisable: { enabled: bool(ad.enabled, previous.autoDisable.enabled), target: oneOf(ad.target, ['key', 'channel'] as const, previous.autoDisable.target), statuses: statuses(ad.statuses, previous.autoDisable.statuses), threshold: Math.floor(number(ad.threshold, previous.autoDisable.threshold, 1, 100)), recover: bool(ad.recover, previous.autoDisable.recover), cooldown: number(ad.cooldown, previous.autoDisable.cooldown, 1, 86400) }, mock: { scenario: oneOf(mock.scenario, ['healthy', 'slow', 'error', 'empty', 'disconnect', 'transient'] as const, previous.mock.scenario), delayMs: number(mock.delayMs, previous.mock.delayMs, 0, 600000), status: Math.floor(number(mock.status, previous.mock.status, 400, 599)), failuresBeforeSuccess: Math.floor(number(mock.failuresBeforeSuccess, previous.mock.failuresBeforeSuccess, 0, 100)) } };
}
export function channel(input: unknown, dev: boolean, previous?: GatewayChannel): GatewayChannel {
  const b = object(input); const now = new Date().toISOString();
  const c: GatewayChannel = previous ?? { id: crypto.randomUUID(), name: '', provider: 'OpenAI', model: '', models: [], tags: [], weight: 1, priority: 0, endpoint: '', status: 'healthy', ttft: 0, successRate: 0, requests: 0, enabled: true, color: '#003c33', history: [], createdAt: now, archived: false, credentialCount: 0, config: structuredClone(defaultChannelConfig), health: { averageTtft: null, averageDuration: null, samples: 0, cooldownUntil: null, recoveryCount: 0, failureCount: 0, reason: null, autoDisabled: false } };
  const models = strings(b.models, c.models); const model = text(b.model, models[0] ?? c.model, 256); if (model && !models.includes(model)) models.unshift(model);
  const name = text(b.name, c.name, 256).trim(); assert(name, 'Channel name is required');
  const cfg = config(b.config, dev, c.config);
  const endpoint = cfg.protocol === 'mock' && (b.endpoint === undefined || b.endpoint === '') ? 'http://127.0.0.1/mock' : url(b.endpoint, dev, c.endpoint);
  assert(models.length, 'At least one model is required');
  const archived = bool(b.archived,c.archived);
  return { ...c, name, provider: text(b.provider, c.provider, 128), model, models, tags: strings(b.tags, c.tags, 100), endpoint, website: channelWebsite(b.website, c.website ?? ''), displayMultiplier: number(b.displayMultiplier, c.displayMultiplier ?? 1), weight: number(b.weight, c.weight, 0, 10000), priority: Math.floor(number(b.priority, c.priority, -10000, 10000)), enabled: archived ? false : bool(b.enabled, c.enabled), archived, config: cfg };
}
export function profile(input: unknown): KeyProfile {
  const b = object(input); const scope = oneOf(b.scope, ['all', 'tags', 'channels'] as const, 'all');
  const tags = strings(b.tags, [], 100); const channelIds = strings(b.channelIds, [], 1000);
  const limit = text(b.requestLimit, '无限制', 30); assert(['无限制', 'unlimited', '', '0'].includes(limit) || /^\d+$/.test(limit) && Number.isSafeInteger(Number(limit)), 'Request quota must be a nonnegative integer');
  const mappings = b.mappings === undefined ? [] : (assert(Array.isArray(b.mappings) && b.mappings.length <= 1000, 'Invalid model mappings'), (b.mappings as unknown[]).map(v => { const p = object(v); return { from: text(p.from, '', 256), to: strings(p.to) }; }));
  const modelMode = oneOf(b.modelMode, ['all', 'selected'] as const, 'all'); const models = strings(b.models);
  assert(scope !== 'tags' || tags.length, 'Tag restriction requires selected tags'); assert(scope !== 'channels' || channelIds.length, 'Channel restriction requires selected channels'); assert(modelMode !== 'selected' || models.length, 'Model restriction requires selected models');
  return { id: text(b.id, crypto.randomUUID(), 128), name: text(b.name, '默认配置', 128), scope, tags, match: oneOf(b.match, ['any', 'all', 'none'] as const, 'any'), channelIds, modelMode, models, requestLimit: limit, mappings };
}
export function apiKey(input: unknown, previous?: GatewayApiKey): GatewayApiKey {
  const b = object(input); const profiles = b.profiles === undefined ? previous?.profiles ?? [profile({})] : (assert(Array.isArray(b.profiles) && b.profiles.length > 0 && b.profiles.length <= 50, 'API Key requires 1–50 profiles'), (b.profiles as unknown[]).map(profile));
  assert(new Set(profiles.map(p => p.id)).size === profiles.length, 'Profile IDs must be unique');
  const activeProfile = text(b.activeProfile, previous?.activeProfile ?? profiles[0].id, 128); assert(profiles.some(p => p.id === activeProfile), 'Active profile does not exist');
  const expires = text(b.expires, previous?.expires ?? '永不过期', 128); assert(['永不过期', 'never', ''].includes(expires) || Number.isFinite(Date.parse(expires)), 'Invalid expiry date');
  const status = oneOf(b.status, ['active', 'disabled'] as const, previous?.status === 'disabled' ? 'disabled' : 'active'); assert(previous?.status !== 'revoked', 'Revoked keys cannot be updated');
  const name = text(b.name, previous?.name ?? '', 256).trim(); assert(name, 'API Key name is required');
  return { id: previous?.id ?? crypto.randomUUID(), name, preview: previous?.preview ?? '', createdAt: previous?.createdAt ?? new Date().toISOString(), expires, note: text(b.note, previous?.note ?? '', 4000), used: previous?.used ?? 0, activeProfile, profiles, status };
}
export function settings(input: unknown, previous = defaultSettings): GatewaySettings {
  const b = object(input); const result = { ...previous };
  const boolKeys = ['aiGatewayEnabled', 'retryEnabled', 'emptyResponseDetection', 'autoSwitch', 'autoRecover', 'autoDisableEnabled', 'autoDisableRecover', 'notifications'] as const;
  boolKeys.forEach(k => { result[k] = bool(b[k], previous[k]); });
  const ranges: Partial<Record<keyof GatewaySettings, [number, number]>> = { maxChannelRetries: [0,10], maxSameChannelRetries: [0,5], retryDelayMs: [100,10000], streamFirstTokenTimeout: [0,600], nonStreamTimeout: [0,600], threshold: [.001,600], responseThreshold: [.001,600], window: [1,1000], windowSeconds: [0,86400], samples: [1,1000], cooldown: [1,86400], recovery: [1,100], autoDisableThreshold: [1,100], autoDisableCooldown: [1,86400], logRetentionDays: [1,3650] };
  for (const [key, range] of Object.entries(ranges)) { const k = key as keyof GatewaySettings; (result as unknown as Record<string,unknown>)[k] = number(b[k], previous[k] as number, range![0], range![1]); }
  for (const k of ['maxChannelRetries','maxSameChannelRetries','retryDelayMs','window','windowSeconds','samples','recovery','autoDisableThreshold','logRetentionDays'] as const) assert(Number.isInteger(result[k]),`${k} must be an integer`);
  assert(result.samples <= result.window, 'Minimum samples cannot exceed the sliding window');
  for (const k of ['account', 'gateway', 'customErrorMessage'] as const) result[k] = text(b[k], previous[k], k === 'customErrorMessage' ? 2000 : 128);
  assert(!result.account || /^[a-zA-Z0-9_-]+$/.test(result.account), 'Invalid Cloudflare account ID'); assert(!result.gateway || /^[a-zA-Z0-9_-]+$/.test(result.gateway), 'Invalid AI Gateway ID');
  result.errorMode = oneOf(b.errorMode, ['raw', 'generic', 'custom'] as const, previous.errorMode); result.strategy = oneOf(b.strategy, ['failover','adaptive','round-robin','weighted','circuit-breaker'] as const, previous.strategy); result.stickyMode = oneOf(b.stickyMode, ['prefer','off'] as const, previous.stickyMode); result.autoDisableTarget = oneOf(b.autoDisableTarget, ['key','channel'] as const, previous.autoDisableTarget); result.retryStatuses = statuses(b.retryStatuses, previous.retryStatuses); result.autoDisableStatuses = statuses(b.autoDisableStatuses, previous.autoDisableStatuses);
  return result;
}
