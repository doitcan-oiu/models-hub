<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useDisplay } from 'vuetify';
import AppDialog from '../components/AppDialog.vue';
import PlaygroundMessage from '../components/playground/PlaygroundMessage.vue';
import { scenarioItems, usePlayground } from '../composables/usePlayground';
import { useConsole } from '../composables/useConsole';

const { state, activeChannels, activeKeys, channel, key, models, devMode, latestTrace, canSend, curl, messageList,
  send, stop, retry, resend, resetConversation, trackScroll, attach, installFixtures, saveScenario, changeScenario,
  importCurl, downloadConversation, copy } = usePlayground();
const { refresh, loading: refreshing } = useConsole();
const imageInput = ref<HTMLInputElement | null>(null);
const { smAndDown } = useDisplay();
const configOpen = ref(!smAndDown.value);
watch(smAndDown, compact => { if (compact) configOpen.value = false; });
const connectionName = computed(() => state.mode === 'channel' ? channel.value?.name : key.value?.name);
const userCount = computed(() => state.messages.filter(message => message.role === 'user').length);
const mockChannels = computed(() => activeChannels.value.filter(item => item.config.protocol === 'mock'));
const modeItems = [{ title: '网关路由', value: 'gateway' }, { title: '渠道直测', value: 'channel' }];
const keyProfile = computed(() => key.value?.profiles.find(profile => profile.id === key.value?.activeProfile)?.name);
function onImage(event: Event) { const input = event.target as HTMLInputElement; attach(input.files?.[0]); input.value = ''; }
function setMessageList(node: unknown) { messageList.value = node instanceof HTMLElement ? node : null; }
function onMessageKey(event: KeyboardEvent) { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); } }
function openCurl(tab: string) { state.curlTab = tab; state.importError = ''; state.curlOpen = true; }
function newConversation() { resetConversation(); }
</script>

<template>
  <div class="playground-workspace" :class="{ 'configuration-closed': !configOpen }">
    <div class="playground-sessionbar"><div class="session-connection"><v-chip :color="state.running ? 'success' : 'primary'" variant="tonal" size="small"><v-icon :icon="state.running ? 'mdi-circle-small' : state.mode === 'gateway' ? 'mdi-source-branch' : 'mdi-connection'" start />{{ state.running ? '正在生成' : state.mode === 'gateway' ? '网关路由' : '渠道直测' }}</v-chip><span class="connection-name">{{ connectionName || '未选择连接' }}</span><v-icon icon="mdi-chevron-right" size="16" /><strong>{{ state.model || '未选择模型' }}</strong></div><div class="session-actions"><v-btn icon="mdi-refresh" variant="text" size="small" :loading="refreshing" aria-label="刷新渠道与凭证" title="刷新渠道与凭证" @click="refresh()" /><v-btn prepend-icon="mdi-tune-variant" :variant="configOpen ? 'tonal' : 'outlined'" :color="configOpen ? 'primary' : undefined" :aria-expanded="configOpen" aria-controls="playground-configuration" @click="configOpen = !configOpen">{{ configOpen ? '收起配置' : '请求配置' }}</v-btn></div></div>
    <v-card v-show="configOpen" id="playground-configuration" class="playground-controls" variant="flat" border>
      <div class="control-section">
        <div class="section-label"><h2>连接与模型</h2><span>REQUEST</span></div>
        <v-select v-model="state.mode" :items="modeItems" label="测试方式" :disabled="state.running || state.fixtureBusy" hide-details density="compact" variant="outlined" />
        <v-select v-if="state.mode === 'channel'" v-model="state.channelId" :items="activeChannels" item-title="name" item-value="id" label="上游渠道" placeholder="选择渠道" :disabled="state.running || state.fixtureBusy" hide-details density="compact" variant="outlined" no-data-text="暂无渠道，请先添加渠道" />
        <v-select v-else v-model="state.keyId" :items="activeKeys" item-title="name" item-value="id" label="网关 API Key" placeholder="选择访问凭证" :disabled="state.running || state.fixtureBusy" hide-details density="compact" variant="outlined" no-data-text="暂无可用 API Key" />
        <v-autocomplete v-model="state.model" :items="models" label="模型" placeholder="选择模型" :disabled="state.running || state.fixtureBusy" hide-details density="compact" variant="outlined" no-data-text="当前连接没有授权模型" auto-select-first />
        <p class="control-note">{{ state.mode === 'gateway' ? `按凭证当前策略授权并自动调度${keyProfile ? ` · ${keyProfile}` : ''}。` : '直接验证选定渠道，不经过网关 Key 的路由策略。' }}</p>
        <v-alert v-if="state.mode === 'channel' && channel && ['anthropic', 'gemini'].includes(channel.config.protocol)" type="warning" variant="tonal" density="compact" class="protocol-note">发送 OpenAI Chat Completions 格式，仅适用于兼容入口；{{ channel.config.protocol === 'anthropic' ? 'Anthropic' : 'Gemini' }} 原生接口请使用对应客户端。</v-alert>
      </div>
      <v-divider />
      <v-expansion-panels :model-value="state.controlsExpanded ? 'parameters' : undefined" variant="accordion" class="parameter-panels" elevation="0" @update:model-value="state.controlsExpanded = $event === 'parameters'">
        <v-expansion-panel value="parameters">
          <v-expansion-panel-title>生成参数</v-expansion-panel-title>
          <v-expansion-panel-text>
            <div class="temperature-heading"><label id="temperature-label">温度</label><span>{{ state.temperature.toFixed(1) }}</span></div>
            <v-slider v-model="state.temperature" :min="0" :max="2" :step="0.1" color="primary" aria-labelledby="temperature-label" :disabled="state.running" hide-details thumb-size="14" />
            <div class="slider-scale"><span>精确 0</span><span>创意 2</span></div>
            <v-text-field v-model.number="state.maxTokens" label="最大输出 Tokens" type="number" :min="1" :max="1000000" :disabled="state.running" density="compact" variant="outlined" hide-details class="mt-5" />
            <v-switch v-model="state.stream" label="流式响应（SSE）" color="primary" :disabled="state.running" hide-details density="compact" class="my-3" />
            <v-textarea v-model="state.system" label="系统提示" :disabled="state.running" rows="3" auto-grow variant="outlined" density="compact" hide-details />
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>
      <template v-if="devMode">
        <v-divider />
        <v-expansion-panels variant="accordion" class="parameter-panels" elevation="0">
          <v-expansion-panel title="本地故障实验">
            <v-expansion-panel-text>
              <p class="control-note mb-4">实验渠道使用相同网关引擎，健康数据和日志均真实保存。</p>
              <v-btn variant="tonal" color="primary" block :loading="state.fixtureBusy" :disabled="state.running" @click="installFixtures">安装 / 重置实验渠道</v-btn>
              <v-select v-if="state.mode === 'gateway' && mockChannels.length" v-model="state.channelId" :items="mockChannels" item-title="name" item-value="id" label="配置实验上游" :disabled="state.running || state.fixtureBusy" density="compact" variant="outlined" hide-details class="mt-5" />
              <template v-if="channel?.config.protocol === 'mock'">
                <v-select :model-value="state.scenario" :items="scenarioItems" label="上游场景" :disabled="state.running || state.fixtureBusy" density="compact" variant="outlined" hide-details class="mt-5" @update:model-value="changeScenario" />
                <v-text-field v-model.number="state.delay" label="首字等待（毫秒）" type="number" :min="0" :max="600000" :disabled="state.running || state.fixtureBusy" density="compact" variant="outlined" hide-details class="mt-4" />
                <v-text-field v-if="state.scenario === 'error' || state.scenario === 'transient'" v-model.number="state.httpStatus" label="HTTP 状态码" type="number" :min="400" :max="599" :disabled="state.running || state.fixtureBusy" density="compact" variant="outlined" hide-details class="mt-4" />
                <v-text-field v-if="state.scenario === 'transient'" v-model.number="state.failures" label="成功前失败次数" type="number" :min="1" :max="100" :disabled="state.running || state.fixtureBusy" density="compact" variant="outlined" hide-details class="mt-4" />
                <v-btn variant="outlined" block class="mt-4" :loading="state.fixtureBusy" :disabled="state.running" @click="saveScenario">保存故障场景</v-btn>
              </template>
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>
      </template>
    </v-card>

    <v-card class="playground-chat" variant="flat" border>
      <header class="chat-heading">
        <div class="chat-title"><v-avatar color="primary" variant="tonal" size="28"><v-icon icon="mdi-message-processing-outline" size="18" /></v-avatar><div><h2>对话工作台</h2><p><span>POST</span> /v1/chat/completions</p></div></div>
        <div class="chat-actions">
          <span v-if="userCount" class="conversation-count">{{ userCount }} 次对话</span>
          <v-btn icon="mdi-refresh" variant="text" size="small" title="重试最后一条" aria-label="重试最后一条" :disabled="state.running || !userCount" @click="retry" />
          <v-btn icon="mdi-chat-plus-outline" variant="text" size="small" title="新会话，保留输入草稿" aria-label="开启新会话" :disabled="state.running || !state.messages.length" @click="newConversation" />
          <v-menu><template #activator="{ props }"><v-btn v-bind="props" icon="mdi-dots-horizontal" variant="text" size="small" aria-label="更多测试操作" /></template><v-list density="compact"><v-list-item prepend-icon="mdi-import" title="导入 cURL / JSON" :disabled="state.running" @click="openCurl('import')" /><v-list-item prepend-icon="mdi-code-json" title="导出网关 cURL" @click="openCurl('export')" /><v-list-item prepend-icon="mdi-download-outline" title="导出对话 JSON" :disabled="!state.messages.length" @click="downloadConversation" /></v-list></v-menu>
        </div>
      </header>
      <div v-if="latestTrace || state.running" class="response-summary" aria-label="最近请求摘要"><div><span>最近请求模型</span><strong :title="latestTrace?.model">{{ latestTrace?.model || '等待响应' }}</strong></div><div><span>首字延迟</span><strong>{{ latestTrace ? `${latestTrace.ttft.toFixed(2)} s` : '—' }}</strong></div><div><span>完整耗时</span><strong>{{ latestTrace ? `${latestTrace.duration.toFixed(2)} s` : '—' }}</strong></div><div><span>路由尝试</span><strong>{{ latestTrace ? `${latestTrace.attempts} 次` : '—' }}</strong></div></div>
      <div :ref="setMessageList" class="playground-messages" role="log" aria-label="测试对话" aria-live="polite" @scroll="trackScroll">
        <div v-if="!state.messages.length" class="chat-welcome"><div class="welcome-mark"><v-icon icon="mdi-creation-outline" size="22" color="primary" /></div><span class="welcome-eyebrow">MODEL PLAYGROUND</span><h3>从一个问题开始</h3><p>选择模型，验证响应。每次请求的首字、用量和路由过程会随对话保留。</p><div class="quick-prompts"><v-btn variant="tonal" color="primary" size="small" prepend-icon="mdi-chat-outline" @click="state.input = '你好，请简短介绍一下你自己。'">简短问答</v-btn><v-btn variant="tonal" size="small" prepend-icon="mdi-lightning-bolt-outline" @click="state.input = '请用三个要点解释 SSE 流式输出。'">流式输出</v-btn></div></div>
        <PlaygroundMessage v-for="message in state.messages" :key="message.id" :message="message" :running="state.running" @copy="copy" @resend="resend" />
      </div>
      <form class="playground-composer" @submit.prevent="send()">
        <v-alert v-if="state.budgetError" type="warning" variant="tonal" density="compact" class="mb-3"><p>{{ state.budgetError }}</p><v-btn v-if="state.messages.length" size="small" variant="text" :disabled="state.running" class="mt-2" @click="newConversation">开启新会话，保留待发内容</v-btn></v-alert>
        <div v-if="state.image" class="draft-image"><v-img :src="state.image" alt="待发送图片" width="46" height="40" contain /><span>图片已附加</span><v-btn icon="mdi-close" variant="text" size="x-small" aria-label="移除图片" :disabled="state.running" @click="state.image = null; state.budgetError = ''" /></div>
        <v-textarea v-model="state.input" label="输入消息" placeholder="Enter 发送，Shift + Enter 换行" :disabled="state.running" rows="2" max-rows="7" auto-grow variant="solo-filled" flat hide-details class="composer-input" @update:model-value="state.budgetError = ''" @keydown="onMessageKey" />
        <div class="composer-actions"><v-btn icon="mdi-image-plus-outline" variant="text" size="small" aria-label="添加图片" title="添加图片，最多 1 MiB" :loading="state.imageBusy" :disabled="state.running" @click="imageInput?.click()" /><input ref="imageInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif" class="visually-hidden" :disabled="state.running" @change="onImage" /><span>图片 ≤ 1 MiB <i /> 请求 ≤ 2 MiB</span><v-btn v-if="state.running" color="error" variant="tonal" prepend-icon="mdi-stop" class="composer-submit" @click="stop">停止生成</v-btn><v-btn v-else type="submit" color="primary" variant="flat" append-icon="mdi-arrow-up" class="composer-submit" :disabled="!canSend">发送</v-btn></div>
      </form>
    </v-card>

    <AppDialog v-model="state.curlOpen" title="cURL 与请求数据" max-width="800">
      <v-tabs v-model="state.curlTab" color="primary" density="compact" class="mb-5"><v-tab value="export">导出 cURL</v-tab><v-tab value="import" :disabled="state.running">导入请求</v-tab></v-tabs>
      <template v-if="state.curlTab === 'export'"><p class="text-body-2 text-medium-emphasis mb-4">使用公开网关接口，不包含密钥原文。将 PULSEGATE_API_KEY 替换为网关密钥；当前会话及输入草稿会纳入导出。</p><pre class="curl-preview">{{ curl }}</pre></template>
      <template v-else><p class="text-body-2 text-medium-emphasis mb-4">粘贴 OpenAI Chat Completions cURL 或 JSON，导入消息和生成参数。继续使用当前选定连接，认证头不会被保存；导入将替换当前会话。</p><v-textarea v-model="state.importText" label="cURL / JSON" variant="outlined" rows="8" hide-details :disabled="state.running" class="curl-input" /><v-alert v-if="state.importError" type="error" variant="tonal" density="compact" :text="state.importError" class="mt-4" /></template>
      <template #actions><v-btn variant="text" @click="state.curlOpen = false">关闭</v-btn><v-btn v-if="state.curlTab === 'export'" color="primary" variant="flat" prepend-icon="mdi-content-copy" @click="copy(curl)">复制 cURL</v-btn><v-btn v-else color="primary" variant="flat" :disabled="state.running || !state.importText.trim()" @click="importCurl">导入请求</v-btn></template>
    </AppDialog>
  </div>
</template>

<style scoped>
.playground-workspace { --playground-height: max(430px, calc(100dvh - 220px)); display: grid; grid-template-columns: minmax(0, 1fr) 278px; gap: 14px 16px; min-width: 0; align-items: start; }
.playground-workspace.configuration-closed { grid-template-columns: minmax(0, 1fr); }
.playground-sessionbar { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 16px; min-width: 0; padding-bottom: 2px; }
.session-connection { display: flex; align-items: center; gap: 10px; min-width: 0; color: rgba(var(--v-theme-on-surface), .65); font-size: 13px; }
.session-connection > .connection-name, .session-connection > strong { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: 240px; }
.session-connection > .v-chip { flex-shrink: 0; }
.session-connection > strong { color: rgb(var(--v-theme-on-surface)); font-weight: 550; }
.session-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.playground-controls { grid-column: 2; grid-row: 2; min-width: 0; max-height: var(--playground-height); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; background: rgb(var(--v-theme-surface)); }
.control-section { display: grid; gap: 14px; padding: 16px; }
.section-label { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
.section-label h2 { font-size: 14px; font-weight: 600; }
.section-label > span { font-size: 12px; letter-spacing: 1.4px; color: rgba(var(--v-theme-on-surface), .45); }
.control-note { font-size: 12px; line-height: 1.8; color: rgba(var(--v-theme-on-surface), .65); margin: 0; }
.protocol-note { font-size: 12px; line-height: 1.75; }
.parameter-panels :deep(.v-expansion-panel-title) { min-height: 40px; padding: 10px 16px; font-size: 13px; font-weight: 500; }
.parameter-panels :deep(.v-expansion-panel-title--active) { min-height: 40px; }
.parameter-panels :deep(.v-expansion-panel-text__wrapper) { padding: 2px 16px 16px; }
.parameter-panels :deep(.v-expansion-panel__shadow) { display: none; }
.temperature-heading, .slider-scale { display: flex; align-items: center; justify-content: space-between; font-size: 13px; }
.temperature-heading span { font-variant-numeric: tabular-nums; color: rgb(var(--v-theme-primary)); }
.slider-scale { color: rgba(var(--v-theme-on-surface), .6); font-size: 12px; margin-top: -4px; }
.playground-chat { grid-column: 1; grid-row: 2; display: flex; flex-direction: column; height: var(--playground-height); min-width: 0; overflow: hidden; border-top: 2px solid rgba(var(--v-theme-primary), .6) !important; }
.chat-heading { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.chat-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
.chat-title > .v-avatar { flex-shrink: 0; }
.chat-title > div { min-width: 0; }
.chat-heading h2 { font-size: 14px; font-weight: 600; margin: 0 0 4px; }
.chat-heading p { color: rgba(var(--v-theme-on-surface), .6); font: 12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; margin: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.chat-heading p > span { color: rgb(var(--v-theme-success)); font-weight: 600; margin-right: 6px; }
.chat-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.conversation-count { font-size: 12px; color: rgba(var(--v-theme-on-surface), .6); margin-right: 8px; }
.response-summary { display: grid; flex-shrink: 0; grid-template-columns: minmax(0, 1.5fr) repeat(3, minmax(0, 1fr)); gap: 14px; padding: 10px 16px; border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); background: rgba(var(--v-theme-primary), .06); }
.response-summary > div { min-width: 0; }
.response-summary span { display: block; color: rgba(var(--v-theme-on-surface), .6); font-size: 12px; margin-bottom: 5px; }
.response-summary strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 550; font-variant-numeric: tabular-nums; }
.playground-messages { overflow-y: auto; min-height: 0; flex: 1; overscroll-behavior: contain; scrollbar-width: thin; background: rgb(var(--v-theme-background)); }
.chat-welcome { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100%; padding: 24px 20px; text-align: center; }
.welcome-mark { display: grid; place-items: center; height: 42px; width: 42px; border-radius: 4px; background: rgba(var(--v-theme-primary), .1); border: 1px solid rgba(var(--v-theme-primary), .18); margin-bottom: 14px; }
.welcome-eyebrow { font-size: 12px; letter-spacing: 2px; color: rgba(var(--v-theme-on-surface), .5); }
.chat-welcome h3 { font-size: 20px; font-weight: 600; letter-spacing: -.4px; margin: 8px 0 10px; }
.chat-welcome > p { font-size: 13px; line-height: 1.85; color: rgba(var(--v-theme-on-surface), .65); max-width: 340px; margin: 0; }
.quick-prompts { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 16px; }
.playground-composer { flex: 0 1 auto; min-height: 0; max-height: 65%; overflow-y: auto; scrollbar-width: thin; padding: 12px 16px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); background: rgb(var(--v-theme-surface)); }
.composer-input { border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 4px; transition: border-color .15s; }
.composer-input:focus-within { border-color: rgb(var(--v-theme-primary)); }
.composer-input :deep(.v-field) { background: rgba(var(--v-theme-on-surface), .035); }
.composer-input :deep(textarea) { max-height: min(190px, 25dvh); overflow-y: auto !important; line-height: 1.8; font-size: 14px; }
.composer-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.composer-actions > span { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: rgba(var(--v-theme-on-surface), .55); }
.composer-actions i { width: 3px; height: 3px; border-radius: 50%; background: currentColor; }
.composer-submit { margin-left: auto; min-width: 100px; }
.draft-image { display: flex; align-items: center; gap: 10px; width: fit-content; margin-bottom: 12px; font-size: 12px; padding: 6px 8px; border: 1px solid rgba(var(--v-theme-primary), .3); background: rgba(var(--v-theme-primary), .06); border-radius: 4px; }
.draft-image > .v-img { flex: none; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.curl-preview { background: rgb(var(--v-theme-background)); border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 4px; padding: 14px; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.85 ui-monospace, SFMono-Regular, Consolas, monospace; max-height: 50dvh; overflow-y: auto; }
.curl-input :deep(textarea) { font: 12px/1.8 ui-monospace, SFMono-Regular, Consolas, monospace; }
@media (max-width: 1150px) { .playground-workspace { grid-template-columns: minmax(0, 1fr) 260px; gap: 16px; } .conversation-count { display: none; } .chat-heading { padding: 12px 16px; } .chat-title > .v-avatar { display: none; } .response-summary { padding-inline: 18px; gap: 14px; } .playground-composer { padding-inline: 18px; } .session-connection > .connection-name, .session-connection > strong { max-width: 180px; } }
@media (max-width: 850px) { .playground-workspace { --playground-height: max(460px, calc(100dvh - 190px)); grid-template-columns: minmax(0, 1fr); } .playground-controls { grid-column: 1; grid-row: 2; max-height: min(65dvh, 540px); } .playground-chat { grid-row: 3; } .configuration-closed .playground-chat { grid-row: 2; } .control-section { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; } .section-label, .control-note, .protocol-note { grid-column: 1 / -1; } .session-connection > .connection-name { display: none; } .session-connection > strong { max-width: 210px; } .session-connection { gap: 8px; } }
@media (max-width: 600px) { .playground-workspace { --playground-height: max(450px, calc(100dvh - 200px)); } .playground-sessionbar { gap: 10px; align-items: flex-start; } .session-connection { flex-wrap: wrap; gap: 7px; } .session-connection > .v-icon { display: none; } .session-connection > strong { flex-basis: 100%; max-width: 220px; font-size: 12px; } .session-actions { gap: 4px; } .session-actions > .v-btn:not(.v-btn--icon) { font-size: 12px; padding-inline: 10px; min-width: 0; } .control-section { padding: 18px; gap: 16px; grid-template-columns: minmax(0, 1fr); } .chat-heading { padding: 16px; gap: 8px; } .chat-heading h2 { font-size: 15px; } .chat-heading p { max-width: 170px; } .chat-actions .v-btn { width: 36px; height: 36px; } .response-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 12px 16px; gap: 10px; } .playground-composer { padding: 16px; } .composer-actions { gap: 6px; } .composer-actions > span { display: block; font-size: 12px; max-width: 140px; line-height: 1.6; } .composer-actions i { display: none; } .composer-submit { min-width: 82px; padding-inline: 14px; } .chat-welcome h3 { font-size: 20px; } }
@media (max-height: 800px) { .chat-heading { padding-block: 14px; } .chat-welcome { padding: 16px 24px; } .welcome-mark, .welcome-eyebrow { display: none; } .chat-welcome h3 { font-size: 18px; margin: 0 0 10px; } .chat-welcome > p { line-height: 1.7; } .quick-prompts { margin-top: 14px; } .playground-composer { padding-top: 14px; padding-bottom: 12px; } .composer-actions { margin-top: 9px; } .composer-input :deep(textarea) { max-height: 130px; } }
</style>
