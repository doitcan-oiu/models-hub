<script setup lang="ts">
import type { ChannelConfig } from '../../../shared/types';
const model = defineModel<ChannelConfig['cooldown']>({ required: true });
</script>

<template>
  <div class="cooldown-settings">
    <v-switch v-model="model.firstToken" color="primary" label="首字健康检查冷却" hide-details />
    <p class="text-caption text-medium-emphasis">关闭后，SSE 流式首字延迟超标不会触发渠道降级冷却；非流式响应耗时判定仍然生效。</p>
    <v-switch v-model="model.error" color="primary" label="错误冷却" hide-details class="mt-4" />
    <p class="text-caption text-medium-emphasis">关闭后，请求失败不会触发失败率冷却，也不会按全局或当前渠道的 HTTP 错误规则自动停用渠道、密钥。</p>
    <p class="text-caption text-medium-emphasis mt-4">关闭并保存后，立即解除对应的已有冷却；关闭错误冷却还会恢复因错误自动停用的密钥。请求日志、超时和重试继续生效，手动停用与归档状态保留。以上设置仅作用于当前渠道。</p>
  </div>
</template>
