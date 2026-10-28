import { describe, expect, it } from 'vitest';
import { defaultChannelConfig, defaultSettings, type GatewayChannel } from '../shared/types';
import { gatewayCandidates, orderedCandidates } from '../worker/gateway';
import type { GatewayContext, GatewayStore } from '../worker/env';
import { exampleAdaptiveScore, exampleChannels, orderExampleChannels, runRoutingExample, type ExampleChannel, type ExampleSettings } from '../src/components/settings/routing-examples';

const settings = (value: Partial<ExampleSettings> = {}): ExampleSettings => ({ ...defaultSettings, ...value });
const ordered = (value: Partial<ExampleSettings> = {}, channels = exampleChannels, request = 0, sticky: string | null = null) => orderExampleChannels(channels, settings(value), request, sticky).available.map(channel => channel.id);

describe('routing settings local examples', () => {
  it('keeps non-random example ordering aligned with the real worker candidate and ordering rules', async () => {
    for (const strategy of ['failover', 'adaptive', 'round-robin', 'circuit-breaker'] as const) {
      for (const autoSwitch of [true, false]) {
        for (const cooling of [true, false]) {
          for (const sticky of ['A', 'B']) {
            const examples = exampleChannels.map(channel => ({ ...channel, ...(channel.id === 'A' ? { status: 'degraded' as const, cooling } : {}) }));
            const channels: GatewayChannel[] = examples.map(channel => ({
              ...channel, name: channel.id, provider: 'Example', model: 'test', models: ['test'], tags: [], endpoint: 'https://example.invalid/v1', requests: 0, color: '#000', history: [], createdAt: '2026-01-01T00:00:00Z', archived: false, credentialCount: 1, config: structuredClone(defaultChannelConfig),
              health: { averageTtft: channel.ttft, averageDuration: null, samples: 20, cooldownUntil: channel.cooling ? new Date(Date.now() + 60_000).toISOString() : '1970-01-01T00:00:00Z', recoveryCount: 0, failureCount: 0, reason: null, autoDisabled: false },
            }));
            const context = { settings: { ...defaultSettings, strategy, autoSwitch }, channels, profile: null } as GatewayContext;
            const store = { nextRoundRobin: async () => 1, getSticky: async () => sticky } as GatewayStore;
            const actual = await orderedCandidates(gatewayCandidates(context, 'test'), context, store, 'example-session', 'example-model', true);
            expect(ordered({ strategy, autoSwitch }, examples, 1, sticky)).toEqual(actual.map(candidate => candidate.channel.id));
          }
        }
      }
    }
  });

  it('orders default routing by priority, then weight, then stable ID', () => {
    const channels: ExampleChannel[] = [
      { ...exampleChannels[0]!, id: 'C', priority: 1, weight: 2 },
      { ...exampleChannels[0]!, id: 'B', priority: 1, weight: 3 },
      { ...exampleChannels[0]!, id: 'A', priority: 1, weight: 3 },
      { ...exampleChannels[0]!, id: 'D', priority: 0, weight: 0 },
    ];
    expect(ordered({}, channels)).toEqual(['D', 'A', 'B', 'C']);
  });

  it('adaptive routing combines latency, reliability and weight instead of priority alone', () => {
    expect(ordered({ strategy: 'adaptive' })).toEqual(['B', 'A', 'C']);
    expect(exampleAdaptiveScore({ ...exampleChannels[1]!, successRate: 80 })).toBeCloseTo(.4);
    const channels = exampleChannels.map(channel => ({ ...channel, weight: channel.id === 'A' ? 20 : channel.weight }));
    expect(ordered({ strategy: 'adaptive' }, channels)[0]).toBe('A');
  });

  it('round robin rotates the complete base order per request', () => {
    const results = runRoutingExample(settings({ strategy: 'round-robin' }), 'normal', 4);
    expect(results.map(request => request.attempts[0]?.channel)).toEqual(['A', 'B', 'C', 'A']);
  });

  it('healthy remembered sessions override every strategy, while fresh sessions do not pin', () => {
    for (const strategy of ['failover', 'adaptive', 'round-robin', 'weighted', 'circuit-breaker'] as const) {
      expect(ordered({ strategy }, exampleChannels, 0, 'C')[0]).toBe('C');
      expect(runRoutingExample(settings({ strategy }), 'session', 3).every(request => request.attempts[0]?.channel === 'B')).toBe(true);
    }
    expect(runRoutingExample(settings({ strategy: 'round-robin', stickyMode: 'off' }), 'session', 3).map(request => request.attempts[0]?.channel)).toEqual(['A', 'B', 'C']);
  });

  it('does not promote a degraded sticky channel even when automatic switching is off', () => {
    const channels = exampleChannels.map(channel => ({ ...channel, ...(channel.id === 'B' ? { status: 'degraded' as const, cooling: true } : {}) }));
    expect(ordered({ autoSwitch: false }, channels, 0, 'B')).toEqual(['A', 'B', 'C']);
    expect(ordered({ autoSwitch: true }, channels, 0, 'B')).toEqual(['A', 'C']);
  });

  it('skips unhealthy channels with auto-switch, and circuit-breaker independently excludes active cooldown', () => {
    const channels = exampleChannels.map(channel => ({ ...channel, ...(channel.id === 'A' ? { status: 'degraded' as const, cooling: true } : {}) }));
    expect(ordered({ autoSwitch: true }, channels)).toEqual(['B', 'C']);
    expect(ordered({ autoSwitch: false }, channels)).toEqual(['A', 'B', 'C']);
    expect(ordered({ strategy: 'circuit-breaker', autoSwitch: false }, channels)).toEqual(['B', 'C']);
    expect(ordered({ strategy: 'circuit-breaker', autoSwitch: false }, channels.map(channel => ({ ...channel, cooling: false })))).toEqual(['A', 'B', 'C']);
    expect(ordered({ strategy: 'circuit-breaker', autoSwitch: true }, channels.map(channel => ({ ...channel, cooling: false })))).toEqual(['B', 'C']);
  });

  it('weighted samples are reproducible, preserve fallback candidates, and tolerate zero weights', () => {
    expect(runRoutingExample(settings({ strategy: 'weighted' }), 'normal', 6)).toEqual(runRoutingExample(settings({ strategy: 'weighted' }), 'normal', 6));
    const channels = exampleChannels.map(channel => ({ ...channel, weight: channel.id === 'A' ? 0 : channel.weight }));
    expect(ordered({ strategy: 'weighted' }, channels)).toContain('A');
    const allZero = channels.map(channel => ({ ...channel, weight: 0 }));
    expect(ordered({ strategy: 'weighted' }, allZero).sort()).toEqual(['A', 'B', 'C']);
    expect(new Set(Array.from({ length: 30 }, (_, request) => ordered({ strategy: 'weighted' }, allZero, request)[0])).size).toBeGreaterThan(1);
  });

  it('honors both retry budgets before switching from a repeatedly failing channel', () => {
    const request = runRoutingExample(settings({ maxSameChannelRetries: 2, maxChannelRetries: 1 }), 'failure', 1)[0]!;
    expect(request.attempts.map(attempt => attempt.channel)).toEqual(['A', 'A', 'A', 'B']);
    expect(request.success).toBe(true);
    const noFallback = runRoutingExample(settings({ maxSameChannelRetries: 1, maxChannelRetries: 0 }), 'failure', 1)[0]!;
    expect(noFallback.attempts.map(attempt => attempt.channel)).toEqual(['A', 'A']);
    expect(noFallback.success).toBe(false);
    expect(noFallback.summary).toContain('跨渠道重试为 0');
  });

  it('disabling retries means one attempt even for a failover strategy', () => {
    const request = runRoutingExample(settings({ retryEnabled: false, maxSameChannelRetries: 5, maxChannelRetries: 10 }), 'failure', 1)[0]!;
    expect(request.attempts).toHaveLength(1);
    expect(request.success).toBe(false);
    expect(request.summary).toContain('自动重试已关闭');
  });

  it('ordinary HTTP failures must match configured retry statuses', () => {
    const request = runRoutingExample(settings(), 'forbidden', 1)[0]!;
    expect(request.attempts).toHaveLength(1);
    expect(request.success).toBe(false);
    expect(request.summary).toContain('403 不在当前重试状态码内');
    const enabled = runRoutingExample(settings({ retryStatuses: [403], maxSameChannelRetries: 0 }), 'forbidden', 1)[0]!;
    expect(enabled.attempts.map(attempt => attempt.channel)).toEqual(['A', 'B']);
    expect(enabled.success).toBe(true);
    expect(runRoutingExample(settings({ retryStatuses: [] }), 'failure', 1)[0]!.attempts).toHaveLength(1);
  });

  it('never switches after streaming output has begun', () => {
    const request = runRoutingExample(settings(), 'after-output', 1)[0]!;
    expect(request.attempts).toHaveLength(1);
    expect(request.attempts[0]?.result).toBe('interrupted');
    expect(request.success).toBe(false);
    expect(request.summary).toContain('已经开始输出');
  });
});
