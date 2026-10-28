import { describe, expect, it } from 'vitest';
import { createDatabaseDrafts, databaseError, databasePayload, passwordError, publicUrlError, setupLoginDestination, setupPublicUrl } from '../src/setup';

describe('first deployment configuration', () => {
  it('uses the server SQLite location and independent MySQL/PostgreSQL ports', () => {
    const drafts = createDatabaseDrafts({ sqlitePath: '/data/pulsegate.db', host: 'db' });
    expect(drafts.sqlite.path).toBe('/data/pulsegate.db');
    expect(drafts.mysql.port).toBe(3306);
    expect(drafts.pgsql.port).toBe(5432);
    expect(drafts.mysql.host).toBe('db');
  });

  it('preserves each database draft and its password when switching types', () => {
    const drafts = createDatabaseDrafts();
    drafts.mysql.host = 'mysql'; drafts.mysql.password = '  mysql secret  ';
    drafts.pgsql.host = 'postgres'; drafts.pgsql.password = 'pg secret';
    expect(databasePayload(drafts.mysql)).toMatchObject({ type: 'mysql', host: 'mysql', port: 3306, password: '  mysql secret  ' });
    expect(databasePayload(drafts.pgsql)).toMatchObject({ type: 'pgsql', host: 'postgres', port: 5432, password: 'pg secret' });
    expect(drafts.sqlite.password).toBe('');
  });

  it('sends only the selected backend configuration and leaves secrets intact', () => {
    const drafts = createDatabaseDrafts();
    drafts.sqlite.path = ' /data/app.db ';
    expect(databasePayload(drafts.sqlite)).toEqual({ type: 'sqlite', path: '/data/app.db' });
    drafts.mysql.host = ' db '; drafts.mysql.name = ' gateway '; drafts.mysql.user = ' admin '; drafts.mysql.port = '3307';
    drafts.mysql.password = ' password ';
    expect(databasePayload(drafts.mysql)).toEqual({ type: 'mysql', host: 'db', port: 3307, name: 'gateway', user: 'admin', password: ' password ', sslMode: 'disable' });
  });

  it('validates only the chosen database fields and rejects invalid TCP ports', () => {
    const drafts = createDatabaseDrafts();
    drafts.sqlite.host = ''; drafts.sqlite.port = '';
    expect(databaseError(drafts.sqlite)).toBe('');
    drafts.sqlite.path = '  ';
    expect(databaseError(drafts.sqlite)).not.toBe('');
    for (const port of ['', ' ', 'abc', 0, 65536, 3306.5]) {
      drafts.mysql.port = port;
      expect(databaseError(drafts.mysql), String(port)).not.toBe('');
    }
    drafts.mysql.port = 65535;
    expect(databaseError(drafts.mysql)).toBe('');
    drafts.mysql.name = '';
    expect(databaseError(drafts.mysql)).not.toBe('');
  });

  it('requires seven characters without complexity rules and preserves bcrypt limits and confirmation', () => {
    expect(passwordError('123456', '123456')).not.toBe('');
    expect(passwordError('1234567', '1234567')).toBe('');
    expect(passwordError('a'.repeat(7), 'a'.repeat(7))).toBe('');
    expect(passwordError('密'.repeat(6), '密'.repeat(6))).not.toBe('');
    expect(passwordError('密'.repeat(7), '密'.repeat(7))).toBe('');
    expect(passwordError('🔑'.repeat(6), '🔑'.repeat(6))).not.toBe('');
    expect(passwordError('🔑'.repeat(7), '🔑'.repeat(7))).toBe('');
    expect(passwordError('a'.repeat(72), 'a'.repeat(72))).toBe('');
    expect(passwordError('密'.repeat(24), '密'.repeat(24))).toBe('');
    expect(passwordError('密'.repeat(25), '密'.repeat(25))).not.toBe('');
    expect(passwordError('a'.repeat(73), 'a'.repeat(73))).not.toBe('');
    expect(passwordError(' '.repeat(12), ' '.repeat(12))).not.toBe('');
    expect(passwordError(' long secret ', 'long secret')).not.toBe('');
    expect(passwordError(' long secret ', ' long secret ')).toBe('');
  });

  it('accepts optional HTTP(S) origins and rejects URLs with credentials or paths', () => {
    for (const value of ['', 'http://localhost:8787', 'https://gateway.example.com/', '  https://gateway.example.com  ']) expect(publicUrlError(value), value).toBe('');
    for (const value of ['gateway.example.com', 'ftp://gateway.example.com', 'https://user:secret@gateway.example.com', 'https://gateway.example.com/v1', 'https://gateway.example.com/?secret=x', 'https://gateway.example.com/#admin']) expect(publicUrlError(value), value).not.toBe('');
  });

  it('keeps automatic login on the current origin and normalizes equivalent origins', () => {
    for (const value of ['', 'https://gateway.example.com', 'https://gateway.example.com/', '  https://gateway.example.com:443  ']) expect(setupLoginDestination(value, 'https://gateway.example.com'), value).toBeNull();
  });

  it('requires a fresh login on a changed host, protocol or port without credentials in the link', () => {
    expect(setupLoginDestination('https://public.example.com', 'http://localhost:8787')).toBe('https://public.example.com/');
    expect(setupLoginDestination('https://gateway.example.com', 'http://gateway.example.com')).toBe('https://gateway.example.com/');
    expect(setupLoginDestination('http://localhost:9090', 'http://localhost:8787')).toBe('http://localhost:9090/');
    for (const value of ['javascript:alert(1)', 'https://user:password@public.example.com/', 'https://public.example.com/?password=secret']) expect(setupLoginDestination(value, 'http://localhost:8787'), value).toBeNull();
  });

  it('uses the server PUBLIC_URL for submission and the login link when configured', () => {
    const effective = setupPublicUrl('http://another.example.com', '  https://gateway.example.com  ');
    expect(effective).toBe('https://gateway.example.com');
    expect(setupLoginDestination(effective, 'http://localhost:8787')).toBe('https://gateway.example.com/');
    expect(setupPublicUrl(' https://chosen.example.com ', '')).toBe('https://chosen.example.com');
    expect(setupPublicUrl('', undefined)).toBe('');
  });
});
