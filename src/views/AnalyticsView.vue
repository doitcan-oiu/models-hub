<script setup lang="ts">
import { computed, ref } from 'vue';
import { useTheme } from 'vuetify';
import type { ChartData, ChartOptions } from 'chart.js';
import MetricChart from '../components/MetricChart.vue';
import MetricsControls from '../components/MetricsControls.vue';
import { useConsole } from '../composables/useConsole';
import { count, seconds } from '../format';
const { dashboard } = useConsole();
const theme = useTheme();
const view = ref('traffic');
const analytics = computed(() => dashboard.value.analytics);
const percent = (value: number | null | undefined) => value == null ? '—' : value.toFixed(1) + '%';
const metrics = computed(() => { const a = analytics.value; if (!a) return []; return [
  { title: '业务请求', value: count(a.totals.requests), detail: `${count(a.summary.streamRequests)} 次流式请求` },
  { title: '成功率', value: a.totals.requests ? percent(a.totals.successRate) : '—', detail: `${count(a.summary.failedRequests)} 次失败` },
  { title: 'P95 首字', value: seconds(a.summary.ttft.p95), detail: `${count(a.summary.ttft.samples)} 个 SSE 样本` },
  { title: 'P95 完成', value: seconds(a.summary.duration.p95), detail: '包括重试与等待' },
  { title: 'Token 用量', value: a.totals.inputTokens + a.totals.outputTokens ? count(a.totals.inputTokens + a.totals.outputTokens) : '—', detail: `${count(a.totals.inputTokens)} 输入 · ${count(a.totals.outputTokens)} 输出` },
  { title: '估算费用', value: a.summary.pricedTokens ? '$' + a.totals.cost.toFixed(4) : '—', detail: 'usage 覆盖 ' + (a.totals.requests ? percent(a.summary.usageCoverage) : '—') },
]; });
const performance = computed(() => { const a = analytics.value; if (!a) return []; return [
  ['平均首字', seconds(a.summary.ttft.average)], ['P50 首字', seconds(a.summary.ttft.p50)], ['平均完成', seconds(a.summary.duration.average)], ['重试率', a.totals.requests ? percent(a.summary.retryRate) : '—'], ['渠道切换', a.totals.requests ? percent(a.summary.switchRate) : '—'], ['吞吐量', a.totals.requests ? a.summary.throughput.toPrecision(3) + ' 次/min' : '—'], ['生成速度', a.summary.generationSpeed == null ? '—' : a.summary.generationSpeed.toFixed(1) + ' token/s'],
]; });
type Plan = { title: string; note: string; type: 'line' | 'bar' | 'doughnut'; data: ChartData; options?: ChartOptions; empty?: boolean };
const charts = computed<Plan[]>(() => {
  const a = analytics.value; if (!a) return [];
  const labels = a.timeline.map(point => new Date(point.time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', ...(a.range === '7d' ? { month: '2-digit', day: '2-digit' } : {}) }));
  const colors = theme.current.value.colors;
  const first = String(colors.primary), second = String(colors.success), ink = String(colors['on-surface']).replace(/^#([\da-f])([\da-f])([\da-f])$/i, '#$1$1$2$2$3$3');
  const line = (label: string, data: (number | null)[], color = first) => ({ label, data, borderColor: color, backgroundColor: color + '14', pointRadius: 2, borderWidth: 2, tension: .25 });
  const bars = (label: string, data: number[], color = first) => ({ label, data, backgroundColor: color, borderRadius: 4, maxBarThickness: 28 });
  const axis: ChartOptions = { scales: { x: { grid: { display: false }, ticks: { color: ink + '99', maxTicksLimit: 6, font: { size: 12 } } }, y: { beginAtZero: true, grid: { color: ink + '12' }, ticks: { color: ink + '99', font: { size: 12 } } }, y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { color: ink + '99', font: { size: 12 } } } } };
  if (view.value === 'traffic') return [
    { title: '请求量与成功率', note: '左轴：请求数 · 右轴：成功率 %', type: 'line', data: { labels, datasets: [{ ...line('请求数', a.timeline.map(point => point.requests)), fill: true }, { ...line('成功率 %', a.timeline.map(point => point.successRate), second), yAxisID: 'y1' }] }, options: { ...axis, scales: { ...axis.scales, y1: { ...axis.scales?.y1, max: 100 } } } },
    { title: '首字延迟', note: '秒 · 仅成功 SSE 请求', type: 'line', empty: !a.timeline.some(point => point.ttftP50 != null), data: { labels, datasets: [line('P50 首字', a.timeline.map(point => point.ttftP50)), line('P95 首字', a.timeline.map(point => point.ttftP95), second)] } },
    { title: '完整响应耗时', note: '秒 · 成功请求，包含重试等待', type: 'line', empty: !a.timeline.some(point => point.durationAverage != null), data: { labels, datasets: [line('平均耗时', a.timeline.map(point => point.durationAverage)), line('P95 完成', a.timeline.map(point => point.durationP95), second)] } },
    { title: '请求结果分布', note: '按业务请求的最终结果统计', type: 'doughnut', data: { labels: a.outcomes.filter(item => item.requests).map(item => ({ success: '直接成功', slow: '成功 · 响应缓慢', failover: '成功 · 渠道切换', error: '请求失败' }[item.result])), datasets: [{ data: a.outcomes.filter(item => item.requests).map(item => item.requests), backgroundColor: a.outcomes.filter(item => item.requests).map(item => ({ success: second, slow: String(colors.warning), failover: String(colors.info), error: String(colors.error) }[item.result])), borderWidth: 0 }] } },
  ];
  if (view.value === 'usage') { const models = a.models.slice(0, 8); return [
    { title: 'Token 用量趋势', note: '包括重试用量', type: 'bar', data: { labels, datasets: [bars('输入 Tokens', a.timeline.map(point => point.inputTokens)), bars('输出 Tokens', a.timeline.map(point => point.outputTokens), second)] } },
    { title: '模型用量排行', note: 'Token 总量前 8 名', type: 'bar', data: { labels: models.map(item => item.model), datasets: [bars('输入 Tokens', models.map(item => item.inputTokens)), bars('输出 Tokens', models.map(item => item.outputTokens), second)] } },
  ]; }
  const channels = a.channels.slice(0, 8), generation = a.channels.filter(item => item.generationSpeed != null).sort((left, right) => (right.generationSpeed ?? 0) - (left.generationSpeed ?? 0)).slice(0, 8);
  return [
    { title: '渠道表现', note: '左轴：成功率 % · 右轴：P95 首字秒数', type: 'bar', data: { labels: channels.map(item => item.name), datasets: [{ ...bars('成功率 %', channels.map(item => item.successRate), second), yAxisID: 'y' }, { label: 'P95 首字 s', data: channels.map(item => item.ttft.p95), backgroundColor: first, borderRadius: 4, maxBarThickness: 24, yAxisID: 'y1' }] }, options: { ...axis, scales: { ...axis.scales, y: { ...axis.scales?.y, max: 100 } } } },
    { title: '渠道生成速度', note: 'token/s · 速度前 8 名', type: 'bar', empty: !generation.length, data: { labels: generation.map(item => item.name), datasets: [bars('token/s', generation.map(item => item.generationSpeed ?? 0))] } },
  ];
});
</script>
<template>
  <v-alert v-if="!analytics" type="info" variant="tonal">统计数据尚未加载，请刷新页面。</v-alert>
  <div v-else class="analytics-workspace">
    <div class="analytics-tabbar"><v-tabs v-model="view" color="primary" density="compact"><v-tab value="traffic" prepend-icon="mdi-chart-line">流量与时延</v-tab><v-tab value="usage" prepend-icon="mdi-counter">Token 用量</v-tab><v-tab value="channels" prepend-icon="mdi-transit-connection-variant">渠道表现</v-tab></v-tabs><MetricsControls class="analytics-controls" /></div>
    <v-alert v-if="analytics.approximatePercentiles" type="info" variant="tonal" density="compact">数据量较大，延迟分位数采用抽样估算；请求数、Token 与费用为完整统计。</v-alert>
    <v-alert v-if="analytics.groupedRows" type="info" variant="tonal" density="compact">模型或渠道数量较多，部分明细合并为「其他」，总量统计包含全部记录。</v-alert>
    <div class="analytics-stage">
      <v-card v-if="charts[0]" variant="flat" border class="analytics-main-chart">
        <v-card-title class="section-heading"><div><h2>{{ charts[0].title }}</h2><p>{{ charts[0].note }}</p></div><v-icon icon="mdi-chart-timeline-variant" color="primary" size="18" /></v-card-title>
        <div class="chart-summary"><div v-for="(metric, index) in metrics.slice(0, 4)" :key="metric.title" :class="{ 'is-primary': index === 0 }"><span>{{ metric.title }}</span><strong>{{ metric.value }}</strong><small>{{ metric.detail }}</small></div></div>
        <v-card-text><div v-if="!analytics.totals.requests" class="chart-empty is-main"><div class="empty-state"><v-icon icon="mdi-chart-line" size="24" color="primary" /><h3 class="mt-3">暂无业务请求数据</h3><p class="mt-2">在测试场发起请求后，可在这里查看性能与用量。</p></div></div><div v-else-if="charts[0].empty" class="chart-empty is-main">暂无有效样本</div><MetricChart v-else :key="charts[0].title" :type="charts[0].type" :data="charts[0].data" :options="charts[0].options" :label="charts[0].title" :height="280" /></v-card-text>
        <p class="chart-footnote">统计业务请求，不含健康探测。北京时间 · 每点 {{ analytics.intervalMinutes < 60 ? analytics.intervalMinutes + ' 分钟' : analytics.intervalMinutes / 60 + ' 小时' }}。</p>
      </v-card>
      <v-card variant="flat" border class="analytics-details">
        <section class="analytics-side-section"><h2>用量与费用</h2><div class="usage-list"><div v-for="metric in metrics.slice(4)" :key="metric.title"><div><span>{{ metric.title }}</span><strong>{{ metric.value }}</strong></div><small>{{ metric.detail }}</small></div></div><p v-if="analytics.totals.requests && analytics.summary.usageCoverage < 100" class="usage-note"><v-icon icon="mdi-information-outline" size="15" color="info" /><span>{{ count(analytics.totals.requests - analytics.summary.usageRequests) }} 次请求未返回 usage，用量与费用仅含已返回的数据。</span></p><p v-if="analytics.summary.unpricedTokens > 0" class="usage-note is-warning"><v-icon icon="mdi-alert-circle-outline" size="15" /><span>{{ count(analytics.summary.unpricedTokens) }} 个 Token 未定价，暂未计入估算费用。</span></p></section>
        <section class="analytics-side-section"><h2>性能详情</h2><div class="performance-list"><div v-for="item in performance" :key="item[0]"><span>{{ item[0] }}</span><strong>{{ item[1] }}</strong></div></div></section>
      </v-card>
    </div>
    <div v-if="analytics.totals.requests" class="analytics-supporting" :class="{ 'has-three': charts.length > 3 }"><v-card v-for="chart in charts.slice(1)" :key="chart.title" variant="flat" border><v-card-title class="section-heading"><div><h2>{{ chart.title }}</h2><p>{{ chart.note }}</p></div></v-card-title><v-card-text><div v-if="chart.empty" class="chart-empty">暂无有效样本</div><MetricChart v-else :type="chart.type" :data="chart.data" :options="chart.options" :label="chart.title" :height="210" /></v-card-text></v-card></div>
  </div>
</template>
<style scoped>
.analytics-workspace { display: grid; gap: 14px; min-width: 0; }
.analytics-tabbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 14px; padding-bottom: 8px; border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.analytics-tabbar > .v-tabs { min-width: 0; flex: 1 1 auto; }
.analytics-controls { flex-shrink: 0; margin-left: auto; }
.analytics-stage { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 14px; align-items: start; min-width: 0; }
.analytics-main-chart { min-width: 0; border-top: 2px solid rgba(var(--v-theme-primary), .65) !important; }
.analytics-main-chart :deep(.section-heading h2) { font-size: 16px; }
.chart-summary { display: flex; flex-wrap: wrap; gap: 14px 22px; padding: 0 18px 16px; }
.chart-summary > div { min-width: 0; }
.chart-summary span { display: block; font-size: 12px; color: rgba(var(--v-theme-on-surface), .65); }
.chart-summary strong { display: block; font-size: 18px; font-weight: 600; letter-spacing: -.3px; margin-top: 5px; line-height: 1.3; font-variant-numeric: tabular-nums; white-space: nowrap; }
.chart-summary small { display: block; font-size: 12px; color: rgba(var(--v-theme-on-surface), .55); line-height: 1.5; margin-top: 3px; }
.chart-summary .is-primary { padding-right: 18px; border-right: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.chart-summary .is-primary strong { color: rgb(var(--v-theme-primary)); font-size: 22px; }
.chart-footnote { padding: 0 18px 14px; margin: 0; color: rgba(var(--v-theme-on-surface), .5); font-size: 12px; }
.analytics-details { padding: 16px; }
.analytics-side-section + .analytics-side-section { margin-top: 16px; padding-top: 14px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.analytics-side-section h2 { font-size: 13px; font-weight: 600; margin-bottom: 10px; }
.usage-list { display: grid; gap: 12px; }
.usage-list > div > div { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12px; color: rgba(var(--v-theme-on-surface), .7); }
.usage-list strong { font-size: 15px; font-weight: 600; color: rgb(var(--v-theme-on-surface)); font-variant-numeric: tabular-nums; }
.usage-list small { display: block; margin-top: 3px; font-size: 12px; color: rgba(var(--v-theme-on-surface), .55); line-height: 1.6; }
.usage-note { display: flex; align-items: flex-start; gap: 6px; margin: 10px 0 0; font-size: 12px; line-height: 1.6; color: rgba(var(--v-theme-on-surface), .65); }
.usage-note > .v-icon { flex-shrink: 0; margin-top: 3px; }
.usage-note.is-warning { color: rgb(var(--v-theme-warning)); }
.performance-list { display: grid; gap: 0; }
.performance-list > div { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 0; font-size: 12px; }
.performance-list span { color: rgba(var(--v-theme-on-surface), .65); }
.performance-list strong { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.analytics-supporting { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; min-width: 0; }
.analytics-supporting.has-three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.analytics-supporting > .v-card { min-width: 0; }
.chart-empty { height: 210px; display: grid; place-items: center; color: rgba(var(--v-theme-on-surface), .6); font-size: 13px; }
.chart-empty.is-main { height: 280px; }
@media (max-width: 1250px) { .analytics-stage { grid-template-columns: minmax(0, 1fr) 240px; } .chart-summary { gap: 14px 20px; } .chart-summary .is-primary { padding-right: 18px; } .analytics-supporting.has-three { grid-template-columns: repeat(2, minmax(0, 1fr)); } .analytics-supporting.has-three > .v-card:last-child { grid-column: 1 / -1; } }
@media (max-width: 1000px) { .chart-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); } .chart-summary .is-primary { border-right: 0; padding-right: 0; } }
@media (max-width: 850px) { .analytics-stage { grid-template-columns: minmax(0, 1fr); } .chart-summary { display: flex; gap: 14px 22px; } .analytics-details { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; } .analytics-side-section + .analytics-side-section { margin: 0; padding: 0 0 0 18px; border-top: 0; border-left: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); } }
@media (max-width: 600px) { .analytics-workspace { gap: 12px; } .chart-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 18px; padding: 0 16px 14px; } .chart-summary strong { font-size: 16px; } .chart-summary .is-primary strong { font-size: 22px; } .chart-footnote { padding-inline: 16px; } .analytics-supporting.has-three { grid-template-columns: minmax(0, 1fr); } .analytics-supporting.has-three > .v-card:last-child { grid-column: auto; } .analytics-tabbar :deep(.v-tab) { padding-inline: 12px; min-width: 0; font-size: 13px; } .analytics-tabbar :deep(.v-tab .v-icon) { display: none; } .analytics-details { grid-template-columns: minmax(0, 1fr); padding: 16px; gap: 16px; } .analytics-side-section + .analytics-side-section { padding: 14px 0 0; border-left: 0; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); } .performance-list { grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 14px; } .performance-list > div { align-items: flex-start; flex-direction: column; gap: 5px; } }
</style>
