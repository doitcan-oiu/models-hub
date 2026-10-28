import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { newApiLoginPayload } from "../worker/newapi-login";
import { HttpError } from "../worker/validation";

const base = "https://newapi.example.com/deployment";
const credentials = {
  username: "account-name",
  password: " 密码-with-spaces 🔐 ",
};
const keyId = "fixture-key-2026";
let fixture: CryptoKeyPair;
let publicKeyPEM: string;

function toBase64(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}
function fromBase64(value: string): ArrayBuffer {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
    .buffer;
}
function success(data: unknown): Response {
  return Response.json({ success: true, data });
}
function keyResponse(overrides: Record<string, unknown> = {}): Response {
  return success({
    enabled: true,
    kid: keyId,
    public_key: publicKeyPEM,
    ...overrides,
  });
}
function mockFetch(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  fetch.mockRejectedValue(new Error("Unexpected NewAPI handshake fetch"));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
function encryptedMock() {
  return mockFetch(
    success({ password_login_encryption_enabled: true }),
    keyResponse(),
  );
}
async function decryptPayload(value: string, kid = keyId): Promise<string> {
  let plaintext: ArrayBuffer;
  if (!value.startsWith("v2.")) {
    plaintext = await crypto.subtle.decrypt(
      { name: "RSA-OAEP" },
      fixture.privateKey,
      fromBase64(value),
    );
  } else {
    const [version, wrapped, nonce, encrypted] = value.split(".");
    expect(version).toBe("v2");
    const secret = await crypto.subtle.decrypt(
      { name: "RSA-OAEP", label: new TextEncoder().encode("password-v2") },
      fixture.privateKey,
      fromBase64(wrapped),
    );
    expect(secret.byteLength).toBe(32);
    const aes = await crypto.subtle.importKey(
      "raw",
      secret,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    expect(fromBase64(nonce).byteLength).toBe(12);
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(nonce),
        additionalData: new TextEncoder().encode("password-v2:" + kid),
        tagLength: 128,
      },
      aes,
      fromBase64(encrypted),
    );
  }
  return new TextDecoder().decode(plaintext);
}
function expectSafeFailure(error: unknown, status = 502) {
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).status).toBe(status);
  expect((error as Error).message).not.toContain(credentials.password);
  expect((error as Error).message).not.toContain(credentials.username);
  expect((error as Error).message).not.toContain("private-response-detail");
}

beforeAll(async () => {
  fixture = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const encoded = toBase64(
    await crypto.subtle.exportKey("spki", fixture.publicKey),
  );
  publicKeyPEM =
    "-----BEGIN PUBLIC KEY-----\n" +
    encoded.match(/.{1,64}/g)!.join("\n") +
    "\n-----END PUBLIC KEY-----";
});
afterEach(() => vi.unstubAllGlobals());

describe("NewAPI optional password encryption handshake", () => {
  it.each([false, undefined])(
    "returns the original credentials for encryption status %s without fetching a key",
    async (enabled) => {
      const fetch = mockFetch(
        success({ password_login_encryption_enabled: enabled }),
      );
      const signal = new AbortController().signal;
      expect(await newApiLoginPayload(base + "/", credentials, signal)).toEqual(
        credentials,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0];
      expect(url).toBe(base + "/api/status");
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(init?.signal).toBe(signal);
      expect(init?.redirect).toBe("manual");
    },
  );

  it("uses the official encryption-key endpoint and produces RSA-OAEP/SHA-256 ciphertext", async () => {
    const fetch = encryptedMock();
    const signal = new AbortController().signal;
    const payload = await newApiLoginPayload(base, credentials, signal);
    expect(Object.keys(payload).sort()).toEqual([
      "encryption_key_id",
      "password_encrypted",
      "username",
    ]);
    expect(payload.username).toBe(credentials.username);
    expect(payload.encryption_key_id).toBe(keyId);
    expect(payload.password).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(credentials.password);
    const ciphertext = payload.password_encrypted as string;
    expect(ciphertext).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(fromBase64(ciphertext).byteLength).toBe(256);
    expect(await decryptPayload(ciphertext)).toBe(credentials.password);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      base + "/api/status",
      base + "/api/user/login/encryption-key",
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBe(signal);
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get("Accept")).toBe("application/json");
      expect(new Headers(init?.headers).get("Authorization")).toBeNull();
    }
  });

  it("uses fresh randomized ciphertext for each login payload", async () => {
    mockFetch(
      success({ password_login_encryption_enabled: true }),
      keyResponse(),
      success({ password_login_encryption_enabled: true }),
      keyResponse(),
    );
    const first = await newApiLoginPayload(
      base,
      credentials,
      new AbortController().signal,
    );
    const second = await newApiLoginPayload(
      base,
      credentials,
      new AbortController().signal,
    );
    expect(first.password_encrypted).not.toBe(second.password_encrypted);
    expect(await decryptPayload(first.password_encrypted as string)).toBe(
      credentials.password,
    );
    expect(await decryptPayload(second.password_encrypted as string)).toBe(
      credentials.password,
    );
  });

  it("supports long Unicode passwords with the server-compatible AES-GCM v2 envelope", async () => {
    encryptedMock();
    const password = "密码🚀".repeat(32);
    expect(new TextEncoder().encode(password).byteLength).toBeGreaterThan(190);
    const payload = await newApiLoginPayload(
      base,
      { ...credentials, password },
      new AbortController().signal,
    );
    expect((payload.password_encrypted as string).startsWith("v2.")).toBe(true);
    expect(await decryptPayload(payload.password_encrypted as string)).toBe(
      password,
    );
    await expect(
      decryptPayload(payload.password_encrypted as string, "different-key-id"),
    ).rejects.toThrow();
  });

  it.each([190, 191])(
    "chooses the RSA/v2 format based on UTF-8 plaintext length (%s bytes)",
    async (count) => {
      encryptedMock();
      const password = "x".repeat(count);
      const payload = await newApiLoginPayload(
        base,
        { ...credentials, password },
        new AbortController().signal,
      );
      expect((payload.password_encrypted as string).startsWith("v2.")).toBe(
        count > 190,
      );
      expect(await decryptPayload(payload.password_encrypted as string)).toBe(
        password,
      );
    },
  );
});

describe("NewAPI encryption handshake failure boundaries", () => {
  it.each([
    [{ turnstile_check: true, password_login_encryption_enabled: true }, "Turnstile"],
    [{ turnstile_check: true }, "Turnstile"],
    [{ password_login_enabled: false, password_login_encryption_enabled: true }, "关闭密码登录"],
  ])("reports required human verification or disabled password login before requesting encryption keys: %s", async (status, message) => {
    const fetch = mockFetch(success({ ...status, message: credentials.password }));
    const error = await newApiLoginPayload(base, credentials, new AbortController().signal).catch(error => error);
    expectSafeFailure(error, 409);
    expect(error.message).toContain(message);
    expect(error.message).toContain("后台访问令牌");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(base + "/api/status");
  });

  it("rejects a non-boolean encryption flag instead of silently downgrading to plaintext", async () => {
    const fetch = mockFetch(
      success({
        password_login_encryption_enabled: "true",
        message: credentials.password,
      }),
    );
    expectSafeFailure(
      await newApiLoginPayload(
        base,
        credentials,
        new AbortController().signal,
      ).catch((error) => error),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a status/key configuration race without producing a plaintext password payload", async () => {
    mockFetch(
      success({ password_login_encryption_enabled: true }),
      keyResponse({ enabled: false }),
    );
    expectSafeFailure(
      await newApiLoginPayload(
        base,
        credentials,
        new AbortController().signal,
      ).catch((error) => error),
    );
  });

  it.each([
    { kid: "" },
    { kid: "x".repeat(129) },
    { kid: "bad\nkey" },
    { public_key: "" },
    { public_key: 123 },
    {
      public_key:
        "-----BEGIN PUBLIC KEY-----\nnot-valid-base64!\n-----END PUBLIC KEY-----",
    },
    {
      public_key: "-----BEGIN PUBLIC KEY-----\nYWJj\n-----END PUBLIC KEY-----",
    },
  ])(
    "rejects invalid key metadata without exposing upstream details: %s",
    async (overrides) => {
      mockFetch(
        success({ password_login_encryption_enabled: true }),
        keyResponse({ ...overrides, message: credentials.password }),
      );
      expectSafeFailure(
        await newApiLoginPayload(
          base,
          credentials,
          new AbortController().signal,
        ).catch((error) => error),
      );
    },
  );

  it("rejects weak RSA keys even when WebCrypto can import them", async () => {
    const weak = await crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 1024,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["encrypt", "decrypt"],
    );
    const public_key =
      "-----BEGIN PUBLIC KEY-----\n" +
      toBase64(await crypto.subtle.exportKey("spki", weak.publicKey)) +
      "\n-----END PUBLIC KEY-----";
    mockFetch(
      success({ password_login_encryption_enabled: true }),
      keyResponse({ public_key }),
    );
    expectSafeFailure(
      await newApiLoginPayload(
        base,
        credentials,
        new AbortController().signal,
      ).catch((error) => error),
    );
  });

  it("rejects passwords exceeding the official encrypted-login byte limit without sending them", async () => {
    const fetch = encryptedMock();
    expectSafeFailure(
      await newApiLoginPayload(
        base,
        { ...credentials, password: "x".repeat(513) },
        new AbortController().signal,
      ).catch((error) => error),
      400,
    );
    expect(fetch.mock.calls.every(([, init]) => init?.body === undefined)).toBe(
      true,
    );
  });

  it.each(["status", "key"] as const)(
    "bounds the %s response read and does not include its body in errors",
    async (endpoint) => {
      const oversized = success({
        padding:
          "private-response-detail" +
          credentials.password +
          "x".repeat(endpoint === "status" ? 512 * 1024 : 32 * 1024),
      });
      const fetch =
        endpoint === "status"
          ? mockFetch(oversized)
          : mockFetch(
              success({ password_login_encryption_enabled: true }),
              oversized,
            );
      expectSafeFailure(
        await newApiLoginPayload(
          base,
          credentials,
          new AbortController().signal,
        ).catch((error) => error),
      );
      expect(fetch).toHaveBeenCalledTimes(endpoint === "status" ? 1 : 2);
    },
  );

  it.each([302, 403, 500])(
    "sanitizes HTTP %s failures and never follows an external redirect",
    async (status) => {
      const fetch = mockFetch(
        new Response(credentials.password + "private-response-detail", {
          status,
          headers: { Location: "https://foreign.example.com/key" },
        }),
      );
      expectSafeFailure(
        await newApiLoginPayload(
          base,
          credentials,
          new AbortController().signal,
        ).catch((error) => error),
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][1]?.redirect).toBe("manual");
    },
  );

  it("sanitizes structured rejection and malformed JSON errors", async () => {
    mockFetch(
      Response.json({
        success: false,
        message: credentials.password + "private-response-detail",
      }),
    );
    expectSafeFailure(
      await newApiLoginPayload(
        base,
        credentials,
        new AbortController().signal,
      ).catch((error) => error),
    );
    mockFetch(new Response(credentials.password + "private-response-detail"));
    expectSafeFailure(
      await newApiLoginPayload(
        base,
        credentials,
        new AbortController().signal,
      ).catch((error) => error),
    );
  });

  it("does not fetch when cancelled and does not expose a custom abort reason", async () => {
    const controller = new AbortController();
    controller.abort(credentials.password);
    const fetch = mockFetch();
    expectSafeFailure(
      await newApiLoginPayload(base, credentials, controller.signal).catch(
        (error) => error,
      ),
      504,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honors cancellation between status and key requests", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      controller.abort(credentials.password);
      return success({ password_login_encryption_enabled: true });
    });
    vi.stubGlobal("fetch", fetch);
    expectSafeFailure(
      await newApiLoginPayload(base, credentials, controller.signal).catch(
        (error) => error,
      ),
      504,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sanitizes transport errors that may contain sensitive request diagnostics", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValue(
          new TypeError(credentials.password + "private-response-detail"),
        ),
    );
    expectSafeFailure(
      await newApiLoginPayload(
        base,
        credentials,
        new AbortController().signal,
      ).catch((error) => error),
    );
  });
});
