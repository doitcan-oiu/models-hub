let localSequence = 0;

/** Identifiers for UI state and events, never authentication tokens or secrets. */
export function createId(): string {
  const source = globalThis.crypto;
  if (typeof source?.randomUUID === 'function') return source.randomUUID();
  if (typeof source?.getRandomValues !== 'function') {
    return `local-${Date.now().toString(36)}-${(++localSequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  // getRandomValues also works over HTTP, where randomUUID may be unavailable.
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
