<script setup lang="ts">
import type { GatewayBalance } from '../../../shared/types';
import { balanceAmount } from '../../channel-balance';
import { dateTime } from '../../format';
import CredentialExpiry from './CredentialExpiry.vue';
withDefaults(defineProps<{ balance?: GatewayBalance; compact?: boolean; showExpiry?: boolean }>(), { compact: false, showExpiry: true });
</script>
<template>
  <div class="credential-balance" :class="{ 'credential-balance--compact': compact }">
    <span class="text-body-2" :title="balance?.updatedAt ? `更新于 ${dateTime(balance.updatedAt)}` : undefined">{{ compact ? '' : '余额 ' }}{{ balanceAmount(balance) }}</span>
    <span v-if="balance?.updatedAt && !compact" class="text-caption text-medium-emphasis">更新于 {{ dateTime(balance.updatedAt) }}</span>
    <span v-if="balance?.status === 'error'" class="text-caption text-warning text-break" :title="balance.error">{{ compact ? '更新失败' : balance.error || '余额查询失败' }}<template v-if="balance.checkedAt && !compact"> · 检查于 {{ dateTime(balance.checkedAt) }}</template></span>
    <CredentialExpiry v-if="showExpiry" :balance="balance" />
  </div>
</template>
<style scoped>
.credential-balance { display: flex; flex-direction: column; gap: 3px; min-width: 120px; font-variant-numeric: tabular-nums; }
.credential-balance--compact { min-width: 80px; white-space: nowrap; }
</style>
