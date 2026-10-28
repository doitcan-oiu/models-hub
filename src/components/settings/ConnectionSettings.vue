<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';
import type { GatewaySettings } from '../../../shared/types';
import { api } from '../../api';
import { useConsole } from '../../composables/useConsole';
import { databaseLabels } from '../../setup';

withDefaults(defineProps<{ section?: 'gateway' | 'data' | 'runtime' }>(), { section: 'gateway' });
const emit = defineEmits<{ section: [value: 'gateway' | 'data' | 'runtime'] }>();
const { settings, session, refresh, notify, copy, requestLogout, registerEditor, loading } = useConsole();
const editorId = useId();
const connectionKeys = ['notifications', 'logRetentionDays'] as const;
type ConnectionDraft = Pick<GatewaySettings, typeof connectionKeys[number]>;
const pick = (value: GatewaySettings): ConnectionDraft => Object.fromEntries(connectionKeys.map(key => [key, value[key]])) as ConnectionDraft;
const signature = (value: GatewaySettings) => JSON.stringify(pick(value));
const baseline = ref(signature(settings.value));
const original = ref(pick(settings.value));
const draft = ref(pick(settings.value));
const retention = ref(String(settings.value.logRetentionDays));
const busy = ref(false);
const error = ref('');
const endpoint = `${window.location.origin}/v1`;
const storageLabel = computed(() => session.value?.databaseType ? `${databaseLabels[session.value.databaseType]} · 持久化存储` : '持久化数据库');
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(original.value) || retention.value !== String(original.value.logRetentionDays));
const serverChanged = computed(() => dirty.value && signature(settings.value) !== baseline.value);
watch([() => signature(settings.value), dirty, busy], () => { if (!dirty.value && !busy.value) reset(); });
const unregisterEditor = registerEditor(`settings-connection-${editorId}`, () => ({ dirty: dirty.value, busy: busy.value }));
const guard = (event: BeforeUnloadEvent) => { if (dirty.value || busy.value) { event.preventDefault(); event.returnValue = ''; } };
window.addEventListener('beforeunload', guard);
onBeforeUnmount(() => { unregisterEditor(); window.removeEventListener('beforeunload', guard); });
function load(value: GatewaySettings) { original.value = pick(value); draft.value = pick(value); retention.value = String(value.logRetentionDays); baseline.value = signature(value); error.value = ''; }
function reset() { if (!busy.value) load(settings.value); }
async function save() {
  if (busy.value || !dirty.value || serverChanged.value) return;
  error.value = '';
  try {
    const next = { ...draft.value, logRetentionDays: Number(retention.value) };
    if (!String(retention.value ?? '').trim() || !Number.isInteger(next.logRetentionDays) || next.logRetentionDays < 1 || next.logRetentionDays > 3650) { emit('section', 'data'); throw new Error('日志保留天数须为 1–3650 的整数。'); }
    const patch: Partial<GatewaySettings> = {};
    for (const key of connectionKeys) if (JSON.stringify(next[key]) !== JSON.stringify(original.value[key])) Object.assign(patch, { [key]: next[key] });
    busy.value = true;
    const result = await api<{ settings: GatewaySettings }>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) });
    load(result.settings); settings.value = result.settings;
    notify('网关接入与运行设置已保存', 'success'); await refresh(true);
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '保存失败'; notify(error.value, 'error'); }
  finally { busy.value = false; }
}
</script>

<template>
  <v-form class="connection-form" :disabled="busy" novalidate @submit.prevent="save">
    <div class="connection-save"><span class="text-body-2" :class="dirty ? 'text-warning' : 'text-medium-emphasis'" role="status">{{ dirty ? '接入与运行 · 有未保存的更改' : '接入与运行 · 配置已同步' }}</span><div class="d-flex ga-2"><v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" :disabled="busy" @click="refresh()">刷新</v-btn><v-btn variant="text" :disabled="busy || !dirty" @click="reset">{{ serverChanged ? '重新载入' : '放弃更改' }}</v-btn><v-btn color="primary" variant="flat" type="submit" :disabled="busy || !dirty || serverChanged" :loading="busy">保存设置</v-btn></div></div>
    <v-alert v-if="serverChanged" type="warning" variant="tonal">服务器接入配置已更新，草稿已保留。请重新载入后继续编辑。</v-alert>
    <fieldset class="connection-fields" :disabled="busy">
      <v-card v-show="section === 'gateway'" variant="flat" border class="connection-section">
        <v-card-title>网关接入</v-card-title><v-card-subtitle>Go 服务统一提供控制台与模型 API，可直连上游或使用 HTTP/HTTPS 中继。</v-card-subtitle>
        <v-card-text>
          <v-alert type="info" variant="tonal">在「渠道管理」中配置上游地址、模型与 API Key。每个渠道独立限制并发、复用连接和熔断；连接参数通过服务端环境变量设置。</v-alert>
          <div class="endpoint mt-4"><code>{{ endpoint }}</code><v-btn icon="mdi-content-copy" variant="text" size="small" aria-label="复制 API 基础地址" @click="copy(endpoint)" /></div>
        </v-card-text>
      </v-card>
      <v-card v-show="section === 'data'" variant="flat" border class="connection-section">
        <v-card-title>数据与通知</v-card-title><v-card-subtitle>设置观测数据保留期限和控制台事件提醒。</v-card-subtitle>
        <v-card-text><v-text-field v-model="retention" label="日志保留天数" type="number" min="1" max="3650" suffix="天" hint="自动清理过期请求、尝试记录和调度事件。" persistent-hint class="retention-field mb-4" /><div class="setting-switch"><div><strong>调度事件通知</strong><p>控制台打开时，显示新的渠道切换与健康事件。</p></div><v-switch v-model="draft.notifications" color="primary" hide-details aria-label="页面打开时通知新的调度事件" /></div></v-card-text>
      </v-card>
      <v-card v-show="section === 'runtime'" variant="flat" border class="connection-section">
        <v-card-title class="d-flex align-center">接入地址与运行<v-spacer /><v-chip size="small" variant="tonal">{{ session?.devMode ? '本地开发' : '生产环境' }}</v-chip></v-card-title><v-card-subtitle>应用访问入口和当前运行环境。</v-card-subtitle>
        <v-card-text><div class="text-subtitle-2 mb-3">统一网关地址</div><div class="endpoint"><code>{{ endpoint }}</code><v-btn icon="mdi-content-copy" variant="text" size="small" aria-label="复制 API 基础地址" @click="copy(endpoint)" /></div><p class="text-caption text-medium-emphasis mt-3 mb-4">使用网关 API Key 调用 OpenAI Compatible、Anthropic Messages 或 Gemini 原生接口。</p><v-divider class="mb-4" /><v-list density="compact" bg-color="transparent"><v-list-item title="数据存储" :subtitle="storageLabel" prepend-icon="mdi-database-outline" /><v-list-item title="凭证保护" subtitle="AES-GCM 加密存储与安全会话" prepend-icon="mdi-shield-lock-outline" /><v-list-item title="运行时" subtitle="Go · 每渠道独立并发与连接池" prepend-icon="mdi-sync" /></v-list><v-divider class="my-5" /><div class="runtime-session"><p class="text-body-2 text-medium-emphasis">管理员通过安全会话访问控制台。</p><v-btn variant="outlined" prepend-icon="mdi-logout" :disabled="busy" @click="requestLogout">退出管理会话</v-btn></div></v-card-text>
      </v-card>
    </fieldset>
    <v-alert v-if="error" type="error" variant="tonal" role="alert">{{ error }}</v-alert>
  </v-form>
</template>

<style scoped>
.connection-form, .connection-fields { display: grid; gap: 16px; min-width: 0; }
.connection-fields { border: 0; padding: 0; margin: 0; }
.connection-fields :deep(.v-row) { margin: 0; --v-col-gap-y: 16px; row-gap: 16px; }
.connection-section :deep(.v-card-title) { padding: 18px 20px 6px; font-size: 16px; font-weight: 600; }
.connection-section :deep(.v-card-subtitle) { padding-inline: 20px; white-space: normal; line-height: 1.7; }
.connection-section :deep(.v-card-text) { padding: 20px; }
.setting-switch { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 4px; background: rgba(var(--v-theme-on-surface), .025); }
.setting-switch strong { font-size: 13px; font-weight: 500; }
.setting-switch p { margin: 5px 0 0; font-size: 12px; color: rgba(var(--v-theme-on-surface), .65); }
.setting-switch > .v-input { flex: 0 0 auto; }
.retention-field { max-width: 380px; }
.connection-save { position: sticky; top: calc(var(--workspace-sticky-top, 110px) + 12px); z-index: 4; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 4px; background: rgb(var(--v-theme-surface)); }
.endpoint { display: flex; align-items: center; gap: 8px; padding: 10px 12px 10px 16px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 4px; background: rgba(var(--v-theme-on-surface), .035); }
.endpoint code { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 14px; }
.runtime-session { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; }
@media (max-width: 600px) { .connection-save { flex-wrap: wrap; padding: 14px; } .connection-save > .d-flex { margin-left: auto; } .connection-section :deep(.v-card-title), .connection-section :deep(.v-card-text) { padding: 20px; } .connection-section :deep(.v-card-subtitle) { padding-inline: 20px; } .setting-switch { padding: 14px; gap: 14px; } }
</style>
