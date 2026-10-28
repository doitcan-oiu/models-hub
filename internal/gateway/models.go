package gateway

// These models preserve the management UI's wire format while keeping secrets
// out of JSON responses.
type ModelAlias struct {
	From string `json:"from"`
	To   string `json:"to"`
}
type ModelPrice struct {
	Model  string  `json:"model"`
	Input  float64 `json:"input"`
	Output float64 `json:"output"`
}
type Conversions struct {
	StripUnsupported bool `json:"stripUnsupported"`
	SystemToUser     bool `json:"systemToUser"`
}
type RateLimit struct {
	RequestsPerMinute int `json:"requestsPerMinute"`
	TokensPerMinute   int `json:"tokensPerMinute"`
}
type Endpoints struct {
	Chat     string `json:"chat"`
	Models   string `json:"models"`
	Messages string `json:"messages"`
	Generate string `json:"generate"`
}
type CooldownPolicy struct {
	FirstToken bool `json:"firstToken"`
	Error      bool `json:"error"`
}
type AutoDisable struct {
	Enabled   bool    `json:"enabled"`
	Target    string  `json:"target"`
	Statuses  []int   `json:"statuses"`
	Threshold int     `json:"threshold"`
	Recover   bool    `json:"recover"`
	Cooldown  float64 `json:"cooldown"`
}
type MockConfig struct {
	Scenario              string `json:"scenario"`
	DelayMs               int    `json:"delayMs"`
	Status                int    `json:"status"`
	FailuresBeforeSuccess int    `json:"failuresBeforeSuccess"`
}
type ChannelConfig struct {
	Integration        string            `json:"integration,omitempty"`
	Protocol           string            `json:"protocol"`
	GatewayMode        string            `json:"gatewayMode"`
	CustomProviderSlug string            `json:"customProviderSlug"`
	Aliases            []ModelAlias      `json:"aliases"`
	Prices             []ModelPrice      `json:"prices"`
	Headers            map[string]string `json:"headers"`
	BodyOverrides      map[string]any    `json:"bodyOverrides"`
	RelayURL           string            `json:"relayUrl"`
	Conversions        Conversions       `json:"conversions"`
	RateLimit          RateLimit         `json:"rateLimit"`
	Endpoints          Endpoints         `json:"endpoints"`
	Cooldown           CooldownPolicy    `json:"cooldown"`
	AutoDisable        AutoDisable       `json:"autoDisable"`
	Mock               MockConfig        `json:"mock"`
}
type GatewayBalance struct {
	Status        string   `json:"status"`
	Amount        *float64 `json:"amount"`
	Unit          string   `json:"unit"`
	UpdatedAt     *string  `json:"updatedAt"`
	CheckedAt     *string  `json:"checkedAt"`
	Error         string   `json:"error,omitempty"`
	ExpiresAt     *string  `json:"expiresAt,omitempty"`
	KeyCount      int      `json:"keyCount,omitempty"`
	AvailableKeys int      `json:"availableKeys,omitempty"`
	ExhaustedKeys int      `json:"exhaustedKeys,omitempty"`
	ExpiredKeys   int      `json:"expiredKeys,omitempty"`
}
type Health struct {
	AverageTTFT     *float64 `json:"averageTtft"`
	AverageDuration *float64 `json:"averageDuration"`
	Samples         int      `json:"samples"`
	CooldownUntil   *string  `json:"cooldownUntil"`
	RecoveryCount   int      `json:"recoveryCount"`
	FailureCount    int      `json:"failureCount"`
	Reason          *string  `json:"reason"`
	AutoDisabled    bool     `json:"autoDisabled"`
}

// ChannelRuntimeState is a live management snapshot, never channel configuration.
type ChannelRuntimeState struct {
	Active       int     `json:"active"`
	Limit        int     `json:"limit"`
	CircuitUntil *string `json:"circuitUntil"`
	HalfOpen     bool    `json:"halfOpen"`
}
type Channel struct {
	Runtime               *ChannelRuntimeState `json:"runtime,omitempty"`
	ID                    string               `json:"id"`
	Name                  string               `json:"name"`
	Provider              string               `json:"provider"`
	Model                 string               `json:"model"`
	Models                []string             `json:"models"`
	Tags                  []string             `json:"tags"`
	Weight                int                  `json:"weight"`
	Endpoint              string               `json:"endpoint"`
	Status                string               `json:"status"`
	Priority              int                  `json:"priority"`
	TTFT                  float64              `json:"ttft"`
	SuccessRate           float64              `json:"successRate"`
	Requests              int64                `json:"requests"`
	Enabled               bool                 `json:"enabled"`
	Color                 string               `json:"color"`
	History               []int                `json:"history"`
	CreatedAt             string               `json:"createdAt"`
	Archived              bool                 `json:"archived"`
	Config                ChannelConfig        `json:"config"`
	CredentialCount       int                  `json:"credentialCount"`
	Health                Health               `json:"health"`
	HasAccountCredentials bool                 `json:"hasAccountCredentials,omitempty"`
	AccountAuthMode       string               `json:"accountAuthMode,omitempty"`
	AccountIntegration    string               `json:"accountIntegration,omitempty"`
	AccountBalance        *GatewayBalance      `json:"accountBalance,omitempty"`
	DisplayMultiplier     float64              `json:"displayMultiplier"`
	Website               string               `json:"website"`
}
type ModelMapping struct {
	From string   `json:"from"`
	To   []string `json:"to"`
}
type KeyProfile struct {
	ID           string         `json:"id"`
	Name         string         `json:"name"`
	Scope        string         `json:"scope"`
	Tags         []string       `json:"tags"`
	Match        string         `json:"match"`
	ChannelIDs   []string       `json:"channelIds"`
	ModelMode    string         `json:"modelMode"`
	Models       []string       `json:"models"`
	RequestLimit string         `json:"requestLimit"`
	Mappings     []ModelMapping `json:"mappings"`
}
type APIKey struct {
	ID            string       `json:"id"`
	Name          string       `json:"name"`
	Preview       string       `json:"preview"`
	Status        string       `json:"status"`
	CreatedAt     string       `json:"createdAt"`
	Expires       string       `json:"expires"`
	Note          string       `json:"note"`
	Used          int64        `json:"used"`
	ActiveProfile string       `json:"activeProfile"`
	Profiles      []KeyProfile `json:"profiles"`
	TokenHash     string       `json:"-"`
}
type Credential struct {
	ID           string          `json:"id"`
	Label        string          `json:"label"`
	Preview      string          `json:"preview"`
	Enabled      bool            `json:"enabled"`
	FailureCount int             `json:"failureCount"`
	DisabledAt   *string         `json:"disabledAt"`
	CreatedAt    string          `json:"createdAt"`
	Reason       *string         `json:"reason"`
	Balance      *GatewayBalance `json:"balance,omitempty"`
	ExpiresAt    *string         `json:"expiresAt,omitempty"`
	Secret       string          `json:"-"`
}
type Settings struct {
	Account                 string  `json:"account"`
	Gateway                 string  `json:"gateway"`
	AIGatewayEnabled        bool    `json:"aiGatewayEnabled"`
	HasAIGatewayToken       bool    `json:"hasAiGatewayToken"`
	RetryEnabled            bool    `json:"retryEnabled"`
	MaxChannelRetries       int     `json:"maxChannelRetries"`
	MaxSameChannelRetries   int     `json:"maxSameChannelRetries"`
	RetryDelayMs            int     `json:"retryDelayMs"`
	StreamFirstTokenTimeout float64 `json:"streamFirstTokenTimeout"`
	NonStreamTimeout        float64 `json:"nonStreamTimeout"`
	EmptyResponseDetection  bool    `json:"emptyResponseDetection"`
	ErrorMode               string  `json:"errorMode"`
	CustomErrorMessage      string  `json:"customErrorMessage"`
	RetryStatuses           []int   `json:"retryStatuses"`
	Strategy                string  `json:"strategy"`
	StickyMode              string  `json:"stickyMode"`
	Threshold               float64 `json:"threshold"`
	ResponseThreshold       float64 `json:"responseThreshold"`
	Window                  int     `json:"window"`
	WindowSeconds           int     `json:"windowSeconds"`
	Samples                 int     `json:"samples"`
	Cooldown                float64 `json:"cooldown"`
	Recovery                int     `json:"recovery"`
	AutoSwitch              bool    `json:"autoSwitch"`
	AutoRecover             bool    `json:"autoRecover"`
	AutoDisableEnabled      bool    `json:"autoDisableEnabled"`
	AutoDisableTarget       string  `json:"autoDisableTarget"`
	AutoDisableStatuses     []int   `json:"autoDisableStatuses"`
	AutoDisableThreshold    int     `json:"autoDisableThreshold"`
	AutoDisableRecover      bool    `json:"autoDisableRecover"`
	AutoDisableCooldown     float64 `json:"autoDisableCooldown"`
	Notifications           bool    `json:"notifications"`
	LogRetentionDays        int     `json:"logRetentionDays"`
}
type Attempt struct {
	HealthIgnored bool     `json:"healthIgnored,omitempty"`
	ID            string   `json:"id"`
	RequestID     string   `json:"requestId"`
	ChannelID     string   `json:"channelId"`
	ChannelName   string   `json:"channelName"`
	CredentialID  *string  `json:"credentialId"`
	Model         string   `json:"model"`
	Stream        bool     `json:"stream"`
	StartedAt     string   `json:"startedAt"`
	TTFT          *float64 `json:"ttft"`
	Duration      float64  `json:"duration"`
	Status        int      `json:"status"`
	Result        string   `json:"result"`
	Error         *string  `json:"error"`
	InputTokens   int64    `json:"inputTokens"`
	OutputTokens  int64    `json:"outputTokens"`
	Attempt       int      `json:"attempt"`
}
type RequestLog struct {
	ID        string  `json:"id"`
	Time      string  `json:"time"`
	CreatedAt string  `json:"createdAt"`
	Model     string  `json:"model"`
	Channel   string  `json:"channel"`
	ChannelID *string `json:"channelId"`
	APIKeyID  *string `json:"apiKeyId"`
	Stream    bool    `json:"stream"`
	TTFT      float64 `json:"ttft"`
	Duration  float64 `json:"duration"`
	Tokens    int64   `json:"tokens"`
	Status    int     `json:"status"`
	Result    string  `json:"result"`
	Attempts  int     `json:"attempts"`
	Source    string  `json:"source"`
	TraceID   *string `json:"traceId"`
	Error     *string `json:"error"`
}
type Event struct {
	ID          string  `json:"id"`
	Time        string  `json:"time"`
	CreatedAt   string  `json:"createdAt"`
	Title       string  `json:"title"`
	Description string  `json:"description"`
	Type        string  `json:"type"`
	ChannelID   *string `json:"channelId"`
}

func DefaultSettings() Settings {
	return Settings{RetryEnabled: true, MaxChannelRetries: 3, MaxSameChannelRetries: 2, RetryDelayMs: 1000, StreamFirstTokenTimeout: 10, NonStreamTimeout: 60, EmptyResponseDetection: true, ErrorMode: "custom", CustomErrorMessage: "服务器错误，请重试", RetryStatuses: []int{408, 429, 500, 502, 503, 504}, Strategy: "failover", StickyMode: "prefer", Threshold: 10, ResponseThreshold: 20, Window: 20, Samples: 10, Cooldown: 60, Recovery: 5, AutoSwitch: true, AutoRecover: true, AutoDisableTarget: "key", AutoDisableStatuses: []int{401, 403}, AutoDisableThreshold: 3, AutoDisableRecover: true, AutoDisableCooldown: 60, Notifications: true, LogRetentionDays: 30}
}
func DefaultChannelConfig() ChannelConfig {
	return ChannelConfig{Protocol: "openai", GatewayMode: "direct", Aliases: []ModelAlias{}, Prices: []ModelPrice{}, Headers: map[string]string{}, BodyOverrides: map[string]any{}, Endpoints: Endpoints{Chat: "/chat/completions", Models: "/models", Messages: "/messages", Generate: "/models/{model}:generateContent"}, Cooldown: CooldownPolicy{FirstToken: true, Error: true}, AutoDisable: AutoDisable{Target: "key", Statuses: []int{401, 403}, Threshold: 3, Recover: true, Cooldown: 60}, Mock: MockConfig{Scenario: "healthy", DelayMs: 50, Status: 503, FailuresBeforeSuccess: 1}}
}
