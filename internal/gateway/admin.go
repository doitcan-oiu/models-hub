package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

func (h *Handler) refresh(ctx context.Context) { _ = h.engine.Refresh(ctx) }
func (h *Handler) admin(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	path := r.URL.Path
	method := r.Method
	switch path {
	case "/api/bootstrap":
		if method == "GET" {
			channels, err := h.store.Channels(ctx)
			if err != nil {
				return err
			}
			keys, err := h.store.Keys(ctx)
			if err != nil {
				return err
			}
			settings, err := h.store.Settings(ctx)
			if err != nil {
				return err
			}
			tags, err := h.store.Tags(ctx)
			if err != nil {
				return err
			}
			writeJSON(w, 200, map[string]any{"channels": channels, "keys": keys, "settings": settings, "tags": tags, "devMode": h.development(r)})
			return nil
		}
	case "/api/settings":
		s, err := h.store.Settings(ctx)
		if err != nil {
			return err
		}
		if method == "PATCH" {
			b, err := readBody(w, r, 1<<20)
			if err != nil {
				return err
			}
			s, err = validateSettings(b, s)
			if err != nil {
				return err
			}
			if err = h.store.SaveSettings(ctx, s); err != nil {
				return err
			}
			h.refresh(ctx)
		} else if method != "GET" {
			return &HTTPError{405, "Method not allowed"}
		}
		writeJSON(w, 200, map[string]any{"settings": s})
		return nil
	case "/api/channels":
		if method == "GET" {
			c, e := h.store.Channels(ctx)
			if e != nil {
				return e
			}
			writeJSON(w, 200, map[string]any{"channels": c})
			return nil
		}
		if method == "POST" {
			b, e := readBody(w, r, 1<<20)
			if e != nil {
				return e
			}
			c, e := h.saveChannel(ctx, b, nil, h.development(r))
			if e != nil {
				return e
			}
			h.refresh(ctx)
			writeJSON(w, 201, map[string]any{"channel": c})
			return nil
		}
	case "/api/channels/discover-models":
		if method == "POST" {
			b, e := readBody(w, r, 1<<20)
			if e != nil {
				return e
			}
			result, e := h.integrations.Discover(ctx, b)
			if e != nil {
				return e
			}
			writeJSON(w, 200, result)
			return nil
		}
	case "/api/channels/import":
		if method == "POST" {
			b, e := readBody(w, r, 4<<20)
			if e != nil {
				return e
			}
			entries, ok := b["channels"].([]any)
			if !ok || len(entries) < 1 || len(entries) > 200 {
				return bad("需要 1–200 个渠道")
			}
			bundles := make([]managedBundle, len(entries))
			for i, v := range entries {
				input, ok := v.(map[string]any)
				if !ok {
					return bad("导入条目须为对象")
				}
				c, e := newChannel(input, nil, h.development(r))
				if e != nil {
					return e
				}
				if e = h.integrations.ValidateAccount(ctx, c, input); e != nil {
					return e
				}
				if _, ok := input["credentialUpdates"]; ok {
					return bad("导入新渠道不能修改已有密钥")
				}
				if _, ok := input["credentialDeletes"]; ok {
					return bad("导入新渠道不能删除已有密钥")
				}
				bundles[i], e = h.prepareAccountBundle(c, input)
				if e != nil {
					return e
				}
				bundles[i].adds, e = parseCredentialAdds(input)
				if e != nil {
					return e
				}
			}
			if e = h.store.saveManagedBundles(ctx, bundles); e != nil {
				return e
			}
			h.refresh(ctx)
			channels, e := h.store.Channels(ctx)
			if e != nil {
				return e
			}
			writeJSON(w, 201, map[string]any{"channels": channels})
			return nil
		}
	case "/api/channels/bulk":
		if method == "POST" {
			return h.bulkChannels(w, r)
		}
	case "/api/keys":
		if method == "GET" {
			keys, e := h.store.Keys(ctx)
			if e != nil {
				return e
			}
			writeJSON(w, 200, map[string]any{"keys": keys})
			return nil
		}
		if method == "POST" {
			b, e := readBody(w, r, 1<<20)
			if e != nil {
				return e
			}
			key, e := newAPIKey(b, nil)
			if e != nil {
				return e
			}
			token := randomSecret("pg_live_")
			key.TokenHash = tokenHash(token)
			key.Preview = "pg_live_••••" + token[len(token)-4:]
			if e = h.store.SaveKey(ctx, key); e != nil {
				return e
			}
			writeJSON(w, 201, map[string]any{"key": key, "token": token})
			return nil
		}
	case "/api/keys/bulk":
		if method == "POST" {
			b, e := readBody(w, r, 1<<20)
			if e != nil {
				return e
			}
			ids, e := stringList(b["ids"], 200)
			if e != nil {
				return e
			}
			action := str(b, "action")
			if !slices.Contains([]string{"enable", "disable", "delete"}, action) {
				return bad("批量操作无效")
			}
			if e = h.store.BulkKeys(ctx, ids, action); e != nil {
				return e
			}
			keys, e := h.store.Keys(ctx)
			if e != nil {
				return e
			}
			writeJSON(w, 200, map[string]any{"keys": keys})
			return nil
		}
	case "/api/tags":
		if method == "POST" {
			b, e := readBody(w, r, 32000)
			if e != nil {
				return e
			}
			name := strings.TrimSpace(str(b, "name"))
			if name == "" || len(name) > 256 {
				return bad("标签名称无效")
			}
			if e = h.store.AddTag(ctx, name); e != nil {
				return e
			}
		} else if method != "GET" {
			return &HTTPError{405, "Method not allowed"}
		}
		tags, e := h.store.Tags(ctx)
		if e != nil {
			return e
		}
		writeJSON(w, 200, map[string]any{"tags": tags})
		return nil
	case "/api/logs":
		if method == "DELETE" {
			if e := h.store.ClearLogs(ctx); e != nil {
				return e
			}
			writeJSON(w, 200, map[string]bool{"cleared": true})
			return nil
		}
		if method == "GET" {
			q := r.URL.Query()
			limit, _ := strconv.Atoi(q.Get("limit"))
			if limit < 1 {
				limit = 50
			}
			limit = min(limit, 200)
			offset, _ := strconv.Atoi(q.Get("offset"))
			offset = max(0, min(offset, 10000000))
			logs, total, e := h.store.Logs(ctx, limit, offset, q.Get("q"), q.Get("result"), q.Get("channelId"))
			if e != nil {
				return e
			}
			writeJSON(w, 200, map[string]any{"logs": logs, "total": total})
			return nil
		}
	case "/api/events":
		if method == "GET" {
			events, e := h.store.Events(ctx)
			if e != nil {
				return e
			}
			writeJSON(w, 200, map[string]any{"events": events})
			return nil
		}
	case "/api/runtime":
		if method == "GET" {
			stats := h.store.DB().Stats()
			database := h.store.DB().Dialect()
			if database == "postgres" {
				database = "postgresql"
			}
			writeJSON(w, 200, map[string]any{"runtime": "go", "database": database, "droppedLogs": h.engine.DroppedLogs(), "databasePool": map[string]any{"open": stats.OpenConnections, "inUse": stats.InUse, "idle": stats.Idle, "waitCount": stats.WaitCount, "waitDurationMs": stats.WaitDuration.Milliseconds()}})
			return nil
		}
	case "/api/dashboard":
		if method == "GET" {
			data, e := h.dashboard(ctx, r.URL.Query().Get("range"))
			if e != nil {
				return e
			}
			writeJSON(w, 200, data)
			return nil
		}
	case "/api/playground/chat":
		if method == "POST" {
			b, e := readBody(w, r, 4<<20)
			if e != nil {
				return e
			}
			var key *APIKey
			force := ""
			if str(b, "mode") == "channel" {
				force = str(b, "channelId")
				if _, e = h.store.Channel(ctx, force); e != nil {
					return e
				}
			} else if id := str(b, "keyId"); id != "" {
				k, e := h.store.Key(ctx, id)
				if e != nil {
					return e
				}
				if k.Status != "active" || keyExpired(k) {
					return &HTTPError{403, "所选 API Key 不可用"}
				}
				key = &k
			} else {
				return bad("请选择网关 API Key 或渠道")
			}
			payload, ok := b["request"].(map[string]any)
			if !ok {
				return bad("request 须为对象")
			}
			data, _ := json.Marshal(payload)
			req := r.Clone(ctx)
			req.URL = &url.URL{Path: "/v1/chat/completions"}
			req.Body = io.NopCloser(bytes.NewReader(data))
			req.ContentLength = int64(len(data))
			h.engine.ServeGateway(w, req, key, force, "playground")
			return nil
		}
	case "/api/dev/fixtures":
		if !h.development(r) {
			return &HTTPError{404, "Not found"}
		}
		if method == "POST" || method == "DELETE" {
			channels, e := h.store.Channels(ctx)
			if e != nil {
				return e
			}
			for _, c := range channels {
				if c.Config.Protocol == "mock" && slices.Contains(c.Tags, "本地测试") {
					if e = h.store.DeleteChannel(ctx, c.ID); e != nil {
						return e
					}
				}
			}
			if method == "POST" {
				for i, name := range []string{"本地测试 · 主渠道", "本地测试 · 备用渠道"} {
					if _, e = h.saveChannel(ctx, map[string]any{"name": name, "models": []string{"mock-model"}, "tags": []string{"本地测试"}, "priority": i, "config": map[string]any{"protocol": "mock"}}, nil, true); e != nil {
						return e
					}
				}
			}
			h.refresh(ctx)
			channels, e = h.store.Channels(ctx)
			if e != nil {
				return e
			}
			writeJSON(w, 200, map[string]any{"channels": channels})
			return nil
		}
	}
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) < 3 {
		return &HTTPError{404, "API endpoint not found"}
	}
	id, e := url.PathUnescape(parts[2])
	if e != nil {
		return bad("无效的 ID")
	}
	switch parts[1] {
	case "channels":
		c, e := h.store.Channel(ctx, id)
		if e != nil {
			return e
		}
		if len(parts) == 3 {
			switch method {
			case "GET":
				writeJSON(w, 200, map[string]any{"channel": c})
				return nil
			case "PATCH":
				b, e := readBody(w, r, 1<<20)
				if e != nil {
					return e
				}
				c, e = h.saveChannel(ctx, b, &c, h.development(r))
				if e != nil {
					return e
				}
				h.refresh(ctx)
				writeJSON(w, 200, map[string]any{"channel": c})
				return nil
			case "DELETE":
				if e = h.store.DeleteChannel(ctx, id); e != nil {
					return e
				}
				h.refresh(ctx)
				w.WriteHeader(204)
				return nil
			}
		}
		if len(parts) >= 4 {
			switch parts[3] {
			case "clone":
				if method == "POST" {
					c.ID = newID()
					c.Name += " · 副本"
					c.Enabled = false
					c.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
					c.CredentialCount = 0
					c.HasAccountCredentials = false
					c.AccountAuthMode = ""
					c.AccountIntegration = ""
					c.AccountBalance = nil
					c.Requests = 0
					c.TTFT = 0
					c.SuccessRate = 0
					c.History = []int{}
					c.Health = Health{}
					c.Status = "healthy"
					if e = h.store.SaveChannel(ctx, c); e != nil {
						return e
					}
					h.refresh(ctx)
					writeJSON(w, 201, map[string]any{"channel": c})
					return nil
				}
			case "balance":
				if method == "POST" {
					c, e = h.integrations.RefreshBalance(ctx, id)
					if e != nil {
						return e
					}
					h.refresh(ctx)
					writeJSON(w, 200, map[string]any{"channel": c})
					return nil
				}
			case "test", "recover":
				if method == "POST" {
					b := map[string]any{}
					if r.ContentLength != 0 {
						b, e = readBody(w, r, 32000)
						if e != nil {
							return e
						}
					}
					return h.testChannel(w, r, c, b)
				}
			case "reset-health":
				if method == "POST" {
					if e = h.store.ResetHealth(ctx, id); e != nil {
						return e
					}
					h.engine.ResetCircuit(id)
					h.refresh(ctx)
					c, e = h.store.Channel(ctx, id)
					if e != nil {
						return e
					}
					writeJSON(w, 200, map[string]any{"channel": c})
					return nil
				}
			case "tests":
				if method == "GET" {
					logs, e := h.store.ProbeLogs(ctx, id)
					if e != nil {
						return e
					}
					writeJSON(w, 200, map[string]any{"logs": logs, "total": len(logs)})
					return nil
				}
			case "credentials":
				return h.credentials(w, r, c, parts)
			}
		}
	case "keys":
		key, e := h.store.Key(ctx, id)
		if e != nil {
			return e
		}
		if len(parts) == 4 && parts[3] == "rotate" && method == "POST" {
			if key.Status == "revoked" {
				return &HTTPError{409, "Revoked keys cannot be rotated"}
			}
			token := randomSecret("pg_live_")
			key.TokenHash = tokenHash(token)
			key.Preview = "pg_live_••••" + token[len(token)-4:]
			if e = h.store.SaveKey(ctx, key); e != nil {
				return e
			}
			writeJSON(w, 200, map[string]any{"key": key, "token": token})
			return nil
		}
		if len(parts) == 3 {
			if method == "PATCH" {
				b, e := readBody(w, r, 1<<20)
				if e != nil {
					return e
				}
				key, e = newAPIKey(b, &key)
				if e != nil {
					return e
				}
				if e = h.store.SaveKey(ctx, key); e != nil {
					return e
				}
				writeJSON(w, 200, map[string]any{"key": key})
				return nil
			}
			if method == "DELETE" {
				if e = h.store.DeleteKey(ctx, id); e != nil {
					return e
				}
				w.WriteHeader(204)
				return nil
			}
		}
	case "logs":
		if method == "GET" {
			l, a, e := h.store.Log(ctx, id)
			if e != nil {
				return e
			}
			writeJSON(w, 200, map[string]any{"log": l, "attempts": a})
			return nil
		}
	case "tags":
		if method == "DELETE" {
			if e = h.store.DeleteTag(ctx, id); e != nil {
				return e
			}
		} else if method == "PATCH" {
			b, e := readBody(w, r, 32000)
			if e != nil {
				return e
			}
			name := strings.TrimSpace(str(b, "name"))
			if name == "" || len(name) > 256 {
				return bad("标签名称无效")
			}
			if e = h.store.RenameTag(ctx, id, name); e != nil {
				return e
			}
		} else {
			return &HTTPError{405, "Method not allowed"}
		}
		h.refresh(ctx)
		tags, e := h.store.Tags(ctx)
		if e != nil {
			return e
		}
		writeJSON(w, 200, map[string]any{"tags": tags})
		return nil
	}
	return &HTTPError{404, "API endpoint not found"}
}
func parseCredentialAdds(b map[string]any) ([]Credential, error) {
	out := []Credential{}
	v, exists := b["apiKeys"]
	if !exists {
		return out, nil
	}
	items, ok := v.([]any)
	if !ok {
		if typed, yes := v.([]string); yes {
			for _, s := range typed {
				items = append(items, s)
			}
		} else {
			return nil, bad("apiKeys 须为数组")
		}
	}
	if len(items) > 100 {
		return nil, bad("每次最多添加 100 个密钥")
	}
	for i, item := range items {
		label := fmt.Sprintf("密钥 %d", i+1)
		secret := ""
		switch v := item.(type) {
		case string:
			secret = v
		case map[string]any:
			secret = str(v, "secret")
			if str(v, "label") != "" {
				label = str(v, "label")
			}
		default:
			return nil, bad("密钥条目无效")
		}
		if strings.TrimSpace(secret) == "" || len(secret) > 16000 || len(label) > 128 {
			return nil, bad("密钥或名称为空或过长")
		}
		out = append(out, Credential{ID: newID(), Label: label, Enabled: true, Secret: strings.TrimSpace(secret), CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)})
	}
	return out, nil
}
func (h *Handler) saveChannel(ctx context.Context, b map[string]any, prior *Channel, dev bool) (Channel, error) {
	c, e := newChannel(b, prior, dev)
	if e != nil {
		return c, e
	}
	if e = h.integrations.ValidateAccount(ctx, c, b); e != nil {
		return c, e
	}
	return h.persistChannel(ctx, c, b, prior != nil)
}
func (h *Handler) persistChannel(ctx context.Context, c Channel, b map[string]any, mustExist bool) (Channel, error) {
	adds, e := parseCredentialAdds(b)
	if e != nil {
		return c, e
	}
	updates := []Credential{}
	deletes := []string{}
	existing := map[string]Credential{}
	if _, ok := b["credentialUpdates"]; ok {
		creds, e := h.store.Credentials(ctx, c.ID, true)
		if e != nil {
			return c, e
		}
		for _, cr := range creds {
			existing[cr.ID] = cr
		}
	}
	if raw, ok := b["credentialUpdates"]; ok {
		items, yes := raw.([]any)
		if !yes || len(items) > 100 {
			return c, bad("密钥更新须为最多 100 项的数组")
		}
		seen := map[string]bool{}
		for _, v := range items {
			item, ok := v.(map[string]any)
			if !ok {
				return c, bad("密钥更新无效")
			}
			id := str(item, "id")
			cr, ok := existing[id]
			if !ok {
				return c, ErrNotFound
			}
			if seen[id] {
				return c, bad("密钥 ID 重复")
			}
			seen[id] = true
			if label, ok := item["label"]; ok {
				s, yes := label.(string)
				if !yes || strings.TrimSpace(s) == "" || len(s) > 128 {
					return c, bad("密钥名称无效")
				}
				cr.Label = s
			} else {
				cr.Label = ""
			}
			if secret, ok := item["secret"]; ok {
				s, yes := secret.(string)
				if !yes || strings.TrimSpace(s) == "" || len(s) > 16000 {
					return c, bad("密钥无效")
				}
				if cr.Secret != s {
					cr.Secret = strings.TrimSpace(s)
					cr.Balance = nil
					cr.ExpiresAt = nil
				}
			} else {
				cr.Secret = ""
			}
			updates = append(updates, cr)
		}
	}
	if raw, ok := b["credentialDeletes"]; ok {
		data, _ := json.Marshal(raw)
		if json.Unmarshal(data, &deletes) != nil || len(deletes) > 100 {
			return c, bad("密钥删除条目无效")
		}
		seen := map[string]bool{}
		for _, id := range deletes {
			if id == "" || seen[id] {
				return c, bad("密钥 ID 无效或重复")
			}
			seen[id] = true
			for _, cr := range updates {
				if cr.ID == id {
					return c, bad("同一密钥不能同时修改和删除")
				}
			}
		}
	}
	bundle, e := h.prepareAccountBundle(c, b)
	if e != nil {
		return c, e
	}
	bundle.adds = adds
	bundle.updates = updates
	bundle.deletes = deletes
	bundle.mustExist = mustExist
	if e = h.store.saveManagedBundles(ctx, []managedBundle{bundle}); e != nil {
		return c, e
	}
	h.engine.ResetCircuit(c.ID)
	return h.store.Channel(ctx, c.ID)
}
func (h *Handler) credentials(w http.ResponseWriter, r *http.Request, c Channel, parts []string) error {
	ctx := r.Context()
	creds, e := h.store.Credentials(ctx, c.ID, true)
	if e != nil {
		return e
	}
	if len(parts) == 4 {
		if r.Method == "GET" {
			writeJSON(w, 200, map[string]any{"credentials": creds})
			return nil
		}
		if r.Method == "POST" {
			b, e := readBody(w, r, 32000)
			if e != nil {
				return e
			}
			secret := strings.TrimSpace(str(b, "secret"))
			label := str(b, "label")
			if label == "" {
				label = "密钥"
			}
			if secret == "" || len(secret) > 16000 || len(label) > 128 {
				return bad("密钥为空或过长")
			}
			cr := Credential{ID: newID(), Label: label, Secret: secret, Enabled: true, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
			if e = h.store.SaveCredential(ctx, c.ID, cr); e != nil {
				return e
			}
			h.refresh(ctx)
			creds, e = h.store.Credentials(ctx, c.ID, true)
			if e != nil {
				return e
			}
			for _, saved := range creds {
				if saved.ID == cr.ID {
					writeJSON(w, 201, map[string]any{"credential": saved})
					return nil
				}
			}
		}
	}
	if len(parts) == 5 {
		var cr Credential
		found := false
		for _, v := range creds {
			if v.ID == parts[4] {
				cr = v
				found = true
				break
			}
		}
		if !found {
			return ErrNotFound
		}
		if r.Method == "DELETE" {
			if e = h.store.DeleteCredential(ctx, c.ID, cr.ID); e != nil {
				return e
			}
			h.refresh(ctx)
			w.WriteHeader(204)
			return nil
		}
		if r.Method == "PATCH" {
			b, e := readBody(w, r, 32000)
			if e != nil {
				return e
			}
			if raw, ok := b["label"]; ok {
				v, yes := raw.(string)
				if !yes || strings.TrimSpace(v) == "" || len(v) > 128 {
					return bad("密钥名称无效")
				}
				cr.Label = v
			} else {
				cr.Label = ""
			}
			if raw, ok := b["secret"]; ok {
				v, yes := raw.(string)
				if !yes || strings.TrimSpace(v) == "" || len(v) > 16000 {
					return bad("密钥无效")
				}
				if cr.Secret != v {
					cr.Secret = strings.TrimSpace(v)
					cr.Balance = nil
					cr.ExpiresAt = nil
				}
			} else {
				cr.Secret = ""
			}
			var enabled *bool
			if raw, ok := b["enabled"]; ok {
				v, yes := raw.(bool)
				if !yes {
					return bad("enabled 须为布尔值")
				}
				enabled = &v
			}
			if cr, e = h.store.PatchManagedCredential(ctx, c.ID, cr, enabled); e != nil {
				return e
			}
			h.refresh(ctx)
			writeJSON(w, 200, map[string]any{"credential": cr})
			return nil
		}
	}
	return &HTTPError{405, "Method not allowed"}
}
func (h *Handler) bulkChannels(w http.ResponseWriter, r *http.Request) error {
	b, e := readBody(w, r, 1<<20)
	if e != nil {
		return e
	}
	ids, e := stringList(b["ids"], 200)
	if e != nil {
		return e
	}
	channels, e := h.store.Channels(r.Context())
	if e != nil {
		return e
	}
	byID := map[string]Channel{}
	for _, c := range channels {
		byID[c.ID] = c
	}
	changes := []Channel{}
	action := str(b, "action")
	if !slices.Contains([]string{"enable", "disable", "archive", "restore", "tags", "weights"}, action) {
		return bad("批量操作无效")
	}
	var tags []string
	if action == "tags" {
		raw, ok := b["tags"].([]any)
		if !ok {
			return bad("标签须为数组")
		}
		tags = make([]string, len(raw))
		for i, entry := range raw {
			var ok bool
			if tags[i], ok = entry.(string); !ok {
				return bad("标签须为文本")
			}
		}
		tags, e = normalizedStrings(tags, 100)
		if e != nil {
			return e
		}
		if !slices.Contains([]string{"", "add", "replace", "remove"}, str(b, "mode")) {
			return bad("标签批量操作无效")
		}
	}
	for _, id := range ids {
		c, ok := byID[id]
		if !ok {
			return ErrNotFound
		}
		switch action {
		case "enable":
			c.Enabled = true
		case "disable":
			c.Enabled = false
		case "archive":
			c.Archived = true
			c.Enabled = false
		case "restore":
			c.Archived = false
		case "weights":
			v, ok := b["weight"].(float64)
			if !ok || v < 0 || v > 10000 || v != float64(int(v)) {
				return bad("权重须为 0–10000 的整数")
			}
			c.Weight = int(v)
		case "tags":
			switch str(b, "mode") {
			case "replace":
				c.Tags = tags
			case "remove":
				next := []string{}
				for _, t := range c.Tags {
					if !slices.Contains(tags, t) {
						next = append(next, t)
					}
				}
				c.Tags = next
			default:
				for _, t := range tags {
					if !slices.Contains(c.Tags, t) {
						c.Tags = append(c.Tags, t)
					}
				}
			}
			if len(c.Tags) > 100 {
				return bad("每个渠道最多允许 100 个标签")
			}
		}
		changes = append(changes, c)
	}
	if e = h.store.BulkChannels(r.Context(), changes); e != nil {
		return e
	}
	h.refresh(r.Context())
	channels, e = h.store.Channels(r.Context())
	if e != nil {
		return e
	}
	writeJSON(w, 200, map[string]any{"channels": channels})
	return nil
}
func (h *Handler) testChannel(w http.ResponseWriter, r *http.Request, c Channel, b map[string]any) error {
	probeContext, cancelProbe := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancelProbe()
	r = r.WithContext(probeContext)
	model := str(b, "model")
	if model == "" {
		model = c.Model
	}
	stream := true
	if v, ok := b["stream"].(bool); ok {
		stream = v
	}
	payload, _ := json.Marshal(map[string]any{"model": model, "messages": []map[string]string{{"role": "user", "content": "Reply with OK."}}, "max_tokens": 32, "stream": stream})
	req := r.Clone(r.Context())
	req.URL = &url.URL{Path: "/v1/chat/completions"}
	if c.Config.Protocol == "anthropic" {
		req.URL.Path = "/v1/messages"
	}
	if c.Config.Protocol == "gemini" {
		req.URL.Path = "/v1beta/models/" + url.PathEscape(model) + ":generateContent"
		payload, _ = json.Marshal(map[string]any{"model": model, "contents": []any{map[string]any{"role": "user", "parts": []any{map[string]string{"text": "Reply with OK."}}}}})
		stream = false
	}
	req.Body = io.NopCloser(bytes.NewReader(payload))
	req.ContentLength = int64(len(payload))
	if credentialID := str(b, "credentialId"); credentialID != "" {
		req = req.WithContext(context.WithValue(req.Context(), engineCredentialContextKey{}, credentialID))
	}
	recorder := &adminProbeWriter{headers: make(http.Header), status: 200}
	start := time.Now()
	h.engine.ServeGateway(recorder, req, nil, c.ID, "probe")
	requestID := recorder.Header().Get("X-Pulsegate-Request-Id")
	ttft, _ := strconv.ParseFloat(recorder.Header().Get("X-Pulsegate-Ttft-Ms"), 64)
	status := recorder.status
	duration := time.Since(start).Seconds()
	attempts := []Attempt{}
	success := status >= 200 && status < 300 && !strings.Contains(recorder.body.String(), `"error"`)
	var problem any
	if log, details, err := h.store.Log(r.Context(), requestID); err == nil {
		status = log.Status
		duration = log.Duration
		ttft = log.TTFT * 1000
		attempts = details
		success = log.Result != "error" && log.Status >= 200 && log.Status < 300
		if log.Error != nil {
			problem = *log.Error
		}
	}
	if !success {
		problem = "上游测试失败，请查看请求日志"
	}
	channel, e := h.store.Channel(r.Context(), c.ID)
	if e != nil {
		return e
	}
	writeJSON(w, 200, map[string]any{"success": success, "requestId": requestID, "ttft": ttft / 1000, "duration": duration, "status": status, "error": problem, "attempts": attempts, "channel": channel})
	return nil
}

type adminProbeWriter struct {
	headers http.Header
	status  int
	body    bytes.Buffer
}

func (w *adminProbeWriter) Header() http.Header    { return w.headers }
func (w *adminProbeWriter) WriteHeader(status int) { w.status = status }
func (w *adminProbeWriter) Write(data []byte) (int, error) {
	n := len(data)
	if w.body.Len() < 64<<10 {
		_, _ = w.body.Write(data[:min(n, (64<<10)-w.body.Len())])
	}
	return n, nil
}
func (w *adminProbeWriter) Flush() {}
