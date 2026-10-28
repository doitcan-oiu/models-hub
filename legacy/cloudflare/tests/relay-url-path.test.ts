import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../shared/types';
import { resolveClientApiUrl } from '../shared/upstream-url';
import { channel as parseChannel } from '../worker/validation';
import { upstreamUrl } from '../worker/protocols';

const origin = 'https://upstream.example';
const bases = [
  ['', '/v1'], ['/', '/v1'], ['/v1', '/v1'], ['/v1/', '/v1'],
  ['/tenant', '/tenant/v1'], ['/tenant/', '/tenant/v1'], ['/tenant/v1', '/tenant/v1'], ['/tenant/v1/', '/tenant/v1'],
] as const;
const channel = (prefix = '') => parseChannel({ name: 'Relay URL', endpoint: origin + prefix, models: ['upstream-model'], config: { protocol: 'gemini' } }, false);

describe('transparent client API pathname resolution', () => {
  it.each(bases)('preserves the deployment base %s and shares its API version only once', (prefix, expected) => {
    const upstream = channel(prefix);
    for (const endpoint of ['responses', 'responses/compact', 'future/action', 'chat/completions', 'messages']) {
      const protocol = endpoint === 'messages' ? 'anthropic' : 'openai';
      const target = upstreamUrl(upstream, defaultSettings, 'model/name', true, '/v1/' + endpoint, protocol);
      expect(target).toBe(origin + expected + '/' + endpoint);
      expect(new URL(target).origin).toBe(origin);
    }
  });

  it.each(bases)('resolves an HTTPS relay base %s independently of the direct upstream deployment', (prefix, expected) => {
    const upstream = channel('/different-deployment/v1');
    upstream.config.relayUrl = 'https://relay.example' + prefix;
    for (const endpoint of ['responses', 'responses/compact', 'future/action']) {
      expect(upstreamUrl(upstream, defaultSettings, 'upstream-model', false, '/v1/' + endpoint, 'openai')).toBe('https://relay.example' + expected + '/' + endpoint);
    }
  });

  it.each(bases)('keeps the resolved deployment %s inside a custom AI Gateway provider URL', (prefix, expected) => {
    const upstream = channel(prefix);
    upstream.config.gatewayMode = 'ai-gateway'; upstream.config.customProviderSlug = 'custom-relay';
    const settings = { ...defaultSettings, aiGatewayEnabled: true, account: 'account', gateway: 'gateway' };
    expect(upstreamUrl(upstream, settings, 'upstream-model', true, '/v1/responses/compact', 'openai')).toBe('https://gateway.ai.cloudflare.com/v1/account/gateway/custom-relay' + expected + '/responses/compact');
  });

  it('uses explicit Chat and Messages endpoint overrides only for their corresponding client routes', () => {
    const upstream = channel();
    upstream.config.endpoints.chat = '/v2/custom/chat'; upstream.config.endpoints.messages = '/custom/messages';
    expect(upstreamUrl(upstream, defaultSettings, 'upstream-model', false, '/v1/chat/completions', 'openai')).toBe(origin + '/v2/custom/chat');
    expect(upstreamUrl(upstream, defaultSettings, 'upstream-model', false, '/v1/messages', 'anthropic')).toBe(origin + '/custom/messages');
    expect(upstreamUrl(upstream, defaultSettings, 'upstream-model', false, '/v1/responses', 'openai')).toBe(origin + '/v1/responses');
    expect(upstreamUrl(upstream, defaultSettings, 'upstream-model', false, '/v1/responses/compact', 'openai')).toBe(origin + '/v1/responses/compact');
    upstream.endpoint += '/tenant/v1'; upstream.config.endpoints.chat = '/tenant/v1/special/chat';
    expect(upstreamUrl(upstream, defaultSettings, 'upstream-model', false, '/v1/chat/completions', 'openai')).toBe(origin + '/tenant/v1/special/chat');
    upstream.config.relayUrl = 'https://relay.example';
    expect(upstreamUrl(upstream, defaultSettings, 'upstream-model', false, '/v1/messages', 'anthropic')).toBe('https://relay.example/custom/messages');
  });

  it('leaves native management and probe endpoint/version conversion behavior unchanged', () => {
    const upstream = channel('/tenant'); upstream.config.protocol = 'openai';
    expect(upstreamUrl(upstream, defaultSettings, 'upstream-model', false)).toBe(origin + '/tenant/chat/completions');
    upstream.config.protocol = 'anthropic';
    expect(upstreamUrl(upstream, defaultSettings, 'upstream-model', false)).toBe(origin + '/tenant/messages');
    upstream.endpoint = origin; upstream.config.protocol = 'gemini';
    expect(upstreamUrl(upstream, defaultSettings, 'model/name', true)).toBe(origin + '/v1beta/models/model%2Fname:streamGenerateContent?alt=sse');
  });

  it('preserves opaque escaped pathname segments and any configured query without normalizing them into model or Chat paths', () => {
    const base = new URL(origin + '/tenant/v1?deployment=one%20two&deployment=three');
    const resolved = resolveClientApiUrl(base, '/v1/future/opaque%2Fidentifier/action');
    expect(resolved.href).toBe(origin + '/tenant/v1/future/opaque%2Fidentifier/action?deployment=one%20two&deployment=three');
    expect(resolveClientApiUrl(new URL(origin + '/tenant/v1'), '/tenant/v1/responses').href).toBe(origin + '/tenant/v1/responses');
  });

  it.each([
    'https://foreign.example/v1/responses', '//foreign.example/v1/responses',
    '/v1/../admin', '/v1/%2e%2e/admin', '/v1/%2e%2e%2fadmin', '/v1\\..\\admin',
    '/v1/responses?escape=1', '/v1/responses#fragment', '/v1/line\nbreak',
  ])('rejects an unsafe client pathname without leaving the configured origin or deployment (%#)', pathname => {
    for (const prefix of ['', '/tenant', '/tenant/v1']) expect(() => resolveClientApiUrl(new URL(origin + prefix), pathname)).toThrow();
  });
});
