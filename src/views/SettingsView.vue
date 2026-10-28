<script setup lang="ts">
import { computed, ref } from 'vue';
import { useConsole } from '../composables/useConsole';
import ConnectionSettings from '../components/settings/ConnectionSettings.vue';
import RoutingSettings from '../components/settings/RoutingSettings.vue';
const { settingsTab, navigate } = useConsole();
const connectionSection = ref<'gateway' | 'data' | 'runtime'>('gateway');
const routingSection = ref<'routing' | 'retry' | 'health' | 'disable'>('routing');
const selected = computed(() => settingsTab.value === 'routing' ? routingSection.value : connectionSection.value);
const connectionItems = [{ id: 'gateway', title: '网关接入', icon: 'mdi-cloud-outline' }, { id: 'data', title: '数据与通知', icon: 'mdi-database-outline' }, { id: 'runtime', title: '接入地址与运行', icon: 'mdi-console-network-outline' }] as const;
const routingItems = [{ id: 'routing', title: '路由分配', icon: 'mdi-routes' }, { id: 'retry', title: '重试与响应', icon: 'mdi-autorenew' }, { id: 'health', title: '健康检查', icon: 'mdi-heart-pulse' }, { id: 'disable', title: '自动禁用', icon: 'mdi-shield-outline' }] as const;
function selectConnection(section: typeof connectionSection.value) { connectionSection.value = section; if (settingsTab.value !== 'connection') navigate('settings', 'connection'); }
function selectRouting(section: typeof routingSection.value) { routingSection.value = section; if (settingsTab.value !== 'routing') navigate('settings', 'routing'); }
</script>

<template>
  <div class="settings-workbench">
    <aside class="settings-navigation"><v-list nav density="compact" bg-color="transparent" aria-label="设置分区"><v-list-subheader>接入与运行</v-list-subheader><v-list-item tag="button" role="button" :tabindex="0" v-for="item in connectionItems" :key="item.id" :title="item.title" :prepend-icon="item.icon" :active="selected === item.id" color="primary" :aria-current="selected === item.id ? 'page' : undefined" @click="selectConnection(item.id)" /><v-divider class="my-2" /><v-list-subheader>调度与健康</v-list-subheader><v-list-item tag="button" role="button" :tabindex="0" v-for="item in routingItems" :key="item.id" :title="item.title" :prepend-icon="item.icon" :active="selected === item.id" color="primary" :aria-current="selected === item.id ? 'page' : undefined" @click="selectRouting(item.id)" /></v-list><p class="text-caption text-medium-emphasis px-4 mt-3">切换分区保留草稿</p></aside>
    <div class="settings-content"><section v-show="settingsTab === 'connection'" aria-label="接入与运行设置"><ConnectionSettings :section="connectionSection" @section="connectionSection = $event" /></section><section v-show="settingsTab === 'routing'" aria-label="调度与健康设置"><RoutingSettings :active-section="routingSection" @section="routingSection = $event" /></section></div>
  </div>
</template>

<style scoped>
.settings-workbench { display: grid; grid-template-columns: 184px minmax(0, 1fr); gap: 16px; align-items: start; min-width: 0; }
.settings-navigation { position: sticky; top: calc(var(--workspace-sticky-top, 110px) + 16px); }
.settings-navigation :deep(.v-list-item) { width: 100%; margin-bottom: 3px; text-align: left; }
.settings-navigation :deep(.v-list-item__prepend > .v-icon) { font-size: 18px; margin-inline-end: 10px; }
.settings-content { min-width: 0; max-width: 1080px; }
@media (max-width: 800px) { .settings-workbench { grid-template-columns: minmax(0, 1fr); gap: 12px; } .settings-navigation { position: static; } .settings-navigation :deep(.v-list) { display: flex; overflow-x: auto; gap: 4px; padding: 0 0 6px; } .settings-navigation :deep(.v-list-item) { flex: 0 0 auto; width: auto; min-height: 40px; } .settings-navigation :deep(.v-list-subheader), .settings-navigation :deep(.v-divider), .settings-navigation > p { display: none; } }
</style>
