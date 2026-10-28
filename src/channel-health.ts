import type { GatewayChannel } from '../shared/types';

export type ChannelHealthView = {
  label: string;
  color: 'default' | 'success' | 'warning' | 'danger';
  reason: string;
  cooldownLabel: string | null;
  cooldownTitle: string | undefined;
  canReset: boolean;
  resetLabel: string;
};

function remainingTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours ? `${hours}小时` : '', minutes ? `${minutes}分` : '', remainder ? `${remainder}秒` : '']
    .filter(Boolean).join(' ') || '0秒';
}

const shanghaiTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function cooldownDeadline(timestamp: number): string {
  const parts = shanghaiTime.formatToParts(timestamp);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)?.value;
  return `冷却截止：${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}（北京时间）`;
}

/** Persisted health restrictions await recovery; fast circuits permit a request after expiry. */
export function channelHealthView(channel: GatewayChannel, nowMs = Date.now()): ChannelHealthView {
  const cooldownUntil = channel.health.cooldownUntil;
  const deadline = cooldownUntil ? Date.parse(cooldownUntil) : NaN;
  const validDeadline = Number.isFinite(deadline);
  const coolingDown = validDeadline && deadline > nowMs;
  const circuitDeadline = Date.parse(channel.runtime?.circuitUntil ?? '');
  const circuitCooling = Number.isFinite(circuitDeadline) && circuitDeadline > nowMs;
  const halfOpen = channel.runtime?.halfOpen === true;
  const runtimeBlocked = circuitCooling || halfOpen;
  let cooldownLabel = !cooldownUntil ? null : !validDeadline ? '冷却时间无效，等待恢复'
    : coolingDown ? `冷却剩余 ${remainingTime(deadline - nowMs)}` : '冷却已结束，等待恢复';
  let cooldownTitle = validDeadline ? cooldownDeadline(deadline) : undefined;
  if (!cooldownUntil && circuitCooling && !halfOpen) {
    cooldownLabel = `熔断剩余 ${remainingTime(circuitDeadline - nowMs)}`;
    cooldownTitle = cooldownDeadline(circuitDeadline);
  }
  const canReset = channel.enabled && !channel.archived
    && (channel.status !== 'healthy' || channel.health.autoDisabled || !!cooldownUntil || runtimeBlocked);

  let label: string;
  let color: ChannelHealthView['color'];
  let fallbackReason: string;
  let runtimeReason = false;
  if (channel.archived) {
    label = '已归档'; color = 'default'; fallbackReason = '渠道已归档，不参与路由';
  } else if (!channel.enabled) {
    label = '已停用'; color = 'default'; fallbackReason = '渠道已手动停用，不参与路由';
  } else if (channel.health.autoDisabled) {
    label = '自动停用'; color = 'warning'; fallbackReason = '触发自动停用规则，等待恢复';
  } else if (channel.status === 'degraded') {
    label = '延迟异常'; color = 'warning'; fallbackReason = '响应延迟超过健康阈值，等待恢复';
  } else if (channel.status === 'offline') {
    label = '不可用'; color = 'danger'; fallbackReason = '最近请求失败，等待恢复';
  } else if (channel.config.protocol !== 'mock' && channel.credentialCount === 0) {
    label = '待配置密钥'; color = 'warning'; fallbackReason = '请先配置渠道密钥';
  } else if (cooldownUntil) {
    label = coolingDown ? '冷却中' : '等待恢复'; color = 'warning';
    fallbackReason = coolingDown ? '渠道处于冷却期，暂不参与路由' : '冷却结束后仍需检测通过或手动恢复健康';
  } else if (halfOpen) {
    label = '恢复检测中'; color = 'warning'; runtimeReason = true;
    fallbackReason = '熔断冷却已结束，正在验证请求是否恢复';
  } else if (circuitCooling) {
    label = '熔断冷却'; color = 'warning'; runtimeReason = true;
    fallbackReason = '连续请求失败触发熔断，冷却结束后允许一次请求验证恢复';
  } else if (channel.runtime && channel.runtime.limit > 0 && channel.runtime.active >= channel.runtime.limit) {
    label = '并发已满'; color = 'warning'; runtimeReason = true;
    fallbackReason = `正在处理 ${channel.runtime.active}/${channel.runtime.limit} 个请求，空闲后自动恢复接收`;
  } else if (channel.config.protocol !== 'mock' && channel.health.samples === 0) {
    label = '待检测'; color = 'default'; fallbackReason = '暂无健康检测记录';
  } else {
    label = '健康'; color = 'success'; fallbackReason = '渠道状态正常';
  }

  return {
    label, color, reason: runtimeReason ? fallbackReason : channel.health.reason?.trim() || fallbackReason,
    cooldownLabel, cooldownTitle,
    canReset, resetLabel: coolingDown ? '解除冷却' : runtimeBlocked && !cooldownUntil && channel.status === 'healthy' && !channel.health.autoDisabled ? '解除熔断' : '恢复健康',
  };
}

/** Cooldown filters also match channels whose primary label describes their failure. */
export function matchesChannelHealthStatus(channel: GatewayChannel, statuses: string[], nowMs = Date.now()): boolean {
  if (!statuses.length) return true;
  const cooldownUntil = channel.health.cooldownUntil;
  const deadline = cooldownUntil ? Date.parse(cooldownUntil) : NaN;
  const circuitDeadline = Date.parse(channel.runtime?.circuitUntil ?? '');
  return statuses.some(status => {
    if (status === '冷却中') return Number.isFinite(deadline) && deadline > nowMs
      || !channel.runtime?.halfOpen && Number.isFinite(circuitDeadline) && circuitDeadline > nowMs;
    if (status === '等待恢复') return !!cooldownUntil && (!Number.isFinite(deadline) || deadline <= nowMs);
    return status === channelHealthView(channel, nowMs).label;
  });
}
