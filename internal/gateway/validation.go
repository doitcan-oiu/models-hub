package gateway

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

type HTTPError struct {
	Code    int
	Message string
}

func (e *HTTPError) Error() string   { return e.Message }
func (e *HTTPError) StatusCode() int { return e.Code }
func bad(message string) error       { return &HTTPError{http.StatusBadRequest, message} }

// Reject null scalars and null entries before merging defaults. encoding/json
// otherwise silently turns a null profile into an unrestricted zero value.
func validatePatchShape(value any, typ reflect.Type) error {
	for typ.Kind() == reflect.Pointer {
		typ = typ.Elem()
	}
	if typ.Kind() == reflect.Interface {
		return nil
	}
	if value == nil {
		return bad("配置字段不能为 null")
	}
	switch typ.Kind() {
	case reflect.Struct:
		object, ok := value.(map[string]any)
		if !ok {
			return bad("配置须为 JSON 对象")
		}
		for index := 0; index < typ.NumField(); index++ {
			field := typ.Field(index)
			name := strings.Split(field.Tag.Get("json"), ",")[0]
			if name == "" || name == "-" {
				continue
			}
			// encoding/json also accepts case-insensitive field names. Validate
			// every spelling it can decode before nulls turn into zero values.
			for suppliedName, supplied := range object {
				if strings.EqualFold(suppliedName, name) {
					if err := validatePatchShape(supplied, field.Type); err != nil {
						return err
					}
				}
			}
		}
	case reflect.Map:
		object, ok := value.(map[string]any)
		if !ok {
			return bad("配置须为 JSON 对象")
		}
		for _, entry := range object {
			if err := validatePatchShape(entry, typ.Elem()); err != nil {
				return err
			}
		}
	case reflect.Slice:
		array, ok := value.([]any)
		if !ok {
			return bad("配置须为数组")
		}
		for _, entry := range array {
			if err := validatePatchShape(entry, typ.Elem()); err != nil {
				return err
			}
		}
	case reflect.String:
		if _, ok := value.(string); !ok {
			return bad("字段须为文本")
		}
	case reflect.Bool:
		if _, ok := value.(bool); !ok {
			return bad("字段须为布尔值")
		}
	}
	return nil
}
func validatePatch(value any, patch map[string]any) error {
	data, err := json.Marshal(patch)
	if err != nil {
		return bad("Invalid JSON")
	}
	var normalized map[string]any
	if json.Unmarshal(data, &normalized) != nil {
		return bad("Invalid JSON")
	}
	return validatePatchShape(normalized, reflect.TypeOf(value))
}
func normalizedStrings(input []string, max int) ([]string, error) {
	if len(input) > max {
		return nil, bad("条目过多")
	}
	out := make([]string, 0, len(input))
	seen := map[string]bool{}
	for _, value := range input {
		value = strings.TrimSpace(value)
		if value == "" || len(value) > 256 {
			return nil, bad("条目为空或过长")
		}
		if !seen[value] {
			seen[value] = true
			out = append(out, value)
		}
	}
	return out, nil
}

var sensitiveValue = regexp.MustCompile(`(?i)Bearer\s|(?:sk-|AIza|pg_live_)[A-Za-z0-9_-]{12,}`)
var sensitiveBodyKey = regexp.MustCompile(`(?i)^(?:api[-_]?key|access[-_]?token|token|secret|password|authorization)$`)

func hasBodySecret(value any) bool {
	switch value := value.(type) {
	case string:
		return sensitiveValue.MatchString(value)
	case []any:
		for _, entry := range value {
			if hasBodySecret(entry) {
				return true
			}
		}
	case map[string]any:
		for key, entry := range value {
			if sensitiveBodyKey.MatchString(key) || hasBodySecret(entry) {
				return true
			}
		}
	}
	return false
}
func validateStatuses(statuses []int) error {
	if len(statuses) > 100 {
		return bad("错误状态码过多")
	}
	for _, status := range statuses {
		if status < 400 || status > 599 {
			return bad("错误状态码须为 400–599")
		}
	}
	return nil
}
func decodeMap(b map[string]any, dst any) error {
	data, err := json.Marshal(b)
	if err != nil {
		return bad("Invalid JSON")
	}
	if err = json.Unmarshal(data, dst); err != nil {
		return bad("字段类型无效：" + err.Error())
	}
	return nil
}
func mergeMap(base, patch map[string]any) map[string]any {
	for k, v := range patch {
		if nested, ok := v.(map[string]any); ok {
			old, _ := base[k].(map[string]any)
			if old == nil {
				old = map[string]any{}
			}
			base[k] = mergeMap(old, nested)
		} else {
			base[k] = v
		}
	}
	return base
}
func merged(value any, b map[string]any, dst any) error {
	data, _ := json.Marshal(value)
	base := map[string]any{}
	_ = json.Unmarshal(data, &base)
	return decodeMap(mergeMap(base, b), dst)
}
func str(b map[string]any, k string) string { v, _ := b[k].(string); return v }
func stringList(v any, max int) ([]string, error) {
	data, err := json.Marshal(v)
	var out []string
	if err != nil || json.Unmarshal(data, &out) != nil || len(out) < 1 || len(out) > max {
		return nil, bad(fmt.Sprintf("需要 1–%d 个有效条目", max))
	}
	seen := map[string]bool{}
	for i, s := range out {
		s = strings.TrimSpace(s)
		if s == "" || len(s) > 256 || seen[s] {
			return nil, bad("条目为空、重复或过长")
		}
		seen[s] = true
		out[i] = s
	}
	return out, nil
}
func validURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Host != "" && (u.Scheme == "http" || u.Scheme == "https") && u.User == nil && u.RawQuery == "" && u.Fragment == "" && !strings.ContainsAny(raw, "\r\n")
}
func newChannel(b map[string]any, prior *Channel, dev bool) (Channel, error) {
	c := Channel{ID: newID(), Provider: "OpenAI", Weight: 1, Enabled: true, Status: "healthy", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Color: "#003c33", Models: []string{}, Tags: []string{}, History: []int{}, Config: DefaultChannelConfig(), DisplayMultiplier: 1}
	if prior != nil {
		c = *prior
	}
	patch := map[string]any{}
	for _, k := range []string{"name", "provider", "model", "models", "tags", "endpoint", "website", "displayMultiplier", "weight", "priority", "enabled", "archived", "config"} {
		if v, ok := b[k]; ok {
			patch[k] = v
		}
	}
	if err := validatePatch(c, patch); err != nil {
		return c, err
	}
	if err := merged(c, patch, &c); err != nil {
		return c, err
	}
	c.Name = strings.TrimSpace(c.Name)
	c.Endpoint = strings.TrimRight(strings.TrimSpace(c.Endpoint), "/")
	if c.Name == "" || len(c.Name) > 256 {
		return c, bad("渠道名称须为 1–256 字符")
	}
	if len(c.Models) == 0 && strings.TrimSpace(c.Model) != "" {
		c.Models = []string{c.Model}
	}
	if len(c.Models) == 0 || len(c.Models) > 1000 {
		return c, bad("至少填写一个模型，最多 1000 个")
	}
	for _, m := range c.Models {
		if strings.TrimSpace(m) == "" || len(m) > 256 {
			return c, bad("模型名称无效")
		}
	}
	var normalizeErr error
	c.Models, normalizeErr = normalizedStrings(c.Models, 1000)
	if normalizeErr != nil {
		return c, normalizeErr
	}
	c.Tags, normalizeErr = normalizedStrings(c.Tags, 100)
	if normalizeErr != nil {
		return c, normalizeErr
	}
	if _, provided := b["model"]; !provided {
		if _, updated := b["models"]; updated || c.Model == "" {
			c.Model = c.Models[0]
		}
	}
	c.Model = strings.TrimSpace(c.Model)
	if c.Model == "" || len(c.Model) > 256 {
		return c, bad("模型名称无效")
	}
	if !slices.Contains(c.Models, c.Model) {
		if len(c.Models) >= 1000 {
			return c, bad("模型条目过多")
		}
		c.Models = append([]string{c.Model}, c.Models...)
	}
	if len(c.Provider) > 128 {
		return c, bad("供应商名称过长")
	}
	if !slices.Contains([]string{"openai", "anthropic", "gemini", "mock"}, c.Config.Protocol) {
		return c, bad("接口类型无效")
	}
	if c.Config.Protocol == "mock" && !dev {
		return c, bad("Mock 渠道仅限开发模式")
	}
	if c.Config.Protocol == "mock" && c.Endpoint == "" {
		c.Endpoint = "http://127.0.0.1/mock"
	}
	if !validURL(c.Endpoint) {
		return c, bad("上游地址须为不含凭据、查询参数和片段的 HTTP/HTTPS URL")
	}
	if c.Website != "" {
		u, e := url.Parse(c.Website)
		if e != nil || u.Host == "" || u.User != nil || !slices.Contains([]string{"http", "https"}, u.Scheme) {
			return c, bad("官网地址无效")
		}
	}
	if c.Weight < 0 || c.Weight > 10000 || c.Priority < -10000 || c.Priority > 10000 || c.DisplayMultiplier < 0 || c.DisplayMultiplier > 1e6 || len(c.Tags) > 100 {
		return c, bad("渠道权重、优先级或标签无效")
	}
	if c.Archived {
		c.Enabled = false
	}
	if c.Config.GatewayMode != "direct" {
		return c, bad("Go 版本使用直连或 relayUrl，请将连接方式设为 direct")
	}
	if c.Config.RelayURL != "" && !validURL(c.Config.RelayURL) {
		return c, bad("中继地址无效")
	}
	if !slices.Contains([]string{"", "native", "newapi", "sub2api", "bbdevlab"}, c.Config.Integration) {
		return c, bad("余额集成无效")
	}
	if c.Config.RateLimit.RequestsPerMinute < 0 || c.Config.RateLimit.TokensPerMinute < 0 {
		return c, bad("限额不能为负数")
	}
	for _, p := range []string{c.Config.Endpoints.Chat, c.Config.Endpoints.Models, c.Config.Endpoints.Messages, c.Config.Endpoints.Generate} {
		if len(p) > 1024 || !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") || strings.ContainsAny(p, "?#\r\n") {
			return c, bad("端点须为相对路径")
		}
	}
	sensitive := regexp.MustCompile(`(?i)authorization|api[-_]?key|token|secret|password|cookie|host|content-length|connection|transfer-encoding`)
	if len(c.Config.Headers) > 30 {
		return c, bad("自定义请求头过多")
	}
	for k, v := range c.Config.Headers {
		if sensitive.MatchString(k) || sensitiveValue.MatchString(v) || strings.ContainsAny(k+v, "\r\n") || len(v) > 2048 || !regexp.MustCompile(`^[!#$%&'*+.^_`+"`"+`|~0-9A-Za-z-]+$`).MatchString(k) {
			return c, bad("凭据须使用加密密钥管理，或请求头无效")
		}
	}
	overrides, _ := json.Marshal(c.Config.BodyOverrides)
	if len(overrides) > 32000 || hasBodySecret(c.Config.BodyOverrides) {
		return c, bad("请求覆盖过大或包含凭据")
	}
	for _, k := range []string{"model", "stream", "messages", "contents", "system", "systemInstruction", "authorization", "api_key", "token", "password", "secret"} {
		if _, ok := c.Config.BodyOverrides[k]; ok {
			return c, bad("请求覆盖包含网关管理字段或凭据")
		}
	}
	if len(c.Config.Aliases) > 1000 || len(c.Config.Prices) > 1000 {
		return c, bad("模型映射或价格条目过多")
	}
	for _, alias := range c.Config.Aliases {
		if strings.TrimSpace(alias.From) == "" || strings.TrimSpace(alias.To) == "" || len(alias.From) > 256 || len(alias.To) > 256 {
			return c, bad("模型别名无效")
		}
	}
	for _, p := range c.Config.Prices {
		if p.Input < 0 || p.Output < 0 || p.Input > 1e6 || p.Output > 1e6 || len(p.Model) > 2000 {
			return c, bad("价格无效")
		}
	}
	if c.Config.AutoDisable.Threshold < 1 || c.Config.AutoDisable.Threshold > 100 || c.Config.AutoDisable.Cooldown < 1 || c.Config.AutoDisable.Cooldown > 86400 || !slices.Contains([]string{"key", "channel"}, c.Config.AutoDisable.Target) {
		return c, bad("自动禁用设置无效")
	}
	for _, s := range c.Config.AutoDisable.Statuses {
		if s < 400 || s > 599 {
			return c, bad("错误状态码无效")
		}
	}
	if err := validateStatuses(c.Config.AutoDisable.Statuses); err != nil {
		return c, err
	}
	mock := c.Config.Mock
	if !slices.Contains([]string{"healthy", "slow", "error", "empty", "disconnect", "transient"}, mock.Scenario) || mock.DelayMs < 0 || mock.DelayMs > 600000 || mock.Status < 400 || mock.Status > 599 || mock.FailuresBeforeSuccess < 0 || mock.FailuresBeforeSuccess > 100 {
		return c, bad("模拟设置无效")
	}
	if len(c.Endpoint) > 2048 || len(c.Website) > 2048 || len(c.Config.RelayURL) > 2048 || len(c.Config.CustomProviderSlug) > 128 || c.Config.RateLimit.RequestsPerMinute > 1000000 || c.Config.RateLimit.TokensPerMinute > 1000000000 {
		return c, bad("渠道配置超出长度或限额范围")
	}
	return c, nil
}
func newAPIKey(b map[string]any, prior *APIKey) (APIKey, error) {
	p := KeyProfile{ID: newID(), Name: "默认配置", Scope: "all", Tags: []string{}, Match: "any", ChannelIDs: []string{}, ModelMode: "all", Models: []string{}, RequestLimit: "无限制", Mappings: []ModelMapping{}}
	k := APIKey{ID: newID(), Status: "active", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Expires: "永不过期", ActiveProfile: p.ID, Profiles: []KeyProfile{p}}
	if prior != nil {
		if prior.Status == "revoked" {
			return k, bad("已撤销的 API Key 无法修改")
		}
		k = *prior
	}
	patch := map[string]any{}
	for _, f := range []string{"name", "status", "expires", "note", "activeProfile", "profiles"} {
		if v, ok := b[f]; ok {
			patch[f] = v
		}
	}
	if err := validatePatch(k, patch); err != nil {
		return k, err
	}
	if err := merged(k, patch, &k); err != nil {
		return k, err
	}
	k.Name = strings.TrimSpace(k.Name)
	if k.Name == "" || len(k.Name) > 256 || len(k.Note) > 4000 || !slices.Contains([]string{"active", "disabled"}, k.Status) {
		return k, bad("API Key 名称或状态无效")
	}
	if len(k.Expires) > 128 {
		return k, bad("到期时间过长")
	}
	if !slices.Contains([]string{"", "never", "永不过期"}, k.Expires) {
		if _, err := time.Parse(time.RFC3339, k.Expires); err != nil {
			if _, err = time.Parse("2006-01-02", k.Expires); err != nil {
				return k, bad("到期时间无效")
			}
		}
	}
	if len(k.Profiles) < 1 || len(k.Profiles) > 50 {
		return k, bad("需要 1–50 个策略")
	}
	active := false
	seen := map[string]bool{}
	for i := range k.Profiles {
		p := &k.Profiles[i]
		if p.ID == "" {
			p.ID = newID()
		}
		if seen[p.ID] {
			return k, bad("策略 ID 重复")
		}
		seen[p.ID] = true
		if p.ID == k.ActiveProfile {
			active = true
		}
		if p.Scope == "" {
			p.Scope = "all"
		}
		if p.Match == "" {
			p.Match = "any"
		}
		if p.ModelMode == "" {
			p.ModelMode = "all"
		}
		if p.RequestLimit == "" {
			p.RequestLimit = "无限制"
		}
		if p.Tags == nil {
			p.Tags = []string{}
		}
		if p.ChannelIDs == nil {
			p.ChannelIDs = []string{}
		}
		if p.Models == nil {
			p.Models = []string{}
		}
		if p.Mappings == nil {
			p.Mappings = []ModelMapping{}
		}
		var normalizeErr error
		p.Tags, normalizeErr = normalizedStrings(p.Tags, 100)
		if normalizeErr != nil {
			return k, normalizeErr
		}
		p.ChannelIDs, normalizeErr = normalizedStrings(p.ChannelIDs, 1000)
		if normalizeErr != nil {
			return k, normalizeErr
		}
		p.Models, normalizeErr = normalizedStrings(p.Models, 1000)
		if normalizeErr != nil {
			return k, normalizeErr
		}
		if len(p.ID) > 128 || len(p.Name) > 128 || len(p.RequestLimit) > 30 || len(p.Mappings) > 1000 {
			return k, bad("策略字段过长或条目过多")
		}
		if p.Name == "" {
			p.Name = "默认配置"
		}
		mappings := map[string]bool{}
		for mappingIndex := range p.Mappings {
			mapping := &p.Mappings[mappingIndex]
			mapping.From = strings.TrimSpace(mapping.From)
			if mapping.From == "" || len(mapping.From) > 256 || mappings[mapping.From] {
				return k, bad("模型映射入口为空、重复或过长")
			}
			mappings[mapping.From] = true
			mapping.To, normalizeErr = normalizedStrings(mapping.To, 1000)
			if normalizeErr != nil {
				return k, normalizeErr
			}
		}
		if !slices.Contains([]string{"all", "tags", "channels"}, p.Scope) || !slices.Contains([]string{"any", "all", "none"}, p.Match) || !slices.Contains([]string{"all", "selected"}, p.ModelMode) || (p.Scope == "tags" && len(p.Tags) == 0) || (p.Scope == "channels" && len(p.ChannelIDs) == 0) || (p.ModelMode == "selected" && len(p.Models) == 0) {
			return k, bad("授权策略无效")
		}
		if !slices.Contains([]string{"无限制", "unlimited", "0", ""}, p.RequestLimit) {
			n, e := strconv.ParseUint(p.RequestLimit, 10, 53)
			if e != nil || n > 9007199254740991 {
				return k, bad("请求额度须为非负安全整数")
			}
		}
	}
	if !active {
		if _, ok := b["activeProfile"]; !ok {
			k.ActiveProfile = k.Profiles[0].ID
		} else {
			return k, bad("生效策略不存在")
		}
	}
	return k, nil
}
func validateSettings(b map[string]any, s Settings) (Settings, error) {
	if err := validatePatch(s, b); err != nil {
		return s, err
	}
	if err := merged(s, b, &s); err != nil {
		return s, err
	}
	if s.AIGatewayEnabled {
		return s, bad("Go 版本无需 Cloudflare AI Gateway，请使用渠道直连或中继")
	}
	ranges := map[string][2]float64{"maxChannelRetries": {0, 10}, "maxSameChannelRetries": {0, 5}, "retryDelayMs": {0, 10000}, "streamFirstTokenTimeout": {0, 600}, "nonStreamTimeout": {0, 600}, "threshold": {.001, 600}, "responseThreshold": {.001, 600}, "window": {1, 1000}, "windowSeconds": {0, 86400}, "samples": {1, 1000}, "cooldown": {1, 86400}, "recovery": {1, 100}, "autoDisableThreshold": {1, 100}, "autoDisableCooldown": {1, 86400}, "logRetentionDays": {1, 3650}}
	data, _ := json.Marshal(s)
	var fields map[string]any
	_ = json.Unmarshal(data, &fields)
	for k, r := range ranges {
		v, _ := fields[k].(float64)
		if v < r[0] || v > r[1] {
			return s, bad(k + " 超出允许范围")
		}
	}
	if s.Samples > s.Window || !slices.Contains([]string{"failover", "adaptive", "round-robin", "weighted", "circuit-breaker"}, s.Strategy) || !slices.Contains([]string{"prefer", "off"}, s.StickyMode) || !slices.Contains([]string{"raw", "generic", "custom"}, s.ErrorMode) || !slices.Contains([]string{"key", "channel"}, s.AutoDisableTarget) {
		return s, bad("调度或健康设置无效")
	}
	if len(s.Account) > 128 || len(s.Gateway) > 128 || len(s.CustomErrorMessage) > 2000 {
		return s, bad("网关标识或自定义错误消息过长")
	}
	if err := validateStatuses(s.RetryStatuses); err != nil {
		return s, err
	}
	if err := validateStatuses(s.AutoDisableStatuses); err != nil {
		return s, err
	}
	return s, nil
}
