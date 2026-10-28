package gateway

import (
	"context"
	"math"
	"testing"
)

func TestSQLiteTokenReservationCannotOverflow(t *testing.T) {
	s := testSQLiteStore(t)
	ctx := context.Background()
	channel := testStoredChannel("token-overflow")
	channel.Config.RateLimit.TokensPerMinute = 100
	if err := s.SaveChannel(ctx, channel); err != nil {
		t.Fatal(err)
	}
	if allowed, err := s.ReserveChannel(ctx, channel, 1); err != nil || !allowed {
		t.Fatalf("initial reservation = %v, %v", allowed, err)
	}
	if allowed, err := s.ReserveChannel(ctx, channel, math.MaxInt64); err != nil || allowed {
		t.Fatalf("overflow reservation = %v, %v", allowed, err)
	}
	if allowed, err := s.ReserveChannel(ctx, channel, 99); err != nil || !allowed {
		t.Fatalf("remaining quota = %v, %v", allowed, err)
	}
	if allowed, err := s.ReserveChannel(ctx, channel, 1); err != nil || allowed {
		t.Fatalf("exhausted quota = %v, %v", allowed, err)
	}
}
