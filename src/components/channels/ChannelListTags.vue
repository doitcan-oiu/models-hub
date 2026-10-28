<script setup lang="ts">
withDefaults(defineProps<{ name: string; tags: string[]; selected?: string[] }>(), { selected: () => [] });
const emit = defineEmits<{ filter: [tag: string] }>();
</script>
<template>
  <div class="channel-list-tags">
    <span v-if="!tags.length" class="untagged-label">未分组</span>
    <v-chip v-for="tag in tags.slice(0, 2)" :key="tag" role="button" size="small" color="primary" :variant="selected.includes(tag) ? 'flat' : 'tonal'" :title="`筛选标签：${tag}`" :aria-label="`筛选标签 ${tag}`" :aria-pressed="selected.includes(tag)" @click="emit('filter', tag)"><span>{{ tag }}</span></v-chip>
    <v-menu v-if="tags.length > 2"><template #activator="{ props }"><v-btn v-bind="props" size="x-small" variant="text" class="more-tags" :aria-label="`查看 ${name} 的全部 ${tags.length} 个标签`">+{{ tags.length - 2 }} 个标签</v-btn></template><v-card border class="tag-popover"><v-card-text><p>全部标签 · {{ tags.length }}</p><div class="all-tags"><v-chip v-for="tag in tags" :key="tag" role="button" size="small" color="primary" :variant="selected.includes(tag) ? 'flat' : 'tonal'" :aria-label="`筛选标签 ${tag}`" :aria-pressed="selected.includes(tag)" @click="emit('filter', tag)">{{ tag }}</v-chip></div></v-card-text></v-card></v-menu>
  </div>
</template>
<style scoped>
.channel-list-tags { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 6px; min-width: 0; }
.channel-list-tags > .v-chip { max-width: 100%; height: auto; min-height: 24px; padding-block: 3px; border-radius: 5px; font-size: 12px; }
.channel-list-tags > .v-chip :deep(.v-chip__content) { white-space: normal; min-width: 0; }
.channel-list-tags > .v-chip span { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
.untagged-label { color: rgba(var(--v-theme-on-surface), .4); font-size: 12px; padding-top: 2px; }
.more-tags { padding-inline: 4px; color: rgba(var(--v-theme-on-surface), .6); }
.tag-popover { width: 360px; max-width: calc(100vw - 32px); }
.tag-popover p { font-size: 12px; color: rgba(var(--v-theme-on-surface), .6); }
.all-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; max-height: 300px; overflow-y: auto; }
.all-tags .v-chip { max-width: 100%; height: auto; min-height: 24px; padding-block: 4px; }
.all-tags :deep(.v-chip__content) { white-space: normal; overflow-wrap: anywhere; }
</style>
