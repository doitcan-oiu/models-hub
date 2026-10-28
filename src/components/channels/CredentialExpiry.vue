<script setup lang="ts">
import { computed } from 'vue';
import type { GatewayBalance } from '../../../shared/types';
import { credentialExpired } from '../../../shared/credential-policy';
import { dateTime } from '../../format';
import { credentialExpiryText } from './credential-list';
const props = defineProps<{ balance?: GatewayBalance; now?: number }>();
const validExpiry = computed(() => Number.isFinite(Date.parse(props.balance?.expiresAt ?? '')));
</script>
<template>
  <div class="credential-expiry" :class="{ 'text-warning': credentialExpired(balance, now) }">
    <span v-if="validExpiry" class="expiry-date">{{ dateTime(balance!.expiresAt!) }}</span>
    <span :class="validExpiry ? 'text-caption' : 'text-caption text-medium-emphasis'">{{ credentialExpiryText(balance, now) }}</span>
  </div>
</template>
<style scoped>
.credential-expiry { display: flex; flex-direction: column; gap: 3px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.expiry-date { font-size: 12px; }
</style>
