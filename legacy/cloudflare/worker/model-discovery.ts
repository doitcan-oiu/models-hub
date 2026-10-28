import type { GatewayChannel, GatewaySettings } from '../shared/types';
import { upstreamHeaders, upstreamUrl } from './protocols';
import { HttpError } from './validation';
import { readUpstreamJSON } from './upstream-http';

export async function discoverModels(channel: GatewayChannel, settings: GatewaySettings, secret: string, gatewayToken: string | null, signal?: AbortSignal): Promise<{ models: string[]; endpoint: string; truncated: boolean }> {
  if (channel.config.protocol === 'mock') return { models: channel.models, endpoint: '本地模拟', truncated: false };
  if (!secret) throw new HttpError(400, '获取模型前请填写 API Key，或为已有渠道添加密钥');
  const target = new URL(upstreamUrl(channel, settings, '', false, channel.config.endpoints.models));
  const endpoint = target.toString();
  const headers = upstreamHeaders(channel, secret, gatewayToken); headers.set('Accept', 'application/json');
  const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  const models = new Set<string>(); const seenTokens = new Set<string>(); let truncated = false;
  if (channel.config.protocol === 'anthropic') target.searchParams.set('limit', '100');
  if (channel.config.protocol === 'gemini') target.searchParams.set('pageSize', '1000');
  try {
    for (let page = 0; page < 10; page++) {
      const response = await fetch(target.toString(), { headers, method: 'GET', redirect: 'manual', signal: abort });
      if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, `获取模型失败（上游 HTTP ${response.status}）`); }
      const data = await readUpstreamJSON(response);
      const entries = channel.config.protocol === 'gemini' ? data.models : data.data;
      if (!Array.isArray(entries)) throw new HttpError(502, '上游未返回有效的模型列表');
      for (const item of entries) {
        if (!item || typeof item !== 'object') continue;
        if (channel.config.protocol === 'gemini' && Array.isArray(item.supportedGenerationMethods) && !item.supportedGenerationMethods.includes('generateContent')) continue;
        const raw = channel.config.protocol === 'gemini' ? item.name : item.id;
        if (typeof raw !== 'string') continue;
        const id = (channel.config.protocol === 'gemini' ? raw.replace(/^models\//, '') : raw).trim();
        if (!id || id.length > 256) continue;
        if (!models.has(id) && models.size >= 1000) { truncated = true; break; }
        models.add(id);
      }
      const next = channel.config.protocol === 'gemini' ? data.nextPageToken : channel.config.protocol === 'anthropic' && data.has_more ? data.last_id : null;
      if (!next || typeof next !== 'string') break;
      if (models.size >= 1000 || page === 9) { truncated = true; break; }
      if (next.length > 1024 || seenTokens.has(next)) throw new HttpError(502, '上游模型分页游标无效');
      seenTokens.add(next);
      target.searchParams.set(channel.config.protocol === 'gemini' ? 'pageToken' : 'after_id', next);
    }
    return { models: [...models].sort(), endpoint, truncated };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, abort.aborted ? '获取模型超时或已取消，请检查上游连接' : '无法连接模型接口，请检查 Base URL 与连接方式');
  }
}
