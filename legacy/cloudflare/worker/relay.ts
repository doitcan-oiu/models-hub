import { StreamFailure } from './sse';

export type RelayUsage = { inputTokens: number; outputTokens: number };
export type RelayFrame = { bytes: Uint8Array; usage: RelayUsage; meaningful: boolean; done: boolean; error?: string };
type ObjectValue = Record<string, any>;
type UsageState = { usage: RelayUsage; anthropic: ObjectValue; gemini: ObjectValue };

const encoder = new TextEncoder(), decoder = new TextDecoder();
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const initialUsage = (): UsageState => ({ usage: { inputTokens: 0, outputTokens: 0 }, anthropic: {}, gemini: {} });

function responseType(value: unknown, event = ''): string {
  return object(value) && typeof value.type === 'string' && value.type.startsWith('response.') ? value.type : event.startsWith('response.') ? event : '';
}
const responseTerminals = new Set(['response.completed', 'response.failed', 'response.incomplete']);
const responseControls = new Set(['response.created', 'response.in_progress', 'response.queued', ...responseTerminals]);
function responseEnvelope(value: ObjectValue, event = ''): ObjectValue | undefined {
  if (value.object === 'response') return value;
  if (object(value.response) && (responseType(value, event) || value.response.object === 'response')) return value.response;
  return undefined;
}

function observeUsage(value: unknown, state: UsageState, event = ''): RelayUsage {
  if (!object(value)) return { ...state.usage };
  const response = responseEnvelope(value, event);
  const responses = !!response || value.object === 'response' || !!responseType(value, event);
  const usage = object(response?.usage) ? response.usage : object(value.usage) ? value.usage : object(value.message?.usage) ? value.message.usage : undefined;
  if (usage) {
    if (responses) {
      // Responses input/output totals already include cached input and reasoning output.
      if (count(usage.input_tokens)) state.usage.inputTokens = usage.input_tokens;
      if (count(usage.output_tokens)) state.usage.outputTokens = usage.output_tokens;
      return { ...state.usage };
    }
    if (count(usage.prompt_tokens)) state.usage.inputTokens = usage.prompt_tokens;
    if (count(usage.completion_tokens)) state.usage.outputTokens = usage.completion_tokens;
    let native = false;
    for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
      if (count(usage[key])) { state.anthropic[key] = usage[key]; native = true; }
    }
    if (native) {
      state.usage.inputTokens = Math.min(Number.MAX_SAFE_INTEGER, (state.anthropic.input_tokens ?? 0) + (state.anthropic.cache_creation_input_tokens ?? 0) + (state.anthropic.cache_read_input_tokens ?? 0));
      state.usage.outputTokens = state.anthropic.output_tokens ?? 0;
    }
  }
  if (object(value.usageMetadata)) {
    for (const key of ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount']) if (count(value.usageMetadata[key])) state.gemini[key] = value.usageMetadata[key];
    state.usage = { inputTokens: state.gemini.promptTokenCount ?? 0, outputTokens: Math.min(Number.MAX_SAFE_INTEGER, (state.gemini.candidatesTokenCount ?? 0) + (state.gemini.thoughtsTokenCount ?? 0)) };
  }
  return { ...state.usage };
}

const metadataFields = new Set(['type', 'id', 'name', 'index', 'model', 'signature', 'citations', 'cache_control', 'metadata', 'usage', 'status', 'state', 'stop_reason', 'stop_sequence']);
function payload(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (text(item) || typeof item === 'number' && Number.isFinite(item) || typeof item === 'boolean') return true;
    if (Array.isArray(item)) { for (const child of item) pending.push(child); }
    else if (object(item)) for (const [key, child] of Object.entries(item)) {
      if (!metadataFields.has(key.toLowerCase()) && !/(?:metadata|annotation|signature|cache_control|usage|status)$/i.test(key)) pending.push(child);
    }
  }
  return false;
}

function block(value: unknown, generic = true): boolean {
  if (typeof value === 'string') return value.length > 0;
  if (!object(value)) return false;
  const type = typeof value.type === 'string' ? value.type : '';
  if (text(value.text) || text(value.thinking) || text(value.reasoning_content) || text(value.reasoning) || text(value.refusal) || text(value.partial_json)) return true;
  if (type === 'signature_delta' || /(?:metadata|signature|status)$/.test(type)) return false;
  if (type.includes('tool_use') && (text(value.id) || text(value.name))) return true;
  if (Array.isArray(value.tool_calls) && value.tool_calls.some((call: unknown) => object(call) && (text(call.id) || text(call.function?.name) || text(call.function?.arguments)))) return true;
  if (object(value.function_call) && (text(value.function_call.name) || text(value.function_call.arguments))) return true;
  if (object(value.functionCall) && (text(value.functionCall.name) || payload(value.functionCall.args))) return true;
  if (typeof value.content === 'string') return value.content.length > 0;
  if (Array.isArray(value.content) && value.content.some(part => block(part))) return true;
  if (Array.isArray(value.parts) && value.parts.some(part => block(part))) return true;
  if (!generic || ['text', 'text_delta', 'thinking', 'thinking_delta', 'input_json_delta'].includes(value.type)) return false;
  return payload(value);
}

const responseMetadata = new Set(['sequence_number', 'item_id', 'output_index', 'content_index', 'summary_index', 'response_id', 'logprobs', 'obfuscation', 'phase']);
function responsePayload(value: ObjectValue, extra: string[] = []): boolean {
  return payload(Object.fromEntries(Object.entries(value).filter(([key]) => !responseMetadata.has(key) && !extra.includes(key))));
}
function responseOutput(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(responseOutput);
  if (!object(value)) return payload(value);
  if (value.type === 'output_text') return text(value.text);
  if (value.type === 'refusal') return text(value.refusal);
  if (value.type === 'message') return responseOutput(value.content) || responsePayload(value, ['role', 'content']);
  if (typeof value.type === 'string' && /(?:function_call|tool|_call$)/.test(value.type)) return text(value.id) || text(value.call_id) || text(value.name) || payload(value);
  return block(value);
}
const responseConfiguration = ['object', 'created_at', 'completed_at', 'background', 'billing', 'conversation', 'instructions', 'max_output_tokens', 'max_tool_calls', 'parallel_tool_calls', 'previous_response_id', 'prompt', 'prompt_cache_key', 'prompt_cache_retention', 'reasoning', 'safety_identifier', 'service_tier', 'store', 'temperature', 'text', 'tool_choice', 'tools', 'top_logprobs', 'top_p', 'truncation', 'user', 'incomplete_details', 'error', 'output', 'output_text'];

function meaningfulJSON(value: unknown, raw: string): boolean {
  if (object(value)) {
    // A queued/running JSON response confirms creation of an asynchronous task.
    // Retrying it as "empty" could create the same background work twice.
    if (value.object === 'response' && ['queued', 'in_progress'].includes(value.status)) return true;
    if (value.object === 'response') return responseOutput(value.output) || text(value.output_text) || responsePayload(value, responseConfiguration);
    if (object(value.response) && responseType(value)) return meaningfulStream(value, '');
    if (Array.isArray(value.choices)) return value.choices.some(choice => object(choice) && block(choice.message ?? choice.delta, false));
    if (Array.isArray(value.candidates)) return value.candidates.some(candidate => object(candidate) && block(candidate.content));
    if (Object.hasOwn(value, 'content')) return block({ content: value.content });
    // Unknown JSON schemas can be valid job acknowledgments containing only an id/status.
    return Object.keys(value).length > 0;
  }
  return value === undefined ? raw.trim().length > 0 : payload(value);
}

function meaningfulStream(value: unknown, event: string): boolean {
  if (!object(value)) return payload(value);
  const responseEvent = responseType(value, event);
  if (responseEvent) {
    if (responseEvent === 'response.completed' || responseEvent === 'response.incomplete') {
      const response = responseEnvelope(value, event);
      return !!response && (responseOutput(response.output) || text(response.output_text));
    }
    if (responseControls.has(responseEvent)) return false;
    if (['response.output_text.delta', 'response.refusal.delta', 'response.function_call_arguments.delta'].includes(responseEvent)) return text(value.delta);
    if (['response.output_item.added', 'response.output_item.done'].includes(responseEvent)) return responseOutput(value.item);
    if (['response.content_part.added', 'response.content_part.done'].includes(responseEvent)) return responseOutput(value.part);
    return responsePayload(value);
  }
  if (Array.isArray(value.choices)) return value.choices.some(choice => object(choice) && block(choice.delta ?? choice.message, false));
  if (Array.isArray(value.candidates)) return value.candidates.some(candidate => object(candidate) && block(candidate.content));
  const type = typeof value.type === 'string' ? value.type : event;
  if (['message_start', 'message_delta', 'message_stop', 'ping', 'error'].includes(type) || ['message_start', 'message_delta', 'message_stop', 'ping', 'error'].includes(event)) return false;
  if (object(value.content_block)) return block(value.content_block);
  if (object(value.delta)) return block(value.delta, type === 'content_block_delta' || event === 'content_block_delta');
  return payload(value);
}

function diagnostic(value: unknown, event?: string): string | null {
  if (object(value) && value.error) return typeof value.error === 'string' ? value.error : typeof value.error.message === 'string' ? value.error.message : 'Upstream returned an error';
  const response = object(value) ? responseEnvelope(value, event) : undefined;
  if (response?.error) return typeof response.error === 'string' ? response.error : typeof response.error.message === 'string' ? response.error.message : 'Upstream returned an error';
  const type = responseType(value, event);
  if (type === 'response.failed' || response?.status === 'failed') return 'Upstream response failed';
  if (event === 'error' || object(value) && value.type === 'error') return object(value) && typeof value.message === 'string' ? value.message : typeof value === 'string' ? value : 'Upstream returned an error';
  return null;
}

function models(value: unknown, clientModel: string, event?: string): { value: unknown; changed: boolean } {
  if (!object(value)) return { value, changed: false };
  let result = value;
  if (Object.hasOwn(value, 'model') && value.model !== clientModel) result = { ...result, model: clientModel };
  if (object(value.response) && responseEnvelope(value, event) === value.response && Object.hasOwn(value.response, 'model') && value.response.model !== clientModel) result = { ...result, response: { ...value.response, model: clientModel } };
  if ((value.type === 'message_start' || event === 'message_start') && object(value.message) && Object.hasOwn(value.message, 'model') && value.message.model !== clientModel) result = { ...result, message: { ...value.message, model: clientModel } };
  return { value: result, changed: result !== value };
}

function parse(raw: string): unknown { try { return JSON.parse(raw); } catch { return undefined; } }

/** Response parsing is observational. Unfamiliar JSON and non-JSON bodies remain valid relay output. */
export function relayJSON(raw: string, clientModel: string, rewriteModel: boolean): { text: string; usage: RelayUsage; meaningful: boolean; error: string | null } {
  const value = parse(raw), replacement = rewriteModel ? models(value, clientModel) : { value, changed: false };
  return { text: replacement.changed ? JSON.stringify(replacement.value) : raw, usage: observeUsage(value, initialUsage()), meaningful: meaningfulJSON(value, raw), error: diagnostic(value) };
}

type Line = { start: number; contentEnd: number; end: number; prefixEnd: number; data: boolean; colon: boolean };
function lines(bytes: Uint8Array): { lines: Line[]; data: string | undefined; event: string } {
  const result: Line[] = [], values: string[] = []; let event = 'message', start = 0;
  while (start < bytes.length) {
    let contentEnd = start;
    while (contentEnd < bytes.length && bytes[contentEnd] !== 10 && bytes[contentEnd] !== 13) contentEnd++;
    const end = contentEnd < bytes.length ? contentEnd + (bytes[contentEnd] === 13 && bytes[contentEnd + 1] === 10 ? 2 : 1) : contentEnd;
    const raw = decoder.decode(bytes.subarray(start, contentEnd)), colon = raw.indexOf(':'), key = colon < 0 ? raw : raw.slice(0, colon);
    const content = colon < 0 ? '' : raw.slice(colon + 1).replace(/^ /, '');
    let prefixEnd = start + (colon < 0 ? raw.length : colon + 1);
    if (colon >= 0 && bytes[prefixEnd] === 32) prefixEnd++;
    if (key === 'data') values.push(content);
    if (key === 'event') event = content;
    result.push({ start, contentEnd, end, prefixEnd, data: key === 'data', colon: colon >= 0 });
    start = end;
  }
  return { lines: result, data: values.length ? values.join('\n') : undefined, event };
}

function concatenate(parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0)); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

function observeFrame(bytes: Uint8Array, clientModel: string, rewriteModel: boolean, state: UsageState): RelayFrame {
  const info = lines(bytes), value = info.data === undefined ? undefined : parse(info.data);
  const replacement = rewriteModel ? models(value, clientModel, info.event) : { value, changed: false };
  if (replacement.changed) {
    const parts: Uint8Array[] = []; let replaced = false;
    for (const line of info.lines) {
      if (!line.data) parts.push(bytes.subarray(line.start, line.end));
      else if (!replaced) {
        parts.push(bytes.subarray(line.start, line.prefixEnd));
        if (!line.colon) parts.push(encoder.encode(': '));
        parts.push(encoder.encode(JSON.stringify(replacement.value)), bytes.subarray(line.contentEnd, line.end)); replaced = true;
      }
    }
    bytes = concatenate(parts);
  }
  const error = diagnostic(value, info.event);
  const done = info.data?.trim() === '[DONE]' || info.event === 'message_stop' || object(value) && value.type === 'message_stop' || responseTerminals.has(responseType(value, info.event));
  const controlEvent = ['message_start', 'message_delta', 'message_stop', 'ping', 'error'].includes(info.event) || responseControls.has(info.event) || /(?:metadata|signature|status)$/.test(info.event);
  const terminalContent = done && object(value) && ['response.completed', 'response.incomplete'].includes(responseType(value, info.event)) && meaningfulStream(value, info.event);
  const meaningful = info.data !== undefined && (terminalContent || !done && !controlEvent && (value === undefined ? info.data.trim().length > 0 : meaningfulStream(value, info.event)));
  return { bytes, usage: observeUsage(value, state, info.event), meaningful, done, ...(error !== null ? { error } : {}) };
}

/** A byte scanner retains the complete original SSE framing, even for comments or non-JSON data.
 * Terminal markers are observed, but the iterator itself also accepts normal EOF without a marker.
 */
export async function* relayStream(body: ReadableStream<Uint8Array>, clientModel: string, rewriteModel: boolean, signal: AbortSignal): AsyncGenerator<RelayFrame> {
  const reader = body.getReader(), state = initialUsage(); let parts: Uint8Array[] = [], lineLength = 0, pendingCR = false, blankCR = false;
  let frameSize = 0;
  const countByte = () => { if (++frameSize > 1024 * 1024) throw new StreamFailure('Upstream SSE event exceeded 1 MiB'); };
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const frame = () => { const result = observeFrame(concatenate(parts), clientModel, rewriteModel, state); parts = []; frameSize = 0; return result; };
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
      const { value, done } = await reader.read();
      if (signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
      if (done) break;
      let offset = 0;
      for (let i = 0; i < value.length; i++) {
        if (signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
        const byte = value[i];
        if (pendingCR) {
          pendingCR = false; lineLength = 0;
          if (byte === 10) {
            countByte();
            parts.push(value.subarray(offset, i + 1)); offset = i + 1;
            if (blankCR) yield frame();
            continue;
          }
          if (blankCR) yield frame();
        }
        countByte();
        if (byte === 13) { parts.push(value.subarray(offset, i + 1)); offset = i + 1; pendingCR = true; blankCR = lineLength === 0; }
        else if (byte === 10) {
          if (lineLength === 0) { parts.push(value.subarray(offset, i + 1)); offset = i + 1; yield frame(); }
          lineLength = 0;
        } else lineLength++;
      }
      if (offset < value.length) parts.push(value.subarray(offset));
    }
    if (parts.length) yield frame();
  } finally {
    signal.removeEventListener('abort', abort);
    // Cancellation closes pending reads immediately; an underlying source's cleanup
    // promise must not hold this generator, downstream cancellation, or logging open.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
