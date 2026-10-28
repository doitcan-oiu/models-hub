import type { Env } from './env';

const encoder = new TextEncoder();
const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromBase64 = (str: string): Uint8Array => Uint8Array.from(atob(str), c => c.charCodeAt(0));
export async function hashToken(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
export function randomToken(prefix = 'pg_live_'): string {
  return prefix + toBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function previewToken(token: string): string { return `pg_live_••••${token.slice(-4)}`; }
export function redact(value: string | null): string | null {
  if (value === null) return null;
  return value.slice(0, 16000).replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/(?:sk-|pg_live_|AIza)[a-zA-Z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/([?&](?:key|api_key|token|access_token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/("?(?:api[_-]?key|authorization|secret|token|password)"?\s*[:=]\s*")[^"]+/gi, '$1[REDACTED]');
}
async function encryptionKey(env: Env): Promise<CryptoKey> {
  if (!env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY is required to store upstream credentials');
  let bytes: Uint8Array;
  try { bytes = fromBase64(env.ENCRYPTION_KEY); } catch { throw new Error('ENCRYPTION_KEY must be a base64 encoded 32 byte key'); }
  if (bytes.byteLength !== 32) throw new Error('ENCRYPTION_KEY must be a base64 encoded 32 byte key');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptSecret(value: string, env: Env): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(env), encoder.encode(value));
  return `v1:${toBase64(iv)}:${toBase64(new Uint8Array(data))}`;
}
export async function decryptSecret(value: string, env: Env): Promise<string> {
  const [version, iv, cipher] = value.split(':');
  if (version !== 'v1' || !iv || !cipher) throw new Error('Unsupported encrypted credential');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, await encryptionKey(env), fromBase64(cipher)));
}
