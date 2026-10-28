import type { GatewayApiKey, GatewayChannel, KeyProfile } from '../../../shared/types';
import { apiKeyExpired, modelsForProfile } from '../../access-policy';

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const scopeNames = { all: '所有渠道', tags: '按标签限定', channels: '指定渠道' };
export const stateNames = { active: '已启用', disabled: '已停用', expired: '已过期', revoked: '已撤销' };
export const keyState = (key: GatewayApiKey) => key.status === 'active' && apiKeyExpired(key) ? 'expired' : key.status;
export const currentProfile = (key: GatewayApiKey) => key.profiles.find(item => item.id === key.activeProfile) ?? key.profiles[0];
export const channelModels = (channel: GatewayChannel) => [...new Set([...(channel.models?.length ? channel.models : [channel.model]), ...channel.config.aliases.map(alias => alias.from)])];
export function scopedChannels(profile: KeyProfile, channels: GatewayChannel[]) {
  return channels.filter(channel => {
    if (channel.archived) return false;
    if (profile.scope === 'all') return true;
    if (profile.scope === 'channels') return profile.channelIds.includes(channel.id);
    if (!profile.tags.length) return false;
    if (profile.match === 'all') return profile.tags.every(tag => channel.tags.includes(tag));
    if (profile.match === 'none') return profile.tags.every(tag => !channel.tags.includes(tag));
    return profile.tags.some(tag => channel.tags.includes(tag));
  });
}
export const permittedModels = (profile: KeyProfile, channels: GatewayChannel[]) => [...new Set(scopedChannels(profile, channels).flatMap(channelModels))].filter(model => profile.modelMode === 'all' || profile.models.includes(model));
export const eligibleChannels = (profile: KeyProfile, channels: GatewayChannel[]) => scopedChannels(profile, channels).filter(channel => modelsForProfile([channel], profile, true).length > 0);
export const availableChannel = (channel: GatewayChannel) => channel.enabled && !channel.archived && !channel.health.autoDisabled && channel.status === 'healthy' && (channel.config.protocol === 'mock' || channel.credentialCount !== 0);
export function blankProfile(name = '默认策略'): KeyProfile {
  return { id: crypto.randomUUID(), name, scope: 'all', tags: [], match: 'any', channelIds: [], modelMode: 'all', models: [], requestLimit: '', mappings: [] };
}
