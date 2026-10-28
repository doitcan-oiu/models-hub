package gateway

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEngineProbeRejectsNonModelAndIncompleteResponses(t *testing.T) {
	for _, test := range []struct {
		name, protocol, contentType, body string
	}{
		{"html", "openai", "text/html", "<!doctype html><html>sign in</html>"},
		{"quota JSON", "anthropic", "application/json", `{"success":false,"message":"quota exhausted"}`},
		{"arbitrary JSON content", "openai", "application/json", `{"content":"sign in"}`},
		{"JSON string", "openai", "application/json", `"quota exhausted"`},
		{"malformed JSON", "openai", "application/json", `{"choices":`},
		{"empty Gemini JSON", "gemini", "application/json", `{"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}`},
		{"pending Responses JSON", "openai", "application/json", `{"object":"response","status":"queued","output":[]}`},
		{"malformed SSE data", "openai", "text/event-stream", "data: not model JSON\n\ndata: [DONE]\n\n"},
		{"malformed SSE after text", "openai", "text/event-stream", "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\ndata: not model JSON\n\ndata: [DONE]\n\n"},
		{"arbitrary SSE JSON", "openai", "text/event-stream", "data: {\"success\":false,\"message\":\"quota exhausted\"}\n\ndata: [DONE]\n\n"},
		{"empty OpenAI stream", "openai", "text/event-stream", "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\ndata: [DONE]\n\n"},
		{"empty Anthropic stream", "anthropic", "text/event-stream", "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"role\":\"assistant\",\"content\":[]}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"},
		{"empty Gemini stream", "gemini", "text/event-stream", "data: {\"candidates\":[{\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":1}}\n\n"},
		{"truncated OpenAI stream", "openai", "text/event-stream", "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n"},
		{"truncated Anthropic stream", "anthropic", "text/event-stream", "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}\n\n"},
		{"stream error after text", "openai", "text/event-stream", "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\nevent: error\ndata: {\"error\":{\"message\":\"quota exhausted\"}}\n\n"},
	} {
		for _, detectEmpty := range []bool{false, true} {
			name := test.name + "/empty-detection-off"
			if detectEmpty {
				name = test.name + "/empty-detection-on"
			}
			t.Run(name, func(t *testing.T) {
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", test.contentType)
					_, _ = io.WriteString(w, test.body)
				}))
				defer upstream.Close()
				c := testEngineChannel("a", upstream.URL, "test", 0)
				c.Config.Protocol = test.protocol
				settings := testEngineSettings()
				settings.EmptyResponseDetection = detectEmpty
				e := testEngine(t, &engineMemoryStore{channels: []Channel{c}, settings: settings}, EngineConfig{})
				if err := e.ProbeChannel(context.Background(), c, test.contentType == "text/event-stream"); err == nil {
					t.Fatal("probe accepted a response without complete model output")
				}
			})
		}
	}
}

func TestEngineProbeAcceptsNativeModelOutput(t *testing.T) {
	for _, test := range []struct {
		name, protocol, contentType, body string
	}{
		{"OpenAI text", "openai", "application/json", `{"choices":[{"message":{"content":"OK"}}]}`},
		{"OpenAI reasoning", "openai", "application/json", `{"choices":[{"message":{"reasoning_content":"thinking"}}]}`},
		{"OpenAI tool", "openai", "application/json", `{"choices":[{"message":{"tool_calls":[{"id":"call-1","type":"function","function":{"name":"lookup","arguments":"{}"}}]}}]}`},
		{"Anthropic text", "anthropic", "application/json", `{"type":"message","content":[{"type":"text","text":"OK"}]}`},
		{"Anthropic thinking", "anthropic", "application/json", `{"type":"message","content":[{"type":"thinking","thinking":"thinking"}]}`},
		{"Anthropic tool", "anthropic", "application/json", `{"type":"message","content":[{"type":"tool_use","id":"call-1","name":"lookup","input":{}}]}`},
		{"Gemini text", "gemini", "application/json", `{"candidates":[{"content":{"parts":[{"text":"OK"}]}}]}`},
		{"Gemini tool", "gemini", "application/json", `{"candidates":[{"content":{"parts":[{"functionCall":{"name":"lookup","args":{}}}]}}]}`},
		{"Responses text", "openai", "application/json", `{"object":"response","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"OK"}]}]}`},
		{"Responses reasoning", "openai", "application/json", `{"object":"response","status":"completed","output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"thinking"}]}]}`},
		{"Responses tool", "openai", "application/json", `{"object":"response","status":"completed","output":[{"type":"function_call","call_id":"call-1","name":"lookup","arguments":"{}"}]}`},
		{"OpenAI SSE", "openai", "text/event-stream", "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\ndata: [DONE]\n\n"},
		{"OpenAI finish reason without DONE", "openai", "text/event-stream", "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"},\"finish_reason\":\"stop\"}]}\n\n"},
		{"Anthropic SSE", "anthropic", "text/event-stream", "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"thinking\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"},
		{"Anthropic tool SSE", "anthropic", "text/event-stream", "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"content_block\":{\"type\":\"tool_use\",\"id\":\"call-1\",\"name\":\"lookup\",\"input\":{}}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"},
		{"Gemini native EOF", "gemini", "text/event-stream", "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"OK\"}]},\"finishReason\":\"STOP\"}]}\n\n"},
		{"Gemini tool SSE", "gemini", "text/event-stream", "data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"lookup\",\"args\":{}}}]},\"finishReason\":\"STOP\"}]}\n\n"},
		{"Responses SSE", "openai", "text/event-stream", "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[]}}\n\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", test.contentType)
				_, _ = io.WriteString(w, test.body)
			}))
			defer upstream.Close()
			c := testEngineChannel("a", upstream.URL, "test", 0)
			c.Config.Protocol = test.protocol
			e := testEngine(t, &engineMemoryStore{channels: []Channel{c}, settings: testEngineSettings()}, EngineConfig{})
			if err := e.ProbeChannel(context.Background(), c, test.contentType == "text/event-stream"); err != nil {
				t.Fatalf("valid native model response rejected: %v", err)
			}
		})
	}
}

func TestEnginePublicGatewayRetainsPermissiveResponseHandling(t *testing.T) {
	for _, test := range []struct{ name, contentType, body string }{
		{"arbitrary JSON", "application/json", `{"vendor_extension":true}`},
		{"empty SSE", "text/event-stream", "data: [DONE]\n\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", test.contentType)
				_, _ = io.WriteString(w, test.body)
			}))
			defer upstream.Close()
			c := testEngineChannel("a", upstream.URL, "test", 0)
			settings := testEngineSettings()
			settings.EmptyResponseDetection = false
			e := testEngine(t, &engineMemoryStore{channels: []Channel{c}, settings: settings}, EngineConfig{})
			rec := httptest.NewRecorder()
			e.ServeGateway(rec, testEngineRequest(context.Background(), "test", test.contentType == "text/event-stream"), nil, "", "api")
			if rec.Code != http.StatusOK {
				t.Fatalf("ordinary gateway compatibility changed: %d %s", rec.Code, rec.Body.String())
			}
		})
	}
}
