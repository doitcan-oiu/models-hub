package gateway

import (
	"context"
	"math"
	"testing"
	"time"
)

func analyticsNumber(t *testing.T, values map[string]any, key string, want float64) {
	t.Helper()
	got, ok := values[key].(float64)
	if !ok || math.Abs(got-want) > 1e-9 {
		t.Fatalf("%s = %v, want %v", key, values[key], want)
	}
}

func TestPostgresAnalyticsFinalStreamGenerationAndBilling(t *testing.T) {
	s := testPostgresStore(t)
	ctx := context.Background()
	a, b := testStoredChannel("a"), testStoredChannel("b")
	a.Name = "Current A"
	a.Config.Prices = []ModelPrice{{Model: "physical", Input: 2, Output: 4}}
	for _, channel := range []Channel{a, b} {
		if err := s.SaveChannel(ctx, channel); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)
	ptr := func(v float64) *float64 { return &v }
	makeAttempt := func(id, channel, result string, status, number int, stream bool, ttft *float64, duration float64, input, output int64) Attempt {
		return Attempt{ID: id, ChannelID: channel, ChannelName: "old " + channel, Model: "physical", Result: result, Status: status, Attempt: number, Stream: stream, TTFT: ttft, Duration: duration, InputTokens: input, OutputTokens: output, StartedAt: now}
	}
	record := func(id, result, source string, status, tries int, stream bool, ttft, duration float64, attempts []Attempt) {
		t.Helper()
		log := RequestLog{ID: id, CreatedAt: now, Model: "public", Result: result, Source: source, Status: status, Attempts: tries, Stream: stream, TTFT: ttft, Duration: duration}
		for idx := range attempts {
			attempts[idx].RequestID = id
		}
		if err := s.Record(ctx, log, attempts); err != nil {
			t.Fatal(err)
		}
	}
	// Earlier successes count toward billed usage but only the final successful
	// streaming response contributes generation speed: 20/(4-2), then 60/(4-1).
	record("one", "success", "api", 200, 1, true, 1, 100, []Attempt{makeAttempt("one-a", "a", "success", 200, 1, true, ptr(1), 2, 10, 100), makeAttempt("one-b", "b", "error", 503, 2, true, nil, 1, 5, 0), makeAttempt("one-c", "b", "success", 200, 3, true, ptr(2), 4, 7, 20)})
	record("two", "success", "playground", 200, 1, false, 999, 5, []Attempt{makeAttempt("two-a", "a", "cancelled", 499, 1, false, nil, .1, 0, 0), makeAttempt("two-b", "a", "success", 200, 2, false, ptr(999), 5, 10, 10)})
	// Inconsistent legacy result/status must be failed in every aggregate, even
	// when one of its earlier attempts completed successfully.
	record("three", "success", "api", 503, 2, true, 999, 999, []Attempt{makeAttempt("three-a", "a", "success", 200, 1, true, ptr(1), 2, 1, 99), makeAttempt("three-b", "a", "error", 503, 2, true, nil, 1, 2, 0)})
	record("four", "error", "api", 503, 2, false, 0, 8, []Attempt{makeAttempt("four-a", "a", "error", 503, 1, false, nil, 2, -1, -2), makeAttempt("four-b", "b", "error", 503, 2, false, nil, 2, 0, 0)})
	record("five", "success", "api", 200, 1, true, 1, 4, []Attempt{makeAttempt("five-a", "b", "success", 200, 1, true, ptr(1), 4, 3, 60)})
	record("probe", "success", "probe", 200, 1, true, .001, 1, []Attempt{makeAttempt("probe-a", "a", "success", 200, 1, true, ptr(.001), 1, 99999, 99999)})
	old := now
	now = time.Now().Add(-48 * time.Hour).UTC().Format(time.RFC3339Nano)
	record("old", "success", "api", 200, 1, true, .001, 1, []Attempt{makeAttempt("old-a", "a", "success", 200, 1, true, ptr(.001), 1, 99999, 99999)})
	now = old
	h := &Handler{store: s}
	dashboard, err := h.dashboard(ctx, "1h")
	if err != nil {
		t.Fatal(err)
	}
	analytics := dashboard["analytics"].(map[string]any)
	totals := analytics["totals"].(map[string]any)
	summary := analytics["summary"].(map[string]any)
	analyticsNumber(t, totals, "requests", 5)
	analyticsNumber(t, totals, "successRate", 60)
	analyticsNumber(t, totals, "failovers", 2)
	analyticsNumber(t, totals, "inputTokens", 38)
	analyticsNumber(t, totals, "outputTokens", 289)
	analyticsNumber(t, totals, "cost", .000882)
	analyticsNumber(t, summary, "generationSpeed", 16)
	analyticsNumber(t, summary, "generationSamples", 2)
	analyticsNumber(t, summary, "retriedRequests", 4)
	analyticsNumber(t, summary, "switchRate", 40)
	analyticsNumber(t, summary, "throughput", 5.0/60)
	analyticsNumber(t, summary, "pricedTokens", 232)
	analyticsNumber(t, summary, "unpricedTokens", 95)
	analyticsNumber(t, summary, "usageCoverage", 80)
	analyticsNumber(t, summary["ttft"].(map[string]any), "average", 1)
	analyticsNumber(t, summary["duration"].(map[string]any), "average", 109.0/3)
	rows := map[string]map[string]any{}
	for _, raw := range analytics["channels"].([]any) {
		row := raw.(map[string]any)
		rows[row["id"].(string)] = row
	}
	if rows["a"]["generationSpeed"] != nil || rows["a"]["name"] != "Current A" {
		t.Fatalf("earlier success counted generation or stale channel name: %v", rows["a"])
	}
	analyticsNumber(t, rows["a"], "generationSamples", 0)
	analyticsNumber(t, rows["a"], "successRate", 60)
	analyticsNumber(t, rows["a"]["ttft"].(map[string]any), "samples", 2)
	analyticsNumber(t, rows["b"], "generationSpeed", 16)
	analyticsNumber(t, rows["b"], "generationSamples", 2)
	timeline := analytics["timeline"].([]any)
	if len(timeline) != 1 {
		t.Fatalf("unexpected buckets: %v", timeline)
	}
	point := timeline[0].(map[string]any)
	analyticsNumber(t, point, "successRate", 60)
	analyticsNumber(t, point, "durationAverage", 109.0/3)
	analyticsNumber(t, point, "throughput", 1)
	if _, err = time.Parse(time.RFC3339Nano, point["time"].(string)); err != nil {
		t.Fatalf("chart timestamp is not ISO: %v", point["time"])
	}
	model := analytics["models"].([]any)[0].(map[string]any)
	analyticsNumber(t, model, "successRate", 60)
	analyticsNumber(t, model, "cost", .000882)
	for _, raw := range analytics["outcomes"].([]any) {
		row := raw.(map[string]any)
		if row["result"] == "error" {
			analyticsNumber(t, row, "requests", 2)
		}
	}
}

func TestPostgresAnalyticsEmptyAndTimelineGaps(t *testing.T) {
	s := testPostgresStore(t)
	h := &Handler{store: s}
	ctx := context.Background()
	empty, err := h.dashboard(ctx, "1h")
	if err != nil {
		t.Fatal(err)
	}
	analytics := empty["analytics"].(map[string]any)
	summary := analytics["summary"].(map[string]any)
	if summary["generationSpeed"] != nil || len(analytics["timeline"].([]any)) != 0 {
		t.Fatal("empty analytics manufactures latency or chart points")
	}
	analyticsNumber(t, summary, "generationSamples", 0)
	base := time.Now().Add(-25 * time.Minute).Truncate(5 * time.Minute)
	for n, offset := range []time.Duration{0, 15 * time.Minute} {
		log := RequestLog{ID: []string{"first", "last"}[n], CreatedAt: base.Add(offset).UTC().Format(time.RFC3339Nano), Status: 200, Result: "success", Source: "api", Duration: 1}
		if err = s.Record(ctx, log, nil); err != nil {
			t.Fatal(err)
		}
	}
	result, err := h.dashboard(ctx, "1h")
	if err != nil {
		t.Fatal(err)
	}
	timeline := result["analytics"].(map[string]any)["timeline"].([]any)
	if len(timeline) != 4 {
		t.Fatalf("gap buckets = %d", len(timeline))
	}
	for _, idx := range []int{1, 2} {
		point := timeline[idx].(map[string]any)
		analyticsNumber(t, point, "requests", 0)
		if point["successRate"] != nil || point["durationAverage"] != nil {
			t.Fatalf("empty bucket has fabricated measurements: %v", point)
		}
	}
}
