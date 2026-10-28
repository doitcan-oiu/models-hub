import { defaultChannelConfig } from './types';
import type { ProviderProtocol } from './types';

const defaultPaths = new Set(Object.values(defaultChannelConfig.endpoints));

/** Bare origins use the protocol's default version; explicit base and endpoint paths keep their meaning. */
export function resolveApiUrl(base: URL, endpointPath: string, protocol: ProviderProtocol, model = '', stream = false): URL {
  let prefix = base.pathname.replace(/\/$/, '');
  if (!prefix && protocol !== 'mock' && defaultPaths.has(endpointPath)) prefix = protocol === 'gemini' ? '/v1beta' : '/v1';
  let path = endpointPath.replace('{model}', encodeURIComponent(model));
  if (protocol === 'gemini' && stream) { path = path.replace(':generateContent', ':streamGenerateContent'); path += path.includes('?') ? '&alt=sse' : '?alt=sse'; }
  const suffix = prefix && path.startsWith(`${prefix}/`) ? path : `${prefix}/${path.replace(/^\//, '')}`;
  const target = new URL(`${base.origin}${suffix}`);
  for (const [key, value] of base.searchParams) if (!target.searchParams.has(key)) target.searchParams.set(key, value);
  return target;
}

/** Append a client's absolute API pathname below its configured deployment base, sharing overlapping path segments once. */
export function resolveClientApiUrl(base: URL, pathname: string): URL {
  if (!pathname.startsWith('/') || pathname.startsWith('//') || /[\\?#\x00-\x20\x7f]/.test(pathname)) throw new TypeError('Invalid client API pathname');
  const incoming = new URL(base.origin + pathname);
  if (incoming.origin !== base.origin || incoming.pathname !== pathname) throw new TypeError('Client API pathname cannot contain relative path segments');
  const decoded = decodeURIComponent(pathname);
  if (decoded.split(/[\\/]/).some(segment => segment === '.' || segment === '..')) throw new TypeError('Client API pathname cannot contain relative path segments');
  const prefix = base.pathname.replace(/\/+$/, '');
  let suffix = pathname;
  // /tenant/v1 + /v1/responses => /tenant/v1/responses, while
  // /tenant + /v1/responses => /tenant/v1/responses.
  for (let overlap = prefix; overlap;) {
    if (pathname === overlap || pathname.startsWith(overlap + '/')) { suffix = pathname.slice(overlap.length); break; }
    const next = overlap.indexOf('/', 1);
    overlap = next < 0 ? '' : overlap.slice(next);
  }
  const target = new URL(base.origin + prefix + suffix);
  if (target.origin !== base.origin || prefix && target.pathname !== prefix && !target.pathname.startsWith(prefix + '/')) throw new TypeError('Client API pathname must stay within the configured base');
  target.search = base.search;
  return target;
}
