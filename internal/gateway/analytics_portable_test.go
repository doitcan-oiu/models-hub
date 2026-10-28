package gateway

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"path/filepath"
	"testing"
	"time"
)

func TestPortableAnalyticsSQLiteFinalStreamGenerationAndBilling(t *testing.T) {
	s, err := NewStore(context.Background(), "sqlite:"+filepath.ToSlash(filepath.Join(t.TempDir(), "analytics.db")), base64.StdEncoding.EncodeToString(make([]byte, 32)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	ctx := context.Background()
	a, b := testStoredChannel("a"), testStoredChannel("b")
	a.Name = "Current A"
	a.Config.Prices = []ModelPrice{{Model: "physical", Input: 2, Output: 4}}
	for _, channel := range []Channel{a, b} {
		if err = s.SaveChannel(ctx, channel); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)
	ptr := func(value float64) *float64 { return &value }
	attempt := func(id, channel, result string, status, number int, stream bool, ttft *float64, duration float64, input, output int64) Attempt {
		return Attempt{ID: id, ChannelID: channel, ChannelName: "old " + channel, Model: "physical", Result: result, Status: status, Attempt: number, Stream: stream, TTFT: ttft, Duration: duration, InputTokens: input, OutputTokens: output, StartedAt: now}
	}
	record := func(id, result, source string, status, tries int, stream bool, ttft, duration float64, attempts []Attempt) {
		t.Helper()
		log := RequestLog{ID: id, CreatedAt: now, Model: "public", Result: result, Source: source, Status: status, Attempts: tries, Stream: stream, TTFT: ttft, Duration: duration}
		for idx := range attempts {
			attempts[idx].RequestID = id
		}
		if err = s.Record(ctx, log, attempts); err != nil {
			t.Fatal(err)
		}
	}
	record("one", "success", "api", 200, 1, true, 1, 100, []Attempt{attempt("one-a", "a", "success", 200, 1, true, ptr(1), 2, 10, 100), attempt("one-b", "b", "error", 503, 2, true, nil, 1, 5, 0), attempt("one-c", "b", "success", 200, 3, true, ptr(2), 4, 7, 20)})
	record("two", "success", "playground", 200, 1, false, 999, 5, []Attempt{attempt("two-a", "a", "cancelled", 499, 1, false, nil, .1, 0, 0), attempt("two-b", "a", "success", 200, 2, false, ptr(999), 5, 10, 10)})
	record("three", "success", "api", 503, 2, true, 999, 999, []Attempt{attempt("three-a", "a", "success", 200, 1, true, ptr(1), 2, 1, 99), attempt("three-b", "a", "error", 503, 2, true, nil, 1, 2, 0)})
	record("four", "error", "api", 503, 2, false, 0, 8, []Attempt{attempt("four-a", "a", "error", 503, 1, false, nil, 2, -1, -2), attempt("four-b", "b", "error", 503, 2, false, nil, 2, 0, 0)})
	record("five", "success", "api", 200, 1, true, 1, 4, []Attempt{attempt("five-a", "b", "success", 200, 1, true, ptr(1), 4, 3, 60)})
	record("probe", "success", "probe", 200, 1, true, .001, 1, []Attempt{attempt("probe-a", "a", "success", 200, 1, true, ptr(.001), 1, 99999, 99999)})
	now = time.Now().Add(-48 * time.Hour).UTC().Format(time.RFC3339Nano)
	record("old", "success", "api", 200, 1, true, .001, 1, []Attempt{attempt("old-a", "a", "success", 200, 1, true, ptr(.001), 1, 99999, 99999)})
	dashboard, err := (&Handler{store: s}).dashboard(ctx, "1h")
	if err != nil {
		t.Fatal(err)
	}
	analytics := dashboard["analytics"].(map[string]any)
	totals := analytics["totals"].(map[string]any)
	summary := analytics["summary"].(map[string]any)
	for key, want := range map[string]float64{"requests": 5, "successRate": 60, "failovers": 2, "inputTokens": 38, "outputTokens": 289, "cost": .000882} {
		analyticsNumber(t, totals, key, want)
	}
	for key, want := range map[string]float64{"generationSpeed": 16, "generationSamples": 2, "retriedRequests": 4, "switchRate": 40, "throughput": 5.0 / 60, "pricedTokens": 232, "unpricedTokens": 95, "usageCoverage": 80} {
		analyticsNumber(t, summary, key, want)
	}
	analyticsNumber(t, summary["ttft"].(map[string]any), "average", 1)
	analyticsNumber(t, summary["duration"].(map[string]any), "average", 109.0/3)
	if analytics["approximatePercentiles"] != false {
		t.Fatal("small data should use exact percentiles")
	}
	channels := map[string]map[string]any{}
	for _, raw := range analytics["channels"].([]any) {
		row := raw.(map[string]any)
		channels[row["id"].(string)] = row
	}
	if channels["a"]["generationSpeed"] != nil || channels["a"]["name"] != "Current A" {
		t.Fatalf("earlier success counted generation or stale name: %v", channels["a"])
	}
	analyticsNumber(t, channels["a"], "generationSamples", 0)
	analyticsNumber(t, channels["a"], "successRate", 60)
	analyticsNumber(t, channels["a"], "requests", 4)
	analyticsNumber(t, channels["b"], "generationSpeed", 16)
	timeline := analytics["timeline"].([]any)
	if len(timeline) != 1 {
		t.Fatalf("buckets: %v", timeline)
	}
	point := timeline[0].(map[string]any)
	analyticsNumber(t, point, "throughput", 1)
	analyticsNumber(t, point, "durationAverage", 109.0/3)
	if _, err = time.Parse(time.RFC3339Nano, point["time"].(string)); err != nil {
		t.Fatal(err)
	}
	analyticsNumber(t, analytics["models"].([]any)[0].(map[string]any), "cost", .000882)
}

func TestPortableAnalyticsEmptyTimelineAndQuantiles(t *testing.T) {
	a := newPortableAnalytics("invalid")
	empty := a.result()
	if empty["range"] != "24h" || len(empty["timeline"].([]any)) != 0 {
		t.Fatalf("unexpected empty analytics %v", empty)
	}
	summary := empty["summary"].(map[string]any)
	if summary["generationSpeed"] != nil || summary["ttft"].(map[string]any)["p50"] != nil {
		t.Fatal("empty measurements must be null")
	}
	a = newPortableAnalytics("1h")
	base := time.Now().UTC().Add(-25 * time.Minute).Truncate(5 * time.Minute)
	for n, offset := range []time.Duration{0, 15 * time.Minute} {
		r := a.begin(RequestLog{ID: fmt.Sprint(n), CreatedAt: base.Add(offset).Format(time.RFC3339Nano), Status: 200, Result: "success", Duration: float64(n*2 + 1)})
		a.finish(r)
	}
	result := a.result()
	timeline := result["timeline"].([]any)
	if len(timeline) != 4 {
		t.Fatalf("gap buckets %d", len(timeline))
	}
	for _, idx := range []int{1, 2} {
		point := timeline[idx].(map[string]any)
		if point["successRate"] != nil || point["durationAverage"] != nil {
			t.Fatalf("gap manufactures measurements %v", point)
		}
	}
	duration := result["summary"].(map[string]any)["duration"].(map[string]any)
	analyticsNumber(t, duration, "average", 2)
	analyticsNumber(t, duration, "p50", 2)
	analyticsNumber(t, duration, "p95", 2.9)
}

func TestPortableAnalyticsReservoirAndGroupsAreBounded(t *testing.T) {
	var samples analyticsSamples
	for _, value := range []float64{0, -1, math.NaN(), math.Inf(1)} {
		samples.add(value)
	}
	if samples.count != 0 {
		t.Fatal("invalid measurements entered distribution")
	}
	for n := 1; n <= 100000; n++ {
		samples.add(float64(n))
	}
	if len(samples.values) != analyticsGroupSamples || !samples.approximate() {
		t.Fatal("percentile memory is not bounded")
	}
	stats := samples.stats()
	analyticsNumber(t, stats, "samples", 100000)
	analyticsNumber(t, stats, "average", 50000.5)
	for _, key := range []string{"p50", "p95"} {
		if value := stats[key].(float64); value < 1 || value > 100000 {
			t.Fatalf("invalid percentile %v", value)
		}
	}
	a := newPortableAnalytics("1h")
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	for n := 0; n < analyticsMaxGroups+100; n++ {
		id := fmt.Sprint(n)
		r := a.begin(RequestLog{ID: id, Model: id, CreatedAt: stamp, Status: 200, Result: "success", Stream: true, TTFT: 1, Duration: 2})
		if err := a.attempt(r, Attempt{ID: id, ChannelID: id, Result: "success", Status: 200, InputTokens: 1}, nil); err != nil {
			t.Fatal(err)
		}
		a.finish(r)
	}
	result := a.result()
	if len(a.models) > analyticsMaxGroups || len(a.channels) > analyticsMaxGroups || result["groupedRows"] != true || result["approximatePercentiles"] != true {
		t.Fatalf("group/sample limits not reported")
	}
	totalRequests, totalTokens := 0.0, 0.0
	for _, raw := range result["models"].([]any) {
		row := raw.(map[string]any)
		totalRequests += row["requests"].(float64)
		totalTokens += row["inputTokens"].(float64)
	}
	if totalRequests != float64(analyticsMaxGroups+100) || totalTokens != totalRequests {
		t.Fatal("group overflow dropped requests or usage")
	}
}

func TestPortableAnalyticsFinalAttemptOrdering(t *testing.T) {
	a := newPortableAnalytics("1h")
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	ttft := 1.0
	r := a.begin(RequestLog{ID: "request", Model: "public", CreatedAt: stamp, Result: "success", Status: 200})
	// A later cancellation must prevent an earlier success contributing speed.
	for _, attempt := range []Attempt{{ID: "a", ChannelID: "channel", Attempt: 2, StartedAt: stamp, Result: "success", Status: 200, Stream: true, TTFT: &ttft, Duration: 2, OutputTokens: 20}, {ID: "z", ChannelID: "channel", Attempt: 2, StartedAt: stamp, Result: "cancelled", Status: 499}} {
		if err := a.attempt(r, attempt, json.RawMessage(`{"name":"Channel"}`)); err != nil {
			t.Fatal(err)
		}
	}
	a.finish(r)
	result := a.result()
	summary := result["summary"].(map[string]any)
	if summary["generationSpeed"] != nil {
		t.Fatal("earlier attempt incorrectly contributed generation")
	}
	analyticsNumber(t, summary, "retriedRequests", 1)
	analyticsNumber(t, result["channels"].([]any)[0].(map[string]any), "requests", 1)
}
