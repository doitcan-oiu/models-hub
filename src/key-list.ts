import type { GatewayApiKey, KeyProfile } from '../shared/types';
import { apiKeyExpired } from './access-policy';

export type ApiKeySort = 'newest' | 'oldest' | 'name' | 'used' | 'expiry';
export type ApiKeyListFilter = {
  query?: string | null;
  status?: 'all' | 'active' | 'disabled' | 'expired' | 'revoked';
  scope?: 'any' | KeyProfile['scope'];
  sort?: ApiKeySort;
};
export type KeyDeleteTarget = Pick<GatewayApiKey, 'id' | 'name' | 'preview'>;
const timestamp = (value: string, fallback = 0) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : fallback;
const expiryTime = (key: GatewayApiKey) => ['', 'never', '永不过期'].includes(key.expires) ? Infinity : timestamp(/^\d{4}-\d{2}-\d{2}$/.test(key.expires) ? `${key.expires}T23:59:59.999+08:00` : key.expires, Infinity);

export function filterApiKeys(keys: GatewayApiKey[], filter: ApiKeyListFilter, now = Date.now()): GatewayApiKey[] {
  const terms = (filter.query ?? '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return keys.filter(key => {
    const profile = key.profiles.find(item => item.id === key.activeProfile) ?? key.profiles[0];
    const state = key.status === 'active' && apiKeyExpired(key, now) ? 'expired' : key.status;
    if (filter.status && filter.status !== 'all' && state !== filter.status) return false;
    if (filter.scope && filter.scope !== 'any' && profile?.scope !== filter.scope) return false;
    const text = [key.name, key.note, key.preview, key.id, profile?.name ?? '', ...(profile?.tags ?? [])].join(' ').toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  }).sort((a, b) => {
    let order: number;
    if (filter.sort === 'name') order = a.name.localeCompare(b.name, 'zh-CN');
    else if (filter.sort === 'used') order = b.used - a.used;
    else if (filter.sort === 'oldest') order = timestamp(a.createdAt) - timestamp(b.createdAt);
    else if (filter.sort === 'expiry') {
      const left = expiryTime(a), right = expiryTime(b);
      order = left === right ? 0 : left < right ? -1 : 1;
    } else order = timestamp(b.createdAt) - timestamp(a.createdAt);
    return order || a.id.localeCompare(b.id);
  });
}

export function keyListPage(keys: GatewayApiKey[], requestedPage: number, requestedSize: number) {
  const size = [20, 50, 100].includes(requestedSize) ? requestedSize : 20;
  const pageCount = Math.max(1, Math.ceil(keys.length / size));
  const page = Math.min(pageCount, Math.max(1, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1));
  return { items: keys.slice((page - 1) * size, page * size), page, pageCount };
}

/** Capture exact deletion targets so later filters and refreshes cannot retarget a confirmation. */
export function keyDeleteTargets(keys: GatewayApiKey[], ids: string[]): KeyDeleteTarget[] {
  if (!ids.length || ids.length > 200 || new Set(ids).size !== ids.length) throw new Error('请选择 1–200 个不同的 API Key');
  const byId = new Map(keys.map(key => [key.id, key]));
  return ids.map(id => {
    const key = byId.get(id);
    if (!key) throw new Error('密钥列表已变化，请重新选择');
    return Object.freeze({ id: key.id, name: key.name, preview: key.preview });
  });
}
