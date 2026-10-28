package gateway

import (
	"net"
	"sync"
	"time"
)

const (
	loginAttemptLimit   = 10
	loginAttemptWindow  = time.Minute
	loginTrackedClients = 4096
)

type loginAttempt struct {
	started time.Time
	count   int
}

// Bound both repeated credential guessing and the memory used by its counters.
// RemoteAddr is supplied by the server; forwarded headers are not trusted.
type loginLimiter struct {
	mu          sync.Mutex
	clients     map[string]loginAttempt
	nextCleanup time.Time
}

func loginClient(address string) string {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		host = address
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.String()
	}
	return host
}

func (l *loginLimiter) allow(address string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.clients == nil {
		l.clients = make(map[string]loginAttempt)
	}
	if !now.Before(l.nextCleanup) {
		for client, attempt := range l.clients {
			if now.Sub(attempt.started) >= loginAttemptWindow {
				delete(l.clients, client)
			}
		}
		l.nextCleanup = now.Add(loginAttemptWindow)
	}
	client := loginClient(address)
	attempt, exists := l.clients[client]
	if !exists || now.Sub(attempt.started) >= loginAttemptWindow {
		if !exists && len(l.clients) >= loginTrackedClients {
			return false
		}
		attempt = loginAttempt{started: now}
	}
	if attempt.count >= loginAttemptLimit {
		return false
	}
	attempt.count++
	l.clients[client] = attempt
	return true
}

func (l *loginLimiter) forget(address string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.clients, loginClient(address))
}
