package gateway

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

var jsonChain = regexp.MustCompile(`\b([A-Za-z_][A-Za-z0-9_.]*)((?:\s*->>?\s*'[^']+')+)`)
var jsonKey = regexp.MustCompile(`->>?\s*'([^']+)'`)
var booleanJSONCast = regexp.MustCompile(`\(([A-Za-z_][A-Za-z0-9_.]*(?:\s*->>?\s*'[^']+')+)\)::boolean`)
var numericCast = regexp.MustCompile(`::(?:double precision|bigint|integer|int|numeric|text|timestamptz)(?:\[\])?\b`)
var rowLock = regexp.MustCompile(`(?i)\s+(?:FOR\s+(?:UPDATE|SHARE)(?:\s+OF\s+[A-Za-z_,]+)?|LOCK\s+IN\s+SHARE\s+MODE)\b`)
var conflictNothing = regexp.MustCompile(`(?i)\s+ON\s+CONFLICT(?:\s*\([^)]*\))?\s+DO\s+NOTHING\s*$`)
var conflictUpdate = regexp.MustCompile(`(?i)\s+ON\s+CONFLICT\s*\([^)]*\)\s+DO\s+UPDATE\s+SET\s+`)
var excludedColumn = regexp.MustCompile(`(?i)\bexcluded\.([A-Za-z_][A-Za-z0-9_]*)`)
var insertIgnore = regexp.MustCompile(`(?i)^\s*INSERT\s+INTO`)
var mysqlConcat = regexp.MustCompile(`(?:'[^']*'|\$[0-9]+|[A-Za-z_][A-Za-z0-9_.]*)\s*(?:\|\|\s*(?:'[^']*'|\$[0-9]+|[A-Za-z_][A-Za-z0-9_.]*)\s*)+`)
var insertValues = regexp.MustCompile(`(?i)INSERT(?:\s+IGNORE)?\s+INTO\s+\w+\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)`)

func dialectSQL(dialect, query string, args []any) (string, []any) {
	if dialect == "postgres" {
		return query, args
	}
	booleanType := "TEXT"
	if dialect == "mysql" {
		booleanType = "CHAR"
	}
	query = booleanJSONCast.ReplaceAllString(query, `(CAST($1 AS `+booleanType+`) IN ('true','1'))`)
	query = jsonChain.ReplaceAllStringFunc(query, func(chain string) string {
		parts := jsonChain.FindStringSubmatch(chain)
		keys := jsonKey.FindAllStringSubmatch(parts[2], -1)
		path := "$"
		for _, key := range keys {
			path += "." + key[1]
		}
		expression := "json_extract(" + parts[1] + ",'" + path + "')"
		if dialect == "mysql" && strings.Contains(parts[2], "->>") {
			expression = "NULLIF(JSON_UNQUOTE(" + expression + "),'null')"
		}
		return expression
	})
	query = numericCast.ReplaceAllString(query, "")
	query = strings.ReplaceAll(query, " ILIKE ", " LIKE ")
	if dialect == "sqlite" {
		query = rowLock.ReplaceAllString(query, "")
		query = strings.ReplaceAll(query, "now()+interval '24 hours'", "strftime('%Y-%m-%d %H:%M:%f000','now','+24 hours')")
		query = strings.ReplaceAll(query, "now()", "strftime('%Y-%m-%d %H:%M:%f000','now')")
	} else {
		// TiDB rejects shared locks by default, and enabling noop compatibility
		// would silently remove their protection. Exclusive row locks are
		// supported by both MySQL and TiDB and preserve the channel-first order.
		query = rowLock.ReplaceAllString(query, " FOR UPDATE")
		query = strings.ReplaceAll(query, "now()+interval '24 hours'", "DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 24 HOUR)")
		query = strings.ReplaceAll(query, "now()", "UTC_TIMESTAMP(6)")
		query = mysqlConcat.ReplaceAllStringFunc(query, func(expression string) string {
			return "CONCAT(" + strings.Join(strings.Split(expression, "||"), ",") + ")"
		})
		if conflictNothing.MatchString(query) {
			// This branch is used only for idempotent inserts with validated data.
			// IGNORE provides PostgreSQL's zero rows affected on duplicate, even
			// when CLIENT_FOUND_ROWS is enabled for ordinary updates.
			query = conflictNothing.ReplaceAllString(query, "")
			query = insertIgnore.ReplaceAllString(query, "INSERT IGNORE INTO")
		} else if conflictUpdate.MatchString(query) {
			query = conflictUpdate.ReplaceAllString(query, " ON DUPLICATE KEY UPDATE ")
			query = excludedColumn.ReplaceAllString(query, "VALUES($1)")
		}
	}
	return bindSQL(dialect, query, args)
}

// bindSQL repeats arguments for repeated PostgreSQL placeholders. It skips SQL
// string literals so values such as '$1' stay literal on every backend.
func bindSQL(dialect, query string, args []any) (string, []any) {
	var result strings.Builder
	bound := make([]any, 0, len(args))
	timeArguments := timestampArguments(query)
	quoted := byte(0)
	for i := 0; i < len(query); {
		ch := query[i]
		if quoted != 0 {
			result.WriteByte(ch)
			i++
			if ch == quoted {
				if i < len(query) && query[i] == quoted {
					result.WriteByte(query[i])
					i++
				} else {
					quoted = 0
				}
			}
			continue
		}
		if ch == '\'' || ch == '"' || ch == '`' {
			quoted = ch
			result.WriteByte(ch)
			i++
			continue
		}
		if ch == '$' && i+1 < len(query) && query[i+1] >= '0' && query[i+1] <= '9' {
			end := i + 1
			for end < len(query) && query[end] >= '0' && query[end] <= '9' {
				end++
			}
			index, _ := strconv.Atoi(query[i+1 : end])
			if index > 0 && index <= len(args) {
				result.WriteByte('?')
				value := normalizeDBValue(dialect, args[index-1])
				if timeArguments[index] {
					if text, ok := value.(string); ok {
						if stamp, err := time.Parse(time.RFC3339Nano, text); err == nil {
							value = stamp.UTC().Format(databaseTimeLayout)
						}
					}
				}
				bound = append(bound, value)
				i = end
				continue
			}
		}
		result.WriteByte(ch)
		i++
	}
	return result.String(), bound
}

// Only physical date columns need normalization. A timestamp-looking string in
// gateway_state.value or a tag is application data and must remain unchanged.
func timestampArguments(query string) map[int]bool {
	result := map[int]bool{}
	match := insertValues.FindStringSubmatch(query)
	if match == nil {
		return result
	}
	columns, values := strings.Split(match[1], ","), strings.Split(match[2], ",")
	for i, column := range columns {
		if i >= len(values) {
			break
		}
		switch strings.ToLower(strings.TrimSpace(column)) {
		case "created_at", "started_at", "expires_at":
			value := strings.TrimSpace(values[i])
			if strings.HasPrefix(value, "$") {
				if index, err := strconv.Atoi(strings.TrimPrefix(value, "$")); err == nil {
					result[index] = true
				}
			}
		}
	}
	return result
}

const databaseTimeLayout = "2006-01-02 15:04:05.000000"

func normalizeDBValue(dialect string, value any) any {
	switch v := value.(type) {
	case time.Time:
		if dialect == "sqlite" {
			return v.UTC().Format(databaseTimeLayout)
		}
		return v.UTC()
	case *string:
		if v != nil {
			return normalizeDBValue(dialect, *v)
		}
	case []byte:
		return string(v)
	}
	return value
}
