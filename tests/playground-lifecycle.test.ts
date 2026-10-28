import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, nextTick } from 'vue';
import { defaultChannelConfig } from '../shared/types';

type Playground = ReturnType<(typeof import('../src/composables/usePlayground'))['usePlayground']>;
let playground: Playground;
let unmount: () => void;

beforeEach(async () => {
  vi.resetModules();
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
