import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../shared/types';
import { buildHealthExample } from '../src/components/settings/health-examples';

const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
const now = Date.parse('2026-10-28T00:00:00.000Z');

beforeEach(() => { vi.stubGlobal('crypto', { getRandomValues }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('gateway settings without crypto.randomUUID', () => {
  it('renders changing health examples with distinct event IDs on ordinary HTTP', () => {
    const settings = { ...defaultSettings, autoSwitch: true, window: 4, samples: 2, windowSeconds: 0, threshold: 10, responseThreshold: 20 };
    expect(crypto.randomUUID).toBeUndefined();

    const results = [
      buildHealthExample(settings, 'stream', 'slow', now),
      buildHealthExample(settings, 'complete', 'slow', now),
      buildHealthExample(settings, 'stream', 'half-failed', now),
    ];

    expect(results.map(result => result.decision.status)).toEqual(['degraded', 'degraded', 'offline']);
    const events = results.map(result => result.decision.event);
    expect(events.every(event => event?.id && event.type === 'warning' && event.channelId === 'health-example')).toBe(true);
    expect(new Set(events.map(event => event?.id)).size).toBe(events.length);
  });
});
