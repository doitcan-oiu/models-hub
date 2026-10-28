import { defaultChannelConfig, defaultSettings } from '../shared/types';
import type { AccountIntegration, AttemptRecord, CredentialMeta, CredentialUpdate, DashboardData, GatewayApiKey, GatewayChannel, GatewayEvent, GatewayLog, GatewaySettings } from '../shared/types';
import type { Credential, Env, GatewayStore, KeyRecord } from './env';
import { decryptSecret, encryptSecret, hashToken, previewToken, randomToken, redact } from './crypto';
import { autoDisableDecision, cooldownExemptsHealth, credentialRecoveryAllowed, evaluateHealth } from './health';
import { HttpError } from './validation';
import { accountAuthMode, assertAccountCredentials, assertAccountReuse, prepareAccountSave, type AccountCredentials } from './accounts';
import { buildAnalytics, completed } from './analytics';
import { channelCredentialBalance } from './credential-balances';
import { BBDEVLAB_EXHAUSTED_REASON, BBDEVLAB_EXPIRED_REASON, credentialExpired, isBbCredentialRestriction } from '../shared/credential-policy';

type DataRow = { id: string; data: string; health_version?: number };
type CredRow = { id: string; channel_id: string; label: string; preview: string; secret: string; enabled: number; failure_count: number; recovery_count: number; disabled_at: string | null; reason: string | null; created_at: string };
type CredentialInput = { label: string; secret: string };
const decode = <T>(row: { data: string }): T => JSON.parse(row.data) as T;
function decodeChannel(row: { data: string }): GatewayChannel {
  const channel = decode<GatewayChannel>(row); channel.displayMultiplier ??= 1; channel.website ??= '';
  channel.config.cooldown = { ...defaultChannelConfig.cooldown, ...channel.config.cooldown };
  return channel;
}
const now = (): string => new Date().toISOString();
function validateCredential({ label,secret }: CredentialInput): void {
  if (!secret || secret.length > 16000) throw new HttpError(400, 'Credential must be 1–16000 characters');
  if (label.length > 128) throw new HttpError(400, 'Credential label exceeds 128 characters');
}
function normalizeCredentialUpdate(update: CredentialUpdate): CredentialUpdate {
  if (!update || typeof update !== 'object' || typeof update.id !== 'string' || !update.id.trim() || update.id.length > 128) throw new HttpError(400, 'Invalid credential ID');
  const normalized: CredentialUpdate = { id:update.id.trim() };
  if (update.label !== undefined) {
    if (typeof update.label !== 'string' || !update.label.trim() || update.label.trim().length > 128) throw new HttpError(400, 'Credential label must be 1–128 characters');
    normalized.label = update.label.trim();
  }
  if (update.secret !== undefined) {
    if (typeof update.secret !== 'string' || !update.secret.trim() || update.secret.trim().length > 16000) throw new HttpError(400, 'Credential must be 1–16000 characters');
    normalized.secret = update.secret.trim();
  }
  return normalized;
}
export class Store implements GatewayStore {
  constructor(public env: Env, private coordinate = true) {}
  private async coordinated<T>(operation: string, args: unknown): Promise<T> {
    const stub = this.env.GATEWAY_STATE.get(this.env.GATEWAY_STATE.idFromName('gateway'));
    const response = await stub.fetch('https://state.internal/' + operation, { method: 'POST', body: JSON.stringify(args) });
    const result = await response.json() as { result: T; error?: string };
    if (!response.ok) throw new Error(result.error ?? 'Gateway state unavailable'); return result.result;
  }
  async listChannels(): Promise<GatewayChannel[]> {
    const rows = await this.env.DB.prepare('SELECT c.data,a.channel_id AS account_id,a.balance, (SELECT COUNT(*) FROM credentials s WHERE s.channel_id=c.id) AS credential_count FROM channels c LEFT JOIN channel_accounts a ON a.channel_id=c.id ORDER BY json_extract(c.data,\'$.createdAt\') DESC').all<{ data: string; credential_count: number; account_id: string | null; balance: string | null }>();
    return Promise.all(rows.results.map(async row => {
      const channel = decodeChannel(row);
      return { ...channel, credentialCount: row.credential_count, hasAccountCredentials: !!row.account_id, accountBalance: channel.config.integration === 'bbdevlab' ? await channelCredentialBalance(this.env,channel.id) : row.balance ? JSON.parse(row.balance) : row.account_id ? { status:'pending' as const,amount:null,unit:'',updatedAt:null,checkedAt:null } : undefined };
    }));
  }
  async getChannel(id: string): Promise<GatewayChannel | null> {
    const row = await this.env.DB.prepare('SELECT data FROM channels WHERE id=?').bind(id).first<DataRow>();
    if (!row) return null; const channel = decodeChannel(row); channel.credentialCount = (await this.listCredentialMeta(id)).length;
    const account = await this.env.DB.prepare('SELECT balance FROM channel_accounts WHERE channel_id=?').bind(id).first<{ balance: string | null }>();
    channel.hasAccountCredentials = !!account;
    channel.accountBalance = channel.config.integration === 'bbdevlab' ? await channelCredentialBalance(this.env,id) : account?.balance ? JSON.parse(account.balance) : account ? { status:'pending',amount:null,unit:'',updatedAt:null,checkedAt:null } : undefined;
    return channel;
  }
  async saveChannel(channel: GatewayChannel, fixture = false, credentials: CredentialInput[] = [], account?: AccountCredentials, credentialUpdates: CredentialUpdate[] = [], credentialDeletes: string[] = []): Promise<void> {
    if (credentials.length > 100) throw new HttpError(400, 'Upstream API keys must be a bounded array');
    credentials.forEach(validateCredential);
    if (!Array.isArray(credentialUpdates) || credentialUpdates.length > 100) throw new HttpError(400, 'Credential updates must be a bounded array');
    const updates = credentialUpdates.map(normalizeCredentialUpdate);
    if (new Set(updates.map(update => update.id)).size !== updates.length) throw new HttpError(400, 'Credential IDs must be unique');
    if (!Array.isArray(credentialDeletes) || credentialDeletes.length > 100) throw new HttpError(400, 'Credential deletes must be a bounded array');
    const deletes = Array.from(credentialDeletes,id => {
      if (typeof id !== 'string' || !id.trim() || id.length > 128) throw new HttpError(400, 'Invalid credential ID');
      return id.trim();
    });
    if (new Set(deletes).size !== deletes.length) throw new HttpError(400, 'Credential IDs must be unique');
    const deletedIds = new Set(deletes);
    if (updates.some(update => deletedIds.has(update.id))) throw new HttpError(400, 'A credential cannot be updated and deleted together');
    if (updates.length || deletes.length) {
      const existing = new Set((await this.listCredentialMeta(channel.id)).map(credential => credential.id));
      if (updates.some(update => !existing.has(update.id)) || deletes.some(id => !existing.has(id))) throw new HttpError(404, 'Credential not found');
    }
    const stored = await this.env.DB.prepare('SELECT data,EXISTS(SELECT 1 FROM channel_accounts a WHERE a.channel_id=channels.id) AS has_account,(SELECT version FROM channel_accounts a WHERE a.channel_id=channels.id) AS account_version FROM channels WHERE id=?').bind(channel.id).first<{ data: string; has_account: number; account_version: number | null }>();
    const previous = stored ? { ...decode<GatewayChannel>(stored), hasAccountCredentials: !!stored.has_account } : null;
    if (previous && (previous.hasAccountCredentials || previous.config.integration !== channel.config.integration)) assertAccountReuse(channel, previous, account);
    // Validate and encrypt the complete edit before the single transaction.
    const prepared = await Promise.all(credentials.map(credential => this.prepareCredential(channel.id,credential)));
    const preparedUpdates = await Promise.all(updates.map(update => this.prepareCredentialUpdate(channel.id,update)));
    const accountStatement = await prepareAccountSave(this.env, channel, account);
    if (account) channel = { ...channel, accountAuthMode: accountAuthMode(account), accountIntegration: channel.config.integration as AccountIntegration };
    // Merge account metadata against the row inside the transaction. A newer account
    // must keep its backend and destination even if this edit passed an older check.
    const modeSource = account ? 'excluded' : 'channels';
    const savedIntegration = account ? "json_extract(excluded.data,'$.accountIntegration')" : "COALESCE(json_extract(channels.data,'$.accountIntegration'),CASE WHEN EXISTS(SELECT 1 FROM channel_accounts a WHERE a.channel_id=channels.id) AND json_extract(channels.data,'$.config.integration') IN ('newapi','sub2api','bbdevlab') THEN json_extract(channels.data,'$.config.integration') END)";
    const requestedIntegration = "json_extract(excluded.data,'$.config.integration')";
    const backendConflict = account ? '0' : `(${requestedIntegration} IN ('newapi','sub2api') AND (${savedIntegration}) IS NOT ${requestedIntegration})`;
    const effectiveIntegration = `CASE WHEN ${backendConflict} THEN json_extract(channels.data,'$.config.integration') ELSE ${requestedIntegration} END`;
    const accountVersion = stored?.account_version ?? -1;
    const effectiveEndpoint = account ? "json_extract(excluded.data,'$.endpoint')" : `CASE WHEN ${backendConflict} OR COALESCE((SELECT version FROM channel_accounts a WHERE a.channel_id=channels.id),-1)<>? THEN json_extract(channels.data,'$.endpoint') ELSE json_extract(excluded.data,'$.endpoint') END`;
    const statements = [this.env.DB.prepare(`INSERT INTO channels(id,data,fixture) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=json_patch(json_set(excluded.data,'$.health',json_extract(channels.data,'$.health'),'$.status',json_extract(channels.data,'$.status'),'$.requests',json_extract(channels.data,'$.requests'),'$.ttft',json_extract(channels.data,'$.ttft'),'$.successRate',json_extract(channels.data,'$.successRate'),'$.history',json_extract(channels.data,'$.history'),'$.endpoint',${effectiveEndpoint},'$.config.integration',${effectiveIntegration}),json_object('accountAuthMode',json_extract(${modeSource}.data,'$.accountAuthMode'),'accountIntegration',${savedIntegration})),health_version=channels.health_version+1`).bind(channel.id, JSON.stringify(channel), fixture ? 1 : 0, ...(!account ? [accountVersion] : [])), ...channel.tags.map(tag => this.env.DB.prepare('INSERT OR IGNORE INTO tags(name) VALUES(?)').bind(tag))];
    // Apply the saved policy to the current health row in the same transaction.
    // Keep measurements, history, manual activation and unrelated isolation intact.
    statements.push(this.env.DB.prepare("UPDATE channels SET data=json_set(data,'$.status','healthy','$.health.cooldownUntil',NULL,'$.health.reason',NULL,'$.health.recoveryCount',0,'$.health.autoDisabled',json('false')),health_version=health_version+1 WHERE id=? AND ((json_extract(data,'$.config.cooldown.error')=0 AND (json_extract(data,'$.health.autoDisabled')=1 OR json_extract(data,'$.health.reason') LIKE 'HTTP %' OR json_extract(data,'$.health.reason') LIKE '%失败率%')) OR (json_extract(data,'$.config.cooldown.firstToken')=0 AND COALESCE(json_extract(data,'$.health.autoDisabled'),0)=0 AND json_extract(data,'$.health.reason') LIKE '%首字%' AND json_extract(data,'$.health.reason') NOT LIKE 'HTTP %' AND json_extract(data,'$.health.reason') NOT LIKE '%失败率%'))").bind(channel.id));
    statements.push(this.env.DB.prepare("UPDATE credentials SET enabled=1,failure_count=0,recovery_count=0,disabled_at=NULL,reason=NULL WHERE channel_id=? AND enabled=0 AND reason IS NOT NULL AND disabled_at IS NOT NULL AND EXISTS (SELECT 1 FROM channels c WHERE c.id=credentials.channel_id AND json_extract(c.data,'$.config.cooldown.error')=0)").bind(channel.id));
    statements.push(...prepared.map(entry => entry.statement));
    statements.push(...preparedUpdates.filter((statement): statement is D1PreparedStatement => statement !== null));
    statements.push(...updates.filter(update => update.secret !== undefined).map(update => this.invalidateCredentialBalance(update.id)));
    if (deletes.length) statements.push(this.env.DB.prepare('DELETE FROM credentials WHERE channel_id=? AND id IN (SELECT value FROM json_each(?))').bind(channel.id,JSON.stringify(deletes)));
    if (previous && (previous.endpoint !== channel.endpoint || previous.config.integration !== channel.config.integration)) {
      statements.push(this.env.DB.prepare("UPDATE credential_balances SET balance=NULL,next_refresh_at=0,lease_until=0,version=version+1 WHERE credential_id IN (SELECT id FROM credentials WHERE channel_id=?) AND EXISTS (SELECT 1 FROM channels WHERE id=? AND json_extract(data,'$.endpoint')=? AND COALESCE(json_extract(data,'$.config.integration'),'native')=?)").bind(channel.id,channel.id,channel.endpoint,channel.config.integration ?? 'native'));
      statements.push(this.env.DB.prepare("UPDATE credentials SET enabled=1,reason=NULL,disabled_at=NULL,failure_count=0,recovery_count=0 WHERE channel_id=? AND enabled=0 AND reason IN (?,?) AND EXISTS (SELECT 1 FROM channels WHERE id=? AND json_extract(data,'$.endpoint')=? AND COALESCE(json_extract(data,'$.config.integration'),'native')=?)").bind(channel.id,BBDEVLAB_EXHAUSTED_REASON,BBDEVLAB_EXPIRED_REASON,channel.id,channel.endpoint,channel.config.integration ?? 'native'));
    }
    if (accountStatement) statements.push(accountStatement);
    else if (previous && previous.endpoint !== channel.endpoint) statements.push(this.env.DB.prepare("UPDATE channel_accounts SET auth_secret=NULL,balance=NULL,next_refresh_at=0,lease_until=0,version=version+1 WHERE channel_id=? AND version=? AND EXISTS (SELECT 1 FROM channels c WHERE c.id=? AND json_extract(c.data,'$.endpoint')=? AND (? NOT IN ('newapi','sub2api','bbdevlab') OR COALESCE(json_extract(c.data,'$.accountIntegration'),json_extract(c.data,'$.config.integration'),'native')=?))").bind(channel.id,accountVersion,channel.id,channel.endpoint,channel.config.integration ?? 'native',channel.config.integration ?? 'native'));
    await this.env.DB.batch(statements);
  }
  async importChannels(entries: { channel: GatewayChannel; credentials: CredentialInput[]; account?: AccountCredentials }[]): Promise<GatewayChannel[]> {
    const preparedCredentials: Record<string, unknown>[] = [], preparedAccounts: { channel_id: string; credentials: string }[] = [];
    for (const entry of entries) {
      if (entry.credentials.length > 100) throw new HttpError(400, 'Upstream API keys must be a bounded array');
      entry.credentials.forEach(validateCredential);
      if (entry.account) {
        assertAccountCredentials(entry.channel, entry.account);
        entry.channel = { ...entry.channel, accountAuthMode: accountAuthMode(entry.account), accountIntegration: entry.channel.config.integration as AccountIntegration };
      }
    }
    // Encrypt the complete import before the first write. JSON inserts keep even a
    // large import to four queries, and D1 batch rolls all of them back on failure.
    for (const entry of entries) {
      for (const credential of entry.credentials) {
        const prepared = await this.prepareCredential(entry.channel.id, credential);
        preparedCredentials.push({ ...prepared.credential, channel_id: entry.channel.id, secret: prepared.encrypted });
      }
      if (entry.account) preparedAccounts.push({ channel_id: entry.channel.id, credentials: await encryptSecret(JSON.stringify(entry.account), this.env) });
    }
    const statements = [
      this.env.DB.prepare("INSERT INTO channels(id,data,fixture) SELECT json_extract(value,'$.id'),value,0 FROM json_each(?)").bind(JSON.stringify(entries.map(entry => entry.channel))),
      this.env.DB.prepare('INSERT OR IGNORE INTO tags(name) SELECT value FROM json_each(?)').bind(JSON.stringify([...new Set(entries.flatMap(entry => entry.channel.tags))])),
    ];
    if (preparedCredentials.length) statements.push(this.env.DB.prepare("INSERT INTO credentials(id,channel_id,label,preview,secret,created_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.channel_id'),json_extract(value,'$.label'),json_extract(value,'$.preview'),json_extract(value,'$.secret'),json_extract(value,'$.createdAt') FROM json_each(?)").bind(JSON.stringify(preparedCredentials)));
    if (preparedAccounts.length) statements.push(this.env.DB.prepare("INSERT INTO channel_accounts(channel_id,credentials) SELECT json_extract(value,'$.channel_id'),json_extract(value,'$.credentials') FROM json_each(?)").bind(JSON.stringify(preparedAccounts)));
    await this.env.DB.batch(statements);
    return entries.map(({ channel, credentials, account }) => ({ ...channel, credentialCount: credentials.length, hasAccountCredentials: !!account, accountBalance: channel.config.integration === 'bbdevlab' ? { status:'pending',amount:null,unit:'余额',updatedAt:null,checkedAt:null,keyCount:credentials.length,availableKeys:credentials.length,exhaustedKeys:0 } : account ? { status: 'pending', amount: null, unit: '', updatedAt: null, checkedAt: null } : undefined }));
  }
  async deleteChannel(id: string): Promise<void> { await this.env.DB.prepare('DELETE FROM channels WHERE id=?').bind(id).run(); }
  async listCredentialMeta(channelId: string): Promise<CredentialMeta[]> {
    const rows = await this.env.DB.prepare("SELECT k.id,k.label,k.preview,k.enabled,k.failure_count,k.disabled_at,k.reason,k.created_at,b.balance,json_extract(c.data,'$.config.integration') AS integration FROM credentials k JOIN channels c ON c.id=k.channel_id LEFT JOIN credential_balances b ON b.credential_id=k.id WHERE k.channel_id=? ORDER BY k.created_at").bind(channelId).all<CredRow & { balance: string | null; integration: string }>();
    return rows.results.map(r => ({ id: r.id, label: r.label, preview: r.preview, enabled: !!r.enabled, failureCount: r.failure_count, disabledAt: r.disabled_at, reason: r.reason, createdAt: r.created_at, ...(r.integration === 'bbdevlab' ? { balance:r.balance ? JSON.parse(r.balance) : { status:'pending',amount:null,unit:'余额',updatedAt:null,checkedAt:null } } : {}) }));
  }
  private async prepareCredential(channelId: string, { label,secret }: CredentialInput): Promise<{ credential: CredentialMeta; statement: D1PreparedStatement; encrypted: string }> {
    validateCredential({ label,secret });
    const credential: CredentialMeta = { id: crypto.randomUUID(), label, preview: `••••${secret.slice(-4)}`, enabled: true, failureCount: 0, disabledAt: null, reason: null, createdAt: now() };
    const encrypted = await encryptSecret(secret, this.env);
    const statement = this.env.DB.prepare('INSERT INTO credentials(id,channel_id,label,preview,secret,created_at) VALUES(?,?,?,?,?,?)').bind(credential.id,channelId,label,credential.preview,encrypted,credential.createdAt);
    return { credential,statement,encrypted };
  }
  async addCredential(channelId: string, label: string, secret: string): Promise<CredentialMeta> {
    const { credential,statement } = await this.prepareCredential(channelId,{ label,secret });
    await statement.run();
    return credential;
  }
  async changeCredential(channelId: string, id: string, patch: { label?: string; enabled?: boolean; secret?: string }): Promise<CredentialMeta> {
    const update = normalizeCredentialUpdate({ ...patch,id });
    if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new HttpError(400, 'Expected a boolean');
    const meta = (await this.listCredentialMeta(channelId)).find(c => c.id === id); if (!meta) throw new HttpError(404, 'Credential not found');
    const statement = await this.prepareCredentialUpdate(channelId,update,patch.enabled);
    if (statement) await this.env.DB.batch([statement,...(update.secret !== undefined ? [this.invalidateCredentialBalance(id)] : [])]);
    return (await this.listCredentialMeta(channelId)).find(c => c.id === id)!;
  }
  private async prepareCredentialUpdate(channelId: string, update: CredentialUpdate, enabled?: boolean): Promise<D1PreparedStatement | null> {
    const columns: string[] = [], values: (string | number)[] = [];
    if (update.label !== undefined) { columns.push('label=?'); values.push(update.label); }
    if (update.secret !== undefined) {
      columns.push('secret=?','preview=?');
      values.push(await encryptSecret(update.secret,this.env),`••••${update.secret.slice(-4)}`);
      if (enabled === undefined) { columns.push('enabled=CASE WHEN reason IN (?,?) THEN 1 ELSE enabled END'); values.push(BBDEVLAB_EXHAUSTED_REASON,BBDEVLAB_EXPIRED_REASON); }
    }
    if (enabled !== undefined) { columns.push('enabled=?'); values.push(enabled ? 1 : 0); }
    if (update.secret !== undefined || enabled !== undefined) columns.push('failure_count=0','recovery_count=0','disabled_at=NULL','reason=NULL');
    return columns.length ? this.env.DB.prepare('UPDATE credentials SET '+columns.join(',')+' WHERE id=? AND channel_id=?').bind(...values,update.id,channelId) : null;
  }
  private invalidateCredentialBalance(id: string): D1PreparedStatement {
    return this.env.DB.prepare('UPDATE credential_balances SET balance=NULL,next_refresh_at=0,lease_until=0,version=version+1 WHERE credential_id=?').bind(id);
  }
  async deleteCredential(channelId: string, id: string): Promise<void> { await this.env.DB.prepare('DELETE FROM credentials WHERE id=? AND channel_id=?').bind(id,channelId).run(); }
  async isCredentialRestricted(channelId: string, credentialId: string): Promise<boolean> {
    const row = await this.env.DB.prepare("SELECT k.enabled,k.reason,b.balance FROM credentials k JOIN channels c ON c.id=k.channel_id LEFT JOIN credential_balances b ON b.credential_id=k.id WHERE k.id=? AND k.channel_id=? AND json_extract(c.data,'$.config.integration')='bbdevlab'").bind(credentialId,channelId).first<{ enabled:number; reason:string|null; balance:string|null }>();
    return !!row && ((!row.enabled && isBbCredentialRestriction(row.reason)) || credentialExpired(row.balance ? JSON.parse(row.balance) : undefined));
  }
  async getCredentials(channelId: string, includeDisabled = false): Promise<Credential[]> {
    const rows = await this.env.DB.prepare("SELECT k.*,b.balance,json_extract(c.data,'$.config.integration') AS integration FROM credentials k JOIN channels c ON c.id=k.channel_id LEFT JOIN credential_balances b ON b.credential_id=k.id WHERE k.channel_id=?" + (includeDisabled ? '' : ' AND k.enabled=1') + ' ORDER BY k.created_at').bind(channelId).all<CredRow & { balance:string|null; integration:string }>();
    const channel = includeDisabled ? await this.getChannel(channelId) : null;
    const settings = includeDisabled ? await this.getSettings() : null;
    const eligible = rows.results.filter(r => r.enabled || (channel && settings && credentialRecoveryAllowed(channel, settings, { enabled: false, reason: r.reason, disabledAt: r.disabled_at })));
    const credentials = await Promise.all(eligible.map(async r => ({ id: r.id, label: r.label, secret: await decryptSecret(r.secret,this.env), enabled: !!r.enabled, failureCount: r.failure_count, disabledAt: r.disabled_at, ...(r.integration === 'bbdevlab' && r.balance ? { expiresAt:JSON.parse(r.balance).expiresAt as string | null | undefined } : {}) })));
    // This gate also covers recovery probes and manual re-enabling, even before
    // the next Cron persists the automatic expiry restriction.
    return credentials.filter(credential => !credentialExpired(credential));
  }
  async getSettings(): Promise<GatewaySettings> {
    const row = await this.env.DB.prepare('SELECT value FROM settings WHERE id=?').bind('gateway').first<{ value: string }>();
    const token = await this.env.DB.prepare('SELECT id FROM settings WHERE id=?').bind('ai_gateway_token').first();
    return { ...defaultSettings, ...(row ? JSON.parse(row.value) as GatewaySettings : {}), hasAiGatewayToken: !!token || !!this.env.AI_GATEWAY_TOKEN };
  }
  async saveSettings(settings: GatewaySettings, token?: string, clear = false): Promise<void> {
    const encrypted = token ? await encryptSecret(token,this.env) : null;
    const statements = [this.env.DB.prepare('INSERT INTO settings(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').bind('gateway', JSON.stringify({ ...settings, hasAiGatewayToken: false }))];
    if (clear) statements.push(this.env.DB.prepare('DELETE FROM settings WHERE id=?').bind('ai_gateway_token'));
    else if (encrypted) statements.push(this.env.DB.prepare('INSERT INTO settings(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').bind('ai_gateway_token',encrypted));
    await this.env.DB.batch(statements);
  }
  async getAiGatewayToken(): Promise<string | null> {
    const row = await this.env.DB.prepare('SELECT value FROM settings WHERE id=?').bind('ai_gateway_token').first<{ value: string }>();
    return row ? decryptSecret(row.value,this.env) : this.env.AI_GATEWAY_TOKEN ?? null;
  }
  async listKeys(): Promise<GatewayApiKey[]> { const rows = await this.env.DB.prepare('SELECT data,used FROM api_keys ORDER BY json_extract(data,\'$.createdAt\') DESC').all<{ data: string; used: number }>(); return rows.results.map(r => ({ ...decode<GatewayApiKey>(r), used: r.used })); }
  async getKey(id: string): Promise<KeyRecord | null> { const row = await this.env.DB.prepare('SELECT data,token_hash,used FROM api_keys WHERE id=?').bind(id).first<{ data: string; token_hash: string; used: number }>(); return row ? { ...decode<GatewayApiKey>(row), used: row.used, tokenHash: row.token_hash } : null; }
  async findKey(token: string): Promise<KeyRecord | null> { const row = await this.env.DB.prepare('SELECT data,token_hash,used FROM api_keys WHERE token_hash=?').bind(await hashToken(token)).first<{ data: string; token_hash: string; used: number }>(); return row ? { ...decode<GatewayApiKey>(row), used: row.used, tokenHash: row.token_hash } : null; }
  async createKey(key: GatewayApiKey): Promise<{ key: GatewayApiKey; token: string }> {
    const token = randomToken(); key.preview = previewToken(token);
    await this.env.DB.batch([this.env.DB.prepare('INSERT INTO api_keys(id,token_hash,data) VALUES(?,?,?)').bind(key.id,await hashToken(token),JSON.stringify(key)), ...key.profiles.map(p => this.env.DB.prepare('INSERT INTO profile_usage(key_id,profile_id) VALUES(?,?)').bind(key.id,p.id))]);
    return { key,token };
  }
  async saveKey(key: GatewayApiKey): Promise<void> {
    const result = await this.env.DB.batch([this.env.DB.prepare("UPDATE api_keys SET data=? WHERE id=? AND json_extract(data,'$.status')<>'revoked'").bind(JSON.stringify(key),key.id), ...key.profiles.map(p => this.env.DB.prepare("INSERT OR IGNORE INTO profile_usage(key_id,profile_id) SELECT ?,? WHERE EXISTS (SELECT 1 FROM api_keys WHERE id=? AND json_extract(data,'$.status')<>'revoked')").bind(key.id,p.id,key.id))]);
    if (!result[0].meta.changes) { if (!await this.getKey(key.id)) throw new HttpError(404, 'API Key not found'); throw new HttpError(409, 'Revoked keys cannot be updated'); }
  }
  async deleteKey(id: string): Promise<void> {
    const result = await this.env.DB.prepare('DELETE FROM api_keys WHERE id=?').bind(id).run();
    if (!result.meta.changes) throw new HttpError(404, 'API Key not found');
  }
  async bulkKeys(ids: string[], action: 'enable' | 'disable' | 'delete'): Promise<void> {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 200 || ids.some(id => typeof id !== 'string' || !id || id !== id.trim() || id.length > 128)) throw new HttpError(400, 'Select 1–200 valid API Key IDs');
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'API Key IDs must be unique');
    if (!['enable','disable','delete'].includes(action)) throw new HttpError(400, 'Invalid API Key bulk action');
    const selection = JSON.stringify(ids);
    const inspect = async (): Promise<void> => {
      const rows = await this.env.DB.prepare("SELECT id,json_extract(data,'$.status') AS status FROM api_keys WHERE id IN (SELECT value FROM json_each(?))").bind(selection).all<{ id: string; status: GatewayApiKey['status'] }>();
      if (rows.results.length !== ids.length) throw new HttpError(404, 'API Key not found');
      if (action !== 'delete' && rows.results.some(key => key.status === 'revoked')) throw new HttpError(409, 'Revoked keys cannot be updated');
    };
    await inspect();
    // Validate the complete selection again inside the one mutation statement.
    // A concurrent deletion or revocation must leave every other selected key intact.
    // profile_usage is removed by its foreign key cascade; request history is retained.
    const guard = "id IN (SELECT value FROM json_each(?)) AND (SELECT COUNT(*) FROM api_keys WHERE id IN (SELECT value FROM json_each(?)))=?";
    const changes = action === 'delete'
      // D1 changes includes cascaded profile rows; RETURNING counts only selected keys.
      ? (await this.env.DB.prepare('DELETE FROM api_keys WHERE '+guard+' RETURNING id').bind(selection,selection,ids.length).all<{ id: string }>()).results.length
      : (await this.env.DB.prepare("UPDATE api_keys SET data=json_set(data,'$.status',?) WHERE "+guard+" AND NOT EXISTS (SELECT 1 FROM api_keys WHERE id IN (SELECT value FROM json_each(?)) AND json_extract(data,'$.status')='revoked')").bind(action === 'enable' ? 'active' : 'disabled',selection,selection,ids.length,selection).run()).meta.changes;
    if (changes !== ids.length) { await inspect(); throw new HttpError(409, 'API Keys changed; refresh and try again'); }
  }
  async rotateKey(key: GatewayApiKey): Promise<{ key: GatewayApiKey; token: string }> {
    const token = randomToken(), preview = previewToken(token);
    const result = await this.env.DB.prepare("UPDATE api_keys SET token_hash=?,data=json_set(data,'$.preview',?) WHERE id=? AND json_extract(data,'$.status')<>'revoked'").bind(await hashToken(token),preview,key.id).run();
    if (!result.meta.changes) { if (!await this.getKey(key.id)) throw new HttpError(404, 'API Key not found'); throw new HttpError(409, 'Revoked keys cannot be rotated'); }
    const current = await this.getKey(key.id); if (!current) throw new HttpError(404, 'API Key not found');
    return { key: publicKey(current), token };
  }
  async incrementKeyUsage(keyId: string, profileId: string, limit: number): Promise<boolean> {
    if (this.coordinate) return this.coordinated<boolean>('quota',{ keyId,profileId,limit });
    const key = await this.getKey(keyId); if (!key || key.status !== 'active' || key.activeProfile !== profileId || expired(key)) return false;
    const current = key.profiles.find(p => p.id === profileId); if (!current) return false;
    limit = Math.max(0,Number(current.requestLimit) || 0);
    const reserved = await this.env.DB.batch([
      this.env.DB.prepare('UPDATE profile_usage SET used=used+1 WHERE key_id=? AND profile_id=? AND (?<=0 OR used<?)').bind(keyId,profileId,limit,limit),
      // changes() observes the preceding profile update in this same transaction;
      // an exhausted or missing profile must not increment the key's total.
      this.env.DB.prepare('UPDATE api_keys SET used=used+1 WHERE id=? AND changes()=1').bind(keyId),
    ]);
    return reserved[0].meta.changes === 1;
  }
  async listTags(): Promise<string[]> { return (await this.env.DB.prepare('SELECT name FROM tags ORDER BY name').all<{ name: string }>()).results.map(r => r.name); }
  async addTag(name: string): Promise<void> { await this.env.DB.prepare('INSERT OR IGNORE INTO tags(name) VALUES(?)').bind(name).run(); }
  async renameTag(oldName: string, newName: string): Promise<void> {
    if (!(await this.listTags()).includes(oldName)) throw new HttpError(404, 'Tag not found');
    if (oldName === newName) return;
    if ((await this.listTags()).includes(newName)) throw new HttpError(409, 'Tag already exists');
    await this.env.DB.batch([
      this.env.DB.prepare('UPDATE tags SET name=? WHERE name=?').bind(newName,oldName),
      this.env.DB.prepare("UPDATE channels SET data=json_set(data,'$.tags',json((SELECT json_group_array(CASE WHEN value=? THEN ? ELSE value END) FROM json_each(channels.data,'$.tags')))),health_version=health_version+1 WHERE EXISTS (SELECT 1 FROM json_each(channels.data,'$.tags') WHERE value=?)").bind(oldName,newName,oldName),
      this.env.DB.prepare("UPDATE api_keys SET data=json_set(data,'$.profiles',json((SELECT json_group_array(json_set(p.value,'$.tags',json((SELECT json_group_array(CASE WHEN t.value=? THEN ? ELSE t.value END) FROM json_each(p.value,'$.tags') t)))) FROM json_each(api_keys.data,'$.profiles') p))) WHERE EXISTS (SELECT 1 FROM json_each(api_keys.data,'$.profiles') p,json_each(p.value,'$.tags') t WHERE t.value=?)").bind(oldName,newName,oldName),
    ]);
  }
  async deleteTag(name: string): Promise<void> {
    if ((await this.listKeys()).some(k => k.status !== 'revoked' && k.profiles.some(p => p.scope === 'tags' && p.tags.includes(name)))) throw new HttpError(409, 'Tag is referenced by an API Key profile; update its restrictions first');
    const referenceGuard = "NOT EXISTS (SELECT 1 FROM api_keys k,json_each(k.data,'$.profiles') p,json_each(p.value,'$.tags') t WHERE json_extract(k.data,'$.status')<>'revoked' AND json_extract(p.value,'$.scope')='tags' AND t.value=?)";
    const result = await this.env.DB.batch([
      this.env.DB.prepare('DELETE FROM tags WHERE name=? AND '+referenceGuard).bind(name,name),
      this.env.DB.prepare("UPDATE channels SET data=json_set(data,'$.tags',json((SELECT json_group_array(value) FROM json_each(channels.data,'$.tags') WHERE value<>?))),health_version=health_version+1 WHERE NOT EXISTS (SELECT 1 FROM tags WHERE name=?) AND "+referenceGuard+" AND EXISTS (SELECT 1 FROM json_each(channels.data,'$.tags') WHERE value=?)").bind(name,name,name,name),
    ]);
    if (!result[0].meta.changes && (await this.listTags()).includes(name)) throw new HttpError(409, 'Tag is referenced by an API Key profile; update its restrictions first');
  }
  async recordAttempt(attempt: AttemptRecord): Promise<void> {
    const clean: AttemptRecord = { ...attempt, error: redact(attempt.error) }; if (this.coordinate) { await this.coordinated('attempt',clean); return; }
    if ((clean.result === 'error' || clean.result === 'empty') && clean.credentialId && await this.isCredentialRestricted(clean.channelId,clean.credentialId)) clean.healthIgnored = true;
    const inserted = await this.env.DB.prepare('INSERT OR IGNORE INTO attempts(id,request_id,channel_id,stream,started_at,data) VALUES(?,?,?,?,?,?)').bind(clean.id,clean.requestId,clean.channelId,clean.stream ? 1 : 0,clean.startedAt,JSON.stringify(clean)).run();
    if (!inserted.meta.changes) return;
    if (clean.result === 'cancelled') {
      // Keep the attempt for tracing, but a client cancellation says nothing about
      // upstream health and must not evict a real sample from a bounded window.
      await this.env.DB.prepare("UPDATE channels SET data=json_set(data,'$.requests',COALESCE(json_extract(data,'$.requests'),0)+1),health_version=health_version+1 WHERE id=?").bind(clean.channelId).run();
      return;
    }
    const c = await this.getChannel(clean.channelId); if (!c) return;
    const s = await this.getSettings(); const recent = await this.getRecentAttempts(c.id,clean.stream,s.window,s.windowSeconds);
    const reset = await this.env.DB.prepare('SELECT value FROM gateway_state WHERE id=?').bind('health-reset:'+c.id).first<{ value:string }>();
    // Requests that began before a manual reset still count toward statistics,
    // but cannot immediately restore the isolation or old failure streak.
    if ((!reset || clean.startedAt > reset.value) && !clean.healthIgnored) {
      const matchingRecoveryMode = c.health.reason?.includes('首字') ? clean.stream : c.health.reason?.includes('响应耗时') ? !clean.stream : true;
      const allowRecovery = c.health.autoDisabled ? (c.config.autoDisable.enabled ? c.config.autoDisable.recover : s.autoDisableRecover) : s.autoRecover;
      const decision = evaluateHealth(c,{ ...s,autoRecover:allowRecovery && matchingRecoveryMode },recent,clean);
      if (decision.status === 'healthy' && c.status !== 'healthy') {
        await this.env.DB.prepare('INSERT INTO gateway_state(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').bind(`health-window:${c.id}:${clean.stream ? 1 : 0}`,clean.startedAt).run();
        decision.patch.samples = 1; if (clean.stream) decision.patch.averageTtft = clean.ttft; else decision.patch.averageDuration = clean.duration;
      }
      if (decision.status === 'healthy' && c.health.autoDisabled) decision.patch.autoDisabled = false;
      await this.updateHealth(c.id,decision.patch,decision.status);
      if (decision.event) await this.recordEvent(decision.event);
      const cred = clean.credentialId ? await this.env.DB.prepare('SELECT failure_count,recovery_count,enabled,disabled_at,reason FROM credentials WHERE id=? AND channel_id=?').bind(clean.credentialId,c.id).first<CredRow>() : null;
      const target = autoDisableDecision(c,s,clean.status,0,Date.now()).target;
      const channelFailures = target === 'channel' ? await this.env.DB.prepare('SELECT value FROM gateway_state WHERE id=?').bind('auto-disable:'+c.id).first<{ value:string }>() : null;
      const prior = target === 'key' ? cred?.failure_count ?? 0 : Number(channelFailures?.value ?? 0);
      const ad = autoDisableDecision(c,s,clean.status,prior,Date.now());
      if (target === 'channel') await this.env.DB.prepare('INSERT INTO gateway_state(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').bind('auto-disable:'+c.id,String(ad.failureCount)).run();
      if (clean.credentialId && cred && !cred.enabled) {
        if (credentialRecoveryAllowed(c,s,{ enabled:false,reason:cred.reason,disabledAt:cred.disabled_at })) {
          const recovery = clean.result === 'success' ? cred.recovery_count+1 : 0;
          const recovered = recovery >= s.recovery;
          // A concurrent manual disable clears reason/disabled_at, so it wins even
          // when an already-running automatic recovery probe has just succeeded.
          await this.env.DB.prepare('UPDATE credentials SET recovery_count=?,failure_count=?,enabled=?,disabled_at=?,reason=? WHERE id=? AND enabled=0 AND reason IS NOT NULL AND disabled_at<=?').bind(recovery,ad.failureCount,recovered ? 1 : 0,recovered ? null : cred.disabled_at,recovered ? null : cred.reason,clean.credentialId,now()).run();
        }
      } else if (ad.target === 'key' && clean.credentialId && cred) {
        await this.env.DB.prepare("UPDATE credentials SET recovery_count=0,failure_count=?,enabled=?,disabled_at=?,reason=? WHERE id=? AND enabled=1 AND (?=0 OR EXISTS (SELECT 1 FROM channels c WHERE c.id=credentials.channel_id AND COALESCE(json_extract(c.data,'$.config.cooldown.error'),1)=1))").bind(ad.failureCount,ad.disable ? 0 : 1,ad.disable ? ad.cooldownUntil : null,ad.disable ? `HTTP ${clean.status}` : null,clean.credentialId,ad.disable ? 1 : 0).run();
      } else if (ad.disable) { await this.updateHealth(c.id,{ autoDisabled: true,cooldownUntil: ad.cooldownUntil,reason: `HTTP ${clean.status}`,failureCount:ad.failureCount },'offline'); }
    }
    for (let retry = 0; retry < 5; retry++) {
      const stored = await this.env.DB.prepare('SELECT data,health_version FROM channels WHERE id=?').bind(c.id).first<DataRow>();
      if (!stored) return;
      const latest = decode<GatewayChannel>(stored); latest.requests += 1; latest.ttft = clean.ttft ?? 0;
      latest.history = [...latest.history.slice(-19),clean.result === 'success' ? 0 : clean.result === 'slow' ? 1 : 2];
      latest.successRate = recent.length ? recent.filter(a => ['success','slow'].includes(a.result)).length / recent.length * 100 : 0;
      const updated = await this.env.DB.prepare('UPDATE channels SET data=?,health_version=health_version+1 WHERE id=? AND health_version=?').bind(JSON.stringify(latest),c.id,stored.health_version!).run();
      if (updated.meta.changes) return;
    }
    throw new Error('Channel statistics update conflict');
  }
  async recordLog(log: GatewayLog): Promise<void> { const clean = { ...log,error: redact(log.error) }; await this.env.DB.prepare('INSERT OR REPLACE INTO request_logs(id,created_at,channel_id,result,source,model,data) VALUES(?,?,?,?,?,?,?)').bind(log.id,log.createdAt,log.channelId,log.result,log.source,log.model,JSON.stringify(clean)).run(); }
  async recordEvent(event: GatewayEvent): Promise<void> { const clean = { ...event,description: redact(event.description) ?? '' }; await this.env.DB.prepare('INSERT OR REPLACE INTO events(id,created_at,data) VALUES(?,?,?)').bind(clean.id,clean.createdAt,JSON.stringify(clean)).run(); }
  async getRecentAttempts(channelId: string, stream: boolean, limit: number, seconds = 0): Promise<AttemptRecord[]> {
    const epochs = await this.env.DB.prepare('SELECT (SELECT value FROM gateway_state WHERE id=?) AS window,(SELECT value FROM gateway_state WHERE id=?) AS reset').bind(`health-window:${channelId}:${stream ? 1 : 0}`,'health-reset:'+channelId).first<{ window:string|null;reset:string|null }>();
    const timeSince = seconds ? new Date(Date.now()-seconds*1000).toISOString() : ''; const since = epochs?.window && epochs.window > timeSince ? epochs.window : timeSince;
    const rows = await this.env.DB.prepare("SELECT data FROM attempts WHERE channel_id=? AND stream=? AND started_at>=? AND started_at>? AND json_extract(data,'$.result')<>'cancelled' AND COALESCE(json_extract(data,'$.healthIgnored'),0)=0 ORDER BY started_at DESC,rowid DESC LIMIT ?").bind(channelId,stream ? 1 : 0,since,epochs?.reset ?? '',Math.min(1000,limit)).all<DataRow>();
    return rows.results.map(r => decode<AttemptRecord>(r));
  }
  async resetChannelHealth(channelId: string): Promise<void> {
    if (this.coordinate) { await this.coordinated('reset-health',{ channelId }); return; }
    const channel = await this.getChannel(channelId); if (!channel) return;
    const resetAt = now();
    const health: GatewayChannel['health'] = { averageTtft:null,averageDuration:null,samples:0,cooldownUntil:null,recoveryCount:0,failureCount:0,reason:null,autoDisabled:false };
    // Atomic SQL updates preserve concurrent configuration edits and all history.
    // Both response modes and channel-level HTTP failure streaks start fresh.
    const result = await this.env.DB.batch([
      this.env.DB.prepare("UPDATE channels SET data=json_set(data,'$.health',json(?),'$.status','healthy'),health_version=health_version+1 WHERE id=?").bind(JSON.stringify(health),channelId),
      ...[`health-window:${channelId}:0`,`health-window:${channelId}:1`,'health-reset:'+channelId].map(id => this.env.DB.prepare('INSERT INTO gateway_state(id,value) SELECT ?,? WHERE EXISTS (SELECT 1 FROM channels WHERE id=?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').bind(id,resetAt,channelId)),
      this.env.DB.prepare('DELETE FROM gateway_state WHERE id=?').bind('auto-disable:'+channelId),
    ]);
    if (result[0].meta.changes) await this.recordEvent({ id:crypto.randomUUID(),createdAt:resetAt,time:new Date(resetAt).toLocaleTimeString('zh-CN',{ timeZone:'Asia/Shanghai',hour12:false }),title:'渠道健康状态已重置',description:`${channel.name}：管理员已解除健康隔离并清空检测窗口`,type:'recovery',channelId });
  }
  async updateHealth(channelId: string, patch: Partial<GatewayChannel['health']>, status?: GatewayChannel['status']): Promise<void> {
    if (this.coordinate) { await this.coordinated('health',{ channelId,patch,status }); return; }
    for (let retry = 0; retry < 5; retry++) {
      const row = await this.env.DB.prepare('SELECT data,health_version FROM channels WHERE id=?').bind(channelId).first<DataRow>(); if (!row) return;
      const current = decodeChannel(row);
      const next = { ...current,status:status ?? current.status,health:{ ...current.health,...patch } };
      if (cooldownExemptsHealth(next)) {
        // A late decision from a now-exempt rule cannot remove isolation imposed
        // by another rule that is still enabled, such as non-streaming latency.
        const keepRestriction = !cooldownExemptsHealth(current) && (current.status !== 'healthy' || current.health.cooldownUntil || current.health.autoDisabled);
        next.status = keepRestriction ? current.status : 'healthy';
        next.health = { ...next.health,
          cooldownUntil:keepRestriction ? current.health.cooldownUntil : null,
          reason:keepRestriction ? current.health.reason : null,
          recoveryCount:keepRestriction ? current.health.recoveryCount : 0,
          autoDisabled:keepRestriction ? current.health.autoDisabled : false,
        };
      }
      const result = await this.env.DB.prepare('UPDATE channels SET data=?,health_version=health_version+1 WHERE id=? AND health_version=?').bind(JSON.stringify(next),channelId,row.health_version!).run();
      if (result.meta.changes) return;
    }
    throw new Error('Health update conflict');
  }
  async setCredentialHealth(id: string, patch: { enabled?: boolean; failureCount?: number; disabledAt?: string | null; reason?: string | null }): Promise<void> {
    const entries = Object.entries(patch); if (!entries.length) return; const columns: Record<string,string> = { enabled:'enabled',failureCount:'failure_count',disabledAt:'disabled_at',reason:'reason' };
    await this.env.DB.prepare('UPDATE credentials SET ' + entries.map(([k]) => columns[k] + '=?').join(',') + ' WHERE id=?').bind(...entries.map(([,v]) => typeof v === 'boolean' ? Number(v) : v),id).run();
  }
  async nextRoundRobin(scope: string): Promise<number> {
    if (this.coordinate) return this.coordinated<number>('rr',{ scope });
    const row = await this.env.DB.prepare('INSERT INTO gateway_state(id,value) VALUES(?,\'1\') ON CONFLICT(id) DO UPDATE SET value=CAST(value AS INTEGER)+1 RETURNING value').bind('rr:'+scope).first<{ value: string }>(); return Number(row!.value)-1;
  }
  async getSticky(scope: string): Promise<string | null> { const row = await this.env.DB.prepare('SELECT value FROM gateway_state WHERE id=? AND expires_at>?').bind('sticky:'+scope,Date.now()).first<{ value: string }>(); return row?.value ?? null; }
  async setSticky(scope: string, channelId: string): Promise<void> { await this.env.DB.prepare('INSERT INTO gateway_state(id,value,expires_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at').bind('sticky:'+scope,channelId,Date.now()+24*3600*1000).run(); }
  async reserveChannel(channel: GatewayChannel, estimatedTokens: number): Promise<boolean> {
    if (this.coordinate) return this.coordinated<boolean>('rate',{ channel,estimatedTokens });
    const minute = Math.floor(Date.now()/60000); const id = `rate:${channel.id}:${minute}`;
    const row = await this.env.DB.prepare('SELECT value FROM gateway_state WHERE id=?').bind(id).first<{ value: string }>();
    const value = row ? JSON.parse(row.value) as { requests: number; tokens: number } : { requests:0,tokens:0 };
    const limits = channel.config.rateLimit; if (limits.requestsPerMinute > 0 && value.requests >= limits.requestsPerMinute || limits.tokensPerMinute > 0 && value.tokens + estimatedTokens > limits.tokensPerMinute) return false;
    value.requests++; value.tokens += estimatedTokens;
    await this.env.DB.prepare('INSERT INTO gateway_state(id,value,expires_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at').bind(id,JSON.stringify(value),Date.now()+120000).run(); return true;
  }
  async listLogs(options: { limit?: number; offset?: number; q?: string; result?: string; channelId?: string; source?: string } = {}): Promise<{ logs: GatewayLog[]; total: number }> {
    // D1 limits LIKE patterns to 50 UTF-8 bytes, including the two wildcards.
    if (options.q && new TextEncoder().encode(options.q).byteLength > 48) throw new HttpError(400, '搜索关键词过长，最多 48 个英文字符或 16 个汉字；混合输入请适当缩短');
    const where = ['1=1']; const args: (string | number)[] = [];
    if (options.q) { where.push('(model LIKE ? OR json_extract(data,\'$.channel\') LIKE ? OR id LIKE ?)'); const q = '%'+options.q+'%'; args.push(q,q,q); }
    for (const [key,column] of [['result','result'],['channelId','channel_id'],['source','source']] as const) if (options[key]) { where.push(column+'=?'); args.push(options[key]!); }
    const clause = where.join(' AND '); const total = await this.env.DB.prepare('SELECT COUNT(*) AS total FROM request_logs WHERE '+clause).bind(...args).first<{ total: number }>();
    const rows = await this.env.DB.prepare('SELECT data FROM request_logs WHERE '+clause+' ORDER BY created_at DESC LIMIT ? OFFSET ?').bind(...args,options.limit ?? 50,options.offset ?? 0).all<DataRow>(); return { logs:rows.results.map(r => decode<GatewayLog>(r)),total:total?.total ?? 0 };
  }
  async getLog(id: string): Promise<{ log: GatewayLog; attempts: AttemptRecord[] } | null> { const row = await this.env.DB.prepare('SELECT data FROM request_logs WHERE id=?').bind(id).first<DataRow>(); if (!row) return null; const attempts = await this.env.DB.prepare('SELECT data FROM attempts WHERE request_id=? ORDER BY started_at,rowid').bind(id).all<DataRow>(); return { log:decode<GatewayLog>(row),attempts:attempts.results.map(r => decode<AttemptRecord>(r)) }; }
  async clearLogs(): Promise<void> { await this.env.DB.batch([this.env.DB.prepare('DELETE FROM attempts'),this.env.DB.prepare('DELETE FROM request_logs')]); }
  async listEvents(limit = 30): Promise<GatewayEvent[]> { const rows = await this.env.DB.prepare('SELECT data FROM events ORDER BY created_at DESC LIMIT ?').bind(limit).all<DataRow>(); return rows.results.map(r => decode<GatewayEvent>(r)); }
  async dashboard(range: string): Promise<DashboardData> {
    const hours = range === '1h' ? 1 : range === '7d' ? 168 : 24; const since = new Date(Date.now()-hours*3600000).toISOString();
    const logs = (await this.env.DB.prepare("SELECT json_remove(data,'$.error') AS data FROM request_logs WHERE created_at>=? AND source<>'probe' ORDER BY created_at").bind(since).all<DataRow>()).results.map(r => decode<GatewayLog>(r));
    const attempts = (await this.env.DB.prepare("SELECT json_remove(a.data,'$.error') AS data FROM attempts a JOIN request_logs l ON l.id=a.request_id WHERE l.created_at>=? AND l.source<>'probe' ORDER BY a.started_at").bind(since).all<DataRow>()).results.map(r => decode<AttemptRecord>(r));
    const requestIds = new Set(logs.map(l => l.id)); const useful = attempts.filter(a => requestIds.has(a.requestId)); const channels = await this.listChannels();
    const buckets = new Map<string,{ time: string; primary: number[]; backup: number[]; requests: number }>(); const sorted = channels.filter(c => !c.archived).sort((a,b) => a.priority-b.priority || b.weight-a.weight); const interval = hours === 1 ? 5*60000 : hours === 24 ? 3600000 : 12*3600000;
    logs.forEach(l => { const date = new Date(Math.floor(Date.parse(l.createdAt)/interval)*interval).toISOString(); let bucket = buckets.get(date); if (!bucket) { bucket = { time:date,primary:[],backup:[],requests:0 }; buckets.set(date,bucket); } bucket.requests++; if (completed(l) && l.stream && l.ttft > 0) (l.channelId === sorted[0]?.id ? bucket.primary : bucket.backup).push(l.ttft); });
    const average = (v: number[]): number | null => v.length ? v.reduce((a,b) => a+b,0)/v.length : null;
    const analytics = buildAnalytics(logs,useful,channels,range);
    return { analytics, totals: analytics.totals, latency:[...buckets.values()].map(b => ({ ...b,primary:average(b.primary),backup:average(b.backup) })),events:await this.listEvents(),channels };
  }
  async cleanup(days: number): Promise<void> { const before = new Date(Date.now()-days*86400000).toISOString(); await this.env.DB.batch([this.env.DB.prepare('DELETE FROM attempts WHERE started_at<?').bind(before),this.env.DB.prepare('DELETE FROM request_logs WHERE created_at<?').bind(before),this.env.DB.prepare('DELETE FROM events WHERE created_at<?').bind(before),this.env.DB.prepare('DELETE FROM gateway_state WHERE expires_at<?').bind(Date.now()),this.env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at<?').bind(Date.now())]); }
  async clearFixtures(): Promise<void> { await this.env.DB.prepare('DELETE FROM channels WHERE fixture=1').run(); }
}
export function publicKey(key: KeyRecord): GatewayApiKey { const { tokenHash: _tokenHash,...data } = key; return data; }
export function expired(key: GatewayApiKey): boolean { if (['','永不过期','never'].includes(key.expires)) return false; const date = /^\d{4}-\d{2}-\d{2}$/.test(key.expires) ? key.expires+'T23:59:59.999+08:00' : key.expires; return Date.parse(date) <= Date.now(); }
