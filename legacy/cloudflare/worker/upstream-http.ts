import { HttpError } from './validation';

/** Bounded JSON reads keep management fetches from buffering arbitrary upstream bodies. */
export async function readUpstreamJSON(response: Response, limit = 2 * 1024 * 1024): Promise<Record<string, any>> {
  if (!response.body) throw new HttpError(502, '上游未返回 JSON');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) throw new HttpError(502, '上游响应超过大小限制');
      parts.push(value);
    }
    const buffer = new Uint8Array(size); let offset = 0;
    for (const part of parts) { buffer.set(part, offset); offset += part.length; }
    const parsed = JSON.parse(new TextDecoder().decode(buffer));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, '上游返回的 JSON 无效');
  } finally { reader.releaseLock(); }
}
