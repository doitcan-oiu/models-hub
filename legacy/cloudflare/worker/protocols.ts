import type { GatewayChannel, GatewaySettings } from '../shared/types';
import { defaultChannelConfig } from '../shared/types';
import { resolveApiUrl, resolveClientApiUrl } from '../shared/upstream-url';
import { parseSSE, StreamFailure } from './sse';

export type ChatBody = Record<string, any> & { model: string; messages: Record<string, any>[]; stream?: boolean };
export class RequestFailure extends Error { constructor(message: string, public status = 400) { super(message); } }
const protectedBody = new Set(['model', 'stream', 'messages', 'contents', 'system', 'systemInstruction']);
const protectedHeaders = new Set(['authorization', 'cf-aig-authorization', 'x-api-key', 'x-goog-api-key', 'host', 'content-length', 'cookie', 'set-cookie', 'connection', 'transfer-encoding']);

const isRecord = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Validate shapes used by routing/conversion before any upstream reservation or health attempt. */
export function validateChatRequest(value: unknown): asserts value is ChatBody {
  if (!isRecord(value) || typeof value.model !== 'string' || !value.model.trim() || !Array.isArray(value.messages) || !value.messages.length) throw new RequestFailure('需要 model 和非空 messages 数组');
  if (value.stream !== undefined && typeof value.stream !== 'boolean') throw new RequestFailure('stream 必须为布尔值');
  for (const field of ['max_tokens', 'max_completion_tokens']) if (value[field] !== undefined && (!Number.isSafeInteger(value[field]) || value[field] <= 0)) throw new RequestFailure(`${field} 必须为正整数`);
  for (const message of value.messages) {
    if (!isRecord(message) || typeof message.role !== 'string') throw new RequestFailure('每条消息都需要 role');
    if (message.content !== undefined && message.content !== null && typeof message.content !== 'string' && (!Array.isArray(message.content) || message.content.some(p => !isRecord(p) || typeof p.type !== 'string'))) throw new RequestFailure('消息 content 必须为文本或有效的内容数组');
    if (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || message.tool_calls.some(t => !isRecord(t) || typeof t.id !== 'string' || !t.id || typeof t.type !== 'string' || (t.type === 'function' && (!isRecord(t.function) || typeof t.function.name !== 'string' || !t.function.name || typeof t.function.arguments !== 'string'))))) throw new RequestFailure('消息 tool_calls 必须为有效的工具调用数组');
    if (message.role === 'tool' && (typeof message.tool_call_id !== 'string' || !message.tool_call_id)) throw new RequestFailure('工具结果需要 tool_call_id');
  }
  if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.some(t => !isRecord(t) || typeof t.type !== 'string' || (t.type === 'function' && (!isRecord(t.function) || typeof t.function.name !== 'string' || !t.function.name))))) throw new RequestFailure('tools 必须为有效的工具定义数组');
  if (value.tool_choice !== undefined && !(typeof value.tool_choice === 'string' ? ['auto', 'none', 'required'].includes(value.tool_choice) : isRecord(value.tool_choice))) throw new RequestFailure('tool_choice 格式无效');
}

export function prepareBody(channel: GatewayChannel, original: ChatBody, model: string): ChatBody {
  const body = structuredClone(original); body.model = model;
  if (channel.config.conversions.systemToUser) body.messages = body.messages.map(m => m.role === 'system' || m.role === 'developer' ? { ...m, role: 'user' } : m);
  for (const [key, value] of Object.entries(channel.config.bodyOverrides)) {
    if (protectedBody.has(key)) throw new RequestFailure(`渠道请求覆盖不允许修改 ${key}`);
    body[key] = value;
  }
  return body;
}

export function prepareRelayBody(channel: GatewayChannel, original: ChatBody, model: string): ChatBody {
  const body = structuredClone(original); body.model = model;
  for (const [key, value] of Object.entries(channel.config.bodyOverrides)) {
    if (protectedBody.has(key)) throw new RequestFailure(`渠道请求覆盖不允许修改 ${key}`);
    body[key] = value;
  }
  return body;
}

function nativeInput(body: ChatBody, channel: GatewayChannel) {
  validateChatRequest(body);
  const common = new Set(['model', 'messages', 'stream', 'stream_options', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'stop', 'tools', 'tool_choice', 'n', 'user', ...(channel.config.protocol === 'anthropic' ? ['thinking', 'top_k', 'metadata', 'output_config'] : ['generationConfig', 'safetySettings', 'cachedContent'])]);
  const extra = Object.keys(body).filter(k => !common.has(k));
  if (!channel.config.conversions.stripUnsupported && extra.length) throw new RequestFailure(`${channel.config.protocol} 原生协议暂不支持参数：${extra.join(', ')}`);
  if (body.n !== undefined && body.n !== 1) throw new RequestFailure('原生协议转换仅支持 n=1');
  if (body.tools?.some((t: any) => t.type !== 'function')) throw new RequestFailure('原生协议转换仅支持 function 工具');
  if (body.tools?.some((t: any) => t.function?.strict)) throw new RequestFailure('原生协议转换暂不支持 strict 工具 schema');
  if (typeof body.tool_choice === 'object' && (body.tool_choice.type !== 'function' || !isRecord(body.tool_choice.function) || typeof body.tool_choice.function.name !== 'string' || !body.tool_choice.function.name)) throw new RequestFailure('原生协议转换仅支持指定 function 工具');
  if (body.messages.some(m => m.tool_calls?.some((t: any) => t.type !== 'function'))) throw new RequestFailure('原生协议转换仅支持 function 工具调用');
  return body;
}

function contentParts(content: unknown, protocol: 'anthropic' | 'gemini'): Record<string, any>[] {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return content ? [{ ...(protocol === 'anthropic' ? { type: 'text' } : {}), text: content }] : [];
  if (!Array.isArray(content)) throw new RequestFailure('消息 content 必须为文本或内容数组');
  return content.map(p => {
    if (p.type === 'text' && typeof p.text === 'string') return { ...(protocol === 'anthropic' ? { type: 'text' } : {}), text: p.text };
    if (p.type !== 'image_url' || typeof p.image_url?.url !== 'string') throw new RequestFailure(`原生协议暂不支持内容类型 ${p.type || 'unknown'}`);
    const url = p.image_url.url; const data = /^data:([^;,]+);base64,(.+)$/s.exec(url);
    if (protocol === 'anthropic') return { type: 'image', source: data ? { type: 'base64', media_type: data[1], data: data[2] } : { type: 'url', url } };
    if (!data) throw new RequestFailure('Gemini 图像输入需要 data:image/...;base64 URL；远程图片请先转换为内联数据');
    return { inlineData: { mimeType: data[1], data: data[2] } };
  });
}

function parseArguments(value: string): Record<string, any> {
  try { const result = JSON.parse(value || '{}'); if (result === null || Array.isArray(result) || typeof result !== 'object') throw new Error(); return result; }
  catch { throw new RequestFailure('工具调用 arguments 必须为 JSON 对象'); }
}

export function toAnthropic(original: ChatBody, channel: GatewayChannel): Record<string, any> {
  const body = nativeInput(original, channel); const systems: any[] = [], messages: any[] = [];
  for (const message of body.messages) {
    if (message.role === 'system' || message.role === 'developer') { const p = contentParts(message.content, 'anthropic'); if (p.some(p => p.type !== 'text')) throw new RequestFailure('系统消息仅支持文本'); systems.push(...p); continue; }
    let role: string; let content: any[];
    if (message.role === 'tool') { role = 'user'; content = [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: typeof message.content === 'string' ? message.content : contentParts(message.content, 'anthropic') }]; }
    else if (message.role === 'assistant' || message.role === 'user') {
      role = message.role; content = contentParts(message.content, 'anthropic');
      const thinking = message.extra_content?.anthropic?.thinking;
      if (message.reasoning_content && !Array.isArray(thinking)) throw new RequestFailure('Anthropic 思考历史需要保留 extra_content.anthropic.thinking 签名数据');
      if (Array.isArray(thinking)) {
        if (thinking.some((p: any) => !isRecord(p) || !['thinking', 'redacted_thinking'].includes(p.type))) throw new RequestFailure('Anthropic 思考历史格式无效');
        content.unshift(...thinking);
      }
      for (const tool of message.tool_calls || []) content.push({ type: 'tool_use', id: tool.id, name: tool.function.name, input: parseArguments(tool.function.arguments) });
    } else throw new RequestFailure(`不支持消息角色 ${message.role}`);
    if (!content.length) throw new RequestFailure('原生协议消息不能为空');
    if (messages.at(-1)?.role === role) messages.at(-1).content.push(...content); else messages.push({ role, content });
  }
  const result: Record<string, any> = { model: body.model, messages, max_tokens: body.max_completion_tokens ?? body.max_tokens ?? 4096, stream: Boolean(body.stream) };
  if (systems.length) result.system = systems;
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stop) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.tools?.length && body.tool_choice !== 'none') result.tools = body.tools.map((t: any) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters || { type: 'object', properties: {} } }));
  if (body.tool_choice && body.tool_choice !== 'none') result.tool_choice = typeof body.tool_choice === 'object' ? { type: 'tool', name: body.tool_choice.function.name } : { type: body.tool_choice === 'required' ? 'any' : 'auto' };
  for (const key of ['thinking', 'top_k', 'metadata', 'output_config']) if (body[key] !== undefined) result[key] = body[key];
  return result;
}

export function toGemini(original: ChatBody, channel: GatewayChannel): Record<string, any> {
  const body = nativeInput(original, channel); const systems: any[] = [], contents: any[] = []; const callNames = new Map<string, string>();
  for (const message of body.messages) {
    if (message.role === 'system' || message.role === 'developer') { const parts = contentParts(message.content, 'gemini'); if (parts.some(p => !('text' in p))) throw new RequestFailure('系统消息仅支持文本'); systems.push(...parts); continue; }
    let role: string; let parts: any[];
    if (message.role === 'tool') {
      role = 'user'; const name = callNames.get(message.tool_call_id); if (!name) throw new RequestFailure('工具结果缺少前文对应的 tool_call_id');
      let result; try { result = JSON.parse(message.content); } catch { result = { result: message.content }; }
      parts = [{ functionResponse: { name, response: result && typeof result === 'object' && !Array.isArray(result) ? result : { result } } }];
    } else if (message.role === 'assistant' || message.role === 'user') {
      role = message.role === 'assistant' ? 'model' : 'user'; parts = contentParts(message.content, 'gemini');
      for (const tool of message.tool_calls || []) {
        callNames.set(tool.id, tool.function.name);
        const signature = tool.extra_content?.google?.thought_signature;
        parts.push({ functionCall: { name: tool.function.name, args: parseArguments(tool.function.arguments) }, ...(signature ? { thoughtSignature: signature } : {}) });
      }
    } else throw new RequestFailure(`不支持消息角色 ${message.role}`);
    if (!parts.length) throw new RequestFailure('原生协议消息不能为空');
    if (contents.at(-1)?.role === role) contents.at(-1).parts.push(...parts); else contents.push({ role, parts });
  }
  const config: Record<string, any> = {};
  if (body.temperature !== undefined) config.temperature = body.temperature;
  if (body.top_p !== undefined) config.topP = body.top_p;
  if (body.max_completion_tokens !== undefined || body.max_tokens !== undefined) config.maxOutputTokens = body.max_completion_tokens ?? body.max_tokens;
  if (body.stop) config.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  const result: Record<string, any> = { contents, generationConfig: { ...(body.generationConfig || {}), ...config } };
  for (const key of ['safetySettings', 'cachedContent']) if (body[key] !== undefined) result[key] = body[key];
  if (systems.length) result.systemInstruction = { parts: systems };
  if (body.tools?.length) result.tools = [{ functionDeclarations: body.tools.map((t: any) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters || { type: 'object', properties: {} } })) }];
  if (body.tool_choice) result.toolConfig = { functionCallingConfig: { mode: body.tool_choice === 'none' ? 'NONE' : body.tool_choice === 'required' || typeof body.tool_choice === 'object' ? 'ANY' : 'AUTO', ...(typeof body.tool_choice === 'object' ? { allowedFunctionNames: [body.tool_choice.function.name] } : {}) } };
  return result;
}

/** Native calls use configured endpoints; relay calls supply their actual client pathname alongside the protocol override. */
export function upstreamUrl(channel: GatewayChannel, settings: GatewaySettings, model: string, stream: boolean, endpointPath?: string, protocolOverride?: GatewayChannel['config']['protocol']): string {
  const config = channel.config;
  const protocol = protocolOverride ?? config.protocol;
  const clientPath = protocolOverride ? endpointPath : undefined;
  const configuredPath = clientPath === '/v1/chat/completions' && config.endpoints.chat !== defaultChannelConfig.endpoints.chat ? config.endpoints.chat
    : clientPath === '/v1/messages' && config.endpoints.messages !== defaultChannelConfig.endpoints.messages ? config.endpoints.messages : undefined;
  const path = configuredPath ?? endpointPath ?? (protocol === 'anthropic' ? config.endpoints.messages : protocol === 'gemini' ? config.endpoints.generate : config.endpoints.chat);
  const resolve = (base: URL) => clientPath && !configuredPath ? resolveClientApiUrl(base, clientPath) : resolveApiUrl(base, path, protocol, model, stream);
  const base = new URL(channel.endpoint);
  if (base.username || base.password) throw new RequestFailure('上游地址不能包含登录凭证；请使用渠道密钥管理');
  const direct = resolve(base);
  if (config.gatewayMode === 'ai-gateway') {
    if (!settings.aiGatewayEnabled || !settings.account || !settings.gateway || !config.customProviderSlug) throw new RequestFailure('请配置 Cloudflare Account、Gateway 和自定义服务商 slug', 503);
    return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(settings.account)}/${encodeURIComponent(settings.gateway)}/custom-${encodeURIComponent(config.customProviderSlug.replace(/^custom-/, ''))}${direct.pathname}${direct.search}`;
  }
  if (config.relayUrl) {
    const relay = new URL(config.relayUrl); if (relay.protocol !== 'https:' && relay.protocol !== 'http:') throw new RequestFailure('中继 URL 无效');
    if (relay.username || relay.password) throw new RequestFailure('中继地址不能包含登录凭证');
    return resolve(relay).toString();
  }
  if (!['http:', 'https:'].includes(direct.protocol)) throw new RequestFailure('上游 URL 仅支持 HTTP(S)');
  return direct.toString();
}

export function upstreamHeaders(channel: GatewayChannel, secret: string, aigToken: string | null, incoming?: Headers, protocolOverride?: GatewayChannel['config']['protocol']): Headers {
  const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' });
  const excluded = new Set(['host', 'content-length', 'content-encoding', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'authorization', 'x-api-key', 'x-goog-api-key', 'cf-aig-authorization', 'cookie']);
  incoming?.forEach((value, key) => { if (!excluded.has(key) && !key.startsWith('x-pulsegate-')) headers.set(key, value); });
  for (const [key, value] of Object.entries(channel.config.headers)) {
    if (protectedHeaders.has(key.toLowerCase())) throw new RequestFailure(`渠道自定义 Header 不允许修改 ${key}`);
    headers.set(key, value);
  }
  const protocol = protocolOverride ?? channel.config.protocol;
  if (protocol === 'anthropic') { headers.set('x-api-key', secret); if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01'); }
  else if (protocol === 'gemini') headers.set('x-goog-api-key', secret);
  else headers.set('Authorization', `Bearer ${secret}`);
  if (channel.config.gatewayMode === 'ai-gateway' && aigToken) headers.set('cf-aig-authorization', `Bearer ${aigToken}`);
  return headers;
}

function finishReason(reason: string | null) { return reason === 'tool_use' ? 'tool_calls' : reason === 'max_tokens' || reason === 'MAX_TOKENS' ? 'length' : reason === 'SAFETY' || reason === 'RECITATION' ? 'content_filter' : reason ? 'stop' : null; }
function baseCompletion(model: string, id = `chatcmpl-${crypto.randomUUID()}`) { return { id, model, created: Math.floor(Date.now() / 1000), object: 'chat.completion' }; }
function usage(prompt = 0, completion = 0) { return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }; }
function anthropicInputTokens(value: any) { return (value?.input_tokens || 0) + (value?.cache_creation_input_tokens || 0) + (value?.cache_read_input_tokens || 0); }
export function normalizeJSON(value: any, channel: GatewayChannel, clientModel: string, preserveAnthropic = false): Record<string, any> {
  if (value.error) throw new StreamFailure(value.error.message || 'Upstream returned an error');
  if (channel.config.protocol === 'openai' || channel.config.protocol === 'mock') {
    if (!Array.isArray(value.choices) || value.choices.some((c: any) => !c || !c.message || typeof c.message !== 'object')) throw new StreamFailure('Upstream returned an invalid chat completion schema');
    return { ...value, model: clientModel };
  }
  if (channel.config.protocol === 'anthropic') {
    if ((value.content || []).some((p: any) => !['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(p.type))) throw new StreamFailure('Unsupported Anthropic response content type');
    const message: any = { role: 'assistant', content: (value.content || []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('') };
    const thinking = (value.content || []).filter((p: any) => p.type === 'thinking').map((p: any) => p.thinking).join(''); if (thinking) message.reasoning_content = thinking;
    const thinkingBlocks = (value.content || []).filter((p: any) => p.type === 'thinking' || p.type === 'redacted_thinking'); if (thinkingBlocks.length) message.extra_content = { anthropic: { thinking: thinkingBlocks } };
    const tools = (value.content || []).filter((p: any) => p.type === 'tool_use').map((p: any) => ({ id: p.id, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.input) } })); if (tools.length) message.tool_calls = tools;
    return { ...baseCompletion(clientModel, value.id), choices: [{ index: 0, message, finish_reason: finishReason(value.stop_reason) }], usage: usage(anthropicInputTokens(value.usage), value.usage?.output_tokens), ...(preserveAnthropic ? { extra_content: { anthropic: { message: { id: value.id, type: 'message', role: 'assistant', model: clientModel, content: value.content, stop_reason: value.stop_reason ?? null, stop_sequence: value.stop_sequence ?? null, usage: value.usage } } } } : {}) };
  }
  const candidates = value.candidates || [];
  return { ...baseCompletion(clientModel), choices: candidates.map((c: any, index: number) => {
    const parts = c.content?.parts || []; const message: any = { role: 'assistant', content: parts.filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join('') };
    if (parts.some((p: any) => p.inlineData || p.fileData || p.executableCode || p.codeExecutionResult)) throw new StreamFailure('Unsupported Gemini multimodal/code response content');
    const thinking = parts.filter((p: any) => p.thought && p.text).map((p: any) => p.text).join(''); if (thinking) message.reasoning_content = thinking;
    const tools = parts.filter((p: any) => p.functionCall).map((p: any) => ({ id: p.functionCall.id || `call_${crypto.randomUUID()}`, type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) }, ...(p.thoughtSignature ? { extra_content: { google: { thought_signature: p.thoughtSignature } } } : {}) })); if (tools.length) message.tool_calls = tools;
    return { index, message, finish_reason: tools.length ? 'tool_calls' : finishReason(c.finishReason) };
  }), usage: usage(value.usageMetadata?.promptTokenCount, (value.usageMetadata?.candidatesTokenCount || 0) + (value.usageMetadata?.thoughtsTokenCount || 0)) };
}

export async function* normalizedStream(body: ReadableStream<Uint8Array>, channel: GatewayChannel, clientModel: string, signal: AbortSignal, preserveAnthropic = false): AsyncGenerator<Record<string, any> | '[DONE]'> {
  const base = { ...baseCompletion(clientModel), object: 'chat.completion.chunk' }; let prompt = 0, completion = 0, finished = false; const tools = new Map<number, number>(), thinking = new Map<number, Record<string, any>>();
  for await (const event of parseSSE(body, signal)) {
    if (event.data === '[DONE]') { finished = true; yield '[DONE]'; break; }
    let value: any; try { value = JSON.parse(event.data); } catch { throw new StreamFailure('Upstream returned malformed SSE JSON'); }
    if (event.event === 'error' || value.error || value.type === 'error') throw new StreamFailure(value.error?.message || value.message || 'Upstream stream error');
    if (channel.config.protocol === 'openai' || channel.config.protocol === 'mock') {
      if (!Array.isArray(value.choices) && !value.usage) continue;
      yield { ...value, model: clientModel }; continue;
    }
    if (channel.config.protocol === 'anthropic') {
      // Native ingress keeps original block ordering/signatures while normalized chunks still drive routing and usage logs.
      if (preserveAnthropic) yield { ...base, choices: [], extra_content: { anthropic: { event: value.type === 'message_start' ? { ...value, message: { ...value.message, model: clientModel } } : value } } };
      if (value.type === 'message_start') { prompt = anthropicInputTokens(value.message?.usage); base.id = value.message?.id || base.id; yield { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }], usage: usage(prompt, 0) }; }
      else if (value.type === 'content_block_start') {
        const block = value.content_block;
        if (block?.type === 'tool_use') { const index = tools.size; tools.set(value.index, index); yield { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index, id: block.id, type: 'function', function: { name: block.name, arguments: block.input && Object.keys(block.input).length ? JSON.stringify(block.input) : '' } }] }, finish_reason: null }] }; }
        else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') { thinking.set(value.index, { ...block }); if (block.thinking) yield { ...base, choices: [{ index: 0, delta: { reasoning_content: block.thinking }, finish_reason: null }] }; }
        else if (block?.type === 'text' && block.text) yield { ...base, choices: [{ index: 0, delta: { content: block.text }, finish_reason: null }] };
      }
      else if (value.type === 'content_block_delta') {
        const d = value.delta; let delta: any = null;
        if (d.type === 'text_delta') delta = { content: d.text };
        if (d.type === 'thinking_delta') { const block = thinking.get(value.index) || { type: 'thinking', thinking: '', signature: '' }; block.thinking += d.thinking; if (block.thinking.length > 1024 * 1024) throw new StreamFailure('Thinking history exceeded 1 MiB'); thinking.set(value.index, block); delta = { reasoning_content: d.thinking }; }
        if (d.type === 'signature_delta') { const block = thinking.get(value.index); if (block) block.signature = (block.signature || '') + d.signature; }
        if (d.type === 'input_json_delta') delta = { tool_calls: [{ index: tools.get(value.index) ?? 0, function: { arguments: d.partial_json } }] };
        if (delta) yield { ...base, choices: [{ index: 0, delta, finish_reason: null }] };
      }
      else if (value.type === 'message_delta') { completion = value.usage?.output_tokens ?? completion; yield { ...base, choices: [{ index: 0, delta: thinking.size ? { extra_content: { anthropic: { thinking: [...thinking.values()] } } } : {}, finish_reason: finishReason(value.delta?.stop_reason) }], usage: usage(prompt, completion) }; }
      else if (value.type === 'message_stop') { finished = true; yield '[DONE]'; break; }
    } else {
      const normalized = normalizeJSON(value, channel, clientModel);
      yield { ...base, choices: normalized.choices.map((c: any) => ({ index: c.index, delta: { ...c.message, ...(c.message.tool_calls ? { tool_calls: c.message.tool_calls.map((t: any, i: number) => ({ index: i, ...t })) } : {}) }, finish_reason: c.finish_reason })), usage: normalized.usage };
      if (value.candidates?.some((c: any) => c.finishReason)) finished = true;
    }
  }
  if (!finished) throw new StreamFailure('Upstream stream ended without completion marker');
  if (channel.config.protocol === 'gemini') yield '[DONE]';
}
