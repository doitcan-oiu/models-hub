import { describe, expect, it } from 'vitest';
import { defaultChannelConfig, defaultSettings, type AttemptRecord, type GatewayChannel, type GatewayLog } from '../shared/types';
import type { GatewayContext, GatewayStore } from '../worker/env';
import { handleGateway } from '../worker/gateway';

function setup(path: 'json' | 'sse' | 'redirect') {
  const attempts: AttemptRecord[] = [], logs: GatewayLog[] = [], background: Promise<unknown>[] = [];
  const channel: GatewayChannel = {
    id: 'runtime', name: 'Runtime transport', provider: 'OpenAI', model: 'test', models: ['test'], tags: [], weight: 1, priority: 0,
    endpoint: `https://gateway-runtime.test/${path}`, status: 'healthy', ttft: 0, successRate: 100, requests: 0,
    enabled: true, color: '', history: [], createdAt: new Date().toISOString(), archived: false, credentialCount: 1,
    health: { averageTtft: null, averageDuration: null, samples: 0, cooldownUntil: null, recoveryCount: 0, failureCount: 0, reason: null, autoDisabled: false },
    config: structuredClone(defaultChannelConfig),
  };
  const context: GatewayContext = {
    env: { DEV_MODE: 'true' } as GatewayContext['env'], ctx: { waitUntil(task: Promise<unknown>) { background.push(task); } } as ExecutionContext, channels: [channel],
    settings: { ...defaultSettings, retryEnabled: false, stickyMode: 'off' }, key: null, profile: null, source: 'api',
  };
  const store: GatewayStore = {
    getCredentials: async () => [{ id: 'runtime-key', label: 'runtime', secret: 'runtime-upstream-secret', enabled: true, failureCount: 0, disabledAt: null }],
    recordAttempt: async attempt => { attempts.push(attempt); }, recordLog: async log => { logs.push(log); }, recordEvent: async () => {},
    getRecentAttempts: async () => [], updateHealth: async () => {}, setCredentialHealth: async () => {}, incrementKeyUsage: async () => true,
    nextRoundRobin: async () => 0, getSticky: async () => null, setSticky: async () => {}, getAiGatewayToken: async () => null, reserveChannel: async () => true,
  };
  const request = (stream: boolean) => new Request('https://gateway.test/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ model: 'test', stream, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const flush = async () => { while (background.length) await Promise.all(background.splice(0)); };
  return { context, store, attempts, logs, request, flush };
}

describe('Workerd upstream transport without replacing global fetch', () => {
  it('accepts the manual redirect mode and returns a genuine upstream JSON response', async () => {
    const { context, store, attempts, logs, request } = setup('json');
    const response = await handleGateway(request(false), context, store);
    expect(response.status).toBe(200); expect((await response.json() as any).choices[0].message.content).toBe('runtime JSON reply');
    expect(attempts).toHaveLength(1); expect(attempts[0]).toMatchObject({ status: 200, result: 'success', inputTokens: 3, outputTokens: 2 }); expect(logs[0].tokens).toBe(5);
  });
  it('streams genuine upstream SSE through parsing, TTFT and final usage accounting', async () => {
    const { context, store, attempts, logs, request, flush } = setup('sse');
    const response = await handleGateway(request(true), context, store); const text = await response.text();
    await flush();
    expect(response.status).toBe(200); expect(text).toContain('runtime SSE reply'); expect(text).toContain('[DONE]');
    expect(attempts).toHaveLength(1); expect(attempts[0].ttft).not.toBeNull(); expect(attempts[0]).toMatchObject({ status: 200, result: 'success', inputTokens: 3, outputTokens: 2 }); expect(logs[0].tokens).toBe(5);
  });
  it('does not follow an upstream redirect or forward credentials to its destination', async () => {
    const { context, store, attempts, logs, request } = setup('redirect');
    const response = await handleGateway(request(false), context, store);
    expect(response.status).toBe(302); expect(await response.text()).not.toContain('runtime JSON reply');
    expect(attempts).toHaveLength(1); expect(attempts[0]).toMatchObject({ status: 302, result: 'error' }); expect(logs[0]).toMatchObject({ status: 302, result: 'error' });
  });
});
