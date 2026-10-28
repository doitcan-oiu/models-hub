package gateway

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	bbExhaustedReason    = "BBDevLab 额度耗尽"
	bbExpiredReason      = "BBDevLab Key 已到期"
	bbBalanceError       = "BBDevLab 余额查询失败，请检查 API Key 与接口连接"
	integrationBodyLimit = 512 * 1024
)

type integrationError struct {
	status  int
	message string
}

func (e *integrationError) Error() string                 { return e.message }
func (e *integrationError) StatusCode() int               { return e.status }
func integrationFailure(status int, message string) error { return &integrationError{status, message} }

// Integrations uses its own bounded connection pool. Maintenance requests never
// borrow inference concurrency slots or keep a global mutex during network I/O.
type Integrations struct {
	store    *Store
	client   *http.Client
	workers  int
	interval time.Duration
}

func NewIntegrations(store *Store) *Integrations {
	transport := &http.Transport{Proxy: http.ProxyFromEnvironment, DialContext: (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext, ForceAttemptHTTP2: true, MaxIdleConns: 64, MaxIdleConnsPerHost: 4, MaxConnsPerHost: 4, IdleConnTimeout: 60 * time.Second, TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 10 * time.Second, ExpectContinueTimeout: time.Second}
	return &Integrations{store: store, client: &http.Client{Transport: transport, Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, workers: 4, interval: 15 * time.Second}
}

func (i *Integrations) request(ctx context.Context, base, path, method string, headers http.Header, payload any, limit int64) (map[string]any, *http.Response, error) {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return nil, nil, err
		}
		body = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, base+path, body)
	if err != nil {
		return nil, nil, integrationFailure(400, "上游地址无效")
	}
	if headers != nil {
		req.Header = headers.Clone()
	}
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := i.client.Do(req)
	if err != nil {
		return nil, nil, integrationFailure(502, "上游连接失败或超时")
	}
	defer response.Body.Close()
	data, readErr := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if readErr != nil {
		return nil, response, integrationFailure(502, "读取上游响应失败")
	}
	if int64(len(data)) > limit {
		return nil, response, integrationFailure(502, "上游响应超出大小限制")
	}
	var object map[string]any
	if err = json.Unmarshal(data, &object); err != nil || object == nil {
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return nil, response, integrationFailure(response.StatusCode, fmt.Sprintf("后台接口 HTTP %d", response.StatusCode))
		}
		return nil, response, integrationFailure(502, "上游未返回有效 JSON")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if strings.HasPrefix(path, "/api/user/") {
			if authErr := integrationNewAPIAuthError(object); authErr != nil {
				return nil, response, authErr
			}
		}
		return nil, response, integrationFailure(response.StatusCode, fmt.Sprintf("后台接口 HTTP %d", response.StatusCode))
	}
	return object, response, nil
}

func (i *Integrations) accountRequest(ctx context.Context, base, path, method string, headers http.Header, payload any) (map[string]any, *http.Response, error) {
	object, response, err := i.request(ctx, base, path, method, headers, payload, integrationBodyLimit)
	if err != nil {
		return nil, response, err
	}
	if path == "/api/usage/token/" {
		if object["code"] != true {
			return nil, response, integrationFailure(502, "BBDevLab 拒绝余额查询，请检查后台访问令牌")
		}
	} else if object["success"] == false || object["code"] != nil && !integrationSuccessCode(object["code"]) {
		if strings.HasPrefix(path, "/api/user/") {
			if authErr := integrationNewAPIAuthError(object); authErr != nil {
				return nil, response, authErr
			}
		}
		return nil, response, integrationFailure(502, "后台拒绝请求，请检查登录信息与验证要求")
	}
	return object, response, nil
}

func integrationSuccessCode(value any) bool {
	n, err := integrationNumber(value)
	return err == nil && (n == 0 || n == 200)
}
func integrationData(value map[string]any) map[string]any {
	if nested, ok := value["data"].(map[string]any); ok {
		return nested
	}
	return value
}
func integrationText(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}
func integrationNumber(value any) (float64, error) {
	var n float64
	var err error
	switch value := value.(type) {
	case float64:
		n = value
	case float32:
		n = float64(value)
	case int:
		n = float64(value)
	case int64:
		n = float64(value)
	case json.Number:
		n, err = value.Float64()
	case string:
		if strings.TrimSpace(value) == "" {
			return 0, errors.New("missing number")
		}
		n, err = strconv.ParseFloat(strings.TrimSpace(value), 64)
	default:
		return 0, errors.New("invalid number")
	}
	if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
		return 0, errors.New("invalid finite number")
	}
	return n, nil
}
func integrationNowString() string                    { return time.Now().UTC().Format(time.RFC3339Nano) }
func integrationStringPointer(value string) *string   { return &value }
func integrationAmountPointer(value float64) *float64 { return &value }

func integrationNewAPIAuthError(object map[string]any) error {
	code := integrationText(object["code"])
	message := strings.TrimSpace(integrationText(object["message"]))
	switch message {
	case "无权进行此操作，未提供 New-Api-User":
		return integrationFailure(401, "此 NewAPI 后台需要用户 ID，请在后台访问令牌配置中填写用户 ID")
	case "无权进行此操作，New-Api-User 格式错误", "无权进行此操作，New-Api-User 与登录用户不匹配":
		return integrationFailure(401, "后台用户 ID 无效或与访问令牌不匹配，请检查用户 ID")
	}
	switch code {
	case "AUTH_UNAUTHORIZED", "AUTH_TOKEN_EXPIRED", "AUTH_SESSION_REVOKED", "AUTH_USER_INVALID", "ACCESS_TOKEN_EXPIRED", "ACCESS_TOKEN_LEGACY_RETIRED":
		return integrationFailure(401, "后台会话或访问令牌失效，请更新后台凭据")
	case "AUTH_USER_DISABLED":
		return integrationFailure(403, "后台账号已被禁用，请联系站点管理员")
	case "AUTH_INSUFFICIENT_PRIVILEGE", "ACCESS_TOKEN_SCOPE_DENIED", "ACCESS_TOKEN_ROUTE_UNDECLARED", "AUTH_SESSION_REQUIRED":
		return integrationFailure(403, "后台访问令牌权限不足，请使用可读取个人资料的后台访问令牌")
	}
	for _, known := range []string{"无权进行此操作，未登录且未提供 access token", "无权进行此操作，access token 无效", "无权进行此操作，用户信息无效", "Unauthorized, not logged in and no access token provided", "Unauthorized, invalid access token", "Unauthorized, invalid user info", "Unauthorized, the access token has expired"} {
		if message == known {
			return integrationFailure(401, "后台会话或访问令牌失效，请更新后台凭据")
		}
	}
	if message == "用户已被封禁" || message == "User has been banned" {
		return integrationFailure(403, "后台账号已被禁用，请联系站点管理员")
	}
	return nil
}

// Discover reuses an existing saved key only when the editor did not provide one.
func (i *Integrations) Discover(ctx context.Context, draft map[string]any) (map[string]any, error) {
	channel := Channel{Config: DefaultChannelConfig(), Models: []string{}}
	channelID := integrationText(draft["channelId"])
	if channelID != "" {
		existing, err := i.store.Channel(ctx, channelID)
		if err != nil {
			return nil, err
		}
		channel = existing
	}
	if endpoint, ok := draft["endpoint"].(string); ok {
		channel.Endpoint = endpoint
	}
	if raw, ok := draft["config"].(map[string]any); ok {
		encoded, _ := json.Marshal(raw)
		if err := json.Unmarshal(encoded, &channel.Config); err != nil {
			return nil, integrationFailure(400, "渠道配置无效")
		}
	} else if protocol, ok := draft["protocol"].(string); ok {
		channel.Config.Protocol = protocol
	}
	if channel.Config.Protocol == "mock" {
		return map[string]any{"models": channel.Models, "endpoint": "本地模拟", "truncated": false}, nil
	}
	secret := strings.TrimSpace(integrationText(draft["apiKey"]))
	if secret == "" && channelID != "" {
		credentials, err := i.store.Credentials(ctx, channelID, false)
		if err != nil {
			return nil, err
		}
		for _, credential := range credentials {
			if credential.Enabled {
				secret = credential.Secret
				break
			}
		}
	}
	if secret == "" {
		return nil, integrationFailure(400, "获取模型前请填写 API Key，或为已有渠道添加密钥")
	}
	endpoint, err := ResolveUpstreamURL(channel, "models", "", false)
	if err != nil {
		return nil, err
	}
	target, err := url.Parse(endpoint)
	if err != nil {
		return nil, integrationFailure(400, "上游地址无效")
	}
	headers := UpstreamHeaders(channel, secret, nil, channel.Config.Protocol)
	headers.Set("Accept", "application/json")
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	models := map[string]struct{}{}
	seen := map[string]bool{}
	truncated := false
	query := target.Query()
	if channel.Config.Protocol == "anthropic" {
		query.Set("limit", "100")
	}
	if channel.Config.Protocol == "gemini" {
		query.Set("pageSize", "1000")
	}
	target.RawQuery = query.Encode()
	for page := 0; page < 10; page++ {
		object, _, err := i.request(ctx, target.String(), "", http.MethodGet, headers, nil, 2*1024*1024)
		if err != nil {
			return nil, integrationFailure(502, "获取模型失败，请检查上游连接与 API Key")
		}
		entries, ok := object["data"].([]any)
		if channel.Config.Protocol == "gemini" {
			entries, ok = object["models"].([]any)
		}
		if !ok {
			return nil, integrationFailure(502, "上游未返回有效的模型列表")
		}
		for _, entry := range entries {
			item, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			id := integrationText(item["id"])
			if channel.Config.Protocol == "gemini" {
				id = strings.TrimPrefix(integrationText(item["name"]), "models/")
				if methods, ok := item["supportedGenerationMethods"].([]any); ok {
					supported := false
					for _, method := range methods {
						if method == "generateContent" {
							supported = true
						}
					}
					if !supported {
						continue
					}
				}
			}
			id = strings.TrimSpace(id)
			if id == "" || len(id) > 256 {
				continue
			}
			if _, exists := models[id]; !exists && len(models) >= 1000 {
				truncated = true
				break
			}
			models[id] = struct{}{}
		}
		next := ""
		if channel.Config.Protocol == "gemini" {
			next = integrationText(object["nextPageToken"])
		} else if channel.Config.Protocol == "anthropic" && object["has_more"] == true {
			next = integrationText(object["last_id"])
		}
		if next == "" {
			break
		}
		if len(models) >= 1000 || page == 9 {
			truncated = true
			break
		}
		if len(next) > 1024 || seen[next] {
			return nil, integrationFailure(502, "上游模型分页游标无效")
		}
		seen[next] = true
		query = target.Query()
		if channel.Config.Protocol == "gemini" {
			query.Set("pageToken", next)
		} else {
			query.Set("after_id", next)
		}
		target.RawQuery = query.Encode()
	}
	list := make([]string, 0, len(models))
	for model := range models {
		list = append(list, model)
	}
	sort.Strings(list)
	return map[string]any{"models": list, "endpoint": endpoint, "truncated": truncated}, nil
}

type accountCredentials struct {
	Username    string `json:"username,omitempty"`
	Password    string `json:"password,omitempty"`
	AccessToken string `json:"accessToken,omitempty"`
	UserID      string `json:"userId,omitempty"`
	Cookie      string `json:"cookie,omitempty"`
	Mode        string `json:"mode"`
}
type integrationSession struct {
	Token     string `json:"token,omitempty"`
	Cookie    string `json:"cookie,omitempty"`
	UserID    string `json:"userId,omitempty"`
	ExpiresAt int64  `json:"expiresAt"`
	Base      string `json:"base"`
}
type accountMetadata struct {
	Integration   string          `json:"integration"`
	AuthMode      string          `json:"authMode"`
	Balance       *GatewayBalance `json:"balance,omitempty"`
	Session       string          `json:"session,omitempty"`
	NextRefreshAt int64           `json:"nextRefreshAt"`
	LeaseUntil    int64           `json:"leaseUntil"`
	Version       int64           `json:"version"`
}

func parseIntegrationCredentials(value any) (accountCredentials, error) {
	object, ok := value.(map[string]any)
	if !ok {
		return accountCredentials{}, integrationFailure(400, "后台凭据须为对象")
	}
	for key, value := range object {
		if key != "username" && key != "password" && key != "accessToken" && key != "userId" && key != "cookie" {
			return accountCredentials{}, integrationFailure(400, "后台凭据包含无效字段")
		}
		if _, ok := value.(string); !ok {
			return accountCredentials{}, integrationFailure(400, "后台凭据字段须为文本")
		}
	}
	account := accountCredentials{Username: strings.TrimSpace(integrationText(object["username"])), Password: integrationText(object["password"]), UserID: strings.TrimSpace(integrationText(object["userId"]))}
	if len(account.Username) > 256 || len(account.Password) > 4096 || len(account.UserID) > 20 {
		return account, integrationFailure(400, "后台凭据超出长度限制")
	}
	token := strings.TrimSpace(integrationText(object["accessToken"]))
	if len(token) > 4096 {
		return account, integrationFailure(400, "后台访问令牌超出长度限制")
	}
	if strings.HasPrefix(strings.ToLower(token), "bearer ") {
		token = strings.TrimSpace(token[7:])
	}
	for _, r := range token {
		if r <= 32 || r == 127 {
			return account, integrationFailure(400, "后台访问令牌不能包含空白或控制字符")
		}
	}
	account.AccessToken = token
	if _, cookieMode := object["cookie"]; cookieMode {
		account.Mode = "cookie"
		cookie := strings.TrimSpace(integrationText(object["cookie"]))
		if strings.HasPrefix(strings.ToLower(cookie), "cookie:") {
			cookie = strings.TrimSpace(cookie[7:])
		}
		if len(cookie) > 16000 {
			return account, integrationFailure(400, "Cookie 超出长度限制")
		}
		for _, r := range cookie {
			if r < 32 || r > 126 {
				return account, integrationFailure(400, "Cookie 须为单行 ASCII 文本")
			}
		}
		parts := strings.Split(cookie, ";")
		for n, part := range parts {
			part = strings.TrimSpace(part)
			if part == "" && (cookie == "" || n == len(parts)-1) {
				continue
			}
			name, _, ok := strings.Cut(part, "=")
			if !ok || !integrationCookieName.MatchString(name) {
				return account, integrationFailure(400, "Cookie 须使用请求头中的 name=value 格式")
			}
		}
		account.Cookie = cookie
		if cookie == "" && token == "" {
			return account, integrationFailure(400, "请填写 Cookie 或后台登录 Token")
		}
		if account.Username != "" || account.Password != "" || account.UserID != "" {
			return account, integrationFailure(400, "Cookie 与账号密码、用户 ID 不能同时填写")
		}
	} else if _, tokenMode := object["accessToken"]; tokenMode {
		account.Mode = "token"
		if token == "" || account.Username != "" || account.Password != "" {
			return account, integrationFailure(400, "请单独填写有效后台访问令牌")
		}
		if account.UserID != "" {
			id, err := strconv.ParseUint(account.UserID, 10, 53)
			if err != nil || id == 0 || id > 9007199254740991 {
				return account, integrationFailure(400, "用户 ID 须为正整数且不超过安全整数范围")
			}
			account.UserID = strconv.FormatUint(id, 10)
		}
	} else {
		account.Mode = "password"
		if account.Username == "" || account.Password == "" || account.UserID != "" {
			return account, integrationFailure(400, "账号和密码须同时填写，用户 ID 仅用于令牌登录")
		}
	}
	return account, nil
}

var integrationCookieName = regexp.MustCompile("^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+$")

func validateIntegrationCredentials(integration string, account accountCredentials) error {
	switch integration {
	case "newapi":
		if account.Mode == "cookie" {
			return integrationFailure(400, "Cookie / 浏览器会话仅支持 Sub2API 后台")
		}
	case "sub2api":
		if account.Mode == "token" {
			return integrationFailure(400, "Sub2API 登录 Token 请使用 Cookie / 浏览器会话模式")
		}
	case "bbdevlab":
		if account.Mode != "token" || account.UserID != "" {
			return integrationFailure(400, "BBDevLab 仅支持后台访问令牌")
		}
	default:
		return integrationFailure(400, "仅 NewAPI / Sub2API / BBDevLab 渠道使用后台凭据")
	}
	return nil
}

func integrationAccountBase(channel Channel) (string, error) {
	base, err := url.Parse(channel.Endpoint)
	if err != nil || base.Host == "" || base.User != nil || (base.Scheme != "http" && base.Scheme != "https") {
		return "", integrationFailure(400, "后台地址无效")
	}
	base.Path = strings.TrimRight(base.Path, "/")
	base.Path = strings.TrimSuffix(strings.TrimSuffix(base.Path, "/v1beta"), "/v1")
	base.RawQuery = ""
	base.Fragment = ""
	return strings.TrimRight(base.String(), "/"), nil
}

func integrationSessionHeaders(session integrationSession, browser bool) http.Header {
	headers := http.Header{}
	if session.Token != "" {
		headers.Set("Authorization", "Bearer "+session.Token)
	}
	if session.Cookie != "" && (browser || session.Token == "") {
		headers.Set("Cookie", session.Cookie)
	}
	if session.UserID != "" {
		headers.Set("New-Api-User", session.UserID)
	}
	return headers
}

func (i *Integrations) login(ctx context.Context, channel Channel, account accountCredentials, base string) (integrationSession, error) {
	sub := channel.Config.Integration == "sub2api"
	path := "/api/user/login"
	payload := map[string]any{"username": account.Username, "password": account.Password}
	if sub {
		path = "/api/v1/auth/login"
		payload = map[string]any{"email": account.Username, "password": account.Password}
	}
	object, response, err := i.accountRequest(ctx, base, path, http.MethodPost, nil, payload)
	if err != nil {
		if sub {
			if settings, _, settingsErr := i.accountRequest(ctx, base, "/api/v1/settings/public", http.MethodGet, nil, nil); settingsErr == nil {
				data := integrationData(settings)
				for _, key := range []string{"turnstile_enabled", "tencent_captcha_enabled", "aliyun_captcha_enabled"} {
					if data[key] == true {
						return integrationSession{}, integrationFailure(409, "后台开启了人机验证，请在浏览器登录后改用 Cookie / 浏览器会话及后台登录 Token")
					}
				}
			}
			return integrationSession{}, err
		}
		payload, handshakeErr := i.newAPILoginPayload(ctx, base, account)
		if handshakeErr != nil {
			return integrationSession{}, handshakeErr
		}
		if payload["password_encrypted"] == nil {
			return integrationSession{}, err
		}
		object, response, err = i.accountRequest(ctx, base, path, http.MethodPost, nil, payload)
		if err != nil {
			return integrationSession{}, err
		}
	}
	data := integrationData(object)
	for _, field := range []string{"requires_2fa", "require_2fa", "verification_required", "require_verification", "challenge_id", "flow_token"} {
		if value := data[field]; value != nil && value != false && value != "" {
			return integrationSession{}, integrationFailure(409, "后台要求二次验证，请改用后台访问令牌或浏览器会话")
		}
	}
	token := integrationText(data["access_token"])
	if token == "" {
		token = integrationText(data["token"])
	}
	cookies := []string{}
	for _, cookie := range response.Cookies() {
		if cookie.Value != "" {
			cookies = append(cookies, cookie.Name+"="+cookie.Value)
		}
	}
	session := integrationSession{Token: token, Cookie: strings.Join(cookies, "; "), Base: base, ExpiresAt: time.Now().Add(time.Hour).UnixMilli()}
	if token == "" && session.Cookie == "" {
		return session, integrationFailure(502, "后台登录未返回会话，请检查验证码或二次验证要求")
	}
	user := data["id"]
	if nested, ok := data["user"].(map[string]any); ok {
		user = nested["id"]
	}
	if n, err := integrationNumber(user); err == nil && n > 0 && n <= 9007199254740991 && math.Trunc(n) == n {
		session.UserID = strconv.FormatInt(int64(n), 10)
	}
	if seconds, err := integrationNumber(data["expires_in"]); err == nil {
		session.ExpiresAt = time.Now().Add(time.Duration(math.Max(60, math.Min(86400, seconds))) * time.Second).UnixMilli()
	}
	if expires, err := integrationNumber(data["access_expires_at"]); err == nil && expires > float64(time.Now().Unix()) {
		session.ExpiresAt = int64(math.Min(expires*1000, float64(time.Now().Add(24*time.Hour).UnixMilli())))
	}
	return session, nil
}

func (i *Integrations) fetchAccountBalance(ctx context.Context, channel Channel, account accountCredentials, cached integrationSession) (float64, string, integrationSession, error) {
	base, err := integrationAccountBase(channel)
	if err != nil {
		return 0, "", integrationSession{}, err
	}
	if err = validateIntegrationCredentials(channel.Config.Integration, account); err != nil {
		return 0, "", integrationSession{}, err
	}
	session := integrationSession{Token: account.AccessToken, Cookie: account.Cookie, UserID: account.UserID, Base: base, ExpiresAt: time.Now().Add(time.Hour).UnixMilli()}
	reused := false
	if account.Mode == "password" {
		if cached.Base == base && cached.ExpiresAt > time.Now().Add(10*time.Second).UnixMilli() {
			session = cached
			reused = true
		} else {
			session, err = i.login(ctx, channel, account, base)
			if err != nil {
				return 0, "", session, err
			}
		}
	}
	if channel.Config.Integration == "bbdevlab" {
		object, _, err := i.accountRequest(ctx, base, "/api/usage/token/", http.MethodGet, integrationSessionHeaders(session, false), nil)
		if err != nil {
			return 0, "", session, err
		}
		amount, err := integrationNumber(integrationData(object)["total_available"])
		if err != nil {
			return 0, "", session, integrationFailure(502, "后台未返回有效余额")
		}
		return amount / 100000, "余额", session, nil
	}
	sub := channel.Config.Integration == "sub2api"
	profile := func() (map[string]any, error) {
		path := "/api/user/self"
		if sub {
			path = "/api/v1/user/profile"
		}
		object, _, err := i.accountRequest(ctx, base, path, http.MethodGet, integrationSessionHeaders(session, account.Mode == "cookie"), nil)
		var status *integrationError
		if sub && errors.As(err, &status) && status.status == 404 {
			object, _, err = i.accountRequest(ctx, base, "/api/v1/auth/me", http.MethodGet, integrationSessionHeaders(session, account.Mode == "cookie"), nil)
		}
		return object, err
	}
	object, err := profile()
	var status *integrationError
	if err != nil && reused && errors.As(err, &status) && (status.status == 401 || status.status == 403) {
		session, err = i.login(ctx, channel, account, base)
		if err == nil {
			object, err = profile()
		}
	}
	if err != nil {
		return 0, "", session, err
	}
	data := integrationData(object)
	if sub {
		amount, err := integrationNumber(data["balance"])
		if err != nil {
			return 0, "", session, integrationFailure(502, "后台未返回有效余额")
		}
		return amount, "USD", session, nil
	}
	amount, err := integrationNumber(data["quota"])
	if err != nil {
		return 0, "", session, integrationFailure(502, "后台未返回有效余额")
	}
	unit := "额度"
	if status, _, err := i.accountRequest(ctx, base, "/api/status", http.MethodGet, nil, nil); err == nil {
		if scale, err := integrationNumber(integrationData(status)["quota_per_unit"]); err == nil && scale > 0 {
			amount /= scale
			unit = "USD"
		}
	}
	return amount, unit, session, nil
}

func (i *Integrations) newAPILoginPayload(ctx context.Context, base string, account accountCredentials) (map[string]any, error) {
	status, _, err := i.accountRequest(ctx, base, "/api/status", http.MethodGet, nil, nil)
	if err != nil {
		return nil, err
	}
	data := integrationData(status)
	if data["password_login_enabled"] == false {
		return nil, integrationFailure(409, "此 NewAPI 后台已关闭密码登录，请改用后台访问令牌")
	}
	if data["turnstile_check"] == true {
		return nil, integrationFailure(409, "此 NewAPI 后台登录需要人机验证，请改用后台访问令牌")
	}
	if data["password_login_encryption_enabled"] == nil || data["password_login_encryption_enabled"] == false {
		return map[string]any{"username": account.Username, "password": account.Password}, nil
	}
	if data["password_login_encryption_enabled"] != true {
		return nil, integrationFailure(502, "NewAPI 登录加密状态无效")
	}
	key, _, err := i.request(ctx, base, "/api/user/login/encryption-key", http.MethodGet, nil, nil, 32*1024)
	if err != nil {
		return nil, err
	}
	key = integrationData(key)
	kid := integrationText(key["kid"])
	if key["enabled"] == false || !integrationKeyID.MatchString(kid) {
		return nil, integrationFailure(502, "NewAPI 登录公钥标识无效")
	}
	encrypted, err := integrationEncryptPassword(account.Password, integrationText(key["public_key"]), kid)
	if err != nil {
		return nil, err
	}
	return map[string]any{"username": account.Username, "password_encrypted": encrypted, "encryption_key_id": kid}, nil
}

var integrationKeyID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func integrationEncryptPassword(password, keyPEM, kid string) (string, error) {
	if len(keyPEM) > 16384 {
		return "", integrationFailure(502, "NewAPI 登录公钥格式无效")
	}
	block, rest := pem.Decode([]byte(keyPEM))
	if block == nil || block.Type != "PUBLIC KEY" || len(bytes.TrimSpace(rest)) > 0 {
		return "", integrationFailure(502, "NewAPI 登录公钥格式无效")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return "", integrationFailure(502, "NewAPI 登录公钥格式无效")
	}
	key, ok := parsed.(*rsa.PublicKey)
	if !ok || key.N.BitLen() < 2048 || key.N.BitLen() > 8192 {
		return "", integrationFailure(502, "NewAPI 登录公钥长度无效")
	}
	plaintext := []byte(password)
	if len(plaintext) == 0 || len(plaintext) > 512 {
		return "", integrationFailure(400, "NewAPI 加密登录密码超出后台支持的长度")
	}
	if len(plaintext) <= key.Size()-66 {
		encrypted, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, key, plaintext, nil)
		if err != nil {
			return "", integrationFailure(502, "NewAPI 登录密码加密失败")
		}
		return base64.StdEncoding.EncodeToString(encrypted), nil
	}
	secret := make([]byte, 32)
	nonce := make([]byte, 12)
	if _, err = rand.Read(secret); err != nil {
		return "", err
	}
	if _, err = rand.Read(nonce); err != nil {
		return "", err
	}
	wrapped, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, key, secret, []byte("password-v2"))
	if err != nil {
		return "", integrationFailure(502, "NewAPI 登录密码加密失败")
	}
	blockCipher, err := aes.NewCipher(secret)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(blockCipher)
	if err != nil {
		return "", err
	}
	encrypted := gcm.Seal(nil, nonce, plaintext, []byte("password-v2:"+kid))
	return "v2." + base64.StdEncoding.EncodeToString(wrapped) + "." + base64.StdEncoding.EncodeToString(nonce) + "." + base64.StdEncoding.EncodeToString(encrypted), nil
}

func integrationParseExpiry(data map[string]any, old *GatewayBalance) (*string, error) {
	raw, present := data["expires_at"]
	if !present {
		if old != nil {
			return old.ExpiresAt, nil
		}
		return nil, nil
	}
	if raw == nil {
		return nil, nil
	}
	if text, ok := raw.(string); ok && !integrationInteger.MatchString(strings.TrimSpace(text)) {
		return nil, errors.New(bbBalanceError)
	}
	seconds, err := integrationNumber(raw)
	if err != nil {
		return nil, err
	}
	if seconds == 0 || seconds == -1 {
		return nil, nil
	}
	if math.Trunc(seconds) != seconds || seconds <= 0 || seconds > 253402300799 {
		return nil, errors.New(bbBalanceError)
	}
	expiry := time.Unix(int64(seconds), 0).UTC().Format(time.RFC3339Nano)
	return &expiry, nil
}

var integrationInteger = regexp.MustCompile(`^-?\d+$`)

func integrationBalanceExpired(balance *GatewayBalance, now time.Time) bool {
	if balance == nil || balance.ExpiresAt == nil {
		return false
	}
	expiry, err := time.Parse(time.RFC3339Nano, *balance.ExpiresAt)
	return err == nil && !expiry.After(now)
}
func integrationRestriction(reason *string) bool {
	return reason != nil && (*reason == bbExhaustedReason || *reason == bbExpiredReason)
}
func integrationMonitoredCredential(credential Credential) bool {
	return credential.Enabled || integrationRestriction(credential.Reason) || credential.Reason != nil && strings.HasPrefix(*credential.Reason, "HTTP ") && credential.DisabledAt != nil
}

// Decimals are added as rationals so 0.1 + 0.2 stays 0.3 in the UI.
func credentialBalanceSummary(credentials []Credential, now time.Time) *GatewayBalance {
	summary := &GatewayBalance{Status: "ok", Unit: "余额", KeyCount: len(credentials)}
	amount := 0.0
	total := new(big.Rat)
	known := false
	pending := len(credentials) == 0
	for _, credential := range credentials {
		expired := credential.Reason != nil && *credential.Reason == bbExpiredReason || integrationBalanceExpired(credential.Balance, now)
		if expired {
			summary.ExpiredKeys++
		} else if credential.Enabled {
			summary.AvailableKeys++
		}
		if !expired && credential.Reason != nil && *credential.Reason == bbExhaustedReason {
			summary.ExhaustedKeys++
		}
		if !integrationMonitoredCredential(credential) {
			continue
		}
		balance := credential.Balance
		if balance == nil || balance.Status == "pending" {
			pending = true
		}
		if balance == nil {
			continue
		}
		if balance.Amount != nil {
			known = true
			if !expired {
				part, ok := new(big.Rat).SetString(strconv.FormatFloat(math.Max(0, *balance.Amount), 'g', -1, 64))
				if ok {
					total.Add(total, part)
				}
			}
		}
		if balance.Status == "error" {
			summary.Status = "error"
			summary.Error = "部分 API Key 余额查询失败，保留上次余额"
		}
		if balance.UpdatedAt != nil && (summary.UpdatedAt == nil || *balance.UpdatedAt > *summary.UpdatedAt) {
			summary.UpdatedAt = balance.UpdatedAt
		}
		if balance.CheckedAt != nil && (summary.CheckedAt == nil || *balance.CheckedAt > *summary.CheckedAt) {
			summary.CheckedAt = balance.CheckedAt
		}
	}
	if summary.Status != "error" && pending {
		summary.Status = "pending"
	}
	if known {
		amount, _ = total.Float64()
		summary.Amount = &amount
	} else if len(credentials) > 0 {
		allManual := true
		for _, credential := range credentials {
			if integrationMonitoredCredential(credential) {
				allManual = false
			}
		}
		if allManual {
			summary.Amount = &amount
		}
	}
	return summary
}

// Run starts finite background jobs until shutdown. Row leases coordinate replicas.
// Each key/account is a separate job: a dead channel consumes at most one worker.
func (i *Integrations) Run(ctx context.Context) {
	defer i.client.CloseIdleConnections()
	ticker := time.NewTicker(i.interval)
	defer ticker.Stop()
	for {
		i.refreshDue(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
func (i *Integrations) refreshDue(ctx context.Context) {
	jobs, err := i.store.integrationDueJobs(ctx, 256)
	if err != nil {
		return
	}
	queue := make(chan integrationJob)
	var wg sync.WaitGroup
	for worker := 0; worker < i.workers; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for job := range queue {
				if ctx.Err() != nil {
					return
				}
				if job.credentialID != "" {
					_ = i.refreshCredential(ctx, job.channelID, job.credentialID, false)
				} else {
					_ = i.refreshAccount(ctx, job.channelID, false)
				}
			}
		}()
	}
	for _, job := range jobs {
		select {
		case queue <- job:
		case <-ctx.Done():
			close(queue)
			wg.Wait()
			return
		}
	}
	close(queue)
	wg.Wait()
}

func (i *Integrations) RefreshBalance(ctx context.Context, id string) (Channel, error) {
	channel, err := i.store.Channel(ctx, id)
	if err != nil {
		return Channel{}, err
	}
	if channel.Config.Integration == "bbdevlab" {
		credentials, err := i.store.Credentials(ctx, id, true)
		if err != nil {
			return Channel{}, err
		}
		queue := make(chan Credential)
		var wg sync.WaitGroup
		var firstError error
		var mu sync.Mutex
		for worker := 0; worker < i.workers; worker++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for credential := range queue {
					if err := i.refreshCredential(ctx, id, credential.ID, true); err != nil {
						mu.Lock()
						if firstError == nil {
							firstError = err
						}
						mu.Unlock()
					}
				}
			}()
		}
		for _, credential := range credentials {
			select {
			case queue <- credential:
			case <-ctx.Done():
				close(queue)
				wg.Wait()
				return Channel{}, ctx.Err()
			}
		}
		close(queue)
		wg.Wait()
		if firstError != nil {
			return Channel{}, firstError
		}
	} else if channel.Config.Integration == "newapi" || channel.Config.Integration == "sub2api" {
		if err = i.refreshAccount(ctx, id, true); err != nil {
			return Channel{}, err
		}
	} else {
		return Channel{}, integrationFailure(400, "请先开启上游余额监控")
	}
	return i.store.Channel(ctx, id)
}
func (i *Integrations) RefreshCredentialBalance(ctx context.Context, channelID, credentialID string) error {
	return i.refreshCredential(ctx, channelID, credentialID, true)
}
