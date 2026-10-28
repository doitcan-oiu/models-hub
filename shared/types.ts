import type { AnalyticsData } from './analytics';
export type ChannelStatus = 'healthy' | 'degraded' | 'offline';
export type ProviderProtocol = 'openai' | 'anthropic' | 'gemini' | 'mock';
export type RoutingStrategy = 'failover' | 'adaptive' | 'round-robin' | 'weighted' | 'circuit-breaker';
export type MockScenario = 'healthy' | 'slow' | 'error' | 'empty' | 'disconnect' | 'transient';
export type ModelPrice = { model: string; input: number; output: number };
export type AccountIntegration = 'newapi' | 'sub2api' | 'bbdevlab';
export type GatewayBalance = {
  status: 'pending' | 'ok' | 'error'; amount: number | null; unit: string;
  updatedAt: string | null; checkedAt: string | null; error?: string;
  expiresAt?: string | null;
  keyCount?: number; availableKeys?: number; exhaustedKeys?: number; expiredKeys?: number;
};
export type ChannelConfig = {
  integration?: 'native' | AccountIntegration;
  protocol: ProviderProtocol;
  gatewayMode: 'direct' | 'ai-gateway';
  customProviderSlug: string;
  aliases: { from: string; to: string }[];
  prices: ModelPrice[];
  headers: Record<string, string>;
  bodyOverrides: Record<string, unknown>;
  relayUrl: string;
  conversions: { stripUnsupported: boolean; systemToUser: boolean };
  rateLimit: { requestsPerMinute: number; tokensPerMinute: number };
  endpoints: { chat: string; models: string; messages: string; generate: string };
  cooldown: { firstToken: boolean; error: boolean };
  autoDisable: { enabled: boolean; target: 'key' | 'channel'; statuses: number[]; threshold: number; recover: boolean; cooldown: number };
  mock: { scenario: MockScenario; delayMs: number; status: number; failuresBeforeSuccess: number };
};
export type GatewayChannel = {
  hasAccountCredentials?: boolean;
  accountAuthMode?: 'password' | 'token' | 'cookie';
  accountIntegration?: AccountIntegration;
  accountBalance?: GatewayBalance;
  /** Display metadata only; never used for routing, requests, balances, or pricing. */
  displayMultiplier?: number;
  /** Optional browser link only; unrelated to the upstream endpoint. */
  website?: string;
  id: string; name: string; provider: string; model: string; models: string[];
  tags: string[]; weight: number; endpoint: string; status: ChannelStatus;
  priority: number; ttft: number; successRate: number; requests: number;
  enabled: boolean; color: string; history: number[]; createdAt: string;
  archived: boolean; config: ChannelConfig; credentialCount: number;
  health: { averageTtft: number | null; averageDuration: number | null; samples: number; cooldownUntil: string | null; recoveryCount: number; failureCount: number; reason: string | null; autoDisabled: boolean };
};
export type KeyProfile = {
  id: string; name: string; scope: 'all' | 'tags' | 'channels'; tags: string[];
  match: 'any' | 'all' | 'none'; channelIds: string[]; modelMode: 'all' | 'selected';
  models: string[]; requestLimit: string; mappings: { from: string; to: string[] }[];
};
export type GatewayApiKey = {
  id: string; name: string; preview: string; status: 'active' | 'disabled' | 'revoked';
  createdAt: string; expires: string; note: string; used: number;
  activeProfile: string; profiles: KeyProfile[];
};
export type CredentialMeta = { id: string; label: string; preview: string; enabled: boolean; failureCount: number; disabledAt: string | null; createdAt: string; reason: string | null; balance?: GatewayBalance };
export type CredentialUpdate = { id: string; label?: string; secret?: string };
export type GatewaySettings = {
  account: string; gateway: string; aiGatewayEnabled: boolean; hasAiGatewayToken: boolean;
  retryEnabled: boolean; maxChannelRetries: number; maxSameChannelRetries: number;
  retryDelayMs: number; streamFirstTokenTimeout: number; nonStreamTimeout: number;
  emptyResponseDetection: boolean; errorMode: 'raw' | 'generic' | 'custom'; customErrorMessage: string;
  retryStatuses: number[]; strategy: RoutingStrategy; stickyMode: 'prefer' | 'off';
  threshold: number; responseThreshold: number; window: number; windowSeconds: number;
  samples: number; cooldown: number; recovery: number; autoSwitch: boolean; autoRecover: boolean;
  autoDisableEnabled: boolean; autoDisableTarget: 'key' | 'channel';
  autoDisableStatuses: number[]; autoDisableThreshold: number;
  autoDisableRecover: boolean; autoDisableCooldown: number;
  notifications: boolean; logRetentionDays: number;
};
export type AttemptRecord = {
  /** A verified exhausted or expired pool Key does not indicate a channel health failure. */
  healthIgnored?: boolean;
  id: string; requestId: string; channelId: string; channelName: string;
  credentialId: string | null; model: string; stream: boolean; startedAt: string;
  ttft: number | null; duration: number; status: number; result: 'success' | 'slow' | 'error' | 'empty' | 'cancelled';
  error: string | null; inputTokens: number; outputTokens: number; attempt: number;
};
export type GatewayLog = {
  id: string; time: string; createdAt: string; model: string; channel: string;
  channelId: string | null; apiKeyId: string | null; stream: boolean; ttft: number;
  duration: number; tokens: number; status: number; result: 'success' | 'slow' | 'failover' | 'error';
  attempts: number; source: 'api' | 'playground' | 'probe'; traceId: string | null;
  error: string | null;
};
export type GatewayEvent = { id: string; time: string; createdAt: string; title: string; description: string; type: 'switch' | 'warning' | 'recovery' | 'info'; channelId: string | null };
export type DashboardData = {
  analytics?: AnalyticsData;
  totals: { requests: number; successRate: number; averageTtft: number; failovers: number; inputTokens: number; outputTokens: number; cost: number };
  latency: { time: string; primary: number | null; backup: number | null; requests: number }[];
  events: GatewayEvent[]; channels: GatewayChannel[];
};
export type BootstrapData = { channels: GatewayChannel[]; keys: GatewayApiKey[]; settings: GatewaySettings; tags: string[]; devMode: boolean };

export const defaultChannelConfig: ChannelConfig = {
  protocol: 'openai', gatewayMode: 'direct', customProviderSlug: '', aliases: [], prices: [],
  headers: {}, bodyOverrides: {}, relayUrl: '', conversions: { stripUnsupported: false, systemToUser: false },
  rateLimit: { requestsPerMinute: 0, tokensPerMinute: 0 },
  endpoints: { chat: '/chat/completions', models: '/models', messages: '/messages', generate: '/models/{model}:generateContent' },
  cooldown: { firstToken: true, error: true },
  autoDisable: { enabled: false, target: 'key', statuses: [401, 403], threshold: 3, recover: true, cooldown: 60 },
  mock: { scenario: 'healthy', delayMs: 50, status: 503, failuresBeforeSuccess: 1 },
};
export const defaultSettings: GatewaySettings = {
  account: '', gateway: '', aiGatewayEnabled: false, hasAiGatewayToken: false,
  retryEnabled: true, maxChannelRetries: 3, maxSameChannelRetries: 2, retryDelayMs: 1000,
  streamFirstTokenTimeout: 10, nonStreamTimeout: 60, emptyResponseDetection: true,
  errorMode: 'custom', customErrorMessage: '服务器错误，请重试', retryStatuses: [408, 429, 500, 502, 503, 504],
  strategy: 'failover', stickyMode: 'prefer', threshold: 10, responseThreshold: 20,
  window: 20, windowSeconds: 0, samples: 10, cooldown: 60, recovery: 5, autoSwitch: true, autoRecover: true,
  autoDisableEnabled: false, autoDisableTarget: 'key', autoDisableStatuses: [401, 403],
  autoDisableThreshold: 3, autoDisableRecover: true, autoDisableCooldown: 60,
  notifications: true, logRetentionDays: 30,
};
