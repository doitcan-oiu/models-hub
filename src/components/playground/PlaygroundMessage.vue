<script setup lang="ts">
import { ref, watch } from 'vue';
import type { PlaygroundMessage } from '../../composables/usePlayground';
import { resultColor } from '../../format';

const props = defineProps<{ message: PlaygroundMessage; running: boolean }>();
const emit = defineEmits<{ copy: [text: string]; resend: [id: string] }>();
const panels = ref<string[]>([]);
const knownTools = new Set<string>();
watch(() => props.message.tools?.map(tool => tool.id) ?? [], ids => {
  for (const id of ids) if (!knownTools.has(id)) { knownTools.add(id); panels.value.push(`tool-${id}`); }
}, { immediate: true });
const resultNames: Record<string, string> = { success: '成功', slow: '响应缓慢', failover: '渠道切换', error: '失败', empty: '空响应', cancelled: '已取消' };
</script>

<template>
  <article class="play-message" :class="`is-${message.role}`">
    <v-avatar :color="message.role === 'user' ? 'secondary' : 'primary'" variant="tonal" size="26" class="message-avatar">
      <v-icon :icon="message.role === 'user' ? 'mdi-account-outline' : 'mdi-robot-outline'" size="18" />
    </v-avatar>
    <div class="message-main">
      <header class="message-header">
        <strong>{{ message.role === 'user' ? '你' : '模型' }}</strong>
        <span v-if="message.pending" class="message-pending"><v-progress-circular indeterminate size="13" width="2" color="primary" />{{ message.content ? '生成中…' : '等待有效首字…' }}</span>
        <div class="message-actions">
          <v-btn size="x-small" variant="text" icon="mdi-refresh" :aria-label="message.role === 'user' ? '从这条消息重发' : '重新生成此回复'" :title="message.role === 'user' ? '从这条消息重发' : '重新生成'" :disabled="running" @click="emit('resend', message.id)" />
          <v-btn size="x-small" variant="text" icon="mdi-content-copy" aria-label="复制消息" title="复制消息" :disabled="!message.content" @click="emit('copy', message.content)" />
        </div>
      </header>
      <v-img v-if="message.image" :src="message.image" alt="发送的图片" max-width="320" max-height="220" contain class="message-image" />
      <div v-if="message.content" class="message-content">{{ message.content }}</div>
      <v-expansion-panels v-if="message.reasoning || message.tools?.length || message.trace" v-model="panels" multiple variant="accordion" class="message-panels" elevation="0">
        <v-expansion-panel v-if="message.reasoning" value="reasoning" title="思考内容">
          <v-expansion-panel-text><div class="message-content reasoning-content">{{ message.reasoning }}</div></v-expansion-panel-text>
        </v-expansion-panel>
        <v-expansion-panel v-for="tool in message.tools" :key="tool.id" :value="`tool-${tool.id}`" :title="`工具调用 · ${tool.name || tool.id}`">
          <v-expansion-panel-text><pre class="message-code">{{ tool.arguments }}</pre><p class="text-caption text-medium-emphasis mt-2">展示调用内容，测试场不会执行外部工具。</p></v-expansion-panel-text>
        </v-expansion-panel>
        <v-expansion-panel v-if="message.trace" value="trace">
          <template #title><span class="trace-title"><v-icon icon="mdi-transit-connection-variant" size="16" color="primary" /><span class="trace-description">{{ message.trace.log.attempts > 1 ? '渠道切换 / 重试' : '请求追踪' }}<small>HTTP {{ message.trace.log.status }} · {{ message.trace.log.attempts }} 次尝试</small></span><v-chip :color="resultColor(message.trace.log.result)" size="x-small" variant="tonal">{{ resultNames[message.trace.log.result] || message.trace.log.result }}</v-chip></span></template>
          <v-expansion-panel-text>
            <div class="trace-metrics"><span>首字 {{ message.trace.log.ttft.toFixed(2) }} s</span><span>完成 {{ message.trace.log.duration.toFixed(2) }} s</span><span>{{ message.trace.log.model }}</span></div>
            <div v-for="attempt in message.trace.attempts" :key="attempt.id" class="trace-attempt">
              <span class="trace-index">#{{ attempt.attempt }}</span>
              <div><strong>{{ attempt.channelName }}</strong><p>{{ attempt.model }} · HTTP {{ attempt.status }} · {{ resultNames[attempt.result] || attempt.result }}</p><p v-if="attempt.error" class="text-error">{{ attempt.error }}</p></div>
              <div class="trace-time"><span>{{ attempt.ttft == null ? '无有效首字' : `${attempt.ttft.toFixed(2)} s 首字` }}</span><span>{{ attempt.duration.toFixed(2) }} s 完成</span></div>
            </div>
            <p v-if="!message.trace.attempts.length" class="text-caption text-medium-emphasis">此请求尚未到达上游。</p>
            <div v-if="message.requestId" class="trace-request-id"><code>{{ message.requestId }}</code><v-btn size="x-small" icon="mdi-content-copy" variant="text" aria-label="复制请求 ID" @click="emit('copy', message.requestId!)" /></div>
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>
      <v-alert v-if="message.error" type="error" variant="tonal" density="compact" class="mt-3" :text="message.error" />
      <div v-if="message.usage || (message.requestId && !message.trace)" class="message-footer">
        <span v-if="message.usage">输入 {{ message.usage.input.toLocaleString('zh-CN') }} · 输出 {{ message.usage.output.toLocaleString('zh-CN') }} Tokens</span>
        <button v-if="message.requestId && !message.trace" type="button" class="request-id-button" title="复制请求 ID" @click="emit('copy', message.requestId)">请求 {{ message.requestId }}</button>
      </div>
    </div>
  </article>
</template>

<style scoped>
.play-message { display: flex; align-items: flex-start; gap: 10px; padding: 16px 20px; }
.is-user { justify-content: flex-end; padding-bottom: 8px; }
.is-user .message-avatar { order: 2; margin-top: 12px; }
.is-user .message-main { flex: 0 1 86%; padding: 10px 14px 12px; border-radius: 4px; border: 1px solid rgba(var(--v-theme-primary), .16); background: rgba(var(--v-theme-primary), .09); }
.is-assistant { padding-top: 16px; padding-bottom: 20px; }
.message-avatar { flex-shrink: 0; margin-top: 2px; }
.message-main { flex: 1; min-width: 0; }
.message-header { display: flex; align-items: center; gap: 8px; min-height: 28px; margin-bottom: 6px; }
.message-header > strong { font-size: 13px; font-weight: 600; }
.is-assistant .message-header > strong { color: rgb(var(--v-theme-primary)); }
.message-actions { display: flex; align-items: center; gap: 2px; margin-left: auto; }
.message-pending { display: inline-flex; align-items: center; gap: 6px; color: rgba(var(--v-theme-on-surface), .7); font-size: 12px; }
.message-content { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.9; }
.message-image { margin: 4px 0 12px; border-radius: 4px; }
.message-panels { margin-top: 12px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-left: 2px solid rgba(var(--v-theme-primary), .45); border-radius: 4px; overflow: hidden; }
.message-panels :deep(.v-expansion-panel-title) { min-height: 36px; padding: 8px 12px; font-size: 12px; }
.message-panels :deep(.v-expansion-panel-title--active) { min-height: 36px; }
.message-panels :deep(.v-expansion-panel-text__wrapper) { padding: 4px 12px 12px; }
.message-panels :deep(.v-expansion-panel__shadow) { display: none; }
.reasoning-content { color: rgba(var(--v-theme-on-surface), .7); font-size: 13px; padding-block: 4px; }
.message-code { white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 4px; background: rgb(var(--v-theme-background)); font: 12px/1.8 ui-monospace, SFMono-Regular, Consolas, monospace; }
.message-footer { display: flex; flex-wrap: wrap; gap: 8px 14px; margin-top: 12px; color: rgba(var(--v-theme-on-surface), .6); font-size: 12px; }
.request-id-button { text-align: left; overflow-wrap: anywhere; border-radius: 4px; }
.request-id-button:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 4px; }
.trace-title { display: flex; align-items: center; gap: 10px; width: 100%; line-height: 1.6; padding-right: 6px; }
.trace-title > .v-icon { flex-shrink: 0; }
.trace-description { flex: 1; }
.trace-title small { display: block; color: rgba(var(--v-theme-on-surface), .6); font-size: 12px; margin-top: 2px; }
.trace-title > .v-chip { flex-shrink: 0; }
.trace-metrics { display: flex; flex-wrap: wrap; gap: 8px 12px; color: rgba(var(--v-theme-on-surface), .7); font-size: 12px; margin-bottom: 12px; padding: 10px; background: rgba(var(--v-theme-primary), .07); border-radius: 4px; font-variant-numeric: tabular-nums; }
.trace-attempt { display: flex; align-items: flex-start; gap: 10px; padding-block: 10px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); font-size: 12px; }
.trace-attempt > div:nth-child(2) { flex: 1; min-width: 0; }
.trace-attempt strong { font-weight: 550; font-size: 13px; }
.trace-attempt p { margin: 4px 0 0; color: rgba(var(--v-theme-on-surface), .65); overflow-wrap: anywhere; line-height: 1.7; }
.trace-index { display: grid; place-items: center; width: 25px; height: 25px; flex-shrink: 0; border-radius: 4px; background: rgba(var(--v-theme-primary), .13); color: rgb(var(--v-theme-primary)); font-variant-numeric: tabular-nums; font-size: 12px; }
.trace-time { display: grid; gap: 4px; text-align: right; flex-shrink: 0; color: rgba(var(--v-theme-on-surface), .7); font-variant-numeric: tabular-nums; line-height: 1.7; }
.trace-request-id { display: flex; align-items: center; gap: 8px; padding-top: 8px; color: rgba(var(--v-theme-on-surface), .6); font-size: 12px; }
.trace-request-id code { min-width: 0; overflow-wrap: anywhere; }
@media (max-width: 600px) { .play-message { padding: 18px 16px; gap: 9px; } .is-user { padding-bottom: 5px; } .is-user .message-main { flex-basis: 90%; padding: 10px 13px 14px; } .is-user .message-avatar { display: none; } .message-avatar { width: 28px !important; height: 28px !important; } .message-pending { font-size: 12px; gap: 4px; } .message-header { flex-wrap: wrap; gap: 4px 8px; } .message-panels :deep(.v-expansion-panel-title) { padding-inline: 10px; } .message-panels :deep(.v-expansion-panel-text__wrapper) { padding-inline: 12px; } .trace-title { gap: 7px; flex-wrap: wrap; } .trace-title > .v-chip { margin-left: 24px; } .trace-attempt { flex-wrap: wrap; gap: 9px; } .trace-time { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-left: 34px; text-align: left; } }
</style>
