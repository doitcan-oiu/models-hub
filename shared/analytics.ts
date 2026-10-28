export type AnalyticsLatency = {
  average: number | null;
  p50: number | null;
  p95: number | null;
  samples: number;
};

export type AnalyticsTotals = {
  requests: number;
  successRate: number;
  averageTtft: number;
  failovers: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
};

export type AnalyticsPoint = {
  time: string;
  requests: number;
  successRate: number | null;
  throughput: number;
  ttftP50: number | null;
  ttftP95: number | null;
  durationAverage: number | null;
  durationP95: number | null;
  inputTokens: number;
  outputTokens: number;
};

export type AnalyticsModel = {
  model: string;
  requests: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
};

export type AnalyticsChannel = {
  id: string;
  name: string;
  attempts: number;
  requests: number;
  successRate: number;
  ttft: AnalyticsLatency;
  duration: AnalyticsLatency;
  generationSpeed: number | null;
  generationSamples: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
};

export type AnalyticsOutcome = {
  result: 'success' | 'slow' | 'failover' | 'error';
  requests: number;
};

export type AnalyticsData = {
  approximatePercentiles?: boolean;
  groupedRows?: boolean;
  range: '1h' | '24h' | '7d';
  rangeLabel: string;
  intervalMinutes: number;
  totals: AnalyticsTotals;
  summary: {
    successfulRequests: number;
    failedRequests: number;
    retriedRequests: number;
    retryRate: number;
    switchedRequests: number;
    switchRate: number;
    streamRequests: number;
    throughput: number;
    ttft: AnalyticsLatency;
    duration: AnalyticsLatency;
    generationSpeed: number | null;
    generationSamples: number;
    usageRequests: number;
    usageCoverage: number;
    pricedTokens: number;
    unpricedTokens: number;
  };
  timeline: AnalyticsPoint[];
  models: AnalyticsModel[];
  channels: AnalyticsChannel[];
  outcomes: AnalyticsOutcome[];
};
