import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, nextTick } from 'vue';
import { defaultChannelConfig } from '../shared/types';

type Playground = ReturnType<(typeof import('../src/composables/usePlayground'))['usePlayground']>;
let playground: Playground;
let unmount: () => void;
const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);

beforeEach(async () => {
  vi.resetModules();
  // Ordinary HTTP browsers expose getRandomValues, but randomUUID requires a secure context.
  vi.stubGlobal('crypto', { getRandomValues });
  vi.stubGlobal('window', { location: { hash: '#playground', origin: 'https://gateway.example' }, removeEventListener: vi.fn() });
  const { useConsole } = await import('../src/composables/useConsole');
  const store = useConsole();
  store.session.value = { authenticated: true, devMode: false, configured: true };
  store.channels.value = [{
    id: 'channel', name: 'Main', provider: 'OpenAI', model: 'model', models: ['model'], tags: [], weight: 1,
    endpoint: 'https://upstream.example', status: 'healthy', priority: 0, ttft: 0, successRate: 100,
    requests: 0, enabled: true, color: '', history: [], createdAt: '', archived: false, credentialCount: 1,
    config: structuredClone(defaultChannelConfig),
    health: { averageTtft: null, averageDuration: null, samples: 0, cooldownUntil: null, recoveryCount: 0, failureCount: 0, reason: null, autoDisabled: false },
  }];
  store.keys.value = [{
    id: 'key', name: 'App', preview: 'pg-masked', status: 'active', createdAt: '', expires: '', note: '', used: 0,
    activeProfile: 'profile', profiles: [{ id: 'profile', name: 'Default', scope: 'all', tags: [], match: 'any', channelIds: [], modelMode: 'all', models: [], requestLimit: '', mappings: [] }],
  }];
  const { usePlayground } = await import('../src/composables/usePlayground');
  const renderer = createRenderer({
    insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {},
  });
  const app = renderer.createApp({ setup() { playground = usePlayground(); return () => null; } });
  app.mount({}); unmount = () => app.unmount();
});

afterEach(() => { unmount?.(); vi.unstubAllGlobals(); });

describe('playground without crypto.randomUUID', () => {
  it('initializes, resets and imports conversations with distinct message and thread IDs', async () => {
    const { useConsole } = await import('../src/composables/useConsole');
    const store = useConsole();
    const threadIds: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/playground/chat') {
        threadIds.push(new Headers(options?.headers).get('X-Thread-Id') ?? '');
        return Response.json({ choices: [{ message: { content: 'reply' } }] });
      }
      if (url === '/api/bootstrap') return Response.json({ channels: store.channels.value, keys: store.keys.value, tags: [], settings: store.settings.value });
      if (url === '/api/events') return Response.json({ events: [] });
      throw new Error(`Unexpected request: ${url}`);
    }));

    expect(crypto.randomUUID).toBeUndefined();
    expect(playground.state.model).toBe('model');
    playground.state.stream = false;
    playground.state.input = 'first conversation';
    await playground.send();
    expect(playground.state.messages.map(message => message.content)).toEqual(['first conversation', 'reply']);
    const messageIds = playground.state.messages.map(message => message.id);

    expect(() => playground.resetConversation()).not.toThrow();
    expect(playground.state.messages).toEqual([]);
    playground.state.input = 'second conversation';
    await playground.send();
    messageIds.push(...playground.state.messages.map(message => message.id));

    playground.state.importText = JSON.stringify({ model: 'model', stream: false, messages: [
      { role: 'user', content: 'imported question' }, { role: 'assistant', content: 'imported answer' }, { role: 'user', content: 'next question' },
    ] });
    playground.importCurl();
    expect(playground.state.importError).toBe('');
    expect(playground.state.messages.map(message => message.content)).toEqual(['imported question', 'imported answer']);
    expect(playground.state.input).toBe('next question');
    await playground.send();
    expect(playground.state.messages).toHaveLength(4);
    messageIds.push(...playground.state.messages.map(message => message.id));

    expect(threadIds).toHaveLength(3);
    expect(threadIds.every(Boolean)).toBe(true);
    expect(new Set(threadIds).size).toBe(3);
    expect(messageIds.every(Boolean)).toBe(true);
    expect(new Set(messageIds).size).toBe(messageIds.length);
    expect(playground.state.messages.every(message => !message.error && !message.pending)).toBe(true);
  });
});

describe('playground cURL handling', () => {
  it('exports a shell-expanded API key and safely round-trips shell-sensitive message text', async () => {
    const { curlRequestBody } = await import('../src/composables/usePlayground');
    playground.state.input = 'single quote: \' ; $(command) `command` "double" 中文';
    const command = playground.curl.value;
    expect(command).toContain('-H "Authorization: Bearer $PULSEGATE_API_KEY"');
    expect(command).not.toContain('pg-masked');
    expect(curlRequestBody(command)).toMatchObject({ model: 'model', stream: true, messages: [
      { role: 'system', content: '你是一个有用的助手。' }, { role: 'user', content: playground.state.input },
    ] });
  });

  it('discards pasted credentials after a successful import and keeps the chosen local connection', () => {
    playground.state.curlOpen = true;
    playground.state.importText = 'curl https://other.example/chat -H "Authorization: Bearer upstream-secret" --data \'{"model":"model","messages":[{"role":"user","content":"hello"}],"stream":false}\'';
    playground.importCurl();
    expect(playground.state.importError).toBe('');
    expect(playground.state.importText).toBe('');
    expect(playground.state.input).toBe('hello');
    expect(playground.state.keyId).toBe('key');
    expect(playground.state.stream).toBe(false);
    expect(playground.curl.value).not.toContain('upstream-secret');
    expect(playground.curl.value).toContain('https://gateway.example/v1/chat/completions');
  });

  it('clears pasted credentials when the import dialog is closed after invalid input', async () => {
    playground.state.curlOpen = true;
    await nextTick();
    playground.state.importText = 'curl -H "Authorization: Bearer upstream-secret" --data @private.json';
    playground.importCurl();
    expect(playground.state.importError).not.toBe('');
    playground.state.curlOpen = false;
    await nextTick();
    expect(playground.state.importText).toBe('');
    expect(playground.state.importError).toBe('');
  });
});
