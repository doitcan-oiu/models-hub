<script setup lang="ts">
import type { GatewayChannel } from '../../../shared/types';
defineProps<{ channel: GatewayChannel; busy: boolean; items: { panel: string; title: string; icon: string }[] }>();
const emit = defineEmits<{ edit: []; test: []; action: [panel: string] }>();
</script>
<template>
  <div class="channel-row-actions">
    <v-btn icon="mdi-pencil-outline" variant="text" size="small" :disabled="busy" :aria-label="`编辑 ${channel.name}`" title="编辑渠道" @click="emit('edit')" />
    <v-btn icon="mdi-play-outline" variant="text" size="small" :disabled="busy" :aria-label="`测试 ${channel.name}`" title="发起测试" @click="emit('test')" />
    <v-menu><template #activator="{ props }"><v-btn v-bind="props" icon="mdi-dots-vertical" variant="text" size="small" :disabled="busy" :aria-label="`${channel.name} 更多操作`" /></template><v-list density="compact"><v-list-item v-for="item in items" :key="item.panel" :title="item.panel === 'archive' ? channel.archived ? '恢复渠道' : '归档渠道' : item.title" :prepend-icon="item.icon" :base-color="item.panel === 'delete' ? 'error' : undefined" @click="emit('action', item.panel)" /></v-list></v-menu>
  </div>
</template>
<style scoped>
.channel-row-actions { display: flex; justify-content: flex-end; gap: 1px; }
</style>
