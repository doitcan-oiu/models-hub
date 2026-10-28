import { describe, expect, it } from 'vitest';
import { BBDEVLAB_EXHAUSTED_REASON, BBDEVLAB_EXPIRED_REASON, credentialExpired } from '../shared/credential-policy';
import type { CredentialMeta, GatewayBalance } from '../shared/types';
import { credentialChanged, credentialExpiryText, credentialList, credentialPage } from '../src/components/channels/credential-list';
import { credentialChanges, credentialState, credentialUpdates, type CredentialDraft } from '../src/components/channels/credential-utils';

const now = Date.parse('2026-10-24T12:00:00.000Z');
const balance = (expiresAt: string | null, amount = 1): GatewayBalance => ({ status: 'ok', amount, expiresAt, unit: '余额', checkedAt: null, updatedAt: null });
const key = (id: string, patch: Partial<CredentialMeta> = {}): CredentialMeta => ({ id, label: 'Key ' + id, preview: '••••' + id, enabled: true, reason: null, disabledAt: null, failureCount: 0, createdAt: new Date(now).toISOString(), ...patch });
const ids = (keys: CredentialMeta[]) => keys.map(value => value.id);

describe('upstream credential status and expiry presentation', () => {
  it('uses an inclusive deadline and rejects invalid or absent cached dates', () => {
    expect(credentialExpired(balance(new Date(now).toISOString()), now)).toBe(true);
    expect(credentialExpired(balance(new Date(now + 1).toISOString()), now)).toBe(false);
    for (const value of [undefined, balance(null), balance('invalid')]) expect(credentialExpired(value, now)).toBe(false);
  });

  it('classifies expired enabled keys and preserves the explicit manual disabled state', () => {
    const expired = balance(new Date(now - 1).toISOString());
    expect(credentialState(key('a', { balance: expired }), now)).toBe('expired');
    expect(credentialState(key('b', { enabled: false, reason: BBDEVLAB_EXPIRED_REASON }), now)).toBe('expired');
    expect(credentialState(key('c', { enabled: false, reason: BBDEVLAB_EXHAUSTED_REASON }), now)).toBe('exhausted');
    expect(credentialState(key('d', { enabled: false, balance: expired }), now)).toBe('disabled');
    expect(credentialState(key('e'), now)).toBe('available');
    expect(credentialState(undefined, now)).toBe('disabled');
  });

  it('distinguishes a pending deadline from a confirmed unlimited deadline and an elapsed deadline', () => {
    expect(credentialExpiryText(undefined, now)).toBe('到期时间待查询');
    expect(credentialExpiryText(balance(null), now)).toBe('无到期限制');
    expect(credentialExpiryText(balance('invalid'), now)).toBe('到期时间待查询');
    expect(credentialExpiryText(balance(new Date(now).toISOString()), now)).toContain('不再调度');
    expect(credentialExpiryText(balance(new Date(now + 30_000).toISOString()), now)).toBe('不足 1 分钟后到期');
    expect(credentialExpiryText(balance(new Date(now + 120_000).toISOString()), now)).toBe('2 分钟后到期');
    expect(credentialExpiryText(balance(new Date(now + 7_200_000).toISOString()), now)).toBe('2 小时后到期');
    expect(credentialExpiryText(balance(new Date(now + 172_800_000).toISOString()), now)).toBe('2 天后到期');
  });
});

describe('large upstream credential lists', () => {
  it('searches draft labels, masked previews and reasons without searching replacement secrets', () => {
    const keys = [key('one', { label: 'Old label' }), key('two', { reason: 'HTTP 403' }), key('three')];
    const drafts = [{ id: 'one', label: 'Renamed target', secret: 'secret-value-never-searchable' }];
    expect(ids(credentialList(keys, { query: ' renamed TARGET ', drafts }))).toEqual(['one']);
    expect(ids(credentialList(keys, { query: '••••two', drafts }))).toEqual(['two']);
    expect(ids(credentialList(keys, { query: 'HTTP 403', drafts }))).toEqual(['two']);
    expect(credentialList(keys, { query: 'secret-value-never-searchable', drafts })).toEqual([]);
    expect(credentialList(keys, { query: 'Old label', drafts })).toEqual([]);
  });

  it('filters independent statuses from the current time and separates edited rows from unchanged drafts', () => {
    const keys = [key('available'), key('expired', { balance: balance(new Date(now).toISOString()) }), key('exhausted', { enabled: false, reason: BBDEVLAB_EXHAUSTED_REASON }), key('disabled', { enabled: false })];
    const drafts = keys.map(value => ({ id: value.id, label: value.label, secret: '' }));
    drafts[0].secret = ' replacement '; drafts[3].label = 'Renamed disabled';
    for (const filter of ['available', 'expired', 'exhausted', 'disabled'] as const) expect(ids(credentialList(keys, { filter, now }))).toEqual([filter]);
    expect(ids(credentialList(keys, { filter: 'modified', drafts, now }))).toEqual(['available', 'disabled']);
    expect(credentialChanged(keys[1], drafts[1])).toBe(false); expect(credentialChanged(keys[0], drafts[0])).toBe(true);
    expect(credentialChanged(keys[0], { ...drafts[0], secret: '  ' })).toBe(false);
  });

  it('sorts known expiry and balances first and uses edited names without mutating the source order', () => {
    const keys = [key('missing'), key('late', { balance: balance(new Date(now + 10_000).toISOString(), 7) }), key('early', { balance: balance(new Date(now + 1_000).toISOString(), 2) }), key('unlimited', { balance: balance(null, 3) })];
    const before = JSON.stringify(keys);
    expect(ids(credentialList(keys, { sort: 'expiry' })).slice(0, 2)).toEqual(['early', 'late']);
    expect(ids(credentialList(keys, { sort: 'balance' }))).toEqual(['early', 'unlimited', 'late', 'missing']);
    const drafts = keys.map((value, index) => ({ id: value.id, label: String(4 - index), secret: '' }));
    expect(ids(credentialList(keys, { sort: 'name', drafts }))).toEqual(['unlimited', 'early', 'late', 'missing']);
    expect(JSON.stringify(keys)).toBe(before);
  });

  it('preserves changes on other pages and hidden rows so one channel save contains all edits', () => {
    const keys = Array.from({ length: 67 }, (_, i) => key(String(i).padStart(2, '0')));
    const drafts: CredentialDraft[] = keys.map(value => ({ id: value.id, label: value.label, secret: '' }));
    drafts[0].label = 'First edited'; drafts[40].secret = 'private-replacement'; drafts[66].label = 'Last edited';
    const original = JSON.stringify(drafts);
    expect(credentialPage(credentialList(keys, { query: 'Last edited', drafts }), 9, 20)).toMatchObject({ page: 1, pageCount: 1, start: 1, end: 1 });
    expect(credentialPage(credentialList(keys, { filter: 'modified', drafts }), 1, 2).items).toHaveLength(2);
    expect(JSON.stringify(drafts)).toBe(original);
    expect(credentialUpdates(drafts, keys)).toEqual([{ id: '00', label: 'First edited' }, { id: '40', secret: 'private-replacement' }, { id: '66', label: 'Last edited' }]);
  });

  it('clamps pages after filters shrink the result and exposes correct empty ranges', () => {
    const values = Array.from({ length: 67 }, (_, i) => i);
    expect(credentialPage(values, 4, 20)).toEqual({ items: values.slice(60), page: 4, pageCount: 4, start: 61, end: 67 });
    expect(credentialPage(values.slice(0, 2), 4, 20)).toEqual({ items: [0, 1], page: 1, pageCount: 1, start: 1, end: 2 });
    expect(credentialPage([], 4, 20)).toEqual({ items: [], page: 1, pageCount: 1, start: 0, end: 0 });
    expect(credentialPage(values, NaN, NaN)).toMatchObject({ page: 1, pageCount: 4, start: 1, end: 20 });
    expect(credentialPage(values, -4, 0)).toMatchObject({ page: 1, start: 1, end: 20 });
    expect(credentialPage(values, 1, 0.5)).toMatchObject({ page: 1, pageCount: 67, start: 1, end: 1 });
  });

  it('submits deletions and other edits across hidden pages without validating discarded replacement fields', () => {
    const keys = Array.from({ length: 67 }, (_, i) => key(String(i).padStart(2, '0')));
    const drafts = keys.map(value => ({ id: value.id, label: value.label, secret: '' }));
    drafts[0].label = 'First renamed'; drafts[40].secret = ' replacement-secret '; drafts[66].label = ''; drafts[66].secret = 'x'.repeat(16001);
    const deletedIds = ['66'], before = JSON.stringify({ keys, drafts, deletedIds });
    expect(ids(credentialPage(credentialList(keys, { query: 'First renamed', drafts, deletedIds }), 4, 20).items)).toEqual(['00']);
    expect(credentialChanges(drafts, keys, deletedIds)).toEqual({ updates: [{ id: '00', label: 'First renamed' }, { id: '40', secret: 'replacement-secret' }], deletes: ['66'] });
    expect(() => credentialChanges(drafts, keys)).toThrow('密钥名称须为 1–128 个字符');
    expect(JSON.stringify({ keys, drafts, deletedIds })).toBe(before);
    const changes = credentialChanges(drafts, keys, deletedIds);
    changes.deletes.push('40');
    expect(deletedIds).toEqual(['66']);
  });

  it('preserves a deleted row and its edits for undo while excluding it from status and modified filters', () => {
    const keys = [key('available'), key('expired', { balance: balance(new Date(now).toISOString()) }), key('exhausted', { enabled: false, reason: BBDEVLAB_EXHAUSTED_REASON }), key('disabled', { enabled: false })];
    const drafts = keys.map(value => ({ id: value.id, label: `Edited ${value.id}`, secret: `replacement-${value.id}` })), deletedIds = ids(keys);
    for (const filter of ['available', 'expired', 'exhausted', 'disabled', 'modified'] as const) expect(credentialList(keys, { filter, drafts, deletedIds, now })).toEqual([]);
    expect(ids(credentialList(keys, { filter: 'all', drafts, deletedIds, now }))).toEqual(deletedIds);
    expect(ids(credentialList(keys, { filter: 'deleted', drafts, deletedIds, now }))).toEqual(deletedIds);
    expect(ids(credentialList(keys, { filter: 'deleted', query: 'Edited exhausted', drafts, deletedIds, now }))).toEqual(['exhausted']);
    expect(credentialChanges(drafts, keys, deletedIds)).toEqual({ updates: [], deletes: deletedIds });
    const restored = deletedIds.filter(id => id !== 'exhausted');
    expect(ids(credentialList(keys, { filter: 'modified', drafts, deletedIds: restored, now }))).toEqual(['exhausted']);
    expect(credentialChanges(drafts, keys, restored)).toEqual({ updates: [{ id: 'exhausted', label: 'Edited exhausted', secret: 'replacement-exhausted' }], deletes: restored });
    expect(credentialChanges(drafts, keys)).toEqual({ updates: credentialUpdates(drafts, keys), deletes: [] });
  });

  it('rejects stale, duplicate and oversized deletion sets and accepts the 100-key deletion boundary', () => {
    const keys = Array.from({ length: 101 }, (_, i) => key(String(i))), drafts = keys.map(value => ({ id: value.id, label: value.label, secret: '' }));
    expect(credentialChanges(drafts, keys, ids(keys.slice(0, 100)))).toEqual({ updates: [], deletes: ids(keys.slice(0, 100)) });
    expect(() => credentialChanges(drafts, keys, ids(keys))).toThrow('每次最多删除 100 个密钥');
    expect(() => credentialChanges(drafts, keys, ['0', '0'])).toThrow('密钥列表已变化');
    expect(() => credentialChanges(drafts, keys, ['missing-key'])).toThrow('密钥列表已变化');
    expect(() => credentialChanges(drafts, keys, ['0', 'missing-key'])).toThrow('密钥列表已变化');
  });
});
