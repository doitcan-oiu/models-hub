package gateway

import (
	"encoding/json"
	"net/http"
)

// Only gateway-generated errors use this adapter. Upstream bodies and SSE bytes
// keep their native format, including tool calls and vendor extensions.
type anthropicWriter struct {
	http.ResponseWriter
	status    int
	generated bool
}

func (w *anthropicWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *anthropicWriter) WriteHeader(status int) {
	w.status = status
	w.generated = status >= 400 && w.Header().Get("X-Pulsegate-Channel-Id") == ""
	if id := w.Header().Get("X-Pulsegate-Request-Id"); id != "" && w.Header().Get("Request-Id") == "" {
		w.Header().Set("Request-Id", id)
	}
	if w.generated {
		w.Header().Del("Content-Length")
	}
	w.ResponseWriter.WriteHeader(status)
}
func (w *anthropicWriter) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	if !w.generated {
		return w.ResponseWriter.Write(data)
	}
	var value struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(data, &value) != nil || value.Error.Message == "" {
		return w.ResponseWriter.Write(data)
	}
	kind := "api_error"
	switch w.status {
	case 400:
		kind = "invalid_request_error"
	case 401:
		kind = "authentication_error"
	case 403:
		kind = "permission_error"
	case 404:
		kind = "not_found_error"
	case 413:
		kind = "request_too_large"
	case 429:
		kind = "rate_limit_error"
	case 503, 529:
		kind = "overloaded_error"
	}
	body, _ := json.Marshal(map[string]any{"type": "error", "error": map[string]string{"type": kind, "message": value.Error.Message}})
	_, err := w.ResponseWriter.Write(body)
	return len(data), err
}
func (w *anthropicWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
