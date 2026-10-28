<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { api, ApiError } from '../../api';
import { errorText } from '../../format';
import { createDatabaseDrafts, databaseError, databaseLabels, databasePayload, passwordError, publicUrlError, setupPublicUrl, type DatabaseType, type SetupStatus, type SetupPayload } from '../../setup';

const props = defineProps<{ status: SetupStatus }>();
const emit = defineEmits<{ complete: [password: string, publicUrl: string]; refresh: [] }>();
const steps = ['设置管理员密码', '连接数据库', '确认并初始化'];
const step = ref(0), adminPassword = ref(''), confirmation = ref(''), reveal = ref(false);
const selected = ref<DatabaseType>(props.status.defaults?.databaseType || 'sqlite');
const drafts = ref(createDatabaseDrafts(props.status.defaults));
const database = computed(() => drafts.value[selected.value]);
const configuredPublicUrl = props.status.defaults?.publicUrl?.trim() || '';
const publicUrl = ref(configuredPublicUrl || window.location.origin);
const busy = ref(false), testing = ref(false), error = ref(''), testState = ref<'idle' | 'success' | 'error'>('idle'), testMessage = ref('');
const heading = ref<HTMLElement | null>(null);
const databaseOptions = [
  { type: 'sqlite' as const, icon: 'mdi-file-document-outline', description: '本机文件，开箱即用' },
  { type: 'mysql' as const, icon: 'mdi-database-outline', description: '连接现有 MySQL 服务' },
  { type: 'pgsql' as const, icon: 'mdi-database-outline', description: '连接 PostgreSQL 服务' },
].filter(option => !props.status.databaseTypes || props.status.databaseTypes.includes(option.type));
const sslModes = [
  { title: '关闭 TLS', value: 'disable' },
  { title: '加密连接（不校验证书）', value: 'require' },
  { title: '验证服务端证书与主机名', value: 'verify-full' },
];
const locked = computed(() => busy.value || testing.value);
watch(() => JSON.stringify(databasePayload(database.value)), () => { testState.value = 'idle'; testMessage.value = ''; });
watch(step, async () => { error.value = ''; await nextTick(); heading.value?.focus({ preventScroll: true }); });

function advance() {
  if (locked.value) return;
  error.value = step.value === 0 ? passwordError(adminPassword.value, confirmation.value) : databaseError(database.value);
  if (!error.value) step.value++;
}
async function testDatabase() {
  if (locked.value) return;
  error.value = databaseError(database.value);
  if (error.value) return;
  testing.value = true; testState.value = 'idle'; testMessage.value = '';
  try {
    await api('/api/setup/test-database', { method: 'POST', body: JSON.stringify({ database: databasePayload(database.value) }) });
    testState.value = 'success'; testMessage.value = '连接成功，数据库可用。';
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 409) { emit('refresh'); return; }
    testState.value = 'error'; testMessage.value = errorText(reason);
  } finally { testing.value = false; }
}
async function initialize() {
  if (locked.value) return;
  const adminError = passwordError(adminPassword.value, confirmation.value), dbError = databaseError(database.value);
  if (adminError) { step.value = 0; await nextTick(); error.value = adminError; return; }
  if (dbError) { step.value = 1; await nextTick(); error.value = dbError; return; }
  const effectivePublicUrl = setupPublicUrl(publicUrl.value, configuredPublicUrl);
  error.value = publicUrlError(effectivePublicUrl);
  if (error.value) return;
  busy.value = true;
  const payload: SetupPayload = { adminPassword: adminPassword.value, confirmPassword: confirmation.value, publicUrl: effectivePublicUrl, database: databasePayload(database.value) };
  try {
    await api('/api/setup', { method: 'POST', body: JSON.stringify(payload) });
    const password = adminPassword.value;
    adminPassword.value = ''; confirmation.value = '';
    for (const draft of Object.values(drafts.value)) draft.password = '';
    emit('complete', password, payload.publicUrl);
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 409) { emit('refresh'); return; }
    error.value = errorText(reason);
  } finally { busy.value = false; }
}
</script>

<template>
  <main class="setup-screen">
    <div class="setup-layout">
      <aside class="setup-intro">
        <div class="setup-brand"><v-icon icon="mdi-pulse" color="primary" size="30" /><strong>PulseGate</strong></div>
        <v-chip color="primary" variant="tonal" size="small" class="mt-8 mb-4">首次部署</v-chip>
        <h1>开始配置你的网关</h1>
        <p class="setup-description">设置管理密码并选择数据存储，完成后即可添加渠道、创建 API Key。</p>
        <ol class="setup-steps" aria-label="初始化进度">
          <li v-for="(title, index) in steps" :key="title" :class="{ active: step === index, done: step > index }" :aria-current="step === index ? 'step' : undefined">
            <span class="setup-step-number"><v-icon v-if="step > index" icon="mdi-check" size="17" /><template v-else>{{ index + 1 }}</template></span><span>{{ title }}</span>
          </li>
        </ol>
        <p class="setup-persistence"><v-icon icon="mdi-content-save-check-outline" size="17" />配置保存后，重启服务可直接使用。</p>
      </aside>
      <v-card border class="setup-card">
        <div class="setup-card-heading"><span class="text-caption text-medium-emphasis">第 {{ step + 1 }} 步，共 3 步</span><h2 ref="heading" tabindex="-1">{{ steps[step] }}</h2><p>{{ step === 0 ? '此密码用于登录网关控制台，请妥善保存。' : step === 1 ? '选择适合部署环境的数据库。' : '检查部署信息，准备启动你的网关。' }}</p></div>
        <v-form :disabled="locked" novalidate @submit.prevent="step < 2 ? advance() : initialize()">
          <fieldset :disabled="locked" class="setup-fields">
            <div v-if="step === 0" class="setup-section">
              <v-text-field v-model="adminPassword" autofocus label="管理员密码" :type="reveal ? 'text' : 'password'" autocomplete="new-password" prepend-inner-icon="mdi-lock-outline" hint="至少 7 个字符，支持纯数字。" persistent-hint required>
                <template #append-inner><v-btn :icon="reveal ? 'mdi-eye-off-outline' : 'mdi-eye-outline'" :aria-label="reveal ? '隐藏密码' : '显示密码'" variant="text" size="x-small" :disabled="locked" @click="reveal = !reveal" /></template>
              </v-text-field>
              <v-text-field v-model="confirmation" label="再次输入管理员密码" :type="reveal ? 'text' : 'password'" autocomplete="new-password" prepend-inner-icon="mdi-lock-check-outline" required />
              <v-alert color="primary" variant="tonal" density="compact" icon="mdi-shield-lock-outline">管理员密码用于控制台登录；应用请求使用单独创建的 API Key。</v-alert>
            </div>
            <div v-else-if="step === 1" class="setup-section">
              <div class="database-options" role="radiogroup" aria-label="数据库类型">
                <button v-for="option in databaseOptions" :key="option.type" type="button" role="radio" :aria-checked="selected === option.type" :class="{ selected: selected === option.type }" :disabled="locked" @click="selected = option.type">
                  <v-icon :icon="option.icon" size="24" :color="selected === option.type ? 'primary' : undefined" /><strong>{{ databaseLabels[option.type] }}</strong><small>{{ option.description }}</small><v-icon v-if="selected === option.type" class="database-selected" icon="mdi-check-circle" color="primary" size="16" />
                </button>
              </div>
              <template v-if="selected === 'sqlite'">
                <v-alert type="info" variant="tonal" density="compact">无需单独安装数据库，适合单实例部署。数据文件应保存在持久化目录中。</v-alert>
                <v-text-field v-model="database.path" label="数据库文件路径" prepend-inner-icon="mdi-folder-outline" hint="相对于服务工作目录；Docker 部署请保留默认值，数据卷会保存此文件。" persistent-hint required />
              </template>
              <template v-else>
                <div class="setup-host-row"><v-text-field v-model="database.host" label="数据库主机" placeholder="例如 db 或 10.0.0.2" autocomplete="off" required /><v-text-field v-model="database.port" label="端口" type="number" min="1" max="65535" required /></div>
                <v-text-field v-model="database.name" label="数据库名称" autocomplete="off" hint="请先创建数据库，并授权该用户访问。" persistent-hint required />
                <v-text-field v-model="database.user" label="数据库用户名" autocomplete="off" required />
                <v-text-field v-model="database.password" label="数据库密码" type="password" autocomplete="new-password" />
                <v-select v-model="database.sslMode" :items="sslModes" label="连接安全（TLS）" />
                <p class="text-caption text-medium-emphasis">Docker 内连接其他容器时，主机请填数据库服务名；127.0.0.1 指向当前应用容器。</p>
              </template>
              <div class="database-test"><v-btn variant="outlined" prepend-icon="mdi-connection" :loading="testing" :disabled="busy" @click="testDatabase">测试数据库连接</v-btn><span v-if="testState === 'idle'" class="text-caption text-medium-emphasis">初始化时也会验证连接</span></div>
              <v-alert v-if="testState !== 'idle'" :type="testState === 'success' ? 'success' : 'error'" variant="tonal" density="compact" role="status">{{ testMessage }}</v-alert>
            </div>
            <div v-else class="setup-section">
              <div class="setup-summary"><div><span>管理员密码</span><strong><v-icon icon="mdi-check-circle-outline" color="success" size="17" class="mr-1" />已设置</strong></div><div><span>数据存储</span><strong>{{ databaseLabels[selected] }}</strong></div><div><span>{{ selected === 'sqlite' ? '文件路径' : '数据库地址' }}</span><code>{{ selected === 'sqlite' ? database.path : `${database.host}:${database.port} / ${database.name}` }}</code></div></div>
              <v-text-field v-model="publicUrl" :label="configuredPublicUrl ? '公开访问地址（由 PUBLIC_URL 固定）' : '网关公开访问地址（可选）'" :readonly="!!configuredPublicUrl" placeholder="https://gateway.example.com" type="url" autocomplete="url" :hint="configuredPublicUrl ? '此地址由服务器的 PUBLIC_URL 配置指定。如需更改，请修改部署配置并重启服务。' : '默认为当前访问地址。通过反向代理访问时，请填写对外地址。'" persistent-hint />
              <v-alert type="info" variant="tonal" density="compact">初始化会创建所需数据表并保存配置。请将应用数据目录挂载到持久化存储，避免重建容器时丢失配置。</v-alert>
            </div>
          </fieldset>
          <v-alert v-if="error" type="error" variant="tonal" density="compact" role="alert" class="mt-5">{{ error }}</v-alert>
          <div class="setup-actions"><v-btn v-if="step > 0" variant="text" :disabled="locked" prepend-icon="mdi-arrow-left" @click="step--">上一步</v-btn><v-spacer /><v-btn color="primary" variant="flat" type="submit" :loading="busy" :disabled="testing" :append-icon="step < 2 ? 'mdi-arrow-right' : 'mdi-check'">{{ step < 2 ? '下一步' : '完成初始化' }}</v-btn></div>
        </v-form>
      </v-card>
    </div>
    <p class="setup-footer">PulseGate <span>·</span> Go 网关 <span>·</span> 自主部署</p>
  </main>
</template>

<style scoped>
.setup-screen { min-height: 100dvh; display: flex; flex-direction: column; justify-content: center; padding: 48px 24px 24px; background: radial-gradient(ellipse at 8% 12%, rgba(var(--v-theme-primary), .07), transparent 50%); }
.setup-layout { display: grid; grid-template-columns: minmax(240px, 300px) minmax(0, 560px); align-items: start; justify-content: center; gap: 64px; width: 100%; max-width: 960px; margin: auto; }
.setup-intro { padding-top: 16px; }
.setup-brand { display: flex; align-items: center; gap: 10px; font-size: 23px; letter-spacing: -.5px; }
.setup-intro h1 { margin: 0 0 14px; font-size: 28px; line-height: 1.4; font-weight: 600; letter-spacing: -.7px; }
.setup-description, .setup-card-heading p { font-size: 13px; line-height: 1.8; color: rgba(var(--v-theme-on-surface), .65); }
.setup-steps { list-style: none; padding: 0; margin: 32px 0; display: grid; gap: 22px; }
.setup-steps li { display: flex; align-items: center; gap: 12px; color: rgba(var(--v-theme-on-surface), .5); font-size: 13px; }
.setup-step-number { display: flex; align-items: center; justify-content: center; width: 29px; height: 29px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 50%; font-size: 12px; font-weight: 600; }
.setup-steps li.active { color: rgb(var(--v-theme-on-surface)); font-weight: 600; }.setup-steps li.active .setup-step-number { color: rgb(var(--v-theme-primary)); border-color: rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), .08); }.setup-steps li.done .setup-step-number { color: rgb(var(--v-theme-success)); border-color: rgba(var(--v-theme-success), .4); }
.setup-persistence { display: flex; align-items: center; gap: 8px; font-size: 12px; color: rgba(var(--v-theme-on-surface), .5); line-height: 1.7; }
.setup-card { padding: 28px; min-width: 0; }.setup-card-heading { margin-bottom: 28px; }.setup-card-heading h2 { margin: 6px 0; font-size: 20px; font-weight: 600; }.setup-card-heading h2:focus { outline: none; }.setup-fields { padding: 0; margin: 0; border: 0; min-width: 0; }.setup-section { display: grid; gap: 18px; }.setup-section :deep(.v-input__details) { padding-top: 7px; }.setup-section :deep(.v-alert__content) { line-height: 1.8; font-size: 12px; }
.database-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }.database-options button { position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 10px; min-width: 0; padding: 15px 12px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 6px; text-align: left; background: transparent; color: inherit; }.database-options button:hover:not(:disabled) { background: rgba(var(--v-theme-primary), .04); }.database-options button:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 3px; }.database-options button.selected { border-color: rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), .055); }.database-options strong { font-size: 13px; font-weight: 600; }.database-options small { font-size: 11px; line-height: 1.6; color: rgba(var(--v-theme-on-surface), .6); }.database-selected { position: absolute; top: 12px; right: 10px; }
.setup-host-row { display: grid; grid-template-columns: minmax(0, 1fr) 112px; gap: 12px; }.database-test { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }.setup-summary { padding: 16px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 5px; display: grid; gap: 15px; background: rgba(var(--v-theme-on-surface), .025); }.setup-summary > div { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; font-size: 12px; }.setup-summary span { color: rgba(var(--v-theme-on-surface), .6); flex-shrink: 0; }.setup-summary strong { font-weight: 500; }.setup-summary code { text-align: right; overflow-wrap: anywhere; }.setup-actions { display: flex; align-items: center; gap: 12px; margin-top: 28px; padding-top: 22px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }.setup-footer { text-align: center; margin-top: 36px; color: rgba(var(--v-theme-on-surface), .4); font-size: 11px; }.setup-footer span { margin-inline: 9px; }
@media (max-width: 850px) { .setup-layout { gap: 30px; grid-template-columns: minmax(200px, 240px) minmax(0, 560px); }.setup-card { padding: 24px; }.setup-intro h1 { font-size: 24px; } }
@media (max-width: 680px) { .setup-screen { justify-content: flex-start; padding: 24px 16px; }.setup-layout { display: block; max-width: 560px; }.setup-intro { padding: 0 4px 20px; }.setup-intro > .v-chip { margin-top: 22px !important; }.setup-intro h1 { font-size: 24px; }.setup-description, .setup-persistence { display: none; }.setup-steps { display: flex; gap: 12px; margin: 22px 0 0; justify-content: space-between; }.setup-steps li { gap: 6px; font-size: 11px; }.setup-step-number { width: 23px; height: 23px; flex-shrink: 0; font-size: 11px; }.setup-card { padding: 22px 18px; }.setup-card-heading { margin-bottom: 22px; }.database-options { gap: 7px; }.database-options button { padding: 13px 10px; }.database-options small { font-size: 10px; }.database-options strong { font-size: 12px; }.database-selected { right: 7px; top: 10px; }.setup-footer { margin-top: 24px; } }
</style>
