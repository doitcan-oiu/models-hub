package gateway

import (
	"context"
	"encoding/json"
	"math"
	"sort"
	"time"
)

const analyticsGlobalSamples = 10000
const analyticsGroupSamples = 1024
const analyticsMaxGroups = 1000
const analyticsOtherGroup = "\x00other"

// Counts, sums and averages remain exact. Reservoirs bound percentile memory;
// callers receive an explicit flag whenever a percentile uses sampled values.
type analyticsSamples struct {
	count  int64
	sum    float64
	limit  int
	values []float64
}

func (s *analyticsSamples) add(value float64) {
	if value <= 0 || math.IsNaN(value) || math.IsInf(value, 0) {
		return
	}
	s.count++
	s.sum += value
	if s.limit == 0 {
		s.limit = analyticsGroupSamples
	}
	if len(s.values) < s.limit {
		s.values = append(s.values, value)
		return
	}
	// SplitMix64 gives reproducible uniform replacement without shared RNG locks.
	x := uint64(s.count) + 0x9e3779b97f4a7c15
	x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9
	x = (x ^ (x >> 27)) * 0x94d049bb133111eb
	x ^= x >> 31
	if index := x % uint64(s.count); index < uint64(s.limit) {
		s.values[index] = value
	}
}

func (s *analyticsSamples) stats() map[string]any {
	var average, p50, p95 any
	if s.count > 0 {
		average = s.sum / float64(s.count)
		sort.Float64s(s.values)
		percentile := func(fraction float64) float64 {
			index := float64(len(s.values)-1) * fraction
			lower, upper := int(math.Floor(index)), int(math.Ceil(index))
			return s.values[lower] + (s.values[upper]-s.values[lower])*(index-float64(lower))
		}
		p50, p95 = percentile(.5), percentile(.95)
	}
	return map[string]any{"average": average, "p50": p50, "p95": p95, "samples": float64(s.count)}
}

func (s *analyticsSamples) approximate() bool { return s.count > int64(s.limit) && s.limit > 0 }

type analyticsUsage struct {
	input, output int64
	cost          float64
}
type analyticsGeneration struct {
	output, seconds float64
	samples         int64
}

func (g *analyticsGeneration) speed() any {
	if g.seconds <= 0 {
		return nil
	}
	return g.output / g.seconds
}

type analyticsGroup struct {
	id, name, lastRequest               string
	requests, good, attempts, completed int64
	ttft, duration                      analyticsSamples
	usage                               analyticsUsage
	generation                          analyticsGeneration
}
type analyticsBucket struct {
	requests, good int64
	ttft, duration analyticsSamples
	usage          analyticsUsage
}
type portableAnalytics struct {
	rangeName, label                                          string
	hours, interval                                           int
	requests, good, retried, switched, streams, usageRequests int64
	priced, unpriced                                          int64
	ttft, duration                                            analyticsSamples
	usage                                                     analyticsUsage
	generation                                                analyticsGeneration
	models, channels                                          map[string]*analyticsGroup
	buckets                                                   map[int64]*analyticsBucket
	outcomes                                                  map[string]int64
	grouped                                                   bool
}

func newPortableAnalytics(selected string) *portableAnalytics {
	a := &portableAnalytics{rangeName: selected, hours: 24, interval: 60, label: "最近 24 小时", models: map[string]*analyticsGroup{}, channels: map[string]*analyticsGroup{}, buckets: map[int64]*analyticsBucket{}, outcomes: map[string]int64{"success": 0, "slow": 0, "failover": 0, "error": 0}}
	switch selected {
	case "1h":
		a.hours, a.interval, a.label = 1, 5, "最近 1 小时"
	case "7d":
		a.hours, a.interval, a.label = 168, 720, "最近 7 天"
	default:
		a.rangeName = "24h"
	}
	a.ttft.limit, a.duration.limit = analyticsGlobalSamples, analyticsGlobalSamples
	return a
}

func analyticsCompleted(result string, status int) bool {
	return (result == "success" || result == "slow" || result == "failover") && status >= 200 && status < 300
}
func analyticsRate(value, total int64) float64 {
	if total == 0 {
		return 0
	}
	return float64(value) / float64(total) * 100
}
func (a *portableAnalytics) group(groups map[string]*analyticsGroup, id, name, fallback string) *analyticsGroup {
	if group := groups[id]; group != nil {
		if id != analyticsOtherGroup && name != "" {
			group.name = name
		}
		return group
	}
	if len(groups) >= analyticsMaxGroups-1 {
		id, name, a.grouped = analyticsOtherGroup, fallback, true
	}
	if group := groups[id]; group != nil {
		return group
	}
	group := &analyticsGroup{id: id, name: name}
	groups[id] = group
	return group
}

// Requests are adjacent in the query, so only one request's final attempt and
// counters are retained. Per-channel lastRequest eliminates distinct-ID sets.
type analyticsRequest struct {
	log                         RequestLog
	model                       *analyticsGroup
	bucket                      *analyticsBucket
	tries                       int64
	firstChannel                string
	hasChannel, switched, usage bool
	final                       *Attempt
}

func (a *portableAnalytics) begin(log RequestLog) *analyticsRequest {
	r := &analyticsRequest{log: log, model: a.group(a.models, log.Model, log.Model, "其他模型")}
	a.requests++
	r.model.requests++
	good := analyticsCompleted(log.Result, log.Status)
	if log.Stream {
		a.streams++
	}
	if stamp, err := time.Parse(time.RFC3339Nano, log.CreatedAt); err == nil {
		bucket := stamp.Unix() / int64(a.interval*60) * int64(a.interval*60)
		r.bucket = a.buckets[bucket]
		if r.bucket == nil {
			r.bucket = &analyticsBucket{}
			a.buckets[bucket] = r.bucket
		}
		r.bucket.requests++
	}
	if good {
		a.good++
		r.model.good++
		a.duration.add(log.Duration)
		if log.Stream {
			a.ttft.add(log.TTFT)
		}
		if r.bucket != nil {
			r.bucket.good++
			r.bucket.duration.add(log.Duration)
			if log.Stream {
				r.bucket.ttft.add(log.TTFT)
			}
		}
		a.outcomes[log.Result]++
	} else {
		a.outcomes["error"]++
	}
	return r
}

func (a *portableAnalytics) attempt(r *analyticsRequest, attempt Attempt, channelJSON []byte) error {
	var current struct {
		Name   string `json:"name"`
		Config struct {
			Prices []ModelPrice `json:"prices"`
		} `json:"config"`
	}
	if len(channelJSON) > 0 {
		if err := json.Unmarshal(channelJSON, &current); err != nil {
			return err
		}
	}
	name := current.Name
	if name == "" {
		name = attempt.ChannelName
	}
	if name == "" {
		name = "已删除渠道"
	}
	group := a.group(a.channels, attempt.ChannelID, name, "其他渠道")
	group.attempts++
	r.tries++
	if group.requests == 0 || group.lastRequest != r.log.ID {
		group.requests++
		group.lastRequest = r.log.ID
	}
	if attempt.Result != "cancelled" {
		group.completed++
	}
	if analyticsCompleted(attempt.Result, attempt.Status) {
		group.good++
		group.duration.add(attempt.Duration)
		if attempt.Stream && attempt.TTFT != nil {
			group.ttft.add(*attempt.TTFT)
		}
	}
	if r.hasChannel && r.firstChannel != attempt.ChannelID {
		r.switched = true
	}
	if !r.hasChannel {
		r.hasChannel = true
		r.firstChannel = attempt.ChannelID
	}
	input, output := max(attempt.InputTokens, 0), max(attempt.OutputTokens, 0)
	if input+output > 0 {
		r.usage = true
	}
	cost, priced := 0.0, false
	for _, price := range current.Config.Prices {
		if price.Model == attempt.Model {
			if price.Input >= 0 && price.Output >= 0 && !math.IsNaN(price.Input) && !math.IsNaN(price.Output) && !math.IsInf(price.Input, 0) && !math.IsInf(price.Output, 0) {
				priced = true
				cost = (float64(input)*price.Input + float64(output)*price.Output) / 1e6
			}
			break
		}
	}
	if priced {
		a.priced += input + output
	} else {
		a.unpriced += input + output
	}
	for _, usage := range []*analyticsUsage{&a.usage, &r.model.usage, &group.usage} {
		usage.input += input
		usage.output += output
		usage.cost += cost
	}
	if r.bucket != nil {
		r.bucket.usage.input += input
		r.bucket.usage.output += output
	}
	if r.final == nil || laterAnalyticsAttempt(attempt, *r.final) {
		copy := attempt
		r.final = &copy
	}
	return nil
}

func laterAnalyticsAttempt(next, previous Attempt) bool {
	if next.Attempt != previous.Attempt {
		return next.Attempt > previous.Attempt
	}
	nextTime, _ := time.Parse(time.RFC3339Nano, next.StartedAt)
	previousTime, _ := time.Parse(time.RFC3339Nano, previous.StartedAt)
	if !nextTime.Equal(previousTime) {
		return nextTime.After(previousTime)
	}
	return next.ID > previous.ID
}

func (a *portableAnalytics) finish(r *analyticsRequest) {
	if r == nil {
		return
	}
	if r.log.Attempts > 1 || r.tries > 1 {
		a.retried++
	}
	if r.log.Result == "failover" || r.switched {
		a.switched++
	}
	if r.usage {
		a.usageRequests++
	}
	final := r.final
	if !analyticsCompleted(r.log.Result, r.log.Status) || final == nil || !analyticsCompleted(final.Result, final.Status) || !final.Stream || final.TTFT == nil || *final.TTFT <= 0 || final.Duration <= *final.TTFT || final.OutputTokens <= 0 {
		return
	}
	group := a.channels[final.ChannelID]
	if group == nil {
		group = a.channels[analyticsOtherGroup]
	}
	for _, generation := range []*analyticsGeneration{&a.generation, &group.generation} {
		generation.output += float64(final.OutputTokens)
		generation.seconds += final.Duration - *final.TTFT
		generation.samples++
	}
}

func (a *portableAnalytics) result() map[string]any {
	ttft, duration := a.ttft.stats(), a.duration.stats()
	average := ttft["average"]
	if average == nil {
		average = float64(0)
	}
	totals := map[string]any{"requests": float64(a.requests), "successRate": analyticsRate(a.good, a.requests), "averageTtft": average, "failovers": float64(a.switched), "inputTokens": float64(a.usage.input), "outputTokens": float64(a.usage.output), "cost": a.usage.cost}
	summary := map[string]any{"successfulRequests": float64(a.good), "failedRequests": float64(a.requests - a.good), "retriedRequests": float64(a.retried), "retryRate": analyticsRate(a.retried, a.requests), "switchedRequests": float64(a.switched), "switchRate": analyticsRate(a.switched, a.requests), "streamRequests": float64(a.streams), "throughput": float64(a.requests) / float64(a.hours*60), "ttft": ttft, "duration": duration, "generationSpeed": a.generation.speed(), "generationSamples": float64(a.generation.samples), "usageRequests": float64(a.usageRequests), "usageCoverage": analyticsRate(a.usageRequests, a.requests), "pricedTokens": float64(a.priced), "unpricedTokens": float64(a.unpriced)}
	approximate := a.ttft.approximate() || a.duration.approximate()
	timeline := []any{}
	times := make([]int64, 0, len(a.buckets))
	for stamp := range a.buckets {
		times = append(times, stamp)
	}
	sort.Slice(times, func(i, j int) bool { return times[i] < times[j] })
	if len(times) > 0 {
		for stamp := times[0]; stamp <= times[len(times)-1]; stamp += int64(a.interval * 60) {
			bucket := a.buckets[stamp]
			if bucket == nil {
				bucket = &analyticsBucket{}
			}
			first, completion := bucket.ttft.stats(), bucket.duration.stats()
			approximate = approximate || bucket.ttft.approximate() || bucket.duration.approximate()
			var successRate any
			if bucket.requests > 0 {
				successRate = analyticsRate(bucket.good, bucket.requests)
			}
			timeline = append(timeline, map[string]any{"time": time.Unix(stamp, 0).UTC().Format("2006-01-02T15:04:05.000Z"), "requests": float64(bucket.requests), "successRate": successRate, "throughput": float64(bucket.requests) / float64(a.interval), "ttftP50": first["p50"], "ttftP95": first["p95"], "durationAverage": completion["average"], "durationP95": completion["p95"], "inputTokens": float64(bucket.usage.input), "outputTokens": float64(bucket.usage.output)})
		}
	}
	modelGroups := make([]*analyticsGroup, 0, len(a.models))
	for _, group := range a.models {
		modelGroups = append(modelGroups, group)
	}
	sort.Slice(modelGroups, func(i, j int) bool {
		x, y := modelGroups[i], modelGroups[j]
		if x.usage.input+x.usage.output != y.usage.input+y.usage.output {
			return x.usage.input+x.usage.output > y.usage.input+y.usage.output
		}
		if x.requests != y.requests {
			return x.requests > y.requests
		}
		return x.name < y.name
	})
	models := []any{}
	for _, group := range modelGroups {
		models = append(models, map[string]any{"model": group.name, "requests": float64(group.requests), "successRate": analyticsRate(group.good, group.requests), "inputTokens": float64(group.usage.input), "outputTokens": float64(group.usage.output), "cost": group.usage.cost})
	}
	channelGroups := make([]*analyticsGroup, 0, len(a.channels))
	for _, group := range a.channels {
		channelGroups = append(channelGroups, group)
	}
	sort.Slice(channelGroups, func(i, j int) bool {
		if channelGroups[i].attempts != channelGroups[j].attempts {
			return channelGroups[i].attempts > channelGroups[j].attempts
		}
		return channelGroups[i].name < channelGroups[j].name
	})
	channels := []any{}
	for _, group := range channelGroups {
		approximate = approximate || group.ttft.approximate() || group.duration.approximate()
		channels = append(channels, map[string]any{"id": group.id, "name": group.name, "attempts": float64(group.attempts), "requests": float64(group.requests), "successRate": analyticsRate(group.good, group.completed), "ttft": group.ttft.stats(), "duration": group.duration.stats(), "generationSpeed": group.generation.speed(), "generationSamples": float64(group.generation.samples), "inputTokens": float64(group.usage.input), "outputTokens": float64(group.usage.output), "cost": group.usage.cost})
	}
	outcomes := []any{}
	for _, result := range []string{"success", "slow", "failover", "error"} {
		outcomes = append(outcomes, map[string]any{"result": result, "requests": float64(a.outcomes[result])})
	}
	return map[string]any{"range": a.rangeName, "rangeLabel": a.label, "intervalMinutes": float64(a.interval), "totals": totals, "summary": summary, "timeline": timeline, "models": models, "channels": channels, "outcomes": outcomes, "approximatePercentiles": approximate, "groupedRows": a.grouped}
}

func (h *Handler) dashboardPortable(ctx context.Context, selected string) (map[string]any, error) {
	a := newPortableAnalytics(selected)
	now := time.Now()
	rows, err := h.store.DB().QueryContext(ctx, `SELECT l.id,l.data,a.data,c.data FROM request_logs l
 LEFT JOIN attempts a ON a.request_id=l.id LEFT JOIN channels c ON c.id=a.channel_id
 WHERE l.created_at >= $1 AND l.created_at <= $2 AND l.source <> 'probe' ORDER BY l.id,a.id`, now.Add(-time.Duration(a.hours)*time.Hour), now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var request *analyticsRequest
	lastID := ""
	for rows.Next() {
		var id string
		var logJSON, attemptJSON, channelJSON []byte
		if err = rows.Scan(&id, &logJSON, &attemptJSON, &channelJSON); err != nil {
			return nil, err
		}
		if request == nil || id != lastID {
			a.finish(request)
			var log RequestLog
			if err = json.Unmarshal(logJSON, &log); err != nil {
				return nil, err
			}
			log.ID = id
			request = a.begin(log)
			lastID = id
		}
		if len(attemptJSON) > 0 {
			var attempt Attempt
			if err = json.Unmarshal(attemptJSON, &attempt); err != nil {
				return nil, err
			}
			if err = a.attempt(request, attempt, channelJSON); err != nil {
				return nil, err
			}
		}
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	a.finish(request)
	rows.Close()
	analytics := a.result()
	channels, err := h.store.Channels(ctx)
	if err != nil {
		return nil, err
	}
	events, err := h.store.Events(ctx)
	if err != nil {
		return nil, err
	}
	latency := []map[string]any{}
	for _, item := range analytics["timeline"].([]any) {
		point := item.(map[string]any)
		latency = append(latency, map[string]any{"time": point["time"], "primary": point["ttftP50"], "backup": point["ttftP95"], "requests": point["requests"]})
	}
	return map[string]any{"analytics": analytics, "totals": analytics["totals"], "latency": latency, "channels": channels, "events": events}, nil
}
