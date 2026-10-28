import type { GatewayBalance, GatewayChannel } from '../shared/types';
import { BBDEVLAB_EXHAUSTED_REASON, BBDEVLAB_EXPIRED_REASON, credentialExpired, isBbCredentialRestriction } from '../shared/credential-policy';
import type { Env } from './env';
import { accountBase } from './accounts';
import { decryptSecret } from './crypto';
import { readUpstreamJSON } from './upstream-http';

export { BBDEVLAB_EXHAUSTED_REASON, BBDEVLAB_EXPIRED_REASON } from '../shared/credential-policy';
export const BBDEVLAB_BALANCE_REFRESH_MS = 60000;
const BALANCE_ERROR = 'BBDevLab 余额查询失败，请检查 API Key 与接口连接';
const MAX_CONCURRENT_REFRESHES = 3;

type BalanceRow = {
  credential_id: string; balance: string | null; version: number; lease_until: number;
  secret: string; channel_data: string;
};
type DueRow = { credential_id: string; channel_data: string };
type SummaryRow = { enabled: number; reason: string | null; disabled_at: string | null; balance: string | null };

function decodeBalance(value: string | null): GatewayBalance | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as GatewayBalance;
    return parsed && ['pending', 'ok', 'error'].includes(parsed.status) && (parsed.amount === null || typeof parsed.amount === 'number' && Number.isFinite(parsed.amount)) ? parsed : null;
  } catch { return null; }
}

async function seedBalances(env: Env, channelId: string | null = null, credentialId: string | null = null, force = false): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO credential_balances(credential_id) SELECT k.id FROM credentials k JOIN channels c ON c.id=k.channel_id WHERE json_extract(c.data,'$.config.integration')='bbdevlab' AND (?=1 OR json_extract(c.data,'$.enabled')=1) AND COALESCE(json_extract(c.data,'$.archived'),0)=0 AND (? IS NULL OR k.channel_id=?) AND (? IS NULL OR k.id=?)").bind(force ? 1 : 0,channelId,channelId,credentialId,credentialId).run();
}

function parseExpiry(data: Record<string, unknown>, old: GatewayBalance | null): string | null {
  // Omitted fields are not evidence that a previously known expiry was removed.
  if (!Object.prototype.hasOwnProperty.call(data,'expires_at')) return old?.expiresAt ?? null;
  const raw = data.expires_at;
  if (raw === null) return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') throw new Error(BALANCE_ERROR);
  const value = typeof raw === 'string' ? raw.trim() : raw;
  if (typeof value === 'string' && !/^-?\d+$/.test(value)) throw new Error(BALANCE_ERROR);
  const seconds = Number(value);
  if (seconds === 0 || seconds === -1) return null;
  // Keep the Unix-seconds contract explicit. Modern millisecond timestamps can
  // fit inside JavaScript's Date range when misread as seconds, so reject dates
  // beyond the interoperable four-digit ISO year range as well.
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 253402300799) throw new Error(BALANCE_ERROR);
  const expiry = new Date(seconds * 1000);
  if (!Number.isFinite(expiry.getTime())) throw new Error(BALANCE_ERROR);
  return expiry.toISOString();
}

function nextRefreshAt(now: number, expiresAt: string | null | undefined): number {
  const expiry = expiresAt ? Date.parse(expiresAt) : NaN;
  return Number.isFinite(expiry) && expiry > now ? Math.min(now + BBDEVLAB_BALANCE_REFRESH_MS,expiry) : now + BBDEVLAB_BALANCE_REFRESH_MS;
}

async function fetchCredentialBalance(channel: GatewayChannel, secret: string, dev: boolean, old: GatewayBalance | null): Promise<{ amount:number; expiresAt:string|null }> {
  const response = await fetch(accountBase(channel,dev) + '/api/usage/token/', {
    method:'GET', redirect:'manual', signal:AbortSignal.timeout(20000),
    headers:{ Accept:'application/json',Authorization:`Bearer ${secret}` },
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(BALANCE_ERROR); }
  const payload = await readUpstreamJSON(response,512 * 1024);
  const raw: unknown = payload.data?.total_available;
  if (payload.code !== true || !['number','string'].includes(typeof raw)) throw new Error(BALANCE_ERROR);
  const value = typeof raw === 'string' ? raw.trim() : raw;
  if (typeof value === 'string' && (!value || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))) throw new Error(BALANCE_ERROR);
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw new Error(BALANCE_ERROR);
  // BBDevLab uses 100000 quota units per balance unit. Tiny positive quotas must
  // remain positive: rounding them to integers would disable usable API keys.
  return { amount:amount / 100000,expiresAt:parseExpiry(payload.data,old) };
}

async function refreshSeededCredentialBalance(env: Env, channelId: string, credentialId: string, dev: boolean, force: boolean): Promise<void> {
  const now = Date.now(), lease = now + 45000;
  // Claim the current ciphertext and destination together; never combine a new
  // credential with the stale channel snapshot supplied by a caller.
  const claimed = await env.DB.prepare("UPDATE credential_balances SET lease_until=? WHERE credential_id=? AND lease_until<=? AND (?=1 OR next_refresh_at<=?) AND EXISTS (SELECT 1 FROM credentials k JOIN channels c ON c.id=k.channel_id WHERE k.id=credential_balances.credential_id AND k.channel_id=? AND (?=1 OR k.enabled=1 OR k.reason IN (?,?) OR (k.reason LIKE 'HTTP %' AND k.disabled_at IS NOT NULL)) AND (?=1 OR json_extract(c.data,'$.enabled')=1) AND COALESCE(json_extract(c.data,'$.archived'),0)=0 AND json_extract(c.data,'$.config.integration')='bbdevlab') RETURNING *, (SELECT secret FROM credentials WHERE id=credential_balances.credential_id) AS secret, (SELECT c.data FROM channels c JOIN credentials k ON k.channel_id=c.id WHERE k.id=credential_balances.credential_id) AS channel_data").bind(lease,credentialId,now,force ? 1 : 0,now,channelId,force ? 1 : 0,BBDEVLAB_EXHAUSTED_REASON,BBDEVLAB_EXPIRED_REASON,force ? 1 : 0).first<BalanceRow>();
  if (!claimed) return;
  const old = decodeBalance(claimed.balance);
  const currentChannel = JSON.parse(claimed.channel_data) as GatewayChannel;
  const endpoint = currentChannel.endpoint;
  // A replacement, endpoint edit, changed integration or newer lease invalidates
  // this response. The same predicate guards both statements in one transaction.
  const valid = "EXISTS (SELECT 1 FROM credential_balances b JOIN credentials k ON k.id=b.credential_id JOIN channels c ON c.id=k.channel_id WHERE b.credential_id=? AND b.version=? AND b.lease_until=? AND k.channel_id=? AND k.secret=? AND json_extract(c.data,'$.endpoint')=? AND json_extract(c.data,'$.config.integration')='bbdevlab' AND (?=1 OR json_extract(c.data,'$.enabled')=1) AND COALESCE(json_extract(c.data,'$.archived'),0)=0)";
  const guard = [credentialId,claimed.version,lease,channelId,claimed.secret,endpoint,force ? 1 : 0];
  let fetched: { amount:number; expiresAt:string|null };
  const restrict = (reason: string) => env.DB.prepare("UPDATE credentials SET enabled=0,reason=?,disabled_at=NULL,failure_count=0,recovery_count=0 WHERE id=? AND (enabled=1 OR reason IN (?,?) OR (reason LIKE 'HTTP %' AND disabled_at IS NOT NULL)) AND " + valid).bind(reason,credentialId,BBDEVLAB_EXHAUSTED_REASON,BBDEVLAB_EXPIRED_REASON,...guard);
  try { fetched = await fetchCredentialBalance(currentChannel,await decryptSecret(claimed.secret,env),dev,old); }
  catch {
    // Provider bodies and thrown errors may contain secrets. Persist only a
    // fixed local message, retaining the last successful amount and expiry. A
    // failed query cannot extend a Key's already confirmed validity period.
    const checked = Date.now();
    const balance: GatewayBalance = { status:'error',amount:old?.amount ?? null,expiresAt:old?.expiresAt ?? null,unit:old?.unit ?? '余额',updatedAt:old?.updatedAt ?? null,checkedAt:new Date(checked).toISOString(),error:BALANCE_ERROR };
    await env.DB.batch([
      ...(credentialExpired(balance,checked) ? [restrict(BBDEVLAB_EXPIRED_REASON)] : []),
      env.DB.prepare('UPDATE credential_balances SET balance=?,next_refresh_at=?,lease_until=0 WHERE credential_id=? AND ' + valid).bind(JSON.stringify(balance),nextRefreshAt(checked,balance.expiresAt),credentialId,...guard),
    ]);
    return;
  }
  const checked = Date.now(), checkedAt = new Date(checked).toISOString();
  const balance: GatewayBalance = { status:'ok',...fetched,unit:'余额',updatedAt:checkedAt,checkedAt };
  // Expiry takes priority over quota. These automatic restrictions supersede
  // HTTP cooldowns; a manual disable has no reason and remains untouched.
  const restriction = credentialExpired(balance,checked) ? BBDEVLAB_EXPIRED_REASON : fetched.amount <= 0 ? BBDEVLAB_EXHAUSTED_REASON : null;
  const state = restriction
    ? restrict(restriction)
    : env.DB.prepare('UPDATE credentials SET enabled=1,reason=NULL,disabled_at=NULL,failure_count=0,recovery_count=0 WHERE id=? AND enabled=0 AND reason IN (?,?) AND ' + valid).bind(credentialId,BBDEVLAB_EXHAUSTED_REASON,BBDEVLAB_EXPIRED_REASON,...guard);
  await env.DB.batch([
    state,
    env.DB.prepare('UPDATE credential_balances SET balance=?,next_refresh_at=?,lease_until=0 WHERE credential_id=? AND ' + valid).bind(JSON.stringify(balance),nextRefreshAt(checked,balance.expiresAt),credentialId,...guard),
  ]);
}

export async function refreshCredentialBalance(env: Env, channel: GatewayChannel, credentialId: string, dev: boolean, force = false): Promise<void> {
  await seedBalances(env,channel.id,credentialId,force);
  await refreshSeededCredentialBalance(env,channel.id,credentialId,dev,force);
}

export async function refreshChannelCredentialBalances(env: Env, channel: GatewayChannel, dev: boolean, force = true, limit = 40): Promise<void> {
  await seedBalances(env,channel.id,null,force);
  const boundedLimit = Number.isFinite(limit) ? Math.min(40,Math.max(0,Math.floor(limit))) : 40;
  const now = Date.now();
  const rows = await env.DB.prepare("SELECT b.credential_id FROM credential_balances b JOIN credentials k ON k.id=b.credential_id WHERE k.channel_id=? AND b.lease_until<=? AND (?=1 OR b.next_refresh_at<=?) AND (?=1 OR k.enabled=1 OR k.reason IN (?,?) OR (k.reason LIKE 'HTTP %' AND k.disabled_at IS NOT NULL)) ORDER BY b.next_refresh_at,k.created_at,k.id LIMIT ?").bind(channel.id,now,force ? 1 : 0,now,force ? 1 : 0,BBDEVLAB_EXHAUSTED_REASON,BBDEVLAB_EXPIRED_REASON,boundedLimit).all<{ credential_id:string }>();
  for (let i = 0; i < rows.results.length; i += MAX_CONCURRENT_REFRESHES) {
    const results = await Promise.allSettled(rows.results.slice(i,i + MAX_CONCURRENT_REFRESHES).map(row => refreshSeededCredentialBalance(env,channel.id,row.credential_id,dev,force)));
    // A manual refresh must report storage failures to the API caller. Cron
    // isolates a failed key so the remaining pool can continue to refresh.
    if (force) for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}

export async function refreshDueCredentialBalances(env: Env, dev: boolean, limit = 20): Promise<void> {
  await seedBalances(env);
  const boundedLimit = Number.isFinite(limit) ? Math.min(20,Math.max(0,Math.floor(limit))) : 20;
  const now = Date.now();
  const rows = await env.DB.prepare("SELECT b.credential_id,c.data AS channel_data FROM credential_balances b JOIN credentials k ON k.id=b.credential_id JOIN channels c ON c.id=k.channel_id WHERE b.next_refresh_at<=? AND b.lease_until<=? AND (k.enabled=1 OR k.reason IN (?,?) OR (k.reason LIKE 'HTTP %' AND k.disabled_at IS NOT NULL)) AND json_extract(c.data,'$.enabled')=1 AND COALESCE(json_extract(c.data,'$.archived'),0)=0 AND json_extract(c.data,'$.config.integration')='bbdevlab' ORDER BY b.next_refresh_at,k.created_at,k.id LIMIT ?").bind(now,now,BBDEVLAB_EXHAUSTED_REASON,BBDEVLAB_EXPIRED_REASON,boundedLimit).all<DueRow>();
  for (let i = 0; i < rows.results.length; i += MAX_CONCURRENT_REFRESHES) {
    await Promise.allSettled(rows.results.slice(i,i + MAX_CONCURRENT_REFRESHES).map(row => {
      const channel = JSON.parse(row.channel_data) as GatewayChannel;
      return refreshSeededCredentialBalance(env,channel.id,row.credential_id,dev,false);
    }));
  }
}

// Add base-ten representations before converting back to Number so common
// fractions such as 0.1 + 0.2 display 0.3, without losing tiny positive balances.
function sumAmounts(amounts: number[]): number {
  const parts = amounts.map(value => {
    const [mantissa,exponent = '0'] = String(value).toLowerCase().split('e');
    const fraction = mantissa.split('.')[1]?.length ?? 0;
    let units = BigInt(mantissa.replace('.','')), scale = fraction - Number(exponent);
    if (scale < 0) { units *= 10n ** BigInt(-scale); scale = 0; }
    return { units,scale };
  });
  const scale = Math.max(0,...parts.map(part => part.scale));
  const total = parts.reduce((sum,part) => sum + part.units * 10n ** BigInt(scale - part.scale),0n);
  return Number(`${total}e-${scale}`);
}

export async function channelCredentialBalance(env: Env, channelId: string): Promise<GatewayBalance> {
  const rows = await env.DB.prepare('SELECT k.enabled,k.reason,k.disabled_at,b.balance FROM credentials k LEFT JOIN credential_balances b ON b.credential_id=k.id WHERE k.channel_id=? ORDER BY k.created_at,k.id').bind(channelId).all<SummaryRow>();
  // Manually disabled Keys remain inspectable individually, but their cached
  // balances and missing checks do not describe the monitored routing pool.
  const now = Date.now();
  const expired = (row: SummaryRow) => row.reason === BBDEVLAB_EXPIRED_REASON || credentialExpired(decodeBalance(row.balance) ?? undefined,now);
  const monitored = rows.results.filter(row => !!row.enabled || isBbCredentialRestriction(row.reason) || row.reason?.startsWith('HTTP ') && row.disabled_at !== null);
  const balances = monitored.map(row => decodeBalance(row.balance));
  const known = balances.filter((balance): balance is GatewayBalance => !!balance && balance.amount !== null);
  const usable = monitored.filter(row => !expired(row)).map(row => decodeBalance(row.balance)).filter((balance): balance is GatewayBalance => !!balance && balance.amount !== null);
  const hasError = balances.some(balance => balance?.status === 'error');
  const pending = !rows.results.length || balances.some(balance => !balance || balance.status === 'pending');
  const dates = (field:'updatedAt'|'checkedAt') => balances.map(balance => balance?.[field]).filter((date):date is string => typeof date === 'string' && !!date).sort();
  return {
    status:hasError ? 'error' : pending ? 'pending' : 'ok',
    // Quotas belong to individual Keys; one overdrawn Key cannot consume funds
    // held by another Key in the pool.
    amount:known.length ? sumAmounts(usable.map(balance => Math.max(0,balance.amount!))) : monitored.length || !rows.results.length ? null : 0,
    unit:'余额',updatedAt:dates('updatedAt').at(-1) ?? null,checkedAt:dates('checkedAt').at(-1) ?? null,
    ...(hasError ? { error:'部分 API Key 余额查询失败，保留上次余额' } : {}),
    keyCount:rows.results.length,availableKeys:rows.results.filter(row => !!row.enabled && !expired(row)).length,
    exhaustedKeys:rows.results.filter(row => row.reason === BBDEVLAB_EXHAUSTED_REASON && !expired(row)).length,
    expiredKeys:rows.results.filter(expired).length,
  };
}
