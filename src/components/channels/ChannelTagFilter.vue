<script setup lang="ts">
import { computed, h, ref, useId, watch } from 'vue';
import type { VNode } from 'vue';
import { VBtn, VIcon } from 'vuetify/components';
import type { GatewayChannel } from '../../../shared/types';

const props = defineProps<{ tags: string[]; channels: GatewayChannel[]; selected: string[]; untagged: boolean }>();
const emit = defineEmits<{ 'update:selected': [value: string[]]; 'update:untagged': [value: boolean]; manage: [] }>();
type TagNode = { path: string; label: string; children: TagNode[] };
const treeId = useId();
const query = ref('');
const search = computed(() => (query.value ?? '').trim().toLocaleLowerCase());
const collapsed = ref(new Set<string>());
const selectedPaths = computed(() => new Set(props.untagged ? [] : props.selected));
const scopedChannels = computed(() => [...new Map(props.channels.map(channel => [channel.id, channel])).values()]);
const untaggedCount = computed(() => scopedChannels.value.filter(channel => !channel.tags.length).length);

const tree = computed(() => {
  const roots: TagNode[] = [];
  const byPath = new Map<string, TagNode>();
  for (const tag of new Set(props.tags.filter(value => value.trim()))) {
    const pieces = tag.split('/');
    // Invalid separators belong to the original tag ID, not virtual empty groups.
    const segments = pieces.every(piece => piece.trim()) ? pieces : [tag];
    let siblings = roots;
    for (let depth = 0; depth < segments.length; depth++) {
      const path = segments.slice(0, depth + 1).join('/');
      let node = byPath.get(path);
      if (!node) {
        node = { path, label: segments[depth]!, children: [] };
        siblings.push(node);
        byPath.set(path, node);
      }
      siblings = node.children;
    }
  }
  const sort = (nodes: TagNode[]) => {
    nodes.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN', { numeric: true }));
    nodes.forEach(node => sort(node.children));
  };
  sort(roots);
  return roots;
});

function walk(nodes: TagNode[], visit: (node: TagNode, ancestors: string[]) => void, ancestors: string[] = []) {
  nodes.forEach(node => { visit(node, ancestors); walk(node.children, visit, [...ancestors, node.path]); });
}
const ancestorsByPath = computed(() => {
  const paths = new Map<string, string[]>();
  walk(tree.value, (node, ancestors) => paths.set(node.path, ancestors));
  return paths;
});
const counts = computed(() => {
  const result = new Map<string, number>();
  for (const channel of scopedChannels.value) {
    const matches = new Set<string>();
    for (const tag of channel.tags) {
      matches.add(tag);
      for (let index = tag.indexOf('/'); index >= 0; index = tag.indexOf('/', index + 1)) matches.add(tag.slice(0, index));
    }
    for (const path of matches) if (ancestorsByPath.value.has(path)) result.set(path, (result.get(path) ?? 0) + 1);
  }
  return result;
});
function matchingTree(nodes: TagNode[], text: string): TagNode[] {
  if (!text) return nodes;
  return nodes.flatMap(node => {
    const children = matchingTree(node.children, text);
    return node.path.toLocaleLowerCase().includes(text) || children.length ? [{ ...node, children }] : [];
  });
}
const visible = computed(() => matchingTree(tree.value, search.value));
const selectedAncestors = computed(() => {
  const paths = new Set<string>();
  for (const selected of selectedPaths.value) for (const ancestor of ancestorsByPath.value.get(selected) ?? []) paths.add(ancestor);
  return paths;
});
watch([() => JSON.stringify(props.selected), ancestorsByPath], () => {
  const next = new Set(collapsed.value);
  for (const selected of props.selected) for (const ancestor of ancestorsByPath.value.get(selected) ?? []) next.delete(ancestor);
  if (next.size !== collapsed.value.size) collapsed.value = next;
}, { immediate: true });
watch([search, tree], () => {
  if (!search.value) return;
  const next = new Set(collapsed.value);
  walk(visible.value, node => next.delete(node.path));
  if (next.size !== collapsed.value.size) collapsed.value = next;
});

function clear(untagged = false) { emit('update:selected', []); emit('update:untagged', untagged); }
function toggle(path: string) {
  emit('update:untagged', false);
  emit('update:selected', props.selected.includes(path) ? props.selected.filter(tag => tag !== path) : [...props.selected, path]);
}
function collapse(path: string) {
  const next = new Set(collapsed.value);
  if (next.has(path)) next.delete(path); else next.add(path);
  collapsed.value = next;
}
function renderNodes(nodes: TagNode[], depth = 0): VNode {
  return h('ul', { class: 'tag-node-list' }, nodes.map(node => {
    const expanded = !collapsed.value.has(node.path);
    const active = selectedPaths.value.has(node.path);
    const selectedBelow = selectedAncestors.value.has(node.path);
    const groupId = `${treeId}-${encodeURIComponent(node.path)}`;
    return h('li', { key: node.path }, [
      h('div', { class: ['tag-node-row', { 'tag-node-row--contains-selection': selectedBelow && !expanded }], style: { paddingInlineStart: `${Math.min(depth, 5) * 12}px` } }, [
        node.children.length ? h(VBtn, {
          type: 'button', variant: 'text', size: 'x-small', icon: expanded ? 'mdi-chevron-down' : 'mdi-chevron-right',
          class: 'tag-node-expander', 'aria-label': `${expanded ? '收起' : '展开'} ${node.path}`,
          'aria-expanded': expanded, 'aria-controls': groupId, onClick: () => collapse(node.path),
        }) : h('span', { class: 'tag-node-marker', 'aria-hidden': 'true' }, [h(VIcon, { size: 15, icon: 'mdi-tag-outline' })]),
        h(VBtn, {
          type: 'button', variant: active ? 'tonal' : 'text', color: active ? 'primary' : undefined,
          size: 'small', class: 'tag-node-select', 'aria-pressed': active,
          'aria-label': `筛选「${node.path}」及其下级标签`, title: `筛选「${node.path}」及其下级标签`, onClick: () => toggle(node.path),
        }, { default: () => [
          h('span', { class: 'tag-node-name' }, node.label),
          selectedBelow && !expanded ? h(VIcon, { size: 14, color: 'primary', icon: 'mdi-check-circle-outline', title: '含已选下级标签', 'aria-label': '含已选下级标签', 'aria-hidden': false }) : null,
          h('span', { class: 'tag-node-count' }, (counts.value.get(node.path) ?? 0).toLocaleString('zh-CN')),
        ] }),
      ]),
      node.children.length ? h('div', { id: groupId, hidden: !expanded }, expanded ? [renderNodes(node.children, depth + 1)] : []) : null,
    ]);
  }));
}
function TagBranches() { return renderNodes(visible.value); }
</script>

<template>
  <v-card width="100%" border class="channel-tag-tree">
    <v-card-title class="tag-tree-heading"><h2 :id="`${treeId}-heading`">渠道标签</h2><v-spacer /><v-btn icon="mdi-cog-outline" size="small" variant="text" aria-label="管理渠道标签" title="管理标签" @click="emit('manage')" /></v-card-title>
    <v-divider />
    <v-card-text class="tag-tree-content">
      <div class="tag-shortcuts">
        <v-btn :variant="!selected.length && !untagged ? 'tonal' : 'text'" :color="!selected.length && !untagged ? 'primary' : undefined" :aria-pressed="!selected.length && !untagged" size="small" @click="clear()"><v-icon start size="small">mdi-layers-outline</v-icon><span>全部渠道</span><span class="tag-shortcut-count">{{ scopedChannels.length }}</span></v-btn>
        <v-btn :variant="untagged ? 'tonal' : 'text'" :color="untagged ? 'primary' : undefined" :aria-pressed="untagged" size="small" @click="clear(true)"><v-icon start size="small">mdi-folder-outline</v-icon><span>未分组</span><span class="tag-shortcut-count">{{ untaggedCount }}</span></v-btn>
      </div>
      <v-text-field v-model="query" placeholder="搜索标签" aria-label="搜索渠道标签" prepend-inner-icon="mdi-magnify" variant="solo-filled" flat density="compact" hide-details clearable class="my-2" />
      <div v-if="selected.length && !untagged" class="tag-current-selection" aria-live="polite"><span :title="selected.join('、')">{{ selected.length === 1 ? selected[0] : `已选 ${selected.length} 个标签` }}</span><v-btn icon="mdi-close" variant="text" size="x-small" aria-label="清除当前标签筛选" @click="clear()" /></div>
      <div class="tag-branches" aria-label="标签层级列表">
        <TagBranches v-if="visible.length" />
        <div v-else class="tag-empty"><p>{{ search ? '没有匹配的标签' : '还没有标签' }}</p><v-btn variant="text" color="primary" size="small" @click="search ? query = '' : emit('manage')">{{ search ? '清除搜索' : '创建标签' }}</v-btn></div>
      </div>
      <p class="tag-tree-hint">可多选，匹配任一标签及其下级。</p>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.channel-tag-tree { min-width: 0; }
.tag-tree-heading { display: flex; align-items: center; padding: 8px 10px; }
.tag-tree-heading h2 { font-size: 14px; font-weight: 600; }
.tag-tree-content { padding: 10px; }
.tag-shortcuts { display: grid; gap: 4px; }
.tag-shortcuts > .v-btn { width: 100%; justify-content: flex-start; padding-inline: 8px; }
.tag-shortcuts :deep(.v-btn__content) { width: 100%; }
.tag-shortcut-count { margin-left: auto; font-size: 12px; opacity: .65; font-variant-numeric: tabular-nums; }
.tag-current-selection { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; padding-left: 8px; color: rgb(var(--v-theme-primary)); font-size: 12px; }
.tag-current-selection > span { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.tag-branches { min-height: 80px; max-height: clamp(120px, calc(100dvh - 340px), 640px); overflow-y: auto; overscroll-behavior: contain; }
.channel-tag-tree :deep(.tag-node-list) { list-style: none; padding: 0; margin: 0; }
.channel-tag-tree :deep(.tag-node-row) { display: grid; grid-template-columns: 28px minmax(0, 1fr); align-items: center; gap: 2px; margin-bottom: 2px; }
.channel-tag-tree :deep(.tag-node-row--contains-selection) { background: rgba(var(--v-theme-on-surface), .035); }
.channel-tag-tree :deep(.tag-node-marker) { display: flex; justify-content: center; color: rgba(var(--v-theme-on-surface), .45); }
.channel-tag-tree :deep(.tag-node-expander) { width: 28px; height: 28px; }
.channel-tag-tree :deep(.tag-node-select) { min-width: 0; padding-inline: 8px; }
.channel-tag-tree :deep(.tag-node-select .v-btn__content) { min-width: 0; width: 100%; justify-content: flex-start; gap: 6px; }
.channel-tag-tree :deep(.tag-node-name) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.channel-tag-tree :deep(.tag-node-count) { margin-left: auto; font-size: 12px; opacity: .6; font-variant-numeric: tabular-nums; }
.tag-empty { padding: 16px 8px; text-align: center; color: rgba(var(--v-theme-on-surface), .6); font-size: 13px; }
.tag-empty > p { margin-bottom: 8px; }
.tag-tree-hint { margin-top: 8px; color: rgba(var(--v-theme-on-surface), .5); font-size: 12px; line-height: 1.6; }
@media (max-width: 959px) { .tag-branches { max-height: min(400px, calc(100dvh - 300px)); min-height: 80px; } }
</style>
