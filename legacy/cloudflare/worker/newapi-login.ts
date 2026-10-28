import { readUpstreamJSON } from "./upstream-http";
import { HttpError } from "./validation";

type Credentials = { username: string; password: string };
const encoder = new TextEncoder();

async function handshakeJSON(
  base: string,
  path: string,
  signal: AbortSignal,
  limit: number,
): Promise<Record<string, unknown>> {
  if (signal.aborted) throw new HttpError(504, "NewAPI 登录握手超时或已取消");
  let response: Response;
  try {
    response = await fetch(base + path, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new HttpError(
      signal.aborted ? 504 : 502,
      signal.aborted
        ? "NewAPI 登录握手超时或已取消"
        : "NewAPI 登录握手连接失败",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(502, `NewAPI 登录握手失败（HTTP ${response.status}）`);
  }
  const json = await readUpstreamJSON(response, limit);
  if (signal.aborted) throw new HttpError(504, "NewAPI 登录握手超时或已取消");
  if (
    json.success === false ||
    (json.code !== undefined && ![0, 200].includes(Number(json.code)))
  ) {
    throw new HttpError(502, "NewAPI 登录握手被后台拒绝");
  }
  const data: unknown = json.data ?? json;
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new HttpError(502, "NewAPI 登录握手返回格式无效");
  return data as Record<string, unknown>;
}

function encodeBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodePublicKey(value: unknown): ArrayBuffer {
  if (typeof value !== "string" || value.length > 16_384)
    throw new HttpError(502, "NewAPI 登录公钥格式无效");
  const pem =
    /^\s*-----BEGIN PUBLIC KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PUBLIC KEY-----\s*$/.exec(
      value,
    );
  if (!pem) throw new HttpError(502, "NewAPI 登录公钥格式无效");
  try {
    const binary = atob(pem[1].replace(/\s/g, ""));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
      .buffer;
  } catch {
    throw new HttpError(502, "NewAPI 登录公钥格式无效");
  }
}

async function encryptPassword(
  password: string,
  publicKey: unknown,
  keyId: string,
): Promise<string> {
  try {
    const rsa = await crypto.subtle.importKey(
      "spki",
      decodePublicKey(publicKey),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
    const modulusLength = (rsa.algorithm as { modulusLength: number })
      .modulusLength;
    if (modulusLength < 2048 || modulusLength > 8192)
      throw new HttpError(502, "NewAPI 登录公钥长度无效");
    const plaintext = encoder.encode(password);
    // NewAPI's current server accepts up to 128 Unicode code points / 512 UTF-8 bytes.
    if (!plaintext.byteLength || plaintext.byteLength > 512)
      throw new HttpError(400, "NewAPI 加密登录密码超出后台支持的长度");
    if (plaintext.byteLength <= modulusLength / 8 - 66) {
      return encodeBase64(
        await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, plaintext),
      );
    }
    // Wire format: RSA-OAEP/SHA-256 wraps AES-256; GCM binds the password to the key ID.
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const aes = await crypto.subtle.importKey(
      "raw",
      secret,
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    const wrapped = await crypto.subtle.encrypt(
      { name: "RSA-OAEP", label: encoder.encode("password-v2") },
      rsa,
      secret,
    );
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: encoder.encode("password-v2:" + keyId),
        tagLength: 128,
      },
      aes,
      plaintext,
    );
    return [
      "v2",
      encodeBase64(wrapped),
      encodeBase64(nonce.buffer),
      encodeBase64(ciphertext),
    ].join(".");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "NewAPI 登录密码加密失败，请检查后台公钥配置");
  }
}

/** Build the optional NewAPI encrypted-password login payload without performing a login.
 * Protocol reference: QuantumNous/new-api common/password_crypto.go and router/api-router.go.
 */
export async function newApiLoginPayload(
  base: string,
  credentials: Credentials,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const normalizedBase = base.replace(/\/$/, "");
  const status = await handshakeJSON(
    normalizedBase,
    "/api/status",
    signal,
    512 * 1024,
  );
  if (status.password_login_enabled === false)
    throw new HttpError(409, "此 NewAPI 后台已关闭密码登录，请改用后台访问令牌刷新余额");
  if (status.turnstile_check === true)
    throw new HttpError(409, "此 NewAPI 后台登录需要 Turnstile 人机验证，请改用后台访问令牌刷新余额");
  const enabled = status.password_login_encryption_enabled;
  if (enabled === undefined || enabled === false)
    return { username: credentials.username, password: credentials.password };
  if (enabled !== true) throw new HttpError(502, "NewAPI 登录加密状态无效");
  const key = await handshakeJSON(
    normalizedBase,
    "/api/user/login/encryption-key",
    signal,
    32 * 1024,
  );
  if (key.enabled === false)
    throw new HttpError(502, "NewAPI 登录加密配置已变化，请重试");
  if (typeof key.kid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(key.kid))
    throw new HttpError(502, "NewAPI 登录公钥标识无效");
  const encrypted = await encryptPassword(
    credentials.password,
    key.public_key,
    key.kid,
  );
  if (signal.aborted) throw new HttpError(504, "NewAPI 登录握手超时或已取消");
  return {
    username: credentials.username,
    password_encrypted: encrypted,
    encryption_key_id: key.kid,
  };
}
