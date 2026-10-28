import { describe, expect, it } from 'vitest';
import { channelColumns, channelWebsite, defaultChannelColumns, readChannelViewPreference } from '../src/channel-view';

const preference = (columns: unknown, size: unknown = 20) => JSON.stringify({ columns, size });
const oldDefaults = ['enabled', 'health', 'models'];
const oldAllColumns = ['priority', 'enabled', 'health', 'models', 'provider', 'weight', 'createdAt'];

describe('channel view preferences', () => {
  it('starts with separate tags and balance columns and returns independent defaults', () => {
    const first = readChannelViewPreference(null);
    expect(first).toEqual({ size: 20, columns: ['tags', 'balance', 'enabled', 'health'] });
    expect(channelColumns.map(column => column.key)).toEqual(['tags', 'balance', 'enabled', 'health', 'models', 'priority', 'provider', 'weight', 'createdAt']);
    first.columns.pop();
    expect(readChannelViewPreference(null).columns).toEqual(defaultChannelColumns);
  });

  it('migrates the old defaults without changing the saved page size', () => {
    expect(readChannelViewPreference(null, preference(oldDefaults, 50))).toEqual({ size: 50, columns: defaultChannelColumns });
    expect(readChannelViewPreference(null, null, preference([...oldAllColumns].reverse(), 100))).toEqual({ size: 100, columns: defaultChannelColumns });
  });

  it('preserves deliberately customized and empty legacy views without adding hidden columns', () => {
    for (const columns of [[], ['provider', 'models'], [...oldDefaults, 'weight'], oldAllColumns]) {
      expect(readChannelViewPreference(null, preference(columns, 10))).toEqual({ size: 10, columns });
    }
    expect(readChannelViewPreference(null, null, preference(oldDefaults))).toEqual({ size: 20, columns: oldDefaults });
    expect(readChannelViewPreference(null, null, preference([]))).toEqual({ size: 20, columns: [] });
  });

  it('gives the current version priority and never migrates current user choices', () => {
    expect(readChannelViewPreference(preference(oldDefaults, 10), preference(['provider'], 50))).toEqual({ size: 10, columns: oldDefaults });
    expect(readChannelViewPreference(preference([]), preference(oldDefaults))).toEqual({ size: 20, columns: [] });
    expect(readChannelViewPreference(null, preference(['provider']), preference(oldAllColumns))).toEqual({ size: 20, columns: ['provider'] });
  });

  it('falls back to older versions for corrupt JSON and non-object preferences', () => {
    for (const current of ['{broken', 'null', '[]', '42', 'true', '"text"', '']) {
      expect(readChannelViewPreference(current, preference(['balance'], 50))).toEqual({ size: 50, columns: ['balance'] });
    }
    expect(readChannelViewPreference('{broken', 'null', preference(oldAllColumns, 10))).toEqual({ size: 10, columns: defaultChannelColumns });
    expect(readChannelViewPreference('[]', 'false', '{}')).toEqual({ size: 20, columns: defaultChannelColumns });
  });

  it('validates fields independently and removes duplicate or unknown columns', () => {
    expect(readChannelViewPreference(preference(['tags', null, 'balance', 1, {}, 'tags', 'unknown'], 50))).toEqual({ size: 50, columns: ['tags', 'balance'] });
    for (const size of [0, 15, -1, '50', null, {}, []]) {
      expect(readChannelViewPreference(preference(['provider'], size))).toEqual({ size: 20, columns: ['provider'] });
    }
    for (const columns of [null, 'tags', 1, {}]) {
      expect(readChannelViewPreference(preference(columns, 100))).toEqual({ size: 100, columns: defaultChannelColumns });
    }
    expect(readChannelViewPreference(preference(['unknown']))).toEqual({ size: 20, columns: [] });
  });
});

describe('channel website links', () => {
  it('keeps valid HTTP(S) paths, queries, fragments and escaped spaces', () => {
    for (const website of [
      'https://provider.example/docs/?source=console&lang=zh#pricing',
      'http://localhost:3000/docs?q=hello%20world#start',
      'http://127.0.0.1:8000/',
      'https://[::1]:8000/docs',
      'HTTPS://PROVIDER.EXAMPLE/docs/',
      `https://provider.example/${'a'.repeat(2023)}`,
    ]) expect(channelWebsite({ website: `  ${website}  ` })).toBe(new URL(website).href);
    expect(channelWebsite({})).toBe('');
    expect(channelWebsite({ website: '  ' })).toBe('');
  });

  it('rejects malformed, executable, authenticated and ambiguous destinations', () => {
    for (const website of [
      '/docs', '//provider.example', 'provider.example', 'https:provider.example', 'http:/provider.example', 'https:///provider.example', 'https://',
      'ftp://provider.example', 'javascript:alert(1)', 'data:text/html,hello',
      'https://private-user:private-password@provider.example', 'https://@provider.example', 'https://provider.example:invalid',
      'https://provider.example/line\nbreak', 'https://provider.example/has space', 'https://provider.example\\path',
      'https://provider.example/has\x00control', 'https://provider.example/has\x7fcontrol',
      `https://provider.example/${'a'.repeat(2048)}`,
    ]) expect(channelWebsite({ website }), website).toBe('');
  });
});
