<script setup lang="ts">
import type { GatewayChannel } from '../../../shared/types';
import { channelWebsite } from '../../channel-view';
withDefaults(defineProps<{ channel: GatewayChannel; showProvider?: boolean }>(), { showProvider: true });
</script>
<template>
  <div class="channel-identity">
    <div class="channel-title"><strong>{{ channel.name }}</strong><v-btn v-if="channelWebsite(channel)" :href="channelWebsite(channel)" target="_blank" rel="noopener noreferrer" icon="mdi-open-in-new" size="x-small" variant="text" :aria-label="'打开 ' + channel.name + ' 官网'" :title="'打开官网 · ' + channelWebsite(channel)" /></div>
    <div class="channel-subtitle"><span v-if="showProvider" class="provider-label">{{ channel.provider }}</span><span class="multiplier" :aria-label="'倍率 ' + (channel.displayMultiplier ?? 1)" :title="'倍率 ' + (channel.displayMultiplier ?? 1) + ' · 仅用于列表展示'">×{{ channel.displayMultiplier ?? 1 }}</span><span class="model-count">{{ channel.models.length }} 个模型</span></div>
  </div>
</template>
<style scoped>
.channel-identity { min-width: 0; }
.channel-title { display: flex; align-items: flex-start; gap: 5px; }
.channel-title > strong { min-width: 0; font-size: 15px; line-height: 1.5; font-weight: 650; overflow-wrap: anywhere; }
.channel-title > .v-btn { flex: 0 0 auto; margin-top: -2px; color: rgba(var(--v-theme-on-surface), .5); }
.channel-subtitle { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin-top: 5px; font-size: 11px; color: rgba(var(--v-theme-on-surface), .55); }
.provider-label { color: rgba(var(--v-theme-on-surface), .72); }
.multiplier { border: 1px solid rgba(var(--v-theme-on-surface), .16); border-radius: 4px; padding: 1px 5px; white-space: nowrap; color: rgba(var(--v-theme-on-surface), .72); font-variant-numeric: tabular-nums; }
.model-count { white-space: nowrap; }
</style>
