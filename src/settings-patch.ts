import type { GatewaySettings } from '../shared/types';

export const routingSettingKeys = [
  'maxChannelRetries', 'maxSameChannelRetries', 'retryDelayMs', 'streamFirstTokenTimeout', 'nonStreamTimeout',
  'threshold', 'responseThreshold', 'window', 'windowSeconds', 'samples', 'cooldown', 'recovery',
  'autoDisableThreshold', 'autoDisableCooldown', 'retryEnabled', 'emptyResponseDetection', 'autoSwitch',
  'autoRecover', 'autoDisableEnabled', 'autoDisableRecover', 'errorMode', 'customErrorMessage', 'strategy',
  'stickyMode', 'autoDisableTarget', 'retryStatuses', 'autoDisableStatuses',
] as const satisfies readonly (keyof GatewaySettings)[];

/** A routing editor must never replay connection settings from its opening snapshot. */
export function routingSettingsPatch(baseline: GatewaySettings, next: GatewaySettings): Partial<GatewaySettings> {
  const patch: Partial<GatewaySettings> = {};
  for (const key of routingSettingKeys) {
    if (JSON.stringify(baseline[key]) !== JSON.stringify(next[key])) Object.assign(patch, { [key]: next[key] });
  }
  return patch;
}
