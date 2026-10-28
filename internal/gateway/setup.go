package gateway

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

// ApplicationConfig contains deployment settings. A completed setup in DataDir
// takes precedence over legacy database and authentication environment settings.
type ApplicationConfig struct {
	DataDir, StaticDir, PublicURL          string
	DatabaseURL, AdminToken, EncryptionKey string
	DevMode                                bool
	Engine                                 EngineConfig
}

type DatabaseConfiguration struct {
	Type     string `json:"type"`
	Path     string `json:"path,omitempty"`
	Host     string `json:"host,omitempty"`
	Port     int    `json:"port,omitempty"`
	Name     string `json:"name,omitempty"`
	User     string `json:"user,omitempty"`
	Password string `json:"password,omitempty"`
	SSLMode  string `json:"sslMode,omitempty"`
}

type savedConfiguration struct {
	Version           int                   `json:"version"`
	AdminPasswordHash string                `json:"adminPasswordHash"`
	SessionSecret     string                `json:"sessionSecret"`
	EncryptionKey     string                `json:"encryptionKey"`
	PublicURL         string                `json:"publicUrl,omitempty"`
	Database          DatabaseConfiguration `json:"database"`
}

type setupRequest struct {
	AdminPassword   string                `json:"adminPassword"`
	ConfirmPassword string                `json:"confirmPassword"`
	PublicURL       string                `json:"publicUrl"`
	Database        DatabaseConfiguration `json:"database"`
}

type applicationRuntime struct {
	handler      *Handler
	store        *Store
	engine       *Engine
	integrations *Integrations
	cancel       context.CancelFunc
	done         chan struct{}
}

// Application serves the installation page before a database exists and swaps
// in the configured gateway only after initialization and durable configuration
// persistence have both succeeded.
type Application struct {
	config     ApplicationConfig
	ctx        context.Context
	cancel     context.CancelFunc
	runtime    atomic.Pointer[applicationRuntime]
	setupMu    sync.Mutex
	closed     bool
	configPath string
	static     *Handler
}

func NewApplication(ctx context.Context, cfg ApplicationConfig) (*Application, error) {
	if cfg.DataDir == "" {
		cfg.DataDir = "data"
	}
	if cfg.StaticDir == "" {
		cfg.StaticDir = "dist"
	}
	publicURL, err := normalizeHTTPOrigin(cfg.PublicURL)
	if err != nil {
		return nil, errors.New("PUBLIC_URL must be an HTTP/HTTPS origin")
	}
	cfg.PublicURL = publicURL
	// ctx bounds startup only. Application.Close owns the process lifetime.
	lifetime, cancel := context.WithCancel(context.WithoutCancel(ctx))
	a := &Application{config: cfg, ctx: lifetime, cancel: cancel, configPath: filepath.Join(cfg.DataDir, "config.json")}
	a.static = NewHandler(nil, nil, nil, HTTPConfig{StaticDir: cfg.StaticDir, PublicURL: cfg.PublicURL, DevMode: cfg.DevMode})
	content, err := os.ReadFile(a.configPath)
	if err == nil {
		var saved savedConfiguration
		if len(content) > 1<<20 || json.Unmarshal(content, &saved) != nil || !validSavedConfiguration(saved) {
			cancel()
			return nil, errors.New("saved configuration is invalid; restore or repair data/config.json; initialization remains locked")
		}
		saved.PublicURL, _ = normalizeHTTPOrigin(saved.PublicURL)
		database, dsn, err := normalizeDatabase(saved.Database, cfg.DataDir)
		if err != nil {
			cancel()
			return nil, errors.New("saved database configuration is invalid; initialization remains locked")
		}
		saved.Database = database
		publicURL := saved.PublicURL
		if cfg.PublicURL != "" {
			publicURL = cfg.PublicURL
		}
		runtime, err := a.createRuntime(ctx, dsn, saved.EncryptionKey, HTTPConfig{AdminPasswordHash: saved.AdminPasswordHash, SessionSecret: saved.SessionSecret, PublicURL: publicURL, DatabaseType: database.Type})
		if err != nil {
			cancel()
			return nil, errors.New("configured database could not be opened; check its availability and saved settings; initialization remains locked")
		}
		a.activate(runtime)
		return a, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		cancel()
		return nil, errors.New("saved configuration cannot be read; initialization remains locked")
	}
	legacy := cfg.DatabaseURL != "" || cfg.AdminToken != "" || cfg.EncryptionKey != ""
	if legacy {
		if cfg.DatabaseURL == "" || len(cfg.AdminToken) < 24 || cfg.EncryptionKey == "" {
			cancel()
			return nil, errors.New("legacy deployment requires DATABASE_URL, ADMIN_TOKEN (at least 24 characters), and ENCRYPTION_KEY together")
		}
		runtime, err := a.createRuntime(ctx, cfg.DatabaseURL, cfg.EncryptionKey, HTTPConfig{AdminToken: cfg.AdminToken, PublicURL: cfg.PublicURL, DatabaseType: DatabaseType(cfg.DatabaseURL)})
		if err != nil {
			cancel()
			return nil, errors.New("legacy database could not be opened; check database availability, DATABASE_URL and ENCRYPTION_KEY")
		}
		a.activate(runtime)
	}
	return a, nil
}

func validSavedConfiguration(saved savedConfiguration) bool {
	if saved.Version != 1 || len(saved.SessionSecret) < 32 || validatePublicURL(saved.PublicURL) != nil {
		return false
	}
	cost, err := bcrypt.Cost([]byte(saved.AdminPasswordHash))
	if err != nil || cost < bcrypt.DefaultCost || cost > 16 {
		return false
	}
	key, err := base64.StdEncoding.DecodeString(saved.EncryptionKey)
	return err == nil && len(key) == 32
}

// OpenConfiguredStore opens the database and encryption key from a completed
// browser setup for offline maintenance commands. A missing configuration is
// reported as os.ErrNotExist so callers can retain explicit legacy env support.
func OpenConfiguredStore(ctx context.Context, dataDir string) (*Store, error) {
	if dataDir == "" {
		dataDir = "data"
	}
	content, err := os.ReadFile(filepath.Join(dataDir, "config.json"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, os.ErrNotExist
		}
		return nil, errors.New("saved configuration cannot be read")
	}
	var saved savedConfiguration
	if len(content) > 1<<20 || json.Unmarshal(content, &saved) != nil || !validSavedConfiguration(saved) {
		return nil, errors.New("saved configuration is invalid")
	}
	_, dsn, err := normalizeDatabase(saved.Database, dataDir)
	if err != nil {
		return nil, errors.New("saved database configuration is invalid")
	}
	store, err := NewStore(ctx, dsn, saved.EncryptionKey)
	if err != nil {
		return nil, errors.New("configured database could not be opened; check its availability and saved settings")
	}
	return store, nil
}

func validatePublicURL(value string) error {
	_, err := normalizeHTTPOrigin(value)
	return err
}

func normalizeHTTPOrigin(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || strings.Contains(value, "#") || (u.Path != "" && u.Path != "/") || (u.Scheme != "http" && u.Scheme != "https") || strings.HasSuffix(u.Host, ":") {
		return "", bad("公开访问地址须为 HTTP/HTTPS 来源地址，例如 https://gateway.example.com")
	}
	host, port := strings.ToLower(u.Hostname()), u.Port()
	if port != "" {
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return "", bad("公开访问地址端口无效")
		}
		port = strconv.Itoa(number)
		if u.Scheme == "http" && number == 80 || u.Scheme == "https" && number == 443 {
			port = ""
		}
	}
	if port != "" {
		host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return u.Scheme + "://" + host, nil
}

// During installation no trusted public URL may exist yet. TLS terminates at
// many reverse proxies, so the browser's HTTP(S) scheme may differ from r.TLS;
// require its host and port to match the preserved Host header instead.
func (a *Application) setupOrigin(r *http.Request) error {
	origin := r.Header.Get("Origin")
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || origin != u.Scheme+"://"+u.Host {
		return &HTTPError{403, "Invalid Origin"}
	}
	actual, err := normalizeHTTPOrigin(origin)
	if err != nil {
		return &HTTPError{403, "Invalid Origin"}
	}
	expected := a.config.PublicURL
	if expected == "" {
		expected = u.Scheme + "://" + r.Host
	}
	expected, err = normalizeHTTPOrigin(expected)
	if err != nil || actual != expected {
		return &HTTPError{403, "Cross-origin mutation denied"}
	}
	return nil
}

func normalizeDatabase(db DatabaseConfiguration, dataDir string) (DatabaseConfiguration, string, error) {
	db.Type = strings.ToLower(strings.TrimSpace(db.Type))
	switch db.Type {
	case "sqlite":
		if db.Path == "" {
			db.Path = filepath.Join(dataDir, "pulsegate.db")
		}
		if strings.ContainsAny(db.Path, "\x00?#") || strings.Contains(db.Path, ":memory:") {
			return db, "", bad("SQLite 需要有效的持久化文件路径")
		}
		absolute, err := filepath.Abs(filepath.Clean(db.Path))
		if err != nil {
			return db, "", bad("SQLite 文件路径无效")
		}
		db = DatabaseConfiguration{Type: "sqlite", Path: absolute}
		return db, "sqlite:" + absolute, nil
	case "mysql", "pgsql":
		db.Host, db.Name, db.User = strings.TrimSpace(db.Host), strings.TrimSpace(db.Name), strings.TrimSpace(db.User)
		if db.Host == "" || strings.ContainsAny(db.Host, "/\\?#@ \t\r\n\x00") || strings.Contains(db.Host, ":") && net.ParseIP(db.Host) == nil {
			return db, "", bad("请填写有效的数据库主机名或 IP 地址，端口需单独填写")
		}
		nameLimit := 63
		if db.Type == "mysql" {
			nameLimit = 64
		}
		if db.Name == "" || len(db.Name) > nameLimit || strings.ContainsAny(db.Name, "/\\?#\x00") || db.User == "" || len(db.User) > 128 || strings.ContainsRune(db.User, '\x00') || len(db.Password) > 4096 || strings.ContainsRune(db.Password, '\x00') {
			return db, "", bad("请填写有效的数据库名称、用户名和密码")
		}
		if db.Port == 0 {
			db.Port = 5432
			if db.Type == "mysql" {
				db.Port = 3306
			}
		}
		if db.Port < 1 || db.Port > 65535 {
			return db, "", bad("数据库端口须在 1–65535 之间")
		}
		if db.SSLMode == "" {
			db.SSLMode = "disable"
		}
		db.Path = ""
		u := &url.URL{User: url.UserPassword(db.User, db.Password), Host: net.JoinHostPort(db.Host, strconv.Itoa(db.Port)), Path: "/" + db.Name}
		query := url.Values{}
		if db.Type == "pgsql" {
			switch db.SSLMode {
			case "disable", "require", "verify-ca", "verify-full":
			default:
				return db, "", bad("PostgreSQL SSL 模式无效")
			}
			u.Scheme = "postgres"
			query.Set("sslmode", db.SSLMode)
			query.Set("connect_timeout", "5")
		} else {
			u.Scheme = "mysql"
			switch db.SSLMode {
			case "disable":
				query.Set("tls", "false")
			case "require":
				query.Set("tls", "skip-verify")
			case "verify-full":
				query.Set("tls", "true")
			default:
				return db, "", bad("MySQL TLS 模式无效")
			}
			query.Set("timeout", "5s")
		}
		u.RawQuery = query.Encode()
		return db, u.String(), nil
	default:
		return db, "", bad("数据库类型须为 sqlite、mysql 或 pgsql")
	}
}

func prepareDatabaseFile(db DatabaseConfiguration) error {
	if db.Type != "sqlite" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(db.Path), 0700); err != nil {
		return &HTTPError{400, "无法创建 SQLite 数据目录，请检查路径和写入权限"}
	}
	file, err := os.OpenFile(db.Path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return &HTTPError{400, "无法打开 SQLite 文件，请检查路径和写入权限"}
	}
	return file.Close()
}

func (a *Application) createRuntime(ctx context.Context, dsn, encryptionKey string, httpConfig HTTPConfig) (*applicationRuntime, error) {
	return a.createRuntimeChecked(ctx, dsn, encryptionKey, httpConfig, false)
}

func (a *Application) createFreshRuntime(ctx context.Context, dsn, encryptionKey string, httpConfig HTTPConfig) (*applicationRuntime, error) {
	return a.createRuntimeChecked(ctx, dsn, encryptionKey, httpConfig, true)
}

func (a *Application) createRuntimeChecked(ctx context.Context, dsn, encryptionKey string, httpConfig HTTPConfig, requireEmpty bool) (*applicationRuntime, error) {
	store, err := NewStore(ctx, dsn, encryptionKey)
	if err != nil {
		return nil, err
	}
	if requireEmpty {
		if err := checkSetupDatabaseEmpty(ctx, store); err != nil {
			_ = store.Close()
			return nil, err
		}
	}
	engineConfig := a.config.Engine
	engineConfig.DevMode = a.config.DevMode
	engine := NewEngine(store, engineConfig)
	if engine.snapshot.Load() == nil {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = engine.Close(closeCtx)
		_ = store.Close()
		return nil, errors.New("gateway configuration could not be loaded")
	}
	integrations := NewIntegrations(store)
	httpConfig.StaticDir = a.config.StaticDir
	httpConfig.DevMode = a.config.DevMode
	if httpConfig.DatabaseType == "postgres" {
		httpConfig.DatabaseType = "pgsql"
	}
	return &applicationRuntime{handler: NewHandler(store, engine, integrations, httpConfig), store: store, engine: engine, integrations: integrations}, nil
}

func (a *Application) activate(runtime *applicationRuntime) {
	background, cancel := context.WithCancel(a.ctx)
	runtime.cancel, runtime.done = cancel, make(chan struct{})
	var workers sync.WaitGroup
	workers.Add(2)
	go func() { defer workers.Done(); runtime.integrations.Run(background) }()
	go func() { defer workers.Done(); RunMaintenance(background, runtime.store, runtime.engine) }()
	go func() { workers.Wait(); close(runtime.done) }()
	a.runtime.Store(runtime)
}

func closeRuntime(ctx context.Context, runtime *applicationRuntime) error {
	if runtime.cancel != nil {
		runtime.cancel()
		select {
		case <-runtime.done:
		case <-ctx.Done():
		}
	}
	runtime.integrations.client.CloseIdleConnections()
	return errors.Join(runtime.engine.Close(ctx), runtime.store.Close())
}

func (a *Application) Close(ctx context.Context) error {
	a.cancel()
	a.setupMu.Lock()
	defer a.setupMu.Unlock()
	if a.closed {
		return nil
	}
	a.closed = true
	if runtime := a.runtime.Load(); runtime != nil {
		return closeRuntime(ctx, runtime)
	}
	return nil
}

func (a *Application) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.URL.Path == "/api/setup" || r.URL.Path == "/api/setup/test-database" {
		if err := a.setup(w, r); err != nil {
			writeError(w, err)
		}
		return
	}
	if runtime := a.runtime.Load(); runtime != nil {
		runtime.handler.ServeHTTP(w, r)
		return
	}
	switch r.URL.Path {
	case "/health/live":
		writeJSON(w, 200, map[string]any{"status": "ok", "service": "pulsegate", "initialized": false})
		return
	case "/health", "/health/ready":
		writeJSON(w, 503, map[string]any{"status": "setup_required", "initialized": false})
		return
	case "/api/session":
		if r.Method == http.MethodGet {
			writeJSON(w, 200, map[string]any{"authenticated": false, "initialized": false, "configured": false, "devMode": false, "authMode": "password"})
			return
		}
	}
	if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/v1/") || strings.HasPrefix(r.URL.Path, "/v1beta/") {
		writeError(w, &HTTPError{503, "请先完成初次部署初始化"})
		return
	}
	a.static.ServeHTTP(w, r)
}

func (a *Application) setup(w http.ResponseWriter, r *http.Request) error {
	initialized := a.runtime.Load() != nil
	if r.URL.Path == "/api/setup" && r.Method == http.MethodGet {
		response := map[string]any{"initialized": initialized}
		if !initialized {
			response["databaseTypes"] = []string{"sqlite", "mysql", "pgsql"}
			response["defaults"] = map[string]any{"databaseType": "sqlite", "sqlitePath": filepath.Join(a.config.DataDir, "pulsegate.db"), "host": "127.0.0.1", "port": 5432, "database": "pulsegate", "username": "pulsegate", "sslMode": "disable", "publicUrl": a.config.PublicURL}
		}
		writeJSON(w, 200, response)
		return nil
	}
	if r.Method != http.MethodPost {
		return &HTTPError{405, "Method not allowed"}
	}
	if initialized {
		return &HTTPError{409, "部署已完成初始化，不能重复设置"}
	}
	// JSON plus a verified browser origin prevents cross-site browser forms
	// from performing first-admin setup.
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return &HTTPError{415, "初始化请求须使用 application/json"}
	}
	if r.Header.Get("Origin") == "" || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return &HTTPError{403, "初始化请求需要同源 Origin"}
	}
	if err := a.setupOrigin(r); err != nil {
		return err
	}
	if !a.setupMu.TryLock() {
		return &HTTPError{409, "初始化或连接测试正在进行，请稍后重试"}
	}
	defer a.setupMu.Unlock()
	if a.closed {
		return &HTTPError{503, "服务正在停止，请稍后重试"}
	}
	if a.runtime.Load() != nil {
		return &HTTPError{409, "部署已完成初始化，不能重复设置"}
	}
	if err := os.MkdirAll(a.config.DataDir, 0700); err != nil {
		return &HTTPError{500, "无法创建配置目录，请检查数据卷的写入权限"}
	}
	unlock, err := lockSetup(filepath.Join(a.config.DataDir, ".setup.lock"))
	if err != nil {
		return &HTTPError{409, "其他进程正在初始化，请稍后重试"}
	}
	defer unlock()
	if _, err := os.Stat(a.configPath); err == nil {
		return &HTTPError{409, "配置文件已存在，请重新启动服务加载已有配置"}
	} else if !errors.Is(err, os.ErrNotExist) {
		return &HTTPError{500, "无法检查已有配置，请检查数据卷的读取权限"}
	}
	var input setupRequest
	r.Body = http.MaxBytesReader(w, r.Body, 32<<10)
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return bad("初始化参数须为有效 JSON，且字段类型正确")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return bad("请求只能包含一个 JSON 对象")
	}
	database, dsn, err := normalizeDatabase(input.Database, a.config.DataDir)
	if err != nil {
		return err
	}
	if r.URL.Path == "/api/setup" {
		if utf8.RuneCountInString(input.AdminPassword) < 7 || len(input.AdminPassword) > 72 || strings.TrimSpace(input.AdminPassword) == "" {
			return bad("管理员密码至少 7 个字符，最多 72 字节，且不能全为空白")
		}
		if input.AdminPassword != input.ConfirmPassword {
			return bad("两次输入的管理员密码不一致")
		}
		input.PublicURL = strings.TrimSpace(input.PublicURL)
		if input.PublicURL == "" {
			input.PublicURL = strings.TrimRight(a.config.PublicURL, "/")
			if input.PublicURL == "" {
				input.PublicURL = r.Header.Get("Origin")
			}
		}
		input.PublicURL, err = normalizeHTTPOrigin(input.PublicURL)
		if err != nil {
			return err
		}
	}
	if err := prepareDatabaseFile(database); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	stop := context.AfterFunc(a.ctx, cancel)
	defer stop()
	if r.URL.Path == "/api/setup/test-database" {
		probe, cancelProbe := context.WithTimeout(ctx, 8*time.Second)
		err := ProbeDatabase(probe, dsn)
		cancelProbe()
		if err != nil {
			return &HTTPError{400, "数据库连接失败，请检查主机、端口、库名、账号、密码和连接权限"}
		}
		writeJSON(w, 200, map[string]any{"success": true})
		return nil
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(input.AdminPassword), bcrypt.DefaultCost)
	if err != nil {
		return errors.New("password hash generation failed")
	}
	var key [32]byte
	if _, err := rand.Read(key[:]); err != nil {
		return errors.New("encryption key generation failed")
	}
	saved := savedConfiguration{Version: 1, AdminPasswordHash: string(hash), SessionSecret: randomSecret(""), EncryptionKey: base64.StdEncoding.EncodeToString(key[:]), PublicURL: input.PublicURL, Database: database}
	publicURL := saved.PublicURL
	if a.config.PublicURL != "" {
		publicURL = a.config.PublicURL
	}
	runtime, err := a.createFreshRuntime(ctx, dsn, saved.EncryptionKey, HTTPConfig{AdminPasswordHash: saved.AdminPasswordHash, SessionSecret: saved.SessionSecret, PublicURL: publicURL, DatabaseType: database.Type})
	if err != nil {
		if errors.Is(err, errSetupDatabasePopulated) {
			return &HTTPError{400, "所选数据库已有 PulseGate 数据。请使用空数据库，或恢复原 config.json 与加密密钥后重新启动"}
		}
		return &HTTPError{400, "数据库初始化失败，请检查连接信息、数据库版本及建表权限"}
	}
	if err := persistConfiguration(a.configPath, saved); err != nil {
		closeCtx, cancelClose := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelClose()
		_ = closeRuntime(closeCtx, runtime)
		return &HTTPError{500, "配置保存失败，请检查数据卷剩余空间和写入权限"}
	}
	a.activate(runtime)
	writeJSON(w, 200, map[string]any{"initialized": true})
	return nil
}

// A synced temporary file becomes visible at configPath in one operation.
// Linking never replaces an existing configuration, even on Windows.
func persistConfiguration(configPath string, saved savedConfiguration) error {
	content, err := json.MarshalIndent(saved, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(configPath), ".config-*.tmp")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if err := file.Chmod(0600); err != nil {
		file.Close()
		return err
	}
	_, err = file.Write(append(content, '\n'))
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := os.Link(temporary, configPath); err != nil {
		return fmt.Errorf("persist configuration: %w", err)
	}
	if directory, err := os.Open(filepath.Dir(configPath)); err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}
