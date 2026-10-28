package gateway

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type engineObservation struct {
	bytes            []byte
	meaningful, done bool
	failure          string
	input, output    int64
}

func asEngineObject(v any) map[string]any { m, _ := v.(map[string]any); return m }
func asEngineArray(v any) []any           { a, _ := v.([]any); return a }
func asEngineString(v any) string         { s, _ := v.(string); return s }
func engineCount(v any) int64 {
	n, _ := v.(float64)
	if n < 0 || n > 9e15 {
		return 0
	}
	return int64(n)
}

func observeEngineJSON(data []byte, model string, rewrite bool, event string) engineObservation {
	o := engineObservation{bytes: data}
	trimmed := bytes.TrimSpace(data)
	if bytes.Equal(trimmed, []byte("[DONE]")) {
		o.done = true
		return o
	}
	var value any
	if json.Unmarshal(data, &value) != nil {
		o.meaningful = len(trimmed) > 0
		return o
	}
	m := asEngineObject(value)
	if m == nil {
		o.meaningful = enginePayload(value)
		return o
	}
	typeName := asEngineString(m["type"])
	if typeName == "" {
		typeName = event
	}
	response := asEngineObject(m["response"])
	if errValue := m["error"]; errValue != nil {
		o.failure = engineDiagnostic(errValue)
	}
	if response != nil && response["error"] != nil {
		o.failure = engineDiagnostic(response["error"])
	}
	if (typeName == "error" || typeName == "response.failed") && o.failure == "" {
		o.failure = asEngineString(m["message"])
		if o.failure == "" {
			o.failure = "上游返回错误事件"
		}
	}
	u := asEngineObject(m["usage"])
	if u == nil {
		u = asEngineObject(asEngineObject(m["message"])["usage"])
	}
	if response != nil && response["usage"] != nil {
		u = asEngineObject(response["usage"])
	}
	if u != nil {
		o.input = engineCount(u["prompt_tokens"])
		o.output = engineCount(u["completion_tokens"])
		if _, ok := u["input_tokens"]; ok {
			o.input = engineCount(u["input_tokens"])
		}
		if _, ok := u["output_tokens"]; ok {
			o.output = engineCount(u["output_tokens"])
		}
		if !strings.HasPrefix(typeName, "response.") && asEngineString(m["object"]) != "response" {
			o.input += engineCount(u["cache_creation_input_tokens"]) + engineCount(u["cache_read_input_tokens"])
		}
	}
	if usage := asEngineObject(m["usageMetadata"]); usage != nil {
		o.input = engineCount(usage["promptTokenCount"])
		o.output = engineCount(usage["candidatesTokenCount"]) + engineCount(usage["thoughtsTokenCount"])
	}
	if choices, ok := m["choices"]; ok {
		for _, v := range asEngineArray(choices) {
			c := asEngineObject(v)
			message := c["delta"]
			if message == nil {
				message = c["message"]
			}
			if engineBlock(message) {
				o.meaningful = true
			}
		}
	} else if candidates, ok := m["candidates"]; ok {
		for _, v := range asEngineArray(candidates) {
			if engineBlock(asEngineObject(v)["content"]) {
				o.meaningful = true
			}
		}
	} else if strings.HasPrefix(typeName, "response.") || asEngineString(m["object"]) == "response" {
		switch typeName {
		case "response.created", "response.in_progress", "response.queued":
		case "response.completed", "response.incomplete":
			o.done = true
			o.meaningful = engineResponseOutput(response["output"]) || asEngineString(response["output_text"]) != ""
		case "response.failed":
			o.done = true
		default:
			if strings.HasSuffix(typeName, ".delta") {
				o.meaningful = enginePayload(m["delta"])
			} else {
				o.meaningful = engineResponseOutput(m["item"]) || engineResponseOutput(m["part"])
			}
		}
		if asEngineString(m["object"]) == "response" {
			status := asEngineString(m["status"])
			o.meaningful = engineResponseOutput(m["output"]) || asEngineString(m["output_text"]) != "" || status == "queued" || status == "in_progress"
		}
	} else {
		switch typeName {
		case "ping", "message_start", "message_delta":
		case "message_stop":
			o.done = true
		case "content_block_start":
			o.meaningful = engineBlock(m["content_block"])
		case "content_block_delta":
			o.meaningful = engineBlock(m["delta"])
		case "error":
		default:
			if _, ok := m["content"]; ok {
				o.meaningful = engineBlock(m)
			} else {
				o.meaningful = enginePayload(m)
				if event == "" {
					o.meaningful = len(m) > 0
				}
			}
		}
	}
	if rewrite {
		changed := false
		if _, ok := m["model"]; ok && m["model"] != model {
			m["model"] = model
			changed = true
		}
		if response != nil {
			if _, ok := response["model"]; ok && response["model"] != model {
				response["model"] = model
				changed = true
			}
		}
		if typeName == "message_start" {
			message := asEngineObject(m["message"])
			if _, ok := message["model"]; ok && message["model"] != model {
				message["model"] = model
				changed = true
			}
		}
		if changed {
			if encoded, err := json.Marshal(m); err == nil {
				o.bytes = encoded
			}
		}
	}
	return o
}

func engineDiagnostic(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	if message := asEngineString(asEngineObject(v)["message"]); message != "" {
		return message
	}
	return "上游返回错误"
}

func engineBlock(v any) bool {
	if s, ok := v.(string); ok {
		return s != ""
	}
	if a, ok := v.([]any); ok {
		for _, x := range a {
			if engineBlock(x) {
				return true
			}
		}
		return false
	}
	m := asEngineObject(v)
	if m == nil {
		return false
	}
	for _, key := range []string{"text", "content", "reasoning_content", "reasoning", "thinking", "refusal", "partial_json"} {
		if s, ok := m[key].(string); ok && s != "" {
			return true
		}
	}
	if asEngineString(m["type"]) == "signature_delta" {
		return false
	}
	for _, key := range []string{"content", "parts"} {
		if engineBlock(m[key]) {
			return true
		}
	}
	if tools := asEngineArray(m["tool_calls"]); len(tools) > 0 {
		for _, tool := range tools {
			t := asEngineObject(tool)
			f := asEngineObject(t["function"])
			if asEngineString(t["id"]) != "" || asEngineString(f["name"]) != "" || asEngineString(f["arguments"]) != "" {
				return true
			}
		}
	}
	for _, key := range []string{"functionCall", "function_call"} {
		if f := asEngineObject(m[key]); f != nil && (asEngineString(f["name"]) != "" || enginePayload(f["args"]) || enginePayload(f["arguments"])) {
			return true
		}
	}
	return strings.Contains(asEngineString(m["type"]), "tool_use") && (asEngineString(m["id"]) != "" || asEngineString(m["name"]) != "")
}

func engineResponseOutput(v any) bool {
	if a, ok := v.([]any); ok {
		for _, x := range a {
			if engineResponseOutput(x) {
				return true
			}
		}
		return false
	}
	m := asEngineObject(v)
	if m == nil {
		return enginePayload(v)
	}
	t := asEngineString(m["type"])
	if t == "message" {
		return engineResponseOutput(m["content"])
	}
	if strings.Contains(t, "call") || strings.Contains(t, "tool") {
		return enginePayload(m)
	}
	return engineBlock(m)
}

func enginePayload(v any) bool {
	switch v := v.(type) {
	case string:
		return v != ""
	case float64, bool:
		return true
	case []any:
		for _, x := range v {
			if enginePayload(x) {
				return true
			}
		}
	case map[string]any:
		for k, x := range v {
			switch strings.ToLower(k) {
			case "type", "id", "name", "index", "model", "signature", "citations", "cache_control", "metadata", "usage", "status", "state", "stop_reason", "stop_sequence", "role", "object", "created", "sequence_number":
				continue
			}
			if enginePayload(x) {
				return true
			}
		}
	}
	return false
}

// SSE boundaries may span arbitrary network reads. The parser bounds every
// event to 1 MiB while preserving framing, comments and unfamiliar events.
func readEngineFrame(r *bufio.Reader) ([]byte, error) {
	frame := make([]byte, 0, 1024)
	for {
		b, err := r.ReadByte()
		if err != nil {
			if len(frame) > 0 && errors.Is(err, io.EOF) {
				return frame, nil
			}
			return nil, err
		}
		frame = append(frame, b)
		n := len(frame)
		if n > 1<<20 {
			return nil, errors.New("上游单个 SSE 事件超过 1 MiB")
		}
		if n >= 2 && (frame[n-2] == '\n' && b == '\n' || frame[n-2] == '\r' && b == '\r') || n >= 4 && bytes.Equal(frame[n-4:], []byte("\r\n\r\n")) {
			return frame, nil
		}
	}
}

type engineIdleReader struct {
	body         io.Reader
	timer        *time.Timer
	idleDuration time.Duration
}

func (r *engineIdleReader) Read(data []byte) (int, error) {
	n, err := r.body.Read(data)
	if n > 0 && r.timer != nil {
		r.timer.Reset(r.idleDuration)
	}
	return n, err
}

func observeEngineFrame(frame []byte, model string, rewrite bool) engineObservation {
	lines := strings.Split(strings.ReplaceAll(strings.ReplaceAll(string(frame), "\r\n", "\n"), "\r", "\n"), "\n")
	event := "message"
	var values []string
	for _, line := range lines {
		if strings.HasPrefix(line, "event:") {
			event = strings.TrimPrefix(strings.TrimPrefix(line, "event:"), " ")
		} else if line == "data" {
			values = append(values, "")
		} else if strings.HasPrefix(line, "data:") {
			values = append(values, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if len(values) == 0 {
		return engineObservation{bytes: frame}
	}
	data := []byte(strings.Join(values, "\n"))
	o := observeEngineJSON(data, model, rewrite, event)
	if !bytes.Equal(o.bytes, data) {
		var output bytes.Buffer
		replaced := false
		start := 0
		for start < len(frame) {
			end := start
			for end < len(frame) && frame[end] != '\r' && frame[end] != '\n' {
				end++
			}
			next := end
			if next < len(frame) {
				next++
				if frame[end] == '\r' && next < len(frame) && frame[next] == '\n' {
					next++
				}
			}
			line := frame[start:end]
			if bytes.Equal(line, []byte("data")) || bytes.HasPrefix(line, []byte("data:")) {
				if !replaced {
					output.WriteString("data: ")
					output.Write(o.bytes)
					output.Write(frame[end:next])
					replaced = true
				}
			} else {
				output.Write(frame[start:next])
			}
			start = next
		}
		o.bytes = output.Bytes()
	} else {
		o.bytes = frame
	}
	return o
}

func (e *Engine) streamAttempt(w http.ResponseWriter, r *http.Request, response *http.Response, c engineCandidate, model string, s Settings, id string, number int, began time.Time, cancel context.CancelFunc, firstTimer *time.Timer, credential Credential) attemptResult {
	result := attemptResult{status: response.StatusCode, header: response.Header, retry: true}
	idleReader := &engineIdleReader{body: response.Body, idleDuration: e.cfg.StreamIdleTimeout}
	reader := bufio.NewReaderSize(idleReader, 32<<10)
	prefix := make([][]byte, 0, 4)
	size := 0
	terminal := false
	observe := func(o engineObservation) {
		if o.input > 0 {
			result.input = o.input
		}
		if o.output > 0 {
			result.output = o.output
		}
	}
	for {
		frame, err := readEngineFrame(reader)
		if err != nil {
			if errors.Is(err, io.EOF) && !s.EmptyResponseDetection {
				break
			}
			result.status = 502
			result.err = errors.New("上游流未返回有效内容或首 Token 超时")
			if r.Context().Err() != nil {
				result.cancelled = true
				result.status = 499
			}
			return result
		}
		o := observeEngineFrame(frame, model, c.model != model)
		observe(o)
		size += len(o.bytes)
		if size > 1<<20 {
			result.status = 502
			result.err = errors.New("上游首 Token 前数据超过 1 MiB")
			return result
		}
		prefix = append(prefix, o.bytes)
		if o.failure != "" {
			result.status = 502
			result.err = errors.New(redactEngineString(o.failure, credential.Secret))
			return result
		}
		terminal = o.done
		if o.meaningful {
			ttft := time.Since(began).Seconds()
			result.ttft = &ttft
			break
		}
		if terminal {
			if s.EmptyResponseDetection {
				result.status = 502
				result.err = errors.New("上游流结束但未返回有效内容")
				return result
			}
			break
		}
	}
	if firstTimer != nil {
		firstTimer.Stop()
	}
	// This deadline is refreshed on every successful upstream read. Comments may
	// keep an active stream alive; StreamMaxDuration remains the absolute bound.
	idle := time.AfterFunc(e.cfg.StreamIdleTimeout, cancel)
	idleReader.timer = idle
	defer idle.Stop()
	defer cancel()
	copyEngineHeaders(w.Header(), response.Header)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	setEngineResponseHeaders(w, id, c.channel.ID, number, result.ttft)
	w.WriteHeader(response.StatusCode)
	result.visible = true
	write := func(data []byte) bool {
		if _, err := writeEngine(w, data, e.cfg.DownstreamWriteTimeout); err != nil {
			result.status = 499
			result.cancelled = true
			result.err = errors.New("客户端取消或读取响应过慢")
			return false
		}
		return true
	}
	for _, frame := range prefix {
		if !write(frame) {
			return result
		}
	}
	if terminal {
		return result
	}
	for {
		frame, err := readEngineFrame(reader)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return result
			}
			result.status = 502
			result.err = errors.New("上游流中断或空闲超时")
			if r.Context().Err() != nil {
				result.status = 499
				result.cancelled = true
			}
			return result
		}
		idle.Reset(e.cfg.StreamIdleTimeout)
		o := observeEngineFrame(frame, model, c.model != model)
		observe(o)
		if o.failure != "" {
			result.status = 502
			result.err = fmt.Errorf("上游流错误: %s", redactEngineString(o.failure, credential.Secret))
			o.bytes = redactEngineBytes(o.bytes, credential.Secret)
		}
		if !write(o.bytes) {
			return result
		}
		if o.done || o.failure != "" {
			return result
		}
	}
}
