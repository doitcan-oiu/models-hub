package gateway

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type HTTPConfig struct {
	AdminToken, PublicURL, StaticDir string
	AdminPasswordHash, SessionSecret string
	DatabaseType                     string
	DevMode                          bool
}
type Handler struct {
	store        *Store
	engine       *Engine
	integrations *Integrations
	config       HTTPConfig
	static       http.Handler
	loginSlots   chan struct{}
	loginLimits  loginLimiter
}

func NewHandler(s *Store, e *Engine, i *Integrations, c HTTPConfig) *Handler {
	if c.StaticDir == "" {
		c.StaticDir = "dist"
	}
	if normalized, err := normalizeHTTPOrigin(c.PublicURL); err == nil {
		c.PublicURL = normalized
	}
	return &Handler{store: s, engine: e, integrations: i, config: c, static: http.FileServer(http.Dir(c.StaticDir)), loginSlots: make(chan struct{}, 4)}
}
func randomSecret(prefix string) string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return prefix + base64.RawURLEncoding.EncodeToString(b[:])
}
func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func tokenHash(s string) string { sum := sha256.Sum256([]byte(s)); return hex.EncodeToString(sum[:]) }
func equalToken(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	ah, bh := sha256.Sum256([]byte(a)), sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(ah[:], bh[:]) == 1
}
func bearerToken(r *http.Request) string {
	p := strings.Fields(r.Header.Get("Authorization"))
	if len(p) == 2 && strings.EqualFold(p[0], "Bearer") {
		return p[1]
	}
	return ""
}
func (h *Handler) development(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return h.config.DevMode && ip != nil && ip.IsLoopback()
}
func (h *Handler) origin(r *http.Request) error {
	if equalToken(bearerToken(r), h.config.AdminToken) {
		return nil
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		if _, err := r.Cookie("pg_session"); err == nil {
			return &HTTPError{403, "Origin header required"}
		}
		return nil
	}
	u, err := url.Parse(origin)
	if err != nil || u.Path != "" {
		return &HTTPError{403, "Invalid Origin"}
	}
	actual, err := normalizeHTTPOrigin(origin)
	if err != nil || actual == "" {
		return &HTTPError{403, "Invalid Origin"}
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	expected := scheme + "://" + r.Host
	if h.config.PublicURL != "" {
		expected = strings.TrimRight(h.config.PublicURL, "/")
	}
	expected, err = normalizeHTTPOrigin(expected)
	if err == nil && actual == expected {
		return nil
	}
	if h.development(r) && (u.Hostname() == "localhost" || net.ParseIP(u.Hostname()) != nil && net.ParseIP(u.Hostname()).IsLoopback()) && (u.Scheme == "http" || u.Scheme == "https") {
		return nil
	}
	return &HTTPError{403, "Cross-origin mutation denied"}
}
func (h *Handler) authenticated(r *http.Request) bool {
	if equalToken(bearerToken(r), h.config.AdminToken) {
		return true
	}
	c, err := r.Cookie("pg_session")
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	var authHash string
	err = h.store.DB().QueryRowContext(ctx, "SELECT value FROM gateway_state WHERE id=$1 AND expires_at>now()", "session:"+tokenHash(c.Value)).Scan(&authHash)
	return err == nil && equalToken(authHash, h.sessionAuthHash())
}

// Bind sessions to the configured credentials. Password hashes never act as
// bearer tokens, and the independent random session secret survives restarts.
func (h *Handler) sessionAuthHash() string {
	if h.config.AdminPasswordHash != "" {
		return tokenHash(h.config.SessionSecret + "\x00" + h.config.AdminPasswordHash)
	}
	return tokenHash(h.config.AdminToken)
}

func (h *Handler) authMode() string {
	if h.config.AdminPasswordHash != "" {
		return "password"
	}
	return "token"
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func writeError(w http.ResponseWriter, err error) {
	status, message := 500, "服务操作失败，请检查服务日志"
	var coded interface{ StatusCode() int }
	if errors.As(err, &coded) {
		status = coded.StatusCode()
		message = err.Error()
	} else if errors.Is(err, ErrNotFound) {
		status = 404
		message = "记录不存在"
	} else if errors.Is(err, ErrConflict) {
		status = 409
		message = "记录已变化，请刷新后重试"
	} else if errors.Is(err, context.DeadlineExceeded) {
		status = 503
		message = "数据库或服务暂时繁忙，请重试"
	} else if errors.Is(err, context.Canceled) {
		status = 499
		message = "请求已取消"
	}
	if status >= 500 {
		slog.Error("management request failed", "error", err)
	}
	writeJSON(w, status, map[string]any{"error": map[string]any{"message": message, "type": "gateway_error"}})
}
func readBody(w http.ResponseWriter, r *http.Request, limit int64) (map[string]any, error) {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	defer r.Body.Close()
	d := json.NewDecoder(r.Body)
	var b map[string]any
	if err := d.Decode(&b); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, &HTTPError{413, "请求体过大"}
		}
		return nil, bad("请求须为 JSON 对象")
	}
	if b == nil {
		return nil, bad("请求须为 JSON 对象")
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return nil, bad("请求只能包含一个 JSON 对象")
	}
	return b, nil
}
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/v1/messages" {
		w = &anthropicWriter{ResponseWriter: w}
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	defer func() {
		if err := recover(); err != nil {
			slog.Error("HTTP handler panic", "error", err)
			writeError(w, errors.New("internal handler panic"))
		}
	}()
	if r.URL.Path == "/health/live" {
		writeJSON(w, 200, map[string]any{"status": "ok", "service": "pulsegate"})
		return
	}
	if r.URL.Path == "/health" || r.URL.Path == "/health/ready" {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := h.store.DB().PingContext(ctx); err != nil {
			writeJSON(w, 503, map[string]string{"status": "database_unavailable"})
			return
		}
		if h.engine.snapshot.Load() == nil {
			writeJSON(w, 503, map[string]string{"status": "configuration_unavailable"})
			return
		}
		writeJSON(w, 200, map[string]string{"status": "ok", "service": "pulsegate"})
		return
	}
	if r.URL.Path == "/api/session" {
		if err := h.session(w, r); err != nil {
			writeError(w, err)
		}
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/") {
		if !h.authenticated(r) {
			writeError(w, &HTTPError{401, "请先登录管理控制台"})
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			if err := h.origin(r); err != nil {
				writeError(w, err)
				return
			}
		}
		if err := h.admin(w, r); err != nil {
			writeError(w, err)
		}
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v1/") || strings.HasPrefix(r.URL.Path, "/v1beta/") {
		token := bearerToken(r)
		if token == "" {
			token = r.Header.Get("X-API-Key")
		}
		if token == "" {
			token = r.Header.Get("X-Goog-Api-Key")
		}
		if token == "" {
			token = r.URL.Query().Get("key")
		}
		if !strings.HasPrefix(token, "pg_live_") || len(token) > 512 {
			writeError(w, &HTTPError{401, "Invalid API key"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		key, err := h.store.FindKey(ctx, token)
		cancel()
		if err != nil && !errors.Is(err, ErrNotFound) {
			writeError(w, &HTTPError{503, "API Key validation temporarily unavailable"})
			return
		}
		if err != nil || key.Status != "active" || keyExpired(key) {
			writeError(w, &HTTPError{401, "Invalid, disabled or expired API key"})
			return
		}
		if r.URL.Path == "/v1/models" && r.Method == "GET" {
			channels, err := h.store.Channels(r.Context())
			if err != nil {
				writeError(w, err)
				return
			}
			data := []map[string]any{}
			for _, m := range visibleModels(channels, key) {
				data = append(data, map[string]any{"id": m, "object": "model", "created": 0, "owned_by": "pulsegate"})
			}
			writeJSON(w, 200, map[string]any{"object": "list", "data": data})
			return
		}
		if r.Method != "POST" {
			writeError(w, &HTTPError{405, "Method not allowed"})
			return
		}
		h.engine.ServeGateway(w, r, &key, "", "api")
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		http.NotFound(w, r)
		return
	}
	clean := filepath.Clean(filepath.FromSlash(r.URL.Path))
	full := filepath.Join(h.config.StaticDir, strings.TrimLeft(clean, "/\\"))
	if info, err := os.Stat(full); err == nil && !info.IsDir() {
		h.static.ServeHTTP(w, r)
		return
	}
	if strings.Contains(filepath.Base(r.URL.Path), ".") {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, filepath.Join(h.config.StaticDir, "index.html"))
}
func (h *Handler) session(w http.ResponseWriter, r *http.Request) error {
	dev := h.development(r)
	configured := h.config.AdminToken != "" || h.config.AdminPasswordHash != ""
	if r.Method == "GET" {
		writeJSON(w, 200, map[string]any{"authenticated": h.authenticated(r), "initialized": true, "configured": configured, "devMode": dev, "authMode": h.authMode(), "databaseType": h.config.DatabaseType})
		return nil
	}
	if err := h.origin(r); err != nil {
		return err
	}
	secure := r.TLS != nil || strings.HasPrefix(h.config.PublicURL, "https://")
	cookie := &http.Cookie{Name: "pg_session", Path: "/", HttpOnly: true, Secure: secure, SameSite: http.SameSiteStrictMode}
	if r.Method == "DELETE" {
		if old, e := r.Cookie("pg_session"); e == nil {
			_, err := h.store.DB().ExecContext(r.Context(), "DELETE FROM gateway_state WHERE id=$1", "session:"+tokenHash(old.Value))
			if err != nil {
				return err
			}
		}
		cookie.MaxAge = -1
		http.SetCookie(w, cookie)
		writeJSON(w, 200, map[string]bool{"authenticated": false})
		return nil
	}
	if r.Method != "POST" {
		return &HTTPError{405, "Method not allowed"}
	}
	b, err := readBody(w, r, 32000)
	if err != nil {
		return err
	}
	authorized := dev && b["dev"] == true || equalToken(str(b, "token"), h.config.AdminToken)
	if !authorized && !h.loginLimits.allow(r.RemoteAddr, time.Now()) {
		w.Header().Set("Retry-After", "60")
		return &HTTPError{429, "登录尝试过多，请稍后重试"}
	}
	if !authorized && h.config.AdminPasswordHash != "" {
		password := str(b, "password")
		if len(password) > 0 && len(password) <= 72 {
			select {
			case h.loginSlots <- struct{}{}:
				authorized = bcrypt.CompareHashAndPassword([]byte(h.config.AdminPasswordHash), []byte(password)) == nil
				<-h.loginSlots
			default:
				return &HTTPError{429, "登录请求过多，请稍后重试"}
			}
		}
	}
	if !authorized {
		return &HTTPError{401, "管理员密码或令牌无效"}
	}
	h.loginLimits.forget(r.RemoteAddr)
	token := randomSecret("pg_session_")
	cookie.Value = token
	cookie.MaxAge = 12 * 3600
	_, err = h.store.DB().ExecContext(r.Context(), "INSERT INTO gateway_state(id,value,expires_at) VALUES($1,$2,$3)", "session:"+tokenHash(token), h.sessionAuthHash(), time.Now().Add(12*time.Hour))
	if err != nil {
		return err
	}
	http.SetCookie(w, cookie)
	writeJSON(w, 200, map[string]any{"authenticated": true, "initialized": true, "configured": configured, "devMode": dev, "authMode": h.authMode(), "databaseType": h.config.DatabaseType})
	return nil
}
func keyExpired(k APIKey) bool { return keyExpiredAt(k, time.Now()) }
func keyExpiredAt(k APIKey, now time.Time) bool {
	if k.Expires == "" || k.Expires == "never" || k.Expires == "永不过期" {
		return false
	}
	expires := k.Expires
	if len(expires) == 10 {
		expires += "T23:59:59.999+08:00"
	}
	t, e := time.Parse(time.RFC3339Nano, expires)
	return e != nil || !t.After(now)
}
func profileFor(k APIKey) (KeyProfile, bool) {
	for _, p := range k.Profiles {
		if p.ID == k.ActiveProfile {
			return p, true
		}
	}
	return KeyProfile{}, false
}
func scopeAllows(c Channel, p KeyProfile) bool {
	if !c.Enabled || c.Archived {
		return false
	}
	has := func(list []string, v string) bool {
		for _, s := range list {
			if s == v {
				return true
			}
		}
		return false
	}
	switch p.Scope {
	case "channels":
		return has(p.ChannelIDs, c.ID)
	case "tags":
		n := 0
		for _, t := range p.Tags {
			if has(c.Tags, t) {
				n++
			}
		}
		switch p.Match {
		case "all":
			return n == len(p.Tags)
		case "none":
			return n == 0
		default:
			return n > 0
		}
	case "all":
		return true
	}
	return false
}
func visibleModels(channels []Channel, k APIKey) []string {
	p, ok := profileFor(k)
	if !ok {
		return []string{}
	}
	physical := map[string]bool{}
	for _, c := range channels {
		if scopeAllows(c, p) {
			for _, m := range c.Models {
				physical[m] = true
			}
			for _, a := range c.Config.Aliases {
				physical[a.From] = true
			}
		}
	}
	allowed := func(m string) bool {
		if !physical[m] {
			return false
		}
		if p.ModelMode == "all" {
			return true
		}
		for _, v := range p.Models {
			if v == m {
				return true
			}
		}
		return false
	}
	names := map[string]bool{}
	for m := range physical {
		if allowed(m) {
			names[m] = true
		}
	}
	for _, mapping := range p.Mappings {
		delete(names, mapping.From)
		for _, target := range mapping.To {
			if allowed(target) {
				names[mapping.From] = true
				break
			}
		}
	}
	out := []string{}
	for m := range names {
		out = append(out, m)
	}
	sort.Strings(out)
	return out
}
