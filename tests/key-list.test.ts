import { describe, expect, it } from 'vitest';
import type { GatewayApiKey } from '../shared/types';
import { filterApiKeys, keyDeleteTargets, keyListPage } from '../src/key-list';

function key(id: string, patch: Partial<GatewayApiKey> = {}): GatewayApiKey {
  return { id, name: id, preview: `pg_live_••••${id}`, status: 'active', createdAt: '2026-10-24T00:00:00Z', expires: '', note: '', used: 0, activeProfile: 'p', profiles: [{ id: 'p', name: '默认策略', scope: 'all', tags: [], match: 'any', channelIds: [], modelMode: 'all', models: [], requestLimit: '', mappings: [] }], ...patch };
}
const now = Date.parse('2026-10-24T16:00:00Z');

describe('large API Key lists', () => {
  it('combines multiword searches with state and current authorization filters', () => {
    const production = key('abc1', { name: '应用服务', note: 'production owner-a' });
    production.profiles[0].scope = 'tags'; production.profiles[0].tags = ['生产'];
    const keys = [production, key('abc2', { note: 'production owner-a', status: 'disabled' }), key('abc3')];
    expect(filterApiKeys(keys, { query: 'OWNER-a 生产', status: 'active', scope: 'tags' }, now).map(item => item.id)).toEqual(['abc1']);
    expect(filterApiKeys(keys, { query: '••••abc2' }, now).map(item => item.id)).toEqual(['abc2']);
    expect(filterApiKeys(keys, { query: 'abc3', scope: 'all' }, now).map(item => item.id)).toEqual(['abc3']);
    expect(filterApiKeys(keys, { query: 'missing' }, now)).toEqual([]);
  });

  it('keeps expired active keys distinct from disabled and legacy revoked keys', () => {
    const keys = [key('expired', { expires: '2026-10-24' }), key('disabled', { status: 'disabled', expires: '2026-10-24' }), key('revoked', { status: 'revoked' }), key('live', { expires: '2026-10-25' })];
    for (const [status, expected] of [['expired', 'expired'], ['disabled', 'disabled'], ['revoked', 'revoked'], ['active', 'live']] as const) {
      expect(filterApiKeys(keys, { status }, now).map(item => item.id)).toEqual([expected]);
    }
    expect(filterApiKeys(keys, { status: 'active' }, Date.parse('2026-10-24T15:59:59.998Z')).map(item => item.id)).toEqual(['expired', 'live']);
  });

  it('sorts a copy consistently and places unlimited or invalid expiry after dated keys', () => {
    const keys = [key('never', { used: 3 }), key('later', { expires: '2026-11-01', createdAt: '2026-10-25T00:00:00Z', used: 9 }), key('soon', { expires: '2026-10-25', used: 7 }), key('invalid', { expires: 'invalid' })];
    expect(filterApiKeys(keys, { sort: 'expiry' }, now).map(item => item.id)).toEqual(['soon', 'later', 'invalid', 'never']);
    expect(filterApiKeys(keys, { sort: 'newest' }, now)[0].id).toBe('later');
    expect(filterApiKeys(keys, { sort: 'used' }, now).map(item => item.id)).toEqual(['later', 'soon', 'never', 'invalid']);
    expect(keys.map(item => item.id)).toEqual(['never', 'later', 'soon', 'invalid']);
  });

  it('renders only the current page and clamps it after filtering or deletion', () => {
    const keys = Array.from({ length: 125 }, (_, index) => key(String(index)));
    expect(keyListPage(keys, 2, 50)).toMatchObject({ page: 2, pageCount: 3 });
    expect(keyListPage(keys, 2, 50).items.map(item => item.id)).toEqual(keys.slice(50, 100).map(item => item.id));
    expect(keyListPage(keys.slice(0, 7), 3, 50)).toEqual({ items: keys.slice(0, 7), page: 1, pageCount: 1 });
    expect(keyListPage([], -2, 20)).toEqual({ items: [], page: 1, pageCount: 1 });
    expect(keyListPage(keys, NaN, -1).items).toHaveLength(20);
  });

  it('freezes confirmation identities independently of list refreshes and selection changes', () => {
    const keys = [key('first'), key('second', { status: 'revoked' })], ids = ['second', 'first'];
    const targets = keyDeleteTargets(keys, ids);
    keys[1].name = 'Renamed after confirmation'; ids.splice(0, ids.length, 'new-selection');
    expect(targets).toEqual([{ id: 'second', name: 'second', preview: 'pg_live_••••second' }, { id: 'first', name: 'first', preview: 'pg_live_••••first' }]);
    for (const selection of [[], ['missing'], ['first', 'first'], Array.from({ length: 201 }, (_, index) => String(index))]) expect(() => keyDeleteTargets(keys, selection)).toThrow();
  });
});
