import type { GatewayChannel } from '../shared/types';

export const channelColumns = [
  { key: 'tags', title: '标签' },
  { key: 'balance', title: '余额与 Key' },
  { key: 'enabled', title: '启用' },
  { key: 'health', title: '健康 / 首字' },
  { key: 'models', title: '支持的模型' },
  { key: 'priority', title: '优先级' },
  { key: 'provider', title: '服务商' },
  { key: 'weight', title: '权重' },
  { key: 'createdAt', title: '创建时间' },
];

export const defaultChannelColumns = ['tags', 'balance', 'enabled', 'health'];

const legacyDefaultColumns = ['enabled', 'health', 'models'];
const legacyAllColumns = ['priority', 'enabled', 'health', 'models', 'provider', 'weight', 'createdAt'];
const columnKeys = new Set(channelColumns.map(column => column.key));

interface ChannelViewPreference { size: number; columns: string[] }

function parsedPreference(raw: string | null): Record<string, unknown> | null {
  if (raw == null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export function readChannelViewPreference(current: string | null, legacyV4: string | null = null, legacyV3: string | null = null): ChannelViewPreference {
  const candidates = [current, legacyV4, legacyV3];
  for (const [version, raw] of candidates.entries()) {
    const value = parsedPreference(raw);
    if (!value) continue;
    const columns = Array.isArray(value.columns)
      ? [...new Set(value.columns.filter((key): key is string => typeof key === 'string' && columnKeys.has(key)))]
      : [...defaultChannelColumns];
    const oldDefault = version === 1 ? legacyDefaultColumns : version === 2 ? legacyAllColumns : null;
    const migrate = oldDefault && columns.length === oldDefault.length && oldDefault.every(key => columns.includes(key));
    return {
      size: typeof value.size === 'number' && [10, 20, 50, 100].includes(value.size) ? value.size : 20,
      columns: migrate ? [...defaultChannelColumns] : columns,
    };
  }
  return { size: 20, columns: [...defaultChannelColumns] };
}

export function channelWebsite(channel: Pick<GatewayChannel, 'website'>): string {
  const website = channel.website?.trim() ?? '';
  if (!/^https?:\/\//i.test(website) || /[\\\x00-\x20\x7f]/.test(website) || website.length > 2048) return '';
  try {
    const parsed = new URL(website);
    const authority = website.slice(website.indexOf('://') + 3).split(/[/?#]/, 1)[0];
    return ['http:', 'https:'].includes(parsed.protocol) && authority && !authority.includes('@') && !parsed.username && !parsed.password ? parsed.href : '';
  } catch { return ''; }
}
