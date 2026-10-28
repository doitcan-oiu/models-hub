import { describe, expect, it } from 'vitest';
import { defaultSettings, type AttemptRecord, type GatewaySettings } from '../shared/types';
import { buildHealthExample, healthExampleSettings, inspectHealthRequests, visibleHealthRequests } from '../src/components/settings/health-examples';
import { numberKeys, type NumericKey } from '../src/components/settings/routing-fields';

const now = Date.parse('2026-10-26T00:00:00.000Z');
const settings = (patch: Partial<GatewaySettings> = {}): GatewaySettings => ({ ...defaultSettings, window: 4, samples: 2, threshold: 10, responseThreshold: 20, ...patch });
describe('live health settings examples', () => {
  it('keeps fixed request latency unchanged so threshold adjustments change the outcome', () => {
    const stream = [10, 12, 20].map(threshold => buildHealthExample(settings({ threshold }), 'stream', 'fixed', now));
    expect(stream.map(result => result.triggered)).toEqual([true, false, false]);
    expect(stream.every(result => result.requests.every(request => request.ttft === 12))).toBe(true);
    expect(stream[0]!.scenarioNote).toContain('固定为 12s');
    const complete = [40, 45, 60].map(responseThreshold => buildHealthExample(settings({ responseThreshold }), 'complete', 'fixed', now));
    expect(complete.map(result => result.triggered)).toEqual([true, false, false]);
    expect(complete.every(result => result.requests.every(request => request.duration === 45))).toBe(true);
    expect(complete[0]!.scenarioNote).toContain('固定为 45s');
  });
  it('requires a full streaming window of strictly slow successful first tokens', () => {
    expect(buildHealthExample(settings(), 'stream', 'slow', now).decision.status).toBe('degraded');
    expect(buildHealthExample(settings(), 'stream', 'fast-break', now).triggered).toBe(false);
    expect(buildHealthExample(settings(), 'stream', 'boundary', now).triggered).toBe(false);
    expect(buildHealthExample(settings(), 'stream', 'insufficient', now).triggered).toBe(false);
  });
  it('does not use minimum samples to shorten the streaming streak', () => {
    const result = buildHealthExample(settings({ samples: 1 }), 'stream', 'insufficient', now);
    expect(result.includedCount).toBe(3);
    expect(result.triggered).toBe(false);
  });
  it('shows the unavoidable first-request trigger when the window is one', () => {
    expect(buildHealthExample(settings({ window: 1, samples: 1 }), 'stream', 'insufficient', now).triggered).toBe(true);
  });
  it('uses average completion latency for non-streaming rather than an all-slow streak', () => {
    const result = buildHealthExample(settings(), 'complete', 'fast-break', now);
    expect(result.averageDuration).toBe(23.75);
    expect(result.triggered).toBe(true);
    expect(buildHealthExample(settings(), 'complete', 'boundary', now).triggered).toBe(false);
    expect(buildHealthExample(settings(), 'complete', 'insufficient', now).triggered).toBe(false);
  });
  it('triggers at exactly fifty percent errors after minimum samples', () => {
    const result = buildHealthExample(settings(), 'stream', 'half-failed', now);
    expect(result.failureCount).toBe(2);
    expect(result.decision.status).toBe('offline');
    expect(buildHealthExample(settings({ samples: 5 }), 'stream', 'half-failed', now).triggered).toBe(false);
  });
  it('reflects the auto-switch toggle while preserving health observations', () => {
    const result = buildHealthExample(settings({ autoSwitch: false }), 'stream', 'slow', now);
    expect(result.triggered).toBe(false);
    expect(result.decision.patch.samples).toBe(4);
    expect(result.explanation).toContain('已关闭');
  });
  it('ignores old requests only when a time window is configured', () => {
    const filtered = buildHealthExample(settings({ windowSeconds: 30 }), 'stream', 'old-requests', now);
    expect(filtered.includedCount).toBe(1);
    expect(filtered.triggered).toBe(false);
    expect(filtered.requests.filter(request => !request.included)).toHaveLength(3);
    expect(buildHealthExample(settings({ windowSeconds: 0 }), 'stream', 'old-requests', now).triggered).toBe(true);
  });
  it('uses completed requests and does not fit long durations into an impossibly short time window', () => {
    const result = buildHealthExample(settings({ window: 1000, samples: 1000, windowSeconds: 1 }), 'stream', 'slow', now);
    expect(result.includedCount).toBe(0);
    expect(result.triggered).toBe(false);
    expect(result.requests.every(request => Date.parse(request.startedAt) + request.duration * 1000 <= now)).toBe(true);
    expect(result.scenarioNote).toContain('开始时间');
  });
  it('uses the inclusive time boundary and independent response modes', () => {
    const base = buildHealthExample(settings(), 'stream', 'slow', now).requests;
    const requests: AttemptRecord[] = base.map((request, index) => ({ ...request, stream: index === 3, startedAt: new Date(index === 3 ? now - 10000 : now).toISOString() }));
    const result = inspectHealthRequests(settings({ windowSeconds: 10 }), true, requests, now);
    expect(result.includedCount).toBe(1);
    expect(result.triggered).toBe(false);
    requests[3]!.startedAt = new Date(now - 10001).toISOString();
    expect(inspectHealthRequests(settings({ windowSeconds: 10 }), true, requests, now).includedCount).toBe(0);
  });
  it('excludes cancelled and verified expired/exhausted-key failures from examples', () => {
    const requests: AttemptRecord[] = buildHealthExample(settings(), 'stream', 'slow', now).requests;
    requests[0] = { ...requests[0]!, result: 'cancelled' };
    requests[1] = { ...requests[1]!, result: 'error', healthIgnored: true };
    expect(inspectHealthRequests(settings(), true, requests, now).includedCount).toBe(2);
    expect(inspectHealthRequests(settings(), true, requests, now).triggered).toBe(false);
  });
  it('calculates large windows in full while limiting visible request cards', () => {
    const result = buildHealthExample(settings({ window: 1000 }), 'stream', 'slow', now);
    const visible = visibleHealthRequests(result.requests);
    expect(result.includedCount).toBe(1000);
    expect(visible.first.length + visible.last.length).toBe(12);
    expect(visible.omitted).toBe(988);
    expect(visible.last.at(-1)?.position).toBe(1000);
  });
  it('validates drafts without rounding small thresholds or truncating large values', () => {
    const values = settings({ threshold: .001, responseThreshold: 600, windowSeconds: 86400 });
    const numeric = Object.fromEntries(numberKeys.map(key => [key, String(values[key])])) as Record<NumericKey, string>;
    expect(healthExampleSettings(values, numeric)).toMatchObject({ threshold: .001, responseThreshold: 600, windowSeconds: 86400 });
    expect(healthExampleSettings(values, { ...numeric, threshold: '' })).toBeNull();
    expect(healthExampleSettings(values, { ...numeric, threshold: 'Infinity' })).toBeNull();
    expect(healthExampleSettings(values, { ...numeric, window: '2.5' })).toBeNull();
    expect(healthExampleSettings(values, { ...numeric, threshold: '.0001' })).toBeNull();
    expect(healthExampleSettings(values, { ...numeric, cooldown: '86401' })).toBeNull();
  });
});
