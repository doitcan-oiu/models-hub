<script setup lang="ts">
import { useConsole } from '../composables/useConsole';
const { range, lastUpdated, loading, refresh } = useConsole();
const ranges = [
  { title: '最近 1 小时', value: '1h' },
  { title: '最近 24 小时', value: '24h' },
  { title: '最近 7 天', value: '7d' },
];
</script>

<template>
  <div class="metrics-controls" aria-label="统计范围与刷新">
    <span v-if="lastUpdated" class="metrics-updated" :title="lastUpdated.toLocaleString('zh-CN')">{{ lastUpdated.toLocaleTimeString('zh-CN', { hour12: false }) }} 更新</span>
    <v-select v-model="range" :items="ranges" aria-label="统计时间范围" density="compact" hide-details class="metrics-range" />
    <v-btn variant="text" icon="mdi-refresh" aria-label="刷新统计" :loading="loading" @click="refresh()" />
  </div>
</template>

<style scoped>
.metrics-controls { display: flex; align-items: center; gap: 6px; min-width: 0; }
.metrics-range { width: 140px; min-width: 132px; flex: 0 0 140px; }
.metrics-updated { font-size: 12px; color: rgba(var(--v-theme-on-surface), .45); white-space: nowrap; }
.metrics-controls > .v-btn { flex: 0 0 auto; }
@media (max-width: 1250px) { .metrics-updated { display: none; } }
@media (max-width: 600px) { .metrics-range { width: 132px; flex-basis: 132px; } }
</style>
