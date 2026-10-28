<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onErrorCaptured, onMounted, onUnmounted, ref, useId, watch } from 'vue';
import { useDisplay } from 'vuetify';
import { useConsole } from './composables/useConsole';
import AppDialog from './components/AppDialog.vue';
import OverviewView from './views/OverviewView.vue';
import type { ConsolePage } from './navigation';
import { errorText } from './format';
import SetupWizard from './components/setup/SetupWizard.vue';
import { setupLoginDestination } from './setup';
const ChannelsView = defineAsyncComponent(() => import('./views/ChannelsView.vue'));
const KeysView = defineAsyncComponent(() => import('./views/KeysView.vue'));
const PlaygroundView = defineAsyncComponent({ loader: () => import('./views/PlaygroundView.vue'), suspensible: false });
const RequestsView = defineAsyncComponent({ loader: () => import('./views/RequestsView.vue'), suspensible: false });
const AnalyticsView = defineAsyncComponent(() => import('./views/AnalyticsView.vue'));
const SettingsView = defineAsyncComponent({ loader: () => import('./views/SettingsView.vue'), suspensible: false });
const store = useConsole();
const { page, session, setup, ready, loading, connectionError, metricsError, snackbar, settingsTab, navigate, copy, refresh, login, initialize, dispose, logoutOpen, logoutBusy, logoutHasDrafts, confirmLogout } = store;
const { smAndDown: mobile } = useDisplay();
const drawer = ref(false), token = ref(''), loginBusy = ref(false), guide = ref(false), viewError = ref('');
const completedSetupUrl = ref<string | null>(null);
const drawerId = useId();
const items = [
  { id: 'overview', title: '网关概览', icon: 'mdi-view-dashboard-outline' },
  { id: 'channels', title: '渠道管理', icon: 'mdi-server-network-outline' },
  { id: 'keys', title: 'API Keys', icon: 'mdi-key-outline' },
  { id: 'playground', title: '测试场', icon: 'mdi-flask-outline' },
  { id: 'requests', title: '请求日志', icon: 'mdi-text-box-search-outline' },
  { id: 'analytics', title: '用量分析', icon: 'mdi-chart-box-outline' },
  { id: 'settings', title: '网关设置', icon: 'mdi-tune-variant' },
] as const;
const current = computed(() => items.find(item => item.id === page.value) ?? items[0]);
const component = computed(() => ({ overview: OverviewView, channels: ChannelsView, keys: KeysView, playground: PlaygroundView, requests: RequestsView, analytics: AnalyticsView, settings: SettingsView, routing: SettingsView }[page.value]));
const endpoint = window.location.origin + '/v1';
let navigationOpener: HTMLElement | null = null;
const drawerElement = () => document.getElementById(drawerId);
const navigationToggle = () => document.querySelector<HTMLElement>('[data-navigation-toggle]');
function drawerFocusable() {
  return [...(drawerElement()?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])]
    .filter(element => element.getClientRects().length > 0 && element.getAttribute('aria-disabled') !== 'true' && !element.closest('[inert]'));
}
watch(drawer, async open => {
  if (!mobile.value) return;
  if (open) {
    const active = document.activeElement;
    navigationOpener = active instanceof HTMLElement && active !== document.body && !drawerElement()?.contains(active) ? active : null;
    await nextTick();
    if (mobile.value && drawer.value) (drawerElement()?.querySelector<HTMLElement>('[aria-current="page"]') ?? drawerFocusable()[0])?.focus({ preventScroll: true });
  } else {
    await nextTick();
    if (mobile.value && !drawer.value) (navigationOpener?.isConnected ? navigationOpener : navigationToggle())?.focus({ preventScroll: true });
    navigationOpener = null;
  }
});
function handleNavigationKeys(event: KeyboardEvent) {
  if (!mobile.value || !drawer.value || event.defaultPrevented || document.querySelector('.v-overlay--active.v-dialog, .v-overlay--active.v-menu')) return;
  if (event.key === 'Escape') { event.preventDefault(); drawer.value = false; return; }
  if (event.key !== 'Tab') return;
  const targets = drawerFocusable(), first = targets[0], last = targets.at(-1), active = document.activeElement;
  if (!first || !last) { event.preventDefault(); drawerElement()?.focus(); return; }
  if (!(active instanceof HTMLElement) || !targets.includes(active)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
  else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
}
watch(mobile, () => drawer.value = false);
watch([page, settingsTab], () => { drawer.value = false; viewError.value = ''; });
function select(destination: ConsolePage) { navigate(destination); drawer.value = false; }
function selectTab(value: unknown) { select(value as ConsolePage); }
function closeMobileNavigation() { drawer.value = false; }
function skipMain() { document.getElementById('main-content')?.focus(); }
async function submitLogin() {
  if (loginBusy.value) return;
  loginBusy.value = true;
  try { await login(token.value); token.value = ''; }
  catch (reason) { store.notify(errorText(reason), 'error'); }
  finally { loginBusy.value = false; }
}
async function completeSetup(password: string, publicUrl: string) {
  setup.value = { initialized: true };
  completedSetupUrl.value = setupLoginDestination(publicUrl, window.location.origin);
  if (completedSetupUrl.value) return;
  await store.startSession();
  try { await login(password); store.notify(session.value?.authenticated ? '初始化完成，欢迎使用 PulseGate' : '初始化已完成，请使用管理员密码登录'); }
  catch (reason) { store.notify(`初始化已完成，请使用管理员密码登录。${errorText(reason)}`, 'warning'); }
}
onErrorCaptured(reason => { viewError.value = errorText(reason); return false; });
onMounted(() => {
  void initialize();
  window.addEventListener('popstate', closeMobileNavigation);
  window.addEventListener('hashchange', closeMobileNavigation);
  window.addEventListener('keydown', handleNavigationKeys);
});
onUnmounted(() => {
  dispose();
  window.removeEventListener('popstate', closeMobileNavigation);
  window.removeEventListener('hashchange', closeMobileNavigation);
  window.removeEventListener('keydown', handleNavigationKeys);
});
</script>
<template>
  <v-app>
    <template v-if="session?.authenticated && ready">
      <a class="skip-link" href="#main-content" @click.prevent="skipMain">跳转到主要内容</a>
      <v-app-bar flat height="56" :extended="!mobile" extension-height="40" class="console-appbar" color="surface">
        <div class="console-topbar">
          <v-app-bar-nav-icon v-if="mobile" data-navigation-toggle :aria-label="drawer ? '关闭导航' : '打开导航'" :aria-expanded="drawer" :aria-controls="drawerId" @click="drawer = !drawer" />
          <button class="console-brand" aria-label="PulseGate 网关概览" @click="select('overview')"><v-icon icon="mdi-pulse" color="primary" size="24" /><strong>PulseGate</strong><span v-if="!mobile">控制台</span></button>
          <v-spacer />
          <v-chip v-if="!mobile" :color="connectionError ? 'error' : 'success'" size="small" variant="tonal" :prepend-icon="connectionError ? 'mdi-alert-circle-outline' : 'mdi-check-circle-outline'">{{ connectionError ? '连接异常' : '服务在线' }}</v-chip>
          <v-btn class="ml-2" :icon="mobile ? 'mdi-code-braces' : undefined" :prepend-icon="mobile ? undefined : 'mdi-code-braces'" variant="text" aria-label="复制 API 地址" @click="copy(endpoint)"><span v-if="!mobile">API 地址</span></v-btn>
          <v-divider vertical inset class="mx-2" />
          <v-menu><template #activator="{ props }"><v-btn v-bind="props" variant="text" class="console-account" aria-label="管理员菜单"><v-avatar color="primary" variant="tonal" size="26"><v-icon icon="mdi-account-outline" size="17" /></v-avatar><span v-if="!mobile" class="ml-2">管理员</span><v-icon icon="mdi-chevron-down" size="14" class="ml-1" /></v-btn></template><v-list density="compact"><v-list-item title="使用指南" prepend-icon="mdi-help-circle-outline" @click="guide = true" /><v-list-item title="网关设置" prepend-icon="mdi-cog-outline" @click="select('settings')" /><v-divider class="my-1" /><v-list-item title="退出登录" prepend-icon="mdi-logout" @click="store.requestLogout()" /></v-list></v-menu>
        </div>
        <template v-if="!mobile" #extension><nav class="console-navigation" aria-label="主导航"><v-tabs :model-value="page" color="primary" @update:model-value="selectTab"><v-tab v-for="item in items" :key="item.id" :value="item.id" :prepend-icon="item.icon" :aria-label="item.title">{{ item.title }}</v-tab></v-tabs><span class="environment-label">{{ session.devMode ? '本地开发' : '生产环境' }}</span></nav></template>
        <v-progress-linear v-if="loading" indeterminate color="primary" absolute location="bottom" height="2" />
      </v-app-bar>
      <v-navigation-drawer v-if="mobile" :id="drawerId" v-model="drawer" temporary width="280" role="dialog" aria-label="工作空间导航" :aria-modal="drawer ? true : undefined" tabindex="-1" class="mobile-navigation">
        <div class="mobile-navigation-title"><strong>导航</strong><v-btn icon="mdi-close" variant="text" size="small" aria-label="关闭导航抽屉" @click="drawer = false" /></div>
        <v-list nav aria-label="主导航"><v-list-item v-for="item in items" :key="item.id" tag="button" role="button" :tabindex="0" :active="page === item.id" :prepend-icon="item.icon" :title="item.title" :aria-label="item.title" :aria-current="page === item.id ? 'page' : undefined" color="primary" @click="select(item.id)" /></v-list>
        <template #append><div class="pa-5 text-body-2 text-medium-emphasis">{{ session.devMode ? '本地开发环境' : '生产环境' }}</div></template>
      </v-navigation-drawer>
      <v-main :aria-label="current.title"><div id="main-content" class="console-content" tabindex="-1">
        <v-alert v-if="connectionError" type="error" variant="tonal" class="mb-5">数据刷新失败：{{ connectionError }}<template #append><v-btn variant="text" size="small" @click="refresh()">重试</v-btn></template></v-alert>
        <v-alert v-if="metricsError && ['overview', 'analytics'].includes(page)" type="warning" variant="tonal" class="mb-5">统计数据暂时无法更新：{{ metricsError }}。已保留上一次数据。</v-alert>
        <v-alert v-if="viewError" type="error" variant="tonal" title="页面暂时无法显示">{{ viewError }}<template #append><v-btn @click="viewError = ''">重新加载</v-btn></template></v-alert>
        <Suspense v-else><KeepAlive :include="['PlaygroundView', 'SettingsView', 'RequestsView']"><component :is="component" /></KeepAlive><template #fallback><div class="page-loading"><v-progress-circular indeterminate color="primary" /><p>正在加载工作区…</p></div></template></Suspense>
        <footer class="console-footer"><span>PulseGate <span class="mx-2">/</span>{{ session.devMode ? '本地开发' : 'Go · Docker' }}</span><v-btn variant="text" size="small" prepend-icon="mdi-help-circle-outline" @click="guide = true">使用指南</v-btn></footer>
      </div></v-main>
    </template>
    <main v-else-if="completedSetupUrl" class="login-screen">
      <div class="login-brand"><v-icon icon="mdi-pulse" color="primary" size="28" /><strong>PulseGate</strong></div>
      <v-card border class="login-card" aria-labelledby="setup-complete-title"><v-avatar color="success" variant="tonal" size="40"><v-icon icon="mdi-check" size="24" /></v-avatar><h1 id="setup-complete-title" class="text-h6 mb-3">初始化已完成</h1><p class="text-medium-emphasis mb-5">数据库和管理员密码已保存。你配置了新的公开访问地址，请前往该地址，使用刚设置的管理员密码登录。</p><div class="endpoint-code mb-5"><code>{{ completedSetupUrl }}</code></div><v-btn :href="completedSetupUrl" color="primary" variant="flat" append-icon="mdi-arrow-right" block>前往网关登录</v-btn></v-card>
    </main>
    <SetupWizard v-else-if="setup && !setup.initialized && !connectionError" :status="setup" @complete="completeSetup" @refresh="store.startSession()" />
    <div v-else class="login-screen">
      <div class="login-brand"><v-icon icon="mdi-pulse" color="primary" size="28" /><strong>PulseGate</strong></div>
      <v-card border class="login-card"><v-avatar color="primary" variant="tonal" size="40"><v-icon icon="mdi-shield-key-outline" size="22" /></v-avatar>
        <template v-if="connectionError"><v-alert type="error" variant="tonal" class="mb-5">{{ connectionError }}</v-alert><v-btn color="primary" block @click="session?.authenticated ? refresh() : store.startSession()">重新连接</v-btn></template>
        <div v-else-if="!session || session.authenticated" class="login-connecting"><v-progress-circular color="primary" indeterminate size="28" /><span>正在连接工作空间…</span></div>
        <v-form v-else aria-label="管理员登录" @submit.prevent="submitLogin"><h1 class="text-h6 mb-2">登录控制台</h1><p class="text-body-2 text-medium-emphasis mb-5">{{ session.authMode === 'token' ? '使用部署时配置的管理员令牌。' : '使用初始化时设置的管理员密码。' }}</p><v-alert v-if="!session.configured" type="warning" variant="tonal" class="mb-5">服务端管理身份尚未配置，请检查部署配置。</v-alert><v-text-field v-model="token" :label="session.authMode === 'token' ? '管理员令牌' : '管理员密码'" type="password" autocomplete="current-password" prepend-inner-icon="mdi-key-outline" :disabled="loginBusy" required class="mb-5" /><v-btn color="primary" block type="submit" :loading="loginBusy" :disabled="!session.configured || !token">进入控制台<v-icon icon="mdi-arrow-right" end /></v-btn></v-form>
        <v-divider class="my-6" /><p class="text-caption text-medium-emphasis"><v-icon icon="mdi-lock-outline" size="15" class="mr-1" />安全会话保护管理访问，上游凭证加密保存。</p>
      </v-card><p class="login-caption">多模型接入 <span>·</span> 智能调度 <span>·</span> 请求观测</p>
    </div>
    <AppDialog v-model="logoutOpen" title="退出管理会话？" max-width="440" :busy="logoutBusy"><v-alert v-if="logoutHasDrafts" type="warning" variant="tonal">当前存在未保存的设置，退出后这些更改将丢失。</v-alert><p v-else class="text-body-2 text-medium-emphasis">退出后需要重新验证管理员身份。</p><template #actions><v-spacer /><v-btn :disabled="logoutBusy" @click="logoutOpen = false">取消</v-btn><v-btn color="primary" variant="flat" :loading="logoutBusy" @click="confirmLogout">退出</v-btn></template></AppDialog>
    <v-snackbar v-model="snackbar.show" :color="snackbar.color" location="bottom right" :timeout="4500">{{ snackbar.text }}<template #actions><v-btn icon="mdi-close" variant="text" size="small" aria-label="关闭通知" @click="snackbar.show = false" /></template></v-snackbar>
    <AppDialog v-model="guide" title="开始使用 PulseGate" max-width="600"><v-list lines="two" class="guide-list"><v-list-item prepend-icon="mdi-server-plus-outline" title="1. 添加上游渠道" subtitle="填写连接地址、上游密钥与支持的模型。" /><v-list-item prepend-icon="mdi-key-plus" title="2. 创建应用凭证" subtitle="配置允许访问的渠道、模型和请求额度。" /><v-list-item prepend-icon="mdi-flask-outline" title="3. 验证模型请求" subtitle="在测试场检查响应、延迟与请求追踪。" /></v-list><div class="endpoint-code"><code>{{ endpoint }}</code><v-btn icon="mdi-content-copy" size="small" variant="text" aria-label="复制网关地址" @click="copy(endpoint)" /></div><v-alert type="info" variant="tonal" density="compact" class="mt-4">OpenAI 使用 /v1/chat/completions，Anthropic 使用 /v1/messages。完整 API Key 仅在创建或轮换时显示一次。</v-alert><template #actions><v-spacer /><v-btn color="primary" variant="flat" @click="guide = false">知道了</v-btn></template></AppDialog>
  </v-app>
</template>
