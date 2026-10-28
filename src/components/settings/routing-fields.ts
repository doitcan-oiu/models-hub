import type { GatewaySettings } from '../../../shared/types';

type NumericField = { title: string; hint: string; min: number; max: number; unit?: string; step?: number; integer?: boolean };
export const numericFields = {
  maxChannelRetries: { title: '跨渠道重试', hint: '失败后，最多切换到其他渠道的次数。', min: 0, max: 10, integer: true },
  maxSameChannelRetries: { title: '同渠道重试', hint: '切换渠道前，在同一渠道再次尝试的次数。', min: 0, max: 5, integer: true },
  retryDelayMs: { title: '重试间隔', hint: '两次尝试之间的等待时间。', min: 100, max: 10000, unit: 'ms', integer: true },
  streamFirstTokenTimeout: { title: '首字超时', hint: '等待第一个有效内容事件；0 表示关闭。', min: 0, max: 600, unit: 's', step: .1 },
  nonStreamTimeout: { title: '完整响应超时', hint: '等待完整响应的最长时间；0 表示关闭。', min: 0, max: 600, unit: 's', step: .1 },
  threshold: { title: '首字阈值', hint: '连续满窗口且均超过阈值时降级。', min: .001, max: 600, unit: 's', step: .001 },
  responseThreshold: { title: '完整响应阈值', hint: '非流式请求的平均完成延迟上限。', min: .001, max: 600, unit: 's', step: .001 },
  window: { title: '请求窗口', hint: '两种响应方式独立统计。', min: 1, max: 1000, unit: '次', integer: true },
  windowSeconds: { title: '时间窗口', hint: '仅统计该时间内的请求；0 表示不限。', min: 0, max: 86400, unit: 's', integer: true },
  samples: { title: '最少样本数', hint: '用于失败比例和非流式平均耗时判定。', min: 1, max: 1000, unit: '次', integer: true },
  cooldown: { title: '恢复冷却', hint: '冷却结束后进入探测恢复。', min: 1, max: 86400, unit: 's' },
  recovery: { title: '恢复次数', hint: '连续健康探测达到次数后恢复正常调度。', min: 1, max: 100, unit: '次', integer: true },
  autoDisableThreshold: { title: '错误阈值', hint: '成功请求将重置连续错误计数。', min: 1, max: 100, unit: '次', integer: true },
  autoDisableCooldown: { title: '禁用冷却', hint: '冷却结束后允许探测恢复。', min: 1, max: 86400, unit: 's' },
} satisfies Partial<Record<keyof GatewaySettings, NumericField>>;
export type NumericKey = keyof typeof numericFields;
export const numberKeys = Object.keys(numericFields) as NumericKey[];
export const retryNumberKeys: NumericKey[] = ['maxChannelRetries', 'maxSameChannelRetries', 'retryDelayMs', 'streamFirstTokenTimeout', 'nonStreamTimeout'];
export const healthNumberKeys: NumericKey[] = ['threshold', 'responseThreshold', 'window', 'samples', 'windowSeconds', 'cooldown', 'recovery'];
export const disableNumberKeys: NumericKey[] = ['autoDisableThreshold', 'autoDisableCooldown'];
export const strategyItems = [{ title: '故障转移', value: 'failover' }, { title: '自适应延迟', value: 'adaptive' }, { title: '轮询', value: 'round-robin' }, { title: '加权随机', value: 'weighted' }, { title: '熔断保护', value: 'circuit-breaker' }];
