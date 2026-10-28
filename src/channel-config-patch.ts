import type { ChannelConfig } from "../shared/types";
import { defaultChannelConfig } from "../shared/types";

export type ChannelConfigPatch = {
  [Key in keyof ChannelConfig]?: Key extends "conversions" | "rateLimit" | "endpoints" | "autoDisable" | "cooldown" | "mock"
    ? Partial<ChannelConfig[Key]>
    : ChannelConfig[Key];
};

export type ChannelConfigPanel = "aliases" | "prices" | "overrides" | "relay" | "rateLimit" | "endpoints" | "autoDisable";

const mergedFields = new Set<keyof ChannelConfig>(["conversions", "rateLimit", "endpoints", "autoDisable", "cooldown", "mock"]);
const panelFields: Record<ChannelConfigPanel, (keyof ChannelConfig)[]> = {
  aliases: ["aliases"], prices: ["prices"], overrides: ["headers", "bodyOverrides"], relay: ["relayUrl"],
  rateLimit: ["rateLimit"], endpoints: ["endpoints"], autoDisable: ["cooldown", "autoDisable"],
};

/** Match the admin API's merge rules; arrays and dynamic dictionaries replace their entire field. */
export function changedChannelConfig(next: Partial<ChannelConfig>, baseline: ChannelConfig): ChannelConfigPatch {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(next) as (keyof ChannelConfig)[]) {
    const value = next[key];
    if (value === undefined || JSON.stringify(value) === JSON.stringify(baseline[key])) continue;
    if (mergedFields.has(key)) {
      const before = { ...defaultChannelConfig[key] as unknown as Record<string, unknown>, ...baseline[key] as unknown as Record<string, unknown> };
      const entries = Object.entries(value as Record<string, unknown>).filter(([field, item]) => JSON.stringify(item) !== JSON.stringify(before[field]));
      if (entries.length) patch[key] = Object.fromEntries(entries);
    } else {
      patch[key] = value;
    }
  }
  return patch as ChannelConfigPatch;
}

export function channelConfigPatchForPanel(next: ChannelConfig, baseline: ChannelConfig, panel: ChannelConfigPanel): ChannelConfigPatch {
  const fields = Object.fromEntries(panelFields[panel].map((key) => [key, next[key]])) as Partial<ChannelConfig>;
  return changedChannelConfig(fields, baseline);
}
