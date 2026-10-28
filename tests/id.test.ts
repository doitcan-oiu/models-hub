import { afterEach, describe, expect, it, vi } from 'vitest';
import { createId } from '../shared/id';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('browser-compatible identifiers', () => {
  it('uses native UUID generation with its crypto receiver when available', () => {
    const source = { randomUUID: vi.fn(function (this: unknown) {
      expect(this).toBe(source);
      return 'fc17bcaa-a174-480e-ab75-a5119b7b99e9';
    }), getRandomValues: vi.fn() };
    vi.stubGlobal('crypto', source);
    expect(createId()).toBe('fc17bcaa-a174-480e-ab75-a5119b7b99e9');
    expect(source.randomUUID).toHaveBeenCalledOnce();
    expect(source.getRandomValues).not.toHaveBeenCalled();
  });

  it('generates correctly formatted v4 UUIDs without randomUUID', () => {
    let counter = 0;
    const source = { getRandomValues: vi.fn(function (this: unknown, bytes: Uint8Array) {
      expect(this).toBe(source);
      bytes.fill(0xff);
      bytes[0] = counter++;
      return bytes;
    }) };
    vi.stubGlobal('crypto', source);
    const ids = Array.from({ length: 100 }, createId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids[0]).toBe('00ffffff-ffff-4fff-bfff-ffffffffffff');
  });

  it.each([undefined, {}])('keeps local UI identifiers distinct without Web Crypto (%j)', source => {
    vi.stubGlobal('crypto', source);
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    const ids = Array.from({ length: 1000 }, createId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(id => id.startsWith('local-'))).toBe(true);
  });
});
