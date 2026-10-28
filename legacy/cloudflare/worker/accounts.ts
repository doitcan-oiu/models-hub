import type { AccountIntegration, GatewayChannel } from '../shared/types';
import type { Env } from './env';
import { encryptSecret, decryptSecret } from './crypto';
import { HttpError, assert, object, text, url } from './validation';
import { readUpstreamJSON } from './upstream-http';
import { newApiLoginPayload } from './newapi-login';

type PasswordCredentials = { username: string; password: string };
export type AccountCredentials = PasswordCredentials | { accessToken: string; userId?: string } | { cookie: string; accessToken?: string };
type Balance = NonNullable<GatewayChannel['accountBalance']>;
type AccountRow = { channel_id: string; credentials: string; auth_secret: string | null; balance: string | null; version: number; channel_data: string };
type Session = { token?: string; cookie?: string; userId?: string; expiresAt: number; base: string };
export const BALANCE_REFRESH_MS = 5 * 60 * 1000;

function isAccountIntegration(value: unknown): value is AccountIntegration {
  return typeof value === 'string' && ['newapi', 'sub2api', 'bbdevlab'].includes(value);
}

export function accountIntegration(channel: GatewayChannel): GatewayChannel['accountIntegration'] {
  return channel.accountIntegration ?? (channel.hasAccountCredentials && isAccountIntegration(channel.config.integration) ? channel.config.integration : undefined);
}

export function accountAuthMode(account: AccountCredentials): NonNullable<GatewayChannel['accountAuthMode']> {
  return 'cookie' in account ? 'cookie' : 'accessToken' in account ? 'token' : 'password';
}

export function assertAccountCredentials(channel: GatewayChannel, account: AccountCredentials): void {
  assert(isAccountIntegration(channel.config.integration), '仅 NewAPI / Sub2API / BBDevLab 渠道使用后台凭据');
  if (channel.config.integration === 'bbdevlab') {
    assert('accessToken' in account && Object.keys(account).every(key => key === 'accessToken'), 'BBDevLab 仅支持后台访问令牌，不支持账号密码、Cookie 或用户 ID');
    return;
  }
  if ('cookie' in account) assert(channel.config.integration === 'sub2api', 'Cookie / 浏览器会话仅支持 Sub2API 后台');
  else if ('accessToken' in account) assert(channel.config.integration === 'newapi', '后台访问令牌仅支持 NewAPI 渠道');
}

export function assertAccountReuse(channel: GatewayChannel, previous: GatewayChannel | null, account?: AccountCredentials): void {
  const integration = channel.config.integration;
  if (!isAccountIntegration(integration)) return;
  if (account) {
    assertAccountCredentials(channel, account);
    return;
  }
  // BBDevLab authenticates each balance request with its inference API Key.
  if (integration === 'bbdevlab') return;
  assert(previous?.hasAccountCredentials && accountIntegration(previous) === integration, '开启余额监控或切换后台类型时，请填写对应的后台凭据');
}

function normalizeAccessToken(value: unknown): string {
  const rawToken = text(value, '', 4096);
  assert(!/[\x00-\x1f\x7f]/.test(rawToken), '后台访问令牌不能包含控制字符');
  const accessToken = rawToken.trim().replace(/^Bearer(?:\s+|$)/i, '');
  assert(accessToken && !/\s/.test(accessToken), '后台访问令牌不能为空或包含空白字符');
  return accessToken;
}

export function parseAccountCredentials(value: unknown): AccountCredentials | undefined {
  if (value === undefined) return undefined;
  const b = object(value);
  if (b.cookie !== undefined) {
    const rawCookie = text(b.cookie, '', 16000);
    assert(!/[^\x20-\x7e]/.test(rawCookie), 'Cookie 须为单行 ASCII 文本，不能包含控制字符');
    const cookie = rawCookie.trim().replace(/^Cookie:\s*/i, '').trim();
    assert(!cookie || cookie.split(';').every((part, index, parts) => {
      const pair = part.trim();
      if (!pair) return index === parts.length - 1;
      const equals = pair.indexOf('=');
      return equals > 0 && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(pair.slice(0, equals));
    }), 'Cookie 须使用请求头中的 name=value 格式');
    assert(!text(b.username, '', 256).trim() && !text(b.password, '', 4096) && !text(b.userId, '', 20).trim(), 'Cookie / 浏览器会话与账号密码、用户 ID 不能同时填写');
    const rawToken = text(b.accessToken, '', 4096);
    assert(!/[\x00-\x1f\x7f]/.test(rawToken), '后台登录 Token 不能包含控制字符');
    const accessToken = rawToken.trim().replace(/^Bearer(?:\s+|$)/i, '');
    assert(!rawToken.trim() || accessToken && !/\s/.test(accessToken), '后台登录 Token 不能为空或包含空白字符');
    assert(cookie || accessToken, 'Cookie / 浏览器会话须填写 Cookie 或后台登录 Token');
    return { cookie, ...(accessToken ? { accessToken } : {}) };
  }
  if (b.accessToken !== undefined) {
    const accessToken = normalizeAccessToken(b.accessToken);
    assert(!text(b.username, '', 256).trim() && !text(b.password, '', 4096), '后台访问令牌与账号密码不能同时填写');
    const userId = text(b.userId, '', 20).trim();
    assert(!userId || /^\d+$/.test(userId) && Number.isSafeInteger(Number(userId)) && Number(userId) > 0, '用户 ID 须为正整数，且不超过安全整数范围');
    return { accessToken, ...(userId ? { userId: String(Number(userId)) } : {}) };
  }
  assert(b.userId === undefined || !text(b.userId, '', 20).trim(), '用户 ID 仅用于后台访问令牌登录');
  const username = text(b.username, '', 256).trim();
  const password = text(b.password, '', 4096);
  assert(username && password, '账号和密码须同时填写');
  return { username, password };
}

export async function prepareAccountSave(env: Env, channel: GatewayChannel, account?: AccountCredentials): Promise<D1PreparedStatement | null> {
  if (!account) return null;
  assertAccountCredentials(channel, account);
  const encrypted = await encryptSecret(JSON.stringify(account), env);
  return env.DB.prepare('INSERT INTO channel_accounts(channel_id,credentials) VALUES(?,?) ON CONFLICT(channel_id) DO UPDATE SET credentials=excluded.credentials,auth_secret=NULL,balance=NULL,next_refresh_at=0,lease_until=0,version=channel_accounts.version+1').bind(channel.id, encrypted);
}

export function accountBase(channel: GatewayChannel, dev: boolean): string {
  const base = new URL(url(channel.endpoint, dev));
  // Preserve a deployment subdirectory, but remove the API version prefix.
  base.pathname = base.pathname.replace(/\/(?:v1|v1beta)\/?$/, '').replace(/\/$/, '');
  return base.toString().replace(/\/$/, '');
}

function newApiAuthError(json: Record<string, any>): HttpError | undefined {
  // Only recognize documented categories; never place an upstream message in saved metadata.
  const code = typeof json.code === 'string' ? json.code : '';
  const message = typeof json.message === 'string' ? json.message.trim() : '';
  if (message === '无权进行此操作，未提供 New-Api-User') return new HttpError(401, '此 NewAPI 后台需要用户 ID，请在后台访问令牌配置中填写用户 ID');
  if (message === '无权进行此操作，New-Api-User 格式错误' || message === '无权进行此操作，New-Api-User 与登录用户不匹配') return new HttpError(401, '后台用户 ID 无效或与访问令牌不匹配，请检查用户 ID');
  if (['AUTH_UNAUTHORIZED', 'AUTH_TOKEN_EXPIRED', 'AUTH_SESSION_REVOKED', 'AUTH_USER_INVALID', 'ACCESS_TOKEN_EXPIRED', 'ACCESS_TOKEN_LEGACY_RETIRED'].includes(code) || [
    '无权进行此操作，未登录且未提供 access token', '无权进行此操作，access token 无效', '无权进行此操作，用户信息无效',
    'Unauthorized, not logged in and no access token provided', 'Unauthorized, invalid access token', 'Unauthorized, invalid user info', 'Unauthorized, the access token has expired',
  ].includes(message)) return new HttpError(401, '后台会话或访问令牌失效，请重新登录或更新后台访问令牌');
  if (code === 'AUTH_USER_DISABLED' || ['用户已被封禁', 'User has been banned'].includes(message)) return new HttpError(403, '后台账号已被禁用，请联系站点管理员');
  if (['AUTH_INSUFFICIENT_PRIVILEGE', 'ACCESS_TOKEN_SCOPE_DENIED', 'ACCESS_TOKEN_ROUTE_UNDECLARED', 'AUTH_SESSION_REQUIRED'].includes(code) || ['无权进行此操作，权限不足', 'Unauthorized, insufficient privileges'].includes(message)) return new HttpError(403, '后台访问令牌权限不足，请使用可读取个人资料的后台访问令牌');
  return undefined;
}

async function accountRequest(base: string, path: string, signal: AbortSignal, init: RequestInit = {}): Promise<{ json: Record<string, any>; response: Response }> {
  const response = await fetch(base + path, { ...init, redirect: 'manual', signal, headers: { Accept: 'application/json', ...init.headers } });
  const newApi = path.startsWith('/api/user/');
  if (!response.ok) {
    if (newApi && [401, 403].includes(response.status)) {
      let authError: HttpError | undefined;
      try { authError = newApiAuthError(await readUpstreamJSON(response, 512 * 1024)); }
      catch { /* An unrecognized response still retains the original HTTP status. */ }
      if (authError) throw authError;
    } else await response.body?.cancel();
    throw new HttpError(response.status, `后台接口 HTTP ${response.status}`);
  }
  const json = await readUpstreamJSON(response, 512 * 1024);
  if (path === '/api/usage/token/') {
    if (json.code !== true) throw new HttpError(502, 'BBDevLab 拒绝余额查询，请检查后台访问令牌');
  } else if (json.success === false || (json.code !== undefined && ![0, 200].includes(Number(json.code)))) throw (newApi ? newApiAuthError(json) : undefined) ?? new HttpError(502, '后台拒绝请求；请检查账号、密码及后台登录验证要求');
  return { json, response };
}

async function loginAccount(channel: GatewayChannel, credentials: PasswordCredentials, base: string, signal: AbortSignal): Promise<Session> {
  const sub = channel.config.integration === 'sub2api';
  const sendLogin = (payload: unknown) => accountRequest(base, sub ? '/api/v1/auth/login' : '/api/user/login', signal, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let login;
  try { login = await sendLogin(sub ? { email:credentials.username,password:credentials.password } : credentials); }
  catch (error) {
    if (sub) {
      if (error instanceof HttpError && [400,401,403,404,502].includes(error.status)) {
        let humanVerification = false;
        try {
          const settings = (await accountRequest(base, '/api/v1/settings/public', signal)).json;
          const data = settings.data ?? settings;
          humanVerification = ['turnstile_enabled', 'tencent_captcha_enabled', 'aliyun_captcha_enabled'].some(key => data[key] === true);
        } catch { /* Preserve the login error if public settings are unavailable. */ }
        if (humanVerification) throw new HttpError(409, '后台开启了人机验证，请在浏览器登录后改用 Cookie / 浏览器会话，并填写后台登录 Token');
      }
      throw error;
    }
    if (!(error instanceof HttpError) || ![400,401,403,502].includes(error.status)) throw error;
    const encrypted = await newApiLoginPayload(base,credentials,signal);
    if (!encrypted.password_encrypted) throw error;
    login = await sendLogin(encrypted);
  }
  const { json, response } = login;
  const data = json.data ?? json;
  if (data.requires_2fa || data.require_2fa || data.verification_required || data.require_verification || data.challenge_id || data.flow_token) throw new HttpError(409, sub ? '后台要求二次验证，暂时无法自动刷新余额' : '后台要求二次验证，请改用后台访问令牌刷新余额');
  const token = typeof data.access_token === 'string' ? data.access_token : typeof data.token === 'string' ? data.token : undefined;
  const cookies = response.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => c && !c.endsWith('=')).join('; ');
  if (!token && !cookies) throw new HttpError(502, '后台登录未返回会话；请检查账号及验证码/二次验证要求');
  const userId = data.user?.id ?? data.id;
  const expiry = Number(data.access_expires_at) * 1000;
  const expiresAt = Number.isFinite(expiry) && expiry > Date.now() ? Math.min(expiry, Date.now() + 86400000) : Date.now() + Math.min(86400, Math.max(60, Number(data.expires_in) || 3600)) * 1000;
  return { token, cookie: cookies || undefined, ...(Number.isSafeInteger(Number(userId)) && Number(userId) > 0 ? { userId: String(userId) } : {}), expiresAt, base };
}

function sessionHeaders(session: Session, browserSession = false): Record<string, string> {
  return { ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}), ...(session.cookie && (browserSession || !session.token) ? { Cookie: session.cookie } : {}), ...(session.userId ? { 'New-Api-User': session.userId } : {}) };
}
function finiteAmount(value: unknown): number {
  if (value === null || value === undefined || value === '' || !['string', 'number'].includes(typeof value) || !Number.isFinite(Number(value))) throw new HttpError(502, '后台未返回有效余额');
  return Number(value);
}

export async function fetchAccountBalance(channel: GatewayChannel, credentials: AccountCredentials, dev: boolean, cached?: Session): Promise<{ amount: number; unit: string; session: Session }> {
  const base = accountBase(channel, dev); const signal = AbortSignal.timeout(20000);
  const sub = channel.config.integration === 'sub2api';
  assertAccountCredentials(channel, credentials);
  if (channel.config.integration === 'bbdevlab' && 'accessToken' in credentials) {
    const session: Session = { token: normalizeAccessToken(credentials.accessToken), expiresAt: Date.now() + 3600000, base };
    let payload: Record<string, any>;
    try {
      payload = (await accountRequest(base, '/api/usage/token/', signal, { method: 'GET', headers: { Authorization: `Bearer ${session.token}` } })).json;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'BBDevLab 余额查询失败，请检查后台连接与访问令牌');
    }
    const raw = payload.data?.total_available;
    const available = finiteAmount(typeof raw === 'string' ? raw.trim() : raw);
    return { amount: Math.trunc(available / 100000) || 0, unit: '余额', session };
  }
  const cookieMode = 'cookie' in credentials;
  const directMode = cookieMode || 'accessToken' in credentials;
  const reusedSession = !directMode && !!cached && cached.base === base && cached.expiresAt > Date.now() + 10000;
  let session: Session;
  if ('cookie' in credentials) session = { cookie: credentials.cookie, token: credentials.accessToken, expiresAt: Date.now() + 3600000, base };
  else if ('accessToken' in credentials) session = { token: normalizeAccessToken(credentials.accessToken), userId: credentials.userId, expiresAt: Date.now() + 3600000, base };
  else session = reusedSession ? cached! : await loginAccount(channel, credentials, base, signal);
  const profile = async () => {
    const init = { headers: sessionHeaders(session, cookieMode) };
    try { return (await accountRequest(base, sub ? '/api/v1/user/profile' : '/api/user/self', signal, init)).json; }
    catch (error) {
      // Both official Sub2API routes return the user balance. Only a missing route
      // warrants compatibility fallback; an authentication rejection must stop.
      if (!sub || !(error instanceof HttpError) || error.status !== 404) throw error;
      return (await accountRequest(base, '/api/v1/auth/me', signal, init)).json;
    }
  };
  let payload: Record<string, any>;
  try { payload = await profile(); }
  catch (error) {
    if (cookieMode && error instanceof HttpError && [401, 403].includes(error.status)) throw new HttpError(error.status, 'Cookie / 浏览器会话已失效或被后台拒绝，请重新登录并更新 Cookie 与后台登录 Token；标准 Sub2API 需要后台登录 Token');
    if (directMode || !reusedSession || !(error instanceof HttpError) || ![401, 403].includes(error.status) || 'cookie' in credentials || 'accessToken' in credentials) throw error;
    session = await loginAccount(channel, credentials, base, signal); payload = await profile();
  }
  const data = payload.data ?? payload;
  if (sub) return { amount: finiteAmount(data.balance), unit: 'USD', session };
  const quota = finiteAmount(data.quota);
  // A custom site may use a different quota scale; never assume 500000.
  let scale: number | null = null;
  try {
    const status = (await accountRequest(base, '/api/status', signal)).json;
    const value = Number((status.data ?? status).quota_per_unit);
    if (Number.isFinite(value) && value > 0) scale = value;
  } catch { /* Raw quota is still a valid balance when currency metadata is unavailable. */ }
  return { amount: scale ? quota / scale : quota, unit: scale ? 'USD' : '额度', session };
}

export async function refreshAccountBalance(env: Env, channel: GatewayChannel, dev: boolean, force = false): Promise<void> {
  if (!isAccountIntegration(channel.config.integration) || channel.config.integration === 'bbdevlab') return;
  const now = Date.now();
  // Capture the destination and credentials in one atomic read. A Cron snapshot can
  // outlive a channel edit; never pair a new password with that snapshot's old URL.
  const claimed = await env.DB.prepare("UPDATE channel_accounts SET lease_until=? WHERE channel_id=? AND lease_until<=? AND (?=1 OR next_refresh_at<=?) AND EXISTS (SELECT 1 FROM channels c WHERE c.id=channel_accounts.channel_id AND COALESCE(json_extract(c.data,'$.archived'),0)=0 AND json_extract(c.data,'$.config.integration') IN ('newapi','sub2api')) RETURNING *, (SELECT data FROM channels WHERE id=channel_accounts.channel_id) AS channel_data").bind(now + 45000, channel.id, now, force ? 1 : 0, now).first<AccountRow>();
  if (!claimed) return;
  const old = claimed.balance ? JSON.parse(claimed.balance) as Balance : null;
  try {
    const credentials = JSON.parse(await decryptSecret(claimed.credentials, env)) as AccountCredentials;
    const session = claimed.auth_secret ? JSON.parse(await decryptSecret(claimed.auth_secret, env)) as Session : undefined;
    const currentChannel = JSON.parse(claimed.channel_data) as GatewayChannel;
    const result = await fetchAccountBalance(currentChannel, credentials, dev, session);
    const balance: Balance = { status: 'ok', amount: result.amount, unit: result.unit, updatedAt: new Date().toISOString(), checkedAt: new Date().toISOString() };
    const auth = await encryptSecret(JSON.stringify(result.session), env);
    await env.DB.prepare('UPDATE channel_accounts SET balance=?,auth_secret=?,next_refresh_at=?,lease_until=0 WHERE channel_id=? AND version=?').bind(JSON.stringify(balance), auth, now + BALANCE_REFRESH_MS, channel.id, claimed.version).run();
  } catch (error) {
    // Do not copy provider error bodies, account IDs or session tokens into metadata.
    const message = error instanceof HttpError ? error.message : '余额刷新失败，请检查后台连接与加密配置';
    const balance: Balance = { status: 'error', amount: old?.amount ?? null, unit: old?.unit ?? '', updatedAt: old?.updatedAt ?? null, checkedAt: new Date().toISOString(), error: message };
    await env.DB.prepare('UPDATE channel_accounts SET balance=?,next_refresh_at=?,lease_until=0 WHERE channel_id=? AND version=?').bind(JSON.stringify(balance), now + BALANCE_REFRESH_MS, channel.id, claimed.version).run();
  }
}

export async function refreshDueAccounts(env: Env, channels: GatewayChannel[], dev: boolean, limit = 5): Promise<void> {
  // A rejected cached session plus encrypted NewAPI login can require seven fetches.
  // Five accounts plus eight recovery probes stay below the Free plan's 50 external fetches.
  const boundedLimit = Math.min(5, Math.max(0, Math.floor(limit)));
  const due = await env.DB.prepare("SELECT a.channel_id FROM channel_accounts a JOIN channels c ON c.id=a.channel_id WHERE a.next_refresh_at<=? AND a.lease_until<=? AND COALESCE(json_extract(c.data,'$.archived'),0)=0 AND json_extract(c.data,'$.config.integration') IN ('newapi','sub2api') ORDER BY a.next_refresh_at LIMIT ?").bind(Date.now(), Date.now(), boundedLimit).all<{ channel_id: string }>();
  // Bounded batches leave headroom for normal gateway traffic and Cron subrequest limits.
  for (let i = 0; i < due.results.length; i += 3) {
    await Promise.allSettled(due.results.slice(i, i + 3).map(({ channel_id }) => {
      const channel = channels.find(c => c.id === channel_id);
      return channel ? refreshAccountBalance(env, channel, dev) : Promise.resolve();
    }));
  }
}
