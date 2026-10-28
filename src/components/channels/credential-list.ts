import type { CredentialMeta, GatewayBalance } from '../../../shared/types';
import { credentialState, type CredentialDraft, type CredentialState } from './credential-utils';

export type CredentialFilter = 'all' | CredentialState | 'modified' | 'deleted';
export type CredentialSort = 'created' | 'name' | 'expiry' | 'balance';

export function credentialChanged(key: CredentialMeta, draft?: CredentialDraft): boolean {
  return !!draft && (draft.label !== key.label || !!draft.secret.trim());
}

/** Filtering never trims or mutates the full set of editable drafts. */
export function credentialList(keys: CredentialMeta[], options: { query?: string; filter?: CredentialFilter; sort?: CredentialSort; drafts?: CredentialDraft[]; deletedIds?: string[]; hideNames?: boolean; now?: number } = {}): CredentialMeta[] {
  const drafts = new Map((options.drafts ?? []).map(draft => [draft.id, draft]));
  const deleted = new Set(options.deletedIds ?? []);
  const query = (options.query ?? '').trim().toLocaleLowerCase();
  const filter = options.filter ?? 'all', now = options.now ?? Date.now();
  const filtered = keys.filter(key => {
    const draft = drafts.get(key.id);
    if (query && !`${options.hideNames ? '' : draft?.label ?? key.label} ${key.preview} ${key.reason ?? ''}`.toLocaleLowerCase().includes(query)) return false;
    if (filter === 'all') return true;
    if (filter === 'deleted') return deleted.has(key.id);
    return !deleted.has(key.id) && (filter === 'modified' ? credentialChanged(key, draft) : credentialState(key, now) === filter);
  });
  if (!options.sort || options.sort === 'created') return filtered;
  return filtered.sort((left, right) => {
    if (options.sort === 'name') return (drafts.get(left.id)?.label ?? left.label).localeCompare(drafts.get(right.id)?.label ?? right.label, 'zh-CN');
    if (options.sort === 'expiry') {
      const expiry = (key: CredentialMeta) => { const value = Date.parse(key.balance?.expiresAt ?? ''); return Number.isFinite(value) ? value : Infinity; };
      return expiry(left) - expiry(right) || left.label.localeCompare(right.label, 'zh-CN');
    }
    return (left.balance?.amount ?? Infinity) - (right.balance?.amount ?? Infinity) || left.label.localeCompare(right.label, 'zh-CN');
  });
}

export function credentialPage<T>(items: T[], requestedPage: number, requestedSize: number): { items: T[]; page: number; pageCount: number; start: number; end: number } {
  const size = Number.isFinite(requestedSize) && requestedSize > 0 ? Math.max(1, Math.floor(requestedSize)) : 20;
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const page = Math.min(pageCount, Math.max(1, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1));
  const start = (page - 1) * size;
  return { items: items.slice(start, start + size), page, pageCount, start: items.length ? start + 1 : 0, end: Math.min(items.length, start + size) };
}

export function credentialExpiryText(balance: GatewayBalance | undefined, now = Date.now()): string {
  if (balance?.expiresAt === null) return '无到期限制';
  const expiry = Date.parse(balance?.expiresAt ?? '');
  if (!Number.isFinite(expiry)) return '到期时间待查询';
  const remaining = expiry - now;
  if (remaining <= 0) return '已到期 · 不再调度';
  if (remaining < 60_000) return '不足 1 分钟后到期';
  if (remaining < 3_600_000) return `${Math.ceil(remaining / 60_000)} 分钟后到期`;
  if (remaining < 86_400_000) return `${Math.ceil(remaining / 3_600_000)} 小时后到期`;
  return `${Math.ceil(remaining / 86_400_000)} 天后到期`;
}
