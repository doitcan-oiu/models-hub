export type DatabaseType = 'sqlite' | 'mysql' | 'pgsql';
export type DatabaseSetup = {
  type: DatabaseType;
  path: string;
  host: string;
  port: number | string;
  name: string;
  user: string;
  password: string;
  sslMode: 'disable' | 'require' | 'verify-full';
};
export type SetupStatus = {
  initialized: boolean;
  defaults?: { databaseType?: DatabaseType; sqlitePath?: string; host?: string; port?: number; database?: string; username?: string; sslMode?: string; publicUrl?: string };
  databaseTypes?: DatabaseType[];
};
export type SetupPayload = { adminPassword: string; confirmPassword: string; publicUrl: string; database: ReturnType<typeof databasePayload> };
export const databaseLabels: Record<DatabaseType, string> = { sqlite: 'SQLite', mysql: 'MySQL', pgsql: 'PostgreSQL' };

export function createDatabaseDrafts(defaults: SetupStatus['defaults'] = {}): Record<DatabaseType, DatabaseSetup> {
  const common = { path: defaults.sqlitePath || 'data/pulsegate.db', host: defaults.host || '127.0.0.1', name: defaults.database || 'pulsegate', user: defaults.username || 'pulsegate', password: '', sslMode: 'disable' as const };
  return {
    sqlite: { ...common, type: 'sqlite', port: 0 },
    mysql: { ...common, type: 'mysql', port: 3306 },
    pgsql: { ...common, type: 'pgsql', port: defaults.port || 5432 },
  };
}

export function passwordError(password: string, confirmation: string): string {
  const bytes = new TextEncoder().encode(password).length;
  if ([...password].length < 7) return '管理员密码至少需要 7 个字符。';
  if (bytes > 72) return '管理员密码不能超过 72 个字节。';
  if (!password.trim()) return '管理员密码不能全部为空格。';
  if (password !== confirmation) return '两次输入的管理员密码不一致。';
  return '';
}

export function databaseError(database: DatabaseSetup): string {
  if (database.type === 'sqlite') return database.path.trim() ? '' : '请填写 SQLite 数据库文件路径。';
  if (!database.host.trim()) return '请填写数据库主机地址。';
  const port = Number(database.port);
  if (!String(database.port).trim() || !Number.isInteger(port) || port < 1 || port > 65535) return '数据库端口须为 1–65535 的整数。';
  if (!database.name.trim()) return '请填写数据库名称。';
  if (!database.user.trim()) return '请填写数据库用户名。';
  return '';
}

export function publicUrlError(value: string): string {
  if (!value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return '';
  } catch { return '请输入完整的 HTTP 或 HTTPS 访问地址，不包含路径、参数或账号密码。'; }
}

export function setupPublicUrl(entered: string, configured?: string): string {
  return configured?.trim() || entered.trim();
}

/** A changed public origin requires a fresh login on that site's cookie scope. */
export function setupLoginDestination(publicUrl: string, currentOrigin: string): string | null {
  if (publicUrlError(publicUrl)) return null;
  const current = new URL(currentOrigin).origin;
  const target = publicUrl.trim() ? new URL(publicUrl.trim()).origin : current;
  return target === current ? null : target + '/';
}

export function databasePayload(database: DatabaseSetup) {
  if (database.type === 'sqlite') return { type: database.type, path: database.path.trim() };
  return { type: database.type, host: database.host.trim(), port: Number(database.port), name: database.name.trim(), user: database.user.trim(), password: database.password, sslMode: database.sslMode };
}
