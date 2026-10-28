package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"time"

	"pulsegate/internal/gateway"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Import failed:", err)
		os.Exit(1)
	}
}
func run() error {
	input := flag.String("input", "", "JSON snapshot produced by scripts/export-d1.py")
	timeout := flag.Duration("timeout", 10*time.Minute, "overall import timeout")
	flag.Parse()
	if *input == "" {
		return fmt.Errorf("-input is required")
	}
	file, err := os.Open(*input)
	if err != nil {
		return err
	}
	defer file.Close()
	snapshot, err := gateway.ReadD1Snapshot(file)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, *timeout)
	defer cancel()
	store, err := gateway.OpenConfiguredStore(ctx, os.Getenv("DATA_DIR"))
	if errors.Is(err, os.ErrNotExist) {
		if os.Getenv("DATABASE_URL") == "" || os.Getenv("ENCRYPTION_KEY") == "" {
			return fmt.Errorf("complete browser setup first, or provide legacy DATABASE_URL and ENCRYPTION_KEY")
		}
		store, err = gateway.NewStore(ctx, os.Getenv("DATABASE_URL"), os.Getenv("ENCRYPTION_KEY"))
	}
	if err != nil {
		return err
	}
	defer store.Close()
	sourceKey := os.Getenv("SOURCE_ENCRYPTION_KEY")
	if sourceKey == "" {
		sourceKey = os.Getenv("ENCRYPTION_KEY")
	}
	result, err := store.ImportD1WithSourceKey(ctx, snapshot, sourceKey)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}
