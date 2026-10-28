package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"pulsegate/internal/gateway"
)

func main() {
	if err := run(); err != nil {
		slog.Error("pulsegate stopped", "error", err)
		os.Exit(1)
	}
}
func run() error {
	initEnv := flag.Bool("init-env", false, "create .env with random credentials; never overwrites existing configuration")
	healthcheck := flag.Bool("healthcheck", false, "check local HTTP liveness (including installation mode) and exit")
	flag.Parse()
	if *initEnv {
		return generateEnv()
	}
	if err := loadEnv(); err != nil {
		return err
	}
	addr := env("LISTEN_ADDR", ":8787")
	if *healthcheck {
		host := "127.0.0.1:8787"
		if strings.HasPrefix(addr, ":") {
			host = "127.0.0.1" + addr
		} else {
			host = addr
		}
		client := http.Client{Timeout: 3 * time.Second}
		res, err := client.Get("http://" + host + "/health/live")
		if err != nil {
			return errors.New("liveness request failed")
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			return errors.New("service not live")
		}
		return nil
	}
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" && os.Getenv("POSTGRES_PASSWORD") != "" && os.Getenv("ADMIN_TOKEN") != "" && os.Getenv("ENCRYPTION_KEY") != "" {
		password := os.Getenv("POSTGRES_PASSWORD")
		u := &url.URL{Scheme: "postgres", User: url.UserPassword("pulsegate", password), Host: "127.0.0.1:5432", Path: "pulsegate", RawQuery: "sslmode=disable"}
		databaseURL = u.String()
	}
	dev, err := strconv.ParseBool(env("DEV_MODE", "false"))
	if err != nil {
		return errors.New("DEV_MODE must be true or false")
	}
	cfg := gateway.EngineConfig{DevMode: dev}
	if cfg.ChannelConcurrency, err = integer("CHANNEL_MAX_CONCURRENCY", 64, 1, 100000); err != nil {
		return err
	}
	if cfg.CircuitFailures, err = integer("CIRCUIT_FAILURE_THRESHOLD", 3, 1, 1000); err != nil {
		return err
	}
	if cfg.LogQueueSize, err = integer("LOG_QUEUE_SIZE", 4096, 1, 1000000); err != nil {
		return err
	}
	if cfg.LogWorkers, err = integer("LOG_WORKERS", 4, 1, 64); err != nil {
		return err
	}
	for name, target := range map[string]*time.Duration{"CONNECT_TIMEOUT": &cfg.ConnectTimeout, "RESPONSE_HEADER_TIMEOUT": &cfg.ResponseHeaderTimeout, "STREAM_IDLE_TIMEOUT": &cfg.StreamIdleTimeout, "STREAM_MAX_DURATION": &cfg.StreamMaxDuration, "REQUEST_TIMEOUT": &cfg.RequestTimeout, "DOWNSTREAM_WRITE_TIMEOUT": &cfg.DownstreamWriteTimeout, "CIRCUIT_COOLDOWN": &cfg.CircuitCooldown} {
		if value := os.Getenv(name); value != "" {
			d, e := time.ParseDuration(value)
			if e != nil || d <= 0 {
				return fmt.Errorf("%s must be a positive Go duration, for example 30s", name)
			}
			*target = d
		}
	}
	startup, cancelStartup := context.WithTimeout(context.Background(), 30*time.Second)
	application, err := gateway.NewApplication(startup, gateway.ApplicationConfig{DataDir: env("DATA_DIR", "data"), StaticDir: env("STATIC_DIR", "dist"), AdminToken: os.Getenv("ADMIN_TOKEN"), DatabaseURL: databaseURL, EncryptionKey: os.Getenv("ENCRYPTION_KEY"), PublicURL: os.Getenv("PUBLIC_URL"), DevMode: dev, Engine: cfg})
	// The application has its own process lifetime; a startup deadline must not
	// cancel maintenance after startup succeeds.
	cancelStartup()
	if err != nil {
		return err
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = application.Close(closeCtx)
	}()
	server := &http.Server{Addr: addr, Handler: application, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 64 << 10, BaseContext: nil}
	signals, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	failures := make(chan error, 1)
	go func() {
		slog.Info("pulsegate listening", "address", addr, "channel_concurrency", cfg.ChannelConcurrency)
		failures <- server.ListenAndServe()
	}()
	select {
	case <-signals.Done():
	case err = <-failures:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	shutdown, cancelShutdown := context.WithTimeout(context.Background(), 25*time.Second)
	err = server.Shutdown(shutdown)
	cancelShutdown()
	if err != nil {
		_ = server.Close()
	}
	drain, cancelDrain := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelDrain()
	return application.Close(drain)
}
func env(name, fallback string) string {
	if s := os.Getenv(name); s != "" {
		return s
	}
	return fallback
}
func integer(name string, fallback, low, high int) (int, error) {
	v := os.Getenv(name)
	if v == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < low || n > high {
		return 0, fmt.Errorf("%s must be an integer in [%d,%d]", name, low, high)
	}
	return n, nil
}
func loadEnv() error {
	data, err := os.ReadFile(".env")
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(strings.TrimPrefix(line, "\ufeff"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return errors.New("invalid .env entry")
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if len(value) >= 2 && ((value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'')) {
			value = value[1 : len(value)-1]
		}
		if _, exists := os.LookupEnv(key); !exists {
			if err = os.Setenv(key, value); err != nil {
				return err
			}
		}
	}
	return nil
}
func generateEnv() error {
	random := func(n int) []byte {
		b := make([]byte, n)
		if _, err := rand.Read(b); err != nil {
			panic(err)
		}
		return b
	}
	file, err := os.OpenFile(".env", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if errors.Is(err, os.ErrExist) {
		fmt.Println(".env already exists; existing credentials were preserved.")
		return nil
	}
	if err != nil {
		return err
	}
	_, err = io.WriteString(file, "# Open the web console after startup to choose a database and administrator password.\nPOSTGRES_PASSWORD="+hex.EncodeToString(random(24))+"\nMYSQL_PASSWORD="+hex.EncodeToString(random(24))+"\nPORT=8787\nPUBLIC_URL=\nDEV_MODE=false\n")
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	fmt.Println("Created .env with optional database service credentials. Start PulseGate and complete setup in the web console.")
	return nil
}
