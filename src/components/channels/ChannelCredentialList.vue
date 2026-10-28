<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { CredentialMeta } from '../../../shared/types';
import { dateTime } from '../../format';
import { credentialChanged, credentialList, credentialPage, type CredentialFilter, type CredentialSort } from './credential-list';
import { credentialState, credentialStatus, type CredentialDraft } from './credential-utils';
import CredentialBalance from './CredentialBalance.vue';
import CredentialExpiry from './CredentialExpiry.vue';

const props = withDefaults(defineProps<{ credentials: CredentialMeta[]; drafts?: CredentialDraft[]; deletedIds?: string[]; monitoring?: boolean; hideNames?: boolean; busy?: boolean; managed?: boolean; deletable?: boolean }>(), { deletedIds: () => [], monitoring: false, hideNames: false, busy: false, managed: false, deletable: false });
const emit = defineEmits<{ edit: [key: CredentialMeta]; toggle: [key: CredentialMeta]; delete: [key: CredentialMeta]; restore: [key: CredentialMeta] }>();
const query = ref(''); const filter = ref<CredentialFilter>('all'); const sort = ref<CredentialSort>('created');
const page = ref(1); const pageSize = ref(20); const now = ref(Date.now());
const clock = window.setInterval(() => { now.value = Date.now(); }, 1000);
onBeforeUnmount(() => window.clearInterval(clock));
const draftsById = computed(() => new Map((props.drafts ?? []).map(draft => [draft.id, draft])));
const deleted = computed(() => new Set(props.deletedIds));
const filtered = computed(() => credentialList(props.credentials, { query: query.value, filter: filter.value, sort: sort.value, drafts: props.drafts, deletedIds: props.deletedIds, hideNames: props.hideNames, now: now.value }));
const pagination = computed(() => credentialPage(filtered.value, page.value, pageSize.value));
const states = computed(() => props.credentials.reduce((result, key) => { if (!deleted.value.has(key.id)) result[credentialState(key, now.value)]++; return result; }, { available: 0, expired: 0, exhausted: 0, disabled: 0 }));
const modified = computed(() => props.credentials.filter(key => !deleted.value.has(key.id) && credentialChanged(key, draftsById.value.get(key.id))).length);
const filters = computed(() => [{ title: '全部状态', value: 'all' }, { title: `可用 (${states.value.available})`, value: 'available' }, ...(props.monitoring ? [{ title: `已到期 (${states.value.expired})`, value: 'expired' }, { title: `额度耗尽 (${states.value.exhausted})`, value: 'exhausted' }] : []), { title: `已停用 (${states.value.disabled})`, value: 'disabled' }, ...(props.drafts ? [{ title: `待保存 (${modified.value})`, value: 'modified' }] : []), ...(props.deletable ? [{ title: `待删除 (${deleted.value.size})`, value: 'deleted' }] : [])]);
const sorts = computed(() => [{ title: '默认顺序', value: 'created' }, ...(props.hideNames ? [] : [{ title: '名称', value: 'name' }]), ...(props.monitoring ? [{ title: '最早到期', value: 'expiry' }, { title: '余额从低到高', value: 'balance' }] : [])]);
watch([query, filter, sort, pageSize], () => { page.value = 1; });
watch(() => props.hideNames, hidden => { if (hidden && sort.value === 'name') sort.value = 'created'; });
watch(() => pagination.value.page, value => { page.value = value; });
function name(key: CredentialMeta) { return props.hideNames ? key.preview : draftsById.value.get(key.id)?.label || key.label; }
function replacement(key: CredentialMeta) { return !!draftsById.value.get(key.id)?.secret.trim(); }
function color(key: CredentialMeta) { const state = credentialState(key, now.value); return state === 'available' ? 'success' : state === 'disabled' ? 'secondary' : 'warning'; }
</script>
<template>
  <div class="credential-list">
    <div class="credential-list-summary">
      <strong>{{ credentials.length }} 个 Key</strong><span class="summary-divider" />
      <span class="text-success">{{ states.available }} 可用</span>
      <span v-if="monitoring" :class="states.expired ? 'text-warning' : ''">{{ states.expired }} 已到期</span>
      <span v-if="monitoring" :class="states.exhausted ? 'text-warning' : ''">{{ states.exhausted }} 额度耗尽</span>
      <span v-if="states.disabled">{{ states.disabled }} 已停用</span>
      <v-chip v-if="modified" size="x-small" color="primary" variant="tonal">{{ modified }} 个待保存</v-chip>
      <v-chip v-if="deleted.size" size="x-small" color="error" variant="tonal">{{ deleted.size }} 个待删除 · 保存后生效</v-chip>
    </div>
    <div class="credential-list-toolbar">
      <v-text-field v-model="query" :label="hideNames ? '搜索 Key 尾号' : '搜索名称或 Key 尾号'" prepend-inner-icon="mdi-magnify" clearable hide-details density="compact" variant="solo-filled" flat class="credential-search" />
      <v-select v-model="filter" :items="filters" label="状态" hide-details density="compact" class="credential-filter" />
      <v-select v-model="sort" :items="sorts" label="排序" hide-details density="compact" class="credential-sort" />
    </div>
    <v-table density="compact" hover fixed-header class="credential-list-table" :class="{ 'credential-list-table--monitored': monitoring }">
      <thead><tr><th>{{ hideNames ? 'API Key' : '密钥名称 / Key' }}</th><th>状态</th><th v-if="monitoring">余额</th><th v-if="monitoring">到期时间</th><th v-else>失败次数</th><th class="credential-actions-column">操作</th></tr></thead>
      <tbody>
        <tr v-for="key in pagination.items" :key="key.id" :class="{ 'credential-pending-delete': deleted.has(key.id) }">
          <td class="credential-identity" :class="{ 'credential-identity--preview': hideNames }"><div class="credential-name"><code v-if="hideNames">{{ key.preview }}</code><strong v-else :title="name(key)">{{ name(key) }}</strong><span v-if="!deleted.has(key.id) && credentialChanged(key, draftsById.get(key.id))" class="draft-dot" title="有待保存的修改" aria-label="有待保存的修改" /></div><code v-if="!hideNames">{{ key.preview }}</code></td>
          <td><v-chip v-if="deleted.has(key.id)" color="error" size="x-small" variant="tonal">待删除</v-chip><v-chip v-else :color="color(key)" size="x-small" variant="tonal" :title="key.reason || undefined">{{ credentialStatus(key, now) }}</v-chip><span v-if="key.failureCount" class="credential-cell-note">失败 {{ key.failureCount }} 次</span></td>
          <td v-if="monitoring"><span v-if="replacement(key)" class="text-caption text-medium-emphasis">保存后重新查询</span><CredentialBalance v-else :balance="key.balance" :show-expiry="false" compact /></td>
          <td v-if="monitoring"><span v-if="replacement(key)" class="text-caption text-medium-emphasis">待查询</span><CredentialExpiry v-else :balance="key.balance" :now="now" /></td>
          <td v-else>{{ key.failureCount }}<span class="credential-cell-note">{{ dateTime(key.createdAt) }}</span></td>
          <td class="credential-actions-column"><div class="credential-row-actions"><v-btn v-if="deleted.has(key.id)" size="x-small" variant="text" :disabled="busy" prepend-icon="mdi-undo" :aria-label="`撤销删除密钥 ${name(key)}`" @click="emit('restore', key)">撤销</v-btn><template v-else><v-btn icon="mdi-pencil-outline" size="x-small" variant="text" :disabled="busy" :aria-label="`编辑密钥 ${name(key)}`" @click="emit('edit', key)" /><v-btn v-if="managed" :icon="key.enabled ? 'mdi-pause-circle-outline' : 'mdi-play-circle-outline'" size="x-small" variant="text" :disabled="busy" :aria-label="`${key.enabled ? '停用' : '启用'}密钥 ${name(key)}`" @click="emit('toggle', key)" /><v-btn v-if="managed || deletable" icon="mdi-delete-outline" size="x-small" variant="text" color="error" :disabled="busy" :aria-label="`删除密钥 ${name(key)}`" @click="emit('delete', key)" /></template></div></td>
        </tr>
        <tr v-if="!pagination.items.length"><td :colspan="monitoring ? 5 : 4" class="credential-list-empty"><v-icon size="22">mdi-key-search-outline</v-icon><p>{{ credentials.length ? '没有符合条件的 Key' : '尚未配置上游 Key' }}</p><v-btn v-if="credentials.length" size="small" variant="text" color="primary" @click="query = ''; filter = 'all'">清除筛选</v-btn></td></tr>
      </tbody>
    </v-table>
    <div class="credential-list-footer"><span>{{ pagination.start }}–{{ pagination.end }} / {{ filtered.length }} 个<template v-if="filtered.length !== credentials.length">（共 {{ credentials.length }} 个）</template></span><v-spacer /><v-select v-model="pageSize" :items="[10, 20, 50, 100]" label="每页" hide-details density="compact" class="credential-page-size" /><v-pagination v-model="page" :length="pagination.pageCount" :total-visible="3" density="compact" size="small" /></div>
  </div>
</template>
<style scoped>
.credential-list { min-width: 0; max-width: 100%; overflow: hidden; border: 1px solid rgba(var(--v-theme-on-surface), .12); border-radius: 6px; }
.credential-list-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; padding: 12px 14px 10px; font-size: 12px; color: rgba(var(--v-theme-on-surface), .58); }
.credential-list-summary > strong { font-size: 13px; color: rgb(var(--v-theme-on-surface)); }
.summary-divider { height: 12px; border-left: 1px solid rgba(var(--v-theme-on-surface), .2); }
.credential-list-toolbar { display: flex; align-items: center; gap: 10px; padding: 0 12px 12px; }
.credential-search { flex: 1 1 220px; min-width: 160px; }
.credential-filter { flex: 0 1 150px; min-width: 130px; }
.credential-sort { flex: 0 1 150px; min-width: 130px; }
.credential-list-table { --credential-table-height: min(560px, max(240px, calc(100dvh - 530px))); max-height: var(--credential-table-height); border-block: 1px solid rgba(var(--v-theme-on-surface), .1); }
.credential-list-table :deep(.v-table__wrapper) { max-height: var(--credential-table-height); }
.credential-list-table :deep(table) { min-width: 420px; }
.credential-list-table--monitored :deep(table) { min-width: 650px; }
.credential-list-table :deep(th) { height: 34px; font-size: 12px; background: rgb(var(--v-theme-surface)); white-space: nowrap; }
.credential-list-table :deep(td) { padding: 11px 14px; font-size: 13px; }
.credential-identity { width: 30%; min-width: 150px; max-width: 240px; }
.credential-identity--preview { width: 18%; min-width: 100px; }
.credential-name { display: flex; align-items: center; gap: 6px; }
.credential-name > strong { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; }
.credential-name > code { font-size: 13px; font-weight: 500; white-space: nowrap; }
.credential-pending-delete .credential-name > strong { text-decoration: line-through; color: rgba(var(--v-theme-on-surface), .5); }
.credential-pending-delete .credential-name > code { text-decoration: line-through; color: rgba(var(--v-theme-on-surface), .5); }
.credential-identity > code { display: block; margin-top: 4px; font-size: 11px; color: rgba(var(--v-theme-on-surface), .5); }
.draft-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: rgb(var(--v-theme-primary)); }
.credential-cell-note { display: block; margin-top: 5px; font-size: 11px; color: rgba(var(--v-theme-on-surface), .5); white-space: nowrap; }
.credential-actions-column { width: 1%; text-align: right; position: sticky; right: 0; z-index: 1; background: rgb(var(--v-theme-surface)); }
.credential-row-actions { display: flex; justify-content: flex-end; gap: 2px; }
.credential-list-empty { padding: 30px 12px !important; text-align: center; color: rgba(var(--v-theme-on-surface), .5); }
.credential-list-empty p { margin-top: 8px; font-size: 13px; }
.credential-list-footer { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 8px 10px 8px 14px; font-size: 12px; color: rgba(var(--v-theme-on-surface), .58); }
.credential-page-size { flex: 0 0 80px; max-width: 80px; }
.credential-list-footer :deep(.v-pagination__item), .credential-list-footer :deep(.v-pagination__prev), .credential-list-footer :deep(.v-pagination__next) { margin: 0 1px; }
@media (max-width: 700px) { .credential-list-toolbar { flex-wrap: wrap; gap: 8px; } .credential-search { flex-basis: 100%; } .credential-filter, .credential-sort { flex: 1; min-width: 0; } .credential-list-summary { gap: 6px 10px; } .credential-list-footer { padding-inline: 10px; } .credential-list-footer > span { flex-basis: 100%; } }
</style>
