package gateway

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

// DB keeps connection pooling in database/sql while translating the small SQL
// vocabulary used by the store. Transactions always use the same dialect.
type DB struct {
	*sql.DB
	dialect string
}

type DBTx struct {
	*sql.Tx
	dialect string
}

func (d *DB) Dialect() string   { return d.dialect }
func (d *DBTx) Dialect() string { return d.dialect }

func DatabaseType(databaseURL string) string {
	switch {
	case strings.HasPrefix(databaseURL, "sqlite:"):
		return "sqlite"
	case strings.HasPrefix(databaseURL, "mysql://"):
		return "mysql"
	case strings.HasPrefix(databaseURL, "postgres://"), strings.HasPrefix(databaseURL, "postgresql://"):
		return "postgres"
	default:
		return ""
	}
}

func openDatabase(databaseURL string) (*DB, error) {
	dialect := DatabaseType(databaseURL)
	var raw *sql.DB
	var err error
	switch dialect {
	case "postgres":
		config, parseErr := pgx.ParseConfig(databaseURL)
		if parseErr != nil {
			return nil, fmt.Errorf("parse PostgreSQL configuration: %w", parseErr)
		}
		config.ConnectTimeout = 5 * time.Second
		config.RuntimeParams["statement_timeout"] = "3000"
		config.RuntimeParams["lock_timeout"] = "1000"
		raw = stdlib.OpenDB(*config)
	case "mysql":
		parsed, parseErr := url.Parse(databaseURL)
		if parseErr != nil || parsed.Hostname() == "" || parsed.Path == "" || parsed.Path == "/" {
			return nil, errors.New("invalid MySQL URL; include host and database name")
		}
		config := mysql.NewConfig()
		config.Net = "tcp"
		port := parsed.Port()
		if port == "" {
			port = "3306"
		}
		config.Addr = net.JoinHostPort(parsed.Hostname(), port)
		config.DBName = strings.TrimPrefix(parsed.Path, "/")
		if parsed.User != nil {
			config.User = parsed.User.Username()
			config.Passwd, _ = parsed.User.Password()
		}
		config.ParseTime = true
		config.Loc = time.UTC
		config.ClientFoundRows = true
		config.Timeout = 5 * time.Second
		config.ReadTimeout = 5 * time.Second
		config.WriteTimeout = 5 * time.Second
		config.Collation = "utf8mb4_bin"
		config.Params = map[string]string{"time_zone": "'+00:00'"}
		config.TLSConfig = parsed.Query().Get("tls")
		if config.TLSConfig == "" {
			config.TLSConfig = "false"
		}
		connector, connectorErr := mysql.NewConnector(config)
		if connectorErr != nil {
			return nil, fmt.Errorf("configure MySQL: %w", connectorErr)
		}
		raw = sql.OpenDB(connector)
	case "sqlite":
		path := strings.TrimPrefix(databaseURL, "sqlite:")
		path = strings.TrimPrefix(path, "//")
		if path == "" {
			return nil, errors.New("SQLite database path is required")
		}
		var dsn string
		if path == ":memory:" {
			dsn = "file::memory:?cache=shared"
		} else {
			absolute, absErr := filepath.Abs(path)
			if absErr != nil {
				return nil, absErr
			}
			if err = os.MkdirAll(filepath.Dir(absolute), 0700); err != nil {
				return nil, err
			}
			// Use SQLite's native filename on Windows. A file:///C:/ URI is
			// interpreted inconsistently by the pure-Go Windows VFS.
			dsn = absolute + "?"
		}
		dsn += "&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_txlock=immediate"
		raw, err = sql.Open("sqlite", dsn)
	default:
		return nil, errors.New("DATABASE_URL must use sqlite:, mysql://, postgres:// or postgresql://")
	}
	if err != nil {
		return nil, err
	}
	raw.SetMaxOpenConns(envPoolSize("DB_MAX_OPEN_CONNS", 32))
	raw.SetMaxIdleConns(envPoolSize("DB_MAX_IDLE_CONNS", 16))
	raw.SetConnMaxIdleTime(5 * time.Minute)
	raw.SetConnMaxLifetime(30 * time.Minute)
	return &DB{DB: raw, dialect: dialect}, nil
}

// ProbeDatabase checks the supplied configuration without creating application
// tables. The caller owns the overall timeout; individual dials are bounded.
func ProbeDatabase(ctx context.Context, databaseURL string) error {
	db, err := openDatabase(databaseURL)
	if err != nil {
		return err
	}
	defer db.Close()
	return db.PingContext(ctx)
}

func (d *DB) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	checkWarnings := d.dialect == "mysql" && conflictNothing.MatchString(query)
	query, args = dialectSQL(d.dialect, query, args)
	if checkWarnings {
		tx, err := d.DB.BeginTx(ctx, nil)
		if err != nil {
			return nil, err
		}
		defer tx.Rollback()
		result, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return nil, err
		}
		if err = mysqlInsertWarnings(ctx, tx); err != nil {
			return nil, err
		}
		if err = tx.Commit(); err != nil {
			return nil, err
		}
		return result, nil
	}
	return d.DB.ExecContext(ctx, query, args...)
}
func (d *DB) Exec(query string, args ...any) (sql.Result, error) {
	return d.ExecContext(context.Background(), query, args...)
}
func (d *DB) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	query, args = dialectSQL(d.dialect, query, args)
	return d.DB.QueryContext(ctx, query, args...)
}
func (d *DB) Query(query string, args ...any) (*sql.Rows, error) {
	return d.QueryContext(context.Background(), query, args...)
}
func (d *DB) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	query, args = dialectSQL(d.dialect, query, args)
	return d.DB.QueryRowContext(ctx, query, args...)
}
func (d *DB) QueryRow(query string, args ...any) *sql.Row {
	return d.QueryRowContext(context.Background(), query, args...)
}
func (d *DB) BeginTx(ctx context.Context, opts *sql.TxOptions) (*DBTx, error) {
	tx, err := d.DB.BeginTx(ctx, opts)
	if err != nil {
		return nil, err
	}
	return &DBTx{Tx: tx, dialect: d.dialect}, nil
}
func (d *DBTx) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	checkWarnings := d.dialect == "mysql" && conflictNothing.MatchString(query)
	query, args = dialectSQL(d.dialect, query, args)
	result, err := d.Tx.ExecContext(ctx, query, args...)
	if err == nil && checkWarnings {
		err = mysqlInsertWarnings(ctx, d.Tx)
	}
	return result, err
}
func (d *DBTx) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	query, args = dialectSQL(d.dialect, query, args)
	return d.Tx.QueryContext(ctx, query, args...)
}
func (d *DBTx) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	query, args = dialectSQL(d.dialect, query, args)
	return d.Tx.QueryRowContext(ctx, query, args...)
}

func mysqlInsertWarnings(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, "SHOW WARNINGS")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var level, message string
		var code uint16
		if err = rows.Scan(&level, &code, &message); err != nil {
			return err
		}
		// INSERT IGNORE must suppress duplicate-key conflicts only. In
		// particular, foreign-key and truncation warnings remain fatal.
		if code != 1062 {
			return &mysql.MySQLError{Number: code, Message: message}
		}
	}
	return rows.Err()
}

func (s *Store) migrate(ctx context.Context) error {
	if s.db.Dialect() == "postgres" {
		return s.migratePostgres(ctx)
	}
	return s.migratePortable(ctx)
}

type migrationExecutor interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func (s *Store) migratePortable(ctx context.Context) error {
	var executor migrationExecutor
	var finish func() error
	dialect := s.db.Dialect()
	if dialect == "sqlite" {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		executor, finish = tx, tx.Commit
	} else {
		// MySQL DDL commits implicitly. A session advisory lock serializes schema
		// changes across simultaneous application starts on one database.
		conn, err := s.db.Conn(ctx)
		if err != nil {
			return err
		}
		defer conn.Close()
		var acquired int
		if err = conn.QueryRowContext(ctx, "SELECT GET_LOCK(CONCAT('pulsegate:',LEFT(SHA2(DATABASE(),256),40)),20)").Scan(&acquired); err != nil || acquired != 1 {
			return errors.New("could not acquire MySQL schema migration lock")
		}
		defer conn.ExecContext(context.Background(), "SELECT RELEASE_LOCK(CONCAT('pulsegate:',LEFT(SHA2(DATABASE(),256),40)))")
		executor, finish = conn, func() error { return nil }
	}
	metadata := "CREATE TABLE IF NOT EXISTS schema_migrations(name VARCHAR(191) PRIMARY KEY, applied_at VARCHAR(40) NOT NULL)"
	if _, err := executor.ExecContext(ctx, metadata); err != nil {
		return err
	}
	directory := "migrations/" + dialect
	files, err := migrations.ReadDir(directory)
	if err != nil {
		return err
	}
	for _, file := range files {
		var exists int
		placeholder := "$1"
		if dialect == "mysql" {
			placeholder = "?"
		}
		if err = executor.QueryRowContext(ctx, "SELECT count(*) FROM schema_migrations WHERE name="+placeholder, file.Name()).Scan(&exists); err != nil {
			return err
		}
		if exists > 0 {
			continue
		}
		body, readErr := migrations.ReadFile(directory + "/" + file.Name())
		if readErr != nil {
			return readErr
		}
		for _, statement := range strings.Split(string(body), ";") {
			if strings.TrimSpace(statement) == "" {
				continue
			}
			if _, err = executor.ExecContext(ctx, statement); err != nil {
				return fmt.Errorf("migration %s: %w", file.Name(), err)
			}
		}
		insert := "INSERT INTO schema_migrations(name,applied_at) VALUES($1,$2)"
		if dialect == "mysql" {
			insert = "INSERT INTO schema_migrations(name,applied_at) VALUES(?,?)"
		}
		if _, err = executor.ExecContext(ctx, insert, file.Name(), time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return err
		}
	}
	return finish()
}
