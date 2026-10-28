import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../shared/types';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const configuration = (tag: string) => ({ channels: [], keys: [], tags: [tag], settings: { ...structuredClone(defaultSettings), account: tag } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

type Store = ReturnType<(typeof import('../src/composables/useConsole'))['useConsole']>;
let store: Store;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('window', { location: { hash: '#requests' }, addEventListener: vi.fn(), removeEventListener: vi.fn(), history: { replaceState: vi.fn() } });
  vi.stubGlobal('document', { visibilityState: 'visible', title: '', createElement: vi.fn(() => ({})) });
  store = (await import('../src/composables/useConsole')).useConsole();
  store.session.value = { authenticated: true, devMode: false, configured: true };
});

afterEach(() => { store.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('console refresh and session lifecycle', () => {
  it('cancels replaced requests and ignores late stale results without showing an abort error', async () => {
    const first = [deferred<Response>(), deferred<Response>()];
    const second = [deferred<Response>(), deferred<Response>()];
    const fetcher = vi.fn()
      .mockReturnValueOnce(first[0].promise).mockReturnValueOnce(first[1].promise)
      .mockReturnValueOnce(second[0].promise).mockReturnValueOnce(second[1].promise);
    vi.stubGlobal('fetch', fetcher);
    const oldRefresh = store.refresh();
    const oldSignal = fetcher.mock.calls[0][1].signal as AbortSignal;
    const newRefresh = store.refresh();
    expect(oldSignal.aborted).toBe(true);
    second[0].resolve(json(configuration('latest'))); second[1].resolve(json({ events: [] }));
    await newRefresh;
    first[0].resolve(json(configuration('stale'))); first[1].resolve(json({ events: [] }));
    await oldRefresh;
    expect(store.tags.value).toEqual(['latest']);
    expect(store.settings.value.account).toBe('latest');
    expect(store.loading.value).toBe(false);
    expect(store.snackbar.value.show).toBe(false);
  });

  it('does not accumulate background polls while a slow refresh is in flight', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/api/setup') return json({ initialized: true });
      if (path === '/api/session') return json({ authenticated: true, devMode: false, configured: true });
      return json(path === '/api/bootstrap' ? configuration('initial') : { events: [] });
    }));
    await store.initialize();
    const fetcher = vi.fn((_path: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetcher);
    await vi.advanceTimersByTimeAsync(15000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(45000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    store.dispose();
    expect(fetcher.mock.calls.every(call => call[1].signal?.aborted)).toBe(true);
  });

  it('clears cached administration data if either endpoint reports an expired session', async () => {
    store.ready.value = true;
    store.dashboard.value.totals.requests = 123;
    store.tags.value = ['private'];
    store.settings.value.account = 'private-account';
    vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/api/bootstrap' ? json(configuration('private-update')) : json({ error: '登录已过期' }, 401)));
    await store.refresh();
    expect(store.session.value?.authenticated).toBe(false);
    expect(store.ready.value).toBe(false);
    expect(store.tags.value).toEqual([]);
    expect(store.settings.value).toEqual(defaultSettings);
    expect(store.dashboard.value.totals.requests).toBe(0);
    expect(store.lastUpdated.value).toBeNull();
  });

  it('blocks refresh during logout and prevents an old poll restoring cleared data', async () => {
    const pending = [deferred<Response>(), deferred<Response>()], logout = deferred<Response>();
    const fetcher = vi.fn().mockReturnValueOnce(pending[0].promise).mockReturnValueOnce(pending[1].promise).mockReturnValueOnce(logout.promise);
    vi.stubGlobal('fetch', fetcher);
    const refresh = store.refresh();
    const signOut = store.confirmLogout();
    expect((fetcher.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
    await store.refresh(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    logout.resolve(new Response(null, { status: 204 })); await signOut;
    pending[0].resolve(json(configuration('late-private-data'))); pending[1].resolve(json({ events: [] })); await refresh;
    expect(store.session.value?.authenticated).toBe(false);
    expect(store.tags.value).toEqual([]);
    expect(store.ready.value).toBe(false);
  });

  it('can log in and refresh again after logout', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit) => {
      if (path === '/api/setup') return json({ initialized: true });
      if (path === '/api/session') return options.method ? new Response(null, { status: 204 }) : json({ authenticated: true, devMode: false, configured: true });
      return json(path === '/api/bootstrap' ? configuration('new-session') : { events: [] });
    }));
    await store.confirmLogout();
    expect(store.session.value?.authenticated).toBe(false);
    await store.login('new-password');
    expect(store.session.value?.authenticated).toBe(true);
    expect(store.ready.value).toBe(true);
    expect(store.tags.value).toEqual(['new-session']);
  });

  it('guards saving editors and reports discarded drafts consistently', async () => {
    let busy = true;
    const unregister = store.registerEditor('credential-editor', () => ({ dirty: true, busy }));
    store.requestLogout();
    expect(store.logoutOpen.value).toBe(false);
    busy = false; store.requestLogout();
    expect(store.logoutOpen.value).toBe(true);
    expect(store.logoutHasDrafts.value).toBe(true);
    unregister(); store.requestLogout();
    expect(store.logoutHasDrafts.value).toBe(false);
  });
});
