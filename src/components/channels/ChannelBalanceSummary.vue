<script setup lang="ts">
import { computed } from 'vue';
import type { GatewayChannel } from '../../../shared/types';
import { channelBalancePresentation } from '../../channel-balance';

const props = withDefaults(defineProps<{ channel: GatewayChannel; busy?: boolean }>(), { busy: false });
defineEmits<{ refresh: []; manageKeys: [] }>();
const summary = computed(() => channelBalancePresentation(props.channel));
</script>

<template>
  <div class="channel-balance" :class="{ 'channel-balance--muted': !summary.monitored }">
    <div class="balance-heading">
      <span class="balance-monitor">{{ summary.monitorLabel }}</span>
      <v-btn v-if="summary.monitored" class="balance-refresh" icon="mdi-refresh" size="x-small" density="compact" variant="text"
        :loading="busy" :disabled="busy || !summary.refreshable" :aria-label="`刷新 ${channel.name} 余额`" :title="summary.refreshTitle" @click="$emit('refresh')" />
    </div>
    <div v-if="summary.hasAmount" class="balance-amount" :class="{ 'balance-amount--cached': summary.state === 'cached-error' }" :title="summary.updatedTitle ? `${summary.state === 'cached-error' ? '缓存余额；' : ''}更新于 ${summary.updatedTitle}` : undefined">
      <span class="balance-number">{{ summary.amount }}</span><span v-if="summary.unit" class="balance-unit">{{ summary.unit }}</span>
      <span v-if="summary.state === 'cached-error'" class="balance-cache">缓存</span>
    </div>
    <div v-else class="balance-empty" :class="{ 'text-warning': summary.state === 'error' }" :title="channel.accountBalance?.error">{{ summary.stateLabel }}</div>
    <div v-if="summary.isKeyPool || !summary.monitored" class="balance-keys">
      <button type="button" class="key-count" :class="{ 'key-count--empty': summary.isKeyPool && summary.availableKeys === 0 && summary.keyCount > 0 }" :aria-label="`管理 ${channel.name} 的 API Key`" title="管理 API Key 池" @click="$emit('manageKeys')">
        <v-icon icon="mdi-key-outline" size="14" />
        <span v-if="summary.isKeyPool">可用 Key <strong>{{ summary.availableKeys ?? '—' }}</strong><span class="key-total"> / {{ summary.keyCount }}</span></span>
        <span v-else>{{ summary.keyCount }} 个 Key</span>
      </button>
      <span v-if="summary.expiredKeys" class="key-issue key-issue--expired">已到期 {{ summary.expiredKeys }}</span>
      <span v-if="summary.exhaustedKeys" class="key-issue key-issue--exhausted">耗尽 {{ summary.exhaustedKeys }}</span>
    </div>
    <div v-if="summary.state !== 'ok' && (summary.updatedText || (summary.hasAmount && summary.stateLabel))" class="balance-update">
      <span v-if="summary.hasAmount && summary.stateLabel" class="balance-state" :class="{ 'text-warning': summary.state === 'cached-error' }" :title="channel.accountBalance?.error">{{ summary.stateLabel }}</span>
      <span v-if="summary.updatedText" :title="summary.updatedTitle">{{ summary.timeLabel }} {{ summary.updatedText }}</span>
    </div>
  </div>
</template>

<style scoped>
.channel-balance { display: flex; flex-direction: column; gap: 2px; min-width: 0; width: 100%; max-width: 260px; }
.balance-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 20px; }
.balance-monitor { font-size: 11px; font-weight: 600; color: rgba(var(--v-theme-on-surface), .64); }
.balance-refresh { flex: 0 0 auto; color: rgba(var(--v-theme-on-surface), .6); }
.balance-amount { display: flex; align-items: baseline; flex-wrap: wrap; gap: 5px; line-height: 1.25; }
.balance-number { min-width: 0; font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -.025em; overflow-wrap: anywhere; }
.balance-unit { font-size: 11px; color: rgba(var(--v-theme-on-surface), .6); }
.balance-cache { font-size: 10px; color: rgb(var(--v-theme-warning)); }
.balance-empty { min-height: 23px; display: flex; align-items: center; font-size: 13px; color: rgba(var(--v-theme-on-surface), .55); }
.balance-keys { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; min-width: 0; }
.key-count { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 3px; padding: 0; border: 0; border-radius: 3px; background: transparent; color: rgb(var(--v-theme-primary)); font: inherit; font-size: 11px; line-height: 20px; text-align: left; cursor: pointer; font-variant-numeric: tabular-nums; }
.key-count:hover { text-decoration: underline; }
.key-count:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 2px; }
.key-count strong { font-weight: 700; }
.key-count--empty { color: rgb(var(--v-theme-error)); }
.key-total { color: rgba(var(--v-theme-on-surface), .6); }
.key-issue { border-radius: 4px; padding: 1px 5px; font-size: 10px; line-height: 16px; font-weight: 500; font-variant-numeric: tabular-nums; }
.key-issue--expired { color: rgb(var(--v-theme-warning)); background: rgba(var(--v-theme-warning), .11); }
.key-issue--exhausted { color: rgb(var(--v-theme-error)); background: rgba(var(--v-theme-error), .09); }
.balance-update { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; color: rgba(var(--v-theme-on-surface), .5); font-size: 10px; line-height: 15px; font-variant-numeric: tabular-nums; }
.balance-state { color: rgba(var(--v-theme-on-surface), .65); }
.channel-balance--muted .balance-monitor { color: rgba(var(--v-theme-on-surface), .45); }
</style>
