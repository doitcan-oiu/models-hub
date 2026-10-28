import type {
  AnalyticsChannel,
  AnalyticsData,
  AnalyticsLatency,
  AnalyticsModel,
  AnalyticsPoint,
} from '../shared/analytics';
import type { AttemptRecord, GatewayChannel, GatewayLog } from '../shared/types';

const positive = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;
const tokens = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, value) : 0;
const rate = (value: number, total: number): number => total ? value / total * 100 : 0;
export const completed = (value: GatewayLog | AttemptRecord): boolean =>
  (value.result === 'success' || value.result === 'slow' || value.result === 'failover') &&
  value.status >= 200 && value.status < 300;

/** Linear interpolation on sorted valid samples; null distinguishes no samples from zero. */
export function latencyStats(values: number[]): AnalyticsLatency {
  const sorted = values.filter(positive).sort((a, b) => a - b);
  const percentile = (fraction: number): number | null => {
    if (!sorted.length) return null;
    const index = (sorted.length - 1) * fraction;
    const lower = Math.floor(index), upper = Math.ceil(index);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
  };
  return {
    average: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
    p50: percentile(0.5), p95: percentile(0.95), samples: sorted.length,
  };
}

function generationRate(attempts: AttemptRecord[]): { speed: number | null; samples: number } {
  let duration = 0, output = 0, samples = 0;
  for (const attempt of attempts) {
    if (!attempt.stream || !completed(attempt) || !positive(attempt.ttft) ||
      !positive(attempt.duration) || attempt.duration <= attempt.ttft || !positive(attempt.outputTokens)) continue;
    duration += attempt.duration - attempt.ttft;
    output += attempt.outputTokens;
    samples++;
  }
  return { speed: duration > 0 ? output / duration : null, samples };
}

/** Inputs are selected-range request logs and their attempts. Probe/orphan records never enter usage. */
export function buildAnalytics(
  logs: GatewayLog[], attempts: AttemptRecord[], channels: GatewayChannel[], selectedRange: string,
): AnalyticsData {
  const range = selectedRange === '1h' ? '1h' : selectedRange === '7d' ? '7d' : '24h';
  const hours = range === '1h' ? 1 : range === '7d' ? 168 : 24;
  const intervalMinutes = range === '1h' ? 5 : range === '7d' ? 720 : 60;
  const records = logs.filter(log => log.source !== 'probe');
  const logById = new Map(records.map(log => [log.id, log]));
  const useful = attempts.filter(attempt => logById.has(attempt.requestId));
  const channelById = new Map(channels.map(channel => [channel.id, channel]));
  const byRequest = new Map<string, AttemptRecord[]>();
  const byChannel = new Map<string, AttemptRecord[]>();
  for (const attempt of useful) {
    const request = byRequest.get(attempt.requestId) ?? [];
    request.push(attempt); byRequest.set(attempt.requestId, request);
    const channel = byChannel.get(attempt.channelId) ?? [];
    channel.push(attempt); byChannel.set(attempt.channelId, channel);
  }
  const successful = records.filter(completed);
  const successfulIds = new Set(successful.map(log => log.id));
  // A request has one final response. Restrict generation speed to that response, even if older records contain successes.
  const finalSuccessful = [...byRequest.entries()].flatMap(([requestId, request]) => {
    if (!successfulIds.has(requestId)) return [];
    const final = [...request].sort((a, b) => b.attempt - a.attempt || Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
    return final && completed(final) ? [final] : [];
  });
  const ttft = latencyStats(successful.filter(log => log.stream).map(log => log.ttft));
  const duration = latencyStats(successful.map(log => log.duration));
  const generated = generationRate(finalSuccessful);
  const retriedRequests = records.filter(log => log.attempts > 1 || (byRequest.get(log.id)?.length ?? 0) > 1).length;
  const switchedRequests = records.filter(log => log.result === 'failover' ||
    new Set((byRequest.get(log.id) ?? []).map(attempt => attempt.channelId)).size > 1).length;

  let inputTokens = 0, outputTokens = 0, cost = 0, pricedTokens = 0, unpricedTokens = 0;
  const usageIds = new Set<string>();
  const costByAttempt = new Map<string, number>();
  for (const attempt of useful) {
    const input = tokens(attempt.inputTokens), output = tokens(attempt.outputTokens);
    inputTokens += input; outputTokens += output;
    if (input + output > 0) usageIds.add(attempt.requestId);
    const price = channelById.get(attempt.channelId)?.config.prices.find(price => price.model === attempt.model);
    if (price && Number.isFinite(price.input) && price.input >= 0 && Number.isFinite(price.output) && price.output >= 0) {
      const billed = (input * price.input + output * price.output) / 1e6;
      cost += billed; pricedTokens += input + output; costByAttempt.set(attempt.id, billed);
    } else unpricedTokens += input + output;
  }

  const buckets = new Map<number, GatewayLog[]>();
  const intervalMs = intervalMinutes * 60000;
  for (const log of records) {
    const timestamp = Date.parse(log.createdAt);
    if (!Number.isFinite(timestamp)) continue;
    const bucketId = Math.floor(timestamp / intervalMs) * intervalMs;
    const bucket = buckets.get(bucketId) ?? [];
    bucket.push(log); buckets.set(bucketId, bucket);
  }
  const timeline: AnalyticsPoint[] = [];
  const times = [...buckets.keys()].sort((a, b) => a - b);
  // Only fill gaps between observed buckets; avoid manufacturing a current time in this pure aggregation.
  if (times.length) for (let time = times[0]; time <= times[times.length - 1]; time += intervalMs) {
    const bucket = buckets.get(time) ?? [];
    const good = bucket.filter(completed);
    const firstToken = latencyStats(good.filter(log => log.stream).map(log => log.ttft));
    const completion = latencyStats(good.map(log => log.duration));
    const bucketAttempts = bucket.flatMap(log => byRequest.get(log.id) ?? []);
    timeline.push({
      time: new Date(time).toISOString(), requests: bucket.length,
      successRate: bucket.length ? rate(good.length, bucket.length) : null,
      throughput: bucket.length / intervalMinutes,
      ttftP50: firstToken.p50, ttftP95: firstToken.p95,
      durationAverage: completion.average, durationP95: completion.p95,
      inputTokens: bucketAttempts.reduce((sum, attempt) => sum + tokens(attempt.inputTokens), 0),
      outputTokens: bucketAttempts.reduce((sum, attempt) => sum + tokens(attempt.outputTokens), 0),
    });
  }

  const byModel = new Map<string, GatewayLog[]>();
  for (const log of records) {
    const group = byModel.get(log.model) ?? [];
    group.push(log); byModel.set(log.model, group);
  }
  const models: AnalyticsModel[] = [...byModel.entries()].map(([model, group]) => {
    const tries = group.flatMap(log => byRequest.get(log.id) ?? []);
    return {
      model, requests: group.length, successRate: rate(group.filter(completed).length, group.length),
      inputTokens: tries.reduce((sum, attempt) => sum + tokens(attempt.inputTokens), 0),
      outputTokens: tries.reduce((sum, attempt) => sum + tokens(attempt.outputTokens), 0),
      cost: tries.reduce((sum, attempt) => sum + (costByAttempt.get(attempt.id) ?? 0), 0),
    };
  }).sort((a, b) => b.inputTokens + b.outputTokens - a.inputTokens - a.outputTokens || b.requests - a.requests || a.model.localeCompare(b.model));
  const channelRows: AnalyticsChannel[] = [...byChannel.entries()].map(([id, group]) => {
    const good = group.filter(completed);
    const generation = generationRate(finalSuccessful.filter(attempt => attempt.channelId === id));
    return {
      id, name: channelById.get(id)?.name ?? group[0].channelName ?? '已删除渠道',
      attempts: group.length, requests: new Set(group.map(attempt => attempt.requestId)).size,
      successRate: rate(good.length, group.filter(attempt => attempt.result !== 'cancelled').length),
      ttft: latencyStats(good.filter(attempt => attempt.stream).flatMap(attempt => positive(attempt.ttft) ? [attempt.ttft] : [])),
      duration: latencyStats(good.map(attempt => attempt.duration)),
      generationSpeed: generation.speed, generationSamples: generation.samples,
      inputTokens: group.reduce((sum, attempt) => sum + tokens(attempt.inputTokens), 0),
      outputTokens: group.reduce((sum, attempt) => sum + tokens(attempt.outputTokens), 0),
      cost: group.reduce((sum, attempt) => sum + (costByAttempt.get(attempt.id) ?? 0), 0),
    };
  }).sort((a, b) => b.attempts - a.attempts || a.name.localeCompare(b.name));
  const outcomeCounts = { success: 0, slow: 0, failover: 0, error: 0 };
  for (const log of records) outcomeCounts[completed(log) ? log.result : 'error']++;
  return {
    range, rangeLabel: range === '1h' ? '最近 1 小时' : range === '7d' ? '最近 7 天' : '最近 24 小时', intervalMinutes,
    totals: {
      requests: records.length, successRate: rate(successful.length, records.length), averageTtft: ttft.average ?? 0,
      failovers: switchedRequests, inputTokens, outputTokens, cost,
    },
    summary: {
      successfulRequests: successful.length, failedRequests: records.length - successful.length,
      retriedRequests, retryRate: rate(retriedRequests, records.length),
      switchedRequests, switchRate: rate(switchedRequests, records.length),
      streamRequests: records.filter(log => log.stream).length, throughput: records.length / (hours * 60),
      ttft, duration, generationSpeed: generated.speed, generationSamples: generated.samples,
      usageRequests: usageIds.size, usageCoverage: rate(usageIds.size, records.length), pricedTokens, unpricedTokens,
    },
    timeline, models, channels: channelRows,
    outcomes: (Object.keys(outcomeCounts) as (keyof typeof outcomeCounts)[]).map(result => ({ result, requests: outcomeCounts[result] })),
  };
}
