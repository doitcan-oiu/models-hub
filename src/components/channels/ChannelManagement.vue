<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { api } from '../../api';
import { useConsole } from '../../composables/useConsole';
import { errorText } from '../../format';
import AppDialog from '../AppDialog.vue';
import RoutingSettings from '../settings/RoutingSettings.vue';
const props = defineProps<{ mode: string; selected: string[] }>();
const emit = defineEmits<{ close: []; applied: []; tagsChanged: [change: { from?: string; to?: string; tags: string[] }] }>();
const { tags, channels, notify, refresh } = useConsole();
const titles: Record<string, string> = { import: '批量导入渠道', tags: '标签管理', weights: '批量调整权重', assign: '批量调整标签', strategy: '负载均衡策略' };
const busy = ref(false); const discard = ref(false); const text = ref(''); const reading = ref(false); let readVersion = 0;
const tagName = ref(''); const renameFrom = ref<string | null>(null); const pendingDelete = ref<string | null>(null); const weight = ref(1); const assignMode = ref('add'); const assignTags = ref<string[]>([]); const strategyDirty = ref(false); const strategyBusy = ref(false);
const dirty = computed(() => props.mode === 'strategy' ? strategyDirty.value : props.mode === 'import' ? !!text.value.trim() || reading.value : props.mode === 'tags' ? !!tagName.value.trim() && tagName.value.trim() !== renameFrom.value : props.mode === 'weights' ? Number(weight.value) !== 1 : props.mode === 'assign' ? assignTags.value.length > 0 || assignMode.value !== 'add' : false);
function close(force = false) { if (busy.value || strategyBusy.value) return; if (dirty.value && !force) { discard.value = true; return; } ++readVersion; text.value = ''; emit('close'); }
function unload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = ''; } }
window.addEventListener('beforeunload', unload); onBeforeUnmount(() => { ++readVersion; text.value = ''; window.removeEventListener('beforeunload', unload); });
async function operation(task: () => Promise<void>, message: string, closeAfter = false) {
  if (busy.value) return; busy.value = true;
  try { await task(); notify(message, 'success'); await refresh(true); if (closeAfter) { text.value = ''; emit('applied'); emit('close'); } }
  catch (error) { notify(errorText(error), 'error'); }
  finally { busy.value = false; }
}
async function readFile(input: File | File[] | null) { const file = Array.isArray(input) ? input[0] : input; if (!file) return; if (file.size > 1048576) { notify('文件不能超过 1 MB', 'error'); return; } const current = ++readVersion; reading.value = true; try { const value = await file.text(); if (current === readVersion) text.value = value; } catch { notify('文件读取失败', 'error'); } finally { if (current === readVersion) reading.value = false; } }
async function submit() {
  if (busy.value || reading.value) return;
  if (props.mode === 'import') {
    let imported: unknown;
    try { const data = JSON.parse(text.value); imported = Array.isArray(data) ? data : data?.channels; if (!Array.isArray(imported) || !imported.length || imported.length > 200) throw new Error('每次导入 1–200 个渠道'); if (new TextEncoder().encode(JSON.stringify({ channels: imported })).byteLength > 1048576) throw new Error('导入数据不能超过 1 MB'); }
    catch (error) { notify(errorText(error), 'error'); return; }
    await operation(async () => { await api('/api/channels/import', { method: 'POST', body: JSON.stringify({ channels: imported }) }); }, '渠道已导入', true);
  } else if (props.mode === 'weights' || props.mode === 'assign') {
    if (!props.selected.length || props.selected.length > 200) { notify('请选择 1–200 个渠道', 'error'); return; }
    if (props.mode === 'weights' && (!Number.isFinite(Number(weight.value)) || weight.value < 0 || weight.value > 10000)) { notify('权重须为 0–10,000', 'error'); return; }
    await operation(async () => { await api('/api/channels/bulk', { method: 'POST', body: JSON.stringify({ ids: props.selected, action: props.mode === 'weights' ? 'weights' : 'tags', ...(props.mode === 'weights' ? { weight: Number(weight.value) } : { mode: assignMode.value, tags: assignTags.value }) }) }); }, `已更新 ${props.selected.length} 个渠道`, true);
  }
}
async function saveTag() {
  const name = tagName.value.trim(); if (!name || name.length > 256) { notify('标签名称须为 1–256 个字符', 'error'); return; }
  await operation(async () => { const from = renameFrom.value; const data = await api<{ tags: string[] }>(from ? `/api/tags/${encodeURIComponent(from)}` : '/api/tags', { method: from ? 'PATCH' : 'POST', body: JSON.stringify({ name }) }); tags.value = data.tags; emit('tagsChanged', { ...(from ? { from, to: name } : {}), tags: data.tags }); tagName.value = ''; renameFrom.value = null; }, '标签已保存，API Key 引用已同步');
}
async function deleteTag() { const value = pendingDelete.value; if (!value) return; await operation(async () => { const data = await api<{ tags: string[] }>(`/api/tags/${encodeURIComponent(value)}`, { method: 'DELETE' }); tags.value = data.tags; emit('tagsChanged', { tags: data.tags }); pendingDelete.value = null; }, '标签已删除'); }
</script>
<template>
  <AppDialog :model-value="true" :title="titles[mode] || '渠道管理'" :max-width="mode === 'strategy' ? 1050 : mode === 'weights' ? 480 : mode === 'import' ? 900 : 700" :busy="busy || strategyBusy" @update:model-value="close()">
    <div :inert="busy ? true : undefined">
    <template v-if="mode === 'import'"><div class="import-intro"><v-icon size="18" color="primary">mdi-upload-network-outline</v-icon><div><strong>导入上游连接配置</strong><p>JSON 文件最大 1 MB，每次最多 200 个渠道。</p></div></div><v-file-input accept=".json,application/json" label="选择 JSON 文件" :disabled="busy || reading" prepend-icon="" prepend-inner-icon="mdi-file-code-outline" class="mb-4" @update:model-value="readFile" /><v-divider class="mb-4" /><v-progress-linear v-if="reading" indeterminate class="mb-3" /><v-textarea v-model="text" label="或粘贴渠道 JSON" rows="8" :disabled="busy || reading" spellcheck="false" class="import-source" hint="支持数组或包含 channels 数组的对象，可携带 config、tags、models 和 apiKeys。" persistent-hint /></template>
    <template v-if="mode === 'weights'"><div class="bulk-context"><strong>{{ selected.length }}</strong><span>个渠道将应用相同权重</span></div><v-text-field v-model.number="weight" type="number" label="权重" min="0" max="10000" hint="0 按最低权重处理。" persistent-hint /></template>
    <template v-if="mode === 'assign'"><p class="text-body-2 mb-4">调整 {{ selected.length }} 个渠道的标签，会影响 API Key 的匹配范围。</p><v-select v-model="assignMode" :items="[{ title: '追加标签', value: 'add' }, { title: '替换全部标签', value: 'replace' }, { title: '移除标签', value: 'remove' }]" label="操作方式" class="mb-4" /><v-alert v-if="assignMode === 'replace'" variant="tonal" type="warning" class="mb-4">将覆盖全部原标签，留空会清空标签。</v-alert><v-combobox v-model="assignTags" :items="tags" multiple chips closable-chips label="标签" /></template>
    <template v-if="mode === 'tags'"><div class="d-flex align-start ga-3"><v-text-field v-model="tagName" :label="renameFrom ? `重命名 ${renameFrom}` : '新标签名称'" maxlength="256" @keydown.enter.prevent="saveTag" /><v-btn color="primary" :loading="busy" @click="saveTag">{{ renameFrom ? '保存' : '添加' }}</v-btn><v-btn v-if="renameFrom" variant="text" @click="renameFrom = null; tagName = ''">取消</v-btn></div><v-list lines="two" density="compact"><v-list-item v-for="tag in tags" :key="tag" :title="tag" :subtitle="`${channels.filter(channel => channel.tags.includes(tag)).length} 个渠道`"><template #append><v-btn icon="mdi-pencil-outline" size="small" variant="text" aria-label="重命名标签" :disabled="busy" @click="renameFrom = tag; tagName = tag" /><v-btn icon="mdi-delete-outline" size="small" color="error" variant="text" aria-label="删除标签" :disabled="busy" @click="pendingDelete = tag" /></template></v-list-item></v-list><p v-if="!tags.length" class="text-medium-emphasis text-center py-5">还没有标签</p></template>
    <RoutingSettings v-if="mode === 'strategy'" compact @dirty="strategyDirty = $event" @busy="strategyBusy = $event" />
    </div>
    <template #actions><v-spacer /><v-btn :disabled="busy || strategyBusy" @click="close()">{{ ['tags', 'strategy'].includes(mode) ? '关闭' : '取消' }}</v-btn><v-btn v-if="!['tags', 'strategy'].includes(mode)" color="primary" :loading="busy" :disabled="reading" @click="submit">{{ mode === 'import' ? '导入渠道' : '应用更改' }}</v-btn></template>
  </AppDialog>
  <AppDialog v-model="discard" title="放弃未保存的内容？" :max-width="440"><p>当前修改将丢失。</p><template #actions><v-btn @click="discard = false">继续编辑</v-btn><v-btn color="error" @click="close(true)">放弃并关闭</v-btn></template></AppDialog>
  <AppDialog :model-value="!!pendingDelete" title="删除标签" :max-width="440" :busy="busy" @update:model-value="pendingDelete = null"><p>删除「{{ pendingDelete }}」？渠道及 API Key 中对此标签的引用会同步移除。</p><template #actions><v-btn :disabled="busy" @click="pendingDelete = null">取消</v-btn><v-btn color="error" :loading="busy" @click="deleteTag">删除标签</v-btn></template></AppDialog>
</template>
<style scoped>
.import-intro { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 16px; }
.import-intro strong { font-size: 14px; font-weight: 500; }
.import-intro p { margin-top: 6px; color: rgba(var(--v-theme-on-surface), .6); font-size: 13px; line-height: 1.6; }
.import-source :deep(textarea) { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; line-height: 1.7; }
.bulk-context { display: flex; align-items: baseline; gap: 8px; margin-bottom: 16px; }
.bulk-context strong { font-size: 20px; font-weight: 500; font-variant-numeric: tabular-nums; }
.bulk-context span { color: rgba(var(--v-theme-on-surface), .6); font-size: 14px; }
</style>
