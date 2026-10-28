import { describe, expect, it } from 'vitest';
import { apiKeyExpired, usableApiKey } from '../src/access-policy';
import { consoleRouteHash, readConsoleRoute } from '../src/navigation';
import { splitSSEFrames } from '../src/playground-stream';
import { routingSettingsPatch } from '../src/settings-patch';
import { defaultSettings } from '../shared/types';

describe('routing settings patches', () => {
  it('only submits changed routing fields and never replays unrelated connection values', () => {
    const baseline = { ...structuredClone(defaultSettings), account: 'old-account', gateway: 'old-gateway', logRetentionDays: 7 };
    const draft = { ...baseline, threshold: 12, account: 'stale-account', gateway: 'stale-gateway', logRetentionDays: 14, notifications: false };
    const patch = routingSettingsPatch(baseline, draft);
    expect(patch).toEqual({ threshold: 12 });
    const latest = { ...baseline, account: 'new-account', gateway: 'new-gateway', logRetentionDays: 90, maxChannelRetries: 6 };
    expect({ ...latest, ...patch }).toMatchObject({ account: 'new-account', gateway: 'new-gateway', logRetentionDays: 90, maxChannelRetries: 6, threshold: 12 });
  });

  it('detects changed status arrays by value and omits restored or unchanged routing fields', () => {
    const baseline = structuredClone(defaultSettings);
    expect(routingSettingsPatch(baseline, structuredClone(baseline))).toEqual({});
    expect(routingSettingsPatch(baseline, { ...baseline, retryStatuses: [429, 503], retryEnabled: false }))
      .toEqual({ retryEnabled: false, retryStatuses: [429, 503] });
  });
});

describe('playground credential eligibility', () => {
  it('uses the inclusive Beijing date boundary rather than UTC midnight', () => {
    const key = { status: 'active' as const, expires: '2026-10-15' };
    expect(usableApiKey(key, Date.parse('2026-10-15T15:59:59.998Z'))).toBe(true);
    expect(apiKeyExpired(key, Date.parse('2026-10-15T16:00:00Z'))).toBe(true);
    expect(usableApiKey(key, Date.parse('2026-10-15T16:00:00Z'))).toBe(false);
  });

  it('rejects inactive keys and expired timestamps, while preserving unlimited expiry', () => {
    const now = Date.parse('2026-10-15T08:00:00Z');
    for (const expires of ['', 'never', '永不过期']) expect(usableApiKey({ status: 'active', expires }, now)).toBe(true);
    expect(usableApiKey({ status: 'disabled', expires: '' }, now)).toBe(false);
    expect(usableApiKey({ status: 'revoked', expires: '' }, now)).toBe(false);
    expect(usableApiKey({ status: 'active', expires: '2026-10-15T07:59:59Z' }, now)).toBe(false);
  });
});

const data = (frames: string[]) => frames.map(frame => frame.split(/\r\n|\r|\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean);

describe('playground SSE framing', () => {
  it.each(['\n', '\r\n', '\r'])('reads multiline events using %j line endings', newline => {
    const parsed = splitSSEFrames(`event: message${newline}data: first${newline}data: second${newline}${newline}data: [DONE]${newline}${newline}`, true);
    expect(data(parsed.frames)).toEqual(['first\nsecond', '[DONE]']);
    expect(parsed.remainder).toBe('');
  });

  it('preserves every possible split of a CRLF stream without inventing events', () => {
    const wire = 'data: {"content":"中文"}\r\n\r\ndata: [DONE]\r\n\r\n';
    for (let index = 1; index < wire.length; index++) {
      const first = splitSSEFrames(wire.slice(0, index));
      const second = splitSSEFrames(first.remainder + wire.slice(index), true);
      expect(data([...first.frames, ...second.frames]), `chunk split ${index}`).toEqual(['{"content":"中文"}', '[DONE]']);
    }
  });

  it('keeps a single CRLF as one line ending rather than an empty line', () => {
    const parsed = splitSSEFrames('data: first\r\n');
    expect(parsed.frames).toEqual([]);
    expect(parsed.remainder).toBe('data: first\r\n');
  });

  it('handles single-character chunks, mixed newlines and a normal EOF without DONE', () => {
    let remainder = '';
    const frames: string[] = [];
    for (const character of 'data: one\r\rdata: two\n\ndata: three\r\n\r\ndata: final') {
      const parsed = splitSSEFrames(remainder + character);
      frames.push(...parsed.frames); remainder = parsed.remainder;
    }
    frames.push(...splitSSEFrames(remainder, true).frames);
    expect(data(frames)).toEqual(['one', 'two', 'three', 'final']);
  });
});

describe('console route compatibility', () => {
  it('keeps the routing alias and settings tabs stable across hash navigation', () => {
    expect(readConsoleRoute('#routing')).toEqual({ page: 'settings', settingsTab: 'routing' });
    expect(readConsoleRoute(consoleRouteHash('routing'))).toEqual({ page: 'settings', settingsTab: 'routing' });
    expect(readConsoleRoute(consoleRouteHash('settings', 'connection'))).toEqual({ page: 'settings', settingsTab: 'connection' });
    expect(readConsoleRoute('#unknown')).toEqual({ page: 'overview', settingsTab: 'connection' });
  });
});
