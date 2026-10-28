#!/usr/bin/env python3
"""Export a local D1 SQLite file or D1 SQL export to the Go migration snapshot.

Usage: python scripts/export-d1.py old.sqlite snapshot.json
       python scripts/export-d1.py old-export.sql snapshot.json
Only Python's standard library is required. Existing output files are refused.
"""

import argparse
import datetime
import json
import os
from pathlib import Path
import sqlite3
import sys

TABLES = (
    "channels", "credentials", "api_keys", "profile_usage", "settings", "tags",
    "request_logs", "attempts", "events", "channel_accounts", "credential_balances",
)


def open_source(path):
    with path.open("rb") as source:
        sqlite = source.read(16) == b"SQLite format 3\x00"
    if sqlite:
        connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
        connection.execute("PRAGMA query_only=ON")
        return connection
    connection = sqlite3.connect(":memory:")
    # A SQL dump needs CREATE/INSERT/PRAGMA but must never attach another file.
    denied = {sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH}

    def authorize(action, first, second, database, trigger):
        return sqlite3.SQLITE_DENY if action in denied else sqlite3.SQLITE_OK

    connection.set_authorizer(authorize)
    try:
        connection.executescript(path.read_text(encoding="utf-8-sig"))
    except BaseException:
        connection.close()
        raise
    return connection


def export_snapshot(connection, output):
    connection.row_factory = sqlite3.Row
    existing = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    counts = {}
    output.write('{"version":1,"exportedAt":')
    json.dump(datetime.datetime.now(datetime.timezone.utc).isoformat(), output)
    output.write(',"tables":{')
    for table_index, table in enumerate(TABLES):
        if table_index:
            output.write(",")
        json.dump(table, output)
        output.write(":[")
        count = 0
        if table in existing:
            for row in connection.execute('SELECT * FROM "' + table + '"'):
                if count:
                    output.write(",")
                json.dump(dict(row), output, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                count += 1
        output.write("]")
        counts[table] = count
    output.write("}}\n")
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="D1 SQLite database or exported .sql file")
    parser.add_argument("output", type=Path, help="New JSON snapshot path; must not already exist")
    args = parser.parse_args()
    if not args.source.is_file():
        parser.error("source does not exist or is not a file")
    try:
        connection = open_source(args.source)
        try:
            # Exclusive creation avoids accidentally overwriting a database/export.
            descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
                    counts = export_snapshot(connection, output)
            except BaseException:
                args.output.unlink(missing_ok=True)
                raise
        finally:
            connection.close()
    except (OSError, sqlite3.Error, ValueError, TypeError) as error:
        # Do not echo SQL, row content, encrypted credentials, or source secrets.
        print("Export failed (" + type(error).__name__ + "); check the input format and output path.", file=sys.stderr)
        return 1
    print("Snapshot saved: " + str(args.output))
    print(", ".join(table + "=" + str(count) for table, count in counts.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
