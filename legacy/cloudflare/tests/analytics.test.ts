import { describe, expect, it } from 'vitest';
import { buildAnalytics, latencyStats } from '../worker/analytics';
import { defaultChannelConfig } from '../shared/types';
import type { AttemptRecord, GatewayChannel, GatewayLog } from '../shared/types';

function channel(id: string): GatewayChannel {
  return {
    id, name: `渠道 ${id}`, provider: 'OpenAI', model: 'actual', models: ['actual'], tags: [],
    weight: 1, endpoint: 'https://example.test/v1', status: 'healthy', priority: 0, ttft: 0,
    successRate: 100, requests: 9999, enabled: true, color: '', history: [],
    createdAt: '2026-10-13T00:00:00Z', archived: false, credentialCount: 1,
    health: { averageTtft: null, averageDuration: null, samples: 0, cooldownUntil: null, recoveryCount: 0, failureCount: 0, reason: null, autoDisabled: false },
    config: { ...structuredClone(defaultChannelConfig), prices: [{ model: 'actual', input: 2, output: 4 }] },
  };
}
function log(id: string, patch: Partial<GatewayLog> = {}): GatewayLog {
  return {
    id, time: '08:02:00', createdAt: '2026-10-13T00:02:00Z', model: 'public-alias', channel: '渠道 a',
    channelId: 'a', apiKeyId: null, stream: true, ttft: 2, duration: 10, tokens: 0,
    status: 200, result: 'success', attempts: 1, source: 'api', traceId: null, error: null, ...patch,
  };
}
function attempt(requestId: string, channelId: string, patch: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: `${requestId}-${channelId}-${patch.attempt ?? 1}`, requestId, channelId, channelName: `历史 ${channelId}`,
    credentialId: null, model: 'actual', stream: true, startedAt: '2026-10-13T00:02:00Z',
    ttft: 2, duration: 10, status: 200, result: 'success', error: null,
    inputTokens: 5, outputTokens: 80, attempt: 1, ...patch,
  };
}

describe('real request analytics aggregation', () => {
  it('excludes failures and non-stream responses from TTFT but includes all successful completion times', () => {
    const logs = [log('a'), log('b', { result: 'slow', ttft: 4, duration: 30 }),
      log('failed', { result: 'error', status: 502, ttft: 500, duration: 999 }),
      log('json', { stream: false, ttft: 100, duration: 2 }),
      log('missing', { ttft: 0, duration: 0 })];
    const data = buildAnalytics(logs, [], [], '1h');
    expect(data.totals.successRate).toBe(80);
    expect(data.summary.ttft).toEqual({ average: 3, p50: 3, p95: 3.9, samples: 2 });
    expect(data.summary.duration.average).toBe(14);
    expect(data.summary.duration.p50).toBe(10);
    expect(data.summary.duration.p95).toBe(28);
    expect(data.summary.duration.samples).toBe(3);
    expect(data.summary.generationSpeed).toBeNull();
  });

  it('counts retries and actual channel switches even when the final request fails', () => {
    const logs = [log('once'), log('same', { attempts: 2 }),
      log('fallback', { result: 'failover', attempts: 2, channelId: 'b' }),
      log('failed', { result: 'error', status: 502, attempts: 2 })];
    const attempts = [attempt('once', 'a'), attempt('same', 'a'), attempt('same', 'a', { attempt: 2 }),
      attempt('fallback', 'a', { result: 'error', status: 502 }), attempt('fallback', 'b', { attempt: 2 }),
      attempt('failed', 'a', { result: 'error', status: 502 }), attempt('failed', 'b', { result: 'error', status: 502, attempt: 2 })];
    const data = buildAnalytics(logs, attempts, [channel('a'), channel('b')], '1h');
    expect(data.summary.retriedRequests).toBe(3);
    expect(data.summary.retryRate).toBe(75);
    expect(data.summary.switchedRequests).toBe(2);
    expect(data.summary.switchRate).toBe(50);
    expect(data.channels.find(row => row.id === 'a')?.attempts).toBe(5);
    expect(data.channels.find(row => row.id === 'a')?.requests).toBe(4);
    expect(data.channels.find(row => row.id === 'a')?.successRate).toBe(60);
    expect(data.channels.find(row => row.id === 'b')?.successRate).toBe(50);
  });

  it('weights generation speed by generation duration and never includes failed or non-stream samples', () => {
    const logs = [log('short'), log('long'), log('failed', { result: 'error', status: 502 }), log('json', { stream: false })];
    const attempts = [attempt('short', 'a', { ttft: 2, duration: 4, outputTokens: 80 }),
      attempt('long', 'b', { ttft: 4, duration: 12, outputTokens: 80 }),
      attempt('failed', 'a', { result: 'error', status: 502, ttft: 1, duration: 2, outputTokens: 9999 }),
      attempt('json', 'a', { stream: false, ttft: 1, duration: 2, outputTokens: 9999 })];
    const data = buildAnalytics(logs, attempts, [channel('a'), channel('b')], '1h');
    expect(data.summary.generationSpeed).toBe(16);
    expect(data.summary.generationSamples).toBe(2);
    expect(data.channels.find(row => row.id === 'a')?.generationSpeed).toBe(40);
    expect(data.channels.find(row => row.id === 'b')?.generationSpeed).toBe(10);
  });

  it('attributes alias usage to the requested model and prices to the actual model on each channel', () => {
    const channels = [channel('a'), channel('b')];
    channels[1].config.prices = [{ model: 'actual', input: 10, output: 20 }];
    const logs = [log('retry', { attempts: 2, result: 'failover', channelId: 'b' })];
    const attempts = [attempt('retry', 'a', { result: 'error', status: 502, inputTokens: 10, outputTokens: 5 }),
      attempt('retry', 'b', { attempt: 2, inputTokens: 20, outputTokens: 40 })];
    const data = buildAnalytics(logs, attempts, channels, '24h');
    expect(data.totals.inputTokens).toBe(30);
    expect(data.totals.outputTokens).toBe(45);
    expect(data.totals.cost).toBeCloseTo(0.00104, 10);
    expect(data.models).toHaveLength(1);
    expect(data.models[0].model).toBe('public-alias');
    expect(data.models[0].requests).toBe(1);
    expect(data.models[0].cost).toBeCloseTo(0.00104, 10);
    expect(data.summary.pricedTokens).toBe(75);
    expect(data.summary.unpricedTokens).toBe(0);
  });

  it('does not fabricate missing usage, prices, probe records or orphan attempts', () => {
    const logs = [log('counted'), log('missing'), log('probe', { source: 'probe' })];
    const attempts = [attempt('counted', 'deleted', { inputTokens: 10, outputTokens: 20 }),
      attempt('missing', 'a', { inputTokens: 0, outputTokens: 0 }),
      attempt('probe', 'a', { inputTokens: 100000 }), attempt('orphan', 'a', { inputTokens: 100000 })];
    const data = buildAnalytics(logs, attempts, [channel('a')], '1h');
    expect(data.totals.requests).toBe(2);
    expect(data.totals.inputTokens).toBe(10);
    expect(data.totals.cost).toBe(0);
    expect(data.summary.usageCoverage).toBe(50);
    expect(data.summary.unpricedTokens).toBe(30);
    expect(data.summary.pricedTokens).toBe(0);
    expect(data.channels.find(row => row.id === 'deleted')?.name).toBe('历史 deleted');
  });

  it('fills observed bucket gaps with zero requests and null latency/rate rather than zero latency', () => {
    const logs = [log('first'), log('last', { createdAt: '2026-10-13T00:12:00Z', ttft: 4 })];
    const data = buildAnalytics(logs, [attempt('first', 'a'), attempt('last', 'a')], [channel('a')], '1h');
    expect(data.timeline).toHaveLength(3);
    expect(data.timeline.map(point => point.requests)).toEqual([1, 0, 1]);
    expect(data.timeline[1].successRate).toBeNull();
    expect(data.timeline[1].ttftP50).toBeNull();
    expect(data.timeline[1].durationAverage).toBeNull();
    expect(data.timeline[0].throughput).toBe(0.2);
    expect(data.summary.throughput).toBeCloseTo(2 / 60);
  });

  it('returns null sample-based metrics and no chart series for an empty range', () => {
    const data = buildAnalytics([], [], [channel('a')], '7d');
    expect(data.timeline).toEqual([]);
    expect(data.channels).toEqual([]);
    expect(data.models).toEqual([]);
    expect(data.summary.ttft.samples).toBe(0);
    expect(data.summary.ttft.p95).toBeNull();
    expect(data.summary.duration.average).toBeNull();
    expect(data.summary.generationSpeed).toBeNull();
    expect(data.totals.requests).toBe(0);
  });

  it('treats invalid samples as missing and rejects impossible generation durations', () => {
    expect(latencyStats([1, 2, Number.NaN, Number.POSITIVE_INFINITY, 0, -1])).toEqual({ average: 1.5, p50: 1.5, p95: 1.95, samples: 2 });
    const data = buildAnalytics([log('one')], [attempt('one', 'a', { ttft: 10, duration: 9 })], [channel('a')], '1h');
    expect(data.summary.generationSpeed).toBeNull();
    expect(data.summary.generationSamples).toBe(0);
  });
  it('excludes cancelled attempts from channel success rate while retaining their trace and reported usage', () => {
    const logs = [log('good'),log('cancelled',{ result:'error',status:499 })];
    const attempts = [attempt('good','a'),attempt('cancelled','a',{ result:'cancelled',status:499,inputTokens:3,outputTokens:5 })];
    const data = buildAnalytics(logs,attempts,[channel('a')],'1h');
    expect(data.channels[0].successRate).toBe(100); expect(data.channels[0].attempts).toBe(2);
    expect(data.totals.successRate).toBe(50); expect(data.totals.inputTokens).toBe(8); expect(data.totals.outputTokens).toBe(85);
  });
});
