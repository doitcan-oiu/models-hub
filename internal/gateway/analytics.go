package gateway

import (
	"context"
	"encoding/json"
	"time"
)

// One PostgreSQL snapshot provides every aggregate. Only grouped chart rows
// enter Go's heap; inference requests never share an analytics mutex.
func (h *Handler) dashboard(ctx context.Context, selected string) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if h.store.DB().Dialect() != "postgres" {
		return h.dashboardPortable(ctx, selected)
	}
	hours, interval, label := 24, 60, "最近 24 小时"
	switch selected {
	case "1h":
		hours, interval, label = 1, 5, "最近 1 小时"
	case "7d":
		hours, interval, label = 168, 720, "最近 7 天"
	default:
		selected = "24h"
	}
	var raw []byte
	err := h.store.DB().QueryRowContext(ctx, dashboardSQL, time.Now().Add(-time.Duration(hours)*time.Hour), interval*60, hours*60).Scan(&raw)
	if err != nil {
		return nil, err
	}
	analytics := map[string]any{}
	if err = json.Unmarshal(raw, &analytics); err != nil {
		return nil, err
	}
	analytics["range"], analytics["rangeLabel"], analytics["intervalMinutes"] = selected, label, interval
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

const dashboardSQL = `WITH logs AS MATERIALIZED (
 SELECT l.*, result IN ('success','slow','failover') AND (data->>'status')::int BETWEEN 200 AND 299 AS good,
 (data->>'ttft')::float8 AS ttft, (data->>'duration')::float8 AS duration,
 COALESCE((data->>'stream')::boolean,false) AS stream, COALESCE((data->>'attempts')::int,0) AS tries,
 floor(extract(epoch FROM created_at)/$2::bigint)::bigint * $2::bigint AS bucket
 FROM request_logs l WHERE created_at >= $1 AND source <> 'probe'
), attempt_values AS (
 SELECT a.*, l.model AS client_model,
 GREATEST(COALESCE((a.data->>'inputTokens')::bigint,0),0) AS input,
 GREATEST(COALESCE((a.data->>'outputTokens')::bigint,0),0) AS output,
 COALESCE((a.data->>'stream')::boolean,false) AS stream,
 (a.data->>'ttft')::float8 AS ttft,(a.data->>'duration')::float8 AS duration,
 COALESCE((a.data->>'attempt')::int,0) AS attempt_number,
 a.data->>'result' IN ('success','slow','failover') AND (a.data->>'status')::int BETWEEN 200 AND 299 AS good,
 c.data->>'name' AS current_name, price.value AS price
 FROM attempts a JOIN logs l ON l.id=a.request_id LEFT JOIN channels c ON c.id=a.channel_id
 LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(COALESCE(NULLIF(c.data->'config'->'prices','null'::jsonb),'[]'::jsonb))
 WHERE value->>'model'=a.data->>'model' LIMIT 1) price ON true
), use AS MATERIALIZED (
 SELECT *, (price IS NOT NULL AND (price->>'input')::float8>=0 AND (price->>'output')::float8>=0) AS priced,
 CASE WHEN price IS NOT NULL AND (price->>'input')::float8>=0 AND (price->>'output')::float8>=0
 THEN (input*(price->>'input')::float8+output*(price->>'output')::float8)/1000000 ELSE 0 END AS cost
 FROM attempt_values
), request_attempts AS (
 SELECT request_id,count(*) AS attempts,count(DISTINCT channel_id) AS channels,
 sum(input) AS input,sum(output) AS output FROM use GROUP BY request_id
), final_attempts AS (
 SELECT DISTINCT ON(request_id) * FROM use ORDER BY request_id,attempt_number DESC,started_at DESC,id DESC
), generated AS (
 SELECT a.channel_id,a.output,a.duration-a.ttft AS seconds FROM final_attempts a JOIN logs l ON l.id=a.request_id
 WHERE l.good AND a.good AND a.stream AND a.ttft>0 AND a.duration>a.ttft AND a.output>0
), generation AS (
 SELECT sum(output)::float8/NULLIF(sum(seconds),0) AS speed,count(*) AS samples FROM generated
), stats AS (
 SELECT count(*) AS requests,count(*) FILTER(WHERE l.good) AS success,
 count(*) FILTER(WHERE l.result='failover' OR r.channels>1) AS switches,
 count(*) FILTER(WHERE l.tries>1 OR r.attempts>1) AS retries,count(*) FILTER(WHERE l.stream) AS streams,
 avg(ttft) FILTER(WHERE good AND stream AND ttft>0) AS ttft_avg,
 percentile_cont(.5) WITHIN GROUP(ORDER BY ttft) FILTER(WHERE good AND stream AND ttft>0) AS ttft_p50,
 percentile_cont(.95) WITHIN GROUP(ORDER BY ttft) FILTER(WHERE good AND stream AND ttft>0) AS ttft_p95,
 count(*) FILTER(WHERE good AND stream AND ttft>0) AS ttft_n,
 avg(duration) FILTER(WHERE good AND duration>0) AS dur_avg,
 percentile_cont(.5) WITHIN GROUP(ORDER BY duration) FILTER(WHERE good AND duration>0) AS dur_p50,
 percentile_cont(.95) WITHIN GROUP(ORDER BY duration) FILTER(WHERE good AND duration>0) AS dur_p95,
 count(*) FILTER(WHERE good AND duration>0) AS dur_n FROM logs l LEFT JOIN request_attempts r ON r.request_id=l.id
), usage AS (
 SELECT COALESCE(sum(input),0) AS input,COALESCE(sum(output),0) AS output,COALESCE(sum(cost),0) AS cost,
 COALESCE(sum(input+output) FILTER(WHERE priced),0) AS priced,COALESCE(sum(input+output) FILTER(WHERE NOT COALESCE(priced,false)),0) AS unpriced,
 count(DISTINCT request_id) FILTER(WHERE input+output>0) AS coverage FROM use
), totals AS (
 SELECT jsonb_build_object('requests',requests,'successRate',100.0*success/GREATEST(requests,1),
 'averageTtft',COALESCE(ttft_avg,0),'failovers',switches,'inputTokens',u.input,'outputTokens',u.output,'cost',u.cost) AS value
 FROM stats CROSS JOIN usage u
), summary AS (
 SELECT jsonb_build_object('successfulRequests',success,'failedRequests',requests-success,
 'retriedRequests',retries,'retryRate',100.0*retries/GREATEST(requests,1),'switchedRequests',switches,'switchRate',100.0*switches/GREATEST(requests,1),
 'streamRequests',streams,'throughput',requests::float8/$3::float8,
 'ttft',jsonb_build_object('average',ttft_avg,'p50',ttft_p50,'p95',ttft_p95,'samples',ttft_n),
 'duration',jsonb_build_object('average',dur_avg,'p50',dur_p50,'p95',dur_p95,'samples',dur_n),
 'generationSpeed',g.speed,'generationSamples',g.samples,'usageRequests',u.coverage,'usageCoverage',100.0*u.coverage/GREATEST(requests,1),
 'pricedTokens',u.priced,'unpricedTokens',u.unpriced) AS value FROM stats CROSS JOIN usage u CROSS JOIN generation g
), timeline_stats AS (
 SELECT l.bucket,count(*) AS requests,100.0*count(*) FILTER(WHERE good)/count(*) AS success_rate,
 percentile_cont(.5) WITHIN GROUP(ORDER BY ttft) FILTER(WHERE good AND stream AND ttft>0) AS ttft_p50,
 percentile_cont(.95) WITHIN GROUP(ORDER BY ttft) FILTER(WHERE good AND stream AND ttft>0) AS ttft_p95,
 avg(duration) FILTER(WHERE good AND duration>0) AS dur_avg,
 percentile_cont(.95) WITHIN GROUP(ORDER BY duration) FILTER(WHERE good AND duration>0) AS dur_p95,
 COALESCE(sum(r.input),0) AS input,COALESCE(sum(r.output),0) AS output
 FROM logs l LEFT JOIN request_attempts r ON r.request_id=l.id GROUP BY l.bucket
), timeline AS (
 SELECT b.bucket,jsonb_build_object('time',to_char(to_timestamp(b.bucket) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'requests',COALESCE(t.requests,0),'successRate',t.success_rate,'throughput',COALESCE(t.requests,0)::float8/($2::float8/60),
 'ttftP50',t.ttft_p50,'ttftP95',t.ttft_p95,'durationAverage',t.dur_avg,'durationP95',t.dur_p95,
 'inputTokens',COALESCE(t.input,0),'outputTokens',COALESCE(t.output,0)) AS value
 FROM generate_series((SELECT min(bucket) FROM logs),(SELECT max(bucket) FROM logs),$2::bigint) b(bucket)
 LEFT JOIN timeline_stats t ON t.bucket=b.bucket
), model_usage AS (
 SELECT client_model,sum(input) AS input,sum(output) AS output,sum(cost) AS cost FROM use GROUP BY client_model
), models AS (
 SELECT l.model,count(*) AS requests,COALESCE(max(u.input),0)+COALESCE(max(u.output),0) AS tokens,
 jsonb_build_object('model',l.model,'requests',count(*),'successRate',100.0*count(*) FILTER(WHERE good)/count(*),
 'inputTokens',COALESCE(max(u.input),0),'outputTokens',COALESCE(max(u.output),0),'cost',COALESCE(max(u.cost),0)) AS value
 FROM logs l LEFT JOIN model_usage u ON u.client_model=l.model GROUP BY l.model
), channel_generation AS (
 SELECT channel_id,sum(output)::float8/NULLIF(sum(seconds),0) AS speed,count(*) AS samples FROM generated GROUP BY channel_id
), channel_rows AS (
 SELECT u.channel_id,count(*) AS attempts,COALESCE(max(current_name),max(data->>'channelName'),'已删除渠道') AS name,
 jsonb_build_object('id',u.channel_id,'name',COALESCE(max(current_name),max(data->>'channelName'),'已删除渠道'),
 'attempts',count(*),'requests',count(DISTINCT request_id),'successRate',100.0*count(*) FILTER(WHERE good)/GREATEST(count(*) FILTER(WHERE data->>'result'<>'cancelled'),1),
 'ttft',jsonb_build_object('average',avg(ttft) FILTER(WHERE good AND stream AND ttft>0),
 'p50',percentile_cont(.5) WITHIN GROUP(ORDER BY ttft) FILTER(WHERE good AND stream AND ttft>0),
 'p95',percentile_cont(.95) WITHIN GROUP(ORDER BY ttft) FILTER(WHERE good AND stream AND ttft>0),
 'samples',count(*) FILTER(WHERE good AND stream AND ttft>0)),
 'duration',jsonb_build_object('average',avg(duration) FILTER(WHERE good AND duration>0),
 'p50',percentile_cont(.5) WITHIN GROUP(ORDER BY duration) FILTER(WHERE good AND duration>0),
 'p95',percentile_cont(.95) WITHIN GROUP(ORDER BY duration) FILTER(WHERE good AND duration>0),
 'samples',count(*) FILTER(WHERE good AND duration>0)),
 'generationSpeed',max(g.speed),'generationSamples',COALESCE(max(g.samples),0),
 'inputTokens',sum(input),'outputTokens',sum(output),'cost',sum(cost)) AS value
 FROM use u LEFT JOIN channel_generation g ON g.channel_id=u.channel_id GROUP BY u.channel_id
), outcomes AS (
 SELECT o.result,o.position,jsonb_build_object('result',o.result,'requests',count(l.id)) AS value
 FROM (VALUES('success',1),('slow',2),('failover',3),('error',4)) o(result,position)
 LEFT JOIN logs l ON CASE WHEN l.good THEN l.result ELSE 'error' END=o.result GROUP BY o.result,o.position
)
SELECT jsonb_build_object('totals',(SELECT value FROM totals),'summary',(SELECT value FROM summary),
 'timeline',COALESCE((SELECT jsonb_agg(value ORDER BY bucket) FROM timeline),'[]'::jsonb),
 'models',COALESCE((SELECT jsonb_agg(value ORDER BY tokens DESC,requests DESC,model) FROM models),'[]'::jsonb),
 'channels',COALESCE((SELECT jsonb_agg(value ORDER BY attempts DESC,name) FROM channel_rows),'[]'::jsonb),
 'outcomes',(SELECT jsonb_agg(value ORDER BY position) FROM outcomes))`
