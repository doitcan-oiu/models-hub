<script setup lang="ts">
import { computed } from 'vue';
import type { GatewayChannel, KeyProfile } from '../../../shared/types';
import { modelsForProfile } from '../../access-policy';
import { availableChannel, channelModels, eligibleChannels, scopedChannels } from './policy';
const props = defineProps<{ profile: KeyProfile; channels: GatewayChannel[] }>();
const scope = computed(() => scopedChannels(props.profile, props.channels));
const eligible = computed(() => eligibleChannels(props.profile, props.channels));
const healthy = computed(() => eligible.value.filter(availableChannel));
const models = computed(() => modelsForProfile(props.channels, props.profile, true));
function status(channel: GatewayChannel) {
  if (!channel.enabled) return '已停用';
  if (channel.health.autoDisabled) return '自动停用';
  if (channel.config.protocol !== 'mock' && channel.credentialCount === 0) return '未配置密钥';
  if (!eligible.value.some(item => item.id === channel.id)) return '模型未授权';
  return channel.status === 'healthy' ? '可用' : channel.status === 'degraded' ? '已降级' : '离线';
}
</script>

<template>
  <div class="scope-preview">
    <v-card variant="tonal" class="mb-5"><v-card-text class="scope-counts"><div><strong>{{ scope.length }}</strong><span>授权渠道</span></div><div><strong>{{ healthy.length }}</strong><span>健康可用</span></div><div><strong>{{ models.length }}</strong><span>授权模型</span></div></v-card-text></v-card>
    <p v-if="profile.scope === 'tags'" class="text-body-2 text-medium-emphasis mb-4">{{ profile.match === 'all' ? '同时包含全部标签' : profile.match === 'none' ? '排除以下标签' : '匹配任一标签' }}：{{ profile.tags.join('、') || '未选择标签' }}</p>
    <v-alert v-if="!scope.length || !healthy.length" type="warning" variant="tonal" density="compact" class="mb-4">{{ !scope.length ? '当前条件没有匹配渠道，请求将拒绝放行。' : '当前没有健康且可用的授权渠道，不会切换到范围外的渠道。' }}</v-alert>
    <div class="scope-content"><section><h4 class="text-subtitle-2 mb-3">授权渠道</h4><v-list v-if="scope.length" density="compact" class="preview-channels border" aria-label="授权渠道">
      <v-list-item v-for="channel in scope" :key="channel.id" :title="channel.name" :subtitle="channelModels(channel).join(' · ')"><template #append><v-chip size="small" :color="status(channel) === '可用' ? 'success' : undefined" variant="tonal">{{ status(channel) }}</v-chip></template></v-list-item>
    </v-list><span v-else class="text-medium-emphasis text-body-2">暂无匹配渠道</span></section><section><h4 class="text-subtitle-2 mb-3">可访问模型</h4>
    <div class="d-flex flex-wrap ga-2"><v-chip v-for="model in models" :key="model" size="small" variant="outlined">{{ model }}</v-chip><span v-if="!models.length" class="text-medium-emphasis text-body-2">暂无匹配模型</span></div></section></div>
    <p class="text-caption text-medium-emphasis mt-4 mb-0">故障切换仅在授权范围内进行。</p>
  </div>
</template>

<style scoped>
.scope-counts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.scope-counts strong { display: block; font-size: 18px; font-weight: 600; }
.scope-counts span { display: block; margin-top: 4px; font-size: 12px; opacity: .7; }
.scope-content { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 20px; }
.scope-content > section { min-width: 0; }
.preview-channels { max-height: 300px; overflow-y: auto; }
@media (max-width: 600px) { .scope-content { grid-template-columns: minmax(0, 1fr); } }
</style>
