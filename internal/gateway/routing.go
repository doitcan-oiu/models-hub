package gateway

import (
	"errors"
	"math"
	"math/rand/v2"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

func currentEngineProfile(key *APIKey) *KeyProfile {
	if key == nil {
		return nil
	}
	for i := range key.Profiles {
		if key.Profiles[i].ID == key.ActiveProfile {
			return &key.Profiles[i]
		}
	}
	return nil
}

func ChannelInScope(c Channel, p *KeyProfile) bool {
	if p == nil || p.Scope == "all" {
		return true
	}
	if p.Scope == "channels" {
		return containsString(p.ChannelIDs, c.ID)
	}
	if len(p.Tags) == 0 {
		return false
	}
	hits := 0
	for _, tag := range p.Tags {
		if containsString(c.Tags, tag) {
			hits++
		}
	}
	if p.Match == "all" {
		return hits == len(p.Tags)
	}
	if p.Match == "none" {
		return hits == 0
	}
	return hits > 0
}

func containsString(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}

func ResolveChannelModel(c Channel, requested string) (string, bool) {
	for _, alias := range c.Config.Aliases {
		if alias.From == requested {
			return alias.To, true
		}
	}
	return requested, requested == c.Model || containsString(c.Models, requested)
}

type engineCandidate struct {
	channel Channel
	model   string
}

func engineCandidates(channels []Channel, p *KeyProfile, model, force string, s Settings, unavailable bool) []engineCandidate {
	targets := []string{model}
	if p != nil {
		for _, m := range p.Mappings {
			if m.From == model {
				targets = m.To
				break
			}
		}
	}
	result := make([]engineCandidate, 0, len(channels))
	for _, c := range channels {
		if c.Archived || !ChannelInScope(c, p) || force != "" && c.ID != force {
			continue
		}
		if force == "" && !unavailable && (!c.Enabled || c.Health.AutoDisabled || s.AutoSwitch && c.Status != "healthy") {
			continue
		}
		for _, target := range targets {
			if p != nil && p.ModelMode == "selected" && !containsString(p.Models, target) {
				continue
			}
			if resolved, ok := ResolveChannelModel(c, target); ok {
				result = append(result, engineCandidate{c, resolved})
				break
			}
		}
	}
	return result
}

func orderEngineCandidates(c []engineCandidate, s Settings, stream bool, offset uint64, sticky string) {
	sort.SliceStable(c, func(i, j int) bool {
		a, b := c[i].channel, c[j].channel
		if a.Priority != b.Priority {
			return a.Priority < b.Priority
		}
		if a.Weight != b.Weight {
			return a.Weight > b.Weight
		}
		return a.ID < b.ID
	})
	switch s.Strategy {
	case "adaptive":
		score := func(c Channel) float64 {
			t := 1.0
			if stream && c.Health.AverageTTFT != nil {
				t = *c.Health.AverageTTFT
			} else if !stream && c.Health.AverageDuration != nil {
				t = *c.Health.AverageDuration
			}
			return math.Max(t, 0.001) * (1 + (100-c.SuccessRate)/20) / math.Max(1, float64(c.Weight))
		}
		sort.SliceStable(c, func(i, j int) bool { return score(c[i].channel) < score(c[j].channel) })
	case "round-robin":
		if len(c) > 0 {
			n := int(offset % uint64(len(c)))
			copy(c, append(append([]engineCandidate{}, c[n:]...), c[:n]...))
		}
	case "weighted":
		ranks := make(map[string]float64, len(c))
		for _, candidate := range c {
			ranks[candidate.channel.ID] = -math.Log(math.Max(rand.Float64(), 1e-15)) / math.Max(float64(candidate.channel.Weight), 0.001)
		}
		sort.SliceStable(c, func(i, j int) bool { return ranks[c[i].channel.ID] < ranks[c[j].channel.ID] })
	}
	if s.StickyMode == "prefer" && sticky != "" {
		for i := range c {
			if c[i].channel.ID == sticky && i > 0 {
				v := c[i]
				copy(c[1:i+1], c[:i])
				c[0] = v
				break
			}
		}
	}
}

// ResolveUpstreamURL preserves an explicitly configured deployment prefix and
// shares an overlapping API version exactly once. Client paths cannot escape it.
// The special path "models" is used by management model discovery.
func ResolveUpstreamURL(c Channel, clientPath, model string, stream bool) (string, error) {
	if c.Config.GatewayMode == "ai-gateway" {
		return "", errors.New("Cloudflare AI Gateway 模式已停用，请将渠道改为直连或中继 URL")
	}
	base := c.Endpoint
	if c.Config.RelayURL != "" {
		base = c.Config.RelayURL
	}
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Fragment != "" {
		return "", errors.New("上游地址必须是无登录凭证的 HTTP(S) URL")
	}
	prefix := strings.TrimRight(u.EscapedPath(), "/")
	path := clientPath
	configured := false
	defaults := DefaultChannelConfig().Endpoints
	if clientPath == "models" {
		path = c.Config.Endpoints.Models
		if path == "" {
			path = defaults.Models
		}
		configured = true
	}
	if clientPath == "/v1/chat/completions" && c.Config.Endpoints.Chat != "" && c.Config.Endpoints.Chat != defaults.Chat {
		path = c.Config.Endpoints.Chat
		configured = true
	}
	if clientPath == "/v1/messages" && c.Config.Endpoints.Messages != "" && c.Config.Endpoints.Messages != defaults.Messages {
		path = c.Config.Endpoints.Messages
		configured = true
	}
	if strings.HasPrefix(clientPath, "/v1beta/models/") && (strings.HasSuffix(clientPath, ":generateContent") || strings.HasSuffix(clientPath, ":streamGenerateContent")) && c.Config.Endpoints.Generate != "" && c.Config.Endpoints.Generate != defaults.Generate {
		path = c.Config.Endpoints.Generate
		configured = true
	}
	if clientPath == "" {
		configured = true
		switch c.Config.Protocol {
		case "anthropic":
			path = c.Config.Endpoints.Messages
			if path == "" {
				path = defaults.Messages
			}
		case "gemini":
			path = c.Config.Endpoints.Generate
			if path == "" {
				path = defaults.Generate
			}
		default:
			path = c.Config.Endpoints.Chat
			if path == "" {
				path = defaults.Chat
			}
		}
	}
	path = strings.ReplaceAll(path, "{model}", url.PathEscape(model))
	if c.Config.Protocol == "gemini" && configured && stream {
		path = strings.Replace(path, ":generateContent", ":streamGenerateContent", 1)
	}
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") || strings.ContainsAny(path, "\\?#\r\n\t ") {
		return "", errors.New("无效的上游 API 路径")
	}
	decoded, err := url.PathUnescape(path)
	if err != nil {
		return "", err
	}
	for _, segment := range strings.FieldsFunc(decoded, func(r rune) bool { return r == '/' || r == '\\' }) {
		if segment == "." || segment == ".." {
			return "", errors.New("API 路径不能包含相对目录")
		}
	}
	if configured {
		if prefix == "" && (path == defaults.Chat || path == defaults.Messages || path == defaults.Models || strings.HasPrefix(path, "/models/")) {
			prefix = "/v1"
			if c.Config.Protocol == "gemini" {
				prefix = "/v1beta"
			}
		}
		if prefix != "" && strings.HasPrefix(path, prefix+"/") {
			prefix = ""
		}
	} else {
		for overlap := prefix; overlap != ""; {
			if path == overlap || strings.HasPrefix(path, overlap+"/") {
				path = strings.TrimPrefix(path, overlap)
				break
			}
			n := strings.Index(overlap[1:], "/")
			if n < 0 {
				break
			}
			overlap = overlap[n+1:]
		}
	}
	escaped := prefix + path
	u.Path, err = url.PathUnescape(escaped)
	if err != nil {
		return "", err
	}
	u.RawPath = escaped
	if c.Config.Protocol == "gemini" && configured && stream {
		q := u.Query()
		q.Set("alt", "sse")
		u.RawQuery = q.Encode()
	}
	return u.String(), nil
}

// The transport negotiates and decodes compression before JSON/SSE inspection.
// Forwarding Accept-Encoding disables its automatic decompression.
var protectedEngineHeaders = map[string]bool{"Host": true, "Content-Length": true, "Content-Encoding": true, "Accept-Encoding": true, "Connection": true, "Keep-Alive": true, "Transfer-Encoding": true, "Te": true, "Trailer": true, "Upgrade": true, "Proxy-Authorization": true, "Proxy-Authenticate": true, "Authorization": true, "X-Api-Key": true, "X-Goog-Api-Key": true, "Cf-Aig-Authorization": true, "Cookie": true, "Set-Cookie": true}

func UpstreamHeaders(c Channel, secret string, incoming http.Header, protocol string) http.Header {
	h := make(http.Header)
	h.Set("Content-Type", "application/json")
	h.Set("Accept", "application/json, text/event-stream")
	connection := map[string]bool{}
	for _, v := range incoming.Values("Connection") {
		for _, k := range strings.Split(v, ",") {
			connection[http.CanonicalHeaderKey(strings.TrimSpace(k))] = true
		}
	}
	for k, vs := range incoming {
		k = http.CanonicalHeaderKey(k)
		if !protectedEngineHeaders[k] && !connection[k] && !strings.HasPrefix(strings.ToLower(k), "x-pulsegate-") {
			h[k] = append([]string(nil), vs...)
		}
	}
	for k, v := range c.Config.Headers {
		if !protectedEngineHeaders[http.CanonicalHeaderKey(k)] {
			h.Set(k, v)
		}
	}
	if protocol == "" {
		protocol = c.Config.Protocol
	}
	switch protocol {
	case "anthropic":
		h.Set("X-Api-Key", secret)
		if h.Get("Anthropic-Version") == "" {
			h.Set("Anthropic-Version", "2023-06-01")
		}
	case "gemini":
		h.Set("X-Goog-Api-Key", secret)
	default:
		h.Set("Authorization", "Bearer "+secret)
	}
	return h
}
