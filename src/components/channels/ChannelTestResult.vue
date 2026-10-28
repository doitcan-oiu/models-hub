<script setup lang="ts">
import type { AttemptRecord } from '../../../shared/types';
import { computed } from 'vue';
import { seconds, resultColor, resultNames, dateTime } from '../../format';
const props = defineProps<{ result: { success?: boolean; status?: number; ttft?: number | null; duration?: number | null; error?: string | null; requestId?: string; attempts?: AttemptRecord[] } }>();
const attempts = computed(() => props.result.attempts ?? []);
const last = computed(() => attempts.value.at(-1));
const ttft = computed(() => last.value?.stream === false || (attempts.value.length && !attempts.value.some(item => item.ttft != null)) ? null : props.result.ttft);
const sanitize = (value: string) => value.replace(/\bBearer\s+[^\s"']+/gi, 'Bearer ••••').replace(/\bsk-[a-zA-Z0-9_-]{8,}/g, 'sk-••••').slice(0, 500);
</script>
<template>
  <div class="mt-4">
    <v-alert :type="result.success === false ? 'error' : last?.result === 'slow' ? 'warning' : 'success'" variant="tonal" density="compact" class="mb-4">{{ result.success === false ? '测试失败' : last?.result === 'slow' ? '响应偏慢' : '测试成功' }}<div v-if="result.error" class="text-body-2 mt-1">{{ sanitize(result.error) }}</div></v-alert>
    <div class="test-metrics"><div><span>HTTP 状态</span><strong>{{ result.status || '—' }}</strong></div><div><span>有效首字</span><strong>{{ last?.stream === false ? '不适用' : seconds(ttft) }}</strong></div><div><span>完成耗时</span><strong>{{ seconds(result.duration) }}</strong></div></div>
    <p v-if="result.requestId" class="text-caption text-medium-emphasis my-3">请求 ID：{{ result.requestId }}</p>
    <v-expansion-panels v-if="attempts.length" variant="accordion"><v-expansion-panel :title="`请求尝试（${attempts.length} 次）`"><v-expansion-panel-text><v-list lines="two" density="compact"><v-list-item v-for="(attempt, index) in attempts" :key="attempt.id || index" :title="`${index + 1}. ${attempt.channelName} · ${attempt.model}`" :subtitle="`${dateTime(attempt.startedAt)} · HTTP ${attempt.status} · 首字 ${seconds(attempt.ttft)} · 完成 ${seconds(attempt.duration)}`"><template #append><v-chip :color="resultColor(attempt.result)" size="small">{{ resultNames[attempt.result] }}</v-chip></template><p v-if="attempt.error" class="text-caption text-error">{{ sanitize(attempt.error) }}</p></v-list-item></v-list></v-expansion-panel-text></v-expansion-panel></v-expansion-panels>
  </div>
</template>
<style scoped>
.test-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; padding: 12px; background: rgba(var(--v-theme-on-surface), .035); border-radius: 4px; }
.test-metrics > div { display: flex; flex-direction: column; gap: 4px; }
.test-metrics span { font-size: 12px; color: rgba(var(--v-theme-on-surface), .6); }
.test-metrics strong { font-size: 18px; font-weight: 500; font-variant-numeric: tabular-nums; }
@media (max-width: 600px) { .test-metrics { gap: 10px; } .test-metrics strong { font-size: 16px; } }
</style>
