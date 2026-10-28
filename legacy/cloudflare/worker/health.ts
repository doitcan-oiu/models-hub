import type { AttemptRecord, GatewayChannel, GatewayEvent, GatewaySettings } from '../shared/types';

export type HealthDecision = { patch: Partial<GatewayChannel['health']>; status: GatewayChannel['status']; event?: GatewayEvent };

/** Only clear an existing health restriction when its cause has been explicitly exempted. */
export function cooldownExemptsHealth(channel: GatewayChannel): boolean {
  const reason = channel.health.reason || '';
  const errorRestriction = channel.health.autoDisabled || /^HTTP\b/i.test(reason) || reason.includes('失败率');
  if (errorRestriction) return channel.config.cooldown?.error === false;
  return channel.config.cooldown?.firstToken === false && reason.includes('首字');
}

/** Manual disables have no reason/cooldown and must never be undone by probes. */
export function credentialRecoveryAllowed(channel: GatewayChannel, settings: GatewaySettings, credential: { enabled: boolean; reason: string | null; disabledAt: string | null }, nowMs = Date.now()): boolean {
  const recover = channel.config.autoDisable.enabled ? channel.config.autoDisable.recover : settings.autoDisableRecover;
  return !credential.enabled && !!credential.reason && !!credential.disabledAt && recover && Date.parse(credential.disabledAt) <= nowMs;
}

/** Called inside the state object's serialized write, using only samples of the same response mode. */
export function evaluateHealth(channel: GatewayChannel, settings: GatewaySettings, recent: AttemptRecord[], latest: AttemptRecord, nowMs = Date.now()): HealthDecision {
  if (latest.result === 'cancelled') return { patch: {}, status: channel.status };
  const since = settings.windowSeconds > 0 ? nowMs - settings.windowSeconds * 1000 : 0;
  const window = Math.max(1, settings.window);
  const samples = recent.filter(a => a.stream === latest.stream && a.result !== 'cancelled' && Date.parse(a.startedAt) >= since).slice(0, window);
  const valid = samples.filter(a => a.result === 'success' || a.result === 'slow');
  const mean = (numbers: number[]) => numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null;
  const ttft = mean(valid.flatMap(a => a.ttft === null || !Number.isFinite(a.ttft) || a.ttft < 0 ? [] : [a.ttft]));
  const duration = mean(valid.map(a => a.duration));
  const failed = latest.result === 'error' || latest.result === 'empty';
  const failureCount = failed ? channel.health.failureCount + 1 : 0;
  const enough = samples.length >= Math.max(1, settings.samples);
  // A slow first token only affects routing after the entire recent window is slow.
  // Include intervening failures/missing TTFT rather than filtering them into a false streak.
  const tooSlow = latest.stream
    ? channel.config.cooldown?.firstToken !== false && samples.length === window && samples.every(a => (a.result === 'success' || a.result === 'slow') && a.ttft !== null && Number.isFinite(a.ttft) && a.ttft > settings.threshold)
    : (channel.config.cooldown?.error === false ? valid.length >= Math.max(1, settings.samples) : enough) && duration !== null && duration > settings.responseThreshold;
  const mostlyFailed = channel.config.cooldown?.error !== false && enough && samples.filter(a => a.result === 'error' || a.result === 'empty').length / samples.length >= 0.5;
  let status = channel.status;
  let reason = channel.health.reason;
  let cooldownUntil = channel.health.cooldownUntil;
  let recoveryCount = channel.health.recoveryCount;
  if (settings.autoSwitch && (tooSlow || mostlyFailed)) {
    status = mostlyFailed ? 'offline' : 'degraded';
    reason = mostlyFailed ? '最近请求失败率超过 50%' : latest.stream ? `连续 ${window} 次首字延迟均超过 ${settings.threshold}s` : `平均响应耗时 ${duration?.toFixed(2)}s 超过 ${settings.responseThreshold}s`;
    if (channel.status === 'healthy') cooldownUntil = new Date(nowMs + settings.cooldown * 1000).toISOString();
    recoveryCount = 0;
  }
  const currentGood = !failed && (latest.stream ? channel.config.cooldown?.firstToken === false || latest.ttft !== null && latest.ttft <= settings.threshold : latest.duration <= settings.responseThreshold);
  // Recovery depends on consecutive fresh samples; the stale slow window must not prevent recovery forever.
  if (channel.status !== 'healthy' && settings.autoRecover && nowMs >= Date.parse(channel.health.cooldownUntil || '1970-01-01')) {
    recoveryCount = currentGood ? channel.health.recoveryCount + 1 : 0;
    if (recoveryCount >= Math.max(1, settings.recovery)) { status = 'healthy'; cooldownUntil = null; reason = null; recoveryCount = 0; }
  }
  const patch: HealthDecision['patch'] = { samples: samples.length, failureCount, recoveryCount, reason, cooldownUntil };
  if (latest.stream) patch.averageTtft = ttft;
  else patch.averageDuration = duration;
  const decision: HealthDecision = { patch, status };
  if (status !== channel.status) decision.event = {
    id: crypto.randomUUID(), createdAt: new Date(nowMs).toISOString(), time: new Date(nowMs).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    title: status === 'healthy' ? '渠道已恢复' : '渠道健康度下降', description: `${channel.name}：${reason || '连续检测通过，恢复参与路由'}`,
    type: status === 'healthy' ? 'recovery' : 'warning', channelId: channel.id,
  };
  return decision;
}

export function autoDisableDecision(channel: GatewayChannel, settings: GatewaySettings, status: number, previousFailures: number, nowMs = Date.now()) {
  const local = channel.config.autoDisable;
  const enabled = local.enabled || settings.autoDisableEnabled;
  const statuses = local.enabled ? local.statuses : settings.autoDisableStatuses;
  const target = local.enabled ? local.target : settings.autoDisableTarget;
  const threshold = local.enabled ? local.threshold : settings.autoDisableThreshold;
  const recover = local.enabled ? local.recover : settings.autoDisableRecover;
  const cooldown = local.enabled ? local.cooldown : settings.autoDisableCooldown;
  const failureCount = statuses.includes(status) ? previousFailures + 1 : 0;
  return { target, failureCount, disable: channel.config.cooldown?.error !== false && enabled && failureCount >= Math.max(1, threshold), recover, cooldownUntil: new Date(nowMs + cooldown * 1000).toISOString() };
}
