<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { AttemptRecord, ChannelConfig, CredentialMeta, GatewayChannel, GatewayLog } from '../../../shared/types';
import { defaultChannelConfig } from '../../../shared/types';
import { api } from '../../api';
import { channelConfigPatchForPanel, type ChannelConfigPanel } from '../../channel-config-patch';
import { dateTime, errorText, resultColor, resultNames, seconds } from '../../format';
import { useConsole } from '../../composables/useConsole';
import { overridesToRows, serializeOverrides, validateConfig } from './channel-utils';
import { credentialUpdates } from './credential-utils';
import ChannelCredentialList from './ChannelCredentialList.vue';
import CredentialBalance from './CredentialBalance.vue';
import AppDialog from '../AppDialog.vue';
import OverrideRows from './OverrideRows.vue';
import ChannelTestResult from './ChannelTestResult.vue';
import ChannelHealth from './ChannelHealth.vue';
import ChannelCooldownSettings from './ChannelCooldownSettings.vue';
const props = defineProps<{ channel: GatewayChannel; panel: string }>();
const emit = defineEmits<{ close: [] }>();
const { notify, refresh, channels } = useConsole();
const titles: Record<string, string> = { test: '渠道测试', history: '测试历史', aliases: '模型别名', prices: '模型价格', overrides: '覆盖设置', relay: '代理配置', rateLimit: '速率限制', endpoints: '端点配置', credentials: '上游密钥管理', autoDisable: '健康与冷却', delete: '删除渠道' };
const configPanels = ['aliases', 'prices', 'overrides', 'relay', 'rateLimit', 'endpoints', 'autoDisable'];
const isConfig = computed(() => configPanels.includes(props.panel));
const baseline: ChannelConfig = JSON.parse(JSON.stringify({ ...props.channel.config, cooldown: { ...defaultChannelConfig.cooldown, ...props.channel.config.cooldown } }));
const config = ref<ChannelConfig>(JSON.parse(JSON.stringify(baseline)));
const headers = ref(overridesToRows(baseline.headers, true)); const body = ref(overridesToRows(baseline.bodyOverrides));
const configSnapshot = () => JSON.stringify({ config: config.value, headers: headers.value, body: body.value });
const initial = configSnapshot();
const busy = ref(false); const discard = ref(false); const deleteName = ref(''); const query = ref('');
const credentials = ref<CredentialMeta[]>([]); const label = ref(''); const secret = ref(''); const editingCredentialId = ref<string | null>(null); const secretVisible = ref(false); const deleteCredential = ref<CredentialMeta | null>(null); const credentialEditorOpen = ref(false);
const editingCredential = computed(() => credentials.value.find(item => item.id === editingCredentialId.value));
const dirty = computed(() => isConfig.value ? configSnapshot() !== initial : props.panel === 'credentials' && (!!secret.value || (!keyBalanceMonitoring.value && label.value !== (editingCredential.value?.label ?? ''))));
const canSaveCredential = computed(() => (keyBalanceMonitoring.value || (!!label.value.trim() && label.value.trim().length <= 128)) && secret.value.trim().length <= 16000 && (editingCredentialId.value ? !!editingCredential.value && (!!secret.value.trim() || (!keyBalanceMonitoring.value && label.value.trim() !== editingCredential.value.label)) : !!secret.value.trim()));
const path = `/api/channels/${encodeURIComponent(props.channel.id)}`;
const current = computed(() => channels.value.find(channel => channel.id === props.channel.id) ?? props.channel);
const keyBalanceMonitoring = computed(() => current.value.config.integration === 'bbdevlab');
const testModel = ref(props.channel.model || props.channel.models[0] || ''); const stream = ref(true);
type TestResult = { success?: boolean; status?: number; ttft?: number | null; duration?: number | null; error?: string | null; requestId?: string; attempts?: AttemptRecord[] };
const result = ref<TestResult | null>(null); const logs = ref<GatewayLog[]>([]); const logTotal = ref(0); const logDetail = ref<{ log: GatewayLog; attempts: AttemptRecord[] } | null>(null); const detailLoading = ref('');
const estimateInput = ref(1000); const estimateOutput = ref(1000); const customStatus = ref('');
const aliases = computed(() => config.value.aliases.map((item, index) => ({ item, index })).filter(({ item }) => !query.value || `${item.from} ${item.to}`.toLowerCase().includes((query.value ?? '').toLowerCase())));
const endpointFields: { key: keyof ChannelConfig['endpoints']; title: string }[] = [{ key: 'chat', title: 'OpenAI Chat Completions' }, { key: 'models', title: '模型列表' }, { key: 'messages', title: 'Anthropic Messages' }, { key: 'generate', title: 'Gemini Generate Content' }];
let alive = true;
function close(force = false) { if (busy.value) return; if (dirty.value && !force) { discard.value = true; return; } secret.value = ''; emit('close'); }
function unload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = ''; } }
window.addEventListener('beforeunload', unload); onBeforeUnmount(() => { alive = false; secret.value = ''; window.removeEventListener('beforeunload', unload); });
async function operation(task: () => Promise<unknown>, message?: string) {
  if (busy.value) return false;
  busy.value = true;
  try { await task(); if (message) notify(message, 'success'); await refresh(true); return true; }
  catch (error) { notify(errorText(error), 'error'); return false; }
  finally { busy.value = false; }
}
onMounted(async () => {
  if (!['credentials', 'history'].includes(props.panel)) return;
  busy.value = true;
  try {
    if (props.panel === 'credentials') { const data = await api<{ credentials: CredentialMeta[] }>(`${path}/credentials`); if (alive) credentials.value = data.credentials; }
    else { const data = await api<{ logs: GatewayLog[]; total: number }>(`${path}/tests`); if (alive) { logs.value = data.logs; logTotal.value = data.total; } }
  } catch (error) { notify(errorText(error), 'error'); }
  finally { busy.value = false; }
});
async function saveConfig() {
  if (busy.value) return;
  let next: ChannelConfig;
  try { if (props.panel === 'autoDisable') config.value.autoDisable.statuses = config.value.autoDisable.statuses.map(Number); next = validateConfig(config.value, props.panel); if (props.panel === 'overrides') { next.headers = serializeOverrides(headers.value, true) as Record<string, string>; next.bodyOverrides = serializeOverrides(body.value); } }
  catch (error) { notify(errorText(error), 'error'); return; }
  const patch = channelConfigPatchForPanel(next, baseline, props.panel as ChannelConfigPanel);
  if (!Object.keys(patch).length) { close(true); return; }
  if (await operation(() => api(path, { method: 'PATCH', body: JSON.stringify({ config: patch }) }), '渠道配置已保存')) close(true);
}
async function runTest(recover = false) {
  await operation(async () => {
    const data = await api<TestResult>(`${path}/${recover ? 'recover' : 'test'}`, { method: 'POST', ...(recover ? {} : { body: JSON.stringify({ model: testModel.value, stream: stream.value }) }) });
    result.value = data; notify(data.success === false ? '检测失败，请查看结果' : '检测完成，健康状态已更新', data.success === false ? 'error' : 'success');
  });
}
async function resetHealth() { await operation(() => api(`${path}/reset-health`, { method: 'POST' }), '冷却和健康异常已清除'); }
async function showLog(log: GatewayLog) { if (detailLoading.value) return; detailLoading.value = log.id; try { logDetail.value = await api(`${'/api/logs/'}${encodeURIComponent(log.id)}`); } catch (error) { notify(errorText(error), 'error'); } finally { detailLoading.value = ''; } }
function setCredentialDraft(key: CredentialMeta | null, open = true) { editingCredentialId.value = key?.id ?? null; label.value = key?.label ?? ''; secret.value = ''; secretVisible.value = false; credentialEditorOpen.value = open; }
const credentialTarget = ref<CredentialMeta | null>(null); const credentialDiscard = ref(false);
const credentialCloseRequested = ref(false);
function beginCredentialEdit(key: CredentialMeta | null) {
  if (busy.value || (credentialEditorOpen.value && (key?.id ?? null) === editingCredentialId.value)) return;
  if (dirty.value) { credentialTarget.value = key; credentialCloseRequested.value = false; credentialDiscard.value = true; return; }
  setCredentialDraft(key);
}
function closeCredentialEditor() {
  if (busy.value) return;
  if (dirty.value) { credentialCloseRequested.value = true; credentialDiscard.value = true; return; }
  setCredentialDraft(null, false);
}
function confirmCredentialSwitch() { setCredentialDraft(credentialCloseRequested.value ? null : credentialTarget.value, !credentialCloseRequested.value); credentialDiscard.value = false; credentialTarget.value = null; credentialCloseRequested.value = false; }
async function saveCredential() {
  if (busy.value) return;
  const id = editingCredentialId.value;
  let patch: { label?: string; secret?: string };
  try {
    if (id) {
      if (keyBalanceMonitoring.value) {
        if (!editingCredential.value) throw new Error('密钥列表已变化，请重新打开密钥管理');
        if (secret.value.trim().length > 16000) throw new Error('API Key 最多 16,000 个字符');
        if (!secret.value.trim()) { setCredentialDraft(null, false); return; }
        patch = { secret: secret.value.trim() };
      } else {
        const update = credentialUpdates([{ id, label: label.value, secret: secret.value }], credentials.value)[0];
        if (!update) { setCredentialDraft(null, false); return; }
        patch = { ...(update.label === undefined ? {} : { label: update.label }), ...(update.secret === undefined ? {} : { secret: update.secret }) };
      }
    } else if (keyBalanceMonitoring.value) {
      if (!secret.value.trim() || secret.value.trim().length > 16000) throw new Error('请填写 API Key，最多 16,000 个字符');
      patch = { secret: secret.value.trim() };
    } else {
      if (!label.value.trim() || !secret.value.trim() || label.value.trim().length > 128 || secret.value.trim().length > 16000) throw new Error('请填写密钥名称与 API Key，名称最多 128 字符，密钥最多 16,000 字符');
      patch = { label: label.value.trim(), secret: secret.value.trim() };
    }
  } catch (error) { notify(errorText(error), 'error'); return; }
  await operation(async () => { const data = await api<{ credential: CredentialMeta }>(id ? `${path}/credentials/${encodeURIComponent(id)}` : `${path}/credentials`, { method: id ? 'PATCH' : 'POST', body: JSON.stringify(patch) }); credentials.value = id ? credentials.value.map(item => item.id === id ? data.credential : item) : [...credentials.value, data.credential]; setCredentialDraft(null, false); }, id ? '密钥修改已保存' : '密钥已添加');
}
async function toggleCredential(key: CredentialMeta) { await operation(async () => { const data = await api<{ credential: CredentialMeta }>(`${path}/credentials/${encodeURIComponent(key.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !key.enabled }) }); credentials.value = credentials.value.map(item => item.id === key.id ? data.credential : item); }, '密钥状态已更新'); }
async function refreshCredentialBalances() {
  await operation(async () => {
    const data = await api<{ channel: GatewayChannel }>(`${path}/balance`, { method: 'POST' });
    channels.value = channels.value.map(channel => channel.id === data.channel.id ? data.channel : channel);
    const result = await api<{ credentials: CredentialMeta[] }>(`${path}/credentials`);
    if (alive) credentials.value = result.credentials;
    if (data.channel.accountBalance?.status === 'error') notify(data.channel.accountBalance.error ?? '部分密钥余额查询失败', 'error');
    else notify(credentials.value.length > 40 ? '已刷新一批密钥，其余由 Worker 定时分批刷新' : '密钥余额已刷新', 'success');
  });
}
async function removeCredential() { const key = deleteCredential.value; if (!key) return; await operation(async () => { await api(`${path}/credentials/${encodeURIComponent(key.id)}`, { method: 'DELETE' }); credentials.value = credentials.value.filter(item => item.id !== key.id); deleteCredential.value = null; if (editingCredentialId.value === key.id) setCredentialDraft(null, false); }, '密钥已删除'); }
async function removeChannel() { if (deleteName.value !== props.channel.name) return; if (await operation(() => api(path, { method: 'DELETE' }), '渠道已删除')) close(true); }
function addStatus() { const value = Number(customStatus.value); if (!Number.isInteger(value) || value < 400 || value > 599) { notify('HTTP 状态码须为 400–599', 'error'); return; } config.value.autoDisable.statuses = [...new Set([...config.value.autoDisable.statuses, value])]; customStatus.value = ''; }
</script>

<template>
  <AppDialog :model-value="true" :title="titles[panel] || '渠道设置'" :subtitle="`${channel.name} · ${channel.provider}`" :max-width="panel === 'delete' ? 520 : ['test', 'relay', 'rateLimit'].includes(panel) ? 660 : 920" :busy="busy" @update:model-value="close()">
    <v-progress-linear v-if="busy" indeterminate color="primary" class="mb-4" />
    <div :inert="busy ? true : undefined" class="operation-workspace">
    <template v-if="panel === 'aliases'">
      <div class="operation-toolbar"><v-text-field v-model="query" placeholder="搜索公开或上游模型名" aria-label="搜索模型映射" variant="solo-filled" flat density="compact" hide-details clearable /><v-btn variant="tonal" prepend-icon="mdi-plus" @click="config.aliases.push({ from: '', to: '' }); query = ''">添加映射</v-btn></div>
      <v-table v-if="config.aliases.length" class="editable-table mb-4"><thead><tr><th>公开模型名</th><th>上游模型名</th><th /></tr></thead><tbody><tr v-for="{ item, index } in aliases" :key="index"><td><v-text-field v-model="item.from" aria-label="公开模型名" density="compact" hide-details /></td><td><v-combobox v-model="item.to" :items="channel.models" aria-label="上游模型名" density="compact" hide-details /></td><td><v-btn icon="mdi-delete-outline" variant="text" size="small" color="error" aria-label="删除映射" @click="config.aliases.splice(index, 1)" /></td></tr></tbody></v-table>
      <p class="operation-note">公开模型名会映射到上游模型，响应仍保留公开名称。</p>
    </template>
    <template v-if="panel === 'prices'">
      <div class="d-flex justify-space-between align-center mb-4"><span class="text-body-2 text-medium-emphasis">USD / 百万 token</span><v-btn variant="tonal" prepend-icon="mdi-plus" @click="config.prices.push({ model: '', input: 0, output: 0 })">添加价格</v-btn></div>
      <v-table v-if="config.prices.length" class="editable-table price-table mb-4"><thead><tr><th>模型</th><th>输入价格</th><th>输出价格</th><th /></tr></thead><tbody><tr v-for="(price, index) in config.prices" :key="index"><td><v-combobox v-model="price.model" :items="channel.models" aria-label="模型" density="compact" hide-details /></td><td><v-text-field v-model.number="price.input" type="number" aria-label="输入价格" min="0" max="1000000" density="compact" hide-details /></td><td><v-text-field v-model.number="price.output" type="number" aria-label="输出价格" min="0" max="1000000" density="compact" hide-details /></td><td><v-btn icon="mdi-delete-outline" size="small" variant="text" color="error" aria-label="删除价格" @click="config.prices.splice(index, 1)" /></td></tr></tbody></v-table>
      <v-expansion-panels variant="accordion"><v-expansion-panel title="单次请求成本试算"><v-expansion-panel-text><div class="operation-field-grid mb-4"><v-text-field v-model.number="estimateInput" label="输入 token" type="number" min="0" /><v-text-field v-model.number="estimateOutput" label="输出 token" type="number" min="0" /></div><div v-for="(price, index) in config.prices" :key="index" class="d-flex justify-space-between py-2"><span>{{ price.model || '未命名模型' }}</span><strong>${{ ((Number(price.input) * estimateInput + Number(price.output) * estimateOutput) / 1000000).toFixed(6) }}</strong></div></v-expansion-panel-text></v-expansion-panel></v-expansion-panels>
    </template>
    <template v-if="panel === 'overrides'"><v-alert type="info" variant="tonal" class="mb-4">认证信息请使用密钥管理。model、stream、messages 等核心参数不可覆盖。</v-alert><OverrideRows v-model="headers" headers /><v-divider class="my-4" /><OverrideRows v-model="body" /></template>
    <template v-if="panel === 'relay'"><v-text-field v-model="config.relayUrl" label="HTTPS 中继 Base URL" hint="留空表示直连上游。中继需支持实际请求协议并接收渠道认证头。" persistent-hint /></template>
    <template v-if="panel === 'rateLimit'"><div class="operation-field-grid operation-field-grid--small-responsive mb-4"><v-text-field v-model.number="config.rateLimit.requestsPerMinute" label="每分钟请求数 RPM" type="number" min="0" max="1000000" /><v-text-field v-model.number="config.rateLimit.tokensPerMinute" label="每分钟 token TPM" type="number" min="0" max="1000000000" /></div><p class="text-caption text-medium-emphasis">0 表示不限制，超出限额时会尝试其他符合条件的渠道。</p></template>
    <template v-if="panel === 'endpoints'"><p class="operation-note mb-4">使用以 / 开头的相对路径，不包含查询参数或片段。Gemini 路径支持 {model} 占位符。</p><div class="endpoint-fields"><v-text-field v-for="field in endpointFields" :key="field.key" v-model="config.endpoints[field.key]" :label="field.title" append-inner-icon="mdi-restore" @click:append-inner="config.endpoints[field.key] = defaultChannelConfig.endpoints[field.key]" /></div></template>
    <template v-if="panel === 'autoDisable'">
      <ChannelCooldownSettings v-model="config.cooldown" />
      <v-divider class="my-4" /><h3 class="text-subtitle-1 mb-2">自动停用与恢复规则</h3>
      <p v-if="!config.cooldown.error" class="text-caption text-medium-emphasis mb-4">当前已关闭错误冷却，以下规则暂不生效；重新开启错误冷却后继续使用。</p>
      <v-switch v-model="config.autoDisable.enabled" color="primary" label="启用当前渠道独立规则" /><p class="text-caption text-medium-emphasis mb-4">关闭时遵循全局自动停用规则。</p>
      <div class="operation-field-stack">
        <v-select v-model="config.autoDisable.target" :items="[{ title: '停用出错密钥', value: 'key' }, { title: '停用整个渠道', value: 'channel' }]" label="停用范围" />
        <v-combobox v-model="config.autoDisable.statuses" :items="[400, 401, 403, 404, 408, 429, 500, 502, 503, 504]" multiple chips closable-chips label="触发 HTTP 状态码" />
        <div class="d-flex align-start ga-3"><v-text-field v-model="customStatus" label="补充状态码" type="number" /><v-btn variant="tonal" class="mt-1" @click="addStatus">添加</v-btn></div>
        <div class="operation-field-grid"><v-text-field v-model.number="config.autoDisable.threshold" label="连续错误次数" type="number" min="1" max="100" /><v-text-field v-model.number="config.autoDisable.cooldown" label="恢复冷却（秒）" type="number" min="1" max="86400" /></div>
        <v-switch v-model="config.autoDisable.recover" color="primary" label="冷却后自动探测恢复" />
      </div>
      <v-divider class="my-4" /><ChannelHealth :channel="current" :busy="busy" @reset="resetHealth" /><v-btn variant="tonal" class="mt-4" :loading="busy" @click="runTest(true)">执行恢复探测</v-btn><ChannelTestResult v-if="result" :result="result" />
    </template>
    <template v-if="panel === 'test'"><div class="operation-field-grid operation-field-grid--small-responsive mb-4"><v-select v-model="testModel" :items="channel.models" label="测试模型" :disabled="busy" /><v-select v-model="stream" :items="[{ title: 'SSE 流式', value: true }, { title: '非流式', value: false }]" label="响应模式" :disabled="busy" /></div><p class="text-caption text-medium-emphasis">仅使用当前渠道配置，测试结果会记录日志并更新健康状态。</p><ChannelTestResult v-if="result" :result="result" /></template>
    <template v-if="panel === 'history'"><p class="text-body-2 mb-4">共 {{ logTotal }} 条测试记录</p><v-table density="compact"><thead><tr><th>时间</th><th>模型</th><th>结果</th><th>首字</th><th>完成</th><th>HTTP</th><th /></tr></thead><tbody><tr v-for="log in logs" :key="log.id"><td class="text-caption">{{ dateTime(log.createdAt) }}</td><td>{{ log.model }}<div class="text-caption text-medium-emphasis">{{ log.stream ? '流式' : '非流式' }} · {{ log.attempts }} 次</div></td><td><v-chip :color="resultColor(log.result)" size="small">{{ resultNames[log.result] }}</v-chip></td><td>{{ log.stream ? seconds(log.ttft || null) : '—' }}</td><td>{{ seconds(log.duration) }}</td><td>{{ log.status }}</td><td><v-btn size="small" variant="text" :loading="detailLoading === log.id" :disabled="!!detailLoading" @click="showLog(log)">详情</v-btn></td></tr><tr v-if="!logs.length && !busy"><td colspan="7" class="text-center py-8 text-medium-emphasis">暂无测试历史</td></tr></tbody></v-table></template>
    <template v-if="panel === 'credentials'">
      <div class="credential-summary"><v-icon color="primary">mdi-key-chain-variant</v-icon><div><strong>上游 API Key 池</strong><p>自动轮换可用密钥，原文加密保存。</p></div><v-spacer /><v-btn v-if="keyBalanceMonitoring" size="small" variant="tonal" prepend-icon="mdi-refresh" :loading="busy" :disabled="!credentials.length || current.archived" @click="refreshCredentialBalances">刷新余额</v-btn><v-btn size="small" color="primary" prepend-icon="mdi-plus" :disabled="busy" @click="beginCredentialEdit(null)">添加密钥</v-btn></div>
      <v-alert v-if="keyBalanceMonitoring" type="info" variant="tonal" density="compact" class="mb-4">BBDevLab 按 Key 监控余额与到期时间。额度耗尽或到期时仅停用对应 Key；确认未到期且余额充足后自动恢复，手动停用保持停用。<p v-if="credentials.length > 40" class="mt-1">单次手动刷新最多查询 40 个 Key，其余由 Worker 定时分批刷新。</p></v-alert>
      <ChannelCredentialList :credentials="credentials" :monitoring="keyBalanceMonitoring" :hide-names="keyBalanceMonitoring" :busy="busy" managed class="mb-4" @edit="beginCredentialEdit" @toggle="toggleCredential" @delete="deleteCredential = $event" />
    </template>
    <template v-if="panel === 'delete'"><v-alert variant="tonal" type="warning" class="mb-4">渠道配置及 {{ channel.credentialCount }} 把上游密钥将永久删除，历史请求日志保留。</v-alert><p class="text-body-2 mb-3">请输入完整渠道名称 <strong>{{ channel.name }}</strong> 确认删除。</p><v-text-field v-model="deleteName" label="渠道名称" autocomplete="off" :error="!!deleteName && deleteName !== channel.name" /></template>
    </div>
    <template #actions><span v-if="dirty" class="text-caption text-medium-emphasis">有未保存的更改</span><v-spacer /><v-btn :disabled="busy" @click="close()">{{ isConfig || panel === 'delete' ? '取消' : '关闭' }}</v-btn><v-btn v-if="isConfig" color="primary" :loading="busy" @click="saveConfig">保存配置</v-btn><v-btn v-else-if="panel === 'test'" color="primary" :loading="busy" :disabled="!testModel" @click="runTest()">运行测试</v-btn><v-btn v-else-if="panel === 'delete'" color="error" :disabled="deleteName !== channel.name" :loading="busy" @click="removeChannel">永久删除</v-btn></template>
  </AppDialog>
  <AppDialog :model-value="credentialEditorOpen" :title="editingCredentialId ? '编辑上游密钥' : '添加上游密钥'" :max-width="560" :busy="busy" @update:model-value="closeCredentialEditor"><p v-if="editingCredential" class="text-caption text-medium-emphasis mb-4">当前密钥：<code>{{ editingCredential.preview }}</code>。<template v-if="!keyBalanceMonitoring">API Key 留空只修改名称。</template></p><v-text-field v-if="!keyBalanceMonitoring" v-model="label" label="密钥名称" maxlength="128" :disabled="busy" class="mb-4" /><v-text-field v-model="secret" :label="editingCredentialId ? '上游 API Key（留空不修改）' : '上游 API Key'" :type="secretVisible ? 'text' : 'password'" :append-inner-icon="secretVisible ? 'mdi-eye-off' : 'mdi-eye'" autocomplete="new-password" maxlength="16000" :disabled="busy" @click:append-inner="secretVisible = !secretVisible" /><template v-if="editingCredential && keyBalanceMonitoring"><p v-if="secret.trim()" class="text-caption text-medium-emphasis mt-4">保存后将使用新 Key 重新查询余额与到期时间。</p><CredentialBalance v-else :balance="editingCredential.balance" class="mt-4" /></template><template #actions><v-btn :disabled="busy" @click="closeCredentialEditor">取消</v-btn><v-spacer /><v-btn color="primary" :loading="busy" :disabled="!canSaveCredential" @click="saveCredential">{{ editingCredentialId ? '保存修改' : '添加密钥' }}</v-btn></template></AppDialog>
  <AppDialog v-model="discard" title="放弃未保存的更改？" :max-width="440"><p>本次修改将丢失。</p><template #actions><v-btn @click="discard = false">继续编辑</v-btn><v-btn color="error" @click="close(true)">放弃并关闭</v-btn></template></AppDialog>
  <AppDialog v-model="credentialDiscard" title="放弃当前密钥草稿？" :max-width="440"><p>当前未保存的{{ keyBalanceMonitoring ? 'API Key' : '名称与密钥' }}将被清除。</p><template #actions><v-btn @click="credentialDiscard = false">继续编辑</v-btn><v-btn color="error" @click="confirmCredentialSwitch">{{ credentialCloseRequested ? '放弃并关闭' : '放弃并切换' }}</v-btn></template></AppDialog>
  <AppDialog :model-value="!!deleteCredential" title="删除上游密钥" :max-width="440" :busy="busy" @update:model-value="deleteCredential = null"><p>永久删除「{{ keyBalanceMonitoring ? deleteCredential?.preview : deleteCredential?.label }}」？后续请求使用其他可用密钥。</p><code v-if="!keyBalanceMonitoring" class="d-block mt-3">{{ deleteCredential?.preview }}</code><template #actions><v-btn :disabled="busy" @click="deleteCredential = null">取消</v-btn><v-btn color="error" :loading="busy" @click="removeCredential">删除密钥</v-btn></template></AppDialog>
  <AppDialog :model-value="!!logDetail" title="测试请求详情" :max-width="850" @update:model-value="logDetail = null"><template v-if="logDetail"><p class="text-body-2">{{ logDetail.log.model }} · {{ dateTime(logDetail.log.createdAt) }}</p><ChannelTestResult :result="{ success: logDetail.log.result !== 'error', status: logDetail.log.status, duration: logDetail.log.duration, ttft: logDetail.log.stream ? logDetail.log.ttft : null, error: logDetail.log.error, requestId: logDetail.log.id, attempts: logDetail.attempts }" /></template></AppDialog>
</template>

<style scoped>
code { overflow-wrap: anywhere; }
.operation-workspace { min-width: 0; }
.operation-field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.operation-field-stack { display: grid; gap: 16px; }
.operation-toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
.operation-toolbar > .v-text-field { max-width: 440px; }
.operation-note { color: rgba(var(--v-theme-on-surface), .62); font-size: 13px; line-height: 1.7; }
.v-table { max-height: 480px; }
.v-table th, .v-table td { white-space: nowrap; }
.editable-table { border: 1px solid rgba(var(--v-theme-on-surface), .12); border-radius: 4px; }
.editable-table :deep(table) { min-width: 500px; }
.editable-table th { background: rgba(var(--v-theme-on-surface), .04); }
.editable-table td { padding: 8px 10px; }
.editable-table td:last-child { width: 50px; }
.price-table :deep(table) { min-width: 640px; }
.price-table td:first-child { width: 45%; }
.endpoint-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.credential-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 16px; }
.credential-summary p { margin-top: 4px; color: rgba(var(--v-theme-on-surface), .6); font-size: 13px; }
@media (max-width: 700px) { .operation-toolbar { flex-wrap: wrap; } .operation-toolbar > .v-text-field { flex-basis: 100%; max-width: none; } .endpoint-fields { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 599px) { .operation-field-grid--small-responsive { grid-template-columns: minmax(0, 1fr); } }
</style>
