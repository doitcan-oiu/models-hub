package gateway

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type EngineConfig struct {
	ChannelConcurrency, CircuitFailures, LogQueueSize, LogWorkers                int
	ConnectTimeout, ResponseHeaderTimeout, FirstTokenTimeout, NonStreamTimeout   time.Duration
	StreamIdleTimeout, StreamMaxDuration, DownstreamWriteTimeout, RequestTimeout time.Duration
	CacheTTL, CircuitCooldown                                                    time.Duration
	DevMode                                                                      bool
}

func (c EngineConfig) defaults() EngineConfig {
	if c.ChannelConcurrency <= 0 {
		c.ChannelConcurrency = 64
	}
	if c.CircuitFailures <= 0 {
		c.CircuitFailures = 3
	}
	if c.LogQueueSize <= 0 {
		c.LogQueueSize = 4096
	}
	if c.LogWorkers <= 0 {
		c.LogWorkers = 2
	}
	if c.ConnectTimeout <= 0 {
		c.ConnectTimeout = 5 * time.Second
	}
	if c.ResponseHeaderTimeout <= 0 {
		c.ResponseHeaderTimeout = 15 * time.Second
	}
	if c.FirstTokenTimeout <= 0 {
		c.FirstTokenTimeout = 15 * time.Second
	}
	if c.NonStreamTimeout <= 0 {
		c.NonStreamTimeout = 60 * time.Second
	}
	if c.StreamIdleTimeout <= 0 {
		c.StreamIdleTimeout = 30 * time.Second
	}
	if c.StreamMaxDuration <= 0 {
		c.StreamMaxDuration = 15 * time.Minute
	}
	if c.DownstreamWriteTimeout <= 0 {
		c.DownstreamWriteTimeout = 15 * time.Second
	}
	if c.RequestTimeout <= 0 {
		c.RequestTimeout = 20 * time.Minute
	}
	if c.CacheTTL <= 0 {
		c.CacheTTL = time.Second
	}
	if c.CircuitCooldown <= 0 {
		c.CircuitCooldown = 15 * time.Second
	}
	return c
}

// engineStore is deliberately small so concurrency behavior can be exercised
// against real HTTP servers without a database in the critical path of tests.
type engineStore interface {
	Channels(context.Context) ([]Channel, error)
	Settings(context.Context) (Settings, error)
	Credentials(context.Context, string, bool) ([]Credential, error)
	ConsumeKey(context.Context, string, string, int64) (bool, error)
	ReserveChannel(context.Context, Channel, int64) (bool, error)
	Record(context.Context, RequestLog, []Attempt) error
	UpdateHealth(context.Context, string, Health, string) error
}

type engineSnapshot struct {
	channels []Channel
	settings Settings
}
type engineLog struct {
	log      RequestLog
	attempts []Attempt
	health   []engineHealth
	done     chan struct{}
}
type engineHealth struct {
	id        string
	health    Health
	status    string
	startedAt string
	event     *Event
}
type engineSticky struct {
	channel string
	expires time.Time
}

type Engine struct {
	store           engineStore
	cfg             EngineConfig
	snapshot        atomic.Pointer[engineSnapshot]
	refreshMu       sync.Mutex
	runtimes        sync.Map
	routingMu       sync.Mutex
	routingCounters map[string]uint64
	logQueue        chan engineLog
	logMu           sync.RWMutex
	closed          bool
	stop            chan struct{}
	done            chan struct{}
	closeOnce       sync.Once
	stickyMu        sync.Mutex
	sticky          map[string]engineSticky
	droppedLogs     atomic.Uint64
}

func NewEngine(store *Store, cfg EngineConfig) *Engine { return newEngine(store, cfg) }

func newEngine(store engineStore, cfg EngineConfig) *Engine {
	cfg = cfg.defaults()
	e := &Engine{store: store, cfg: cfg, logQueue: make(chan engineLog, cfg.LogQueueSize), stop: make(chan struct{}), done: make(chan struct{}), sticky: map[string]engineSticky{}, routingCounters: map[string]uint64{}}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if err := e.Refresh(ctx); err != nil {
		slog.Error("gateway initial configuration unavailable", "error", err)
	}
	cancel()
	var workers sync.WaitGroup
	for range cfg.LogWorkers {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for item := range e.logQueue {
				e.persistItem(item)
			}
		}()
	}
	go func() {
		ticker := time.NewTicker(cfg.CacheTTL)
		defer ticker.Stop()
		defer close(e.done)
		for {
			select {
			case <-e.stop:
				workers.Wait()
				e.runtimes.Range(func(_, v any) bool { v.(*channelRuntime).transport.CloseIdleConnections(); return true })
				return
			case <-ticker.C:
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				_ = e.Refresh(ctx)
				cancel()
			}
		}
	}()
	return e
}

// Refresh only swaps a fully loaded immutable snapshot. Requests use the last
// good snapshot while a database refresh is slow or temporarily unavailable.
func (e *Engine) Refresh(ctx context.Context) error {
	e.refreshMu.Lock()
	defer e.refreshMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	channels, err := e.store.Channels(ctx)
	if err != nil {
		return err
	}
	settings, err := e.store.Settings(ctx)
	if err != nil {
		return err
	}
	e.snapshot.Store(&engineSnapshot{channels, settings})
	return nil
}

func (e *Engine) Close(ctx context.Context) error {
	e.closeOnce.Do(func() { e.logMu.Lock(); e.closed = true; close(e.logQueue); e.logMu.Unlock(); close(e.stop) })
	select {
	case <-e.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (e *Engine) DroppedLogs() uint64 { return e.droppedLogs.Load() }

func (e *Engine) persistItem(item engineLog) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	if err := e.store.Record(ctx, item.log, item.attempts); err != nil {
		slog.Warn("gateway telemetry write failed", "request_id", item.log.ID, "error", err)
	}
	cancel()
	if credentialStore, ok := e.store.(interface {
		ApplyCredentialAttempt(context.Context, Attempt, Channel, Settings, string) error
	}); ok {
		if snapshot := e.snapshot.Load(); snapshot != nil {
			for _, a := range item.attempts {
				for _, channel := range snapshot.channels {
					if channel.ID == a.ChannelID {
						ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
						if err := credentialStore.ApplyCredentialAttempt(ctx, a, channel, snapshot.settings, item.log.Source); err != nil {
							slog.Warn("gateway credential health write failed", "credential_id", a.CredentialID, "error", err)
						}
						cancel()
						break
					}
				}
			}
		}
	}
	seen := make(map[string]bool, len(item.health))
	for _, h := range item.health {
		if !seen[h.id] {
			seen[h.id] = true
			e.persistHealth(h.id)
		}
	}
	if eventStore, ok := e.store.(interface {
		AddEvent(context.Context, Event) error
	}); ok {
		events := make([]Event, 0)
		for _, h := range item.health {
			if h.event != nil {
				events = append(events, *h.event)
			}
		}
		if item.log.Result == "failover" {
			now := time.Now()
			events = append(events, Event{ID: engineID(), CreatedAt: now.UTC().Format(time.RFC3339Nano), Time: now.In(time.FixedZone("CST", 8*3600)).Format("15:04:05"), Title: "已切换备用渠道", Description: item.log.Channel + " 已接管 " + item.log.Model + " 请求", Type: "switch", ChannelID: item.log.ChannelID})
		}
		for _, event := range events {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			if err := eventStore.AddEvent(ctx, event); err != nil {
				slog.Warn("gateway event write failed", "error", err)
			}
			cancel()
		}
	}
	if item.done != nil {
		close(item.done)
	}
}

// ResetCircuit is called after an explicit health reset or endpoint edit.
func (e *Engine) ResetCircuit(channelID string) {
	if v, ok := e.runtimes.Load(channelID); ok {
		r := v.(*channelRuntime)
		r.mu.Lock()
		r.resetCircuitLocked()
		r.healthLoaded = false
		r.recentStream = nil
		r.recentNonstream = nil
		r.autoDisableFailures = 0
		r.resetAt = time.Now()
		r.mu.Unlock()
		r.transport.CloseIdleConnections()
	}
}

// ProbeChannel uses the provider's native request format and a finite overall
// deadline. Forced probes can test a circuit in cooldown without admitting API
// traffic to that circuit.
func (e *Engine) ProbeChannel(ctx context.Context, c Channel, stream bool) error {
	return e.probeChannel(ctx, c, stream, "")
}

func (e *Engine) ProbeCredential(ctx context.Context, c Channel, credentialID string, stream bool) error {
	return e.probeChannel(ctx, c, stream, credentialID)
}

type engineCredentialContextKey struct{}
type engineProbeContextKey struct{}
type engineProbeOutcome struct {
	status int
	err    error
}

func (e *Engine) probeChannel(ctx context.Context, c Channel, stream bool, credentialID string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	outcome := &engineProbeOutcome{}
	ctx = context.WithValue(ctx, engineProbeContextKey{}, outcome)
	if credentialID != "" {
		ctx = context.WithValue(ctx, engineCredentialContextKey{}, credentialID)
	}
	model := c.Model
	if len(c.Models) > 0 {
		model = c.Models[0]
	}
	path := "/v1/chat/completions"
	// Leave room for a short real answer; a one-token probe can end before
	// the model emits any content and prevent an otherwise healthy recovery.
	body := map[string]any{"model": model, "messages": []any{map[string]any{"role": "user", "content": "Reply OK"}}, "max_tokens": 64, "stream": stream}
	if c.Config.Protocol == "anthropic" {
		path = "/v1/messages"
	}
	if c.Config.Protocol == "gemini" {
		path = "/v1beta/models/" + model + ":generateContent"
		if stream {
			path = "/v1beta/models/" + model + ":streamGenerateContent?alt=sse"
		}
		body = map[string]any{"model": model, "contents": []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": "Reply OK"}}}}, "generationConfig": map[string]any{"maxOutputTokens": 64}}
	}
	data, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://gateway.internal"+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	recorder := &engineProbeWriter{header: make(http.Header)}
	e.ServeGateway(recorder, req, nil, c.ID, "probe")
	if outcome.err != nil {
		return outcome.err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if recorder.status < 200 || recorder.status >= 300 {
		return fmt.Errorf("channel probe failed: HTTP %d", recorder.status)
	}
	return nil
}

type engineProbeWriter struct {
	header http.Header
	status int
}

func (w *engineProbeWriter) Header() http.Header    { return w.header }
func (w *engineProbeWriter) WriteHeader(status int) { w.status = status }
func (w *engineProbeWriter) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.status = 200
	}
	return len(data), nil
}
func (w *engineProbeWriter) Flush() {}

func (e *Engine) enqueue(item engineLog) bool {
	e.logMu.RLock()
	defer e.logMu.RUnlock()
	if e.closed {
		return false
	}
	select {
	case e.logQueue <- item:
		return true
	default:
		e.droppedLogs.Add(1)
		return false
	}
}

type channelRuntime struct {
	mu                      sync.Mutex
	persistMu               sync.Mutex
	active, limit, failures int
	openUntil               time.Time
	halfOpen                bool
	circuitGeneration       uint64
	transport               *http.Transport
	client                  *http.Client
	credentialIndex         atomic.Uint64
	health                  Health
	healthLoaded            bool
	healthStatus            string
	healthStartedAt         string
	recentStream            []engineHealthSample
	recentNonstream         []engineHealthSample
	autoDisableFailures     int
	resetAt                 time.Time
}

func (e *Engine) persistHealth(channelID string) {
	v, ok := e.runtimes.Load(channelID)
	if !ok {
		return
	}
	rt := v.(*channelRuntime)
	// A slow telemetry worker must never overwrite newer channel health.
	rt.persistMu.Lock()
	defer rt.persistMu.Unlock()
	rt.mu.Lock()
	if !rt.healthLoaded {
		rt.mu.Unlock()
		return
	}
	health, status, startedAt := rt.health, rt.healthStatus, rt.healthStartedAt
	rt.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var err error
	if conditional, ok := e.store.(interface {
		UpdateHealthAfter(context.Context, string, Health, string, string) error
	}); ok {
		err = conditional.UpdateHealthAfter(ctx, channelID, health, status, startedAt)
	} else {
		err = e.store.UpdateHealth(ctx, channelID, health, status)
	}
	if err != nil {
		slog.Warn("gateway health write failed", "channel_id", channelID, "error", err)
	}
}

func (e *Engine) runtime(c Channel) *channelRuntime {
	return e.runtimeWithLimit(c.ID, e.cfg.ChannelConcurrency)
}
func (e *Engine) probeRuntime(c Channel) *channelRuntime { return e.runtimeWithLimit("probe:"+c.ID, 1) }
func (e *Engine) runtimeWithLimit(runtimeID string, limit int) *channelRuntime {
	if v, ok := e.runtimes.Load(runtimeID); ok {
		return v.(*channelRuntime)
	}
	t := &http.Transport{Proxy: http.ProxyFromEnvironment, DialContext: (&net.Dialer{Timeout: e.cfg.ConnectTimeout, KeepAlive: 30 * time.Second}).DialContext, ForceAttemptHTTP2: true, MaxIdleConns: limit, MaxIdleConnsPerHost: limit, MaxConnsPerHost: limit, IdleConnTimeout: 90 * time.Second, TLSHandshakeTimeout: e.cfg.ConnectTimeout, ResponseHeaderTimeout: e.cfg.ResponseHeaderTimeout, ExpectContinueTimeout: time.Second, MaxResponseHeaderBytes: 64 << 10}
	r := &channelRuntime{limit: limit, transport: t}
	r.client = &http.Client{Transport: t, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	v, loaded := e.runtimes.LoadOrStore(runtimeID, r)
	if loaded {
		t.CloseIdleConnections()
		return v.(*channelRuntime)
	}
	return r
}

type runtimeLease struct {
	generation uint64
	halfOpen   bool
	protected  bool
}

func (r *channelRuntime) resetCircuitLocked() {
	r.failures = 0
	r.openUntil = time.Time{}
	r.halfOpen = false
	r.circuitGeneration++
}

func (e *Engine) channelRuntimeState(channelID string) *ChannelRuntimeState {
	v, ok := e.runtimes.Load(channelID)
	if !ok {
		return nil
	}
	r := v.(*channelRuntime)
	r.mu.Lock()
	defer r.mu.Unlock()
	state := &ChannelRuntimeState{Active: r.active, Limit: r.limit, HalfOpen: r.halfOpen}
	if !r.openUntil.IsZero() {
		state.CircuitUntil = engineStringPtr(r.openUntil.UTC().Format(time.RFC3339Nano))
	}
	return state
}

// No caller waits for a slot. Each channel owns its own pool and semaphore.
func (r *channelRuntime) acquire(probe, protect bool) (runtimeLease, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	// The channel's error-cooldown exemption also applies to this fast circuit.
	if !protect && (!r.openUntil.IsZero() || r.failures > 0) {
		r.resetCircuitLocked()
	}
	now := time.Now()
	if r.active >= r.limit {
		return runtimeLease{}, "并发已满"
	}
	lease := runtimeLease{generation: r.circuitGeneration, protected: protect && !probe}
	if lease.protected && !r.openUntil.IsZero() {
		if now.Before(r.openUntil) || r.halfOpen {
			return runtimeLease{}, "熔断冷却或恢复检测中"
		}
		r.halfOpen = true
		lease.halfOpen = true
	}
	r.active++
	return lease, ""
}

func (r *channelRuntime) release(lease runtimeLease, outcome int, cfg EngineConfig) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.active--
	// A pre-reset or pre-recovery request must release its slot without
	// reopening the circuit or releasing another request's half-open lease.
	if lease.generation != r.circuitGeneration {
		return
	}
	if lease.halfOpen {
		r.halfOpen = false
	}
	if !lease.protected {
		return
	}
	if outcome > 0 {
		r.resetCircuitLocked()
	} else if outcome < 0 {
		// Requests admitted before the circuit opened must not extend its
		// cooldown. Only the admitted half-open request can open it again.
		if !r.openUntil.IsZero() && !lease.halfOpen {
			return
		}
		r.failures++
		if r.failures >= cfg.CircuitFailures {
			r.openUntil = time.Now().Add(cfg.CircuitCooldown)
			r.halfOpen = false
		}
	}
}

type attemptResult struct {
	status        int
	body          []byte
	header        http.Header
	err           error
	visible       bool
	ttft          *float64
	input, output int64
	cancelled     bool
	retry         bool
	healthIgnored bool
}

func (e *Engine) ServeGateway(w http.ResponseWriter, r *http.Request, key *APIKey, forceChannelID, source string) {
	start := time.Now()
	id := engineID()
	w.Header().Set("X-Pulsegate-Request-Id", id)
	clientContext := r.Context()
	ctx, cancel := context.WithTimeout(clientContext, e.cfg.RequestTimeout)
	defer cancel()
	r = r.WithContext(ctx)
	snapshot := e.snapshot.Load()
	if snapshot == nil {
		engineError(w, 503, "网关配置暂时不可用", id)
		return
	}
	s := snapshot.settings
	raw, err := io.ReadAll(io.LimitReader(r.Body, (4<<20)+1))
	if err != nil {
		engineError(w, 400, "无法读取请求体", id)
		return
	}
	if len(raw) > 4<<20 {
		engineError(w, 413, "请求体不能超过 4 MiB", id)
		return
	}
	var body map[string]any
	if json.Unmarshal(raw, &body) != nil || body == nil {
		engineError(w, 400, "请求体必须为有效 JSON 对象", id)
		return
	}
	model, _ := body["model"].(string)
	if model == "" && strings.HasPrefix(r.URL.Path, "/v1beta/models/") {
		model = strings.TrimPrefix(r.URL.Path, "/v1beta/models/")
		model = strings.SplitN(model, ":", 2)[0]
		body["model"] = model
	}
	if strings.TrimSpace(model) == "" {
		engineError(w, 400, "请求需要 model 供渠道路由", id)
		return
	}
	stream, _ := body["stream"].(bool)
	if strings.Contains(r.URL.Path, ":streamGenerateContent") {
		stream = true
	}
	if v, exists := body["stream"]; exists {
		if _, ok := v.(bool); !ok {
			engineError(w, 400, "stream 必须为布尔值", id)
			return
		}
	}
	profile := currentEngineProfile(key)
	if key != nil && (key.Status != "active" || profile == nil || engineExpired(key.Expires)) {
		engineError(w, 401, "API Key 未启用、已过期或策略无效", id)
		return
	}
	authorized := engineCandidates(snapshot.channels, profile, model, forceChannelID, s, true)
	if len(authorized) == 0 {
		engineError(w, 403, "当前策略范围内没有支持该模型的授权渠道", id)
		return
	}
	candidates := engineCandidates(snapshot.channels, profile, model, forceChannelID, s, false)
	trace := limitEngineString(r.Header.Get("X-Trace-Id"), 128)
	thread := limitEngineString(r.Header.Get("X-Thread-Id"), 128)
	identity := "admin:all:" + model
	if key != nil {
		identity = key.ID + ":" + profile.ID + ":" + model
	}
	scope := ""
	if trace != "" {
		scope = identity + ":trace:" + trace
	} else if thread != "" {
		scope = identity + ":thread:" + thread
	}
	sticky := e.readSticky(scope)
	if sticky == "" && thread != "" {
		sticky = e.readSticky(identity + ":thread:" + thread)
	}
	offset := uint64(0)
	if s.Strategy == "round-robin" {
		offset = e.nextRoundRobin(identity)
	}
	orderEngineCandidates(candidates, s, stream, offset, sticky)
	var attempts []Attempt
	var health []engineHealth
	var last engineCandidate
	result := attemptResult{status: 503, err: errors.New(engineUnavailableReason(authorized, s))}
	attemptNumber := 0
	defer func() {
		if probe, ok := ctx.Value(engineProbeContextKey{}).(*engineProbeOutcome); ok {
			probe.status = result.status
			probe.err = result.err
		}
		if attemptNumber == 0 && result.visible {
			return
		}
		now := time.Now()
		log := RequestLog{ID: id, Time: now.In(time.FixedZone("CST", 8*3600)).Format("15:04:05"), CreatedAt: now.UTC().Format(time.RFC3339Nano), Model: model, Channel: last.channel.Name, Stream: stream, Duration: time.Since(start).Seconds(), Tokens: result.input + result.output, Status: result.status, Result: "error", Attempts: attemptNumber, Source: source}
		log.Tokens = 0
		for _, a := range attempts {
			log.Tokens += a.InputTokens + a.OutputTokens
		}
		if log.Channel == "" {
			log.Channel = "无可用渠道"
		}
		if last.channel.ID != "" {
			log.ChannelID = engineStringPtr(last.channel.ID)
		}
		if key != nil {
			log.APIKeyID = engineStringPtr(key.ID)
		}
		if trace != "" {
			log.TraceID = &trace
		}
		if result.ttft != nil {
			log.TTFT = *result.ttft
		}
		if result.err != nil {
			log.Error = engineStringPtr(result.err.Error())
		} else {
			log.Result = "success"
			if len(attempts) > 0 {
				log.Result = attempts[len(attempts)-1].Result
			}
			for _, a := range attempts {
				if a.ChannelID != last.channel.ID {
					log.Result = "failover"
					break
				}
			}
		}
		item := engineLog{log: log, attempts: attempts, health: health}
		if source == "probe" {
			e.persistItem(item)
		} else {
			e.enqueue(item)
		}
	}()
	if len(candidates) == 0 {
		engineError(w, result.status, e.publicError(s, result.err.Error()), id)
		return
	}
	quotaConsumed := false
	maxChannels := 1
	if s.RetryEnabled {
		maxChannels = 1 + min(10, max(0, s.MaxChannelRetries))
	}
	usedChannels := 0
	busy, circuits := 0, 0
	for _, candidate := range candidates {
		if usedChannels >= maxChannels {
			break
		}
		primaryRuntime := e.runtime(candidate.channel)
		rt := primaryRuntime
		if source == "probe" {
			rt = e.probeRuntime(candidate.channel)
		}
		rounds := 1
		if s.RetryEnabled && source != "probe" {
			rounds += min(5, max(0, s.MaxSameChannelRetries))
		}
		admitted := false
		for round := 0; round < rounds; round++ {
			if ctx.Err() != nil {
				result = attemptResult{status: 499, err: ctx.Err(), cancelled: true}
				break
			}
			if round > 0 && s.RetryDelayMs > 0 {
				timer := time.NewTimer(time.Duration(min(s.RetryDelayMs, 10000)) * time.Millisecond)
				select {
				case <-ctx.Done():
					timer.Stop()
				case <-timer.C:
				}
				if ctx.Err() != nil {
					result = attemptResult{status: 499, err: ctx.Err(), cancelled: true}
					break
				}
			}
			lease, blocked := rt.acquire(source == "probe", candidate.channel.Config.Cooldown.Error)
			if blocked != "" {
				if blocked == "并发已满" {
					busy++
				} else {
					circuits++
				}
				break
			}
			if key != nil && !quotaConsumed {
				limit, _ := strconv.ParseInt(profile.RequestLimit, 10, 64)
				dbctx, dbcancel := context.WithTimeout(ctx, 3*time.Second)
				ok, consumeErr := e.store.ConsumeKey(dbctx, key.ID, profile.ID, max(int64(0), limit))
				dbcancel()
				if consumeErr != nil || !ok {
					rt.release(lease, 0, e.cfg)
					result.status = 429
					result.err = errors.New("API Key 请求额度已用完或策略已变更")
					if consumeErr != nil {
						result.status = 503
						result.err = errors.New("API Key 额度校验暂时不可用")
					}
					engineError(w, result.status, result.err.Error(), id)
					return
				}
				quotaConsumed = true
			}
			if !admitted {
				usedChannels++
				admitted = true
			}
			last = candidate
			attemptNumber++
			began := time.Now()
			var credential Credential
			result, credential = e.attempt(w, r, candidate, rt, body, raw, model, stream, s, id, attemptNumber, source)
			outcome := 0
			if result.err == nil {
				outcome = 1
			} else if !result.cancelled && !result.healthIgnored && (result.status >= 500 || result.status == 408 || result.status == 429 || result.status == 401 || result.status == 403) {
				outcome = -1
			}
			rt.release(lease, outcome, e.cfg)
			if source == "probe" && outcome > 0 {
				primaryRuntime.mu.Lock()
				if began.After(primaryRuntime.resetAt) {
					primaryRuntime.resetCircuitLocked()
				}
				primaryRuntime.mu.Unlock()
			}
			a := Attempt{ID: engineID(), RequestID: id, ChannelID: candidate.channel.ID, ChannelName: candidate.channel.Name, Model: candidate.model, Stream: stream, StartedAt: began.UTC().Format(time.RFC3339Nano), TTFT: result.ttft, Duration: time.Since(began).Seconds(), Status: result.status, Result: "success", InputTokens: result.input, OutputTokens: result.output, Attempt: attemptNumber}
			a.HealthIgnored = result.healthIgnored
			if credential.ID != "" {
				a.CredentialID = engineStringPtr(credential.ID)
			}
			if result.err != nil {
				a.Result = "error"
				if result.cancelled {
					a.Result = "cancelled"
				}
				a.Error = engineStringPtr(result.err.Error())
			} else if stream && a.TTFT != nil && *a.TTFT > float64(s.Threshold) || !stream && a.Duration > float64(s.ResponseThreshold) {
				a.Result = "slow"
			}
			attempts = append(attempts, a)
			// Retesting an already disabled key must not mark the whole channel
			// unhealthy or break another key's channel-recovery streak.
			failedDisabledKeyProbe := source == "probe" && !credential.Enabled && credential.ID != "" && result.err != nil
			if !failedDisabledKeyProbe {
				if h := primaryRuntime.observe(candidate.channel, a, s); h.id != "" {
					health = append(health, h)
				}
			}
			if result.err == nil {
				if s.StickyMode == "prefer" {
					e.rememberSticky(scope, candidate.channel.ID)
					if thread != "" {
						e.rememberSticky(identity+":thread:"+thread, candidate.channel.ID)
					}
				}
				return
			}
			if result.visible || result.cancelled {
				if !result.visible && clientContext.Err() == nil && ctx.Err() != nil {
					result.status = 504
					result.err = errors.New("请求总处理期限已到")
					engineError(w, 504, e.publicError(s, result.err.Error()), id)
				}
				return
			}
			if !result.retry {
				break
			}
		}
		if result.cancelled || result.visible {
			break
		}
		if admitted && !result.retry {
			break
		}
	}
	if ctx.Err() != nil {
		if clientContext.Err() == nil && !result.visible {
			result.status = 504
			result.err = errors.New("请求总处理期限已到")
			engineError(w, 504, e.publicError(s, result.err.Error()), id)
		}
		return
	}
	if len(result.body) > 0 && s.ErrorMode == "raw" {
		copyEngineHeaders(w.Header(), result.header)
		w.Header().Set("X-Pulsegate-Request-Id", id)
		setEngineResponseHeaders(w, id, last.channel.ID, attemptNumber, nil)
		w.WriteHeader(result.status)
		_, _ = w.Write(result.body)
		return
	}
	if attemptNumber == 0 && busy+circuits > 0 {
		result.err = fmt.Errorf("已授权渠道暂不可用：并发已满 %d 个，熔断冷却或恢复检测中 %d 个", busy, circuits)
	}
	engineError(w, result.status, e.publicError(s, errorString(result.err)), id)
}

func engineUnavailableReason(authorized []engineCandidate, s Settings) string {
	var disabled, automatic, unhealthy int
	for _, c := range authorized {
		switch {
		case !c.channel.Enabled:
			disabled++
		case c.channel.Health.AutoDisabled:
			automatic++
		case s.AutoSwitch && c.channel.Status != "healthy":
			unhealthy++
		}
	}
	return fmt.Sprintf("已授权渠道不可用：手动停用 %d 个，自动停用 %d 个，健康检查未恢复 %d 个", disabled, automatic, unhealthy)
}

func (e *Engine) attempt(w http.ResponseWriter, r *http.Request, c engineCandidate, rt *channelRuntime, original map[string]any, raw []byte, clientModel string, stream bool, s Settings, id string, number int, source string) (result attemptResult, credential Credential) {
	result = attemptResult{status: 502, retry: true, healthIgnored: true}
	began := time.Now()
	timeout := e.cfg.NonStreamTimeout
	if s.NonStreamTimeout > 0 {
		timeout = time.Duration(float64(s.NonStreamTimeout) * float64(time.Second))
	}
	if stream {
		timeout = e.cfg.StreamMaxDuration
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	firstTimeout := e.cfg.FirstTokenTimeout
	if s.StreamFirstTokenTimeout > 0 {
		firstTimeout = time.Duration(float64(s.StreamFirstTokenTimeout) * float64(time.Second))
	}
	var firstTimer *time.Timer
	if stream {
		firstTimer = time.AfterFunc(firstTimeout, cancel)
		defer firstTimer.Stop()
	}
	dbctx, dbcancel := context.WithTimeout(ctx, 3*time.Second)
	credentials, err := e.store.Credentials(dbctx, c.channel.ID, source == "probe")
	dbcancel()
	if err != nil {
		result.status = 503
		result.err = errors.New("上游密钥暂时不可用")
		return
	}
	available := make([]Credential, 0, len(credentials))
	forceCredential, _ := r.Context().Value(engineCredentialContextKey{}).(string)
	for _, v := range credentials {
		if forceCredential != "" && v.ID != forceCredential {
			continue
		}
		if (v.Enabled || source == "probe" && v.Reason != nil) && !credentialEngineExpired(v) {
			available = append(available, v)
		}
	}
	if source == "probe" && forceCredential == "" {
		// Channel recovery should use an active key when one exists; disabled
		// keys are checked independently by the credential recovery scheduler.
		enabled := make([]Credential, 0, len(available))
		for _, v := range available {
			if v.Enabled {
				enabled = append(enabled, v)
			}
		}
		if len(enabled) > 0 {
			available = enabled
		}
	}
	if len(available) == 0 && c.channel.Config.Protocol != "mock" {
		result.status = 503
		result.err = errors.New("渠道没有可用的上游密钥")
		return
	}
	if len(available) > 0 {
		credential = available[(rt.credentialIndex.Add(1)-1)%uint64(len(available))]
	}
	payload := raw
	effectiveBody := original
	geminiPath := strings.HasPrefix(r.URL.Path, "/v1beta/")
	if c.model != clientModel || len(c.channel.Config.BodyOverrides) > 0 || geminiPath {
		body := make(map[string]any, len(original))
		for k, v := range original {
			body[k] = v
		}
		body["model"] = c.model
		if geminiPath {
			delete(body, "model")
		}
		for k, v := range c.channel.Config.BodyOverrides {
			switch k {
			case "model", "stream", "messages", "contents", "system", "systemInstruction":
				result.status = 400
				result.retry = false
				result.err = fmt.Errorf("渠道请求覆盖不允许修改 %s", k)
				return
			}
			body[k] = v
		}
		payload, err = json.Marshal(body)
		if err != nil {
			result.status = 400
			result.retry = false
			result.err = err
			return
		}
		effectiveBody = body
	}
	if c.channel.Config.RateLimit.RequestsPerMinute > 0 || c.channel.Config.RateLimit.TokensPerMinute > 0 {
		estimated := estimateEngineTokens(payload, effectiveBody, c.channel.Config.RateLimit.TokensPerMinute)
		dbctx, dbcancel := context.WithTimeout(ctx, 2*time.Second)
		ok, reserveErr := e.store.ReserveChannel(dbctx, c.channel, estimated)
		dbcancel()
		if reserveErr != nil || !ok {
			result.status = 429
			result.err = errors.New("渠道速率限制已触发或暂不可用")
			return
		}
	}
	var response *http.Response
	if c.channel.Config.Protocol == "mock" {
		if !e.cfg.DevMode {
			result.status = 403
			result.retry = false
			result.err = errors.New("演示渠道仅在 DEV_MODE=true 时启用")
			return
		}
		response, err = e.mockResponse(ctx, c.channel, original, stream, number)
		result.healthIgnored = false
	} else {
		path := r.URL.EscapedPath()
		if strings.HasPrefix(path, "/v1beta/models/") && c.model != clientModel {
			if colon := strings.LastIndex(path, ":"); colon >= 0 {
				path = "/v1beta/models/" + url.PathEscape(c.model) + path[colon:]
			}
		}
		target, urlErr := ResolveUpstreamURL(c.channel, path, c.model, stream)
		if urlErr != nil {
			result.status = 400
			result.retry = false
			result.err = urlErr
			return
		}
		incomingQuery := r.URL.Query()
		if geminiPath {
			incomingQuery.Del("key")
		}
		if incomingQuery.Encode() != "" {
			separator := "?"
			if strings.Contains(target, "?") {
				separator = "&"
			}
			target += separator + incomingQuery.Encode()
		}
		request, requestErr := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(payload))
		if requestErr != nil {
			result.err = requestErr
			return
		}
		protocol := "openai"
		if r.URL.Path == "/v1/messages" {
			protocol = "anthropic"
		} else if strings.HasPrefix(r.URL.Path, "/v1beta/") {
			protocol = "gemini"
		}
		request.Header = UpstreamHeaders(c.channel, credential.Secret, r.Header, protocol)
		result.healthIgnored = false
		response, err = rt.client.Do(request)
	}
	if err != nil {
		result.err = engineSafeError(err, credential.Secret)
		if ctx.Err() != nil {
			result.status = 504
			result.err = errors.New("上游连接、响应或首 Token 超时")
		}
		if r.Context().Err() != nil {
			result.status = 499
			result.cancelled = true
			result.err = errors.New("客户端取消或请求总期限已到")
		}
		return
	}
	defer response.Body.Close()
	result.status = response.StatusCode
	result.header = response.Header
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		data, readErr := readEngineBounded(response.Body, 64<<10)
		result.body = redactEngineBytes(data, credential.Secret)
		result.err = fmt.Errorf("HTTP %d: %s", response.StatusCode, limitEngineString(string(result.body), 4000))
		if readErr != nil {
			result.err = fmt.Errorf("HTTP %d: 无法读取上游错误正文", response.StatusCode)
		}
		result.retry = containsStatus(s.RetryStatuses, response.StatusCode)
		return
	}
	stream = strings.Contains(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream")
	if stream {
		return e.streamAttempt(w, r, response, c, clientModel, s, id, number, began, cancel, firstTimer, credential, source == "probe"), credential
	}
	data, readErr := readEngineBounded(response.Body, 8<<20)
	if readErr != nil {
		result.status = 502
		result.err = engineSafeError(readErr, credential.Secret)
		if ctx.Err() != nil {
			result.status = 504
			result.err = errors.New("上游响应超时")
		}
		if r.Context().Err() != nil {
			result.status = 499
			result.cancelled = true
		}
		return
	}
	observed := observeEngineJSON(data, clientModel, c.model != clientModel, "")
	result.input, result.output = observed.input, observed.output
	if observed.failure != "" {
		result.status = http.StatusBadGateway
		result.err = errors.New(redactEngineString(observed.failure, credential.Secret))
		result.body = redactEngineBytes(data, credential.Secret)
		result.retry = true
		return
	}
	if source == "probe" && !observed.modelOutput {
		result.status = http.StatusBadGateway
		result.err = errors.New("上游探测未返回可识别的模型输出")
		return
	}
	if source != "probe" && s.EmptyResponseDetection && !observed.meaningful && response.StatusCode != 204 && response.StatusCode != 205 {
		result.status = 502
		result.err = errors.New("上游返回空内容")
		return
	}
	copyEngineHeaders(w.Header(), response.Header)
	setEngineResponseHeaders(w, id, c.channel.ID, number, nil)
	w.WriteHeader(response.StatusCode)
	_, err = writeEngine(w, observed.bytes, e.cfg.DownstreamWriteTimeout)
	if err != nil {
		result.status = 499
		result.cancelled = true
		result.err = errors.New("客户端取消或读取响应过慢")
	}
	result.visible = true
	return
}

// Only a value up to the configured budget plus one is needed for admission.
// Clamp before conversion so large JSON numbers cannot overflow into zero or
// negative reservations. With RPM only, no output-token reservation is needed.
func estimateEngineTokens(payload []byte, body map[string]any, limit int) int64 {
	input := int64(len(payload) / 3)
	if limit <= 0 {
		return input + 4096
	}
	ceiling := int64(limit) + 1
	output := 0.0
	for _, field := range []string{"max_tokens", "max_completion_tokens", "max_output_tokens"} {
		if n, ok := body[field].(float64); ok && n > output {
			output = n
		}
	}
	if n, ok := asEngineObject(body["generationConfig"])["maxOutputTokens"].(float64); ok && n > output {
		output = n
	}
	if output <= 0 {
		output = 4096
	}
	copies := 1.0
	for _, field := range []string{"n", "best_of"} {
		if n, ok := body[field].(float64); ok && n > copies {
			copies = n
		}
	}
	if n, ok := asEngineObject(body["generationConfig"])["candidateCount"].(float64); ok && n > copies {
		copies = n
	}
	output *= copies
	if input >= ceiling || output >= float64(ceiling-input) {
		return ceiling
	}
	return input + int64(math.Ceil(output))
}

func (e *Engine) readSticky(scope string) string {
	if scope == "" {
		return ""
	}
	e.stickyMu.Lock()
	defer e.stickyMu.Unlock()
	v := e.sticky[scope]
	if time.Now().After(v.expires) {
		delete(e.sticky, scope)
		return ""
	}
	return v.channel
}

func (e *Engine) nextRoundRobin(scope string) uint64 {
	e.routingMu.Lock()
	defer e.routingMu.Unlock()
	offset := e.routingCounters[scope]
	if len(e.routingCounters) >= 10000 {
		if _, exists := e.routingCounters[scope]; !exists {
			for k := range e.routingCounters {
				delete(e.routingCounters, k)
				break
			}
		}
	}
	e.routingCounters[scope] = offset + 1
	return offset
}
func (e *Engine) rememberSticky(scope, channel string) {
	if scope == "" {
		return
	}
	e.stickyMu.Lock()
	defer e.stickyMu.Unlock()
	if len(e.sticky) >= 10000 {
		now := time.Now()
		for k, v := range e.sticky {
			if now.After(v.expires) {
				delete(e.sticky, k)
			}
		}
		if len(e.sticky) >= 10000 {
			for k := range e.sticky {
				delete(e.sticky, k)
				break
			}
		}
	}
	e.sticky[scope] = engineSticky{channel, time.Now().Add(30 * time.Minute)}
}
func (e *Engine) publicError(s Settings, message string) string {
	if s.ErrorMode == "raw" {
		return message
	}
	if s.ErrorMode == "custom" && s.CustomErrorMessage != "" {
		return s.CustomErrorMessage
	}
	return "上游服务暂时不可用，请稍后重试"
}
func engineID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(b[:])
}
func engineStringPtr(v string) *string { return &v }
func engineExpired(value string) bool {
	if value == "" || value == "永不过期" || value == "never" {
		return false
	}
	if len(value) == 10 {
		value += "T23:59:59.999+08:00"
	}
	t, err := time.Parse(time.RFC3339Nano, value)
	return err != nil || !time.Now().Before(t)
}
func credentialEngineExpired(c Credential) bool {
	if c.ExpiresAt != nil && engineExpired(*c.ExpiresAt) {
		return true
	}
	if c.Balance != nil && c.Balance.ExpiresAt != nil && engineExpired(*c.Balance.ExpiresAt) {
		return true
	}
	return c.Balance != nil && c.Balance.Status == "ok" && c.Balance.Amount != nil && *c.Balance.Amount <= 0
}
func containsStatus(values []int, value int) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func limitEngineString(v string, n int) string {
	if len(v) > n {
		return v[:n]
	}
	return v
}
func errorString(err error) string {
	if err == nil {
		return "上游暂时不可用"
	}
	return err.Error()
}
func engineSafeError(err error, secret string) error {
	var networkError *url.Error
	if errors.As(err, &networkError) {
		err = networkError.Err
	}
	return errors.New(limitEngineString(redactEngineString(errorString(err), secret), 4000))
}
func redactEngineString(value, secret string) string {
	if secret != "" {
		return strings.ReplaceAll(value, secret, "[REDACTED]")
	}
	return value
}
func redactEngineBytes(value []byte, secret string) []byte {
	return []byte(redactEngineString(string(value), secret))
}
func engineError(w http.ResponseWriter, status int, message, id string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Pulsegate-Request-Id", id)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"message": message, "type": "gateway_error", "request_id": id}})
}
func readEngineBounded(r io.Reader, max int) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, int64(max)+1))
	if len(data) > max {
		return nil, fmt.Errorf("上游正文超过 %d 字节", max)
	}
	return data, err
}
func copyEngineHeaders(dst, src http.Header) {
	blocked := map[string]bool{"Content-Length": true, "Content-Encoding": true, "Transfer-Encoding": true, "Connection": true, "Keep-Alive": true, "Proxy-Authenticate": true, "Proxy-Authorization": true, "Te": true, "Trailer": true, "Upgrade": true, "Set-Cookie": true, "Etag": true}
	for _, v := range src.Values("Connection") {
		for _, k := range strings.Split(v, ",") {
			blocked[http.CanonicalHeaderKey(strings.TrimSpace(k))] = true
		}
	}
	for k, v := range src {
		if !blocked[http.CanonicalHeaderKey(k)] && !strings.HasPrefix(strings.ToLower(k), "x-pulsegate-") {
			dst[k] = append([]string(nil), v...)
		}
	}
}
func setEngineResponseHeaders(w http.ResponseWriter, id, channel string, attempts int, ttft *float64) {
	w.Header().Set("X-Pulsegate-Request-Id", id)
	w.Header().Set("X-Pulsegate-Channel-Id", channel)
	w.Header().Set("X-Pulsegate-Attempts", strconv.Itoa(attempts))
	if ttft != nil {
		w.Header().Set("X-Pulsegate-Ttft-Ms", strconv.FormatInt(int64(*ttft*1000), 10))
	}
}
func writeEngine(w http.ResponseWriter, data []byte, timeout time.Duration) (int, error) {
	controller := http.NewResponseController(w)
	_ = controller.SetWriteDeadline(time.Now().Add(timeout))
	n, err := w.Write(data)
	if err == nil && strings.Contains(w.Header().Get("Content-Type"), "text/event-stream") {
		err = controller.Flush()
		if errors.Is(err, http.ErrNotSupported) {
			err = nil
		}
	}
	return n, err
}

func (e *Engine) mockResponse(ctx context.Context, c Channel, body map[string]any, stream bool, number int) (*http.Response, error) {
	delay := time.Duration(max(0, c.Config.Mock.DelayMs)) * time.Millisecond
	t := time.NewTimer(delay)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-t.C:
	}
	status := 200
	var data string
	scenario := c.Config.Mock.Scenario
	if scenario == "error" || scenario == "transient" && number <= c.Config.Mock.FailuresBeforeSuccess {
		status = c.Config.Mock.Status
		if status < 400 {
			status = 503
		}
		data = `{"error":{"message":"mock failure"}}`
	} else {
		message := "OK"
		if scenario == "empty" {
			message = ""
		}
		value := map[string]any{"id": "mock-" + engineID(), "object": "chat.completion", "model": body["model"], "choices": []any{map[string]any{"index": 0, "message": map[string]any{"role": "assistant", "content": message}, "finish_reason": "stop"}}, "usage": map[string]any{"prompt_tokens": 1, "completion_tokens": 1}}
		if stream {
			value["object"] = "chat.completion.chunk"
			value["choices"] = []any{map[string]any{"index": 0, "delta": map[string]any{"content": message}}}
		}
		encoded, _ := json.Marshal(value)
		data = string(encoded)
		if stream {
			data = "data: " + data + "\n\ndata: [DONE]\n\n"
		}
		if scenario == "disconnect" && stream {
			data = strings.TrimSuffix(data, "data: [DONE]\n\n")
		}
	}
	header := http.Header{"Content-Type": []string{"application/json"}}
	if stream && status == 200 {
		header.Set("Content-Type", "text/event-stream")
	}
	return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(strings.NewReader(data))}, nil
}
