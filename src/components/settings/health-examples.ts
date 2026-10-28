import { defaultChannelConfig, type AttemptRecord, type GatewayChannel, type GatewaySettings } from '../../../shared/types';
import { evaluateHealth } from '../../../shared/health';
import { healthNumberKeys, numericFields, type NumericKey } from './routing-fields';

export type HealthExampleMode = 'stream' | 'complete';
export type HealthExampleScenario = 'fixed' | 'slow' | 'fast-break' | 'boundary' | 'insufficient' | 'half-failed' | 'old-requests';
export type HealthExampleRequest = AttemptRecord & { included: boolean; position: number };
export const healthExampleScenarios = [
  { value: 'fixed', title: '固定请求 · 拖动阈值试试看' },
  { value: 'slow', title: '每次都比较慢' },
  { value: 'fast-break', title: '中间有一次很快' },
  { value: 'boundary', title: '耗时刚好等于阈值' },
  { value: 'insufficient', title: '观察次数还不够' },
  { value: 'half-failed', title: '一半请求返回错误' },
  { value: 'old-requests', title: '大部分请求发生在很久以前' },
] satisfies { value: HealthExampleScenario; title: string }[];

/** Invalid drafts pause the preview instead of silently demonstrating another value. */
export function healthExampleSettings(settings: GatewaySettings, numeric: Record<NumericKey, string>): GatewaySettings | null {
  const value = { ...settings };
  for (const key of [...healthNumberKeys, 'streamFirstTokenTimeout', 'nonStreamTimeout'] as NumericKey[]) {
    const text = numeric[key] ?? '', number = Number(text), field = numericFields[key];
    if (!text.trim() || !Number.isFinite(number) || number < field.min || number > field.max || ('integer' in field && field.integer && !Number.isInteger(number))) return null;
    value[key] = number;
  }
  return value;
}

function exampleChannel(): GatewayChannel {
  return {
    id: 'health-example', name: '示例渠道', provider: '示例', model: 'demo', models: ['demo'], tags: [], weight: 1,
    endpoint: '', status: 'healthy', priority: 1, ttft: 0, successRate: 100, requests: 0, enabled: true, color: '', history: [],
    createdAt: '2026-01-01T00:00:00.000Z', archived: false, config: structuredClone(defaultChannelConfig), credentialCount: 1,
    health: { averageTtft: null, averageDuration: null, samples: 0, cooldownUntil: null, recoveryCount: 0, failureCount: 0, reason: null, autoDisabled: false },
  };
}

/** Evaluate the final window through the same pure rule used by the Worker. */
export function inspectHealthRequests(settings: GatewaySettings, stream: boolean, chronological: AttemptRecord[], nowMs: number) {
  const latest = chronological.at(-1);
  if (!latest) throw new Error('示例至少需要一次请求');
  const recent = [...chronological].reverse();
  const since = settings.windowSeconds > 0 ? nowMs - settings.windowSeconds * 1000 : 0;
  const included = recent.filter(request => request.stream === stream && request.result !== 'cancelled' && !request.healthIgnored && Date.parse(request.startedAt) >= since).slice(0, Math.max(1, settings.window));
  const ids = new Set(included.map(request => request.id));
  const requests: HealthExampleRequest[] = chronological.map((request, index) => ({ ...request, position: index + 1, included: ids.has(request.id) }));
  const decision = evaluateHealth(exampleChannel(), settings, recent.filter(request => !request.healthIgnored), latest, nowMs);
  const valid = included.filter(request => request.result === 'success' || request.result === 'slow');
  const failures = included.filter(request => request.result === 'error' || request.result === 'empty').length;
  const mean = valid.length ? valid.reduce((sum, request) => sum + request.duration, 0) / valid.length : null;
  return { requests, decision, includedCount: included.length, failureCount: failures, averageDuration: mean, triggered: decision.status !== 'healthy' };
}

export function buildHealthExample(settings: GatewaySettings, mode: HealthExampleMode, scenario: HealthExampleScenario, nowMs = Date.now()) {
  const stream = mode === 'stream', threshold = stream ? settings.threshold : settings.responseThreshold;
  const required = stream ? settings.window : settings.samples;
  const count = scenario === 'insufficient' ? Math.max(1, Math.min(settings.window, required - 1)) : settings.window;
  // Completion times fit the window; actual sampling uses start times, including the full request duration.
  const spacing = settings.windowSeconds > 0 ? Math.min(1000, settings.windowSeconds * 1000 / (count + 1)) : 1000;
  const slow = threshold * 1.5, fast = threshold * .25;
  const requests: AttemptRecord[] = Array.from({ length: count }, (_, index) => {
    const failed = scenario === 'half-failed' && index < Math.ceil(count / 2);
    const latency = scenario === 'fixed' ? stream ? 12 : 45 : scenario === 'boundary' ? threshold : scenario === 'fast-break' && index === Math.floor(count / 2) ? fast : slow;
    const age = scenario === 'old-requests' && index < count - 1 ? (settings.windowSeconds || 60) * 1000 + (count - index) * 1000 : (count - index - 1) * spacing;
    const duration = failed ? .2 : latency;
    return {
      id: `example-${index}`, requestId: `request-${index}`, channelId: 'health-example', channelName: '示例渠道', credentialId: null,
      model: 'demo', stream, startedAt: new Date(nowMs - age - duration * 1000).toISOString(), ttft: failed ? null : stream ? latency : null,
      duration, status: failed ? 503 : 200, result: failed ? 'error' : latency > threshold ? 'slow' : 'success',
      error: failed ? '示例错误' : null, inputTokens: 0, outputTokens: 0, attempt: 1,
    };
  });
  const result = inspectHealthRequests(settings, stream, requests, nowMs);
  let explanation: string;
  if (!settings.autoSwitch) explanation = '自动切换已关闭。仍会记录健康数据，但这些请求不会自动让渠道退出正常调度。';
  else if (result.triggered) explanation = result.decision.patch.reason ?? '当前请求窗口已达到切换条件。';
  else if (!result.includedCount) explanation = '请求均未进入当前统计窗口，尚无可用于判定的样本。';
  else if (stream) explanation = result.includedCount < settings.window
    ? `只统计到 ${result.includedCount} 次请求，还没有满 ${settings.window} 次观察窗口。`
    : `需要连续 ${settings.window} 次成功请求的首字都严格超过 ${settings.threshold}s；等于阈值、一次快请求或错误都会打断。`;
  else explanation = result.includedCount < settings.samples
    ? `只统计到 ${result.includedCount} 次请求，还没有达到最少 ${settings.samples} 次样本。`
    : `成功请求平均耗时 ${formatExampleSeconds(result.averageDuration ?? 0)}s，未严格超过 ${settings.responseThreshold}s；错误比例也未达到 50%。`;
  let scenarioNote = scenario === 'fixed'
    ? `这批请求的${stream ? '首字等待固定为 12s' : '完整响应固定为 45s'}，不会跟着阈值改变。拖动上方${stream ? '首字' : '完整回答'}阈值，观察同样的请求何时触发切换；等于阈值不算慢。`
    : scenario === 'old-requests'
    ? settings.windowSeconds === 0 ? '时间窗口设为 0，不限制请求距今多久；旧请求仍会参与统计。' : `超过 ${settings.windowSeconds}s 的旧请求显示为灰色，不参与本次判定。`
    : scenario === 'fast-break' && !stream ? '非流式按平均耗时判断，一次快请求只能拉低平均值，不一定阻止切换。'
      : scenario === 'insufficient' && required === 1 ? '当前只需 1 次请求，第一条就已满足次数要求。'
        : scenario === 'half-failed' ? '错误和空响应计入失败比例；达到最少样本后，失败比例等于 50% 也会触发。' : '';
  if (settings.windowSeconds > 0 && result.includedCount < count && scenario !== 'old-requests') scenarioNote += `${scenarioNote ? ' ' : ''}时间窗口按请求开始时间计算；已完成的慢请求也可能因为开始得太早而被排除。`;
  return { ...result, explanation, scenarioNote, threshold, stream };
}

export function visibleHealthRequests(requests: HealthExampleRequest[], maximum = 12) {
  if (requests.length <= maximum) return { first: requests, last: [] as HealthExampleRequest[], omitted: 0 };
  const firstCount = Math.ceil(maximum / 2), lastCount = Math.floor(maximum / 2);
  return { first: requests.slice(0, firstCount), last: requests.slice(-lastCount), omitted: requests.length - maximum };
}

export function formatExampleSeconds(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 }).format(value);
}
