package gateway

import (
	"context"
	"testing"
	"time"
)

func TestSQLiteLogFiltersAndPagination(t *testing.T) {
	s := testSQLiteStore(t)
	ctx := context.Background()
	for n, id := range []string{"first", "second", "third"} {
		channel, result, model := "a", "success", "model-a"
		if n == 1 {
			result = "error"
		}
		if n == 2 {
			channel, model = "b", "model-b"
		}
		log := RequestLog{ID: id, CreatedAt: time.Now().Add(time.Duration(n) * time.Second).UTC().Format(time.RFC3339Nano), ChannelID: &channel, Channel: "Channel " + channel, Model: model, Result: result, Source: "api"}
		if err := s.Record(ctx, log, nil); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		name, q, result, channel string
		limit, offset, total     int
		id                       string
	}{
		{name: "unfiltered page", limit: 1, offset: 1, total: 3, id: "second"},
		{name: "result", result: "error", total: 1, id: "second"},
		{name: "channel", channel: "b", total: 1, id: "third"},
		{name: "combined", result: "success", channel: "a", total: 1, id: "first"},
		{name: "search model", q: "MODEL-B", total: 1, id: "third"},
		{name: "search channel", q: "CHANNEL B", result: "success", channel: "b", total: 1, id: "third"},
		{name: "search id", q: "SECOND", total: 1, id: "second"},
		{name: "bound search", q: "' OR 1=1 --", total: 0},
		{name: "bound filter", channel: "' OR 1=1 --", total: 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			logs, total, err := s.Logs(ctx, tc.limit, tc.offset, tc.q, tc.result, tc.channel)
			if err != nil || total != tc.total {
				t.Fatalf("total = %d, error = %v; want %d", total, err, tc.total)
			}
			if tc.id == "" {
				if len(logs) != 0 {
					t.Fatalf("unexpected logs: %v", logs)
				}
			} else if len(logs) != 1 || logs[0].ID != tc.id {
				t.Fatalf("logs = %v, want %s", logs, tc.id)
			}
		})
	}
}
