<script setup lang="ts">
import { computed, ref } from 'vue';
import type { GatewaySettings } from '../../../shared/types';
import SettingRangeControl from './SettingRangeControl.vue';
import { buildHealthExample, formatExampleSeconds, healthExampleScenarios, healthExampleSettings, visibleHealthRequests, type HealthExampleMode, type HealthExampleRequest, type HealthExampleScenario } from './health-examples';
import { numericFields, type NumericKey } from './routing-fields';

const props = defineProps<{ numeric: Record<NumericKey, string>; settings: GatewaySettings; previewError?: string }>();
const emit = defineEmits<{ 'update:numeric': [value: Record<NumericKey, string>]; 'update:autoSwitch': [value: boolean]; 'update:autoRecover': [value: boolean] }>();
const mode = ref<HealthExampleMode>('stream');
const scenario = ref<HealthExampleScenario>('fixed');
const example = computed(() => { if (props.previewError) return null; const settings = healthExampleSettings(props.settings, props.numeric); return settings ? buildHealthExample(settings, mode.value, scenario.value) : null; });
const visible = computed(() => example.value ? visibleHealthRequests(example.value.requests, 6) : { first: [], last: [], omitted: 0 });
const core = [
  { key: 'threshold', title: '首字阈值', hint: '流式：连续满窗口均超过此值才切换。', sliderMax: 60 },
  { key: 'responseThreshold', title: '完整响应阈值', hint: '非流式：成功响应的平均耗时上限。', sliderMax: 120 },
  { key: 'window', title: '观察请求数', hint: '流式与非流式分别统计最近 N 次。', sliderMax: 100 },
] satisfies { key: NumericKey; title: string; hint: string; sliderMax: number }[];
const advanced = [
  { key: 'samples', title: '最少样本数', hint: '用于失败比例和非流式平均耗时。', sliderMax: 100 },
  { key: 'windowSeconds', title: '统计时间范围', hint: '0 为不限；按请求开始时间统计。', sliderMax: 3600 },
  { key: 'cooldown', title: '恢复冷却', hint: '结束后允许探测，不会立即恢复。', sliderMax: 600 },
  { key: 'recovery', title: '连续恢复次数', hint: '探测失败会重置连续次数。', sliderMax: 20 },
] satisfies { key: NumericKey; title: string; hint: string; sliderMax: number }[];
const samplesTooLarge = computed(() => Number(props.numeric.samples) > Number(props.numeric.window));
const previewTimeout = computed(() => Number(mode.value === 'stream' ? props.numeric.streamFirstTokenTimeout : props.numeric.nonStreamTimeout));
const previewMaximum = computed(() => Math.max(0, ...(example.value?.requests.filter(request => request.result !== 'error').map(request => request.stream ? request.ttft ?? 0 : request.duration) ?? [])));
const timeoutConflict = computed(() => previewTimeout.value > 0 && previewTimeout.value <= previewMaximum.value);
function update(key: NumericKey, value: string) { emit('update:numeric', { ...props.numeric, [key]: value }); }
function rangeStep(key: NumericKey) { const field = numericFields[key]; return 'step' in field ? Number(field.step) : 1; }
function latency(request: HealthExampleRequest) { return request.result === 'error' ? '错误 503' : `${formatExampleSeconds(request.stream ? request.ttft ?? 0 : request.duration)}s`; }
function requestWidth(request: HealthExampleRequest) { if (request.result === 'error') return '100%'; const elapsed = request.stream ? request.ttft ?? 0 : request.duration; return `${Math.max(3, Math.min(100, elapsed / Math.max(.001, (example.value?.threshold ?? 1) * 2) * 100))}%`; }
</script>

<template>
  <section class="health-panel" aria-label="健康检查配置">
    <div class="health-intro"><div><h2>健康检查</h2><p>持续缓慢或大量失败时，切换到可用渠道。</p></div><v-switch :model-value="settings.autoSwitch" color="primary" label="自动切换" density="compact" hide-details aria-label="自动切换" @update:model-value="emit('update:autoSwitch', !!$event)" /></div>
    <div class="health-controls"><SettingRangeControl v-for="field in core" :key="field.key" :model-value="numeric[field.key]" :title="field.title" :hint="field.hint" :min="numericFields[field.key].min" :max="numericFields[field.key].max" :step="rangeStep(field.key)" :unit="numericFields[field.key].unit" :slider-max="field.sliderMax" @update:model-value="update(field.key, $event)" /></div>
    <v-alert v-if="samplesTooLarge" type="warning" variant="tonal" density="compact" class="health-alert">最少样本数不能大于观察请求数，否则失败比例和非流式平均耗时规则无法触发。</v-alert>
    <v-expansion-panels variant="accordion" class="health-advanced"><v-expansion-panel title="观察范围与恢复"><v-expansion-panel-text><div class="advanced-controls"><SettingRangeControl v-for="field in advanced" :key="field.key" :model-value="numeric[field.key]" :title="field.title" :hint="field.hint" :min="numericFields[field.key].min" :max="numericFields[field.key].max" :unit="numericFields[field.key].unit" :slider-max="field.sliderMax" @update:model-value="update(field.key, $event)" /></div><div class="health-toggle recovery-toggle"><div><strong>自动恢复</strong><p>冷却后探测，连续通过才恢复调度。</p></div><v-switch :model-value="settings.autoRecover" color="primary" density="compact" hide-details aria-label="自动恢复" @update:model-value="emit('update:autoRecover', !!$event)" /></div></v-expansion-panel-text></v-expansion-panel></v-expansion-panels>
    <section class="health-preview" aria-label="健康检查请求演示">
      <div class="preview-heading"><h3>请求演示</h3><p>按当前设置计算，不发送请求。</p></div>
      <div class="preview-toolbar"><div class="mode-options" role="group" aria-label="演示响应方式"><button type="button" :class="{ selected: mode === 'stream' }" :aria-pressed="mode === 'stream'" @click="mode = 'stream'">流式 · 首字</button><button type="button" :class="{ selected: mode === 'complete' }" :aria-pressed="mode === 'complete'" @click="mode = 'complete'">非流式 · 完整响应</button></div><v-select v-model="scenario" :items="healthExampleScenarios" item-title="title" item-value="value" label="请求场景" hide-details density="compact" variant="outlined" /></div>
      <div v-if="!example" class="preview-paused" role="status"><v-icon icon="mdi-pencil-outline" /> {{ previewError || '请先填写有效的配置数值，演示会自动继续。' }}</div>
      <template v-else>
        <v-alert v-if="timeoutConflict" type="warning" variant="tonal" density="compact" class="health-alert preview-timeout">本例最长需 {{ formatExampleSeconds(previewMaximum) }}s，真实请求可能先在 {{ previewTimeout }}s 超时。以下按成功响应演示；可在「重试与响应」调高超时，或设 0 关闭。</v-alert>
        <div class="preview-result" :class="{ triggered: example.triggered, paused: !settings.autoSwitch }" role="status" aria-live="polite"><v-icon :icon="!settings.autoSwitch ? 'mdi-pause-circle-outline' : example.triggered ? 'mdi-swap-horizontal' : 'mdi-check-circle-outline'" /><div><strong>{{ !settings.autoSwitch ? '不会自动切换' : example.triggered ? example.decision.status === 'offline' ? '会切换 · 大量错误' : '会切换 · 持续缓慢' : '暂不切换 · 继续观察' }}</strong><p>{{ example.explanation }}</p></div></div>
        <div class="preview-facts"><span>实际统计 <strong>{{ example.includedCount }}</strong> / {{ numeric.window }} 次</span><span v-if="mode === 'stream'">慢首字：<strong>&gt; {{ numeric.threshold }}s</strong></span><span v-else>平均耗时：<strong>{{ formatExampleSeconds(example.averageDuration ?? 0) }}s</strong></span><span>失败 <strong>{{ example.failureCount }}</strong> 次</span></div>
        <ol class="request-grid"><li v-for="request in [...visible.first, ...visible.last]" :key="request.id" class="request-sample" :class="{ excluded: !request.included, failed: request.result === 'error', slow: request.result === 'slow' }"><div><span>#{{ request.position }}</span><strong>{{ latency(request) }}</strong></div><div class="request-meter"><span :style="{ width: requestWidth(request) }" /></div><small>{{ !request.included ? '超出统计范围' : request.result === 'error' ? '请求失败' : request.result === 'slow' ? '超过阈值' : '阈值内' }}</small></li></ol>
        <p v-if="visible.omitted" class="request-omitted">完整窗口已计算，省略中间 {{ visible.omitted }} 次展示。</p>
        <details class="preview-details"><summary>判定说明</summary><p v-if="example.scenarioNote">{{ example.scenarioNote }}</p><p>流式与非流式分别统计。渠道的冷却豁免仍生效；健康切换与「自动禁用」独立。</p></details>
      </template>
    </section>
    <div class="recovery-flow" aria-label="恢复流程"><span>异常切换</span><v-icon icon="mdi-chevron-right" size="16" /><span>冷却 {{ numeric.cooldown }}s</span><v-icon icon="mdi-chevron-right" size="16" /><span>{{ settings.autoRecover ? `连续 ${numeric.recovery} 次探测通过后恢复` : '手动恢复' }}</span></div>
  </section>
</template>

<style scoped>
.health-panel { container-type: inline-size; min-width: 0; padding: 18px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 10px; background: rgb(var(--v-theme-surface)); }
.health-intro, .preview-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.health-intro { margin-bottom: 14px; }
.health-intro h2 { margin: 0 0 3px; font-size: 18px; font-weight: 650; line-height: 1.5; }
.health-intro p, .preview-heading p { margin: 0; font-size: 12px; line-height: 1.6; color: rgba(var(--v-theme-on-surface), .65); }
.health-intro > .v-input { flex: 0 0 auto; }
.health-intro :deep(.v-label) { font-size: 13px; }
.health-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 8px; background: rgba(var(--v-theme-on-surface), .025); }
.health-toggle strong { font-size: 13px; font-weight: 600; }.health-toggle p { margin: 3px 0 0; font-size: 12px; line-height: 1.5; color: rgba(var(--v-theme-on-surface), .6); }.health-toggle > .v-input { flex: 0 0 auto; }
.health-controls { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }.advanced-controls { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.health-advanced { margin-top: 10px; }.health-advanced :deep(.v-expansion-panel) { border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); box-shadow: none; border-radius: 8px !important; }.health-advanced :deep(.v-expansion-panel-title) { min-height: 42px; padding: 10px 14px; font-size: 13px; }.health-advanced :deep(.v-expansion-panel-text__wrapper) { padding: 0 12px 12px; }.recovery-toggle { margin-top: 10px; }.health-alert { margin-top: 10px; font-size: 12px; }.preview-timeout { margin: 0 0 10px; }
.health-preview { margin-top: 14px; padding: 14px; border: 1px solid rgba(var(--v-theme-primary), .22); border-radius: 9px; background: rgba(var(--v-theme-primary), .025); min-width: 0; }.preview-heading h3 { margin: 0; font-size: 15px; font-weight: 600; }
.preview-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, .8fr); gap: 12px; align-items: center; margin: 12px 0; }.mode-options { display: flex; align-items: stretch; gap: 3px; padding: 3px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 7px; width: fit-content; max-width: 100%; background: rgb(var(--v-theme-surface)); }.mode-options button { border: 0; background: transparent; padding: 7px 10px; border-radius: 5px; font-size: 12px; line-height: 1.5; color: rgba(var(--v-theme-on-surface), .65); }.mode-options button.selected { color: rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), .12); font-weight: 600; }.mode-options button:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 2px; }
.preview-result { display: flex; align-items: flex-start; gap: 9px; padding: 12px; border-radius: 7px; background: rgba(var(--v-theme-success), .09); color: rgb(var(--v-theme-success)); }.preview-result.triggered { color: rgb(var(--v-theme-warning)); background: rgba(var(--v-theme-warning), .1); }.preview-result.paused { color: rgba(var(--v-theme-on-surface), .7); background: rgba(var(--v-theme-on-surface), .05); }.preview-result > .v-icon { margin-top: 1px; flex: 0 0 auto; }.preview-result strong { display: block; font-size: 14px; }.preview-result p { margin: 3px 0 0; font-size: 12px; line-height: 1.65; color: rgba(var(--v-theme-on-surface), .73); }.preview-facts { display: flex; flex-wrap: wrap; gap: 5px 18px; margin: 10px 0 8px; font-size: 12px; color: rgba(var(--v-theme-on-surface), .6); }.preview-facts strong { color: rgba(var(--v-theme-on-surface), .9); font-weight: 600; font-variant-numeric: tabular-nums; }
.request-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 6px; margin: 0; padding: 0; list-style: none; }.request-sample { min-width: 0; padding: 8px; border: 1px solid rgba(var(--v-theme-success), .24); border-radius: 6px; background: rgb(var(--v-theme-surface)); color: rgb(var(--v-theme-success)); }.request-sample.slow { border-color: rgba(var(--v-theme-warning), .28); color: rgb(var(--v-theme-warning)); }.request-sample.failed { border-color: rgba(var(--v-theme-error), .3); color: rgb(var(--v-theme-error)); }.request-sample.excluded { opacity: .46; color: rgba(var(--v-theme-on-surface), .7); border-color: rgba(var(--v-border-color), var(--v-border-opacity)); }.request-sample > div:first-child { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 5px; font-size: 11px; }.request-sample strong { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }.request-sample small { display: block; margin-top: 5px; font-size: 11px; line-height: 1.4; }.request-meter { height: 4px; margin-top: 7px; border-radius: 4px; overflow: hidden; background: rgba(var(--v-theme-on-surface), .08); }.request-meter > span { display: block; height: 100%; border-radius: 4px; background: currentColor; }.request-omitted { margin: 6px 0 0; font-size: 11px; color: rgba(var(--v-theme-on-surface), .5); }
.preview-details { margin-top: 9px; font-size: 12px; line-height: 1.65; color: rgba(var(--v-theme-on-surface), .65); }.preview-details summary { width: fit-content; cursor: pointer; }.preview-details summary:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 3px; }.preview-details p { margin: 7px 0 0; }.preview-paused { display: flex; align-items: center; gap: 8px; padding: 16px 10px; font-size: 13px; color: rgba(var(--v-theme-on-surface), .6); }
.recovery-flow { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; margin-top: 11px; font-size: 12px; line-height: 1.6; color: rgba(var(--v-theme-on-surface), .6); }.recovery-flow > .v-icon { color: rgba(var(--v-theme-on-surface), .4); }
@container (max-width: 720px) { .health-controls { grid-template-columns: 1fr; }.preview-toolbar { grid-template-columns: 1fr; }.request-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@container (min-width: 490px) and (max-width: 720px) { .health-controls { grid-template-columns: repeat(2, minmax(0, 1fr)); }.health-controls > :last-child { grid-column: 1 / -1; } }
@media (max-width: 650px) { .health-panel { padding: 14px; }.health-intro { align-items: flex-start; flex-wrap: wrap; gap: 3px 12px; margin-bottom: 10px; }.health-intro h2 { font-size: 17px; }.health-intro > .v-input { margin-left: auto; }.preview-heading { flex-wrap: wrap; gap: 3px; }.health-controls, .advanced-controls { grid-template-columns: 1fr; }.health-preview { padding: 11px; }.preview-toolbar { gap: 10px; margin: 10px 0; }.mode-options { width: 100%; }.mode-options button { flex: 1; padding: 7px 5px; }.health-advanced :deep(.v-expansion-panel-title) { padding-inline: 12px; }.health-advanced :deep(.v-expansion-panel-text__wrapper) { padding-inline: 10px; } }
</style>
