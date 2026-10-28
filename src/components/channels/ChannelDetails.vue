<script setup lang="ts">
import type { GatewayChannel } from '../../../shared/types';
import { channelHealthView } from '../../channel-health';
import { count, dateTime, seconds } from '../../format';
defineProps<{ channel: GatewayChannel; now: number }>();
</script>
<template>
  <div class="channel-details">
    <div><span>上游端点</span><code>{{ channel.endpoint }}</code><p class="detail-note">{{ channel.config.protocol }} · {{ channel.config.relayUrl ? 'HTTP/HTTPS 中继' : '直连' }}</p></div>
    <div><span>模型与路由</span><p v-for="alias in channel.config.aliases" :key="alias.from">{{ alias.from }} → {{ alias.to }}</p><p v-if="!channel.config.aliases.length">未配置模型别名</p><p class="detail-note">{{ channel.credentialCount }} 个 Key · 优先级 {{ channel.priority }} · 权重 {{ channel.weight }}</p><div class="detail-models"><code v-for="model in channel.models" :key="model">{{ model }}</code></div></div>
    <div><span>健康判定</span><p>{{ channelHealthView(channel, now).reason }}</p><p class="detail-note">样本 {{ channel.health.samples }} · 失败 {{ channel.health.failureCount }} · 恢复 {{ channel.health.recoveryCount }}</p></div>
    <div><span>请求统计</span><p>{{ count(channel.requests) }} 次 · 成功率 {{ channel.successRate.toFixed(1) }}%</p><p class="detail-note">平均完成 {{ seconds(channel.health.averageDuration) }}</p><p class="detail-note">创建于 {{ dateTime(channel.createdAt) }}</p></div>
  </div>
</template>
<style scoped>
.channel-details { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 20px; padding: 18px; font-size: 13px; }
.channel-details > div { min-width: 0; overflow-wrap: anywhere; }
.channel-details > div > span { display: block; margin-bottom: 8px; font-size: 11px; color: rgba(var(--v-theme-on-surface), .5); }
.channel-details code { font-size: 11px; overflow-wrap: anywhere; }
.detail-note { margin-top: 7px; font-size: 11px; color: rgba(var(--v-theme-on-surface), .6); }
.detail-models { display: flex; flex-direction: column; gap: 4px; max-height: 140px; overflow-y: auto; margin-top: 8px; }
@media (max-width: 1100px) { .channel-details { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 600px) { .channel-details { grid-template-columns: minmax(0, 1fr); padding: 14px; } }
</style>
