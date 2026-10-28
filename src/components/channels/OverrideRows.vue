<script setup lang="ts">
import type { OverrideRow } from './channel-utils';
const props = defineProps<{ modelValue: OverrideRow[]; headers?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: OverrideRow[]] }>();
function add() { emit('update:modelValue', [...props.modelValue, { id: crypto.randomUUID(), key: '', type: 'string', value: '' }]); }
function update(index: number, key: 'key' | 'value' | 'type', value: string) { emit('update:modelValue', props.modelValue.map((row, i) => i === index ? { ...row, [key]: value } as OverrideRow : row)); }
</script>
<template>
  <section class="override-section">
    <div class="d-flex align-center mb-3"><h3 class="text-subtitle-1">{{ headers ? '自定义请求头' : '请求参数覆盖' }}</h3><v-spacer /><v-btn variant="tonal" size="small" prepend-icon="mdi-plus" @click="add">添加</v-btn></div>
    <v-table v-if="modelValue.length" class="override-table" :class="{ 'has-types': !headers }">
      <thead><tr><th>{{ headers ? '请求头名称' : '参数名称' }}</th><th v-if="!headers">类型</th><th>值</th><th /></tr></thead>
      <tbody><tr v-for="(row, index) in modelValue" :key="row.id">
        <td><v-text-field :model-value="row.key" :aria-label="headers ? '请求头名称' : '参数名称'" density="compact" hide-details @update:model-value="update(index, 'key', $event)" /></td>
        <td v-if="!headers" class="type-cell"><v-select :model-value="row.type" :items="['string', 'number', 'boolean', 'json', 'null']" aria-label="参数类型" density="compact" hide-details @update:model-value="update(index, 'type', $event)" /></td>
        <td><v-select v-if="row.type === 'boolean' && !headers" :model-value="row.value" :items="['true', 'false']" aria-label="参数值" density="compact" hide-details @update:model-value="update(index, 'value', $event)" /><v-textarea v-else-if="row.type === 'json' && !headers" :model-value="row.value" aria-label="JSON 参数值" rows="2" density="compact" hide-details @update:model-value="update(index, 'value', $event)" /><v-text-field v-else :model-value="row.type === 'null' ? 'null' : row.value" :disabled="row.type === 'null'" aria-label="参数值" density="compact" hide-details @update:model-value="update(index, 'value', $event)" /></td>
        <td class="remove-cell"><v-btn icon="mdi-delete-outline" variant="text" size="small" color="error" aria-label="删除参数" @click="emit('update:modelValue', modelValue.filter((_, i) => i !== index))" /></td>
      </tr></tbody>
    </v-table>
    <div v-else class="override-empty"><v-icon size="18">{{ headers ? 'mdi-code-braces' : 'mdi-code-json' }}</v-icon><span>未配置{{ headers ? '自定义请求头' : '覆盖参数' }}</span></div>
  </section>
</template>
<style scoped>
.override-table { border: 1px solid rgba(var(--v-theme-on-surface), .12); border-radius: 4px; }
.override-table :deep(table) { min-width: 490px; }
.override-table.has-types :deep(table) { min-width: 650px; }
.override-table th { background: rgba(var(--v-theme-on-surface), .035); white-space: nowrap; }
.override-table td { padding: 8px 10px; vertical-align: top; }
.type-cell { width: 155px; }
.remove-cell { width: 48px; }
.override-empty { display: flex; align-items: center; gap: 8px; padding: 16px 12px; color: rgba(var(--v-theme-on-surface), .45); background: rgba(var(--v-theme-on-surface), .025); border: 1px dashed rgba(var(--v-theme-on-surface), .14); border-radius: 4px; font-size: 13px; }
</style>
