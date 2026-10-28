<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useTheme } from 'vuetify';
import { useConsole } from '../composables/useConsole';
import { channelHealthView } from '../channel-health';
import { count, dateTime, seconds } from '../format';
import MetricChart from '../components/MetricChart.vue';
import MetricsControls from '../components/MetricsControls.vue';
const { dashboard, channels, settings, editChannel, navigate, openPlayground } = useConsole();
const theme = useTheme();
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval>;
onMounted(() => { clock = setInterval(() => now.value = Date.now(), 1000); });
onUnmounted(() => clearInterval(clock));
const visible = computed(() => channels.value.filter(channel => !channel.archived));
const enabled = computed(() => visible.value.filter(channel => channel.enabled));
const states = computed(() => visible.value.map(channel => ({ channel, health: channelHealthView(channel, now.value) })));
const healthy = computed(() => states.value.filter(row => row.health.color === 'success').length);
const attention = computed(() => states.value.filter(row => row.channel.enabled && ['warning', 'danger'].includes(row.health.color)).length);
const pending = computed(() => states.value.filter(row => row.channel.enabled && row.health.color === 'default').length);
const gatewayStatus = computed(() => {
  if (!visible.value.length) return { label: '尚未接入渠道', color: 'secondary', icon: 'mdi-server-plus-outline' };
  if (!enabled.value.length) return { label: '所有渠道已停用', color: 'secondary', icon: 'mdi-pause-circle-outline' };
  if (attention.value) return { label: `${attention.value} 个渠道需要关注`, color: 'warning', icon: 'mdi-alert-circle-outline' };
  if (pending.value) return { label: `${pending.value} 个渠道待检测`, color: 'secondary', icon: 'mdi-clock-outline' };
  return { label: '渠道运行正常', color: 'success', icon: 'mdi-check-circle-outline' };
});
const healthPercent = computed(() => enabled.value.length ? healthy.value / enabled.value.length * 100 : 0);
const healthHeadline = computed(() => healthy.value ? '健康可用' : enabled.value.length ? '暂无健康渠道' : visible.value.length ? '渠道未启用' : '等待接入');
const mode = ref<'requests' | 'latency'>('requests');
const strategyNames = { failover: '故障转移', adaptive: '低延迟优先', 'round-robin': '轮询', weighted: '加权随机', 'circuit-breaker': '熔断保护' };
const chart = computed(() => {
  const analytics = dashboard.value.analytics;
  const points = analytics?.timeline ?? dashboard.value.latency;
  const colors = theme.current.value.colors;
  const primary = String(colors.primary), secondary = String(colors.secondary);
  const labels = points.map(point => new Date(point.time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit', ...(analytics?.range === '7d' ? { month: 'numeric', day: 'numeric' } : {}) }));
  if (mode.value === 'requests') return { labels, datasets: [{ label: '业务请求', data: points.map(point => point.requests), backgroundColor: primary, borderRadius: 3, maxBarThickness: 24 }] };
  return { labels, datasets: [
    { label: analytics ? '首字 P50（秒）' : '优先渠道平均首字（秒）', data: analytics ? analytics.timeline.map(point => point.ttftP50) : dashboard.value.latency.map(point => point.primary), borderColor: primary, backgroundColor: primary + '14', tension: .25, fill: true, pointRadius: 2 },
    { label: analytics ? '首字 P95（秒）' : '其他渠道平均首字（秒）', data: analytics ? analytics.timeline.map(point => point.ttftP95) : dashboard.value.latency.map(point => point.backup), borderColor: secondary, tension: .25, pointRadius: 2 },
  ] };
});
const summary = computed(() => [
  { label: '成功率', value: dashboard.value.totals.requests ? dashboard.value.totals.successRate.toFixed(1) + '%' : '—', icon: 'mdi-check-circle-outline' },
  { label: '平均首字', value: seconds(dashboard.value.totals.averageTtft || null), icon: 'mdi-timer-outline' },
  { label: 'Token 用量', value: count(dashboard.value.totals.inputTokens + dashboard.value.totals.outputTokens), icon: 'mdi-layers-outline' },
]);
const healthColor = (color: string) => color === 'danger' ? 'error' : color === 'default' ? undefined : color;
const eventColor = (type: string) => type === 'warning' ? 'warning' : type === 'recovery' ? 'success' : 'primary';
</script>
<template>
  <div class="overview-view">
    <div class="overview-actions"><div class="overview-status"><v-chip :color="gatewayStatus.color" :prepend-icon="gatewayStatus.icon" variant="tonal">{{ gatewayStatus.label }}</v-chip><span class="overview-context">{{ enabled.length }} 个已启用渠道 · {{ strategyNames[settings.strategy] }}</span></div><div class="overview-commands"><MetricsControls /><v-btn variant="outlined" prepend-icon="mdi-plus" @click="editChannel('new')">添加渠道</v-btn><v-btn color="primary" variant="flat" prepend-icon="mdi-play-outline" @click="openPlayground()">发起测试</v-btn></div></div>
    <div class="overview-primary">
      <v-card border class="traffic-panel">
        <div class="section-heading"><div><h2>业务流量</h2><p>业务请求统计，不含健康探测</p></div><v-btn-toggle v-model="mode" mandatory density="compact" color="primary" variant="tonal" divided><v-btn value="requests" size="small">请求量</v-btn><v-btn value="latency" size="small">首字延迟</v-btn></v-btn-toggle></div>
        <div class="traffic-summary"><div class="request-total"><strong>{{ count(dashboard.totals.requests) }}</strong><span>次请求</span></div><div v-for="metric in summary" :key="metric.label" class="traffic-stat"><span><v-icon :icon="metric.icon" size="15" />{{ metric.label }}</span><strong>{{ metric.value }}</strong></div></div>
        <div class="traffic-chart"><MetricChart :type="mode === 'requests' ? 'bar' : 'line'" :data="chart" :height="230" label="业务请求趋势" :options="{ plugins: { legend: { display: mode === 'latency' } } }" /></div>
        <div class="panel-footer"><span>北京时间 · 按所选时间范围汇总</span><v-btn variant="text" color="primary" size="small" append-icon="mdi-arrow-right" @click="navigate('analytics')">完整分析</v-btn></div>
      </v-card>
      <v-card border class="health-panel">
        <div class="section-heading"><h2>渠道健康</h2><v-icon icon="mdi-shield-check-outline" :color="gatewayStatus.color" size="18" /></div>
        <div class="health-overview"><v-progress-circular :model-value="healthPercent" :color="gatewayStatus.color" size="72" width="5"><span class="ring-value">{{ healthy }}<small>/ {{ enabled.length }}</small></span></v-progress-circular><div><strong>{{ healthHeadline }}</strong><p>已启用渠道中</p><v-btn variant="text" size="small" color="primary" append-icon="mdi-arrow-right" class="health-manage" @click="navigate('channels')">管理渠道</v-btn></div></div>
        <div class="health-counts"><div><i class="bg-success" />健康 <b>{{ healthy }}</b></div><div><i class="bg-warning" />异常 <b>{{ attention }}</b></div><div><i class="bg-secondary" />待检测 <b>{{ pending }}</b></div></div>
        <v-divider class="mx-4" />
        <dl class="routing-facts"><div><dt>路由策略</dt><dd>{{ strategyNames[settings.strategy] }}</dd></div><div><dt>首字超时</dt><dd>{{ settings.streamFirstTokenTimeout ? settings.streamFirstTokenTimeout + ' 秒' : '已关闭' }}</dd></div><div><dt>跨渠道重试</dt><dd>{{ settings.retryEnabled ? settings.maxChannelRetries + ' 次' : '已关闭' }}</dd></div><div><dt>会话粘性</dt><dd>{{ settings.stickyMode === 'prefer' ? '已启用' : '已关闭' }}</dd></div></dl>
        <div class="health-setting"><v-btn variant="text" prepend-icon="mdi-tune-variant" size="small" @click="navigate('settings', 'routing')">调整调度策略</v-btn></div>
      </v-card>
    </div>
    <div class="overview-secondary">
      <v-card border class="upstream-panel"><div class="section-heading"><div class="d-flex align-center ga-3"><h2>上游渠道</h2><v-chip size="x-small" variant="tonal">{{ visible.length }}</v-chip></div><v-btn variant="text" color="primary" size="small" append-icon="mdi-arrow-right" @click="navigate('channels')">查看全部</v-btn></div><v-table class="resource-table"><thead><tr><th>渠道 / 服务商</th><th>健康状态</th><th>平均首字</th><th class="text-right">累计尝试</th><th /></tr></thead><tbody><tr v-for="row in states.slice(0, 6)" :key="row.channel.id"><td><div class="channel-identity"><v-avatar size="26" variant="tonal"><v-icon icon="mdi-server-network-outline" size="14" /></v-avatar><div><strong>{{ row.channel.name }}</strong><span class="table-secondary">{{ row.channel.provider }}</span></div></div></td><td><v-chip :color="healthColor(row.health.color)" size="small" variant="tonal">{{ row.health.label }}</v-chip><div v-if="row.health.cooldownLabel" class="table-secondary text-warning">{{ row.health.cooldownLabel }}</div></td><td>{{ seconds(row.channel.health.averageTtft) }}</td><td class="text-right">{{ count(row.channel.requests) }}</td><td><v-btn icon="mdi-arrow-top-right" variant="text" size="small" :aria-label="'编辑 ' + row.channel.name" @click="editChannel(row.channel)" /></td></tr><tr v-if="!visible.length"><td colspan="5" class="empty-cell"><v-icon icon="mdi-server-plus-outline" size="24" /><p>添加第一个渠道，开始连接模型服务。</p><v-btn color="primary" @click="editChannel('new')">添加渠道</v-btn></td></tr></tbody></v-table></v-card>
      <section class="events-panel" aria-labelledby="events-title"><div class="section-heading"><h2 id="events-title">运行动态</h2><v-icon icon="mdi-history" size="18" class="text-medium-emphasis" /></div><div v-if="!dashboard.events.length" class="empty-state">暂无调度或健康事件</div><div class="event-list"><div v-for="event in dashboard.events.slice(0, 4)" :key="event.id" class="event-item"><v-avatar :color="eventColor(event.type)" variant="tonal" size="24"><v-icon :icon="event.type === 'warning' ? 'mdi-alert-outline' : event.type === 'recovery' ? 'mdi-check' : 'mdi-swap-horizontal'" size="14" /></v-avatar><div><time>{{ dateTime(event.createdAt) }}</time><strong>{{ event.title }}</strong><p>{{ event.description }}</p></div></div></div></section>
    </div>
  </div>
</template>
<style scoped>
.overview-actions { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; margin-bottom:14px; }
.overview-status,.overview-commands { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.overview-context { font-size:13px; color:rgba(var(--v-theme-on-background),.55); }
.overview-primary { display:grid; grid-template-columns:minmax(0,2.3fr) minmax(300px,1fr); gap:14px; }
.traffic-panel { min-width:0; }
.traffic-summary { display:flex; align-items:center; gap:20px; padding:0 18px 16px; }
.request-total { display:flex; align-items:baseline; gap:9px; margin-right:auto; }
.request-total strong { font-size:32px; line-height:1.25; font-weight:600; letter-spacing:-.6px; font-variant-numeric:tabular-nums; }
.request-total>span { font-size:13px; color:rgba(var(--v-theme-on-surface),.55); white-space:nowrap; }
.traffic-stat { display:flex; flex-direction:column; gap:5px; }
.traffic-stat>span { display:flex; align-items:center; gap:6px; font-size:12px; color:rgba(var(--v-theme-on-surface),.6); white-space:nowrap; }
.traffic-stat strong { font-size:18px; font-weight:550; font-variant-numeric:tabular-nums; }
.traffic-chart { padding:0 14px 12px; }
.panel-footer { display:flex; align-items:center; justify-content:space-between; gap:12px; border-top:1px solid rgba(var(--v-border-color),.08); padding:6px 12px 6px 18px; }
.panel-footer>span { font-size:12px; color:rgba(var(--v-theme-on-surface),.5); }
.health-panel { display:flex; flex-direction:column; }
.health-overview { display:flex; align-items:center; gap:16px; padding:0 18px 16px; }
.ring-value { font-size:22px; color:rgb(var(--v-theme-on-surface)); font-weight:600; }
.ring-value small { font-size:12px; font-weight:400; color:rgba(var(--v-theme-on-surface),.5); }
.health-overview strong { font-size:15px; font-weight:550; }
.health-overview p { font-size:13px; color:rgba(var(--v-theme-on-surface),.55); margin-top:5px; }
.health-manage { padding-inline:0; margin-left:-3px; margin-top:4px; }
.health-counts { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:0 18px 16px; font-size:12px; color:rgba(var(--v-theme-on-surface),.65); }
.health-counts>div { display:flex; align-items:center; gap:6px; }
.health-counts i { width:6px; height:6px; border-radius:50%; }
.health-counts b { font-size:13px; font-weight:550; margin-left:3px; color:rgb(var(--v-theme-on-surface)); }
.routing-facts { display:grid; gap:9px; padding:14px 18px 8px; font-size:12px; }
.routing-facts>div { display:flex; justify-content:space-between; gap:12px; }
.routing-facts dt { color:rgba(var(--v-theme-on-surface),.6); }
.routing-facts dd { font-weight:500; }
.health-setting { padding:6px 12px 10px; margin-top:auto; }
.overview-secondary { display:grid; grid-template-columns:minmax(0,2.3fr) minmax(300px,1fr); gap:14px; margin-top:16px; }
.upstream-panel { min-width:0; }
.channel-identity { display:flex; align-items:center; gap:8px; min-width:140px; }
.channel-identity .table-secondary { margin-top:3px; }
.resource-table :deep(td) { padding-block:6px!important; }
.resource-table :deep(table) { min-width:690px; }
.events-panel { border-left:1px solid rgba(var(--v-border-color),.12); }
.events-panel .section-heading { padding-top:4px!important; }
.event-list { padding:0 18px; }
.event-item { display:flex; align-items:flex-start; gap:9px; padding:0 0 14px; }
.event-item>.v-avatar { flex:0 0 24px; }
.event-item>div:last-child { flex:1; min-width:0; }
.event-item time { display:block; font-size:12px; color:rgba(var(--v-theme-on-background),.45); margin-bottom:3px; }
.event-item strong { display:block; font-size:13px; font-weight:550; }
.event-item p { font-size:12px; line-height:1.6; color:rgba(var(--v-theme-on-background),.6); margin-top:4px; }
@media(max-width:600px){.traffic-panel>.section-heading{flex-wrap:wrap;align-items:flex-start}.traffic-panel>.section-heading>div{width:100%}.traffic-panel>.section-heading .v-btn-toggle{max-width:100%;flex:0 0 auto}}
@media(max-width:1200px){.traffic-summary{gap:20px}.traffic-stat strong{font-size:17px}.overview-primary,.overview-secondary{grid-template-columns:minmax(0,2fr) minmax(290px,1fr)}}
@media(max-width:1000px){.overview-primary{grid-template-columns:1fr}.health-panel{display:grid;grid-template-columns:1fr 1fr}.health-panel .section-heading{grid-column:1/-1}.health-overview{grid-row:2/5}.health-panel .v-divider{display:none}.health-counts{padding-top:0}.health-setting{margin-top:0}.routing-facts{padding-top:0}.overview-secondary{grid-template-columns:1fr}.events-panel{border-left:0;border-top:1px solid rgba(var(--v-border-color),.12);padding-top:16px}.event-list{display:grid;grid-template-columns:1fr 1fr;gap:10px 18px}}
@media(max-width:600px){.overview-context{display:none}.overview-actions{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}.overview-commands{display:grid;grid-template-columns:1fr 1fr;gap:8px}.overview-commands>.metrics-controls{grid-column:1/-1;justify-content:space-between}.overview-commands>.v-btn{width:100%}.traffic-summary{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding-inline:16px}.request-total strong{font-size:28px}.traffic-stat:last-child{border-top:1px solid rgba(var(--v-border-color),.1);padding-top:10px}.traffic-stat:nth-child(3){border-top:1px solid rgba(var(--v-border-color),.1);padding-top:10px}.traffic-chart{padding-inline:10px}.panel-footer>span{display:none}.panel-footer{justify-content:flex-end}.health-panel{display:flex}.health-overview{padding-inline:16px}.health-counts{padding:0 16px 14px;justify-content:flex-start;gap:20px}.routing-facts{padding:14px 16px 6px}.event-list{grid-template-columns:1fr;padding:0 4px}.events-panel .section-heading{padding-inline:4px!important}.overview-primary,.overview-secondary{gap:12px}.section-heading .v-btn-toggle .v-btn{padding-inline:10px}}
</style>
