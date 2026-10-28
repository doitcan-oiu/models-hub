import { describe, expect, it } from 'vitest';
import { relayJSON, relayStream, type RelayFrame } from '../worker/relay';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const clientModel = 'public-model', providerModel = 'private-provider-model';
function frame(value: unknown, event?: string): string {
  return (event ? 'event: ' + event + '\r\n' : '') + 'data: ' + JSON.stringify(value) + '\r\n\r\n';
}
async function observe(raw: string, rewrite = false, chunkSize = 17): Promise<RelayFrame[]> {
  const bytes = encoder.encode(raw);
  const body = new ReadableStream<Uint8Array>({ start(output) {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) output.enqueue(bytes.slice(offset, offset + chunkSize));
    output.close();
  } });
  const frames: RelayFrame[] = [];
  for await (const item of relayStream(body, clientModel, rewrite, new AbortController().signal)) frames.push(item);
  return frames;
}
const returned = (frames: RelayFrame[]) => frames.map(item => decoder.decode(item.bytes)).join('');
const response = (extra: Record<string, unknown> = {}) => ({
  object: 'response', id: 'resp_1', model: providerModel, status: 'in_progress', created_at: 1730000000,
  instructions: 'provider instructions', tools: [{ type: 'web_search' }], tool_choice: 'auto',
  parallel_tool_calls: true, temperature: 1, top_p: 1, store: true, output: [], ...extra,
});

describe('Responses relay observations preserve the original wire response', () => {
  it.each(['response.created', 'response.in_progress', 'response.queued'])('does not count %s metadata as the first output', async type => {
    const raw = frame({ type, sequence_number: 12, response: response() }, type);
    const frames = await observe(raw);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ meaningful: false, done: false, usage: { inputTokens: 0, outputTokens: 0 } });
    expect(returned(frames)).toBe(raw);
  });

  it.each(['response.output_text.delta', 'response.refusal.delta', 'response.function_call_arguments.delta'])('counts nonempty string delta for %s without counting indexes', async type => {
    const metadata = { type, sequence_number: 4, item_id: 'item_1', content_index: 0, output_index: 0, logprobs: [{ token: 'metadata only' }] };
    const raw = frame({ ...metadata, delta: '' }, type) + frame({ ...metadata, delta: type.includes('arguments') ? '{"city":' : '实际内容' }, type);
    const frames = await observe(raw);
    expect(frames.map(item => item.meaningful)).toEqual([false, true]);
    expect(returned(frames)).toBe(raw);
  });

  it('observes event names when a provider omits the JSON type', async () => {
    const raw = frame({ response: response(), sequence_number: 0 }, 'response.created')
      + frame({ delta: 'hello', sequence_number: 1 }, 'response.output_text.delta');
    expect((await observe(raw)).map(item => item.meaningful)).toEqual([false, true]);
  });

  it.each([
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'weather', arguments: '', status: 'in_progress' },
    { type: 'web_search_call', id: 'ws_1', status: 'in_progress' },
    { type: 'tool_output', output: 'tool result' },
    { type: 'function_call_output', call_id: 'call_1', output: 'tool result' },
  ])('counts output_item.added tool/function output $type', async item => {
    const raw = frame({ type: 'response.output_item.added', item, output_index: 0, sequence_number: 1 });
    expect((await observe(raw))[0]).toMatchObject({ meaningful: true, done: false });
  });

  it('waits for message content rather than a new message item or empty content part', async () => {
    const raw = frame({ type: 'response.output_item.added', item: { type: 'message', id: 'msg_1', role: 'assistant', phase: 'final_answer', status: 'in_progress', content: [] }, sequence_number: 1 })
      + frame({ type: 'response.content_part.added', part: { type: 'output_text', text: '', annotations: [], logprobs: [{ token: 'metadata' }] }, item_id: 'msg_1', output_index: 0, content_index: 0, sequence_number: 2 })
      + frame({ type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', url: 'https://example.test' }, item_id: 'msg_1', sequence_number: 3 });
    const frames = await observe(raw);
    expect(frames.map(item => item.meaningful)).toEqual([false, false, false]);
    expect(returned(frames)).toBe(raw);
  });

  it('reads response.completed totals once without adding cached input or reasoning output again', async () => {
    const raw = frame({ type: 'response.created', response: response({ usage: { input_tokens: 100, output_tokens: 0 } }) })
      + frame({ type: 'response.output_text.delta', delta: 'hello', sequence_number: 1 })
      + frame({ type: 'response.completed', response: response({ status: 'completed', usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 }, output_tokens: 25, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 125, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 } }), sequence_number: 2 })
      + ': provider trailer\r\n\r\n';
    const frames = await observe(raw);
    expect(frames[2]).toMatchObject({ meaningful: false, done: true, usage: { inputTokens: 100, outputTokens: 25 } });
    expect(frames[2].error).toBeUndefined();
    expect(frames[3].usage).toEqual({ inputTokens: 100, outputTokens: 25 });
    expect(returned(frames)).toBe(raw);
  });

  it.each(['response.completed', 'response.incomplete'])('accepts actual full output on a single %s frame without treating terminal metadata as content', async type => {
    for (const output of [
      [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'final-only reply', annotations: [] }] }],
      [{ type: 'function_call', id: 'fc_1', name: 'weather', arguments: '{"city":"Paris"}' }],
    ]) {
      const raw = frame({ type, response: response({ status: type.slice(9), output, incomplete_details: type === 'response.incomplete' ? { reason: 'max_output_tokens' } : null, usage: { input_tokens: 5, output_tokens: 3 } }), sequence_number: 9 }, type);
      const frames = await observe(raw);
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ meaningful: true, done: true, usage: { inputTokens: 5, outputTokens: 3 } });
      expect(frames[0].error).toBeUndefined();
      expect(returned(frames)).toBe(raw);
    }
    const empty = frame({ type, response: response({ status: type.slice(9) }), sequence_number: 9 }, type);
    expect((await observe(empty))[0]).toMatchObject({ meaningful: false, done: true });
  });

  it.each([
    { type: 'response.failed', state: response({ status: 'failed', error: { code: 'server_error', message: 'provider failed', extension: true } }), error: 'provider failed' },
    { type: 'response.failed', state: response({ status: 'failed', error: null }), error: 'Upstream response failed' },
    { type: 'response.incomplete', state: response({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), error: undefined },
    { type: 'response.incomplete', state: response({ status: 'incomplete', incomplete_details: null }), error: undefined },
  ])('observes $type terminal status while retaining partial output and the exact event', async ({ type, state, error }) => {
    const raw = frame({ type: 'response.output_text.delta', delta: 'partial', sequence_number: 1 })
      + frame({ type, response: { ...state, usage: { input_tokens: 4, output_tokens: 2 } }, sequence_number: 2 }, type)
      + ': tail\r\n\r\n';
    const frames = await observe(raw);
    expect(frames[0].meaningful).toBe(true);
    expect(frames[1]).toMatchObject({ meaningful: false, done: true, usage: { inputTokens: 4, outputTokens: 2 } });
    expect(frames[1].error).toBe(error);
    expect(returned(frames)).toBe(raw);
  });

  it('retains unfamiliar events, unknown fields, non-JSON data, multiline data, UTF-8 and CR framing', async () => {
    const raw = ': heartbeat 值\r\nid: 7\r\nretry: 1000\r\nevent: response.created\r\ndata: opaque metadata\r\n\r\n'
      + 'event: response.vendor_extension\rdata: {"type":"response.vendor_extension",\rdata: "sequence_number":3,"vendor":{"answer":"未来内容"},"unknown":null}\r\r'
      + 'event: vendor_output\ndata: non-JSON 原文\n\n'
      + ': unterminated trailer 值';
    for (const size of [1, 7, 19]) {
      const frames = await observe(raw, false, size);
      expect(frames.map(item => item.meaningful)).toEqual([false, true, true, false]);
      expect(returned(frames)).toBe(raw);
    }
  });

  it('does not count index-only future Responses events while preserving them', async () => {
    const raw = frame({ type: 'response.future_event', item_id: 'item_1', response_id: 'resp_1', output_index: 4, content_index: 2, sequence_number: 10, unknown: null });
    expect((await observe(raw))[0].meaningful).toBe(false);
    expect(returned(await observe(raw))).toBe(raw);
  });

  it('does not count an empty reasoning summary part or its summary_index as the first output', async () => {
    const raw = frame({ type: 'response.reasoning_summary_part.added', item_id: 'reasoning_1', output_index: 0, summary_index: 4, sequence_number: 7, part: { type: 'summary_text', text: '' } });
    const frames = await observe(raw);
    expect(frames[0]).toMatchObject({ meaningful: false, done: false });
    expect(returned(frames)).toBe(raw);
  });
});

describe('Responses JSON usage, errors and model aliases are observational', () => {
  it.each(['queued', 'in_progress'])('accepts a %s background JSON acknowledgement without treating it as an empty completion', status => {
    const raw = JSON.stringify(response({ background: true, status, output: [], usage: null }), null, 2);
    expect(relayJSON(raw, clientModel, false)).toMatchObject({ text: raw, meaningful: true, error: null, usage: { inputTokens: 0, outputTokens: 0 } });
  });

  it('reads full-response totals and actual content without adding cache or reasoning details', () => {
    const value = response({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer', annotations: [] }] }], usage: { input_tokens: 13, input_tokens_details: { cached_tokens: 9 }, output_tokens: 7, output_tokens_details: { reasoning_tokens: 4 } }, extension: { nullable: null } });
    const raw = JSON.stringify(value, null, 2), observed = relayJSON(raw, clientModel, false);
    expect(observed).toMatchObject({ text: raw, meaningful: true, usage: { inputTokens: 13, outputTokens: 7 }, error: null });
    expect(relayJSON(JSON.stringify(response({ status: 'completed' })), clientModel, false).meaningful).toBe(false);
    expect(relayJSON(JSON.stringify(response({ vendor_result: { answer: 'new provider payload' } })), clientModel, false).meaningful).toBe(true);
  });

  it.each([
    { status: 'failed', error: { message: 'failed JSON response' } },
    { status: 'incomplete', incomplete_details: { reason: 'content_filter' } },
  ])('observes $status JSON status without modifying its body', extra => {
    const raw = JSON.stringify(response(extra), null, 2), observed = relayJSON(raw, clientModel, false);
    expect(observed.text).toBe(raw);
    if (extra.status === 'failed') expect(observed.error).toBe('failed JSON response');
    else expect(observed.error).toBeNull();
  });

  it('rewrites only existing response.model and top-level model, including free-form metadata values', async () => {
    const value = { type: 'response.completed', model: null, response: response({ model: { vendor: true }, metadata: { model: 'keep-nested' }, usage: { input_tokens: 3, output_tokens: 1 } }), vendor: { model: 'keep-vendor' } };
    const raw = ': header\r\nid: alias\r\nretry: 5\r\nevent: response.completed\r\ndata: ' + JSON.stringify(value) + '\r\n\r\n';
    expect(returned(await observe(raw, false))).toBe(raw);
    const changed = { ...value, model: clientModel, response: { ...value.response, model: clientModel } };
    expect(returned(await observe(raw, true))).toBe(raw.replace(JSON.stringify(value), JSON.stringify(changed)));
    expect(JSON.parse(relayJSON(JSON.stringify(value), clientModel, true).text)).toEqual(changed);
    const noModel = { type: 'response.completed', response: { status: 'completed', vendor: true } };
    expect(relayJSON(JSON.stringify(noModel), clientModel, true).text).toBe(JSON.stringify(noModel));
  });

  it('preserves non-JSON and unfamiliar JSON outputs without requiring a Responses schema', () => {
    for (const raw of ['opaque response 值', '{"vendor":{"answer":"future"},"usage_extension":null}', '[{"future":"reply"}]']) {
      expect(relayJSON(raw, clientModel, true)).toMatchObject({ text: raw, meaningful: true, error: null });
    }
  });

  it('keeps opaque vendor response.model fields intact when aliases rewrite the actual model', async () => {
    const value = { type: 'vendor.result', model: providerModel, response: { model: 'opaque-metadata', answer: 'keep' } };
    const expected = { ...value, model: clientModel };
    expect(JSON.parse(relayJSON(JSON.stringify(value), clientModel, true).text)).toEqual(expected);
    const observed = await observe(frame(value, 'vendor.result'), true);
    expect(returned(observed)).toBe(frame(expected, 'vendor.result'));
  });

  it('retains Chat and Anthropic token accounting and first-output behavior', async () => {
    expect(relayJSON('{"choices":[{"message":{"content":"chat"}}],"usage":{"prompt_tokens":10,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":8}},"response":{"vendor":"metadata"}}', clientModel, false).usage).toEqual({ inputTokens: 10, outputTokens: 3 });
    const raw = frame({ type: 'message_start', message: { model: providerModel, usage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 5 } } }, 'message_start')
      + frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'native' } }, 'content_block_delta')
      + frame({ type: 'message_delta', usage: { output_tokens: 3 } }, 'message_delta')
      + frame({ type: 'message_stop' }, 'message_stop');
    const frames = await observe(raw);
    expect(frames.map(item => item.meaningful)).toEqual([false, true, false, false]);
    expect(frames[2].usage).toEqual({ inputTokens: 17, outputTokens: 3 });
    expect(returned(frames)).toBe(raw);
  });
});
