<script setup lang="ts">
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue';
import type { AttemptRecord, GatewayLog } from '../../shared/types';
import { api } from '../api';
import { useConsole } from '../composables/useConsole';
import { count, dateTime, download, errorText, resultColor, resultNames, seconds } from '../format';
import { csvCell } from '../csv';
import AppDialog from '../components/AppDialog.vue';
const { notify, copy, refresh } = useConsole();
const logs = ref<GatewayLog[]>([]), total = ref(0), page = ref(1), query = ref(''), search = ref(''), result = ref('');
const loading = ref(false), clearing = ref(false), exporting = ref(false), error = ref(''), queryError = ref(''), confirmClear = ref(false);
const detail = ref<{ log: GatewayLog; attempts: AttemptRecord[] } | null>(null), detailOpen = ref(false), detailLoading = ref(false);
const composing = ref(false);
let version = 0, detailVersion = 0, active = false;
let loadController: AbortController | undefined, detailController: AbortController | undefined;
let debounce: ReturnType<typeof setTimeout> | undefined, interval: ReturnType<typeof setInterval> | undefined;
const sources: Record<string, string> = { api: 'API 调用', playground: '测试场', probe: '健康探测' };
const filters = [{ title: '全部结果', value: '' }, ...Object.entries(resultNames).filter(([key]) => ['success', 'error', 'slow', 'failover'].includes(key)).map(([value, title]) => ({ title, value }))];
const headers = [{ title: '时间', key: 'createdAt', sortable: false, width: 130 }, { title: '模型 / 请求 ID', key: 'model', sortable: false }, { title: '渠道 / 来源', key: 'channel', sortable: false }, { title: '响应耗时', key: 'duration', sortable: false }, { title: 'Tokens', key: 'tokens', sortable: false, align: 'end' as const }, { title: '结果', key: 'result', sortable: false }, { title: '', key: 'actions', sortable: false, width: 90 }];
const summaries = computed(() => ['success', 'error', 'slow', 'failover'].map(value => ({ value, count: logs.value.filter(log => log.result === value).length })));
async function load() {
  if (clearing.value || !active) return; loadController?.abort(); const controller = new AbortController(); loadController = controller; const request = ++version; loading.value = true; error.value = '';
  try { const data = await api<{ logs: GatewayLog[]; total: number }>('/api/logs?' + new URLSearchParams({ limit: '25', offset: String((page.value - 1) * 25), q: query.value, result: result.value }), { signal: controller.signal }); if (request !== version || clearing.value || !active) return; logs.value = data.logs; total.value = data.total; if (page.value > 1 && (page.value - 1) * 25 >= data.total) page.value = Math.max(1, Math.ceil(data.total / 25)); }
  catch (reason) { if (request === version && active) { logs.value = []; total.value = 0; error.value = errorText(reason); } }
  finally { if (request === version) { loading.value = false; loadController = undefined; } }
}
function updateSearch(value: string) { search.value = value; if (composing.value) return; if (new TextEncoder().encode(value).byteLength > 48) { queryError.value = '搜索词最多 48 字节（约 16 个汉字）；保留上一次有效搜索结果。'; return; } queryError.value = ''; query.value = value; }
watch([query, result], () => page.value = 1, { flush: 'sync' });
watch([query, result, page], () => {
  ++version; loadController?.abort(); loadController = undefined; clearTimeout(debounce);
  loading.value = active && !clearing.value;
  if (active && !clearing.value) debounce = setTimeout(() => void load(), 250);
}, { flush: 'sync' });
function deactivate() {
  active = false; ++version; ++detailVersion; loadController?.abort(); loadController = undefined; detailController?.abort(); detailController = undefined; clearInterval(interval); clearTimeout(debounce);
  interval = undefined; debounce = undefined; loading.value = false; detailLoading.value = false;
  detailOpen.value = false; detail.value = null; confirmClear.value = false; composing.value = false;
}
function activate() {
  if (active) return;
  active = true; clearInterval(interval); void load();
  interval = setInterval(() => { if (active && !loading.value && document.visibilityState === 'visible') void load(); }, 15000);
}
onMounted(activate);
onActivated(activate);
onDeactivated(deactivate);
onUnmounted(deactivate);
async function open(log: GatewayLog) { if (clearing.value || loading.value || !active) return; detailController?.abort(); const controller = new AbortController(); detailController = controller; const request = ++detailVersion; detailOpen.value = true; detailLoading.value = true; detail.value = null; try { const data = await api<{ log: GatewayLog; attempts: AttemptRecord[] }>('/api/logs/' + encodeURIComponent(log.id), { signal: controller.signal }); if (request === detailVersion && !clearing.value && active) detail.value = data; } catch (reason) { if (request === detailVersion && active) { notify(errorText(reason), 'error'); detailOpen.value = false; } } finally { if (request === detailVersion) { detailLoading.value = false; detailController = undefined; } } }
async function clearAll() { if (clearing.value) return; clearing.value = true; ++version; ++detailVersion; loadController?.abort(); loadController = undefined; detailController?.abort(); detailController = undefined; loading.value = false; detailLoading.value = false; try { await api('/api/logs', { method: 'DELETE' }); logs.value = []; total.value = 0; query.value = ''; search.value = ''; result.value = ''; page.value = 1; detail.value = null; detailOpen.value = false; confirmClear.value = false; notify('全部请求日志已清空'); await refresh(true); } catch (reason) { notify(errorText(reason), 'error'); } finally { clearing.value = false; void load(); } }
async function exportCsv() { exporting.value = true; try { const data = await api<{ logs: GatewayLog[] }>('/api/logs?' + new URLSearchParams({ limit: '200', q: query.value, result: result.value })); const rows = [['请求 ID', '时间', '模型', '渠道', '流式', '首字(s)', '完成(s)', 'HTTP', '结果', '尝试次数'], ...data.logs.map(log => [log.id, dateTime(log.createdAt), log.model, log.channel, log.stream ? '是' : '否', log.ttft, log.duration, log.status, resultNames[log.result], log.attempts])]; download('pulsegate-requests.csv', '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8'); notify(`已导出 ${data.logs.length} 条记录（每次最多 200 条）`); } catch (reason) { notify(errorText(reason), 'error'); } finally { exporting.value = false; } }
</script>
<template>
  <div class="requests-workspace">
    <v-card variant="flat" border class="requests-records">
      <div class="records-heading"><h2>请求明细 <span class="records-count">{{ loading || clearing ? '—' : count(total) }} 条{{ query || result ? '匹配' : '' }}</span></h2><div class="log-summary" aria-label="当前页结果分布"><span class="summary-page">本页 {{ loading || clearing ? '—' : logs.length }} 条</span><span v-for="summary in summaries" :key="summary.value" :class="[summary.value, { 'is-empty': !summary.count || loading || clearing }]"><i />{{ resultNames[summary.value] }} <b>{{ loading || clearing ? '—' : summary.count }}</b></span></div></div>
      <div class="requests-toolbar"><v-text-field :model-value="search" label="搜索请求" placeholder="请求 ID、模型或渠道" prepend-inner-icon="mdi-magnify" hide-details density="compact" :error="!!queryError" :disabled="clearing" class="log-search" @update:model-value="updateSearch" @compositionstart="composing = true" @compositionend="composing = false; updateSearch(search)" /><v-select v-model="result" label="请求结果" :items="filters" hide-details density="compact" :disabled="clearing" class="result-filter" /><v-spacer /><v-btn variant="tonal" prepend-icon="mdi-refresh" :loading="loading" :disabled="clearing" @click="load">刷新</v-btn><v-btn variant="text" prepend-icon="mdi-download-outline" :loading="exporting" :disabled="clearing" aria-label="导出 CSV" @click="exportCsv"><span class="export-full-label">导出 CSV</span><span class="export-compact-label">导出</span></v-btn><v-divider vertical class="toolbar-divider" /><v-btn variant="text" color="error" icon="mdi-delete-outline" aria-label="清空日志" title="清空全部日志" :disabled="clearing" @click="confirmClear = true" /></div>
      <v-alert v-if="queryError || error" :type="error ? 'error' : 'warning'" variant="tonal" class="mx-4 mb-4" density="compact">{{ error || queryError }}</v-alert>
      <div class="records-meta"><span>第 {{ page }} 页 · 每页 25 条 · 北京时间 · 活动页每 15 秒更新</span><v-btn v-if="query || result" size="small" variant="text" color="primary" prepend-icon="mdi-filter-remove-outline" :disabled="clearing" @click="search = ''; query = ''; result = ''; queryError = ''">清除筛选</v-btn></div>
    <v-data-table-server v-model:page="page" :headers="headers" :items="logs" :items-length="total" :items-per-page="25" :items-per-page-options="[25]" :loading="loading || clearing" item-value="id" class="resource-table requests-table" no-data-text="当前条件下没有请求记录">
      <template #item.createdAt="{ item }"><span class="log-time" :title="dateTime(item.createdAt)">{{ new Date(item.createdAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) }}</span><div class="table-secondary">{{ new Date(item.createdAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' }) }}</div></template>
      <template #item.model="{ item }"><strong>{{ item.model }}</strong><code class="table-secondary">{{ item.id.slice(0, 16) }}</code></template>
      <template #item.channel="{ item }">{{ item.channel || '未到达上游' }}<div class="table-secondary">{{ sources[item.source] }} · {{ item.stream ? 'SSE' : 'JSON' }}</div></template>
      <template #item.duration="{ item }"><strong>{{ seconds(item.duration) }}</strong><div class="table-secondary">首字 {{ seconds(item.ttft) }}</div></template>
      <template #item.tokens="{ item }">{{ count(item.tokens) }}</template>
      <template #item.result="{ item }"><v-chip :color="resultColor(item.result)" size="small" variant="tonal">{{ resultNames[item.result] }}</v-chip><div class="table-secondary">HTTP {{ item.status }}</div></template>
      <template #item.actions="{ item }"><v-btn variant="tonal" color="primary" size="small" :disabled="clearing || loading" @click="open(item)">追踪</v-btn><div class="table-secondary">{{ item.attempts }} 次尝试</div></template>
    </v-data-table-server>
  </v-card>
  </div>
  <AppDialog v-model="confirmClear" title="清空请求日志" max-width="440" :busy="clearing"><v-alert type="warning" variant="tonal">将删除全部请求日志及尝试记录。此操作无法撤销。</v-alert><p class="mt-4 text-medium-emphasis">当前筛选不会限制清空范围。</p><template #actions><v-spacer /><v-btn :disabled="clearing" @click="confirmClear = false">取消</v-btn><v-btn color="error" variant="flat" :loading="clearing" @click="clearAll">清空全部日志</v-btn></template></AppDialog>
  <AppDialog v-model="detailOpen" title="请求追踪" max-width="840"><div v-if="detailLoading" class="text-center pa-6"><v-progress-circular indeterminate color="primary" size="24" width="2" /></div><template v-else-if="detail"><div class="trace-heading"><v-chip :color="resultColor(detail.log.result)" size="small" variant="tonal">{{ resultNames[detail.log.result] }}</v-chip><code class="trace-id">{{ detail.log.id }}</code><v-btn icon="mdi-content-copy" size="x-small" variant="text" aria-label="复制请求 ID" @click="copy(detail.log.id)" /></div><p class="text-body-2 text-medium-emphasis">{{ dateTime(detail.log.createdAt) }} · {{ detail.log.model }} · {{ detail.log.stream ? 'SSE' : 'JSON' }}</p><div class="trace-overview"><div><span>首字延迟</span><strong>{{ seconds(detail.log.ttft) }}</strong></div><div><span>完整耗时</span><strong>{{ seconds(detail.log.duration) }}</strong></div><div><span>上游尝试</span><strong>{{ detail.log.attempts }} 次</strong></div><div><span>HTTP 状态</span><strong>{{ detail.log.status }}</strong></div></div><v-alert v-if="detail.log.error" type="error" variant="tonal" class="my-4">{{ detail.log.error }}</v-alert><h3 class="trace-section-title">路由过程</h3><v-timeline side="end" density="compact" class="request-timeline"><v-timeline-item v-for="attempt in detail.attempts" :key="attempt.id" :dot-color="resultColor(attempt.result)" size="x-small"><div class="trace-attempt-heading"><span class="trace-step">{{ attempt.attempt }}</span><strong>{{ attempt.channelName }}</strong><v-chip :color="resultColor(attempt.result)" size="x-small" variant="tonal">{{ resultNames[attempt.result] }}</v-chip></div><p class="text-body-2 mt-2">{{ attempt.model }} · HTTP {{ attempt.status }}</p><p class="text-caption text-medium-emphasis mt-1">首字 {{ seconds(attempt.ttft) }} · 完成 {{ seconds(attempt.duration) }} · {{ attempt.inputTokens }} 输入 / {{ attempt.outputTokens }} 输出 Tokens</p><p class="text-caption text-medium-emphasis">{{ attempt.credentialId ? '密钥 ' + attempt.credentialId.slice(0, 8) : '无上游密钥' }}</p><v-alert v-if="attempt.error" type="error" variant="tonal" density="compact" class="mt-2">{{ attempt.error }}</v-alert></v-timeline-item></v-timeline><div v-if="!detail.attempts.length" class="empty-state">此请求尚未到达上游</div></template><template #actions><v-spacer /><v-btn @click="detailOpen = false">关闭</v-btn></template></AppDialog>
</template>
<style scoped>
.requests-workspace { display: grid; gap: 14px; min-width: 0; }
.log-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; font-size: 12px; color: rgba(var(--v-theme-on-surface), .65); }
.log-summary > span { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.log-summary b { font-size: 12px; font-weight: 550; color: rgb(var(--v-theme-on-surface)); font-variant-numeric: tabular-nums; }
.log-summary i { width: 5px; height: 5px; border-radius: 50%; background: rgb(var(--v-theme-success)); flex-shrink: 0; }
.log-summary .error i { background: rgb(var(--v-theme-error)); }
.log-summary .slow i { background: rgb(var(--v-theme-warning)); }
.log-summary .failover i { background: rgb(var(--v-theme-info)); }
.log-summary .error:not(.is-empty) b { color: rgb(var(--v-theme-error)); }
.log-summary .slow:not(.is-empty) b { color: rgb(var(--v-theme-warning)); }
.log-summary .is-empty i { background: rgba(var(--v-theme-on-surface), .3); }
.log-summary .is-empty b { color: rgba(var(--v-theme-on-surface), .55); }
.summary-page { padding-right: 12px; border-right: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.requests-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 12px; }
.log-search { min-width: 200px; max-width: 440px; flex: 1; }
.result-filter { flex: 0 0 145px; }
.toolbar-divider { align-self: stretch; margin-block: 6px; }
.export-compact-label { display: none; }
.records-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 16px; padding: 14px 16px; border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.records-heading h2 { display: flex; align-items: baseline; gap: 8px; font-size: 14px; font-weight: 600; }
.records-count { font-size: 13px; font-weight: 400; color: rgba(var(--v-theme-on-surface), .65); white-space: nowrap; }
.records-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 28px; padding: 0 16px 8px; font-size: 12px; color: rgba(var(--v-theme-on-surface), .55); }
.requests-table :deep(td) { height: 56px !important; padding-block: 8px !important; }
.requests-table :deep(table) { min-width: 850px; }
.requests-table :deep(td strong) { font-weight: 550; }
.requests-table :deep(thead) { background: rgba(var(--v-theme-on-surface), .035); color: rgba(var(--v-theme-on-surface), .7); }
.requests-table :deep(thead th) { height: 36px !important; font-size: 12px; }
.log-time { font-variant-numeric: tabular-nums; font-size: 13px; }
.trace-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.trace-id { flex: 1; font-size: 12px; overflow-wrap: anywhere; color: rgba(var(--v-theme-on-surface), .7); }
.trace-overview { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; padding: 14px; margin-top: 16px; border-radius: 4px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); background: rgba(var(--v-theme-primary), .07); }
.trace-overview span { display: block; font-size: 12px; color: rgba(var(--v-theme-on-surface), .65); }
.trace-overview strong { display: block; margin-top: 6px; font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; }
.trace-section-title { font-size: 14px; font-weight: 600; margin: 18px 0 12px; }
.request-timeline :deep(.v-timeline-item__body) { padding-bottom: 12px; width: 100%; }
.trace-attempt-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; font-size: 13px; }
.trace-step { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 4px; background: rgba(var(--v-theme-primary), .12); color: rgb(var(--v-theme-primary)); font-size: 12px; font-weight: 600; }
@media (max-width: 1000px) { .requests-toolbar .v-spacer { display: none; } .log-search { max-width: none; } }
@media (max-width: 700px) { .requests-toolbar { display: grid; grid-template-columns: minmax(100px, 1fr) auto auto 32px; padding: 12px; gap: 8px; } .log-search { grid-column: 1 / -1; min-width: 0; width: 100%; } .result-filter { min-width: 0; width: 100%; } .toolbar-divider { display: none; } .requests-toolbar > .v-btn { height: 32px; font-size: 12px; padding-inline: 8px; min-width: 0; } .requests-toolbar > .v-btn:last-child { width: 32px; } .export-full-label { display: none; } .export-compact-label { display: inline; } .records-heading { padding: 14px; gap: 8px; } .log-summary { width: 100%; gap: 7px 12px; } .records-meta { padding-inline: 14px; flex-wrap: wrap; } .trace-overview { grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 14px; } }
@media (max-width: 400px) { .requests-toolbar > .v-btn :deep(.v-btn__prepend) { display: none; } }
</style>
