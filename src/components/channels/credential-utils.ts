import type { CredentialMeta, CredentialUpdate } from '../../../shared/types';
import { BBDEVLAB_EXHAUSTED_REASON, BBDEVLAB_EXPIRED_REASON, credentialExpired } from '../../../shared/credential-policy';

export type CredentialDraft = { id: string; label: string; secret: string };

export type CredentialState = 'available' | 'expired' | 'exhausted' | 'disabled';

export function credentialState(key: CredentialMeta | undefined, now = Date.now()): CredentialState {
  if (!key || (!key.enabled && !key.reason)) return 'disabled';
  if (key.reason === BBDEVLAB_EXPIRED_REASON || credentialExpired(key.balance, now)) return 'expired';
  if (key.reason === BBDEVLAB_EXHAUSTED_REASON) return 'exhausted';
  return key.enabled ? 'available' : 'disabled';
}

export function credentialStatus(key: CredentialMeta | undefined, now = Date.now()): string {
  return { available: '可用', expired: '已到期', exhausted: '额度耗尽', disabled: '已停用' }[credentialState(key, now)];
}

/** Empty replacement fields preserve saved secrets; send only edited fields. */
export function credentialUpdates(drafts: CredentialDraft[], baseline: CredentialMeta[]): CredentialUpdate[] {
  const saved = new Map(baseline.map(key => [key.id, key]));
  const ids = new Set<string>();
  const updates: CredentialUpdate[] = [];
  for (const draft of drafts) {
    const original = saved.get(draft.id);
    if (!original || ids.has(draft.id)) throw new Error('密钥列表已变化，请重新打开渠道编辑器');
    ids.add(draft.id);
    const label = draft.label.trim(), secret = draft.secret.trim();
    const update: CredentialUpdate = { id: draft.id };
    if (label !== original.label) {
      if (!label || label.length > 128) throw new Error('密钥名称须为 1–128 个字符');
      update.label = label;
    }
    if (secret) {
      if (secret.length > 16000) throw new Error('API Key 最多 16,000 个字符');
      update.secret = secret;
    }
    if (update.label !== undefined || update.secret !== undefined) updates.push(update);
  }
  if (updates.length > 100) throw new Error('每次最多修改 100 个密钥');
  return updates;
}

/** Deletions supersede edits, while keeping drafts intact for an undo. */
export function credentialChanges(drafts: CredentialDraft[], baseline: CredentialMeta[], deletedIds: string[] = []): { updates: CredentialUpdate[]; deletes: string[] } {
  if (deletedIds.length > 100) throw new Error('每次最多删除 100 个密钥');
  const saved = new Set(baseline.map(key => key.id));
  const deleted = new Set(deletedIds);
  if (deleted.size !== deletedIds.length || deletedIds.some(id => !saved.has(id))) throw new Error('密钥列表已变化，请重新打开渠道编辑器');
  return { updates: credentialUpdates(drafts.filter(draft => !deleted.has(draft.id)), baseline), deletes: [...deletedIds] };
}
