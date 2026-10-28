import type { GatewayContext, GatewayStore } from './env';
import { handleGateway } from './gateway';
import { readUpstreamJSON } from './upstream-http';
import { HttpError } from './validation';

function errorType(status: number): string {
  return status === 400 ? 'invalid_request_error' : status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 404 ? 'not_found_error' : status === 413 ? 'request_too_large' : status === 429 ? 'rate_limit_error' : status === 529 || status === 503 ? 'overloaded_error' : 'api_error';
}
export function anthropicErrorResponse(status: number, message: string): Response {
  return Response.json({ type: 'error', error: { type: errorType(status), message } }, { status, headers: { 'cache-control': 'no-store' } });
}

/** Messages uses the same transparent relay as Chat Completions. No protocol adapter or parameter whitelist. */
export async function handleAnthropicMessages(request: Request, input: Record<string, unknown> | undefined, context: GatewayContext, store: GatewayStore): Promise<Response> {
  try {
    let forwarded = request;
    if (input !== undefined) {
      const headers = new Headers(request.headers); headers.delete('content-length');
      forwarded = new Request(request.url, { method: 'POST', headers, signal: request.signal, body: JSON.stringify(input) });
    }
    const result = await handleGateway(forwarded, { ...context, relayProtocol: 'anthropic' }, store);
    const headers = new Headers(result.headers);
    const requestId = headers.get('x-pulsegate-request-id'); if (requestId && !headers.has('request-id')) headers.set('request-id', requestId);
    // Upstream responses, including upstream errors, keep their original format.
    if (headers.has('x-pulsegate-channel-id')) return new Response(result.body, { status: result.status, statusText: result.statusText, headers });
    const value = await readUpstreamJSON(result, 8 * 1024 * 1024);
    const error = anthropicErrorResponse(result.status, typeof value.error?.message === 'string' ? value.error.message : '网关请求失败');
    headers.set('content-type', 'application/json'); headers.set('cache-control', 'no-store');
    return new Response(error.body, { status: result.status, headers });
  } catch (error) {
    return anthropicErrorResponse(error instanceof HttpError ? error.status : 500, error instanceof HttpError ? error.message : 'Gateway operation failed; check server configuration');
  }
}
