import { describe, expect, it } from 'vitest';
import { editableRequestLimit, modelsForProfile, requestLimitLabel } from '../src/access-policy';
import { defaultChannelConfig } from '../shared/types';
import type { GatewayChannel, KeyProfile } from '../shared/types';

function channel(id: string, models: string[], patch: Partial<GatewayChannel> = {}): GatewayChannel {
  return {
    id, name: id, provider: 'OpenAI', model: models[0], models, tags: ['production'], weight: 1,
    endpoint: 'https://example.test/v1', status: 'healthy', priority: 0, ttft: 0, successRate: 100,
    requests: 0, enabled: true, color: '', history: [], createdAt: '2026-10-13T00:00:00Z',
    archived: false, credentialCount: 1, config: structuredClone(defaultChannelConfig),
    health: { averageTtft: null, averageDuration: null, samples: 0, cooldownUntil: null, recoveryCount: 0, failureCount: 0, reason: null, autoDisabled: false },
    ...patch,
  };
}

function profile(patch: Partial<KeyProfile> = {}): KeyProfile {
  return {
    id: 'p', name: 'Profile', scope: 'all', tags: [], match: 'any', channelIds: [], modelMode: 'all',
    models: [], requestLimit: '', mappings: [], ...patch,
  };
}

describe('frontend API Key access and quota compatibility', () => {
  it('keeps the public mapping name when its target is on the model whitelist', () => {
    const selected = profile({ modelMode: 'selected', models: ['stable'], mappings: [
      { from: 'public-model', to: ['stable'] }, { from: 'blocked-model', to: ['expensive'] },
    ] });
    expect(modelsForProfile([channel('main', ['stable', 'expensive'])], selected)).toEqual(['stable', 'public-model']);
  });

  it('excludes mapping targets outside the selected channel or tag scope', () => {
    const channels = [channel('main', ['stable']), channel('outside', ['expensive'], { tags: ['other'] })];
    const selected = profile({ scope: 'tags', tags: ['production'], mappings: [
      { from: 'public-model', to: ['stable'] }, { from: 'blocked-model', to: ['expensive'] },
    ] });
    expect(modelsForProfile(channels, selected)).toEqual(['stable', 'public-model']);
    expect(modelsForProfile(channels, { ...selected, scope: 'channels', channelIds: ['main'] })).toEqual(['stable', 'public-model']);
    expect(modelsForProfile(channels, { ...selected, tags: [], match: 'none' })).toEqual([]);
  });

  it('honors mapping precedence when its entry shadows a physical model', () => {
    const selected = profile({ modelMode: 'selected', models: ['stable'], mappings: [{ from: 'stable', to: ['expensive'] }] });
    expect(modelsForProfile([channel('main', ['stable', 'expensive'])], selected)).toEqual([]);
  });

  it('distinguishes an authorization preview from the public list without exposing archived models', () => {
    const channels = [channel('main', ['stable']), channel('disabled', ['paused'], { enabled: false }), channel('archived', ['retired'], { archived: true })];
    expect(modelsForProfile(channels, profile())).toEqual(['stable']);
    expect(modelsForProfile(channels, profile(), true)).toEqual(['stable', 'paused']);
  });

  it.each(['', '0', '无限制', 'unlimited'])('loads the legal unlimited quota %j into an empty editable field', value => {
    expect(editableRequestLimit(value)).toBe('');
    expect(requestLimitLabel(value)).toBe('不限');
  });

  it('preserves finite cumulative quota and never renders an invalid value as NaN', () => {
    expect(editableRequestLimit('1000')).toBe('1000');
    expect(requestLimitLabel('1000')).toBe('1,000 次');
    expect(requestLimitLabel('not-a-quota')).toBe('配置无效');
    expect(requestLimitLabel('99999999999999999999')).toBe('配置无效');
  });
});
