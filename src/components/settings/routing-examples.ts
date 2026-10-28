import type { GatewaySettings, RoutingStrategy } from '../../../shared/types';

export const routingStrategies: { value: RoutingStrategy; title: string; icon: string; description: string; rule: string }[] = [
  { value: 'failover', title: '主用 + 备用', icon: 'mdi-source-branch', description: '优先使用排在前面的渠道，失败后尝试备用。', rule: '先看优先级，数值越小越靠前；同优先级时权重越大越靠前。' },
  { value: 'adaptive', title: '综合表现优先', icon: 'mdi-speedometer', description: '结合响应速度、成功率和权重选择渠道。', rule: '流式看首字，非流式看完整响应耗时。综合分越低越优先：耗时 × 失败惩罚 ÷ 权重；相同分数沿用基础顺序。' },
  { value: 'round-robin', title: '轮流分配', icon: 'mdi-sync', description: '每个新请求让下一条渠道排在前面。', rule: '在基础顺序上轮转，不按优先级分组；同一 Key、访问策略和模型共用轮转计数。' },
  { value: 'weighted', title: '按权重抽取', icon: 'mdi-dice-multiple-outline', description: '权重越大，被首先选中的机会越大。', rule: '每个请求重新抽取完整的尝试顺序；结果有随机波动，不保证固定比例。权重 0 仍有极小概率被选中。' },
  { value: 'circuit-breaker', title: '主备 + 冷却保护', icon: 'mdi-shield-check-outline', description: '按主备顺序分配，额外避开冷却中的异常渠道。', rule: '即使关闭自动切换，也会跳过仍在冷却的异常渠道。开启自动切换时，异常渠道需恢复健康后再接收请求。' },
];

export type RoutingExampleScenario = 'normal' | 'failure' | 'cooldown' | 'session' | 'session-failure' | 'forbidden' | 'after-output';
export const routingScenarios: { value: RoutingExampleScenario; title: string; description: string }[] = [
  { value: 'normal', title: '都正常，看请求分给谁', description: '三个渠道都健康。每个请求都是新会话，直接观察分配顺序。' },
  { value: 'failure', title: 'A 在输出前返回 503', description: 'A 每次都返回 503；B、C 正常。观察是否重试、重试几次以及何时换渠道。' },
  { value: 'cooldown', title: 'A 已降级，正在冷却', description: 'A 已被判定异常，冷却尚未结束；B、C 健康。关闭自动切换时，普通策略仍可能使用 A。' },
  { value: 'session', title: '同一会话，上次由 B 成功响应', description: '这些请求携带相同的会话标识，上次成功的渠道是 B。观察会话连续性是否优先于调度方式。' },
  { value: 'session-failure', title: '同一会话，但原渠道 B 已异常', description: '上次成功的 B 已降级，冷却尚未结束。即使保留会话连续性，也不会强行把异常 B 提到首位。' },
  { value: 'forbidden', title: 'A 在输出前返回 403', description: 'A 返回普通的 403 错误。只有重试状态码包含 403，才会继续尝试；这里不模拟余额到期等特殊情况。' },
  { value: 'after-output', title: '已经输出内容，连接才断开', description: '首选渠道已经输出文字，随后连接断开。这时会结束本次请求，不再切换渠道拼接回答。' },
];

export type ExampleChannel = {
  id: string; priority: number; weight: number; ttft: number; successRate: number;
  status: 'healthy' | 'degraded'; cooling: boolean; enabled: boolean;
};
export const exampleChannels: ExampleChannel[] = [
  { id: 'A', priority: 1, weight: 6, ttft: 2.4, successRate: 100, status: 'healthy', cooling: false, enabled: true },
  { id: 'B', priority: 2, weight: 3, ttft: .6, successRate: 100, status: 'healthy', cooling: false, enabled: true },
  { id: 'C', priority: 3, weight: 1, ttft: 1.2, successRate: 100, status: 'healthy', cooling: false, enabled: true },
];

export type ExampleSettings = Pick<GatewaySettings, 'strategy' | 'stickyMode' | 'autoSwitch' | 'retryEnabled' | 'maxChannelRetries' | 'maxSameChannelRetries' | 'retryStatuses' | 'retryDelayMs'>;
export type ExampleAttempt = { channel: string; result: 'success' | 'error' | 'interrupted'; status: number; reason: string };
export type RoutingExampleRequest = { number: number; attempts: ExampleAttempt[]; skipped: { channel: string; reason: string }[]; order: string[]; success: boolean; summary: string };

export function exampleAdaptiveScore(channel: ExampleChannel): number {
  return channel.ttft * (1 + (100 - channel.successRate) / 20) / Math.max(1, channel.weight);
}

// A fixed pseudo-random sample makes the demonstration replayable. This is the
// worker's exponential-race ordering, not a promise about real traffic ratios.
function randomSample(request: number, channel: string): number {
  let value = 1 + (request + 1) * 104729 + [...channel].reduce((sum, char) => sum + char.charCodeAt(0), 0) * 15485863;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return ((value ^ (value >>> 15)) >>> 0) / 4294967296;
}

export function orderExampleChannels(channels: ExampleChannel[], settings: ExampleSettings, request: number, sticky: string | null = null): { available: ExampleChannel[]; skipped: { channel: string; reason: string }[] } {
  const skipped: { channel: string; reason: string }[] = [];
  const ordered = channels.filter(channel => {
    const reason = !channel.enabled ? '渠道已停用' : settings.autoSwitch && channel.status !== 'healthy' ? '自动切换已开启：跳过异常渠道' : '';
    if (reason) skipped.push({ channel: channel.id, reason });
    return !reason;
  }).sort((a, b) => a.priority - b.priority || b.weight - a.weight || a.id.localeCompare(b.id));
  if (settings.strategy === 'adaptive') ordered.sort((a, b) => exampleAdaptiveScore(a) - exampleAdaptiveScore(b));
  if (settings.strategy === 'round-robin' && ordered.length) ordered.push(...ordered.splice(0, request % ordered.length));
  if (settings.strategy === 'weighted') {
    const rank = (channel: ExampleChannel) => -Math.log(Math.max(Number.MIN_VALUE, randomSample(request, channel.id))) / Math.max(.001, channel.weight);
    ordered.sort((a, b) => rank(a) - rank(b));
  }
  const available = ordered.filter(channel => {
    if (settings.strategy === 'circuit-breaker' && channel.status !== 'healthy' && channel.cooling) {
      skipped.push({ channel: channel.id, reason: '冷却保护：异常渠道仍在冷却' });
      return false;
    }
    return true;
  });
  if (settings.stickyMode === 'prefer' && sticky) {
    const index = available.findIndex(channel => channel.id === sticky && channel.status === 'healthy');
    if (index > 0) available.unshift(...available.splice(index, 1));
  }
  return { available, skipped };
}

export function channelsForScenario(scenario: RoutingExampleScenario): ExampleChannel[] {
  return exampleChannels.map(channel => ({ ...channel, ...((scenario === 'cooldown' && channel.id === 'A') || (scenario === 'session-failure' && channel.id === 'B') ? { status: 'degraded' as const, cooling: true } : {}) }));
}

export function runRoutingExample(settings: ExampleSettings, scenario: RoutingExampleScenario, count = 3): RoutingExampleRequest[] {
  const channels = channelsForScenario(scenario);
  const sameSession = scenario === 'session' || scenario === 'session-failure';
  let sticky: string | null = sameSession ? 'B' : null;
  const results: RoutingExampleRequest[] = [];
  const channelBudget = settings.retryEnabled ? 1 + Math.max(0, Math.min(10, Math.trunc(settings.maxChannelRetries))) : 1;
  const sameChannelBudget = settings.retryEnabled ? 1 + Math.max(0, Math.min(5, Math.trunc(settings.maxSameChannelRetries))) : 1;
  for (let request = 0; request < Math.max(0, Math.min(6, Math.trunc(count))); request++) {
    const { available, skipped } = orderExampleChannels(channels, settings, request, sameSession ? sticky : null);
    const attempts: ExampleAttempt[] = [];
    let success = false, stop = '';
    for (const channel of available.slice(0, channelBudget)) {
      for (let round = 0; round < sameChannelBudget; round++) {
        if (scenario === 'after-output') {
          attempts.push({ channel: channel.id, result: 'interrupted', status: 502, reason: '已经输出内容后断开，不能再切换渠道' });
          stop = '已经开始输出，本次请求结束。自动重试只用于开始输出前的失败。';
          break;
        }
        const status = channel.id === 'A' && scenario === 'failure' ? 503 : channel.id === 'A' && scenario === 'forbidden' ? 403 : 200;
        if (status === 200) {
          const reason = sameSession && settings.stickyMode === 'prefer' && sticky === channel.id && channel.status === 'healthy' ? '沿用同一会话上次成功的健康渠道' : round ? '同渠道再次尝试成功' : '按当前分配顺序成功响应';
          attempts.push({ channel: channel.id, result: 'success', status, reason });
          success = true;
          if (sameSession && settings.stickyMode === 'prefer') sticky = channel.id;
          break;
        }
        const canRetry = settings.retryStatuses.includes(status);
        const reason = !settings.retryEnabled ? `返回 ${status}；自动重试已关闭` : !canRetry ? `返回 ${status}；不在重试状态码内` : round + 1 < sameChannelBudget ? `返回 ${status}；等待 ${settings.retryDelayMs} ms 后再试本渠道` : `返回 ${status}；本渠道尝试次数已用完`;
        attempts.push({ channel: channel.id, result: 'error', status, reason });
        if (!settings.retryEnabled) { stop = '自动重试已关闭，失败后不会再试本渠道或切换备用。'; break; }
        if (!canRetry) { stop = `${status} 不在当前重试状态码内，本次请求结束。`; break; }
      }
      if (success || stop) break;
    }
    const first = attempts[0]?.channel, last = attempts.at(-1)?.channel;
    const summary = success ? first !== last ? `${first} 在输出前失败，尝试 ${attempts.length - 1} 次后切换到 ${last}，请求成功。` : attempts[0]!.reason : stop || (!available.length ? '没有可调度的示例渠道。' : settings.maxChannelRetries <= 0 ? '跨渠道重试为 0，本渠道失败后不能切换到备用。' : `已用完本次允许的 ${Math.min(channelBudget, available.length)} 个渠道，未能完成请求。`);
    results.push({ number: request + 1, attempts, skipped, order: available.map(channel => channel.id), success, summary });
  }
  return results;
}
