import type { GatewayApiKey, GatewayChannel, GatewaySettings, AttemptRecord, GatewayLog, GatewayEvent } from '../shared/types';

export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_TOKEN?: string;
  ENCRYPTION_KEY?: string;
  DEV_MODE?: string;
  AI_GATEWAY_TOKEN?: string;
  GATEWAY_STATE: DurableObjectNamespace;
};
export type Credential = { id: string; label: string; secret: string; enabled: boolean; failureCount: number; disabledAt: string | null; expiresAt?: string | null };
export type KeyRecord = GatewayApiKey & { tokenHash: string };
export type GatewayContext = {
  env: Env;
  ctx: ExecutionContext;
  settings: GatewaySettings;
  channels: GatewayChannel[];
  key: KeyRecord | null;
  profile: GatewayApiKey['profiles'][number] | null;
  source: GatewayLog['source'];
  forceChannelId?: string;
  forceCredentialId?: string;
  relayProtocol?: 'openai' | 'anthropic';
};

/** Implemented by store.ts; consumed by the routing engine. */
export type GatewayStore = {
  getChannel?(channelId: string): Promise<GatewayChannel | null>;
  isCredentialRestricted?(channelId: string, credentialId: string): Promise<boolean>;
  getCredentials(channelId: string, includeDisabled?: boolean): Promise<Credential[]>;
  recordAttempt(attempt: AttemptRecord): Promise<void>;
  recordLog(log: GatewayLog): Promise<void>;
  recordEvent(event: GatewayEvent): Promise<void>;
  getRecentAttempts(channelId: string, stream: boolean, limit: number, seconds?: number): Promise<AttemptRecord[]>;
  updateHealth(channelId: string, patch: Partial<GatewayChannel['health']>, status?: GatewayChannel['status']): Promise<void>;
  setCredentialHealth(id: string, patch: { enabled?: boolean; failureCount?: number; disabledAt?: string | null; reason?: string | null }): Promise<void>;
  incrementKeyUsage(keyId: string, profileId: string, limit: number): Promise<boolean>;
  nextRoundRobin(scope: string): Promise<number>;
  getSticky(scope: string): Promise<string | null>;
  setSticky(scope: string, channelId: string): Promise<void>;
  getAiGatewayToken(): Promise<string | null>;
  reserveChannel(channel: GatewayChannel, estimatedTokens: number): Promise<boolean>;
};
