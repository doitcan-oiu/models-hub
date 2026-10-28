<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId } from 'vue';
import { createId } from '../../../shared/id';
import type { GatewayApiKey, GatewayChannel } from '../../../shared/types';
import { api } from '../../api';
import { editableRequestLimit } from '../../access-policy';
import { useConsole } from '../../composables/useConsole';
import { blankProfile, channelModels, clone, permittedModels, scopedChannels } from './policy';
import ScopePreview from './ScopePreview.vue';

const props = defineProps<{ keyRecord: GatewayApiKey | null; channels: GatewayChannel[]; tags: string[] }>();
const emit = defineEmits<{ close: []; secret: [value: { name: string; value: string }] }>();
const { notify, refresh, registerEditor } = useConsole();
const formId = useId();
const first = blankProfile();
const draft = ref(props.keyRecord ? clone({ name: props.keyRecord.name, expires: ['永不过期', 'never'].includes(props.keyRecord.expires) ? '' : props.keyRecord.expires, note: props.keyRecord.note, profiles: props.keyRecord.profiles.map(item => ({ ...item, requestLimit: editableRequestLimit(item.requestLimit) })), activeProfile: props.keyRecord.activeProfile }) : { name: '', expires: '', note: '', profiles: [first], activeProfile: first.id });
const baseline = JSON.stringify(draft.value);
const editingProfile = ref(draft.value.activeProfile);
const profile = computed(() => draft.value.profiles.find(item => item.id === editingProfile.value) ?? draft.value.profiles[0]);
const dirty = computed(() => JSON.stringify(draft.value) !== baseline);
const busy = ref(false);
const error = ref('');
const editorSection = ref('identity');
const discard = ref(false);
const unregisterEditor = registerEditor(`key-editor-${formId}`, () => ({ dirty: dirty.value, busy: busy.value }));
const allTags = computed(() => [...new Set([...props.tags, ...props.channels.flatMap(channel => channel.tags), ...draft.value.profiles.flatMap(item => item.tags)])].sort());
const channelItems = computed(() => props.channels.filter(channel => !channel.archived).map(channel => ({ title: channel.name, value: channel.id })));
const profileModels = computed(() => [...new Set(scopedChannels(profile.value, props.channels).flatMap(channelModels))].sort());
const modelItems = computed(() => [...new Set([...profileModels.value, ...profile.value.models])]);
const mappingModels = computed(() => permittedModels(profile.value, props.channels));
const missingModels = computed(() => profile.value.models.filter(model => !profileModels.value.includes(model)));
const guard = (event: BeforeUnloadEvent) => { if (dirty.value || busy.value) { event.preventDefault(); event.returnValue = ''; } };
window.addEventListener('beforeunload', guard);
onBeforeUnmount(() => { unregisterEditor(); window.removeEventListener('beforeunload', guard); });
function close() { if (busy.value) return; if (dirty.value) discard.value = true; else emit('close'); }
function addProfile(duplicate = false) {
  const next = duplicate ? { ...clone(profile.value), id: createId(), name: `${profile.value.name} 副本` } : blankProfile(`策略 ${draft.value.profiles.length + 1}`);
  draft.value.profiles.push(next); editingProfile.value = next.id;
}
function removeProfile() {
  if (draft.value.profiles.length < 2) return;
  const removed = profile.value.id;
  draft.value.profiles = draft.value.profiles.filter(item => item.id !== removed);
  editingProfile.value = draft.value.profiles[0].id;
  if (draft.value.activeProfile === removed) draft.value.activeProfile = editingProfile.value;
}
function validate() {
  if (!draft.value.name.trim()) { editorSection.value = 'identity'; throw new Error('请填写 API Key 名称'); }
  if (draft.value.expires && draft.value.expires < new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })) { editorSection.value = 'identity'; throw new Error('到期日期不能早于今天；所选日期至北京时间 23:59:59 有效。'); }
  for (const item of draft.value.profiles) {
    const invalid = (message: string): never => { editingProfile.value = item.id; editorSection.value = 'permissions'; throw new Error(message); };
    if (!item.name.trim()) invalid('请为每个策略填写名称');
    if (item.scope === 'tags' && !item.tags.length) invalid(`「${item.name}」至少选择一个标签`);
    if (item.scope === 'channels' && !item.channelIds.length) invalid(`「${item.name}」至少选择一个渠道`);
    if (item.modelMode === 'selected' && !item.models.length) invalid(`「${item.name}」至少选择一个模型`);
    if (item.requestLimit && (!/^\d+$/.test(item.requestLimit) || !Number.isSafeInteger(Number(item.requestLimit)) || Number(item.requestLimit) <= 0)) invalid(`「${item.name}」的额度须为大于 0 的整数`);
    if (item.mappings.some(mapping => !mapping.from.trim() || !mapping.to.length)) invalid(`「${item.name}」的模型映射需要入口名称和目标模型`);
    if (new Set(item.mappings.map(mapping => mapping.from.trim())).size !== item.mappings.length) invalid(`「${item.name}」的映射入口名称不能重复`);
    const allowed = permittedModels(item, props.channels);
    if (item.mappings.some(mapping => mapping.to.some(model => !allowed.includes(model)))) invalid(`「${item.name}」的映射目标须属于可访问模型`);
  }
}
async function save() {
  if (busy.value) return;
  error.value = '';
  try {
    validate(); busy.value = true;
    const normalized = { ...clone(draft.value), name: draft.value.name.trim(), profiles: draft.value.profiles.map(item => ({ ...clone(item), name: item.name.trim(), mappings: item.mappings.map(mapping => ({ from: mapping.from.trim(), to: [...mapping.to] })) })) };
    let secret: { name: string; value: string } | null = null;
    if (props.keyRecord) await api(`/api/keys/${encodeURIComponent(props.keyRecord.id)}`, { method: 'PATCH', body: JSON.stringify(normalized) });
    else { const result = await api<{ key: GatewayApiKey; token: string }>('/api/keys', { method: 'POST', body: JSON.stringify(normalized) }); secret = { name: result.key.name, value: result.token }; }
    notify(props.keyRecord ? 'API Key 配置已保存' : 'API Key 已创建', 'success');
    try { await refresh(true); } catch { notify('变更已保存，但列表刷新失败，请刷新页面', 'warning'); }
    if (secret) emit('secret', secret);
    emit('close');
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '保存失败'; notify(error.value, 'error'); }
  finally { busy.value = false; }
}
</script>

<template>
  <v-dialog :model-value="true" :aria-label="keyRecord ? '编辑 API Key' : '创建 API Key'" persistent scrollable max-width="880" @keydown.esc="close">
    <v-card>
      <v-card-title class="d-flex align-center px-5 pt-4"><span>{{ keyRecord ? '编辑 API Key' : '创建 API Key' }}</span><v-spacer /><v-btn icon="mdi-close" variant="text" size="small" aria-label="关闭编辑" :disabled="busy" @click="close" /></v-card-title>
      <v-tabs v-model="editorSection" color="primary" class="px-4 mt-2" grow><v-tab value="identity">应用信息</v-tab><v-tab value="permissions">访问策略</v-tab><v-tab value="preview">授权预览</v-tab></v-tabs><v-divider />
      <v-card-text class="pt-4">
        <v-form :id="formId" :disabled="busy" @submit.prevent="save">
          <fieldset :disabled="busy" class="editor-fields">
            <section v-show="editorSection === 'identity'" class="editor-section">
            <v-row><v-col cols="12" sm="7"><v-text-field v-model="draft.name" label="名称" maxlength="80" autofocus required hide-details="auto" /></v-col><v-col cols="12" sm="5"><v-text-field v-model="draft.expires" label="到期日期（可选）" type="date" hint="留空永不过期；至北京时间当日 23:59:59 有效。" persistent-hint /></v-col><v-col cols="12"><v-text-field v-model="draft.note" label="备注（可选）" maxlength="300" hide-details /></v-col></v-row>
            </section><section v-show="editorSection === 'permissions'" class="editor-section">
            <div class="d-flex align-center flex-wrap ga-2 mb-4"><h3 class="text-subtitle-1">访问策略</h3><v-spacer /><v-btn variant="text" size="small" prepend-icon="mdi-plus" @click="addProfile()">添加策略</v-btn></div>
            <v-tabs v-if="draft.profiles.length > 1" v-model="editingProfile" color="primary" class="mb-4" show-arrows><v-tab v-for="item in draft.profiles" :key="item.id" :value="item.id">{{ item.name || '未命名策略' }}<v-icon v-if="item.id === draft.activeProfile" icon="mdi-check" size="16" class="ml-2" /></v-tab></v-tabs>
            <div class="profile-tools mb-5"><v-text-field v-model="profile.name" label="策略名称" maxlength="80" hide-details /><v-btn v-if="profile.id !== draft.activeProfile" variant="tonal" size="small" @click="draft.activeProfile = profile.id">设为当前生效</v-btn><v-chip v-else color="success" size="small" variant="tonal">当前生效</v-chip><v-btn icon="mdi-content-copy" title="复制策略" aria-label="复制策略" variant="text" size="small" @click="addProfile(true)" /><v-btn icon="mdi-delete-outline" aria-label="删除策略" title="删除策略" variant="text" size="small" :disabled="draft.profiles.length < 2" @click="removeProfile" /></div>
            <v-select v-model="profile.scope" label="渠道授权范围" :items="[{title:'所有渠道',value:'all'},{title:'按标签限定',value:'tags'},{title:'指定渠道',value:'channels'}]" hide-details class="mb-4" />
            <template v-if="profile.scope === 'tags'"><v-select v-model="profile.match" label="标签匹配方式" :items="[{title:'任一匹配 · OR',value:'any'},{title:'全部匹配 · AND',value:'all'},{title:'排除匹配 · NONE',value:'none'}]" hide-details class="mb-4" /><v-autocomplete v-model="profile.tags" :items="allTags" label="授权标签" multiple chips closable-chips hide-details class="mb-4" /></template>
            <v-autocomplete v-if="profile.scope === 'channels'" v-model="profile.channelIds" :items="channelItems" label="授权渠道" multiple chips closable-chips hide-details class="mb-4" />
            <p class="text-body-2 text-medium-emphasis mb-4">{{ scopedChannels(profile, channels).length }} 个授权渠道 · {{ mappingModels.length }} 个可访问模型。故障切换仅在授权范围内进行。</p>
            <v-expansion-panels variant="accordion" class="mt-5">
              <v-expansion-panel title="模型权限与请求额度"><v-expansion-panel-text><v-select v-model="profile.modelMode" label="模型权限" :items="[{title:'全部模型',value:'all'},{title:'指定模型',value:'selected'}]" hide-details class="mb-4" /><v-autocomplete v-if="profile.modelMode === 'selected'" v-model="profile.models" :items="modelItems" label="允许访问的模型" multiple chips closable-chips hide-details class="mb-4" /><v-alert v-if="missingModels.length" type="warning" variant="tonal" density="compact" class="mb-4">{{ missingModels.join('、') }} 当前不在渠道模型中，保存的授权仍会保留。</v-alert><v-text-field v-model="profile.requestLimit" label="请求额度" type="text" inputmode="numeric" hint="留空不限制；填写大于 0 的整数。" persistent-hint /></v-expansion-panel-text></v-expansion-panel>
              <v-expansion-panel title="模型映射"><v-expansion-panel-text><p class="text-body-2 text-medium-emphasis mb-4">将一个入口名称映射到一个或多个已授权模型。</p><div v-for="(mapping, index) in profile.mappings" :key="index" class="mapping-row"><v-text-field v-model="mapping.from" label="入口名称" hide-details /><v-autocomplete v-model="mapping.to" :items="mappingModels" label="目标模型" multiple chips closable-chips hide-details /><v-btn icon="mdi-close" aria-label="删除模型映射" variant="text" size="small" @click="profile.mappings.splice(index, 1)" /></div><v-btn variant="text" size="small" prepend-icon="mdi-plus" @click="profile.mappings.push({from:'',to:[]})">添加映射</v-btn></v-expansion-panel-text></v-expansion-panel>
            </v-expansion-panels>
            </section><section v-show="editorSection === 'preview'" class="editor-section"><div class="text-subtitle-2 mb-4">{{ profile.name }}<v-chip v-if="profile.id === draft.activeProfile" color="success" size="small" variant="tonal" class="ml-3">当前生效</v-chip></div><ScopePreview :profile="profile" :channels="channels" /></section>
          </fieldset>
        </v-form>
        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-4" role="alert">{{ error }}</v-alert>
      </v-card-text>
      <v-divider /><v-card-actions class="px-5 py-3"><span class="text-caption text-medium-emphasis">{{ dirty ? '有未保存的更改' : '仅当前生效策略参与请求授权' }}</span><v-spacer /><v-btn variant="text" :disabled="busy" @click="close">取消</v-btn><v-btn color="primary" variant="flat" type="submit" :form="formId" :loading="busy" :disabled="busy">{{ keyRecord ? '保存配置' : '创建 API Key' }}</v-btn></v-card-actions>
    </v-card>
  </v-dialog>
  <v-dialog v-model="discard" aria-label="放弃未保存的更改" max-width="420" persistent><v-card title="放弃更改？" text="未保存的配置将丢失。"><v-card-actions><v-spacer /><v-btn @click="discard = false">继续编辑</v-btn><v-btn color="error" @click="emit('close')">放弃更改</v-btn></v-card-actions></v-card></v-dialog>
</template>

<style scoped>
.editor-fields { border: 0; margin: 0; padding: 0; min-width: 0; }
.editor-section { padding: 8px 0 12px; }
.editor-fields :deep(.v-row) { margin: 0; --v-col-gap-y: 16px; row-gap: 16px; }
.profile-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.profile-tools > .v-input { flex: 1; min-width: 180px; }
.mapping-row { display: grid; grid-template-columns: minmax(130px, .8fr) minmax(170px, 1.2fr) 32px; gap: 10px; align-items: start; margin-bottom: 12px; }
@media (max-width: 600px) { .mapping-row { grid-template-columns: minmax(0, 1fr) 32px; } .mapping-row > :nth-child(2) { grid-column: 1; } .mapping-row > :last-child { grid-column: 2; grid-row: 1; } }
</style>
