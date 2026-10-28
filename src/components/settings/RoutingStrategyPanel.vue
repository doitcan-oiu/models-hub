<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { GatewaySettings, RoutingStrategy } from '../../../shared/types';
import { channelsForScenario, exampleAdaptiveScore, routingScenarios, routingStrategies, runRoutingExample, type RoutingExampleScenario } from './routing-examples';

const props = defineProps<{ settings: GatewaySettings; previewError?: string }>();
const emit = defineEmits<{ 'update:strategy': [value: RoutingStrategy]; 'update:stickyMode': [value: 'prefer' | 'off'] }>();
const scenario = ref<RoutingExampleScenario>('normal');
const requestCount = ref(1);
const selectedStrategy = computed(() => routingStrategies.find(item => item.value === props.settings.strategy)!);
const selectedScenario = computed(() => routingScenarios.find(item => item.value === scenario.value)!);
const channels = computed(() => channelsForScenario(scenario.value));
const requests = computed(() => props.previewError ? [] : runRoutingExample(props.settings, scenario.value, requestCount.value));
watch(() => JSON.stringify([props.settings.strategy, props.settings.stickyMode, props.settings.autoSwitch, props.settings.retryEnabled, props.settings.maxChannelRetries, props.settings.maxSameChannelRetries, props.settings.retryStatuses, props.settings.retryDelayMs, scenario.value]), () => { requestCount.value = 1; });
const decimal = (value: number) => Number(value.toFixed(3));
</script>

<template>
  <v-card variant="flat" border class="routing-strategy-panel">
    <h2>路由分配</h2>
    <div class="strategy-options" role="group" aria-label="路由分配方式">
      <button v-for="item in routingStrategies" :key="item.value" type="button" class="strategy-option" :class="{ 'is-selected': settings.strategy === item.value }" :aria-pressed="settings.strategy === item.value" :title="item.description" @click="emit('update:strategy', item.value)">
        <v-icon :icon="item.icon" size="19" /><strong>{{ item.title }}</strong><v-icon v-if="settings.strategy === item.value" icon="mdi-check-circle" size="17" class="strategy-check" />
      </button>
    </div>
    <div class="strategy-rule"><v-icon icon="mdi-information-outline" size="17" /><p>{{ selectedStrategy.rule }}</p></div>
    <div class="session-setting"><div><strong>同一会话优先沿用原渠道</strong><details class="session-help"><summary>生效条件</summary><p>使用相同 <code>x-trace-id</code> 或 <code>x-thread-id</code>。上次成功的健康渠道优先于分配顺序，异常渠道不优先。</p></details></div><v-switch :model-value="settings.stickyMode === 'prefer'" color="primary" hide-details density="compact" aria-label="同一会话沿用上次成功的渠道" @update:model-value="emit('update:stickyMode', $event ? 'prefer' : 'off')" /></div>
    <div class="routing-demo">
      <div class="demo-heading"><h3>请求演示</h3><span class="demo-local"><v-icon icon="mdi-flask-outline" size="16" />本地演示 · 不消耗额度</span></div>
      <div class="example-channels"><div v-for="channel in channels" :key="channel.id" class="example-channel" :class="{ 'is-cooling': channel.cooling }"><div><strong>渠道 {{ channel.id }}</strong><span v-if="channel.cooling" class="text-warning">降级 · 冷却中</span><span v-else class="text-success">健康</span></div><p>优先级 <b>{{ channel.priority }}</b><span>权重 <b>{{ channel.weight }}</b></span></p><p>首字 <b>{{ channel.ttft }} s</b><span>成功率 <b>{{ channel.successRate }}%</b></span></p><p v-if="settings.strategy === 'adaptive'" class="adaptive-score">综合分 {{ decimal(exampleAdaptiveScore(channel)) }}，越低越优先</p></div></div>
      <div class="demo-controls"><v-select v-model="scenario" :items="routingScenarios" item-title="title" item-value="value" label="演示场景" density="compact" hide-details /><div class="demo-buttons"><v-btn variant="text" size="small" prepend-icon="mdi-replay" @click="requestCount = 1">重播</v-btn><v-btn color="primary" variant="tonal" size="small" append-icon="mdi-arrow-right" :disabled="requestCount >= 6" @click="requestCount++">下一次请求</v-btn></div></div>
      <p class="scenario-description">{{ selectedScenario.description }}</p>
      <v-alert v-if="previewError" type="info" variant="tonal" density="compact">演示已暂停：{{ previewError }}</v-alert>
      <div v-else class="demo-requests" aria-live="polite" aria-atomic="false"><article v-for="request in requests" :key="request.number" class="example-request"><div class="request-title"><strong>请求 {{ request.number }}</strong><span :class="request.success ? 'text-success' : 'text-warning'">{{ request.success ? '成功' : '未完成' }}</span></div><div class="request-path"><span class="request-origin">请求</span><template v-for="(attempt, index) in request.attempts" :key="index"><v-icon icon="mdi-arrow-right" size="17" class="path-arrow" /><span class="attempt-node" :class="`attempt-${attempt.result}`"><b>{{ attempt.channel }}</b><span>{{ attempt.result === 'success' ? '成功' : attempt.result === 'interrupted' ? '输出后断开' : attempt.status }}</span></span></template><span v-if="!request.attempts.length" class="text-warning">没有可用渠道</span></div><p class="request-summary">{{ request.summary }}</p><details class="request-details"><summary>分配原因</summary><p>候选顺序：{{ request.order.join(' → ') || '无' }}<template v-if="settings.strategy === 'weighted'">（固定随机样本，真实请求会重新抽取）</template></p><p v-for="skipped in request.skipped" :key="skipped.channel" class="skipped-channel"><v-icon icon="mdi-skip-next-outline" size="16" />跳过 {{ skipped.channel }}：{{ skipped.reason }}</p><p v-for="(attempt, index) in request.attempts" :key="index">第 {{ index + 1 }} 次尝试 · {{ attempt.channel }}：{{ attempt.reason }}</p></details></article></div>
      <details class="demo-context"><summary>演示设置与说明</summary><div class="current-conditions"><span :class="settings.retryEnabled ? '' : 'text-warning'">自动重试{{ settings.retryEnabled ? '开' : '关' }}</span><span>跨渠道重试 {{ settings.retryEnabled ? settings.maxChannelRetries : 0 }} 次</span><span>同渠道重试 {{ settings.retryEnabled ? settings.maxSameChannelRetries : 0 }} 次</span><span>异常自动切换{{ settings.autoSwitch ? '开' : '关' }}</span><span>会话连续性{{ settings.stickyMode === 'prefer' ? '开' : '关' }}</span></div><p>使用当前未保存的设置演示流式请求。失败后能否换渠道取决于「重试与响应」中的设置；已经输出内容后不会切换。</p><p>示例渠道均已授权、支持相同模型，健康状态保持不变。实际还受密钥可用性、限流和健康判定影响。</p></details>
    </div>
  </v-card>
</template>

<style scoped>
.routing-strategy-panel { min-width: 0; overflow: hidden; padding: 18px; }
.demo-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
h2, h3 { margin: 0; font-size: 17px; font-weight: 650; line-height: 1.5; }
h3 { font-size: 15px; }
.strategy-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(155px, 1fr)); gap: 8px; margin-top: 12px; }
.strategy-option { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 46px; padding: 10px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 8px; text-align: left; color: rgb(var(--v-theme-on-surface)); background: rgba(var(--v-theme-on-surface), .015); cursor: pointer; }
.strategy-option:hover { background: rgba(var(--v-theme-primary), .055); border-color: rgba(var(--v-theme-primary), .45); }
.strategy-option:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 3px; }
.strategy-option.is-selected { border-color: rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), .09); box-shadow: inset 0 0 0 1px rgba(var(--v-theme-primary), .25); }
.strategy-option > .v-icon { flex-shrink: 0; color: rgb(var(--v-theme-primary)); }
.strategy-option strong { font-size: 13px; font-weight: 650; }
.strategy-check { margin-left: auto; }
.strategy-rule { display: flex; gap: 6px; align-items: start; margin: 10px 0 12px; color: rgba(var(--v-theme-on-surface), .65); }
.strategy-rule .v-icon { flex-shrink: 0; margin-top: 1px; }
.strategy-rule p { margin: 0; font-size: 12px; line-height: 1.65; }
.session-setting { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 8px; }
.session-setting > div { flex: 1; min-width: 0; }
.session-setting strong { font-size: 13px; }
.session-help { color: rgba(var(--v-theme-on-surface), .65); font-size: 12px; margin-top: 3px; }
.session-help summary { width: fit-content; cursor: pointer; }
.session-setting p { margin: 5px 0 0; line-height: 1.65; overflow-wrap: anywhere; }
.session-setting > .v-input { flex: 0 0 auto; }
.routing-demo { border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); margin-top: 16px; padding-top: 14px; }
.demo-local { display: inline-flex; gap: 5px; align-items: center; color: rgba(var(--v-theme-on-surface), .6); font-size: 12px; }
.example-channels { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 12px 0; }
.example-channel { min-width: 0; background: rgba(var(--v-theme-on-surface), .025); border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 8px; padding: 9px 11px; }
.example-channel.is-cooling { border-color: rgba(var(--v-theme-warning), .35); background: rgba(var(--v-theme-warning), .04); }
.example-channel > div { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 5px; flex-wrap: wrap; }
.example-channel strong { font-size: 13px; }
.example-channel > div > span { font-size: 12px; }
.example-channel p { display: flex; flex-wrap: wrap; gap: 5px 16px; margin: 4px 0 0; font-size: 12px; color: rgba(var(--v-theme-on-surface), .65); }
.example-channel b { color: rgb(var(--v-theme-on-surface)); font-weight: 550; }
.example-channel .adaptive-score { color: rgb(var(--v-theme-primary)); margin-top: 5px; font-size: 12px; }
.demo-controls { display: flex; align-items: center; gap: 8px; }
.demo-controls > .v-input { min-width: 0; flex: 1; }
.demo-buttons { display: flex; gap: 3px; flex-shrink: 0; }
.scenario-description { color: rgba(var(--v-theme-on-surface), .7); font-size: 12px; line-height: 1.65; margin: 8px 0 10px; }
.current-conditions { display: flex; flex-wrap: wrap; gap: 5px; margin: 8px 0; }
.current-conditions span { background: rgba(var(--v-theme-on-surface), .045); border-radius: 4px; padding: 3px 6px; color: rgba(var(--v-theme-on-surface), .65); font-size: 12px; }
.demo-requests { display: grid; gap: 8px; }
.example-request { min-width: 0; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 8px; padding: 10px 12px; }
.request-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; }
.request-title strong { font-size: 13px; font-weight: 600; }
.request-title > span { font-size: 12px; }
.request-path { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.request-origin { font-size: 12px; color: rgba(var(--v-theme-on-surface), .6); }
.path-arrow { color: rgba(var(--v-theme-on-surface), .35); flex-shrink: 0; }
.attempt-node { display: inline-flex; gap: 6px; align-items: center; border: 1px solid; border-radius: 5px; padding: 3px 7px; font-size: 12px; }
.attempt-node b { font-size: 13px; }
.attempt-success { border-color: rgba(var(--v-theme-success), .35); background: rgba(var(--v-theme-success), .06); color: rgb(var(--v-theme-success)); }
.attempt-error, .attempt-interrupted { border-color: rgba(var(--v-theme-warning), .35); background: rgba(var(--v-theme-warning), .06); color: rgb(var(--v-theme-warning)); }
.request-summary { margin: 7px 0 0; font-size: 12px; line-height: 1.65; color: rgba(var(--v-theme-on-surface), .75); }
.request-details { font-size: 12px; color: rgba(var(--v-theme-on-surface), .6); margin-top: 4px; }
.request-details summary { width: fit-content; cursor: pointer; padding: 3px 0; }
.request-details p { margin: 5px 0 0; line-height: 1.8; }
.skipped-channel { color: rgb(var(--v-theme-warning)); }
.demo-context { font-size: 12px; line-height: 1.65; color: rgba(var(--v-theme-on-surface), .6); margin-top: 10px; }
.demo-context summary { width: fit-content; cursor: pointer; }
.demo-context p { margin: 7px 0 0; }
@media (max-width: 700px) { .routing-strategy-panel { padding: 16px; } .strategy-options { grid-template-columns: repeat(2, minmax(0, 1fr)); } .demo-controls { align-items: stretch; flex-direction: column; } .demo-buttons { justify-content: flex-end; } .example-channels { gap: 6px; } .example-channel { padding: 8px; } .example-channel p { gap: 3px 6px; } }
@media (max-width: 420px) { .routing-strategy-panel { padding: 14px; } .strategy-option { padding: 9px; gap: 6px; } .strategy-check { display: none; } .session-setting { padding: 9px 10px; gap: 8px; } .example-channels { grid-template-columns: minmax(0, 1fr); } .example-channel > div { margin-bottom: 3px; } .example-channel p { display: inline-flex; margin-right: 12px; } .request-path { gap: 5px; } .example-request { padding: 10px; } }
</style>
