export const BBDEVLAB_EXHAUSTED_REASON = 'BBDevLab 额度耗尽';
export const BBDEVLAB_EXPIRED_REASON = 'BBDevLab Key 已到期';

/** Cached expiry is checked at use time so scheduling never waits for a refresh. */
export function credentialExpired(balance: { expiresAt?: string | null } | undefined, now = Date.now()): boolean {
  if (!balance?.expiresAt) return false;
  const expiry = Date.parse(balance.expiresAt);
  return Number.isFinite(expiry) && expiry <= now;
}

export function isBbCredentialRestriction(reason: string | null | undefined): boolean {
  return reason === BBDEVLAB_EXHAUSTED_REASON || reason === BBDEVLAB_EXPIRED_REASON;
}
