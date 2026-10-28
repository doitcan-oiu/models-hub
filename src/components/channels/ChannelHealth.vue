<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import type { GatewayChannel } from '../../../shared/types';
import { channelHealthView } from '../../channel-health';
const props = defineProps<{ channel: GatewayChannel; busy?: boolean; compact?: boolean }>();
const emit = defineEmits<{ reset: [] }>();
const now = ref(Date.now());
const timer = window.setInterval(() => { now.value = Date.now(); }, 1000);
onUnmounted(() => window.clearInterval(timer));
const health = computed(() => channelHealthView(props.channel, now.value));
const reason = computed(() => props.channel.health.reason || (props.channel.status !== 'healthy' || props.channel.health.autoDisabled ? health.value.reason : null));
const color = computed(() => ({ default: 'grey', success: 'success', warning: 'warning', danger: 'error' }[health.value.color]));
const history = computed(() => props.channel.history.slice(-14));
</script>

<template>
  <div class="channel-health">
    <div class="d-flex align-center ga-2 flex-wrap">
      <v-chip :color="color" size="small" variant="tonal" prepend-icon="mdi-circle-small">{{ health.label }}</v-chip>
      <span v-if="!compact" class="text-caption text-medium-emphasis">首字 {{ channel.health.averageTtft == null ? '—' : `${channel.health.averageTtft.toFixed(2)} s` }}</span>
    </div>
    <div v-if="!compact" class="health-history" role="img" :aria-label="history.length ? '最近检测，从左到右由旧到新' : '暂无健康历史，灰格表示暂无样本'" :title="history.length ? '最近检测：' + history.map(value => value === 0 ? '成功' : value === 1 ? '慢响应' : '失败').join('、') : '暂无健康历史，灰格表示暂无样本'">
      <i v-for="index in 14" :key="index" :class="history[index - (14 - history.length) - 1] === 0 ? 'bg-success' : history[index - (14 - history.length) - 1] === 1 ? 'bg-warning' : history[index - (14 - history.length) - 1] === 2 ? 'bg-error' : 'history-neutral'" />
    </div>
    <div v-if="reason" class="text-caption text-medium-emphasis mt-1">{{ reason }}</div>
    <div v-if="health.cooldownLabel || health.canReset" class="d-flex align-center ga-2 flex-wrap mt-1">
      <span v-if="health.cooldownLabel" class="text-caption text-warning" :title="health.cooldownTitle">{{ health.cooldownLabel }}</span>
      <v-btn v-if="health.canReset" size="x-small" variant="text" color="primary" :disabled="busy" @click="emit('reset')">{{ health.resetLabel }}</v-btn>
    </div>
  </div>
</template>

<style scoped>
.channel-health { min-width: 210px; max-width: 310px; }
.health-history { display: flex; gap: 3px; margin-top: 6px; max-width: 148px; }
.health-history i { flex: 1; height: 5px; border-radius: 2px; }
.history-neutral { background: rgba(var(--v-theme-on-surface), .13); }
</style>
