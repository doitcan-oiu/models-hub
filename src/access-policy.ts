import type { GatewayApiKey, GatewayChannel, KeyProfile } from '../shared/types';

/** Date-only expiry is inclusive through the end of the selected Beijing date. */
export function apiKeyExpired(key: Pick<GatewayApiKey, 'expires'>, now = Date.now()): boolean {
  if (['', '永不过期', 'never'].includes(key.expires)) return false;
  const expires = /^\d{4}-\d{2}-\d{2}$/.test(key.expires) ? `${key.expires}T23:59:59.999+08:00` : key.expires;
  return Date.parse(expires) <= now;
}

export function usableApiKey(key: Pick<GatewayApiKey, 'status' | 'expires'>, now = Date.now()): boolean {
  return key.status === 'active' && !apiKeyExpired(key, now);
}

/** Match the public model list: whitelist mapping targets, then expose their entry names. */
export function modelsForProfile(channels: GatewayChannel[], profile: KeyProfile, includeDisabled = false): string[] {
  const scoped = channels.filter(channel => {
    if (channel.archived || (!includeDisabled && !channel.enabled)) return false;
    if (profile.scope === 'channels') return profile.channelIds.includes(channel.id);
    if (profile.scope !== 'tags') return true;
    if (!profile.tags.length) return false;
    if (profile.match === 'all') return profile.tags.every(tag => channel.tags.includes(tag));
    if (profile.match === 'none') return !profile.tags.some(tag => channel.tags.includes(tag));
    return profile.tags.some(tag => channel.tags.includes(tag));
  });
  const available = new Set(scoped.flatMap(channel => [...channel.models, ...channel.config.aliases.map(alias => alias.from)]));
  const names = [...new Set([...available, ...profile.mappings.map(mapping => mapping.from)])];
  return names.filter(name => {
    const targets = profile.mappings.find(mapping => mapping.from === name)?.to ?? [name];
    return targets.some(target => available.has(target) && (profile.modelMode === 'all' || profile.models.includes(target)));
  });
}

/** The API accepts these legacy representations of an unlimited quota. Forms use an empty field. */
export function editableRequestLimit(value: string): string {
  const normalized = value.trim();
  return ['', '0', '无限制', 'unlimited'].includes(normalized) ? '' : normalized;
}

export function requestLimitLabel(value: string): string {
  const normalized = editableRequestLimit(value);
  if (!normalized) return '不限';
  const limit = Number(normalized);
  return Number.isSafeInteger(limit) && limit > 0 ? `${limit.toLocaleString('zh-CN')} 次` : '配置无效';
}
