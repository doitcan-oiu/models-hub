import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import type { AttemptRecord, GatewayChannel, GatewayLog, MockScenario } from '../../shared/types';
import { api } from '../api';
import { modelsForProfile, usableApiKey } from '../access-policy';
import { splitSSEFrames } from '../playground-stream';
import { useConsole } from './useConsole';

export type PlaygroundTool = { id: string; name: string; arguments: string };
export type PlaygroundMessage = {
  id: string; role: 'user' | 'assistant'; content: string; image?: string;
  tools?: PlaygroundTool[]; reasoning?: string; error?: string; requestId?: string;
  trace?: { log: GatewayLog; attempts: AttemptRecord[] }; usage?: { input: number; output: number }; pending?: boolean;
};
type ImagePart = { type: 'image_url'; image_url: { url: string } };
type WireMessage = { role: string; content: string | ({ type: 'text'; text: string } | ImagePart)[] };
type Payload = {
  choices?: { delta?: { content?: string; reasoning_content?: string; reasoning?: string;
    tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] };
    message?: { content?: string; reasoning_content?: string; reasoning?: string;
      tool_calls?: { id: string; function?: { name?: string; arguments?: string } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } | string; type?: string; message?: string;
};
const errorText = (error: unknown) => error instanceof Error ? error.message : '请求失败';
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const MODEL_LIMIT = 2 * 1024 * 1024, PAYLOAD_LIMIT = 4 * 1024 * 1024;
const sizeLabel = (value: number) => `${(value / 1024 / 1024).toFixed(2)} MiB`;
const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
export const scenarioItems: { title: string; value: MockScenario }[] = [
  { title: '健康响应', value: 'healthy' }, { title: '首字延迟', value: 'slow' },
  { title: 'HTTP 错误', value: 'error' }, { title: '空响应', value: 'empty' },
  { title: '流中断', value: 'disconnect' }, { title: '暂时失败后恢复', value: 'transient' },
];

/** Parse arguments only; imported cURL is never executed and its credentials are never retained. */
export function curlRequestBody(source: string): Record<string, unknown> {
  const text = source.trim();
  let body = text;
  if (!text.startsWith('{')) {
    const input = text.replace(/\\\r?\n|\^\r?\n/g, ' ');
    const tokens: string[] = [];
    let token = '', quote = '', started = false;
    for (let index = 0; index < input.length; index++) {
      const character = input[index];
      if (quote) {
        if (character === quote) quote = '';
        else if (character === '\\' && quote === '"' && /["\\$`]/.test(input[index + 1] ?? '')) token += input[++index];
        else token += character;
        started = true;
      } else if (character === "'" || character === '"') { quote = character; started = true; }
      else if (/\s/.test(character)) { if (started) { tokens.push(token); token = ''; started = false; } }
      else if (character === '\\' && index + 1 < input.length) { token += input[++index]; started = true; }
      else { token += character; started = true; }
    }
    if (quote) throw new Error('cURL 引号没有闭合');
    if (started) tokens.push(token);
    const pieces: string[] = [];
    const flags = ['-d', '--data', '--data-raw', '--data-binary', '--json'];
    for (let index = 0; index < tokens.length; index++) {
      const argument = tokens[index];
      if (flags.includes(argument)) {
        if (!tokens[index + 1]) throw new Error('cURL 缺少请求 JSON');
        pieces.push(tokens[++index]);
      } else {
        const match = flags.filter(flag => flag.startsWith('--')).find(flag => argument.startsWith(`${flag}=`));
        if (match) pieces.push(argument.slice(match.length + 1));
        else if (argument.startsWith('-d') && argument.length > 2) pieces.push(argument.slice(2));
      }
    }
    if (pieces.length !== 1 || pieces[0].startsWith('@')) throw new Error('请粘贴包含一段内联 JSON 的 --data / --json cURL');
    body = pieces[0];
  }
  if (bytes(body) > MODEL_LIMIT) throw new Error('导入请求超过 2 MiB 上限');
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new Error('无法解析请求 JSON，请检查 cURL 的数据部分'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求必须是 JSON 对象');
  return parsed as Record<string, unknown>;
}

export function usePlayground() {
  const consoleStore = useConsole();
  const state = reactive({
    mode: (consoleStore.playChannel.value ? 'channel' : 'gateway') as 'channel' | 'gateway',
    channelId: consoleStore.playChannel.value || '', keyId: '', model: '', temperature: 1, maxTokens: 4096,
    system: '你是一个有用的助手。', stream: true, input: '', image: null as string | null,
    messages: [] as PlaygroundMessage[], running: false, fixtureBusy: false, controlsExpanded: true,
    budgetError: '', scenario: 'healthy' as MockScenario, delay: 50, httpStatus: 503, failures: 1,
    curlOpen: false, curlTab: 'export', importText: '', importError: '', imageBusy: false,
  });
  const messageList = ref<HTMLElement | null>(null);
  let followOutput = true, threadId = crypto.randomUUID(), sequence = 0, epoch = 0, disposed = false;
  let controller: AbortController | null = null;
  let imageReader: FileReader | null = null;
  const traceControllers = new Set<AbortController>();
  const activeChannels = computed(() => consoleStore.channels.value.filter(item => !item.archived));
  const activeKeys = computed(() => consoleStore.keys.value.filter(item => usableApiKey(item)));
  const channel = computed(() => consoleStore.channels.value.find(item => item.id === state.channelId));
  const key = computed(() => consoleStore.keys.value.find(item => item.id === state.keyId));
  const devMode = computed(() => Boolean(consoleStore.session.value?.devMode));
  const models = computed(() => {
    if (state.mode === 'channel') return [...new Set([...(channel.value?.models ?? []), ...(channel.value?.config.aliases.map(alias => alias.from) ?? [])])];
    const credential = key.value;
    if (!credential || !usableApiKey(credential)) return [];
    const profile = credential.profiles.find(item => item.id === credential.activeProfile);
    return profile ? modelsForProfile(consoleStore.channels.value, profile) : [];
  });
  const latestResponse = computed(() => [...state.messages].reverse().find(message => message.role === 'assistant'));
  const latestTrace = computed(() => latestResponse.value?.trace?.log);
  const canSend = computed(() => !state.running && !state.fixtureBusy && !state.imageBusy && Boolean(state.model && (state.input.trim() || state.image)));
  const modelRequest = (history: PlaygroundMessage[]) => ({
    model: state.model,
    messages: [
      ...(state.system.trim() ? [{ role: 'system', content: state.system }] : []),
      ...history.filter(message => !message.error && !message.pending).map(message => ({
        role: message.role, content: message.image ? [{ type: 'text' as const, text: message.content }, { type: 'image_url' as const, image_url: { url: message.image } }] : message.content,
      })),
    ] as WireMessage[], temperature: state.temperature, max_tokens: state.maxTokens, stream: state.stream,
  });
  const exportHistory = computed(() => [...state.messages, ...(state.input.trim() || state.image ? [{ id: 'draft', role: 'user' as const, content: state.input.trim(), ...(state.image ? { image: state.image } : {}) }] : [])]);
  const curl = computed(() => `curl ${shellQuote(`${window.location.origin}/v1/chat/completions`)} \\\n  -H "Authorization: Bearer $PULSEGATE_API_KEY" \\\n  -H 'Content-Type: application/json' \\\n  --data ${shellQuote(JSON.stringify(modelRequest(exportHistory.value), null, 2))}${state.stream ? ' \\\n  --no-buffer' : ''}`);
  const updateMessage = (id: string, update: Partial<PlaygroundMessage>) => {
    const index = state.messages.findIndex(message => message.id === id);
    if (index >= 0) state.messages[index] = { ...state.messages[index], ...update };
  };
  function abortTraces() { for (const pending of traceControllers) pending.abort(); traceControllers.clear(); }
  function stop() { controller?.abort(); }
  function cancelCurrent() {
    controller?.abort(); controller = null; sequence++; state.running = false;
    for (const message of state.messages) if (message.pending) { message.pending = false; message.error = '已停止生成'; }
  }
  function invalidateContext() { epoch++; abortTraces(); imageReader?.abort(); imageReader = null; state.imageBusy = false; }
  watch([activeChannels, activeKeys, () => state.running], () => {
    if (state.running) return;
    if (!activeChannels.value.some(item => item.id === state.channelId)) state.channelId = activeChannels.value[0]?.id ?? '';
    if (!activeKeys.value.some(item => item.id === state.keyId)) state.keyId = activeKeys.value[0]?.id ?? '';
  }, { immediate: true });
  watch([models, () => state.running], () => { if (!state.running && !models.value.includes(state.model)) state.model = models.value[0] ?? ''; }, { immediate: true });
  watch(() => [channel.value?.id, channel.value?.config.mock.scenario, channel.value?.config.mock.delayMs, channel.value?.config.mock.status, channel.value?.config.mock.failuresBeforeSuccess], () => {
    if (channel.value?.config.protocol !== 'mock' || state.running || state.fixtureBusy) return;
    const mock = channel.value.config.mock;
    state.scenario = mock.scenario; state.delay = mock.delayMs; state.httpStatus = mock.status; state.failures = mock.failuresBeforeSuccess;
  }, { immediate: true });
  watch(consoleStore.playVersion, () => {
    if (!consoleStore.playChannel.value) return;
    cancelCurrent(); invalidateContext(); state.mode = 'channel'; state.channelId = consoleStore.playChannel.value; state.controlsExpanded = true;
  }, { immediate: true });
  watch(() => consoleStore.session.value?.authenticated, authenticated => { if (authenticated === false) { cancelCurrent(); invalidateContext(); } });
  watch(() => state.curlOpen, open => { if (!open) { state.importText = ''; state.importError = ''; } });
  watch(() => state.messages.at(-1), async () => { await nextTick(); if (followOutput && messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight; });
  function trackScroll() { const node = messageList.value; if (node) followOutput = node.scrollHeight - node.scrollTop - node.clientHeight < 96; }
  function resetConversation() {
    if (state.running) return;
    if (state.budgetError && !state.input.trim() && !state.image) {
      const user = [...state.messages].reverse().find(message => message.role === 'user');
      if (user) { state.input = user.content; state.image = user.image ?? null; }
    }
    invalidateContext(); state.messages = []; state.budgetError = ''; threadId = crypto.randomUUID(); followOutput = true;
  }
  async function loadTrace(id: string, assistantId: string, capturedEpoch: number) {
    const traceController = new AbortController(); traceControllers.add(traceController);
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        if (disposed || capturedEpoch !== epoch || traceController.signal.aborted) return;
        try {
          const trace = await api<{ log: GatewayLog; attempts: AttemptRecord[] }>(`/api/logs/${encodeURIComponent(id)}`, { signal: traceController.signal });
          if (!disposed && capturedEpoch === epoch && !traceController.signal.aborted) updateMessage(assistantId, { trace });
          return;
        } catch {
          if (attempt === 4 || traceController.signal.aborted) return;
          await new Promise<void>(resolve => { const timer = window.setTimeout(resolve, 300 * (attempt + 1)); traceController.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
        }
      }
    } finally { traceControllers.delete(traceController); }
  }
  async function send(history?: PlaygroundMessage[]) {
    if (state.running || controller || state.fixtureBusy || state.imageBusy) return;
    if (!state.model || !models.value.includes(state.model) || (state.mode === 'channel' ? !channel.value || channel.value.archived : !key.value || !usableApiKey(key.value))) {
      consoleStore.notify(state.mode === 'channel' ? '请选择渠道和模型' : '请先创建可用 API Key 并选择模型', 'error'); return;
    }
    if (!Number.isInteger(state.maxTokens) || state.maxTokens < 1 || state.maxTokens > 1000000) { consoleStore.notify('最大 token 数须为 1–1000000 的整数', 'error'); return; }
    if (!Number.isFinite(state.temperature) || state.temperature < 0 || state.temperature > 2) { consoleStore.notify('温度须为 0–2', 'error'); return; }
    const previous = [...state.messages];
    const user: PlaygroundMessage = { id: crypto.randomUUID(), role: 'user', content: state.input.trim(), ...(state.image ? { image: state.image } : {}) };
    if (!history && !user.content && !user.image) return;
    const historyToSend = history ? [...history] : [...state.messages, user];
    const request = modelRequest(historyToSend);
    const modelBytes = bytes(JSON.stringify(request));
    const payload = JSON.stringify({ mode: state.mode, channelId: state.mode === 'channel' ? state.channelId : undefined, keyId: state.mode === 'gateway' ? state.keyId : undefined, request });
    if (modelBytes > MODEL_LIMIT || bytes(payload) > PAYLOAD_LIMIT) {
      state.budgetError = `当前请求为 ${sizeLabel(modelBytes)}，超过单次 2 MiB 上限。历史回复、系统提示和图片编码均计入大小；请开启新会话或缩小图片后发送，待发内容会保留。`; return;
    }
    state.budgetError = '';
    const assistantId = crypto.randomUUID(), operation = ++sequence, capturedEpoch = epoch;
    const abort = new AbortController(); controller = abort; state.running = true; followOutput = true;
    state.messages = [...historyToSend, { id: assistantId, role: 'assistant', content: '', pending: true }];
    if (!history) { state.input = ''; state.image = null; }
    let requestId: string | null = null, content = '', reasoning = '';
    let usage: PlaygroundMessage['usage'];
    const tools = new Map<number, PlaygroundTool>();
    const current = () => !disposed && operation === sequence && capturedEpoch === epoch;
    const apply = (data: Payload) => {
      if (!current()) return;
      if (data.error || data.type === 'error') throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || '上游流式请求失败');
      const choice = data.choices?.[0];
      if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
      const thought = choice?.delta?.reasoning_content || choice?.delta?.reasoning;
      if (typeof thought === 'string') reasoning += thought;
      for (const delta of choice?.delta?.tool_calls ?? []) {
        const tool = tools.get(delta.index) ?? { id: delta.id || `tool-${delta.index}`, name: '', arguments: '' };
        if (delta.id) tool.id = delta.id;
        if (delta.function?.name) tool.name += delta.function.name;
        if (delta.function?.arguments) tool.arguments += delta.function.arguments;
        tools.set(delta.index, tool);
      }
      if (choice?.message) {
        content = choice.message.content || ''; reasoning = choice.message.reasoning_content || choice.message.reasoning || '';
        for (const [index, tool] of (choice.message.tool_calls ?? []).entries()) tools.set(index, { id: tool.id, name: tool.function?.name ?? '', arguments: tool.function?.arguments ?? '' });
      }
      if (data.usage) usage = { input: Math.max(usage?.input ?? 0, data.usage.prompt_tokens ?? 0), output: Math.max(usage?.output ?? 0, data.usage.completion_tokens ?? 0) };
      updateMessage(assistantId, { content, reasoning, tools: [...tools.values()], usage });
    };
    try {
      const response = await fetch('/api/playground/chat', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Thread-Id': threadId }, body: payload, signal: abort.signal });
      if (!current()) return;
      requestId = response.headers.get('x-pulsegate-request-id');
      if (requestId) updateMessage(assistantId, { requestId });
      if (!response.ok) {
        if (response.status === 413) {
          state.messages = previous;
          if (!history) { state.input = user.content; state.image = user.image ?? null; }
          state.budgetError = '请求内容超过服务端大小上限，待发内容已保留。请开启新会话或缩小图片后重试。'; return;
        }
        const data = await response.json().catch(() => ({})) as Payload;
        throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `HTTP ${response.status}`);
      }
      if (!response.headers.get('content-type')?.includes('text/event-stream')) apply(await response.json() as Payload);
      else {
        if (!response.body) throw new Error('响应没有可读取的流');
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let buffer = '', finished = false;
        const consume = (frame: string) => {
          let event = 'message'; const data: string[] = [];
          for (const line of frame.split(/\r\n|\r|\n/)) { if (line.startsWith('event:')) event = line.slice(6).trim(); if (line.startsWith('data:')) data.push(line.slice(5).trimStart()); }
          if (!data.length) return;
          const text = data.join('\n'); if (text === '[DONE]') { finished = true; return; }
          let parsed: Payload;
          try { parsed = JSON.parse(text); } catch { throw new Error(event === 'error' ? text : '收到格式异常的 SSE 数据'); }
          if (event === 'error') throw new Error(typeof parsed.error === 'string' ? parsed.error : parsed.error?.message || parsed.message || '上游流中断');
          apply(parsed);
        };
        try {
          while (!finished && current()) {
            const chunk = await reader.read();
            if (!current()) break;
            buffer += decoder.decode(chunk.value, { stream: !chunk.done });
            const parsed = splitSSEFrames(buffer, chunk.done); buffer = parsed.remainder;
            for (const frame of parsed.frames) { consume(frame); if (finished) break; }
            if (chunk.done) break;
          }
        } finally { await reader.cancel().catch(() => undefined); }
      }
      if (!current()) return;
      if (abort.signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
      if (!content && !reasoning && !tools.size) throw new Error('上游返回了空响应');
      updateMessage(assistantId, { pending: false });
    } catch (error) {
      if (current()) { updateMessage(assistantId, { pending: false, error: abort.signal.aborted ? '已停止生成' : errorText(error) }); if (!abort.signal.aborted) consoleStore.notify(errorText(error), 'error'); }
    } finally {
      if (current()) {
        state.running = false; controller = null;
        if (requestId) void loadTrace(requestId, assistantId, capturedEpoch);
        try { await consoleStore.refresh(true); } catch { if (current()) consoleStore.notify('请求已结束，状态刷新失败。请手动刷新控制台。', 'error'); }
      }
    }
  }
  function retry() { const index = state.messages.map(message => message.role).lastIndexOf('user'); if (index >= 0) void send(state.messages.slice(0, index + 1)); }
  function resend(id: string) { const index = state.messages.findIndex(message => message.id === id); if (index < 0) return; const user = state.messages[index].role === 'user' ? index : state.messages.slice(0, index).map(message => message.role).lastIndexOf('user'); if (user >= 0) void send(state.messages.slice(0, user + 1)); }
  function attach(file?: File) {
    if (!file || state.running) return;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) { consoleStore.notify('支持 PNG、JPEG、WebP 和 GIF', 'error'); return; }
    if (file.size > 1048576) { consoleStore.notify('图片不能超过 1 MiB', 'error'); return; }
    imageReader?.abort(); const reader = new FileReader(), capturedEpoch = epoch;
    imageReader = reader; state.imageBusy = true;
    reader.onload = () => { if (!disposed && imageReader === reader && capturedEpoch === epoch) { state.image = String(reader.result); state.budgetError = ''; } };
    reader.onerror = () => { if (imageReader === reader) consoleStore.notify('图片读取失败', 'error'); };
    reader.onloadend = () => { if (imageReader === reader) { imageReader = null; state.imageBusy = false; } };
    reader.readAsDataURL(file);
  }
  async function installFixtures() {
    if (state.fixtureBusy || state.running) return;
    state.fixtureBusy = true; const capturedEpoch = epoch;
    try {
      const installed = await api<{ channels: GatewayChannel[] }>('/api/dev/fixtures', { method: 'POST' });
      await consoleStore.refresh(true);
      if (!disposed && capturedEpoch === epoch) { state.mode = 'channel'; if (installed.channels[0]) state.channelId = installed.channels[0].id; consoleStore.notify('已安装健康主渠道与备用渠道，可调整故障场景', 'success'); }
    } catch (error) { if (!disposed && capturedEpoch === epoch) consoleStore.notify(errorText(error), 'error'); }
    finally { state.fixtureBusy = false; }
  }
  async function saveScenario() {
    if (state.fixtureBusy || state.running || channel.value?.config.protocol !== 'mock') return;
    if (!Number.isInteger(state.delay) || state.delay < 0 || state.delay > 600000 || !Number.isInteger(state.httpStatus) || state.httpStatus < 400 || state.httpStatus > 599 || !Number.isInteger(state.failures) || state.failures < 1 || state.failures > 100) { consoleStore.notify('请检查延迟（0–600000）、HTTP 状态（400–599）与失败次数（1–100）', 'error'); return; }
    state.fixtureBusy = true; const capturedEpoch = epoch;
    try {
      await api(`/api/channels/${encodeURIComponent(channel.value.id)}`, { method: 'PATCH', body: JSON.stringify({ config: { ...channel.value.config, mock: { scenario: state.scenario, delayMs: state.delay, status: state.httpStatus, failuresBeforeSuccess: state.failures } } }) });
      await consoleStore.refresh(true);
      if (!disposed && capturedEpoch === epoch) consoleStore.notify('本地上游故障场景已更新', 'success');
    } catch (error) { if (!disposed && capturedEpoch === epoch) consoleStore.notify(errorText(error), 'error'); }
    finally { state.fixtureBusy = false; }
  }
  function changeScenario(value: MockScenario) { state.scenario = value; if (value === 'slow') state.delay = 15000; else if (value === 'healthy') state.delay = 50; }
  function importCurl() {
    if (state.running) return;
    state.importError = '';
    try {
      const body = curlRequestBody(state.importText);
      if (typeof body.model !== 'string' || !models.value.includes(body.model)) throw new Error('导入模型不在当前连接授权范围内，请先选择对应渠道或 API Key');
      if (!Array.isArray(body.messages)) throw new Error('请求缺少 messages 数组');
      const imported: PlaygroundMessage[] = [], prompts: string[] = [];
      for (const raw of body.messages) {
        if (!raw || typeof raw !== 'object') throw new Error('消息格式无效');
        const message = raw as Record<string, unknown>;
        if (!['system', 'user', 'assistant'].includes(String(message.role))) throw new Error('仅支持 system、user、assistant 消息；测试场不执行工具响应');
        let content = '', image: string | undefined;
        if (typeof message.content === 'string') content = message.content;
        else if (message.content === null && message.role === 'assistant') content = '';
        else if (Array.isArray(message.content)) for (const rawPart of message.content) {
          const part = rawPart as { type?: string; text?: string; image_url?: { url?: string } };
          if (part.type === 'text' && typeof part.text === 'string') content += part.text;
          else if (part.type === 'image_url' && typeof part.image_url?.url === 'string') { if (image) throw new Error('每条消息暂支持一张图片'); image = part.image_url.url; }
          else throw new Error('包含不支持的消息内容类型');
        } else throw new Error('消息内容格式无效');
        if (message.role === 'system') { if (image) throw new Error('系统提示不支持图片'); prompts.push(content); }
        else imported.push({ id: crypto.randomUUID(), role: message.role as 'user' | 'assistant', content, ...(image ? { image } : {}) });
      }
      const temperature = body.temperature === undefined ? state.temperature : Number(body.temperature);
      const maxTokens = body.max_tokens === undefined ? state.maxTokens : Number(body.max_tokens);
      if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2 || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 1000000 || (body.stream !== undefined && typeof body.stream !== 'boolean')) throw new Error('生成参数不合法，请检查温度、最大 Token 和 stream');
      invalidateContext(); threadId = crypto.randomUUID(); state.model = body.model; state.temperature = temperature; state.maxTokens = maxTokens;
      if (body.stream !== undefined) state.stream = body.stream as boolean;
      state.system = prompts.join('\n\n'); state.input = ''; state.image = null; state.budgetError = '';
      const last = imported[imported.length - 1];
      if (last?.role === 'user') { state.input = last.content; state.image = last.image ?? null; imported.pop(); }
      state.messages = imported; state.importText = ''; state.curlOpen = false; followOutput = true;
      consoleStore.notify('已导入消息与生成参数，使用当前选定连接发送', 'success');
    } catch (error) { state.importError = errorText(error); }
  }
  function downloadConversation() {
    const content = JSON.stringify({ exportedAt: new Date().toISOString(), model: state.model, mode: state.mode, channelId: state.mode === 'channel' ? state.channelId : undefined, messages: state.messages }, null, 2);
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `pulsegate-conversation-${Date.now()}.json`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  onBeforeUnmount(() => { disposed = true; cancelCurrent(); invalidateContext(); });
  return { state, activeChannels, activeKeys, channel, key, models, devMode, latestResponse, latestTrace, canSend, curl, messageList,
    send, stop, retry, resend, resetConversation, trackScroll, attach, installFixtures, saveScenario, changeScenario, importCurl, downloadConversation,
    copy: consoleStore.copy, notify: consoleStore.notify };
}
