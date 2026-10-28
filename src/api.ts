export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.name = 'ApiError'; this.status = status; }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...options, headers, credentials: 'include' });
  const data = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) throw new ApiError(data?.error?.message || data?.error || data?.message || `请求失败（${response.status}）`, response.status);
  return data as T;
}
