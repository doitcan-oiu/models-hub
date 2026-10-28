<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { GatewayApiKey } from '../../shared/types';
import { api } from '../api';
import { requestLimitLabel } from '../access-policy';
import { dateTime } from '../format';
import { filterApiKeys, keyDeleteTargets, keyListPage, type ApiKeySort } from '../key-list';
import { useConsole } from '../composables/useConsole';
import KeyEditor from '../components/access/KeyEditor.vue';
import ScopePreview from '../components/access/ScopePreview.vue';
import { currentProfile, keyState, scopeNames, stateNames } from '../components/access/policy';

type KeyState = ReturnType<typeof keyState>;
type DeleteTarget = Pick<GatewayApiKey, 'id' | 'name' | 'preview'>;
type Confirmation = { action: 'rotate'; key: DeleteTarget } | { action: 'delete'; targets: DeleteTarget[]; bulk: boolean };
const { keys, channels, tags, notify, refresh, copy, loading } = useConsole();
const search = ref('');
const status = ref<KeyState | 'all'>('all');
const scope = ref<'any' | 'all' | 'tags' | 'channels'>('any');
const sort = ref<ApiKeySort>('newest');
const page = ref(1), pageSize = ref(20), selected = ref<string[]>([]), busy = ref(false);
const editorOpen = ref(false), editingKey = ref<GatewayApiKey | null>(null);
const secret = ref<{ name: string; value: string } | null>(null);
const confirmation = ref<Confirmation | null>(null);
const detail = ref<GatewayApiKey | null>(null), detailProfileId = ref('');
const counts = computed(() => keys.value.reduce<Record<KeyState | 'all', number>>((result, key) => { result[keyState(key)]++; return result; }, { all: keys.value.length, active: 0, disabled: 0, expired: 0, revoked: 0 }));
const statusTabs: { title: string; value: KeyState | 'all' }[] = [{ title: '全部', value: 'all' }, { title: '已启用', value: 'active' }, { title: '已停用', value: 'disabled' }, { title: '已过期', value: 'expired' }, { title: '旧已撤销', value: 'revoked' }];
const scopeItems = [{ title: '全部授权类型', value: 'any' }, { title: '所有渠道', value: 'all' }, { title: '按标签限定', value: 'tags' }, { title: '指定渠道', value: 'channels' }];
const sortItems = [{ title: '最近创建', value: 'newest' }, { title: '最早创建', value: 'oldest' }, { title: '名称 A → Z', value: 'name' }, { title: '请求量最高', value: 'used' }, { title: '最早到期', value: 'expiry' }];
const totalRequests = computed(() => keys.value.reduce((sum, key) => sum + key.used, 0));
const filtered = computed(() => filterApiKeys(keys.value, { query: search.value, status: status.value, scope: scope.value, sort: sort.value }));
const pagination = computed(() => keyListPage(filtered.value, page.value, pageSize.value));
const shown = computed(() => pagination.value.items), pageCount = computed(() => pagination.value.pageCount);
const resultRange = computed(() => filtered.value.length ? `${(pagination.value.page - 1) * pageSize.value + 1}–${Math.min(pagination.value.page * pageSize.value, filtered.value.length)}` : '0');
const selectedSet = computed(() => new Set(selected.value));
const selectedKeys = computed(() => keys.value.filter(key => selectedSet.value.has(key.id)));
const selectedHasRevoked = computed(() => selectedKeys.value.some(key => key.status === 'revoked'));
const pageSelected = computed(() => shown.value.length > 0 && shown.value.every(key => selectedSet.value.has(key.id)));
const pagePartSelected = computed(() => !pageSelected.value && shown.value.some(key => selectedSet.value.has(key.id)));
const filtersActive = computed(() => !!search.value?.trim() || status.value !== 'all' || scope.value !== 'any');
const detailProfile = computed(() => detail.value?.profiles.find(profile => profile.id === detailProfileId.value) ?? (detail.value ? currentProfile(detail.value) : undefined));
const detailProfiles = computed(() => detail.value?.profiles.map(profile => ({ title: profile.name + (profile.id === detail.value?.activeProfile ? ' · 当前生效' : ''), value: profile.id })) ?? []);

// A batch belongs to the page being viewed; changing the page or filters starts a new batch.
watch([search, status, scope, sort, pageSize], () => { page.value = 1; selected.value = []; });
watch(page, () => { selected.value = []; });
watch(pageCount, value => { if (page.value > value) page.value = value; });
watch(keys, value => {
  // A background refresh can also move a key out of the filtered page.
  const ids = new Set(shown.value.map(key => key.id));
  selected.value = selected.value.filter(id => ids.has(id));
  if (detail.value) detail.value = value.find(key => key.id === detail.value?.id) ?? null;
});
function resetFilters() { search.value = ''; status.value = 'all'; scope.value = 'any'; }
function select(id: string) {
  if (busy.value) return;
  if (selectedSet.value.has(id)) selected.value = selected.value.filter(value => value !== id);
  else if (selected.value.length >= 200) notify('每次最多选择 200 个 API Key', 'warning');
  else selected.value = [...selected.value, id];
}
function selectPage() {
  if (busy.value) return;
  if (pageSelected.value) selected.value = [];
  else if (shown.value.length > 200) notify('每次最多选择 200 个 API Key', 'warning');
  else selected.value = shown.value.map(key => key.id);
}
function edit(key: GatewayApiKey | null) { editingKey.value = key; editorOpen.value = true; }
function showDetail(key: GatewayApiKey) { detail.value = key; detailProfileId.value = key.activeProfile; }
function deleteKeys(targets: GatewayApiKey[], bulk = false) {
  if (!targets.length || busy.value) return;
  try { confirmation.value = { action: 'delete', bulk, targets: keyDeleteTargets(keys.value, targets.map(key => key.id)) }; }
  catch (error) { notify(error instanceof Error ? error.message : '请选择需要删除的 API Key', 'error'); }
}
async function run(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  try { await action(); }
  catch (error) { notify(error instanceof Error ? error.message : '操作失败', 'error'); }
  finally { busy.value = false; }
}
function updateKey(key: GatewayApiKey) { keys.value = keys.value.map(value => value.id === key.id ? key : value); }
async function setProfile() {
  const key = detail.value, profile = detailProfile.value;
  if (!key || !profile || key.status === 'revoked' || profile.id === key.activeProfile) return;
  await run(async () => {
    const result = await api<{ key: GatewayApiKey }>(`/api/keys/${encodeURIComponent(key.id)}`, { method: 'PATCH', body: JSON.stringify({ activeProfile: profile.id }) });
    updateKey(result.key); notify('已切换当前生效策略', 'success'); await refresh(true);
  });
}
async function toggleStatus(key: GatewayApiKey) {
  if (key.status === 'revoked') return;
  await run(async () => {
    const next = key.status === 'active' ? 'disabled' : 'active';
    const result = await api<{ key: GatewayApiKey }>(`/api/keys/${encodeURIComponent(key.id)}`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
    updateKey(result.key); notify(next === 'active' ? 'API Key 已启用' : 'API Key 已停用', 'success'); await refresh(true);
  });
}
async function bulkStatus(action: 'enable' | 'disable') {
  if (!selected.value.length || selected.value.length > 200 || selectedHasRevoked.value) return;
  const ids = [...selected.value];
  await run(async () => {
    const result = await api<{ keys: GatewayApiKey[] }>('/api/keys/bulk', { method: 'POST', body: JSON.stringify({ ids, action }) });
    keys.value = result.keys; selected.value = [];
    notify(`已${action === 'enable' ? '启用' : '停用'} ${ids.length} 个 API Key`, 'success'); await refresh(true);
  });
}
async function confirmAction() {
  const pending = confirmation.value;
  if (!pending) return;
  await run(async () => {
    if (pending.action === 'delete') {
      const ids = pending.targets.map(key => key.id);
      if (pending.bulk) await api('/api/keys/bulk', { method: 'POST', body: JSON.stringify({ ids, action: 'delete' }) });
      else await api(`/api/keys/${encodeURIComponent(ids[0]!)}`, { method: 'DELETE' });
      const removed = new Set(ids);
      keys.value = keys.value.filter(key => !removed.has(key.id));
      selected.value = selected.value.filter(id => !removed.has(id));
      notify(`已删除 ${ids.length} 个 API Key`, 'success');
    } else {
      const result = await api<{ key: GatewayApiKey; token: string }>(`/api/keys/${encodeURIComponent(pending.key.id)}/rotate`, { method: 'POST' });
      updateKey(result.key); secret.value = { name: result.key.name, value: result.token };
      notify('密钥已轮换，旧密钥立即失效', 'success');
    }
    confirmation.value = null; await refresh(true);
  });
}
const expiry = (key: GatewayApiKey) => !key.expires || ['永不过期', 'never'].includes(key.expires) ? '永不过期' : `${key.expires} 到期`;
const shortDate = (value: string) => new Date(value).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
</script>

<template>
  <div class="keys-view">
    <header class="keys-heading"><div><h1>API Keys <span>{{ keys.length }}</span></h1><p>管理应用访问凭证、授权策略和使用状态。</p></div><div class="keys-heading-actions"><span class="request-total">累计 {{ totalRequests.toLocaleString('zh-CN') }} 次请求</span><v-btn color="primary" prepend-icon="mdi-plus" :disabled="busy" @click="edit(null)">创建 API Key</v-btn></div></header>
    <v-card variant="flat" border class="keys-card">
      <v-tabs v-model="status" color="primary" class="keys-status-tabs" aria-label="按 API Key 状态筛选" :disabled="busy" show-arrows><v-tab v-for="tab in statusTabs" :key="tab.value" :value="tab.value">{{ tab.title }}<span class="tab-count">{{ counts[tab.value] }}</span></v-tab></v-tabs>
      <v-divider />
      <div class="keys-toolbar">
        <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" placeholder="搜索名称、备注、密钥掩码或 ID" aria-label="搜索 API Key" density="compact" variant="solo-filled" flat hide-details clearable class="key-search" :disabled="busy" @click:clear="search = ''" />
        <v-select v-model="scope" :items="scopeItems" aria-label="授权类型" density="compact" variant="solo-filled" flat hide-details class="scope-filter" :disabled="busy" />
        <v-select v-model="sort" :items="sortItems" aria-label="API Key 排序" density="compact" variant="solo-filled" flat hide-details class="sort-filter" :disabled="busy" />
        <v-btn v-if="filtersActive" variant="text" size="small" :disabled="busy" @click="resetFilters">重置</v-btn><v-btn icon="mdi-refresh" variant="text" aria-label="刷新 API Keys" title="刷新 API Keys" :loading="loading" :disabled="busy" @click="refresh()" />
      </div>
      <div class="keys-bulk-bar" :class="{ 'has-selection': selected.length }" aria-label="API Key 批量操作"><div class="selection-summary"><strong>{{ selected.length ? `已选 ${selected.length} 个` : '批量操作' }}</strong><span v-if="selectedHasRevoked" class="text-warning">含旧已撤销凭证，仅可删除</span><span v-else>当前页选择 · 翻页或筛选后清空</span></div><div class="bulk-actions"><v-btn v-if="selected.length" size="small" variant="text" :disabled="busy" @click="selected = []">清空</v-btn><v-btn size="small" variant="text" prepend-icon="mdi-play-outline" :disabled="busy || !selected.length || selectedHasRevoked" @click="bulkStatus('enable')">启用</v-btn><v-btn size="small" variant="text" prepend-icon="mdi-pause" :disabled="busy || !selected.length || selectedHasRevoked" @click="bulkStatus('disable')">停用</v-btn><v-btn color="error" size="small" variant="text" prepend-icon="mdi-delete-outline" :disabled="busy || !selected.length" @click="deleteKeys(selectedKeys, true)">删除</v-btn></div></div>
      <v-progress-linear v-if="busy" indeterminate height="2" color="primary" />
      <v-table density="compact" class="keys-table" :aria-busy="busy" aria-label="API Key 列表">
        <thead><tr><th class="selection-cell"><v-checkbox-btn :model-value="pageSelected" :indeterminate="pagePartSelected" :disabled="busy || !shown.length" aria-label="选择当前页全部 API Keys" density="compact" @update:model-value="selectPage" /></th><th>名称 / 备注</th><th>访问凭证</th><th>状态</th><th>当前授权策略</th><th class="text-right">请求量 / 有效期</th><th class="text-right">操作</th></tr></thead>
        <tbody>
          <tr v-for="item in shown" :key="item.id" :class="{ 'selected-row': selectedSet.has(item.id) }">
            <td class="selection-cell"><v-checkbox-btn :model-value="selectedSet.has(item.id)" :disabled="busy" :aria-label="`选择 ${item.name}`" density="compact" @update:model-value="select(item.id)" /></td>
            <td class="application-cell"><button class="application-name" :title="item.name" @click="showDetail(item)">{{ item.name }}</button><span class="key-note" :title="item.note">{{ item.note || '无备注' }}</span></td>
            <td class="credential-cell"><code>{{ item.preview }}</code><span class="cell-secondary">创建于 {{ shortDate(item.createdAt) }}</span></td>
            <td><v-chip :color="keyState(item) === 'active' ? 'success' : keyState(item) === 'expired' ? 'warning' : undefined" variant="tonal" size="small">{{ item.status === 'revoked' ? '旧已撤销' : stateNames[keyState(item)] }}</v-chip></td>
            <td class="profile-cell"><button class="profile-name" :title="currentProfile(item).name" :aria-label="`查看 ${item.name} 的授权策略`" @click="showDetail(item)">{{ currentProfile(item).name }}<span v-if="item.profiles.length > 1" class="profile-count">+{{ item.profiles.length - 1 }}</span><v-icon icon="mdi-chevron-right" size="14" /></button><span class="cell-secondary">{{ scopeNames[currentProfile(item).scope] }} · {{ currentProfile(item).modelMode === 'all' ? '全部模型' : `${currentProfile(item).models.length} 个模型` }}</span></td>
            <td class="usage-cell text-right"><strong>{{ item.used.toLocaleString('zh-CN') }}</strong><span class="cell-secondary" :class="{ 'text-warning': keyState(item) === 'expired' }">{{ expiry(item) }}</span></td>
            <td><div class="row-actions"><v-btn icon="mdi-pencil-outline" size="small" variant="text" :aria-label="`编辑 ${item.name}`" title="编辑" :disabled="busy || item.status === 'revoked'" @click="edit(item)" /><v-btn :icon="item.status === 'active' ? 'mdi-pause' : 'mdi-play-outline'" size="small" variant="text" :aria-label="`${item.status === 'active' ? '停用' : '启用'} ${item.name}`" :title="item.status === 'active' ? '停用' : '启用'" :disabled="busy || item.status === 'revoked'" @click="toggleStatus(item)" /><v-btn icon="mdi-delete-outline" color="error" size="small" variant="text" :aria-label="`删除 ${item.name}`" title="删除" :disabled="busy" @click="deleteKeys([item])" /><v-menu><template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" icon="mdi-dots-vertical" size="small" variant="text" :disabled="busy" :aria-label="`${item.name} 更多操作`" /></template><v-list density="compact"><v-list-item title="详情与权限" prepend-icon="mdi-shield-key-outline" @click="showDetail(item)" /><v-list-item title="轮换密钥" prepend-icon="mdi-autorenew" :disabled="item.status === 'revoked'" @click="confirmation = { action: 'rotate', key: { id: item.id, name: item.name, preview: item.preview } }" /></v-list></v-menu></div></td>
          </tr>
          <tr v-if="!shown.length"><td colspan="7" class="keys-empty"><v-icon icon="mdi-key-outline" size="32" color="medium-emphasis" /><h2>{{ keys.length ? '没有匹配的 API Key' : '创建第一个 API Key' }}</h2><p>{{ keys.length ? '试试其他名称、状态或授权类型。' : '为应用分配独立凭证，分别管理权限和用量。' }}</p><v-btn v-if="!keys.length" color="primary" prepend-icon="mdi-plus" :disabled="busy" @click="edit(null)">创建 API Key</v-btn><v-btn v-else variant="tonal" :disabled="busy" @click="resetFilters">重置筛选</v-btn></td></tr>
        </tbody>
      </v-table>
      <div class="keys-pagination"><span class="result-count">显示 {{ resultRange }} / {{ filtered.length }} 个</span><div class="page-size"><span>每页</span><v-select v-model="pageSize" :items="[20, 50, 100]" aria-label="每页 API Key 数量" density="compact" variant="outlined" hide-details :disabled="busy" /></div><v-pagination v-model="page" :length="pageCount" :total-visible="5" density="compact" :disabled="busy" aria-label="API Key 分页" /></div>
    </v-card>

    <KeyEditor v-if="editorOpen" :key-record="editingKey" :channels="channels" :tags="tags" @close="editorOpen = false" @secret="secret = $event" />
    <v-dialog :model-value="Boolean(secret)" aria-label="保存 API Key" max-width="600" persistent><v-card v-if="secret"><v-card-title class="px-5 pt-4">保存 API Key</v-card-title><v-card-text><div class="text-subtitle-2 mb-3">{{ secret.name }}</div><v-alert type="warning" variant="tonal" density="compact" class="mb-4">完整密钥仅显示一次，请复制后妥善保存。</v-alert><div class="secret-value"><code>{{ secret.value }}</code><v-btn icon="mdi-content-copy" variant="text" aria-label="复制 API Key" @click="copy(secret.value)" /></div></v-card-text><v-card-actions class="px-5 pb-3"><v-spacer /><v-btn color="primary" variant="flat" @click="secret = null">已保存，关闭</v-btn></v-card-actions></v-card></v-dialog>
    <v-dialog :model-value="Boolean(confirmation)" :aria-label="confirmation?.action === 'rotate' ? '轮换 API Key' : '删除 API Key'" max-width="520" persistent>
      <v-card v-if="confirmation"><v-card-title class="px-5 pt-4">{{ confirmation.action === 'rotate' ? '轮换 API Key？' : `删除 ${confirmation.targets.length} 个 API Key？` }}</v-card-title><v-card-text><template v-if="confirmation.action === 'delete'"><v-alert type="error" variant="tonal" density="compact" class="mb-4">删除后立即失效且从列表删除，历史请求日志保留。此操作无法撤销。</v-alert><p class="text-body-2 mb-3">将删除以下 {{ confirmation.targets.length }} 个 API Key：</p><ul class="delete-preview"><li v-for="target in confirmation.targets.slice(0, 8)" :key="target.id"><strong>{{ target.name }}</strong><code>{{ target.preview }}</code></li></ul><p v-if="confirmation.targets.length > 8" class="text-caption text-medium-emphasis mt-3">另有 {{ confirmation.targets.length - 8 }} 个已选 API Key。</p></template><template v-else><p>「{{ confirmation.key.name }}」的旧密钥将立即失效，请将新密钥更新到应用中。权限和累计用量保留。</p><code class="text-medium-emphasis d-block mt-3">{{ confirmation.key.preview }}</code></template></v-card-text><v-card-actions class="px-5 pb-4"><v-spacer /><v-btn :disabled="busy" @click="confirmation = null">取消</v-btn><v-btn :color="confirmation.action === 'delete' ? 'error' : 'primary'" variant="flat" :loading="busy" @click="confirmAction">{{ confirmation.action === 'rotate' ? '确认轮换' : `删除 ${confirmation.targets.length} 个` }}</v-btn></v-card-actions></v-card>
    </v-dialog>
    <v-dialog :model-value="Boolean(detail)" aria-label="API Key 详情与权限" max-width="760" scrollable @update:model-value="(value: boolean) => { if (!value && !busy) detail = null; }">
      <v-card v-if="detail"><v-card-title class="detail-heading"><div><h2>{{ detail.name }}</h2><code>{{ detail.preview }}</code></div><v-btn icon="mdi-close" size="small" variant="text" aria-label="关闭凭证详情" :disabled="busy" @click="detail = null" /></v-card-title><v-divider /><v-card-text><div class="detail-grid mb-5"><div><span>状态</span>{{ detail.status === 'revoked' ? '旧已撤销' : stateNames[keyState(detail)] }}</div><div><span>累计请求</span>{{ detail.used.toLocaleString('zh-CN') }} 次</div><div><span>有效期</span>{{ expiry(detail) }}</div><div><span>创建时间</span>{{ dateTime(detail.createdAt) }}</div><div><span>凭证 ID</span><code>{{ detail.id }}</code></div><div v-if="detailProfile"><span>当前查看策略的请求额度</span>{{ requestLimitLabel(detailProfile.requestLimit) }}</div></div><p v-if="detail.note" class="detail-note text-body-2 mb-4">{{ detail.note }}</p><v-alert v-if="keyState(detail) !== 'active'" type="warning" variant="tonal" density="compact" class="mb-4">此凭证{{ stateNames[keyState(detail)] }}，不能发起请求。以下显示保存的授权范围。</v-alert><div class="detail-profile-heading"><h3>授权策略</h3><p>{{ detail.profiles.length }} 个策略 · 当前生效：{{ currentProfile(detail).name }}</p></div><div v-if="detail.profiles.length > 1" class="detail-profile-picker"><v-select v-model="detailProfileId" label="查看策略" :items="detailProfiles" hide-details :disabled="busy" /><v-btn v-if="detailProfile && detailProfile.id !== detail.activeProfile" variant="tonal" color="primary" :disabled="busy || detail.status === 'revoked'" :loading="busy" @click="setProfile">设为当前生效</v-btn></div><ScopePreview v-if="detailProfile" :key="detailProfile.id" :profile="detailProfile" :channels="channels" /></v-card-text><v-divider /><v-card-actions class="px-5 py-3"><v-btn color="error" variant="text" prepend-icon="mdi-delete-outline" :disabled="busy" @click="deleteKeys([detail])">删除</v-btn><v-spacer /><v-btn :disabled="busy" @click="detail = null">关闭</v-btn><v-btn v-if="detail.status !== 'revoked'" color="primary" variant="flat" :disabled="busy" @click="edit(detail); detail = null">编辑权限</v-btn></v-card-actions></v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.keys-view { display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; min-width: 0; }
.keys-view > * { min-width: 0; }
.keys-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px; }
.keys-heading h1 { display: flex; align-items: center; gap: 10px; font-size: 21px; font-weight: 650; line-height: 1.4; }
.keys-heading h1 span { font-size: 12px; font-weight: 500; padding: 2px 8px; border-radius: 5px; color: rgba(var(--v-theme-on-surface), .7); background: rgba(var(--v-theme-on-surface), .07); }
.keys-heading p { margin-top: 5px; font-size: 13px; color: rgba(var(--v-theme-on-surface), .55); }
.keys-heading-actions { display: flex; align-items: center; gap: 18px; }
.request-total { color: rgba(var(--v-theme-on-surface), .5); font-size: 12px; }
.keys-card { min-width: 0; max-width: 100%; overflow: visible; }
.keys-status-tabs { padding-inline: 8px; }
.keys-status-tabs :deep(.v-tab) { padding-inline: 16px; min-width: 80px; font-size: 13px; }
.tab-count { margin-left: 8px; font-size: 11px; opacity: .65; font-variant-numeric: tabular-nums; }
.keys-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 14px 16px; }
.keys-toolbar > .key-search { flex: 1 1 270px; min-width: 200px; }
.keys-toolbar > .scope-filter { flex: 0 1 170px; min-width: 150px; }
.keys-toolbar > .sort-filter { flex: 0 1 150px; min-width: 130px; }
.keys-bulk-bar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px 12px; padding: 9px 16px; min-height: 50px; border-block: 1px solid rgba(var(--v-border-color), .1); background: rgba(var(--v-theme-on-surface), .025); }
.keys-bulk-bar.has-selection { background: rgba(var(--v-theme-primary), .055); }
.selection-summary, .bulk-actions { display: flex; align-items: center; gap: 10px; }
.selection-summary { flex-wrap: wrap; }
.selection-summary strong { font-size: 12px; font-weight: 600; }
.selection-summary > span { font-size: 11px; color: rgba(var(--v-theme-on-surface), .5); }
.bulk-actions { gap: 2px; }
.keys-table { min-width: 0; max-width: 100%; }
.keys-table :deep(.v-table__wrapper) { min-width: 0; max-width: 100%; overflow-x: auto; }
.keys-table :deep(table) { min-width: 1010px; table-layout: fixed; }
.keys-table :deep(th), .keys-table :deep(td) { padding-inline: 12px !important; }
.keys-table :deep(td) { height: 62px; padding-block: 8px !important; }
.keys-table :deep(th:first-child), .keys-table :deep(td:first-child) { width: 46px; padding-inline: 8px !important; }
.keys-table :deep(th:nth-child(2)) { width: 24%; }
.keys-table :deep(th:nth-child(3)) { width: 18%; }
.keys-table :deep(th:nth-child(4)) { width: 100px; }
.keys-table :deep(th:nth-child(5)) { width: 23%; }
.keys-table :deep(th:nth-child(6)) { width: 150px; }
.keys-table :deep(th:last-child) { width: 150px; }
.keys-table :deep(.selected-row) { background: rgba(var(--v-theme-primary), .045); }
.application-name, .profile-name { background: transparent; border: 0; padding: 0; color: inherit; cursor: pointer; text-align: left; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.application-name { display: block; font-size: 13px; font-weight: 600; }
.application-name:hover, .profile-name:hover { color: rgb(var(--v-theme-primary)); }
.application-name:focus-visible, .profile-name:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 3px; border-radius: 2px; }
.key-note, .cell-secondary { display: block; margin-top: 4px; color: rgba(var(--v-theme-on-surface), .5); font-size: 11px; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.credential-cell code { font-size: 12px; white-space: nowrap; }
.profile-name { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.profile-count { padding: 0 4px; border-radius: 3px; font-size: 10px; background: rgba(var(--v-theme-on-surface), .08); }
.usage-cell strong { font-size: 13px; font-weight: 500; font-variant-numeric: tabular-nums; }
.row-actions { display: flex; justify-content: flex-end; gap: 1px; }
.keys-pagination { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 10px 18px; padding: 10px 16px; border-top: 1px solid rgba(var(--v-border-color), .1); }
.result-count { margin-right: auto; font-size: 12px; color: rgba(var(--v-theme-on-surface), .6); }
.page-size { display: flex; align-items: center; gap: 8px; font-size: 12px; color: rgba(var(--v-theme-on-surface), .6); }
.page-size .v-input { width: 82px; }
.keys-pagination :deep(.v-pagination__list) { flex-wrap: nowrap; }
.keys-empty { padding: 48px 20px !important; text-align: center; }
.keys-empty h2 { margin-top: 12px; font-size: 15px; font-weight: 500; }
.keys-empty p { margin: 6px 0 18px; font-size: 12px; color: rgba(var(--v-theme-on-surface), .5); }
.secret-value { display: flex; align-items: center; gap: 10px; padding: 12px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 4px; background: rgba(var(--v-theme-on-surface), .04); }
.secret-value code { min-width: 0; overflow-wrap: anywhere; flex: 1; }
.delete-preview { list-style: none; padding: 0; margin: 0; border: 1px solid rgba(var(--v-border-color), .15); border-radius: 6px; overflow: hidden; }
.delete-preview li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; font-size: 12px; }
.delete-preview li + li { border-top: 1px solid rgba(var(--v-border-color), .1); }
.delete-preview strong { min-width: 0; overflow-wrap: anywhere; font-weight: 500; }
.delete-preview code { flex-shrink: 0; color: rgba(var(--v-theme-on-surface), .55); }
.detail-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 18px 20px !important; white-space: normal; }
.detail-heading > div { min-width: 0; }
.detail-heading h2 { font-size: 18px; line-height: 1.5; overflow-wrap: anywhere; }
.detail-heading code { display: block; margin-top: 3px; font-size: 12px; color: rgba(var(--v-theme-on-surface), .5); }
.detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; font-size: 13px; }
.detail-grid > div { min-width: 0; overflow-wrap: anywhere; }
.detail-grid span { display: block; margin-bottom: 5px; font-size: 11px; color: rgba(var(--v-theme-on-surface), .55); }
.detail-note { padding: 12px; border-radius: 4px; background: rgba(var(--v-theme-on-surface), .04); white-space: pre-wrap; overflow-wrap: anywhere; }
.detail-profile-heading { margin: 22px 0 14px; }
.detail-profile-heading h3 { font-size: 14px; font-weight: 600; }
.detail-profile-heading p { margin-top: 4px; font-size: 12px; color: rgba(var(--v-theme-on-surface), .55); }
.detail-profile-picker { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
.detail-profile-picker .v-input { min-width: 0; }
@media (max-width: 960px) { .request-total { display: none; } .keys-toolbar > .key-search { flex-basis: 100%; } .keys-toolbar > .scope-filter, .keys-toolbar > .sort-filter { flex: 1; } .selection-summary > span { display: none; } .selection-summary > .text-warning { display: inline; } }
@media (max-width: 600px) { .keys-view { gap: 14px; } .keys-heading h1 { font-size: 19px; } .keys-heading p { font-size: 12px; } .keys-heading-actions { margin-left: auto; } .keys-status-tabs { padding: 0; } .keys-status-tabs :deep(.v-tab) { padding-inline: 12px; } .keys-toolbar { gap: 8px; padding: 12px; } .keys-bulk-bar { padding-inline: 12px; } .bulk-actions :deep(.v-btn__prepend) { display: none; } .keys-pagination { padding: 10px 12px; gap: 8px; } .keys-pagination .v-pagination { width: 100%; } .keys-pagination .page-size { margin-left: auto; } .detail-grid { grid-template-columns: minmax(0, 1fr); } .detail-profile-picker { align-items: stretch; flex-direction: column; } .delete-preview li { align-items: flex-start; flex-direction: column; gap: 4px; } }
</style>
