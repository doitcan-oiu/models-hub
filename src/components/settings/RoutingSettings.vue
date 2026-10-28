<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';
import type { GatewayChannel, GatewaySettings } from '../../../shared/types';
import { defaultChannelConfig } from '../../../shared/types';
import { autoDisableDecision } from '../../../shared/health';
import { api } from '../../api';
import { useConsole } from '../../composables/useConsole';
import { routingSettingKeys, routingSettingsPatch } from '../../settings-patch';
import { clone } from '../access/policy';
import { disableNumberKeys, healthNumberKeys, numberKeys, numericFields, retryNumberKeys, type NumericKey } from './routing-fields';
import HealthSettingsPanel from './HealthSettingsPanel.vue';
import RoutingStrategyPanel from './RoutingStrategyPanel.vue';
import SettingRangeControl from './SettingRangeControl.vue';

type RoutingSection = 'routing' | 'retry' | 'health' | 'disable';
const props = withDefaults(defineProps<{ compact?: boolean; activeSection?: RoutingSection }>(), { compact: false });
const emit = defineEmits<{ dirty: [value: boolean]; busy: [value: boolean]; section: [value: RoutingSection] }>();
const { settings, refresh, notify, registerEditor, loading } = useConsole();
const prefix = useId();
const draft = ref(clone(settings.value));
const baseline = ref(clone(settings.value));
const numeric = ref(Object.fromEntries(numberKeys.map(key => [key, String(draft.value[key])])) as Record<NumericKey, string>);
const statuses = ref(draft.value.retryStatuses.join(', '));
const disableStatuses = ref(draft.value.autoDisableStatuses.join(', '));
const busy = ref(false);
const error = ref('');
const savedAt = ref('');
const localSection = ref<RoutingSection>('routing');
const section = computed(() => props.activeSection ?? localSection.value);
const sections = [{ id: 'routing', title: '路由分配' }, { id: 'retry', title: '重试与响应' }, { id: 'health', title: '健康检查' }, { id: 'disable', title: '自动禁用' }];
const signature = (value: GatewaySettings) => JSON.stringify(Object.fromEntries(routingSettingKeys.map(key => [key, value[key]])));
const dirty = computed(() => signature(draft.value) !== signature(baseline.value) || statuses.value !== baseline.value.retryStatuses.join(', ') || disableStatuses.value !== baseline.value.autoDisableStatuses.join(', ') || numberKeys.some(key => String(numeric.value[key] ?? '') !== String(baseline.value[key])));
const serverChanged = computed(() => dirty.value && signature(settings.value) !== signature(baseline.value));
watch(dirty, value => emit('dirty', value), { immediate: true });
watch(busy, value => emit('busy', value), { immediate: true });
watch([() => signature(settings.value), dirty, busy], () => { if (!dirty.value && !busy.value) reset(); });
const unregisterEditor = registerEditor(`settings-routing-${prefix}`, () => ({ dirty: dirty.value, busy: busy.value }));
const guard = (event: BeforeUnloadEvent) => { if (dirty.value || busy.value) { event.preventDefault(); event.returnValue = ''; } };
window.addEventListener('beforeunload', guard);
onBeforeUnmount(() => { unregisterEditor(); window.removeEventListener('beforeunload', guard); emit('dirty', false); emit('busy', false); });
function load(value: GatewaySettings) { draft.value = clone(value); baseline.value = clone(value); numeric.value = Object.fromEntries(numberKeys.map(key => [key, String(value[key])])) as Record<NumericKey, string>; statuses.value = value.retryStatuses.join(', '); disableStatuses.value = value.autoDisableStatuses.join(', '); error.value = ''; }
function reset() { if (!busy.value) load(settings.value); }
function selectSection(value: unknown) { const id = value as RoutingSection; if (!sections.some(item => item.id === id)) return; localSection.value = id; emit('section', id); }
const spec = (key: NumericKey) => numericFields[key] as { title: string; hint: string; min: number; max: number; unit?: string; step?: number; integer?: boolean };
const friendlyTitles: Partial<Record<NumericKey, string>> = {
  maxChannelRetries: '最多切换渠道数', maxSameChannelRetries: '同渠道重试次数', retryDelayMs: '重试间隔',
  streamFirstTokenTimeout: '首字等待上限', nonStreamTimeout: '完整响应等待上限',
  autoDisableThreshold: '连续错误次数', autoDisableCooldown: '停用冷却时间',
};
const friendlyHints: Partial<Record<NumericKey, string>> = {
  maxChannelRetries: '0：只用首选渠道；受可用渠道数限制。', maxSameChannelRetries: '轮换可用 Key；0：不重试。',
  retryDelayMs: '1000 毫秒 = 1 秒。', streamFirstTokenTimeout: '0：不限时；仅在开始输出前允许重试。',
  nonStreamTimeout: '0：不限时；超时后按重试规则处理。',
  autoDisableThreshold: '只累计指定状态码，其他状态会清零。', autoDisableCooldown: '需开启自动恢复；到时探测，通过后才启用。',
};
const sliderMaximum = (key: NumericKey) => key === 'streamFirstTokenTimeout' || key === 'nonStreamTimeout' ? 60 : key === 'autoDisableThreshold' ? 10 : key === 'autoDisableCooldown' ? 600 : spec(key).max;
const previewSettings = computed(() => {
  const value = clone(draft.value);
  for (const key of numberKeys) {
    const text = String(numeric.value[key] ?? ''), number = Number(text), field = spec(key);
    if (text.trim() && Number.isFinite(number) && number >= field.min && number <= field.max && (!field.integer || Number.isInteger(number))) value[key] = number;
  }
  try { value.retryStatuses = parseStatuses(statuses.value); } catch { /* Keep the saved value until the input is valid. */ }
  try { value.autoDisableStatuses = parseStatuses(disableStatuses.value); } catch { /* Save still validates the full draft. */ }
  return value;
});
const previewInputError = computed(() => {
  for (const key of numberKeys) {
    const text = String(numeric.value[key] ?? ''), number = Number(text), field = spec(key);
    if (!text.trim() || !Number.isFinite(number) || number < field.min || number > field.max || (field.integer && !Number.isInteger(number))) return `请先填写有效的${field.title}。`;
  }
  if (Number(numeric.value.samples) > Number(numeric.value.window)) return '最少样本数不能大于请求窗口，请调整进阶设置。';
  try { parseStatuses(statuses.value); parseStatuses(disableStatuses.value); } catch { return '请填写 400–599 的错误状态码，多个状态码用逗号分隔。'; }
  return '';
});
const retryBudget = computed(() => previewSettings.value.retryEnabled ? (1 + previewSettings.value.maxChannelRetries) * (1 + previewSettings.value.maxSameChannelRetries) : 1);
const disableExample = computed(() => {
  const value = previewSettings.value;
  const code = value.autoDisableStatuses[0] ?? 401;
  const channel = { config: clone(defaultChannelConfig) } as GatewayChannel;
  const decision = autoDisableDecision(channel, value, code, Math.max(0, value.autoDisableThreshold - 1));
  return { code, threshold: value.autoDisableThreshold, triggered: decision.disable, target: decision.target === 'key' ? '这个出错的 Key' : '整个渠道' };
});
function parseStatuses(text: string) { const values = text.split(/[,，\s]+/).filter(Boolean).map(Number); if (values.some(value => !Number.isInteger(value) || value < 400 || value > 599)) throw new Error('错误状态码须为 400–599，使用逗号分隔'); return [...new Set(values)]; }
async function save() {
  if (busy.value || !dirty.value || serverChanged.value) return;
  error.value = '';
  try {
    const value = clone(draft.value);
    for (const key of numberKeys) {
      const field = spec(key), text = String(numeric.value[key] ?? ''), number = Number(text);
      const invalid = (message: string): never => { selectSection(retryNumberKeys.includes(key) ? 'retry' : healthNumberKeys.includes(key) ? 'health' : 'disable'); throw new Error(message); };
      if (!text.trim()) invalid(`请填写${field.title}`);
      if (!Number.isFinite(number) || number < field.min || number > field.max) invalid(`${field.title}须在 ${field.min}–${field.max}${field.unit ?? ''} 之间`);
      if (field.integer && !Number.isInteger(number)) invalid(`${field.title}须为整数`);
      value[key] = number;
    }
    try { value.retryStatuses = parseStatuses(statuses.value); } catch (reason) { selectSection('retry'); throw reason; }
    try { value.autoDisableStatuses = parseStatuses(disableStatuses.value); } catch (reason) { selectSection('disable'); throw reason; }
    if (value.errorMode === 'custom' && !value.customErrorMessage.trim()) { selectSection('retry'); throw new Error('请填写自定义错误消息'); }
    if (value.samples > value.window) { selectSection('health'); throw new Error('最少样本数不能大于最近请求窗口'); }
    const patch = routingSettingsPatch(baseline.value, value);
    busy.value = true;
    const result = await api<{ settings: GatewaySettings }>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) });
    load(result.settings); settings.value = result.settings;
    savedAt.value = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
    notify('调度与健康策略已保存', 'success');
    await refresh(true);
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '保存失败'; notify(error.value, 'error'); }
  finally { busy.value = false; }
}
defineExpose({ dirty, busy, reset, save });
</script>

<template>
  <v-form class="routing-settings" :class="{ 'is-compact': compact }" :disabled="busy" novalidate @submit.prevent="save">
    <div class="routing-save-bar"><div><span class="text-body-2" :class="dirty ? 'text-warning' : 'text-medium-emphasis'" role="status">{{ dirty ? '未保存' : savedAt ? `已保存 ${savedAt}` : '已同步' }}</span></div><div class="d-flex ga-2"><v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="loading" :disabled="busy" @click="refresh()">刷新</v-btn><v-btn size="small" variant="text" :disabled="!dirty || busy" @click="reset">{{ serverChanged ? '重新载入' : '还原' }}</v-btn><v-btn size="small" color="primary" variant="flat" type="submit" :disabled="!dirty || serverChanged || busy" :loading="busy">保存</v-btn></div></div>
    <v-alert v-if="serverChanged" type="warning" variant="tonal" class="mb-5" role="alert">服务器策略已更新，草稿已保留。请重新载入后继续编辑。</v-alert><v-alert v-if="error" type="error" variant="tonal" class="mb-5" role="alert">{{ error }}</v-alert>
    <v-alert v-if="previewInputError" type="info" variant="tonal" density="compact" class="mb-5" role="status">演示已暂停：{{ previewInputError }}</v-alert>
    <div class="routing-layout">
      <v-tabs v-if="!activeSection" :model-value="section" color="primary" show-arrows class="mb-5" aria-label="调度配置分区" @update:model-value="selectSection"><v-tab v-for="item in sections" :key="item.id" :value="item.id" :aria-controls="`${prefix}-${item.id}`">{{ item.title }}</v-tab></v-tabs>
      <fieldset class="routing-fields" :disabled="busy">
        <section v-show="section === 'routing'" :id="`${prefix}-routing`" aria-label="路由分配"><RoutingStrategyPanel :settings="previewSettings" :preview-error="previewInputError" @update:strategy="draft.strategy = $event" @update:sticky-mode="draft.stickyMode = $event" /></section>
        <v-card v-show="section === 'retry'" :id="`${prefix}-retry`" variant="flat" border class="routing-section"><v-card-title class="text-subtitle-1 px-6 pt-5">重试与响应</v-card-title><v-card-subtitle>失败后的重试、超时与错误信息。</v-card-subtitle><v-card-text>
          <div class="setting-switch"><div><strong>自动重试</strong><p>仅在开始输出前重试，已输出内容不会跨渠道拼接。</p></div><v-switch v-model="draft.retryEnabled" color="primary" hide-details aria-label="自动重试" /></div>
          <v-row class="mt-2"><v-col v-for="key in retryNumberKeys" :key="key" cols="12" sm="6"><SettingRangeControl v-model="numeric[key]" :title="friendlyTitles[key] || spec(key).title" :min="spec(key).min" :max="spec(key).max" :slider-max="sliderMaximum(key)" :step="spec(key).step ?? (key === 'retryDelayMs' ? 100 : 1)" :unit="spec(key).unit" :hint="friendlyHints[key] || spec(key).hint" /></v-col><v-col cols="12" sm="6"><v-text-field v-model="statuses" label="哪些错误允许重试" hint="HTTP 状态码，逗号分隔；留空关闭状态码重试。" placeholder="408, 429, 500, 502, 503, 504" persistent-hint /></v-col></v-row>
          <div v-if="!previewInputError" class="settings-example-note"><v-icon size="18" color="primary">mdi-transit-connection-variant</v-icon><p>{{ draft.retryEnabled ? `理论上限 ${retryBudget} 次，实际受可用渠道、错误类型和是否已输出限制。` : '重试已关闭，失败后直接结束。' }} 到「路由分配」查看演示。</p></div>
          <v-alert v-if="Number(numeric.streamFirstTokenTimeout) > 0 && Number(numeric.streamFirstTokenTimeout) <= Number(numeric.threshold)" type="warning" variant="tonal" density="compact" class="my-4">首字超时不高于健康阈值，请求会先超时。需要统计连续慢响应时，请调高首字超时或设为 0。</v-alert>
          <div class="setting-switch"><div><strong>检测空响应</strong><p>文本、推理内容或工具调用视为有效输出。</p></div><v-switch v-model="draft.emptyResponseDetection" color="primary" hide-details aria-label="检测空响应" /></div>
          <v-row class="mt-2"><v-col cols="12" sm="6"><v-select v-model="draft.errorMode" label="错误消息" :items="[{title:'自定义消息',value:'custom'},{title:'通用消息',value:'generic'},{title:'上游原始错误',value:'raw'}]" hint="日志保留脱敏后的错误详情。" persistent-hint /></v-col><v-col v-if="draft.errorMode === 'custom'" cols="12" sm="6"><v-textarea v-model="draft.customErrorMessage" label="自定义错误消息" rows="2" auto-grow maxlength="1000" /></v-col></v-row>
        </v-card-text></v-card>
        <section v-show="section === 'health'" :id="`${prefix}-health`" aria-label="健康检查"><HealthSettingsPanel v-model:numeric="numeric" :settings="previewSettings" :preview-error="previewInputError" @update:auto-switch="draft.autoSwitch = $event" @update:auto-recover="draft.autoRecover = $event" /></section>
        <v-card v-show="section === 'disable'" :id="`${prefix}-disable`" variant="flat" border class="routing-section"><v-card-title class="text-subtitle-1 px-6 pt-5">自动禁用</v-card-title><v-card-subtitle>连续错误达到阈值时暂停上游。</v-card-subtitle><v-card-text><div class="setting-switch"><div><strong>启用自动禁用</strong><p>仅作用于上游渠道或凭证。</p></div><v-switch v-model="draft.autoDisableEnabled" color="primary" hide-details aria-label="启用自动禁用" /></div><v-row class="mt-2"><v-col cols="12" sm="6"><v-select v-model="draft.autoDisableTarget" label="禁用对象" :items="[{title:'上游密钥',value:'key'},{title:'整个渠道',value:'channel'}]" hide-details /></v-col><v-col cols="12" sm="6"><v-text-field v-model="disableStatuses" label="触发状态码" hint="400–599，使用逗号分隔。" persistent-hint /></v-col><v-col v-for="key in disableNumberKeys" :key="key" cols="12" sm="6"><SettingRangeControl v-model="numeric[key]" :title="friendlyTitles[key] || spec(key).title" :min="spec(key).min" :max="spec(key).max" :slider-max="sliderMaximum(key)" :step="spec(key).step ?? 1" :unit="spec(key).unit" :hint="friendlyHints[key] || spec(key).hint" /></v-col></v-row><div class="setting-switch"><div><strong>自动恢复已禁用项</strong><p>关闭后需手动启用，渠道可单独覆盖。</p></div><v-switch v-model="draft.autoDisableRecover" color="primary" hide-details aria-label="自动恢复已禁用项" /></div><div v-if="!previewInputError" class="disable-example"><div><span class="example-caption">当前规则示例</span><strong>连续 {{ disableExample.threshold }} 次 HTTP {{ disableExample.code }}</strong><v-chip :color="disableExample.triggered ? 'warning' : 'success'" size="small" variant="tonal">{{ disableExample.triggered ? '会停用' : '不会停用' }}</v-chip><p>{{ disableExample.triggered ? '达到次数后暂停' + disableExample.target + '，其他可用渠道继续处理请求。' : !draft.autoDisableEnabled ? '自动禁用开关未开启。' : '未选择触发状态码，不会累计停用。' }}</p></div><div><span class="example-caption">对照示例</span><strong>中间返回 HTTP 200</strong><v-chip color="success" size="small" variant="tonal">重新计数</v-chip><p>200 或其他非触发状态会清零，下次从 1 开始。</p></div></div></v-card-text></v-card>
      </fieldset>
    </div>
  </v-form>
</template>

<style scoped>
.routing-save-bar { position: sticky; top: calc(var(--workspace-sticky-top, 110px) + 8px); z-index: 4; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 12px; margin-bottom: 12px; background: rgb(var(--v-theme-surface)); border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 4px; }
.routing-layout { min-width: 0; }
.routing-fields { display: grid; gap: 12px; border: 0; padding: 0; margin: 0; min-width: 0; }
.routing-fields :deep(.v-row) { margin: 0; --v-col-gap-y: 10px; row-gap: 10px; }
.routing-fields :deep(.v-row + .setting-switch) { margin-top: 12px; }
.routing-section :deep(.v-card-title) { padding: 14px 16px 4px !important; font-size: 16px !important; font-weight: 600; }
.routing-section :deep(.v-card-subtitle) { padding-inline: 16px; white-space: normal; line-height: 1.6; }
.routing-section :deep(.v-card-text) { padding: 14px 16px; }
.setting-switch { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; margin-bottom: 6px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 4px; background: rgba(var(--v-theme-on-surface), .025); }
.setting-switch strong { font-size: 13px; font-weight: 500; }
.setting-switch p { margin: 3px 0 0; font-size: 12px; color: rgba(var(--v-theme-on-surface), .65); }
.setting-switch > .v-input { flex: 0 0 auto; }
.settings-example-note { display: flex; gap: 8px; padding: 10px 12px; margin-block: 12px; background: rgba(var(--v-theme-primary), .055); border: 1px solid rgba(var(--v-theme-primary), .16); border-radius: 6px; font-size: 12px; line-height: 1.6; }
.settings-example-note > .v-icon { flex: 0 0 auto; margin-top: 2px; }
.disable-example { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
.disable-example > div { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 6px; padding: 12px; border: 1px solid rgba(var(--v-theme-on-surface), .12); border-radius: 6px; }
.example-caption { flex-basis: 100%; color: rgba(var(--v-theme-on-surface), .55); font-size: 11px; }
.disable-example strong { font-size: 13px; }
.disable-example p { flex-basis: 100%; color: rgba(var(--v-theme-on-surface), .65); font-size: 12px; line-height: 1.7; }
@media (max-width: 650px) { .disable-example { grid-template-columns: minmax(0, 1fr); } }
.is-compact .routing-layout { display: block; }
.is-compact .routing-save-bar { position: static; padding: 0 0 12px; border: 0; border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 0; }
@media (max-width: 550px) { .routing-save-bar { flex-wrap: wrap; padding: 8px 10px; } .routing-save-bar > .d-flex { margin-left: auto; } .routing-section :deep(.v-card-title), .routing-section :deep(.v-card-text) { padding: 12px !important; } .routing-section :deep(.v-card-subtitle) { padding-inline: 12px; } .setting-switch { padding: 8px 10px; gap: 10px; } }
</style>
