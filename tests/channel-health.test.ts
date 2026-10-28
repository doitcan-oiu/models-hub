import { describe, expect, it } from 'vitest';
import { defaultChannelConfig } from '../shared/types';
import type { GatewayChannel } from '../shared/types';
import { channelHealthView, matchesChannelHealthStatus } from '../src/channel-health';

const now = Date.parse('2026-10-19T00:00:00Z');

function channel(patch: Partial<GatewayChannel> = {}, health: Partial<GatewayChannel['health']> = {}): GatewayChannel {
  return {
    id: 'main', name: 'Main', provider: 'OpenAI', model: 'test', models: ['test'], tags: [], weight: 1,
    endpoint: 'https://example.test/v1', status: 'healthy', priority: 0, ttft: 0, successRate: 100,
    requests: 0, enabled: true, color: '', history: [], createdAt: '2026-10-13T00:00:00Z',
    archived: false, credentialCount: 1, config: structuredClone(defaultChannelConfig), ...patch,
    health: { averageTtft: null, averageDuration: null, samples: 20, cooldownUntil: null,
      recoveryCount: 0, failureCount: 0, reason: null, autoDisabled: false, ...health },
  };
}

describe('channel health presentation', () => {
  it('shows the unhealthy status and actual reason even before samples exist', () => {
    const reason = '连续 20 次首字延迟均超过 10s';
    expect(channelHealthView(channel({ status: 'degraded' }, { samples: 0, reason }), now))
      .toMatchObject({ label: '延迟异常', color: 'warning', reason, canReset: true, resetLabel: '恢复健康' });
    expect(channelHealthView(channel({ status: 'offline' }, { samples: 0 }), now))
      .toMatchObject({ label: '不可用', color: 'danger', canReset: true });
  });

  it('keeps untested, missing credentials, mock and healthy states distinct', () => {
    expect(channelHealthView(channel({}, { samples: 0 }), now)).toMatchObject({ label: '待检测', color: 'default', canReset: false });
    expect(channelHealthView(channel({ credentialCount: 0 }), now)).toMatchObject({ label: '待配置密钥', color: 'warning', canReset: false });
    const mock = channel({ credentialCount: 0 }, { samples: 0 });
    mock.config.protocol = 'mock';
    expect(channelHealthView(mock, now)).toMatchObject({ label: '健康', color: 'success' });
    expect(channelHealthView(channel(), now)).toMatchObject({ label: '健康', color: 'success', canReset: false, cooldownLabel: null, cooldownTitle: undefined });
  });

  it.each([
    [3_723_000, '1小时 2分 3秒'], [3_600_000, '1小时'], [60_001, '1分 1秒'], [1, '1秒'],
  ])('formats %i milliseconds remaining without rounding down', (remaining, text) => {
    const result = channelHealthView(channel({ status: 'degraded' }, { cooldownUntil: new Date(now + remaining).toISOString() }), now);
    expect(result.cooldownLabel).toBe(`冷却剩余 ${text}`);
    expect(result.resetLabel).toBe('解除冷却');
  });

  it('shows a fixed Shanghai deadline independently of the browser timezone', () => {
    const result = channelHealthView(channel({}, { cooldownUntil: '2026-10-19T01:02:03Z' }), now);
    expect(result.cooldownTitle).toBe('冷却截止：2026-10-19 09:02:03（北京时间）');
  });

  it.each([0, -1, -86_400_000])('keeps an expired cooldown visible at offset %i until actual recovery', offset => {
    const result = channelHealthView(channel({ status: 'degraded' }, { cooldownUntil: new Date(now + offset).toISOString() }), now);
    expect(result).toMatchObject({ label: '延迟异常', color: 'warning', cooldownLabel: '冷却已结束，等待恢复', canReset: true, resetLabel: '恢复健康' });
    expect(channelHealthView(channel({}, { cooldownUntil: new Date(now + offset).toISOString() }), now).label).toBe('等待恢复');
  });

  it('does not claim health when a healthy status still carries a cooldown', () => {
    const result = channelHealthView(channel({}, { cooldownUntil: new Date(now + 60_000).toISOString(), samples: 0 }), now);
    expect(result).toMatchObject({ label: '冷却中', color: 'warning', canReset: true, resetLabel: '解除冷却' });
  });

  it('shows automatic disable and preserves the server explanation', () => {
    const result = channelHealthView(channel({}, { autoDisabled: true, reason: '连续 3 次返回 HTTP 403' }), now);
    expect(result).toMatchObject({ label: '自动停用', reason: '连续 3 次返回 HTTP 403', canReset: true });
  });

  it('never offers health reset for manual disables or archived channels', () => {
    const health = { autoDisabled: true, cooldownUntil: new Date(now + 60_000).toISOString() };
    expect(channelHealthView(channel({ enabled: false, status: 'offline' }, health), now)).toMatchObject({ label: '已停用', color: 'default', canReset: false });
    expect(channelHealthView(channel({ archived: true, status: 'degraded' }, health), now)).toMatchObject({ label: '已归档', color: 'default', canReset: false });
  });

  it('handles invalid cooldowns without an invalid date or false healthy status', () => {
    const result = channelHealthView(channel({}, { cooldownUntil: 'invalid' }), now);
    expect(result).toMatchObject({ label: '等待恢复', cooldownLabel: '冷却时间无效，等待恢复', cooldownTitle: undefined, canReset: true, resetLabel: '恢复健康' });
  });
});

describe('channel health filtering', () => {
  it('accepts no filter and matches multiple selections with OR semantics', () => {
    const offline = channel({ status: 'offline' });
    expect(matchesChannelHealthStatus(offline, [], now)).toBe(true);
    expect(matchesChannelHealthStatus(offline, ['健康', '不可用'], now)).toBe(true);
    expect(matchesChannelHealthStatus(offline, ['健康', '延迟异常'], now)).toBe(false);
    expect(matchesChannelHealthStatus(channel({}, { samples: 0 }), ['待检测'], now)).toBe(true);
    expect(matchesChannelHealthStatus(channel({ credentialCount: 0 }), ['待配置密钥'], now)).toBe(true);
  });

  it.each([
    ['degraded', false, '延迟异常'], ['offline', false, '不可用'], ['offline', true, '自动停用'],
  ] as const)('finds a cooling %s channel independently of its primary label', (status, autoDisabled, label) => {
    const cooling = channel({ status }, { autoDisabled, cooldownUntil: new Date(now + 1).toISOString() });
    expect(matchesChannelHealthStatus(cooling, ['冷却中'], now)).toBe(true);
    expect(matchesChannelHealthStatus(cooling, [label], now)).toBe(true);
    expect(matchesChannelHealthStatus(cooling, ['等待恢复'], now)).toBe(false);
    expect(matchesChannelHealthStatus(cooling, ['健康', '冷却中'], now)).toBe(true);
  });

  it.each([0, -1])('moves expired cooldowns into waiting-for-recovery at offset %i', offset => {
    const expired = channel({ status: 'degraded' }, { cooldownUntil: new Date(now + offset).toISOString() });
    expect(matchesChannelHealthStatus(expired, ['等待恢复'], now)).toBe(true);
    expect(matchesChannelHealthStatus(expired, ['冷却中'], now)).toBe(false);
    expect(matchesChannelHealthStatus(expired, ['延迟异常'], now)).toBe(true);
  });

  it('includes invalid deadlines in waiting-for-recovery but requires a cooldown value', () => {
    const invalid = channel({ status: 'offline' }, { cooldownUntil: 'invalid' });
    expect(matchesChannelHealthStatus(invalid, ['等待恢复'], now)).toBe(true);
    expect(matchesChannelHealthStatus(invalid, ['冷却中'], now)).toBe(false);
    expect(matchesChannelHealthStatus(channel({ status: 'degraded' }), ['等待恢复', '冷却中'], now)).toBe(false);
  });
});
