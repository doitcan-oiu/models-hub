import type { GatewayBalance, GatewayChannel } from '../shared/types';

export function balanceAmount(balance: GatewayBalance | undefined, pending = '待更新'): string {
  if (balance?.amount == null) return balance?.status === 'error' ? '更新失败' : pending;
  const amount = balance.amount.toLocaleString('zh-CN', { maximumFractionDigits: 5 });
  return `${amount}${balance.unit && balance.unit !== '余额' ? ` ${balance.unit}` : ''}`;
}

const monitorNames: Record<string, string> = { newapi: 'NewAPI', sub2api: 'Sub2API', bbdevlab: 'BBDevLab' };
export type ChannelBalanceState = 'unmonitored' | 'unconfigured' | 'pending' | 'error' | 'cached-error' | 'partial' | 'ok';

function balanceTime(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return { text: '', title: '' };
  const date = new Date(value);
  return {
    text: date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }),
    title: `${date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）`,
  };
}

/** Shared display data for the channel table and its narrow-screen cards. */
export function channelBalancePresentation(channel: GatewayChannel) {
  const integration = channel.config.integration ?? '';
  const monitored = Object.hasOwn(monitorNames, integration);
  const isKeyPool = integration === 'bbdevlab';
  const configured = isKeyPool ? channel.credentialCount > 0 : !!channel.hasAccountCredentials;
  const balance = channel.accountBalance;
  const hasAmount = monitored && configured && typeof balance?.amount === 'number' && Number.isFinite(balance.amount);
  const state: ChannelBalanceState = !monitored ? 'unmonitored' : !configured ? 'unconfigured'
    : balance?.status === 'error' ? hasAmount ? 'cached-error' : 'error'
      : balance?.status === 'pending' || !hasAmount ? hasAmount ? 'partial' : 'pending' : 'ok';
  const stateLabel = {
    unmonitored: '未开启监控', unconfigured: isKeyPool ? '未配置 Key' : '未配置账户',
    pending: '待查询', error: '查询失败', 'cached-error': '更新失败', partial: '部分待更新', ok: '',
  }[state];
  const isUsd = balance?.unit === 'USD';
  const time = balanceTime(hasAmount ? balance?.updatedAt : state === 'error' ? balance?.checkedAt : undefined);
  const lastUpdated = balanceTime(balance?.updatedAt);
  const keyCount = isKeyPool ? balance?.keyCount ?? channel.credentialCount : channel.credentialCount;
  return {
    monitored, isKeyPool, hasAmount, state, stateLabel,
    monitorLabel: monitored ? monitorNames[integration] : '余额监控',
    refreshable: monitored && !channel.archived && configured,
    amount: hasAmount ? `${isUsd ? '$' : ''}${balance!.amount!.toLocaleString('zh-CN', { maximumFractionDigits: isKeyPool ? 5 : 4 })}` : '—',
    unit: isUsd || !hasAmount ? '' : isKeyPool && (!balance?.unit || balance.unit === '余额') ? '额度' : balance?.unit || '余额',
    keyCount, availableKeys: isKeyPool ? balance?.availableKeys ?? null : null,
    expiredKeys: isKeyPool ? balance?.expiredKeys ?? 0 : 0, exhaustedKeys: isKeyPool ? balance?.exhaustedKeys ?? 0 : 0,
    updatedText: time.text, updatedTitle: time.title,
    timeLabel: hasAmount ? state === 'cached-error' || state === 'partial' ? '上次更新' : '更新' : '检查',
    refreshTitle: [
      balance?.error,
      lastUpdated.title ? `更新于 ${lastUpdated.title}` : '',
      isKeyPool ? '仅合计未到期且参与监控的 Key 余额，手动停用的 Key 不计入；每次最多刷新 40 个，其余自动分批刷新' : 'Worker 定时刷新',
    ].filter(Boolean).join(' · '),
  };
}
